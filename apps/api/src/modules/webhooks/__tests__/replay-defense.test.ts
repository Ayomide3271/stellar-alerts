import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Redis from 'ioredis';

import {
  ReplayDefense,
  REPLAY_DRIFT_TOLERANCE_MS,
  REPLAY_NONCE_TTL_SECONDS,
  extractReplayHeaders,
  createReplayDefenseHook,
} from '../replay-defense';
import { NONCE_PREFIX } from '../../../lib/nonceCache';
import { AuthenticationError } from '../../../lib/errors';

const { mockAuditCreate } = vi.hoisted(() => ({
  mockAuditCreate: vi.fn(async () => ({ id: 'audit-1' })),
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: { securityAuditLog: { create: mockAuditCreate } },
}));

vi.mock('../../../lib/redis', () => ({
  redis: { set: vi.fn(), get: vi.fn(), on: vi.fn() },
}));

interface FakeRedis {
  client: Redis;
  store: Map<string, string>;
  lastTtl: number | null;
}

function createFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  const state = { lastTtl: null as number | null };
  const client = {
    set: vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
      const args = rest.map((a) => (typeof a === 'string' ? a.toUpperCase() : a));
      const nxIndex = args.indexOf('NX');
      if (nxIndex !== -1 && store.has(key)) {
        return null;
      }
      const exIndex = args.indexOf('EX');
      if (exIndex !== -1 && typeof rest[exIndex] === 'number') {
        state.lastTtl = rest[exIndex] as number;
      } else if (exIndex !== -1 && typeof args[exIndex + 1] === 'number') {
        state.lastTtl = args[exIndex + 1] as number;
      }
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
  return {
    client: client as unknown as Redis,
    store,
    get lastTtl() {
      return state.lastTtl;
    },
  } as FakeRedis;
}

