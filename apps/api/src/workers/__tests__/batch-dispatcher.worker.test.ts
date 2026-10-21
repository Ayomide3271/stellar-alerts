import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  deliverBatch,
  flushAndDeliver,
  startBatchDispatcherWorker,
} from '../batch-dispatcher.worker';
import { BatchDispatcher, type WebhookBatch } from '../../modules/alerts/batch-dispatcher';
import { evaluateWebhookVerification } from '../../utils/webhook-signer';

const SECRET = 'whsec_batch_test_secret';

function buildBatch(dispatcher: BatchDispatcher): WebhookBatch {
  dispatcher.enqueue(
    {
      targetId: 'wh-1',
      webhookId: 'db-webhook-1',
      url: 'https://receiver.example.com/hooks',
      secret: SECRET,
    },
    {
      deliveryId: 'delivery-1',
      event: 'payment.received',
      data: { amount: '10', asset: 'XLM', txHash: 'tx-1' },
    },
  );
  dispatcher.enqueue('wh-1', {
    deliveryId: 'delivery-2',
    event: 'payment.received',
    data: { amount: '20', asset: 'USDC', txHash: 'tx-2' },
  });

  const batch = dispatcher.flush('wh-1');
  if (!batch) throw new Error('expected batch');
  return batch;
}

describe('dispatcher.worker — signed batch delivery (#719)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs a single JSON array with a signature that covers the whole batch', async () => {
    const dispatcher = new BatchDispatcher({ windowMs: 1000 });
    const batch = buildBatch(dispatcher);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

    const result = await deliverBatch(batch, {
      fetchImpl: fetchMock as unknown as typeof import('../../utils/ssrf').ssrfSafeFetch,
    });

    expect(result).toEqual({
      batchId: batch.batchId,
      targetId: 'wh-1',
      delivered: true,
      status: 200,
      deliveryIds: ['delivery-1', 'delivery-2'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://receiver.example.com/hooks');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Stellar-Alerts-Batch-Id']).toBe(batch.batchId);
    expect(headers['X-Stellar-Alerts-Batch-Count']).toBe('2');
    expect(headers['X-Stellar-Alerts-Delivery-Ids']).toBe('delivery-1,delivery-2');
    expect(headers['X-Stellar-Alerts-Nonce']).toBeTruthy();

    const body = init.body as string;
    const parsed = JSON.parse(body);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((event: { deliveryId: string }) => event.deliveryId)).toEqual([
      'delivery-1',
      'delivery-2',
    ]);

    // The HMAC verifies against the exact array payload that was POSTed.
    const verification = evaluateWebhookVerification(
      body,
      headers['X-Stellar-Signature'],
      SECRET,
    );
    expect(verification.valid).toBe(true);
    expect(verification.status).toBe(200);
  });

  it('resolves the signing secret from a resolver when the target has none', async () => {
    const dispatcher = new BatchDispatcher({ windowMs: 1000 });
    dispatcher.enqueue(
      { targetId: 'wh-2', url: 'https://receiver.example.com/hooks' },
      { deliveryId: 'd-1', event: 'payment.received', data: { amount: '1' } },
    );
    const batch = dispatcher.flush('wh-2') as WebhookBatch;

    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }) as Response);
    const secretResolver = vi.fn(async () => SECRET);

    const result = await deliverBatch(batch, {
      fetchImpl: fetchMock as unknown as typeof import('../../utils/ssrf').ssrfSafeFetch,
      secretResolver,
    });

    expect(secretResolver).toHaveBeenCalledWith(batch);
    expect(result.delivered).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const verification = evaluateWebhookVerification(
      init.body as string,
      (init.headers as Record<string, string>)['X-Stellar-Signature'],
      SECRET,
    );
    expect(verification.valid).toBe(true);
  });

  it('does not send when the target URL or signing secret is missing', async () => {
    const dispatcher = new BatchDispatcher({ windowMs: 1000 });
    dispatcher.enqueue('no-url', { event: 'payment.received', data: {} });
    const noUrl = dispatcher.flush('no-url') as WebhookBatch;

    const noUrlFetch = vi.fn();
    const noUrlResult = await deliverBatch(noUrl, {
      fetchImpl: noUrlFetch as unknown as typeof import('../../utils/ssrf').ssrfSafeFetch,
    });
    expect(noUrlResult.error).toBe('missing_target_url');
    expect(noUrlFetch).not.toHaveBeenCalled();

    dispatcher.enqueue({ targetId: 'no-secret', url: 'https://example.com/h' }, {
      event: 'payment.received',
      data: {},
    });
    const noSecret = dispatcher.flush('no-secret') as WebhookBatch;
    const noSecretFetch = vi.fn();
    const noSecretResult = await deliverBatch(noSecret, {
      fetchImpl: noSecretFetch as unknown as typeof import('../../utils/ssrf').ssrfSafeFetch,
    });
    expect(noSecretResult.error).toBe('missing_signing_secret');
    expect(noSecretFetch).not.toHaveBeenCalled();
  });

  it('reports non-2xx responses and transport errors without throwing', async () => {
    const dispatcher = new BatchDispatcher({ windowMs: 1000 });
    const batch = buildBatch(dispatcher);

    const rejected = await deliverBatch(batch, {
      fetchImpl: vi.fn(async () => ({ ok: false, status: 429 }) as Response) as unknown as typeof import('../../utils/ssrf').ssrfSafeFetch,
    });
    expect(rejected).toMatchObject({ delivered: false, status: 429 });

    const failed = await deliverBatch(batch, {
      fetchImpl: vi.fn(async () => {
        throw new Error('connection refused');
      }) as unknown as typeof import('../../utils/ssrf').ssrfSafeFetch,
    });
    expect(failed).toMatchObject({ delivered: false, status: null, error: 'connection refused' });
  });
});

