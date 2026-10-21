import { describe, expect, it, vi } from 'vitest';
import { OutboxService, outboxIdempotencyKey, type OutboxWriter } from './outbox.service';

function fakeTx() {
  const createMany = vi.fn().mockResolvedValue({ count: 2 });
  const tx: OutboxWriter = { outboxEvent: { createMany } };
  return { tx, createMany };
}

describe('OutboxService.record', () => {
  it('writes through the supplied transaction client with idempotency keys', async () => {
    const { tx, createMany } = fakeTx();

    await new OutboxService().record(tx, [
      { eventType: 'payment.alert', aggregateId: 'p1', payload: { paymentId: 'p1' } },
      { eventType: 'payment.realtime', aggregateId: 'p1', payload: { paymentId: 'p1' } },
    ]);

    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ eventType: 'payment.alert', idempotencyKey: 'payment.alert:p1' }),
        expect.objectContaining({ eventType: 'payment.realtime', idempotencyKey: 'payment.realtime:p1' }),
      ],
      skipDuplicates: true,
    });
  });

  it('derives a stable key per event type and aggregate', () => {
    expect(outboxIdempotencyKey('payment.alert', 'p1')).toBe(outboxIdempotencyKey('payment.alert', 'p1'));
    expect(outboxIdempotencyKey('payment.alert', 'p1')).not.toBe(outboxIdempotencyKey('payment.realtime', 'p1'));
  });

  it('does not touch the database for an empty batch', async () => {
    const { tx, createMany } = fakeTx();
    await expect(new OutboxService().record(tx, [])).resolves.toBeUndefined();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('propagates a failure so the surrounding transaction rolls back', async () => {
    const { tx, createMany } = fakeTx();
    createMany.mockRejectedValue(new Error('db down'));
    await expect(
      new OutboxService().record(tx, [{ eventType: 'payment.alert', aggregateId: 'p1', payload: {} }]),
    ).rejects.toThrow('db down');
  });
});
