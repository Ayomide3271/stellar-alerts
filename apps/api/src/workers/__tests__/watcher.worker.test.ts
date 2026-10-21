import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  payment: {
    findUnique: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
  },
  ingestionCursor: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  notificationPreference: { findUnique: vi.fn().mockResolvedValue(null) },
  outboxEvent: { createMany: vi.fn() },
  alertRule: { findMany: vi.fn().mockResolvedValue([]) },
  alertRuleDispatchLog: {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    ...prismaMock,
    wallet: { findMany: vi.fn() },
    $transaction: vi.fn((callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock)),
  },
}));

vi.mock('../../lib/stellar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stellar')>();
  return {
    ...actual,
    decodeHorizonAsset: vi.fn((record: any) => ({
      assetCode: record?.asset_type === 'native' ? 'XLM' : record?.asset_code || 'XLM',
      assetIssuer: record?.asset_issuer || null,
    })),
    stellar: {
      server: {},
      multiNode: { streamPaymentsMultiNode: vi.fn(() => vi.fn()) },
      getRecentPayments: vi.fn().mockResolvedValue([]),
      getPaymentsSince: vi.fn(),
      getPaymentsSinceResult: vi.fn(),
      getLatestPagingToken: vi.fn(),
      openPaymentStream: vi.fn(),
    },
  };
});

vi.mock('../../lib/queue', () => ({
  enqueuePaymentAlert: vi.fn(),
}));

vi.mock('../../lib/lock', () => ({
  withWalletLock: vi.fn(async (_walletId: string, fn: () => Promise<any>) => fn()),
}));

