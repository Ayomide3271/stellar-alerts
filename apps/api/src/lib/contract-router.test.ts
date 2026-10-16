import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./soroban', () => ({
  fetchEventsForContracts: vi.fn(),
  getEventTopicName: (event: any) => {
    const first = Array.isArray(event.topic) ? event.topic[0] : undefined;
    return typeof first === 'string' ? first : 'default';
  },
}));

import { fetchEventsForContracts } from './soroban';
import {
  ContractRouter,
  ContractLimitError,
  MAX_ROUTER_CONTRACTS,
} from './contract-router';

const ev = (contractId: string, topic: string, ledger = 10) => ({
  contractId,
  topic: [topic],
  ledger,
});

describe('ContractRouter', () => {
  let router: ContractRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new ContractRouter();
  });

  it('registers up to 100 contracts and rejects the 101st', () => {
    for (let i = 0; i < MAX_ROUTER_CONTRACTS; i++) {
      router.subscribe(`C${i}`, async () => {});
    }
    expect(router.size).toBe(100);
    expect(() => router.subscribe('C-extra', async () => {})).toThrow(ContractLimitError);
    // extra handlers on an already-registered contract are still allowed
    expect(() => router.subscribe('C0', async () => {})).not.toThrow();
  });

  it('dispatches only to handlers whose contract and topic match', async () => {
    const transfers = vi.fn(async () => {});
    const anyTopic = vi.fn(async () => {});
    const other = vi.fn(async () => {});
    router.subscribe('CA', transfers, 'transfer');
    router.subscribe('CA', anyTopic);
    router.subscribe('CB', other);

    const count = await router.dispatchEvent(ev('CA', 'mint'));

    expect(count).toBe(1);
    expect(transfers).not.toHaveBeenCalled();
    expect(anyTopic).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();

    await router.dispatchEvent(ev('CA', 'transfer'));
    expect(transfers).toHaveBeenCalledTimes(1);
  });

  it('isolates handler errors', async () => {
    const good = vi.fn(async () => {});
    router.subscribe('CA', async () => {
      throw new Error('boom');
    });
    router.subscribe('CA', good);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await router.dispatchEvent(ev('CA', 'transfer'))).toBe(1);
    expect(good).toHaveBeenCalled();
  });

  it('polls all contracts in one batched fetch and advances per-contract cursors', async () => {
    const hA = vi.fn(async () => {});
    const hB = vi.fn(async () => {});
    router.subscribe('CA', hA);
    router.subscribe('CB', hB);
    vi.mocked(fetchEventsForContracts).mockResolvedValueOnce([
      ev('CA', 'transfer', 12),
      ev('CB', 'mint', 15),
    ]);

    await router.pollOnce(5);

    expect(fetchEventsForContracts).toHaveBeenCalledTimes(1);
    expect(fetchEventsForContracts).toHaveBeenCalledWith(['CA', 'CB'], 5);
    expect(hA).toHaveBeenCalledTimes(1);
    expect(hB).toHaveBeenCalledTimes(1);

    // Next poll resumes from the oldest cursor (13) and skips already-seen events.
    vi.mocked(fetchEventsForContracts).mockResolvedValueOnce([
      ev('CA', 'transfer', 12),
      ev('CB', 'mint', 15),
      ev('CA', 'transfer', 20),
    ]);
    await router.pollOnce(5);

    expect(fetchEventsForContracts).toHaveBeenLastCalledWith(['CA', 'CB'], 13);
    expect(hA).toHaveBeenCalledTimes(2);
    expect(hB).toHaveBeenCalledTimes(1);
  });

  it('fans routed alerts out to every channel and survives a failing one', async () => {
    const ok = vi.fn();
    router.registerChannel('bad', () => {
      throw new Error('channel down');
    });
    router.registerChannel('ok', ok);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const delivered = await router.dispatchToChannels({
      contractId: 'CA',
      topic: 'transfer',
      userIds: ['u1'],
      event: ev('CA', 'transfer'),
    });

    expect(delivered).toBe(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
