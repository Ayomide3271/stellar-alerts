import { beforeEach, describe, expect, it, vi } from 'vitest';

const { outboxEvent, enqueuePaymentAlert, publish } = vi.hoisted(() => ({
  outboxEvent: {
    updateMany: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  enqueuePaymentAlert: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({ prisma: { outboxEvent } }));
vi.mock('../../lib/queue', () => ({ enqueuePaymentAlert }));
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
    enqueuePaymentAlert.mockResolvedValue({ id: 'job-1' });
    publish.mockResolvedValue(1);
  });

  it('relays alert and realtime events and marks both processed', async () => {
    outboxEvent.findMany.mockResolvedValue([
      { id: 'event-alert', eventType: 'payment.alert', attempts: 1, payload: { paymentId: 'payment-1' } },
      { id: 'event-realtime', eventType: 'payment.realtime', attempts: 1, payload: { paymentId: 'payment-1' } },
    ]);

    await expect(relayOutboxBatch()).resolves.toBe(2);

    expect(enqueuePaymentAlert).toHaveBeenCalledWith({ paymentId: 'payment-1', eventId: 'event-alert' });
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
    enqueuePaymentAlert.mockRejectedValue(new Error('Redis unavailable'));

    await expect(relayOutboxBatch()).resolves.toBe(1);

    expect(outboxEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'event-alert' },
      data: expect.objectContaining({ status: 'pending', lastError: 'Redis unavailable' }),
    }));
  });
});