vi.mock('../../lib/realtime', () => ({
  publishPaymentEvent: vi.fn().mockResolvedValue(undefined),
  publishDeliveryEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/checksumChain.service', () => ({
  appendPaymentChecksum: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../lib/prisma';
import { stellar } from '../../lib/stellar';
import { withWalletLock } from '../../lib/lock';
import { enqueuePaymentAlert } from '../../lib/queue';
import {
  ensureCursor,
  processWalletPayments,
  saveCursor,
  handleStreamRecord,
  startHorizonSSEStream,
  processPaymentRecord,
  streamMetrics,
  type StreamConnector,
} from '../watcher.worker';

const wallet = {
  id: 'wallet-1',
  publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
};

const paymentRecord = (pagingToken: string, txHash: string) => ({
  id: pagingToken,
  paging_token: pagingToken,
  type: 'payment',
  amount: '10.5',
  asset_type: 'native',
  from: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSFMG4BVI',
  transaction_hash: txHash,
  created_at: '2026-08-24T10:00:00Z',
});

// TOID = ledgerSeq << 32 | txOrder << 12 | opOrder — matches lib/cursor-recovery.ts decoding.
const toid = (ledgerSeq: number, txOrder = 1, opOrder = 1): string =>
  ((BigInt(ledgerSeq) << 32n) | (BigInt(txOrder) << 12n) | BigInt(opOrder)).toString();

const okResult = (records: any[]) => ({ records, allNodesFailed: false, lastError: null });
const outageResult = (lastError: string) => ({ records: [], allNodesFailed: true, lastError });

describe('Watcher ingestion cursor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.payment.findUnique).mockResolvedValue({ id: 'payment-1' } as any);
    vi.mocked(prisma.payment.createMany).mockResolvedValue({ count: 1 } as any);
  });

  describe('ensureCursor', () => {
    it('creates a cursor record seeded from the latest paging token on first sight', async () => {
      vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue(null as any);
      vi.mocked(stellar.getLatestPagingToken).mockResolvedValue('4000');
      vi.mocked(prisma.ingestionCursor.upsert).mockResolvedValue({ pagingToken: '4000' } as any);

      const cursor = await ensureCursor(wallet);

      expect(prisma.ingestionCursor.upsert).toHaveBeenCalledWith({
        where: { walletId: wallet.id },
        create: { walletId: wallet.id, pagingToken: '4000' },
        update: {},
      });
      expect(cursor).toBe('4000');
    });

    it('returns the persisted paging token without touching Horizon', async () => {
      vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue({ pagingToken: '4200' } as any);

      const cursor = await ensureCursor(wallet);

      expect(cursor).toBe('4200');
      expect(stellar.getLatestPagingToken).not.toHaveBeenCalled();
      expect(prisma.ingestionCursor.create).not.toHaveBeenCalled();
    });
  });

  describe('saveCursor', () => {
    it('upserts the paging token keyed by wallet, recording success health', async () => {
      vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue(null as any);

      await saveCursor(wallet.id, toid(1000));

      expect(prisma.ingestionCursor.upsert).toHaveBeenCalledWith({
        where: { walletId: wallet.id },
        create: { walletId: wallet.id, pagingToken: toid(1000) },
        update: expect.objectContaining({
          pagingToken: toid(1000),
          status: 'active',
          consecutiveFailures: 0,
          lastError: null,
        }),
      });
    });
  });

  describe('processWalletPayments', () => {
    it('resumes the Horizon query from the persisted cursor (restart scenario)', async () => {
      vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue({ pagingToken: '4200', consecutiveFailures: 0 } as any);
      vi.mocked(stellar.getPaymentsSinceResult).mockResolvedValue(okResult([]));

      await processWalletPayments(wallet);

      expect(stellar.getPaymentsSinceResult).toHaveBeenCalledWith(wallet.publicKey, '4200', 50);
    });

    it('advances the cursor to the paging token of every processed record', async () => {
      vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue({ pagingToken: toid(1000), consecutiveFailures: 0 } as any);
      vi.mocked(stellar.getPaymentsSinceResult).mockResolvedValue(
        okResult([paymentRecord(toid(1001), 'hash-a'), paymentRecord(toid(1002), 'hash-b')]),
      );

      await processWalletPayments(wallet);

      expect(vi.mocked(prisma.ingestionCursor.upsert).mock.calls.map((call) => call[0].update.pagingToken)).toEqual([
        toid(1001),
        toid(1002),
      ]);
    });

    it('persists the payment and cursor inside the same transaction', async () => {
      vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue({ pagingToken: toid(1000) } as any);
      vi.mocked(stellar.getPaymentsSinceResult).mockResolvedValue(
        okResult([paymentRecord(toid(1001), 'hash-atomic')]),
      );

      await processWalletPayments(wallet);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.payment.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ txHash: 'hash-atomic' })],
        skipDuplicates: true,
      });
      expect(prisma.ingestionCursor.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ pagingToken: toid(1001) }) }),
      );
      expect(withWalletLock).toHaveBeenCalledWith(
        wallet.id,
        expect.any(Function),
        { retryCount: 3, retryDelayMs: 100 },
      );
    });

    it('pages through a backlog until Horizon returns a partial page', async () => {
      vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue({ pagingToken: toid(1000), consecutiveFailures: 0 } as any);
      const fullPage = Array.from({ length: 50 }, (_, i) =>
        paymentRecord(toid(1001 + i), `hash-${i}`)
      );
      vi.mocked(stellar.getPaymentsSinceResult)
        .mockResolvedValueOnce(okResult(fullPage))
        .mockResolvedValueOnce(okResult([paymentRecord(toid(1051), 'hash-tail')]));

      await processWalletPayments(wallet);

      expect(stellar.getPaymentsSinceResult).toHaveBeenCalledTimes(2);
      expect(vi.mocked(stellar.getPaymentsSinceResult).mock.calls[1]).toEqual([wallet.publicKey, toid(1050), 50]);
    });

    it('skips wallets with an invalid public key', async () => {
      await processWalletPayments({ id: 'wallet-2', publicKey: 'not-a-key' });

      expect(prisma.ingestionCursor.findUnique).not.toHaveBeenCalled();
      expect(stellar.getPaymentsSinceResult).not.toHaveBeenCalled();
    });
  });

  describe('cursor recovery hardening', () => {
    it('ledger gap scenario: a large ledger jump triggers a bounded backfill and clears the gap flag', async () => {
      vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue({ pagingToken: toid(1000), consecutiveFailures: 0 } as any);
      // The next record jumps from ledger 1000 to 1500 — far past the default gap threshold.
      vi.mocked(stellar.getPaymentsSinceResult).mockResolvedValueOnce(
        okResult([paymentRecord(toid(1500), 'hash-after-gap')]),
      );
      vi.mocked(stellar.getRecentPayments).mockResolvedValue([
        paymentRecord(toid(1499), 'hash-recent-2'),
        paymentRecord(toid(1500), 'hash-after-gap'),
      ] as any);

      await processWalletPayments(wallet);

      // Bounded backfill re-fetched recent payments instead of an unbounded replay.
      expect(stellar.getRecentPayments).toHaveBeenCalledWith(wallet.publicKey, expect.any(Number));

      const updateCalls = vi.mocked(prisma.ingestionCursor.upsert).mock.calls.map((c) => c[0].update);
      expect(updateCalls.some((u) => u.status === 'gap_detected')).toBe(true);

      // The final persisted state clears the gap flag once bounded backfill completes.
      expect(prisma.ingestionCursor.update).toHaveBeenCalledWith({
        where: { walletId: wallet.id },
        data: { status: 'active' },
      });
    });

    it('provider outage scenario: every Horizon node failing does not advance the cursor and is retried next poll', async () => {
      vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue({ pagingToken: toid(1000), consecutiveFailures: 1 } as any);
      vi.mocked(stellar.getPaymentsSinceResult).mockResolvedValue(outageResult('All Horizon nodes unreachable'));

      await processWalletPayments(wallet);

      expect(prisma.ingestionCursor.upsert).not.toHaveBeenCalled();
      expect(prisma.ingestionCursor.update).toHaveBeenCalledWith({
        where: { walletId: wallet.id },
        data: { consecutiveFailures: 2, lastError: 'All Horizon nodes unreachable' },
      });
    });

    it('reorg-like duplicate scenario: a raced duplicate advances the cursor without re-alerting', async () => {
      vi.mocked(prisma.payment.createMany).mockResolvedValueOnce({ count: 0 } as any);
      vi.mocked(prisma.payment.findUnique).mockResolvedValueOnce({ id: 'payment-winner' } as any);
      vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue(null as any);

      await expect(handleStreamRecord(wallet, paymentRecord(toid(2000), 'hash-race'))).resolves.not.toThrow();

      expect(enqueuePaymentAlert).not.toHaveBeenCalled();
      // The cursor still advances — the record was legitimately processed by the winner.
      expect(prisma.ingestionCursor.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ pagingToken: toid(2000) }) }),
      );
    });
  });
});

