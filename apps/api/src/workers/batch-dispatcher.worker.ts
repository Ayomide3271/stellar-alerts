import { env } from '../config/env';
import { createLogger } from '../lib/logger';
import { generateWebhookSignature } from '../utils/webhook-signer';
import { ssrfSafeFetch } from '../utils/ssrf';
import {
  BatchDispatcher,
  batchDispatcher,
  serializeBatchPayload,
  type WebhookBatch,
} from '../modules/alerts/batch-dispatcher';
import { registerSupervisorHeartbeat } from './supervisor';

/**
 * Webhook batch dispatcher worker (#719).
 *
 * Subscribes to `BatchDispatcher` flushes and performs one signed HTTP POST
 * per target per window. The request body is the JSON array of buffered
 * events (each retaining its own `deliveryId`), and the HMAC signature covers
 * that entire array so receivers can verify the batch in one pass.
 */

const log = createLogger({ module: 'BatchDispatcherWorker' });

export interface BatchDeliveryResult {
  batchId: string;
  targetId: string;
  delivered: boolean;
  status: number | null;
  deliveryIds: string[];
  error?: string;
}

export interface BatchDeliveryDeps {
  fetchImpl?: typeof ssrfSafeFetch;
  /** Resolve a signing secret when the batch target did not carry one. */
  secretResolver?: (batch: WebhookBatch) => Promise<string | undefined> | string | undefined;
}

/**
 * Delivers a single aggregate batch. Never throws; transport/signing failures
 * are reported in the result so the worker can keep draining other targets.
 */
export async function deliverBatch(
  batch: WebhookBatch,
  deps: BatchDeliveryDeps = {},
): Promise<BatchDeliveryResult> {
  const deliveryIds = batch.events.map((event) => event.deliveryId);
  const base = { batchId: batch.batchId, targetId: batch.targetId, deliveryIds };

  if (!batch.url) {
    log.warn({ ...base, count: batch.count }, 'Batch target has no URL; dropping batch');
    return { ...base, delivered: false, status: null, error: 'missing_target_url' };
  }

  const secret = batch.secret ?? (await deps.secretResolver?.(batch));
  if (!secret) {
    log.warn({ ...base, count: batch.count }, 'Batch target has no signing secret; refusing unsigned delivery');
    return { ...base, delivered: false, status: null, error: 'missing_signing_secret' };
  }

  const body = serializeBatchPayload(batch);
  const signature = generateWebhookSignature(body, secret);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Stellar-Signature': signature.headerValue,
    'X-Stellar-Alerts-Nonce': signature.nonce,
    'X-Stellar-Alerts-Batch-Id': batch.batchId,
    'X-Stellar-Alerts-Batch-Count': String(batch.count),
    'X-Stellar-Alerts-Delivery-Ids': deliveryIds.join(','),
  };

  const fetchImpl = deps.fetchImpl ?? ssrfSafeFetch;

  try {
    const response = await fetchImpl(batch.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(env.WEBHOOK_TIMEOUT_MS),
    });

    const result: BatchDeliveryResult = {
      ...base,
      delivered: response.ok,
      status: response.status,
    };

    if (response.ok) {
      log.info(
        { ...base, count: batch.count, status: response.status, windowMs: batch.windowEnd.getTime() - batch.windowStart.getTime() },
        'Webhook batch delivered',
      );
    } else {
      log.warn(
        { ...base, count: batch.count, status: response.status },
        'Webhook batch rejected by destination',
      );
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ ...base, count: batch.count, err: message }, 'Webhook batch delivery failed');
    return { ...base, delivered: false, status: null, error: message };
  }
}

/** Flushes pending batches (optionally a single target) and delivers them. */
export async function flushAndDeliver(
  dispatcher: BatchDispatcher = batchDispatcher,
  deps: BatchDeliveryDeps = {},
  targetId?: string,
): Promise<BatchDeliveryResult[]> {
  const batches = targetId
    ? [dispatcher.flush(targetId)].filter((batch): batch is WebhookBatch => batch !== null)
    : dispatcher.flushAll();

  return Promise.all(batches.map((batch) => deliverBatch(batch, deps)));
}

export interface BatchDispatcherWorkerOptions {
  dispatcher?: BatchDispatcher;
  deps?: BatchDeliveryDeps;
  /** Register SIGTERM/SIGINT handlers that drain before exiting. Default true. */
  registerSignals?: boolean;
  /** Keepalive tick interval; prevents an idle worker process from exiting. */
  keepAliveMs?: number;
}

export function startBatchDispatcherWorker(options: BatchDispatcherWorkerOptions = {}) {
  const dispatcher = options.dispatcher ?? batchDispatcher;
  const deps = options.deps ?? {};
  let stopped = false;

  const onFlush = (batch: WebhookBatch) => {
    void deliverBatch(batch, deps).catch((error) => {
      log.error({ err: error, batchId: batch.batchId }, 'Unhandled batch delivery error');
    });
  };

  dispatcher.on('flush', onFlush);

  const keepAlive = setInterval(() => {
    log.debug({ pending: dispatcher.pending(), targets: dispatcher.pendingTargets().length }, 'Batch dispatcher heartbeat');
  }, options.keepAliveMs ?? 30_000);

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(keepAlive);
    dispatcher.off('flush', onFlush);
    const results = await flushAndDeliver(dispatcher, deps);
    log.info({ flushed: results.length }, 'Batch dispatcher worker stopped');
  };

  const onSignal = () => {
    void stop().finally(() => process.exit(0));
  };

  if (options.registerSignals !== false) {
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  }

  log.info(
    { windowMs: dispatcher.getWindowMs(), maxBatchSize: dispatcher.getMaxBatchSize() },
    'Batch dispatcher worker started',
  );

  return { stop, dispatcher };
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  startBatchDispatcherWorker();
}
