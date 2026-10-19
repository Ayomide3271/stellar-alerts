import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HorizonPool } from '../horizon-pool';

describe('HorizonPool Multi-Node Failover & Latency Probing (#640)', () => {
  const ENDPOINTS = [
    'https://horizon-node1.stellar.org',
    'https://horizon-node2.stellar.org',
    'https://horizon-node3.stellar.org',
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maintains priority list of configured Horizon RPC URLs', () => {
    const pool = new HorizonPool({ endpoints: ENDPOINTS });
    expect(pool.endpoints).toEqual(ENDPOINTS);
    expect(pool.getActiveNode()).toBe(ENDPOINTS[0]);
  });

  it('probes node health, latency, and ledger height', async () => {
    const pool = new HorizonPool({ endpoints: ENDPOINTS });
    const serverMock = {
      ledgers: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            call: vi.fn().mockResolvedValue({
              records: [{ sequence: 5432100 }],
            }),
          }),
        }),
      }),
    };
    vi.spyOn(pool, 'getServer').mockReturnValue(serverMock as any);

    const stats = await pool.probeNode(ENDPOINTS[0]);
    expect(stats.healthy).toBe(true);
    expect(stats.ledgerHeight).toBe(5432100);
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.lastError).toBeNull();
  });

  it('rotates to fallback node upon 503 error or 429 rate limit', async () => {
    const pool = new HorizonPool({ endpoints: ENDPOINTS, maxConsecutiveFailures: 1 });

    expect(pool.getActiveNode()).toBe(ENDPOINTS[0]);

    // Mark node 1 with 429 error
    pool.markNodeFailure(ENDPOINTS[0], { response: { status: 429 }, message: 'Too Many Requests' });

    // Should immediately rotate to node 2
    expect(pool.getActiveNode()).toBe(ENDPOINTS[1]);

    // Mark node 2 with 503 error
    pool.markNodeFailure(ENDPOINTS[1], { response: { status: 503 }, message: 'Service Unavailable' });

    // Should immediately rotate to node 3
    expect(pool.getActiveNode()).toBe(ENDPOINTS[2]);
  });

  it('executes periodic health probing every 30s', async () => {
    const pool = new HorizonPool({ endpoints: ENDPOINTS, probeIntervalMs: 30000 });
    const probeAllSpy = vi.spyOn(pool, 'probeAll').mockResolvedValue([]);

    pool.startHealthProbing();
    expect(probeAllSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30000);
    expect(probeAllSpy).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30000);
    expect(probeAllSpy).toHaveBeenCalledTimes(3);

    pool.stopHealthProbing();
    vi.advanceTimersByTime(30000);
    expect(probeAllSpy).toHaveBeenCalledTimes(3);
  });

  it('streamPaymentsWithFailover continues cursor across node switches without duplicate event emissions', async () => {
    const pool = new HorizonPool({ endpoints: ENDPOINTS, maxConsecutiveFailures: 1 });
    const receivedRecords: any[] = [];
    const receivedFromNodes: string[] = [];

    let node1Handler: any;
    let node2Handler: any;

    const server1Mock = {
      payments: () => ({
        forAccount: () => ({
          cursor: () => ({
            stream: (handlers: any) => {
              node1Handler = handlers;
              return () => {};
            },
          }),
        }),
      }),
    };

    const server2Mock = {
      payments: () => ({
        forAccount: () => ({
          cursor: () => ({
            stream: (handlers: any) => {
              node2Handler = handlers;
              return () => {};
            },
          }),
        }),
      }),
    };

    vi.spyOn(pool, 'getServer').mockImplementation((url: string) => {
      if (url === ENDPOINTS[0]) return server1Mock as any;
      if (url === ENDPOINTS[1]) return server2Mock as any;
      return server1Mock as any;
    });

    const close = pool.streamPaymentsWithFailover(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      'cursor-0',
      (record, nodeUrl) => {
        receivedRecords.push(record);
        receivedFromNodes.push(nodeUrl);
      },
    );

    // Node 1 receives event 1
    const event1 = {
      id: 'op-1',
      paging_token: '1001',
      transaction_hash: 'tx-hash-1',
      type: 'payment',
      amount: '100.0000000',
      asset_type: 'native',
      from: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      to: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF',
      created_at: new Date().toISOString(),
    };
    await node1Handler.onmessage(event1);

    expect(receivedRecords).toHaveLength(1);
    expect(receivedRecords[0].paging_token).toBe('1001');
    expect(receivedFromNodes[0]).toBe(ENDPOINTS[0]);

    // Node 1 experiences 429 rate limit
    node1Handler.onerror({ response: { status: 429 }, message: 'Rate limit 429' });

    // Advance timer for reconnect
    vi.advanceTimersByTime(1500);

    // Active node has shifted to Node 2
    expect(pool.getActiveNode()).toBe(ENDPOINTS[1]);
    expect(node2Handler).toBeDefined();

    // Node 2 re-sends event 1 (duplicate) followed by event 2
    await node2Handler.onmessage(event1); // duplicate: should be skipped!

    const event2 = {
      id: 'op-2',
      paging_token: '1002',
      transaction_hash: 'tx-hash-2',
      type: 'payment',
      amount: '200.0000000',
      asset_type: 'native',
      from: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      to: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF',
      created_at: new Date().toISOString(),
    };
    await node2Handler.onmessage(event2); // new: should be processed!

    expect(receivedRecords).toHaveLength(2);
    expect(receivedRecords[1].paging_token).toBe('1002');
    expect(receivedFromNodes[1]).toBe(ENDPOINTS[1]);

    close();
  });
});
