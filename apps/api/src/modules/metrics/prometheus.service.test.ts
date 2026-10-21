import { describe, it, expect, beforeEach } from 'vitest';
import { PrometheusMetricsService } from './prometheus.service';

describe('PrometheusMetricsService', () => {
  let service: PrometheusMetricsService;

  beforeEach(() => {
    service = new PrometheusMetricsService();
  });

  describe('Ledger Lag Metrics', () => {
    it('should record ledger lag observations', () => {
      service.recordLedgerLag(2.5, 'horizon');
      service.recordLedgerLag(1.2, 'horizon');
      service.recordLedgerLag(5.0, 'soroban-rpc');

      const output = service.render();

      expect(output).toContain('stellar_alerts_ledger_lag_seconds');
      expect(output).toContain('source="horizon"');
      expect(output).toContain('source="soroban-rpc"');
      expect(output).toContain('_count 2'); // 2 horizon observations
    });

    it('should produce valid Prometheus format for lag metrics', () => {
      service.recordLedgerLag(10, 'horizon');
      const output = service.render();

      expect(output).toContain('# HELP stellar_alerts_ledger_lag_seconds');
      expect(output).toContain('# TYPE stellar_alerts_ledger_lag_seconds histogram');
      expect(output).toMatch(/stellar_alerts_ledger_lag_seconds_bucket.*le=/);
    });

    it('should ignore NaN and Infinity lag values', () => {
      service.recordLedgerLag(NaN);
      service.recordLedgerLag(Infinity);
      service.recordLedgerLag(2.5);

      const output = service.render();
      // Only the valid value should be counted
      expect(output).toContain('_count 1');
    });
  });

  describe('Queue Latency Metrics', () => {
    it('should record queue latency observations', () => {
      service.recordQueueLatency(100, 'notifications');
      service.recordQueueLatency(250, 'notifications');
      service.recordQueueLatency(50, 'alerts');

      const output = service.render();

      expect(output).toContain('stellar_alerts_queue_latency_milliseconds');
      expect(output).toContain('queue="notifications"');
      expect(output).toContain('queue="alerts"');
    });

    it('should track histogram buckets correctly', () => {
      service.recordQueueLatency(5);
      service.recordQueueLatency(50);
      service.recordQueueLatency(500);

      const output = service.render();

      expect(output).toContain('le="5"');
      expect(output).toContain('le="50"');
      expect(output).toContain('le="500"');
      expect(output).toContain('le="+Inf"');
    });
  });

  describe('Delivery Metrics', () => {
    it('should record delivery attempts with outcome', () => {
      service.recordDeliveryAttempt(150, 'webhook', 'delivered');
      service.recordDeliveryAttempt(500, 'webhook', 'failed');
      service.recordDeliveryAttempt(100, 'telegram', 'delivered');

      const output = service.render();

      expect(output).toContain('stellar_alerts_delivery_duration_milliseconds');
      expect(output).toContain('stellar_alerts_delivery_attempts_total');
      expect(output).toContain('provider="webhook"');
      expect(output).toContain('provider="telegram"');
      expect(output).toContain('outcome="delivered"');
      expect(output).toContain('outcome="failed"');
    });

    it('should track all provider types', () => {
      const providers: Array<'webhook' | 'telegram' | 'email' | 'discord' | 'slack'> = [
        'webhook',
        'telegram',
        'email',
        'discord',
        'slack',
      ];

      for (const provider of providers) {
        service.recordDeliveryAttempt(100, provider, 'delivered');
      }

      const output = service.render();

      for (const provider of providers) {
        expect(output).toContain(`provider="${provider}"`);
      }
    });

    it('should track all outcome types', () => {
      const outcomes: Array<'delivered' | 'failed' | 'skipped'> = [
        'delivered',
        'failed',
        'skipped',
      ];

      for (const outcome of outcomes) {
        service.recordDeliveryAttempt(100, 'webhook', outcome);
      }

      const output = service.render();

      for (const outcome of outcomes) {
        expect(output).toContain(`outcome="${outcome}"`);
      }
    });

    it('should aggregate delivery attempts in counter', () => {
      service.recordDeliveryAttempt(100, 'webhook', 'delivered');
      service.recordDeliveryAttempt(120, 'webhook', 'delivered');
      service.recordDeliveryAttempt(110, 'webhook', 'delivered');

      const output = service.render();

      // Counter should show 3 total
      expect(output).toMatch(
        /stellar_alerts_delivery_attempts_total\{.*outcome="delivered".*\}\s+3/,
      );
    });
  });

  describe('Queue Depth Gauge', () => {
    it('should set queue depth', () => {
      service.setQueueDepth(42, 'notifications');
      service.setQueueDepth(15, 'webhooks');

      const output = service.render();

      expect(output).toContain('stellar_alerts_queue_depth_jobs');
      expect(output).toContain('queue="notifications" 42');
      expect(output).toContain('queue="webhooks" 15');
    });

    it('should overwrite previous queue depth value', () => {
      service.setQueueDepth(100, 'notifications');
      service.setQueueDepth(50, 'notifications');

      const output = service.render();

      expect(output).toContain('queue="notifications" 50');
      expect(output).not.toContain('queue="notifications" 100');
    });
  });

  describe('Active Workers Gauge', () => {
    it('should set active worker count', () => {
      service.setActiveWorkers(3);

      const output = service.render();

      expect(output).toContain('stellar_alerts_active_workers_count 3');
    });

    it('should produce valid gauge format', () => {
      service.setActiveWorkers(5);
      const output = service.render();

      expect(output).toContain('# HELP stellar_alerts_active_workers_count');
      expect(output).toContain('# TYPE stellar_alerts_active_workers_count gauge');
    });
  });

  describe('SLO Success Rate Gauge', () => {
    it('should set delivery SLO success rate per provider', () => {
      service.setDeliverySloRate('webhook', 99.5);
      service.setDeliverySloRate('telegram', 98.2);
      service.setDeliverySloRate('email', 97.0);

      const output = service.render();

      expect(output).toContain('stellar_alerts_delivery_slo_success_rate');
      expect(output).toContain('provider="webhook" 99.5');
      expect(output).toContain('provider="telegram" 98.2');
      expect(output).toContain('provider="email" 97');
    });

    it('should track SLO rates 0-100', () => {
      service.setDeliverySloRate('webhook', 100);
      service.setDeliverySloRate('telegram', 0);

      const output = service.render();

      expect(output).toContain('provider="webhook" 100');
      expect(output).toContain('provider="telegram" 0');
    });
  });

  describe('Prometheus Output Format', () => {
    it('should produce valid Prometheus text exposition format', () => {
      service.recordLedgerLag(5);
      service.recordQueueLatency(100);
      service.recordDeliveryAttempt(50, 'webhook', 'delivered');
      service.setQueueDepth(10);
      service.setActiveWorkers(2);
      service.setDeliverySloRate('webhook', 99.5);

      const output = service.render();

      // Every metric should have HELP and TYPE
      expect(output).toMatch(/# HELP stellar_alerts_ledger_lag_seconds/);
      expect(output).toMatch(/# TYPE stellar_alerts_ledger_lag_seconds histogram/);

      expect(output).toMatch(/# HELP stellar_alerts_queue_latency_milliseconds/);
      expect(output).toMatch(/# TYPE stellar_alerts_queue_latency_milliseconds histogram/);

      expect(output).toMatch(/# HELP stellar_alerts_delivery_duration_milliseconds/);
      expect(output).toMatch(/# TYPE stellar_alerts_delivery_duration_milliseconds histogram/);

      expect(output).toMatch(/# HELP stellar_alerts_delivery_attempts_total/);
      expect(output).toMatch(/# TYPE stellar_alerts_delivery_attempts_total counter/);

      expect(output).toMatch(/# HELP stellar_alerts_queue_depth_jobs/);
      expect(output).toMatch(/# TYPE stellar_alerts_queue_depth_jobs gauge/);

      expect(output).toMatch(/# HELP stellar_alerts_active_workers_count/);
      expect(output).toMatch(/# TYPE stellar_alerts_active_workers_count gauge/);

      expect(output).toMatch(/# HELP stellar_alerts_delivery_slo_success_rate/);
      expect(output).toMatch(/# TYPE stellar_alerts_delivery_slo_success_rate gauge/);
    });

    it('should produce empty metrics section with no observations', () => {
      const output = service.render();

      // HELP and TYPE lines should still exist
      expect(output).toContain('# HELP stellar_alerts_ledger_lag_seconds');
      expect(output).toContain('# TYPE stellar_alerts_ledger_lag_seconds histogram');

      // But no data lines
      expect(output).not.toMatch(/stellar_alerts_ledger_lag_seconds\{.*\}\s+\d+/);
    });

    it('should separate metric families with blank lines', () => {
      service.recordLedgerLag(5);
      service.recordQueueLatency(100);

      const output = service.render();

      // Should have empty lines between metric families
      const lines = output.split('\n');
      let emptyLineCount = 0;

      for (const line of lines) {
        if (line.trim() === '') {
          emptyLineCount += 1;
        }
      }

      expect(emptyLineCount).toBeGreaterThan(0);
    });
  });

  describe('Reset Functionality', () => {
    it('should reset all metrics', () => {
      service.recordLedgerLag(5);
      service.recordQueueLatency(100);
      service.recordDeliveryAttempt(50, 'webhook', 'delivered');
      service.setQueueDepth(10);
      service.setActiveWorkers(2);

      service.reset();

      const output = service.render();

      // Should have HELP/TYPE but no data
      expect(output).toContain('# HELP stellar_alerts_ledger_lag_seconds');
      expect(output).not.toMatch(/stellar_alerts_ledger_lag_seconds\{.*\}\s+\d+(?!\d)/);
    });

    it('should allow re-recording after reset', () => {
      service.recordLedgerLag(5);
      service.reset();
      service.recordLedgerLag(10);

      const output = service.render();

      expect(output).toContain('_count 1');
    });
  });

  describe('Concurrent Metric Recording', () => {
    it('should handle multiple concurrent records', () => {
      // Simulate rapid concurrent metric updates
      for (let i = 0; i < 100; i++) {
        service.recordLedgerLag(Math.random() * 10);
        service.recordQueueLatency(Math.random() * 1000);
        service.recordDeliveryAttempt(Math.random() * 500, 'webhook', 'delivered');
      }

      const output = service.render();

      expect(output).toContain('_count 100');
      expect(output).toContain('_sum'); // Histogram sum
    });
  });
});