describe('ReplayDefense — timestamp drift window (#718)', () => {
  let fakeRedis: FakeRedis;
  let defense: ReplayDefense;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    fakeRedis = createFakeRedis();
    defense = new ReplayDefense({ redisClient: fakeRedis.client });
    mockAuditCreate.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const now = () => Date.now();

  it('accepts a request whose timestamp is inside the 30-second window', async () => {
    const result = await defense.check({
      nonce: 'nonce-fresh-1',
      timestamp: now() - 5_000,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a request timestamped exactly at server time', async () => {
    const result = await defense.check({ nonce: 'nonce-fresh-2', timestamp: now() });
    expect(result.ok).toBe(true);
  });

  it('rejects payloads with expired timestamps (drift > 30s in the past)', async () => {
    const result = await defense.check({
      nonce: 'nonce-old',
      timestamp: now() - REPLAY_DRIFT_TOLERANCE_MS - 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('TIMESTAMP_DRIFT_EXCEEDED');
      expect(result.statusCode).toBe(401);
    }
  });

  it('rejects payloads with timestamps too far in the future', async () => {
    const result = await defense.check({
      nonce: 'nonce-future',
      timestamp: now() + REPLAY_DRIFT_TOLERANCE_MS + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('TIMESTAMP_DRIFT_EXCEEDED');
    }
  });

  it('accepts a timestamp exactly at the drift boundary', async () => {
    const result = await defense.check({
      nonce: 'nonce-boundary',
      timestamp: now() - REPLAY_DRIFT_TOLERANCE_MS,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects missing or invalid timestamps', async () => {
    const missing = await defense.check({ nonce: 'nonce-no-ts' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('MISSING_TIMESTAMP');

    const invalid = await defense.check({ nonce: 'nonce-bad-ts', timestamp: 'not-a-number' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toBe('INVALID_TIMESTAMP');
  });

  it('rejects missing or oversized nonces', async () => {
    const missing = await defense.check({ timestamp: now() });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('MISSING_NONCE');

    const oversized = await defense.check({ nonce: 'x'.repeat(129), timestamp: now() });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.reason).toBe('INVALID_NONCE');
  });
});

describe('ReplayDefense — one-time nonce consumption in Redis (#718)', () => {
  let fakeRedis: FakeRedis;
  let defense: ReplayDefense;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    fakeRedis = createFakeRedis();
    defense = new ReplayDefense({ redisClient: fakeRedis.client });
    mockAuditCreate.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a replayed nonce within the TTL window', async () => {
    const timestamp = Date.now();

    const first = await defense.check({ nonce: 'replayed-nonce', timestamp });
    expect(first.ok).toBe(true);

    const second = await defense.check({ nonce: 'replayed-nonce', timestamp });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('NONCE_ALREADY_CONSUMED');
      expect(second.statusCode).toBe(401);
    }
  });

  it('stores consumed nonces in Redis with a 5-minute TTL', async () => {
    await defense.check({ nonce: 'ttl-nonce', timestamp: Date.now() });

    expect(fakeRedis.store.has(`${NONCE_PREFIX}ttl-nonce`)).toBe(true);
    expect(fakeRedis.lastTtl).toBe(REPLAY_NONCE_TTL_SECONDS);
    expect(REPLAY_NONCE_TTL_SECONDS).toBe(300);
  });

  it('does not consume the nonce when timestamp validation fails first', async () => {
    const result = await defense.check({
      nonce: 'stale-nonce',
      timestamp: Date.now() - REPLAY_DRIFT_TOLERANCE_MS - 1_000,
    });
    expect(result.ok).toBe(false);
    expect(fakeRedis.store.has(`${NONCE_PREFIX}stale-nonce`)).toBe(false);
  });

  it('allows the same nonce value after the Redis entry expires (TTL elapse)', async () => {
    const timestamp = Date.now();
    expect((await defense.check({ nonce: 'expiring-nonce', timestamp })).ok).toBe(true);

    // Simulate TTL expiry.
    fakeRedis.store.delete(`${NONCE_PREFIX}expiring-nonce`);

    const afterExpiry = await defense.check({ nonce: 'expiring-nonce', timestamp });
    expect(afterExpiry.ok).toBe(true);
  });
});

describe('ReplayDefense — assertFresh 401 + security audit log (#718)', () => {
  let fakeRedis: FakeRedis;
  let defense: ReplayDefense;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    fakeRedis = createFakeRedis();
    defense = new ReplayDefense({ redisClient: fakeRedis.client });
    mockAuditCreate.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws a 401 AuthenticationError for a duplicate nonce and writes a HIGH audit entry', async () => {
    const input = {
      nonce: 'audit-nonce',
      timestamp: Date.now(),
      context: { endpoint: 'POST /hooks/inbound', ip: '203.0.113.9' },
    };

    await defense.assertFresh(input);

    await expect(defense.assertFresh(input)).rejects.toMatchObject({
      statusCode: 401,
      code: 'WEBHOOK_REPLAY_NONCE_ALREADY_CONSUMED',
    });
    await expect(defense.assertFresh(input)).rejects.toBeInstanceOf(AuthenticationError);

    // Two rejected replays above → two audit entries (the first call succeeded).
    expect(mockAuditCreate).toHaveBeenCalledTimes(2);
    const audit = mockAuditCreate.mock.calls[mockAuditCreate.mock.calls.length - 1][0];
    expect(audit.data.eventType).toBe('WEBHOOK_REPLAY_ATTEMPT');
    expect(audit.data.severity).toBe('HIGH');
    expect(audit.data.details.reason).toBe('NONCE_ALREADY_CONSUMED');
    expect(audit.data.details.nonce).toBe('audit-nonce');
    expect(audit.data.details.ip).toBe('203.0.113.9');
  });

  it('throws a 401 AuthenticationError for stale timestamps and audits the drift', async () => {
    await expect(
      defense.assertFresh({ nonce: 'stale-audit', timestamp: Date.now() - 60_000 }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'WEBHOOK_REPLAY_TIMESTAMP_DRIFT_EXCEEDED' });

    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    const audit = mockAuditCreate.mock.calls[0][0];
    expect(audit.data.details.reason).toBe('TIMESTAMP_DRIFT_EXCEEDED');
  });

  it('does not throw for a valid first-time request', async () => {
    const result = await defense.assertFresh({ nonce: 'valid-1', timestamp: Date.now() });
    expect(result.ok).toBe(true);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('still rejects replays when audit logging fails', async () => {
    mockAuditCreate.mockRejectedValueOnce(new Error('db down'));

    const input = { nonce: 'audit-fail-nonce', timestamp: Date.now() };
    await defense.assertFresh(input);
    await expect(defense.assertFresh(input)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('extractReplayHeaders & createReplayDefenseHook (#718)', () => {
  it('prefers dedicated nonce/timestamp headers', () => {
    const extracted = extractReplayHeaders({
      'x-stellar-alerts-nonce': 'header-nonce',
      'x-stellar-alerts-timestamp': '1767225600000',
      'x-stellar-signature': 't=111,n=embedded-nonce,v1=abcd',
    });
    expect(extracted).toEqual({ nonce: 'header-nonce', timestamp: '1767225600000' });
  });

  it('falls back to t=/n= fields inside the signature header', () => {
    const extracted = extractReplayHeaders({
      'x-stellar-signature': 't=1767225600000,n=sig-nonce,v1=abcd',
    });
    expect(extracted).toEqual({ nonce: 'sig-nonce', timestamp: '1767225600000' });
  });

  it('returns nulls when no replay material is present', () => {
    expect(extractReplayHeaders({})).toEqual({ nonce: null, timestamp: null });
  });

  it('hook rejects a replayed request with 401 and allows a fresh one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const fakeRedis = createFakeRedis();
    const hook = createReplayDefenseHook({ redisClient: fakeRedis.client });

    const request = {
      method: 'POST',
      url: '/hooks/inbound',
      ip: '198.51.100.4',
      headers: {
        'x-stellar-alerts-nonce': 'hook-nonce',
        'x-stellar-alerts-timestamp': String(Date.now()),
        'user-agent': 'curl/8.0',
      },
    } as never;

    await expect(hook(request, {} as never)).resolves.toBeUndefined();
    await expect(hook(request, {} as never)).rejects.toMatchObject({ statusCode: 401 });

    vi.useRealTimers();
  });
});
