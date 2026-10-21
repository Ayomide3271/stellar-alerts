import { createLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';

const log = createLogger({ module: 'WebhookTelemetry' });

export interface LatencySample {
  webhookId: string;
  url: string;
  durationMs: number;
  statusCode?: number;
  timestamp: Date;
  success: boolean;
}

export interface LatencyHistogramMetrics {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
}

export class WebhookTelemetry {
  private samples: LatencySample[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples = 1000) {
    this.maxSamples = maxSamples;
  }

  /**
   * Times an async outbound dispatch function using process.hrtime.bigint()
   * with sub-millisecond precision (#770).
   */
  public async measureDispatch<T>(
    webhookId: string,
    url: string,
    dispatchFn: () => Promise<T>,
    paymentId?: string
  ): Promise<{ result: T; durationMs: number }> {
    const start = process.hrtime.bigint();
    let result!: T;
    let success = true;
    let statusCode: number | undefined;
    let thrownError: any = null;

    try {
      result = await dispatchFn();
      if (result && typeof result === 'object' && 'status' in result) {
        statusCode = (result as any).status;
      }
    } catch (err: any) {
      success = false;
      thrownError = err;
      if (err && err.statusCode) {
        statusCode = err.statusCode;
      }
    } finally {
      const end = process.hrtime.bigint();
      // Calculate nanoseconds and convert to milliseconds with sub-millisecond precision
      const durationNs = Number(end - start);
      const durationMs = Math.round((durationNs / 1_000_000) * 100) / 100;

      this.recordSample({
        webhookId,
        url,
        durationMs,
        statusCode,
        timestamp: new Date(),
        success,
      });

      // Threshold logging: warn if subscriber response duration exceeds 5,000ms (#770)
      if (durationMs > 5000) {
        log.warn(
          { webhookId, url, durationMs, thresholdMs: 5000 },
          `[WebhookTelemetry] High latency warning: subscriber response took ${durationMs}ms (>5,000ms threshold)`
        );
      }

      // Attach durationMs property to delivery log database record
      if (paymentId) {
        try {
          await this.recordDeliveryLog(
            paymentId,
            webhookId,
            success,
            durationMs,
            statusCode,
            thrownError?.message
          );
        } catch (dbErr: any) {
          log.warn(
            { paymentId, webhookId, err: dbErr.message },
            '[WebhookTelemetry] Failed to record DeliveryLog database entry'
          );
        }
      }

      if (thrownError) {
        throw thrownError;
      }
    }

    const end = process.hrtime.bigint();
    const durationNs = Number(end - start);
    const durationMs = Math.round((durationNs / 1_000_000) * 100) / 100;

    return { result, durationMs };
  }

  public recordSample(sample: LatencySample): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  public getSamples(webhookId?: string): LatencySample[] {
    return webhookId
      ? this.samples.filter((s) => s.webhookId === webhookId)
      : [...this.samples];
  }

  /**
   * Computes P50, P95, P99, min, max, avg histogram metrics across latency samples.
   */
  public getHistogramMetrics(webhookId?: string): LatencyHistogramMetrics {
    const filtered = webhookId
      ? this.samples.filter((s) => s.webhookId === webhookId)
      : this.samples;

    if (filtered.length === 0) {
      return { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
    }

    const sorted = filtered.map((s) => s.durationMs).sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, val) => acc + val, 0);

    const percentile = (p: number) => {
      const idx = Math.ceil((p / 100) * count) - 1;
      return sorted[Math.max(0, Math.min(idx, count - 1))];
    };

    return {
      count,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
      min: sorted[0],
      max: sorted[count - 1],
      avg: Math.round((sum / count) * 100) / 100,
    };
  }

  public async recordDeliveryLog(
    paymentId: string,
    webhookId: string,
    success: boolean,
    durationMs: number,
    statusCode?: number,
    error?: string
  ) {
    return await prisma.deliveryLog.upsert({
      where: {
        paymentId_channel: {
          paymentId,
          channel: `webhook:${webhookId}`,
        },
      },
      update: {
        status: success ? 'delivered' : 'failed',
        durationMs,
        error: error || (statusCode ? `HTTP ${statusCode}` : undefined),
      },
      create: {
        paymentId,
        channel: `webhook:${webhookId}`,
        status: success ? 'delivered' : 'failed',
        durationMs,
        error: error || (statusCode ? `HTTP ${statusCode}` : undefined),
      },
    });
  }

  public clear(): void {
    this.samples = [];
  }
}

export const webhookTelemetry = new WebhookTelemetry();
