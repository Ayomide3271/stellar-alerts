import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  BatchDispatcher,
  DEFAULT_BATCH_MAX_SIZE,
  DEFAULT_BATCH_WINDOW_MS,
  MAX_BATCH_WINDOW_MS,
  MIN_BATCH_WINDOW_MS,
  serializeBatchPayload,
  type WebhookBatch,
} from '../batch-dispatcher';

function paymentEvent(amount: number, deliveryId?: string) {
  return {
    deliveryId,
    event: 'payment.received',
    data: { amount, asset: 'XLM', txHash: `tx-${amount}` },
  };
}

describe('BatchDispatcher — aggregation window (#719)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accumulates rapid events for the same target and flushes once at the window timeout', () => {
    const dispatcher = new BatchDispatcher({ windowMs: 5000 });
    const flushSpy = vi.fn();
    dispatcher.on('flush', flushSpy);

    dispatcher.enqueue('wh-1', paymentEvent(1));
    dispatcher.enqueue('wh-1', paymentEvent(2));
    dispatcher.enqueue('wh-1', paymentEvent(3));

    expect(dispatcher.pending('wh-1')).toBe(3);
    expect(flushSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4_999);
    expect(flushSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);

    const batch = flushSpy.mock.calls[0][0] as WebhookBatch;
    expect(batch.targetId).toBe('wh-1');
    expect(batch.count).toBe(3);
    expect(batch.events.map((event) => event.data.amount)).toEqual([1, 2, 3]);
    expect(dispatcher.pending('wh-1')).toBe(0);
  });

  it('flushes immediately when the maximum batch size is reached', () => {
    const dispatcher = new BatchDispatcher({ windowMs: 5000, maxBatchSize: 3 });
    const flushSpy = vi.fn();
    dispatcher.on('flush', flushSpy);

    dispatcher.enqueue('wh-1', paymentEvent(1));
    dispatcher.enqueue('wh-1', paymentEvent(2));
    expect(flushSpy).not.toHaveBeenCalled();

    dispatcher.enqueue('wh-1', paymentEvent(3));
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect((flushSpy.mock.calls[0][0] as WebhookBatch).count).toBe(3);

    // The window timer was cleared; no second flush should fire.
    vi.advanceTimersByTime(10_000);
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps separate windows per webhook target', () => {
    const dispatcher = new BatchDispatcher({ windowMs: 1000 });
    const flushSpy = vi.fn();
    dispatcher.on('flush', flushSpy);

    dispatcher.enqueue('wh-a', paymentEvent(10));
    dispatcher.enqueue('wh-b', paymentEvent(20));
    dispatcher.enqueue('wh-a', paymentEvent(11));

    expect(dispatcher.pendingTargets().sort()).toEqual(['wh-a', 'wh-b']);
    expect(dispatcher.pending('wh-a')).toBe(2);
    expect(dispatcher.pending('wh-b')).toBe(1);

    const batchA = dispatcher.flush('wh-a');
    expect(batchA?.count).toBe(2);
    expect(dispatcher.pending('wh-b')).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(flushSpy).toHaveBeenCalledTimes(2);
    const flushedTargets = flushSpy.mock.calls.map((call) => (call[0] as WebhookBatch).targetId);
    expect(flushedTargets).toContain('wh-b');
  });

  it('starts a fresh window for events arriving after a flush', () => {
    const dispatcher = new BatchDispatcher({ windowMs: 1000 });
    const flushSpy = vi.fn();
    dispatcher.on('flush', flushSpy);

    dispatcher.enqueue('wh-1', paymentEvent(1));
    vi.advanceTimersByTime(1000);
    expect(flushSpy).toHaveBeenCalledTimes(1);

    dispatcher.enqueue('wh-1', paymentEvent(2));
    vi.advanceTimersByTime(999);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(flushSpy).toHaveBeenCalledTimes(2);
    expect((flushSpy.mock.calls[1][0] as WebhookBatch).count).toBe(1);
  });
});

describe('BatchDispatcher — delivery id & signature preservation (#719)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves caller-supplied delivery ids and generates one when omitted', () => {
    const dispatcher = new BatchDispatcher({ windowMs: 5000 });
    const resultA = dispatcher.enqueue('wh-1', paymentEvent(1, 'delivery-a'));
    const resultB = dispatcher.enqueue('wh-1', paymentEvent(2));

    expect(resultA.deliveryId).toBe('delivery-a');
    expect(resultB.deliveryId).toMatch(/^[0-9a-f-]{36}$/);

    const batch = dispatcher.flush('wh-1');
    expect(batch?.events.map((event) => event.deliveryId)).toEqual([
      'delivery-a',
      resultB.deliveryId,
    ]);
  });

  it('serializes the batch as a JSON array of events with delivery ids', () => {
    const dispatcher = new BatchDispatcher({ windowMs: 5000 });
    dispatcher.enqueue({ targetId: 'wh-1', webhookId: 'db-webhook-1', url: 'https://example.com/hook' }, paymentEvent(1, 'd-1'));
    dispatcher.enqueue('wh-1', paymentEvent(2, 'd-2'));

    const batch = dispatcher.flush('wh-1');
    expect(batch).not.toBeNull();

    const payload = JSON.parse(serializeBatchPayload(batch as WebhookBatch));
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({
      deliveryId: 'd-1',
      event: 'payment.received',
      data: { amount: 1 },
    });
    expect(payload[1].deliveryId).toBe('d-2');

    // Target details supplied on the first enqueue carry through to the batch.
    expect(batch?.webhookId).toBe('db-webhook-1');
    expect(batch?.url).toBe('https://example.com/hook');
  });

  it('carries the signing secret provided on the target without persisting it elsewhere', () => {
    const dispatcher = new BatchDispatcher({ windowMs: 5000 });
    dispatcher.enqueue(
      { targetId: 'wh-1', url: 'https://example.com/hook', secret: 'whsec_123' },
      paymentEvent(1),
    );
    const batch = dispatcher.flush('wh-1');
    expect(batch?.secret).toBe('whsec_123');
  });
});

describe('BatchDispatcher — configuration & lifecycle (#719)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to a 5s window and 100-event maximum', () => {
    const dispatcher = new BatchDispatcher();
    expect(dispatcher.getWindowMs()).toBe(DEFAULT_BATCH_WINDOW_MS);
    expect(dispatcher.getMaxBatchSize()).toBe(DEFAULT_BATCH_MAX_SIZE);
  });

  it('clamps the aggregation window to 1–10 seconds', () => {
    expect(new BatchDispatcher({ windowMs: 250 }).getWindowMs()).toBe(MIN_BATCH_WINDOW_MS);
    expect(new BatchDispatcher({ windowMs: 60_000 }).getWindowMs()).toBe(MAX_BATCH_WINDOW_MS);
    expect(new BatchDispatcher({ windowMs: 7_500 }).getWindowMs()).toBe(7_500);
  });

  it('close() flushes all remaining targets and clears timers', () => {
    vi.useFakeTimers();
    const dispatcher = new BatchDispatcher({ windowMs: 5000 });
    const flushSpy = vi.fn();
    dispatcher.on('flush', flushSpy);

    dispatcher.enqueue('a', paymentEvent(1));
    dispatcher.enqueue('b', paymentEvent(2));

    const batches = dispatcher.close();
    expect(batches).toHaveLength(2);
    expect(dispatcher.pending()).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(flushSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects enqueue calls without any target identity', () => {
    const dispatcher = new BatchDispatcher();
    expect(() => dispatcher.enqueue({}, paymentEvent(1))).toThrow(/targetId, webhookId, or url/);
  });
});
