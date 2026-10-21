import crypto from 'crypto';
import { EventEmitter } from 'events';

import { env } from '../../config/env';

/**
 * Notification batching for high-frequency payment events (#719).
 *
 * High-volume wallets can produce dozens of payments per second. Dispatching
 * one HTTP request per payment invites destination rate limiting and inflates
 * egress. `BatchDispatcher` accumulates notifications per webhook target and
 * emits a single `flush` event carrying a JSON-array payload once either:
 *
 *  - the aggregation window elapses (configurable, clamped to 1–10s), or
 *  - the buffer reaches the maximum batch size (default 100 events).
 *
 * Every event keeps its own `deliveryId` so receivers can de-duplicate and map
 * each item back to an individual delivery. The dispatcher worker signs the
 * serialized array as a whole, so one signature still covers the batch.
 */

export const DEFAULT_BATCH_MAX_SIZE = 100;
export const DEFAULT_BATCH_WINDOW_MS = 5_000;
export const MIN_BATCH_WINDOW_MS = 1_000;
export const MAX_BATCH_WINDOW_MS = 10_000;

export interface BatchableNotification {
  /** Stable per-delivery identifier. Generated when omitted. */
  deliveryId?: string;
  /** Logical event name, e.g. `payment.received`. */
  event: string;
  /** ISO timestamp; defaults to the enqueue time. */
  timestamp?: string;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BatchTarget {
  /** Stable grouping key. Prefer the webhook id; falls back to url/webhookId. */
  targetId?: string;
  webhookId?: string;
  url?: string;
  /** Signing secret; kept in-memory only and never persisted by the dispatcher. */
  secret?: string;
}

export interface NormalizedBatchTarget {
  targetId: string;
  webhookId?: string;
  url?: string;
  secret?: string;
}

export interface BatchedNotification extends BatchableNotification {
  deliveryId: string;
  timestamp: string;
}

export interface WebhookBatch extends NormalizedBatchTarget {
  batchId: string;
  events: BatchedNotification[];
  count: number;
  createdAt: Date;
  windowStart: Date;
  windowEnd: Date;
}

export interface BatchDispatcherOptions {
  /** Maximum events per flush. Defaults to 100. */
  maxBatchSize?: number;
  /** Aggregation window in ms. Clamped to [1000, 10000]; defaults to 5000. */
  windowMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface TargetState {
  target: NormalizedBatchTarget;
  events: BatchedNotification[];
  windowStart: number;
  timer: NodeJS.Timeout | null;
}

function clampWindow(windowMs: number): number {
  if (!Number.isFinite(windowMs)) return DEFAULT_BATCH_WINDOW_MS;
  return Math.min(MAX_BATCH_WINDOW_MS, Math.max(MIN_BATCH_WINDOW_MS, Math.floor(windowMs)));
}

function normalizeTarget(target: string | BatchTarget): NormalizedBatchTarget {
  if (typeof target === 'string') {
    return { targetId: target };
  }
  const targetId = target.targetId ?? target.webhookId ?? target.url;
  if (!targetId) {
    throw new Error('BatchDispatcher requires a targetId, webhookId, or url');
  }
  return {
    targetId,
    webhookId: target.webhookId,
    url: target.url,
    secret: target.secret,
  };
}

export class BatchDispatcher extends EventEmitter {
  private readonly maxBatchSize: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly targets = new Map<string, TargetState>();

  constructor(options: BatchDispatcherOptions = {}) {
    super();
    this.maxBatchSize =
      Number.isInteger(options.maxBatchSize) && (options.maxBatchSize as number) > 0
        ? (options.maxBatchSize as number)
        : DEFAULT_BATCH_MAX_SIZE;
    this.windowMs = clampWindow(options.windowMs ?? DEFAULT_BATCH_WINDOW_MS);
    this.now = options.now ?? (() => Date.now());
  }

  /** Aggregation window actually in use (after clamping). */
  public getWindowMs(): number {
    return this.windowMs;
  }

  public getMaxBatchSize(): number {
    return this.maxBatchSize;
  }

