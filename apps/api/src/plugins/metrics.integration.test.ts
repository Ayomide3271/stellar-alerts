import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import metricsPlugin from './metrics';
import { prometheusMetricsService } from '../modules/metrics/prometheus.service';

describe('Metrics Plugin - /metrics Endpoint Integration', () => {
  const app = Fastify();

  beforeAll(async () => {
    // Reset metrics before tests
    prometheusMetricsService.reset();
    await app.register(metricsPlugin);
  });

  afterAll(async () => {
    await app.close();
    prometheusMetricsService.reset();
  });

  describe('GET /metrics', () => {
    it('should expose /metrics endpoint', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return Prometheus text format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.headers['content-type']).toContain('version=0.0.4');
    });

    it('should include ledger lag metrics', async () => {
      prometheusMetricsService.recordLedgerLag(5, 'horizon');

      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;

      expect(body).toContain('stellar_alerts_ledger_lag_seconds');
      expect(body).toContain('source="horizon"');
    });

    it('should include queue latency metrics', async () => {
      prometheusMetricsService.recordQueueLatency(250, 'notifications');

      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;

      expect(body).toContain('stellar_alerts_queue_latency_milliseconds');
      expect(body).toContain('queue="notifications"');
    });

    it('should include delivery metrics with all providers', async () => {
      prometheusMetricsService.recordDeliveryAttempt(100, 'webhook', 'delivered');
      prometheusMetricsService.recordDeliveryAttempt(200, 'telegram', 'failed');
      prometheusMetricsService.recordDeliveryAttempt(150, 'email', 'skipped');

      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;

      expect(body).toContain('stellar_alerts_delivery_duration_milliseconds');
      expect(body).toContain('provider="webhook"');
      expect(body).toContain('provider="telegram"');
      expect(body).toContain('provider="email"');
      expect(body).toContain('outcome="delivered"');
      expect(body).toContain('outcome="failed"');
      expect(body).toContain('outcome="skipped"');
    });

    it('should include queue depth gauge', async () => {
      prometheusMetricsService.setQueueDepth(42, 'notifications');

      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;

      expect(body).toContain('stellar_alerts_queue_depth_jobs');
      expect(body).toContain('queue="notifications" 42');
    });

    it('should include active workers gauge', async () => {
      prometheusMetricsService.setActiveWorkers(3);

      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;

      expect(body).toContain('stellar_alerts_active_workers_count');
      expect(body).toContain('3');
    });

    it('should include delivery SLO success rate', async () => {
      prometheusMetricsService.setDeliverySloRate('webhook', 99.5);
      prometheusMetricsService.setDeliverySloRate('telegram', 98.0);

      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;

      expect(body).toContain('stellar_alerts_delivery_slo_success_rate');
      expect(body).toContain('provider="webhook"');
      expect(body).toContain('99.5');
    });

    it('should include legacy queue metrics', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;

      // Legacy metrics should still be present
      expect(body).toContain('stellar_alerts_queue_waiting_jobs');
      expect(body).toContain('stellar_alerts_queue_active_jobs');
      expect(body).toContain('stellar_alerts_queue_completed_jobs_total');
      expect(body).toContain('stellar_alerts_queue_failed_jobs_total');
    });

    it('should include webhook dispatch metrics', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;

      // Webhook metrics from webhook-metrics.ts
      expect(body).toContain('stellar_alerts_webhook_dispatch');
    });

    it('should include process and nodejs metrics', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const body = response.body;

      expect(body).toContain('process_uptime_seconds');
      expect(body).toContain('nodejs_heap_used_bytes');
    });

    it('should update metrics on subsequent requests', async () => {
      prometheusMetricsService.reset();
      prometheusMetricsService.setQueueDepth(10, 'notifications');

      const response1 = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response1.body).toContain('queue="notifications" 10');

      prometheusMetricsService.setQueueDepth(20, 'notifications');

      const response2 = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response2.body).toContain('queue="notifications" 20');
    });

    it('should have valid Prometheus exposition format', async () => {
      prometheusMetricsService.recordLedgerLag(5);
      prometheusMetricsService.recordQueueLatency(100);

      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      const lines = response.body.split('\n');
      let helpCount = 0;
      let typeCount = 0;

      for (const line of lines) {
        if (line.startsWith('# HELP')) helpCount++;
        if (line.startsWith('# TYPE')) typeCount++;
      }

      // Should have HELP and TYPE lines
      expect(helpCount).toBeGreaterThan(0);
      expect(typeCount).toBeGreaterThan(0);
    });

    it('should handle rapid metric updates', async () => {
      prometheusMetricsService.reset();

      // Simulate rapid updates
      for (let i = 0; i < 50; i++) {
        prometheusMetricsService.recordQueueLatency(Math.random() * 1000);
        prometheusMetricsService.recordDeliveryAttempt(
          Math.random() * 500,
          'webhook',
          'delivered',
        );
      }

      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('stellar_alerts_queue_latency_milliseconds');
      expect(response.body).toContain('stellar_alerts_delivery_duration_milliseconds');
    });
  });

  describe('Bearer Token Authentication', () => {
    // Note: Auth is only tested in environment-aware integration.
    // Unit tests verify the logic; this ensures the /metrics endpoint exists
    // and responds to unauthenticated requests (development behavior).

    it('should allow unauthenticated requests in development', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
      });

      // Should succeed because NODE_ENV is 'test' (no auth required)
      expect(response.statusCode).toBe(200);
    });

    it('should accept valid bearer token header format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      // Request should be processed (auth check is env-dependent)
      expect(response.statusCode).toBe(200);
    });
  });
});
