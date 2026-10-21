/**
 * Prometheus metrics service for Stellar Alerts.
 * Exports counters, histograms, and gauges for ingestion lag, queue latency, and delivery SLOs.
 * 
 * Hand-rolled Prometheus exposition format (dependency-free, like webhook-metrics.ts).
 */

/** Delivery provider types tracked separately. */
export type DeliveryProvider = 'webhook' | 'telegram' | 'email' | 'discord' | 'slack';

/** Terminal outcome of a delivery attempt. */
export type DeliveryOutcome = 'delivered' | 'failed' | 'skipped';

/** Histogram bucket boundaries (milliseconds for latency, seconds for lag). */
const LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const LAG_BUCKETS_SECONDS = [1, 5, 10, 30, 60, 300, 600, 1800, 3600];

/**
 * Lightweight histogram tracking for Prometheus metrics.
 */
class Histogram {
  private readonly series = new Map<
    string,
    { counts: number[]; sum: number; count: number }
  >();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly bounds: readonly number[],
  ) {}

  observe(labels: string, value: number): void {
    if (!Number.isFinite(value)) return;

    let entry = this.series.get(labels);
    if (!entry) {
      entry = { counts: new Array(this.bounds.length).fill(0), sum: 0, count: 0 };
      this.series.set(labels, entry);
    }

    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.bounds.length; i++) {
      if (value <= this.bounds[i]) {
        entry.counts[i] += 1;
      }
    }
  }

  render(): string[] {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    if (this.series.size === 0) {
      return lines;
    }

    for (const [labels, entry] of this.series) {
      const withBound = (bound: string) =>
        labels ? `${labels},le="${bound}"` : `le="${bound}"`;

      for (let i = 0; i < this.bounds.length; i++) {
        lines.push(
          `${this.name}_bucket{${withBound(String(this.bounds[i]))}} ${entry.counts[i]}`,
        );
      }
      lines.push(`${this.name}_bucket{${withBound('+Inf')}} ${entry.count}`);

      const sumSuffix = labels ? `_sum{${labels}}` : '_sum';
      const countSuffix = labels ? `_count{${labels}}` : '_count';
      lines.push(`${this.name}${sumSuffix} ${entry.sum}`);
      lines.push(`${this.name}${countSuffix} ${entry.count}`);
    }

    return lines;
  }

  reset(): void {
    this.series.clear();
  }
}

/**
 * Lightweight counter for Prometheus metrics.
 */
class Counter {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  increment(labels: string, value: number = 1): void {
    this.values.set(labels, (this.values.get(labels) ?? 0) + value);
  }

  render(): string[] {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const [labels, value] of this.values) {
      lines.push(`${this.name}{${labels}} ${value}`);
    }
    return lines;
  }

  reset(): void {
    this.values.clear();
  }
}

/**
 * Lightweight gauge for Prometheus metrics.
 */
class Gauge {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(labels: string, value: number): void {
    this.values.set(labels, value);
  }

  render(): string[] {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    for (const [labels, value] of this.values) {
      lines.push(`${this.name}{${labels}} ${value}`);
    }
    return lines;
  }

  reset(): void {
    this.values.clear();
  }
}

/**
 * Main Prometheus metrics collector for Stellar Alerts.
 */
export class PrometheusMetricsService {
  // Ledger ingestion lag histogram (seconds)
  private ledgerLagHistogram = new Histogram(
    'stellar_alerts_ledger_lag_seconds',
    'Ledger ingestion lag in seconds (delay between on-chain ledger and local processing)',
    LAG_BUCKETS_SECONDS,
  );

  // Queue latency histogram (milliseconds)
  private queueLatencyHistogram = new Histogram(
    'stellar_alerts_queue_latency_milliseconds',
    'Queue processing latency from enqueue to dispatch in milliseconds',
    LATENCY_BUCKETS_MS,
  );

  // Delivery attempt duration histogram (milliseconds)
  private deliveryDurationHistogram = new Histogram(
    'stellar_alerts_delivery_duration_milliseconds',
    'Notification delivery attempt duration in milliseconds, grouped by provider',
    LATENCY_BUCKETS_MS,
  );

  // Delivery attempt counter by outcome
  private deliveryCounterByOutcome = new Counter(
    'stellar_alerts_delivery_attempts_total',
    'Total notification delivery attempts by provider and outcome',
  );

  // Queue depth gauge (jobs waiting)
  private queueDepthGauge = new Gauge(
    'stellar_alerts_queue_depth_jobs',
    'Current number of jobs waiting in queue',
  );

  // Active workers gauge
  private activeWorkersGauge = new Gauge(
    'stellar_alerts_active_workers_count',
    'Number of active worker instances/pods',
  );

  // SLO success rate gauge (delivery success % per provider, last 1h window)
  private deliverySloGauge = new Gauge(
    'stellar_alerts_delivery_slo_success_rate',
    'Delivery success rate (%) for SLO tracking, grouped by provider (1h window)',
  );

  /**
   * Record ingestion lag (seconds from on-chain ledger to local processing).
   */
  recordLedgerLag(lagSeconds: number, source: string = 'horizon'): void {
    this.ledgerLagHistogram.observe(`source="${source}"`, lagSeconds);
  }

  /**
   * Record queue latency (milliseconds from enqueue to dispatch).
   */
  recordQueueLatency(latencyMs: number, queueName: string = 'notifications'): void {
    this.queueLatencyHistogram.observe(`queue="${queueName}"`, latencyMs);
  }

  /**
   * Record delivery attempt duration and outcome.
   */
  recordDeliveryAttempt(
    durationMs: number,
    provider: DeliveryProvider,
    outcome: DeliveryOutcome,
  ): void {
    const labels = `provider="${provider}",outcome="${outcome}"`;
    this.deliveryDurationHistogram.observe(labels, durationMs);
    this.deliveryCounterByOutcome.increment(labels);
  }

  /**
   * Update queue depth gauge (jobs waiting).
   */
  setQueueDepth(depth: number, queueName: string = 'notifications'): void {
    this.queueDepthGauge.set(`queue="${queueName}"`, depth);
  }

  /**
   * Update active worker count.
   */
  setActiveWorkers(count: number): void {
    this.activeWorkersGauge.set('', count);
  }

  /**
   * Update delivery SLO success rate for a provider (0-100).
   * Typically computed over a 1-hour sliding window.
   */
  setDeliverySloRate(provider: DeliveryProvider, successRatePercent: number): void {
    this.deliverySloGauge.set(`provider="${provider}"`, successRatePercent);
  }

  /**
   * Render all metrics in Prometheus text exposition format.
   */
  render(): string {
    return [
      this.ledgerLagHistogram.render().join('\n'),
      '',
      this.queueLatencyHistogram.render().join('\n'),
      '',
      this.deliveryDurationHistogram.render().join('\n'),
      '',
      this.deliveryCounterByOutcome.render().join('\n'),
      '',
      this.queueDepthGauge.render().join('\n'),
      '',
      this.activeWorkersGauge.render().join('\n'),
      '',
      this.deliverySloGauge.render().join('\n'),
      '',
    ].join('\n');
  }

  /**
   * Reset all metrics (for testing).
   */
  reset(): void {
    this.ledgerLagHistogram.reset();
    this.queueLatencyHistogram.reset();
    this.deliveryDurationHistogram.reset();
    this.deliveryCounterByOutcome.reset();
    this.queueDepthGauge.reset();
    this.activeWorkersGauge.reset();
    this.deliverySloGauge.reset();
  }
}

// Singleton instance
export const prometheusMetricsService = new PrometheusMetricsService();
