import { Job, Worker, Queue } from 'bullmq';
import { redis, registerRedisCleanupTask } from '../lib/redis';
import { createLogger } from '../lib/logger';
import { RedisCircuitBreaker, CircuitBreakerOpenError } from '../modules/alerts/circuit-breaker';

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
}

export type WebhookTransportFn = (
  url: string,
  payload: string,
  headers: Record<string, string>
) => Promise<{ status: number; body?: string }>;

export class DispatcherWorker {
  private circuitBreaker: RedisCircuitBreaker;
  private worker: Worker<WebhookDispatchJobData> | null = null;
  private transport: WebhookTransportFn;

  constructor(
    circuitBreaker?: RedisCircuitBreaker,
    transport?: WebhookTransportFn
  ) {
    this.circuitBreaker = circuitBreaker || new RedisCircuitBreaker();
    this.transport = transport || this.defaultTransport.bind(this);
  }

  private async defaultTransport(
    url: string,
    payload: string,
    headers: Record<string, string>
  ) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: payload,
    });
    return { status: res.status, body: await res.text() };
  }

  /**
   * Processes a single webhook dispatch job.
   * If the circuit breaker for the webhook endpoint is OPEN, skips the network call
   * immediately without network blocking.
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

    try {
      const payloadStr = JSON.stringify(payload);
      const res = await this.circuitBreaker.execute(webhookId, async () => {
        const response = await this.transport(url, payloadStr, headers);
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
