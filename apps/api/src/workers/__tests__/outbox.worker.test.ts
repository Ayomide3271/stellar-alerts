import { beforeEach, describe, expect, it, vi } from 'vitest';

const { outboxEvent, enqueuePaymentAlertStrict, publish } = vi.hoisted(() => ({
  outboxEvent: {
    updateMany: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  enqueuePaymentAlertStrict: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({ prisma: { outboxEvent } }));
vi.mock('../../lib/queue', () => ({ enqueuePaymentAlertStrict }));
vi.mock('../../lib/redis', () => ({ redis: { publish } }));
vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { relayOutboxBatch } from '../outbox.worker';

describe('outbox relay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboxEvent.updateMany.mockImplementation(async (args: { where: { status: string } }) => ({
      count: args.where.status === 'pending' ? 1 : 0,
    }));
    outboxEvent.update.mockResolvedValue({});
    enqueuePaymentAlertStrict.mockResolvedValue({ id: 'job-1' });
    publish.mockResolvedValue(1);
  });

  it('relays alert and realtime events and marks both processed', async () => {
    outboxEvent.findMany.mockResolvedValue([
      { id: 'event-alert', eventType: 'payment.alert', attempts: 1, payload: { paymentId: 'payment-1' } },
      { id: 'event-realtime', eventType: 'payment.realtime', attempts: 1, payload: { paymentId: 'payment-1' } },
    ]);

    await expect(relayOutboxBatch()).resolves.toBe(2);

    expect(enqueuePaymentAlertStrict).toHaveBeenCalledWith({ paymentId: 'payment-1', eventId: 'event-alert' });
    expect(publish).toHaveBeenCalledWith(
      'stellar-alerts:payments',
      expect.stringContaining('event-realtime'),
    );
    expect(outboxEvent.update).toHaveBeenCalledTimes(2);
  });

  it('returns failed events to pending with a retry time', async () => {
    outboxEvent.findMany.mockResolvedValue([
      { id: 'event-alert', eventType: 'payment.alert', attempts: 2, payload: { paymentId: 'payment-1' } },
    ]);
    enqueuePaymentAlertStrict.mockRejectedValue(new Error('Redis unavailable'));

    await expect(relayOutboxBatch()).resolves.toBe(1);

    expect(outboxEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'event-alert' },
      data: expect.objectContaining({ status: 'pending', lastError: 'Redis unavailable' }),
    }));
  });
});
describe('outbox relay during a Redis outage', () => {
  // In-memory outbox table so the relay's real claim/mark logic runs end to end.
  type Row = { id: string; eventType: string; payload: unknown; status: string; attempts: number; availableAt: Date; lockedAt: Date | null; createdAt: Date };
  let rows: Row[];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    rows = ['a', 'b', 'c'].map((id, i) => ({
      id: `event-${id}`, eventType: 'payment.alert', payload: { txHash: `tx-${id}` },
      status: 'pending', attempts: 0, availableAt: new Date(0), lockedAt: null, createdAt: new Date(i),
    }));
    const matches = (r: Row, where: any) =>
      (!where.id || r.id === where.id) && (!where.status || r.status === where.status) &&
      (!where.availableAt?.lte || r.availableAt <= where.availableAt.lte) &&
      (!where.lockedAt?.lt || (r.lockedAt !== null && r.lockedAt < where.lockedAt.lt));
    outboxEvent.findMany.mockImplementation(async ({ where, take }: any) =>
      rows.filter((r) => matches(r, where)).slice(0, take).map((r) => ({ ...r })));
    outboxEvent.updateMany.mockImplementation(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) {
        const { attempts, ...rest } = data;
        Object.assign(r, rest);
        if (attempts?.increment) r.attempts += attempts.increment;
      }
      return { count: hit.length };
    });
    outboxEvent.update.mockImplementation(async ({ where, data }: any) => {
      Object.assign(rows.find((r) => r.id === where.id)!, data);
      return {};
    });
  });

  it('keeps every event pending while Redis is down, then delivers each exactly once', async () => {
    enqueuePaymentAlertStrict.mockRejectedValue(new Error('ECONNREFUSED'));
    await relayOutboxBatch();
    expect(rows.every((r) => r.status === 'pending' && r.attempts === 1)).toBe(true);

    // Redis recovers; make the retry windows elapse.
    rows.forEach((r) => { r.availableAt = new Date(0); });
    enqueuePaymentAlertStrict.mockReset();
    enqueuePaymentAlertStrict.mockResolvedValue({ id: 'job' });
    await relayOutboxBatch();
    await relayOutboxBatch();

    expect(rows.every((r) => r.status === 'processed')).toBe(true);
    expect(enqueuePaymentAlertStrict).toHaveBeenCalledTimes(3);
    const sent = enqueuePaymentAlertStrict.mock.calls.map(([p]: any) => p.eventId).sort();
    expect(sent).toEqual(['event-a', 'event-b', 'event-c']);
  });

  it('does not relay an event that is already claimed or processed', async () => {
    rows[0].status = 'processed';
    rows[1].status = 'processing';
    rows[1].lockedAt = new Date();
    await relayOutboxBatch();
    expect(enqueuePaymentAlertStrict).toHaveBeenCalledTimes(1);
    expect(enqueuePaymentAlertStrict).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'event-c' }));
  });
});