describe('handleStreamRecord (live SSE message handler)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.payment.findUnique).mockResolvedValue({ id: 'payment-1' } as any);
    vi.mocked(prisma.payment.createMany).mockResolvedValue({ count: 1 } as any);
  });

  it('persists a payment and advances the ingestion cursor', async () => {
    await handleStreamRecord(wallet, paymentRecord('5001', 'hash-hsr'));

    expect(prisma.payment.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.ingestionCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ pagingToken: '5001' }) })
    );
  });

  it('does not re-ingest a payment that was already seen', async () => {
    vi.mocked(prisma.payment.createMany).mockResolvedValueOnce({ count: 0 } as any);
    vi.mocked(prisma.payment.findUnique).mockResolvedValue({ id: 'existing' } as any);

    await handleStreamRecord(wallet, paymentRecord('5002', 'hash-dup'));

    // Payment is not re-created, but the cursor still advances past it.
    expect(prisma.payment.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.ingestionCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ pagingToken: '5002' }) })
    );
  });
});

describe('Horizon SSE stream lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(prisma.payment.findUnique).mockResolvedValue({ id: 'payment-1' } as any);
    vi.mocked(prisma.payment.createMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.ingestionCursor.findUnique).mockResolvedValue({ pagingToken: '4200' } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeConnector = () => {
    const connections: { handlers: any; close: ReturnType<typeof vi.fn> }[] = [];
    const connector: StreamConnector = (cursor, handlers) => {
      const close = vi.fn();
      connections.push({ handlers, close });
      return close;
    };
    return { connector, connections };
  };

  it('opens a stream from the persisted cursor and ingests live messages', async () => {
    const { connector, connections } = makeConnector();

    const close = await startHorizonSSEStream(wallet, { connector });

    expect(connections).toHaveLength(1);
    expect(connections[0].handlers.onmessage).toBeTypeOf('function');

    await connections[0].handlers.onmessage(paymentRecord('4201', 'hash-sse'));

    expect(prisma.payment.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.ingestionCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ pagingToken: '4201' }) })
    );

    close();
  });

  it('uses the multi-node Horizon cluster for its default connector', async () => {
    const closeStream = vi.fn();
    vi.mocked(stellar.multiNode.streamPaymentsMultiNode).mockReturnValue(closeStream);

    const close = await startHorizonSSEStream(wallet);

    expect(stellar.multiNode.streamPaymentsMultiNode).toHaveBeenCalledWith(
      wallet.publicKey,
      '4200',
      expect.any(Function),
    );
    close();
    expect(closeStream).toHaveBeenCalledTimes(1);
  });

  it('automatically reconnects after a network drop', async () => {
    const { connector, connections } = makeConnector();

    const close = await startHorizonSSEStream(wallet, { connector, reconnectDelayMs: 10 });
    expect(connections).toHaveLength(1);

    // Simulate the underlying EventSource dropping.
    connections[0].handlers.onerror(new Error('network drop'));

    // The broken connection is torn down immediately...
    expect(connections[0].close).toHaveBeenCalledTimes(1);

    // ...and a fresh stream is opened after the backoff delay.
    await vi.advanceTimersByTimeAsync(10);
    expect(connections).toHaveLength(2);

    close();
  });

  it('stops reconnecting once maxReconnectAttempts is reached', async () => {
    const { connector, connections } = makeConnector();

    const close = await startHorizonSSEStream(wallet, {
      connector,
      reconnectDelayMs: 10,
      maxReconnectAttempts: 2,
    });
    expect(connections).toHaveLength(1);

    connections[0].handlers.onerror(new Error('drop-1'));
    await vi.advanceTimersByTimeAsync(10);
    expect(connections).toHaveLength(2);

    connections[1].handlers.onerror(new Error('drop-2'));
    await vi.advanceTimersByTimeAsync(10);
    // attempts has reached the limit: no further reconnect.
    expect(connections).toHaveLength(2);

    close();
  });

  it('close() cancels any pending reconnect', async () => {
    const { connector, connections } = makeConnector();

    const close = await startHorizonSSEStream(wallet, { connector, reconnectDelayMs: 10 });
    connections[0].handlers.onerror(new Error('drop'));
    close();

    await vi.advanceTimersByTimeAsync(10);
    expect(connections).toHaveLength(1);
  });

  it('does not open a stream for an invalid public key', async () => {
    const { connector, connections } = makeConnector();

    const close = await startHorizonSSEStream(
      { id: 'wallet-2', publicKey: 'not-a-key' },
      { connector }
    );

    expect(connections).toHaveLength(0);
    expect(typeof close).toBe('function');
  });

  it('grows the reconnect delay exponentially on repeated drops', async () => {
    const { connector, connections } = makeConnector();

    const close = await startHorizonSSEStream(wallet, {
      connector,
      reconnectDelayMs: 10,
      maxReconnectDelayMs: 1000,
    });
    expect(connections).toHaveLength(1);

    // 1st drop: base delay (10ms).
    connections[0].handlers.onerror(new Error('drop-1'));
    await vi.advanceTimersByTimeAsync(9);
    expect(connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connections).toHaveLength(2);

    // 2nd drop: delay doubles to 20ms.
    connections[1].handlers.onerror(new Error('drop-2'));
    await vi.advanceTimersByTimeAsync(19);
    expect(connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connections).toHaveLength(3);

    close();
  });

  it('caps the reconnect delay at maxReconnectDelayMs', async () => {
    const { connector, connections } = makeConnector();

    const close = await startHorizonSSEStream(wallet, {
      connector,
      reconnectDelayMs: 10,
      maxReconnectDelayMs: 15,
    });

    // 1st drop: 10ms. 2nd drop would be 20ms uncapped, but is capped to 15ms.
    connections[0].handlers.onerror(new Error('drop-1'));
    await vi.advanceTimersByTimeAsync(10);
    expect(connections).toHaveLength(2);

    connections[1].handlers.onerror(new Error('drop-2'));
    await vi.advanceTimersByTimeAsync(14);
    expect(connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connections).toHaveLength(3);

    close();
  });

  it('resets heartbeat timer on every chunk and reconnects upon silent TCP timeout expiration (#538)', async () => {
    const { connector, connections } = makeConnector();
    const close = await startHorizonSSEStream(wallet, {
      connector,
      reconnectDelayMs: 10,
      heartbeatTimeoutMs: 30000,
    });

    expect(connections).toHaveLength(1);
    const initialHeartbeatTimeouts = streamMetrics.heartbeatTimeouts;
    const initialReconnects = streamMetrics.reconnects;

    // Advance 25s (< 30s) — stream remains active, no reconnect
    await vi.advanceTimersByTimeAsync(25000);
    expect(connections).toHaveLength(1);
    expect(connections[0].close).not.toHaveBeenCalled();

    // A chunk/message arrives on the SSE stream; heartbeat timer resets
    await connections[0].handlers.onmessage(paymentRecord('4201', 'hash-chunk-1'));
    expect(connections).toHaveLength(1);

    // Advance another 25s (total 50s from start, but 25s since chunk) — still no timeout
    await vi.advanceTimersByTimeAsync(25000);
    expect(connections).toHaveLength(1);
    expect(connections[0].close).not.toHaveBeenCalled();

    // Now advance 30s with silence (simulating silent TCP stream drop)
    await vi.advanceTimersByTimeAsync(30000);

    // Old stream was closed and reconnect triggered
    expect(connections[0].close).toHaveBeenCalledTimes(1);
    expect(connections).toHaveLength(2);
    expect(streamMetrics.heartbeatTimeouts).toBe(initialHeartbeatTimeouts + 1);
    expect(streamMetrics.reconnects).toBe(initialReconnects + 1);

    close();
  });

  it('processes messages one at a time and drops beyond the backpressure limit', async () => {
    vi.useRealTimers();
    const { connector, connections } = makeConnector();
    let resolveFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(prisma.payment.createMany).mockImplementationOnce(async () => {
      await gate;
      return { count: 1 } as any;
    });

    const close = await startHorizonSSEStream(wallet, { connector, maxQueuedMessages: 2 });
    const before = streamMetrics.backpressureDropped;

    // First message starts processing immediately (occupying 1 of 2 slots) and
    // blocks on `gate` — not awaited here so the next messages can be dispatched
    // while it's in flight.
    const first = connections[0].handlers.onmessage(paymentRecord('4201', 'hash-1'));
    // Second message fills the remaining slot, queued behind the in-flight one.
    const second = connections[0].handlers.onmessage(paymentRecord('4202', 'hash-2'));
    // Third message exceeds the bounded queue (2/2 slots taken) and is dropped.
    await connections[0].handlers.onmessage(paymentRecord('4203', 'hash-3'));

    expect(streamMetrics.backpressureDropped).toBe(before + 1);

    resolveFirst();
    await Promise.all([first, second]);
    expect(prisma.payment.createMany).toHaveBeenCalledTimes(2);

    close();
    vi.useFakeTimers();
  });
});

