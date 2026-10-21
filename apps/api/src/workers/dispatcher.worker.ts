import { Job, Worker, Queue } from 'bullmq';
import { redis, registerRedisCleanupTask } from '../lib/redis';
import { createLogger } from '../lib/logger';
import { RedisCircuitBreaker, CircuitBreakerOpenError } from '../modules/alerts/circuit-breaker';
import {
  SsrfFilter,
  ssrfFilter as defaultSsrfFilter,
  SsrfBlockedError,
  PinnedWebhookTarget,
} from '../modules/webhooks/ssrf-filter';

const log = createLogger({ module: 'WebhookDispatcherWorker' });

export interface WebhookDispatchJobData {
  webhookId: string;
  url: string;
  payload: Record<string, any>;
  headers?: Record<string, string>;
  traceparent?: string;
  paymentId?: string;
}

export interface WebhookDispatchResult {
  webhookId: string;
  status: 'delivered' | 'skipped' | 'failed';
  statusCode?: number;
  reason?: string;
  pinnedIp?: string;
}

export type WebhookTransportFn = (
  url: string,
  payload: string,
  headers: Record<string, string>,
  pinnedTarget?: PinnedWebhookTarget
) => Promise<{ status: number; body?: string }>;

export class DispatcherWorker {
  private circuitBreaker: RedisCircuitBreaker;
  private worker: Worker<WebhookDispatchJobData> | null = null;
  private transport: WebhookTransportFn;
  private ssrfFilter: SsrfFilter;

  constructor(
    circuitBreaker?: RedisCircuitBreaker,
    transport?: WebhookTransportFn,
    filter?: SsrfFilter
  ) {
    this.circuitBreaker = circuitBreaker || new RedisCircuitBreaker();
    this.transport = transport || this.defaultTransport.bind(this);
    this.ssrfFilter = filter || defaultSsrfFilter;
  }

  private async defaultTransport(
    url: string,
    payload: string,
    headers: Record<string, string>,
    pinnedTarget?: PinnedWebhookTarget
  ) {
    const target = pinnedTarget ?? (await this.ssrfFilter.validateAndResolve(url));
    const connectUrl = target.parsedUrl.protocol === 'http:' ? target.pinnedUrl : url;
    const res = await fetch(connectUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: target.hostHeader,
        'X-Validated-Egress-IP': target.pinnedIp,
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
   * 2. Validates target URL and resolves/pins IP via SsrfFilter (rejecting private/internal IPs).
   * 3. Dispatches webhook with pinned IP target.
   */
  public async processJob(job: { data: WebhookDispatchJobData }): Promise<WebhookDispatchResult> {
    const { webhookId, url, payload, headers = {} } = job.data;

    // Check circuit breaker state first
    const canSend = await this.circuitBreaker.canExecute(webhookId);
    if (!canSend) {
      log.warn(
        { webhookId, url },
        `[DispatcherWorker] Circuit breaker OPEN for webhook ${webhookId}; skipping network call`
      );
      return {
        webhookId,
        status: 'skipped',
        reason: 'circuit_breaker_open',
      };
    }

    let pinnedTarget: PinnedWebhookTarget;
    try {
      pinnedTarget = await this.ssrfFilter.validateAndResolve(url);
    } catch (err: any) {
      const statusCode = err instanceof SsrfBlockedError ? err.statusCode : 400;
      log.error(
        { webhookId, url, reason: err.reason ?? err.message, statusCode },
        '[SECURITY_AUDIT] Blocked webhook dispatch due to SSRF egress policy'
      );
      return {
        webhookId,
        status: 'failed',
        statusCode,
        reason: err.message,
      };
    }

    try {
      const payloadStr = JSON.stringify(payload);
      const res = await this.circuitBreaker.execute(webhookId, async () => {
        const response =
          this.transport.length >= 4
            ? await this.transport(url, payloadStr, headers, pinnedTarget)
            : await this.transport(url, payloadStr, headers);
        if (response.status >= 500) {
          const err: any = new Error(`Server returned HTTP ${response.status}`);
          err.statusCode = response.status;
          throw err;
        }
        return response;
      });

      return {
        webhookId,
        status: 'delivered',
        statusCode: res.status,
        pinnedIp: pinnedTarget.pinnedIp,
      };
    } catch (err: any) {
      if (err instanceof CircuitBreakerOpenError) {
        log.warn({ webhookId }, 'Fast-fail: circuit breaker opened during dispatch');
        return {
          webhookId,
          status: 'skipped',
          reason: 'circuit_breaker_open',
        };
      }

      log.error({ webhookId, err: err.message }, 'Webhook delivery failed');
      return {
        webhookId,
        status: 'failed',
        reason: err.message,
      };
    }
  }

  public start(queueName = 'webhook-dispatch', concurrency = 5) {
    this.worker = new Worker<WebhookDispatchJobData>(
      queueName,
      async (job) => this.processJob(job),
      { connection: redis, concurrency }
    );

    registerRedisCleanupTask(async () => {
      if (this.worker) await this.worker.close();
    });

    return this.worker;
  }
}

export const dispatcherWorker = new DispatcherWorker();
