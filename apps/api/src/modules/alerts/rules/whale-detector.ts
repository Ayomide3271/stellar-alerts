import {
  RollingVolumeService,
  RollingVolumeStats,
} from '../../analytics/rolling-volume.service';

/**
 * Configuration for the WhaleDetectorRule. The detector fires when a
 * payment exceeds the rolling baseline by more than `stdDeviations`
 * standard deviations (and optionally by an absolute multiple of the
 * EMA).
 */
export interface WhaleDetectorConfig {
  /** Number of standard deviations above the baseline that triggers an alert. */
  stdDeviations: number;
  /** Minimum number of historical payments required before firing. */
  minHistory: number;
  /** Optional absolute floor for the payment amount. */
  minAmount?: number;
  /** Optional multiple of the EMA that the payment must also exceed. */
  minEmaMultiplier?: number;
}

export const DEFAULT_WHALE_CONFIG: Required<WhaleDetectorConfig> = {
  stdDeviations: 3,
  minHistory: 5,
  minAmount: 0,
  minEmaMultiplier: 2,
};

export interface WhaleDetectorEvaluationInput {
  walletId: string;
  amount: number | string;
  /** Timestamp of the payment being evaluated. Defaults to now. */
  timestamp?: Date | number;
}

export interface WhaleDetectorEvaluationResult {
  /** Whether the payment should trigger an alert. */
  triggered: boolean;
  /** Reason code for the decision (for observability/testing). */
  reason:
    | 'triggered'
    | 'below_threshold'
    | 'insufficient_history'
    | 'invalid_amount'
    | 'below_min_amount'
    | 'below_ema_multiplier';
  /** The payment amount as a number. */
  amount: number;
  /** Rolling baseline statistics used for the decision. */
  baseline: RollingVolumeStats;
  /** The threshold amount computed from the baseline. */
  threshold: number;
  /** How many standard deviations the payment is above the mean. */
  anomalyMultiplier: number;
}

/**
 * WhaleDetectorRule fires when a payment is anomalous relative to a
 * wallet's rolling 24h volume baseline. The baseline is maintained by
 * RollingVolumeService in Redis sorted sets, and this rule computes the
 * anomaly multiplier and decides whether to fire.
 */
export class WhaleDetectorRule {
  private readonly volumeService: RollingVolumeService;
  private readonly config: Required<WhaleDetectorConfig>;

  constructor(volumeService: RollingVolumeService, config: Partial<WhaleDetectorConfig> = {}) {
    this.volumeService = volumeService;
    this.config = { ...DEFAULT_WHALE_CONFIG, };
}

  /**
   * Evaluates a payment against the wallet's rolling baseline. The
   * payment is not included in the baseline used for the decision; it is
   * only recorded into the rolling window after evaluation via
   * `recordPayment`.
   */
  async evaluate(input: WhaleDetectorEvaluationInput): Promise<WhaleDetectorEvaluationResult> {
    const amount = Number(input.amount);
    const timestamp = input.timestamp ?? Date.now();
    const baseline = await this.volumeService.getBaseline(input.walletId, timestamp);

    if (!Number.isFinite(amount)) {
      return {
        triggered: false,
        reason: 'invalid_amount',
        amount,
        baseline,
        threshold: 0,
        anomalyMultiplier: 0,
      };
    }

    if (this.config.minAmount !== undefined && amount < this.config.minAmount) {
      return {
        triggered: false,
        reason: 'below_min_amount',
        amount,
        baseline,
        threshold: 0,
        anomalyMultiplier: 0,
      };
    }

    if (baseline.count < this.config.minHistory) {
      return {
        triggered: false,
        reason: 'insufficient_history',
        amount,
        baseline,
        threshold: 0,
        anomalyMultiplier: 0,
      };
    }

    const threshold = this.computeThreshold(baseline);
    const anomalyMultiplier = this.computeAnomalyMultiplier(amount, baseline);

    if (amount <= threshold) {
      return {
        triggered: false,
        reason: 'below_threshold',
        amount,
        baseline,
        threshold,
        anomalyMultiplier,
      };
    }

    if (
      this.config.minEmaMultiplier !== undefined &&
      baseline.ema > 0 &&
      amount < baseline.ema * this.config.minEmaMultiplier
    ) {
      return {
        triggered: false,
        reason: 'below_ema_multiplier',
        amount,
        baseline,
        threshold,
        anomalyMultiplier,
      };
    }

    return {
      triggered: true,
      reason: 'triggered',
      amount,
      baseline,
      threshold,
      anomalyMultiplier,
    };
  }

  /**
   * Records a payment into the wallet's rolling window. Call this after
   * `evaluate` so the payment being evaluated does not pollute its own
   * baseline.
   */
  async recordPayment(
    walletId: string,
    amount: number | string,
    timestamp: Date | number = new Date(),
  ): Promise<RollingVolumeStats> {
    return this.volumeService.record(walletId, amount, timestamp);
  }

  /**
   * Computes the amount threshold above which a payment is considered
   * anomalous. Uses the larger of the EMA-based and mean-based
   * thresholds so that both recency-weighted and window-average behavior
   * are respected.
   */
  computeThreshold(baseline: RollingVolumeStats): number {
    const stdDeviations = this.config.stdDeviations;
    const meanThreshold = baseline.mean + stdDeviations * baseline.standardDeviation;
    const emaStd = Math.sqrt(Math.max(baseline.emaVariance, 0));
    const emaThreshold = baseline.ema + stdDeviations * emaStd;
    return Math.max(meanThreshold, emaThreshold);
  }

  /**
   * Anomaly multiplier = how many standard deviations the payment is
   * above the mean. Returns 0 when the payment is at or below the mean,
   * and Infinity when the historical volatility is zero and the payment
   * exceeds the mean.
   */
  computeAnomalyMultiplier(amount: number, baseline: RollingVolumeStats): number {
    if (amount <= baseline.mean) return 0;
    if (baseline.standardDeviation === 0) return Number.POSITIVE_INFINITY;
    return (amount - baseline.mean) / baseline.standardDeviation;
  }
}