describe('processPaymentRecord — persisted AlertRule evaluator', () => {
  const userWallet = { id: 'wallet-1', publicKey: wallet.publicKey, userId: 'user-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.payment.findUnique).mockResolvedValue(null as any);
    vi.mocked(prisma.payment.findUnique)
      .mockResolvedValueOnce(null as any)
      .mockResolvedValue({ id: 'payment-1' } as any);
    vi.mocked(prisma.payment.create).mockResolvedValue({ id: 'payment-1' } as any);
    vi.mocked(prisma.alertRule.findMany).mockResolvedValue([]);
    vi.mocked(prisma.alertRuleDispatchLog.findUnique).mockResolvedValue(null as any);
    vi.mocked(prisma.notificationPreference.findUnique).mockResolvedValue(null as any);
    vi.mocked(prisma.outboxEvent.createMany).mockResolvedValue({ count: 2 } as any);
  });

  it('enqueues an alert when an active AlertRule matches the payment', async () => {
    vi.mocked(prisma.alertRule.findMany).mockResolvedValue([
      { id: 'rule-1', userId: 'user-1', walletId: null, assets: [], minAmount: null, conditions: null, isActive: true },
    ] as any);

    await processPaymentRecord(userWallet, paymentRecord('6001', 'hash-rule-match'));

    expect(enqueuePaymentAlert).toHaveBeenCalledTimes(1);
    expect(prisma.alertRuleDispatchLog.create).toHaveBeenCalledWith({
      data: { paymentId: 'payment-1', matchedRuleIds: ['rule-1'] },
    });
    expect(prisma.outboxEvent.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ eventType: 'payment.alert', aggregateId: 'payment-1', idempotencyKey: 'payment.alert:payment-1' }),
        expect.objectContaining({ eventType: 'payment.realtime', aggregateId: 'payment-1', idempotencyKey: 'payment.realtime:payment-1' }),
      ]),
      skipDuplicates: true,
    });
    // The legacy filterRules gate must not run once AlertRule rows exist for the user.
    expect(prisma.notificationPreference.findUnique).not.toHaveBeenCalled();
  });

  it('does not enqueue when the user has AlertRules but none match (multi-asset, no match)', async () => {
    vi.mocked(prisma.alertRule.findMany).mockResolvedValue([
      { id: 'usdc-only', userId: 'user-1', walletId: null, assets: ['USDC'], minAmount: null, conditions: null, isActive: true },
    ] as any);

    // paymentRecord() is a native XLM payment, which the USDC-only rule rejects.
    await processPaymentRecord(userWallet, paymentRecord('6002', 'hash-no-match'));

    expect(enqueuePaymentAlert).not.toHaveBeenCalled();
    expect(prisma.alertRuleDispatchLog.create).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ eventType: 'payment.realtime', aggregateId: 'payment-1' })],
      skipDuplicates: true,
    });
  });

  it('respects a minimum amount threshold rule', async () => {
    vi.mocked(prisma.alertRule.findMany).mockResolvedValue([
      { id: 'min-100', userId: 'user-1', walletId: null, assets: [], minAmount: 100, conditions: null, isActive: true },
    ] as any);

    // paymentRecord() amount is '10.5', below the 100 threshold.
    await processPaymentRecord(userWallet, paymentRecord('6003', 'hash-below-threshold'));

    expect(enqueuePaymentAlert).not.toHaveBeenCalled();
  });

  it('never matches an inactive AlertRule', async () => {
    vi.mocked(prisma.alertRule.findMany).mockResolvedValue([
      { id: 'inactive', userId: 'user-1', walletId: null, assets: [], minAmount: null, conditions: null, isActive: false },
    ] as any);

    await processPaymentRecord(userWallet, paymentRecord('6004', 'hash-inactive'));

    expect(enqueuePaymentAlert).not.toHaveBeenCalled();
  });

  it('does not re-enqueue a duplicate delivery of the same payment event', async () => {
    vi.mocked(prisma.alertRule.findMany).mockResolvedValue([
      { id: 'rule-1', userId: 'user-1', walletId: null, assets: [], minAmount: null, conditions: null, isActive: true },
    ] as any);
    vi.mocked(prisma.alertRuleDispatchLog.findUnique).mockResolvedValue({ id: 'log-1' } as any);

    await processPaymentRecord(userWallet, paymentRecord('6005', 'hash-duplicate'));

    expect(enqueuePaymentAlert).not.toHaveBeenCalled();
    expect(prisma.alertRuleDispatchLog.create).not.toHaveBeenCalled();
  });

  it('falls back to the legacy filterRules gate when the user has no AlertRule rows', async () => {
    vi.mocked(prisma.alertRule.findMany).mockResolvedValue([]);
    vi.mocked(prisma.notificationPreference.findUnique).mockResolvedValue({ filterRules: null } as any);

    await processPaymentRecord(userWallet, paymentRecord('6006', 'hash-legacy'));

    expect(prisma.notificationPreference.findUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(enqueuePaymentAlert).toHaveBeenCalledTimes(1);
  });

  describe('processPaymentRecord with SAC transfer', () => {
    it('processes SAC transfer event with dynamic decimal formatting', async () => {
      const { processPaymentRecord } = await import('../watcher.worker');
      const { enqueuePaymentAlert } = await import('../../lib/queue');
      const sorobanLib = await import('../../lib/soroban');

      vi.spyOn(sorobanLib, 'getSacMetadata').mockResolvedValue({
        contractId: 'CA3D525ZJGCS2JA7SXG5E5Z265WJCCAKTHR5EEXY355E55E55E55E55E',
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
      });

      const sacRecord = {
        type: 'contract_event',
        contractId: 'CA3D525ZJGCS2JA7SXG5E5Z265WJCCAKTHR5EEXY355E55E55E55E55E',
        transaction_hash: 'tx-sac-123',
        created_at: '2026-08-24T12:00:00Z',
        topic: ['transfer', 'GBRPYHIL2CI3FNQ4BXLFMNDLFPPPU2HY4ZDM4T6VKFZ4MVEXDHJA5W5T', wallet.publicKey],
        value: {
          amount: '25000000', // 25 USDC with 6 decimals
        },
      };

      await processPaymentRecord(wallet, sacRecord);

      expect(prisma.payment.createMany).toHaveBeenCalledWith({
        data: [{
          walletId: wallet.id,
          txHash: 'tx-sac-123',
          fromAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFPPPU2HY4ZDM4T6VKFZ4MVEXDHJA5W5T',
          amount: 25,
          asset: 'USDC',
          assetIssuer: null,
          memo: null,
          receivedAt: new Date('2026-08-24T12:00:00Z'),
        }],
        skipDuplicates: true,
      });

      expect(enqueuePaymentAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          txHash: 'tx-sac-123',
          amount: '25',
          asset: 'USDC',
          fromAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFPPPU2HY4ZDM4T6VKFZ4MVEXDHJA5W5T',
        })
      );
    });
  });
});
