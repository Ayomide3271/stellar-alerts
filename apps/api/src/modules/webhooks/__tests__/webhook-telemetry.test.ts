import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebhookTelemetry } from '../webhook-telemetry';
import { prisma } from '../../../lib/prisma';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    deliveryLog: {
      upsert: vi.fn().mockResolvedValue({ id: 'dl-123' }),
    },
  },
}));

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('WebhookTelemetry (#770)', () => {
  let telemetry: WebhookTelemetry;

  beforeEach(() => {
    telemetry = new WebhookTelemetry(100);
    vi.clearAllMocks();
  });

  it('measures dispatch duration with high precision using process.hrtime.bigint', async () => {
    const mockDispatch = vi.fn().mockImplementation(async () => {
      // Simulate 15ms latency
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { status: 200, body: 'ok' };
    });

    const { result, durationMs } = await telemetry.measureDispatch(
      'wh_test_1',
      'https://example.com/webhook',
      mockDispatch
    );

    expect(result.status).toBe(200);
    expect(durationMs).toBeGreaterThanOrEqual(10);
    expect(durationMs).toBeLessThan(1000);
    expect(typeof durationMs).toBe('number');
  });

  it('calculates P50, P95, and P99 percentiles correctly', () => {
    // Populate with 100 sorted samples: 1ms to 100ms
    for (let i = 1; i <= 100; i++) {
      telemetry.recordSample({
        webhookId: 'wh_test_1',
        url: 'https://example.com/webhook',
        durationMs: i,
        statusCode: 200,
        timestamp: new Date(),
        success: true,
      });
    }

    const metrics = telemetry.getHistogramMetrics('wh_test_1');
    expect(metrics.count).toBe(100);
    expect(metrics.min).toBe(1);
    expect(metrics.max).toBe(100);
    expect(metrics.p50).toBe(50);
    expect(metrics.p95).toBe(95);
    expect(metrics.p99).toBe(99);
    expect(metrics.avg).toBe(50.5);
  });

  it('persists durationMs to DeliveryLog database record when paymentId is provided', async () => {
    const mockDispatch = vi.fn().mockResolvedValue({ status: 200 });

    await telemetry.measureDispatch(
      'wh_target',
      'https://example.com/webhook',
      mockDispatch,
      'pay_12345'
    );

    expect(prisma.deliveryLog.upsert).toHaveBeenCalledTimes(1);
    const callArg = (prisma.deliveryLog.upsert as any).mock.calls[0][0];
    expect(callArg.where.paymentId_channel.paymentId).toBe('pay_12345');
    expect(callArg.create.channel).toBe('webhook:wh_target');
    expect(callArg.create.durationMs).toBeDefined();
    expect(callArg.create.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures failures and duration even when dispatchFn throws', async () => {
    const mockErrorDispatch = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const err: any = new Error('Connection refused');
      err.statusCode = 502;
      throw err;
    });

    await expect(
      telemetry.measureDispatch(
        'wh_fail',
        'https://example.com/fail',
        mockErrorDispatch,
        'pay_fail'
      )
    ).rejects.toThrow('Connection refused');

    const samples = telemetry.getSamples('wh_fail');
    expect(samples.length).toBe(1);
    expect(samples[0].success).toBe(false);
    expect(samples[0].statusCode).toBe(502);
    expect(samples[0].durationMs).toBeGreaterThanOrEqual(5);
  });
});
