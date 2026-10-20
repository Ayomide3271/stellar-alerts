import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisCircuitBreaker, CircuitBreakerOpenError } from '../circuit-breaker';
import { DispatcherWorker } from '../../../workers/dispatcher.worker';

const { mockRedis, store, ttls } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();

  const mockRedis = {
    get: vi.fn(async (key: string) => store.get(key) || null),
    set: vi.fn(async (key: string, val: string) => {
      store.set(key, val);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.delete(key);
      ttls.delete(key);
      return existed ? 1 : 0;
    }),
    incr: vi.fn(async (key: string) => {
      const cur = parseInt(store.get(key) || '0', 10);
      const next = cur + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      return 1;
    }),
  };

  return { mockRedis, store, ttls };
});

vi.mock('../../../lib/redis', () => ({
  redis: mockRedis,
  registerRedisCleanupTask: vi.fn(),
}));

describe('Distributed Circuit Breaker with Redis State (#633)', () => {
  let breaker: RedisCircuitBreaker;
  const endpointId = 'webhook-test-123';

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    ttls.clear();
    breaker = new RedisCircuitBreaker({
      failureThreshold: 5,
      windowSeconds: 60,
      cooldownSeconds: 60,
    });
  });

  it('starts in CLOSED state and allows requests', async () => {
    const state = await breaker.getState(endpointId);
    expect(state).toBe('CLOSED');
    expect(await breaker.canExecute(endpointId)).toBe(true);
  });

  it('tracks failure counts in Redis and sets TTL on first failure', async () => {
    await breaker.recordFailure(endpointId, { statusCode: 500 });

    expect(mockRedis.incr).toHaveBeenCalledWith(`circuit_breaker:${endpointId}:failures`);
    expect(mockRedis.expire).toHaveBeenCalledWith(`circuit_breaker:${endpointId}:failures`, 60);
    expect(await breaker.getState(endpointId)).toBe('CLOSED');
  });

  it('trips from CLOSED to OPEN after 5 consecutive failures', async () => {
    for (let i = 1; i <= 4; i++) {
      const state = await breaker.recordFailure(endpointId, { statusCode: 502 });
      expect(state).toBe('CLOSED');
    }

    // 5th failure trips the breaker
    const state = await breaker.recordFailure(endpointId, { statusCode: 504 });
    expect(state).toBe('OPEN');

    expect(await breaker.getState(endpointId)).toBe('OPEN');
    expect(await breaker.canExecute(endpointId)).toBe(false);
  });

  it('fast-fails execution when circuit is OPEN without executing target function', async () => {
    await breaker.trip(endpointId);

    const fn = vi.fn().mockResolvedValue('ok');
    await expect(breaker.execute(endpointId, fn)).rejects.toThrow(CircuitBreakerOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('transitions to HALF-OPEN after cooldown expires', async () => {
    // Trip to OPEN with opened_at in the past (>60s ago)
    store.set(`circuit_breaker:${endpointId}:state`, 'OPEN');
    const pastTime = Date.now() - 65 * 1000;
    store.set(`circuit_breaker:${endpointId}:opened_at`, String(pastTime));

    const state = await breaker.getState(endpointId);
    expect(state).toBe('HALF_OPEN');
    expect(await breaker.canExecute(endpointId)).toBe(true);
  });

  it('transitions from HALF-OPEN to CLOSED on successful canary request', async () => {
    // Set in HALF-OPEN
    store.set(`circuit_breaker:${endpointId}:state`, 'HALF_OPEN');

    const fn = vi.fn().mockResolvedValue({ status: 200 });
    const result = await breaker.execute(endpointId, fn);

    expect(result).toEqual({ status: 200 });
    expect(await breaker.getState(endpointId)).toBe('CLOSED');
    expect(store.get(`circuit_breaker:${endpointId}:state`)).toBe('CLOSED');
  });

  it('re-trips to OPEN if canary request fails during HALF-OPEN', async () => {
    store.set(`circuit_breaker:${endpointId}:state`, 'HALF_OPEN');

    const state = await breaker.recordFailure(endpointId, { statusCode: 500 });
    expect(state).toBe('OPEN');
    expect(await breaker.getState(endpointId)).toBe('OPEN');
  });

  describe('BullMQ Dispatcher Worker integration', () => {
    it('skips network call when circuit is OPEN', async () => {
      await breaker.trip(endpointId);

      const mockTransport = vi.fn();
      const worker = new DispatcherWorker(breaker, mockTransport);

      const result = await worker.processJob({
        data: {
          webhookId: endpointId,
          url: 'https://flapping-webhook.example.com/alerts',
          payload: { event: 'test' },
        },
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('circuit_breaker_open');
      expect(mockTransport).not.toHaveBeenCalled();
    });

    it('executes network call when circuit is CLOSED', async () => {
      const mockTransport = vi.fn().mockResolvedValue({ status: 200 });
      const worker = new DispatcherWorker(breaker, mockTransport);

      const result = await worker.processJob({
        data: {
          webhookId: endpointId,
          url: 'https://healthy-webhook.example.com/alerts',
          payload: { event: 'payment.received' },
        },
      });

      expect(result.status).toBe('delivered');
      expect(result.statusCode).toBe(200);
      expect(mockTransport).toHaveBeenCalledTimes(1);
    });
  });
});