describe('dispatcher.worker — lifecycle (#719)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushAndDeliver drains buffered targets', async () => {
    const dispatcher = new BatchDispatcher({ windowMs: 1000 });
    dispatcher.enqueue(
      { targetId: 'wh-1', url: 'https://example.com/h', secret: SECRET },
      { deliveryId: 'd-1', event: 'payment.received', data: {} },
    );

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    const results = await flushAndDeliver(dispatcher, {
      fetchImpl: fetchMock as unknown as typeof import('../../utils/ssrf').ssrfSafeFetch,
    });

    expect(results).toHaveLength(1);
    expect(results[0].delivered).toBe(true);
    expect(dispatcher.pending()).toBe(0);
  });

  it('delivers automatically when the aggregation window closes', async () => {
    const dispatcher = new BatchDispatcher({ windowMs: 1000 });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

    const worker = startBatchDispatcherWorker({
      dispatcher,
      deps: {
        fetchImpl: fetchMock as unknown as typeof import('../../utils/ssrf').ssrfSafeFetch,
      },
      registerSignals: false,
      keepAliveMs: 60_000,
    });

    dispatcher.enqueue(
      { targetId: 'wh-1', url: 'https://example.com/h', secret: SECRET },
      { deliveryId: 'd-1', event: 'payment.received', data: {} },
    );
    // Rapid burst inside the window.
    dispatcher.enqueue('wh-1', { deliveryId: 'd-2', event: 'payment.received', data: {} });

    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toHaveLength(2);

    await worker.stop();
  });

  it('stop() flushes any pending batch before returning', async () => {
    const dispatcher = new BatchDispatcher({ windowMs: 5000 });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

    const worker = startBatchDispatcherWorker({
      dispatcher,
      deps: {
        fetchImpl: fetchMock as unknown as typeof import('../../utils/ssrf').ssrfSafeFetch,
      },
      registerSignals: false,
      keepAliveMs: 60_000,
    });

    dispatcher.enqueue(
      { targetId: 'wh-1', url: 'https://example.com/h', secret: SECRET },
      { deliveryId: 'd-1', event: 'payment.received', data: {} },
    );

    await worker.stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dispatcher.pending()).toBe(0);
  });
});
