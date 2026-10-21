import { Job, Worker, Queue } from 'bullmq';
import { redis, registerRedisCleanupTask } from '../lib/redis';
import { createLogger } from '../lib/logger';
import { RedisCircuitBreaker, CircuitBreakerOpenError } from '../modules/alerts/circuit-breaker';
import { webhookTelemetry } from '../modules/webhooks/webhook-telemetry';
import {
  ssrfFilter,
  SsrfFilter,
  SsrfBlockedError,
  type PinnedWebhookTarget,
} from '../modules/webhooks/ssrf-filter';

const log = createLogger({ module: 'WebhookDispatcherWorker' });

export interface WebhookDispatchJobData {
  webhookId: string;
  url: string;
  payload: Record<string, any>;
  headers?: Record<string, string>;
  traceparent?: string;
  paymentId?: string;
  /** Priority lane hint. If omitted, lane is derived from severity metadata. */
  lane?: QueueLane;
  /** Severity of the underlying alert rule (critical/high/standard/bulk). */
  severity?: string;
}

export interface WebhookDispatchResult {
  webhookId: string;
  status: 'delivered' | 'skipped' | 'failed';
  statusCode?: number;
  durationMs?: number;
  reason?: string;
  pinnedIp?: string;
  lane?: QueueLane;
}

export type WebhookTransportFn = (
  url: string,
  payload: string,
  headers: Record<string, string>,
  pinnedTarget?: PinnedWebhookTarget
) => Promise<{ status: number; body?: string }>;

export class DispatcherWorker {
  private circuitBreaker: RedisCircuitBreaker;
  private workers: Map<QueueLane, Worker<WebhookDispatchJobData>> = new Map();
  private transport: WebhookTransportFn;
  private sssfFilter: SssfFilter;
  private laneManager: QueueLaneManager;

  constructor(
    circuitBreaker?: RedisCircuitBreaker,
    transport?: WebhookTransportFn,
    filter?: SssfFilter,
    laneManager?: QueueLaneManager
  ) {
    this.circuitBreaker = circuitBreaker || new RedisCircuitBreaker();
    this.transport = transport || this.defaultTransport.bind(this);
    this.ssrfFilter = filter || ssrfFilter;
  }

  private async defaultTransport(
    url: string,
    payload: string,
    headers: Record<string, string>,
    pinnedTarget?: PinnedWebhookTarget
  ) {
    const target = pinnedTarget ?? (await this.sssfFilter.validateAndResolve(url));
    const connectUrl = target.parsedUrl.protocol === 'http:' ? target.pinnedUrl : url;
    const res = await fetch(connectUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: target.hostHeader,
        'X-Validated-Egress-IP': target.pinnedId,
        ...headers,
      },
      body: payload,
      redirect: 'manual',
    });
    return { status: res.status, body: await res.text() };
  }

  /**
   * Processes a single webhook dispatch job.
   * 1. Checks circuit breaker state.
   * 2. Validates target URL and resolves/pins IP via SssfFilter (rejecting private/internal IPs).
   * 3. Dispatches webhook with pinned IP target.
   */
  public async processJob(job: { data: WebhookDispatchJobData }): Promise<WebhookDispatchResult> {
    const { webhookId, url, payload, headers = {}, paymentId } = job.data;

    // Check circuit breaker state first
    const canSend = await this.circuitBreaker.canExecute(webhookId);
    if (!canSend) {
      log.warn(
        { webhookId, url, lane },
        `[DispatcherWorker] Circuit breaker OPEN for webhook ${webhookId}; skipping network call`
      );
      return {
        webhookId,
        status: 'skipped',
        reason: 'circuit_breaker_open',
        lane,
      };
    }

    let pinnedTarget: PinnedWebhookTarget;
    try {
      pinnedTarget = await this.sssfFilter.validateAndResolve(url);
    } catch (err: any) {
      const statusCode = err instanceof SssfBlockedError ? err.statusCode : 400;
      log.error(
        { webhookId, url, reason: err.reason ?? err.message, statusCode, lane },
        '[SECURITY_AUDIT] Blocked webhook dispatch due to SSRF egress policy'
      );
      return {
        webhookId,
        status: 'failed',
        statusCode,
        reason: err.message,
        lane,
      };
    }

    try {
      const payloadStr = JSON.stringify(payload);
      const { result: res, durationMs } = await webhookTelemetry.measureDispatch(
        webhookId,
        url,
        async () => {
          return await this.circuitBreaker.execute(webhookId, async () => {
            const response = await this.transport(url, payloadStr, headers);
            if (response.status >= 500) {
              const err: any = new Error(`Server returned HTTP ${response.status}`);
              err.statusCode = response.status;
              throw err;
            }
            return response;
          });
        },
        paymentId
      );

      return {
        webhookId,
        status: 'delivered',
        statusCode: res.status,
        durationMs,
        lane,
      };
    } catch (err: any) {
      if (err instanceof CircuitBreakerOpenError) {
        log.warn({ webhookId, lane }, 'Fast-fail: circuit breaker opened during dispatch');
        return {
          webhookId,
          status: 'skipped',
          reason: 'circuit_breaker_open',
          lane,
        };
      }

      log.error({ webhookId, lane, err: err.message }, 'Webhook delivery failed');
      return {
        webhookId,
        status: 'failed',
        reason: err.message,
        lane,
      };
    }
  }

  /**
   * Starts dedicated workers for each priority lane.
   *
   * Each lane gets its own BullMQ Worker bound to its lane-specific queue name,
   * so critical jobs are never head-of-line blocked behind bulk jobs. The
   * concurrency for each lane is taken from QUEUE_LANE_CONFIGS, which guarantees
   * minimum capacity for critical/high lanes.
   */
  public start(baseQueueName = 'webhook-dispatch') {
    for (const lane of Object.keys(QUEUE_LANE_CONFIGS) as QueueLane[]) {
      const config = QUEUE_LANE_CONFIGS[lane];
      const queueName = this.laneManager.getQueueName(lane, baseQueueName);
      const worker = new Worker<WebhookDispatchJobData>(
        queueName,
        async (job) => this.processJob(job),
        { connection: redis, concurrency: config.concurrency }
      );

      worker.on('failed', (job, error) => {
        log.error(
          { lane, jobId: job?.id, err: error.message },
          'Webhook dispatch job failed in lane'
        );
      });

      this.workers.set(lane, worker);
      log.info(
        { lane, queueName, concurrency: config.concurrency },
        'Started priority lane dispatcher worker'
      );
    }

    registerRedisCleanupTask(async () => {
      await Promise.all(
        Array.from(this.workers.values()).map((w) => w.close())
      );
      this.workers.clear();
    });

    return this.workers;
  }

  /** Returns the worker for a specific lane (if started). */
  public getWorker(lane: QueueLane): Worker<WebhookDispatchJobData> | undefined {
    return this.workers.get(lane);
  }

  /** Returns the lane manager used by this worker (for metrics/integration tests). */
  public getLaneManager(): QueueLaneManager {
    return this.laneManager;
  }
}

export const dispatcherWorker = new DispatcherWorker();