  /**
   * Adds a notification to its target's batch. The batch is emitted
   * immediately when the count threshold is reached; otherwise a timer flushes
   * it when the aggregation window closes.
   */
  public enqueue(
    target: string | BatchTarget,
    notification: BatchableNotification,
  ): { targetId: string; deliveryId: string; batchSize: number } {
    const normalized = normalizeTarget(target);
    const existing = this.targets.get(normalized.targetId);

    const state: TargetState =
      existing ??
      {
        target: normalized,
        events: [],
        windowStart: this.now(),
        timer: null,
      };

    // Later enqueues may fill in details omitted on the first one.
    state.target = { ...state.target, ...stripUndefined(normalized) };

    const deliveryId =
      notification.deliveryId && notification.deliveryId.trim() !== ''
        ? notification.deliveryId
        : crypto.randomUUID();

    const event: BatchedNotification = {
      ...notification,
      deliveryId,
      timestamp: notification.timestamp ?? new Date(this.now()).toISOString(),
    };

    state.events.push(event);
    this.targets.set(normalized.targetId, state);

    if (state.events.length >= this.maxBatchSize) {
      // Count threshold wins over the remaining window.
      this.flush(normalized.targetId);
    } else if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        this.flush(normalized.targetId);
      }, this.windowMs);
      state.timer.unref?.();
    }

    return {
      targetId: normalized.targetId,
      deliveryId,
      batchSize: state.events.length,
    };
  }

  /**
   * Flushes one target's buffered events, emitting a `flush` event with the
   * batch. Returns null when the target has no pending events.
   */
  public flush(targetId: string): WebhookBatch | null {
    const state = this.targets.get(targetId);
    if (!state || state.events.length === 0) {
      if (state?.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      this.targets.delete(targetId);
      return null;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const windowEnd = this.now();
    const batch: WebhookBatch = {
      ...state.target,
      batchId: crypto.randomUUID(),
      events: state.events,
      count: state.events.length,
      createdAt: new Date(state.windowStart),
      windowStart: new Date(state.windowStart),
      windowEnd: new Date(windowEnd),
    };

    this.targets.delete(targetId);
    this.emit('flush', batch);
    return batch;
  }

  /** Flushes every pending target. */
  public flushAll(): WebhookBatch[] {
    const batches: WebhookBatch[] = [];
    for (const targetId of [...this.targets.keys()]) {
      const batch = this.flush(targetId);
      if (batch) batches.push(batch);
    }
    return batches;
  }

  /** Number of buffered events, optionally for a single target. */
  public pending(targetId?: string): number {
    if (targetId !== undefined) {
      return this.targets.get(targetId)?.events.length ?? 0;
    }
    let total = 0;
    for (const state of this.targets.values()) total += state.events.length;
    return total;
  }

  /** Target ids with buffered events (mainly for diagnostics/tests). */
  public pendingTargets(): string[] {
    return [...this.targets.keys()];
  }

  /** Flushes everything and clears all aggregation timers. */
  public close(): WebhookBatch[] {
    const batches = this.flushAll();
    for (const state of this.targets.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.targets.clear();
    return batches;
  }
}

function stripUndefined(target: NormalizedBatchTarget): Partial<NormalizedBatchTarget> {
  const result: Partial<NormalizedBatchTarget> = { targetId: target.targetId };
  if (target.webhookId !== undefined) result.webhookId = target.webhookId;
  if (target.url !== undefined) result.url = target.url;
  if (target.secret !== undefined) result.secret = target.secret;
  return result;
}

/**
 * Serializes a batch into the JSON array that is POSTed to the destination.
 * The array (not the envelope) is what gets signed, so signature verification
 * covers every event and every preserved deliveryId in one assertion.
 */
export function serializeBatchPayload(batch: WebhookBatch): string {
  return JSON.stringify(batch.events);
}

export const batchDispatcher = new BatchDispatcher({
  windowMs: env.WEBHOOK_BATCH_WINDOW_MS,
  maxBatchSize: env.WEBHOOK_BATCH_MAX_SIZE,
});
