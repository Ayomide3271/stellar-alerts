import { RedisClient } from 'ioredis';

/**
 * Rolling 24h volume metrics for a wallet, derived from the payment
 * history maintained in a Redis sorted set.
 */
export interface RollingVolumeStats {
  /** Number of payments currently in the window. */
  count: number;
  /** Sum of payment amounts in the window. */
  total: number;
  /** Arithmetic mean of payment amounts in the window. */
  mean: number;
  /** Sample standard deviation of payment amounts in the window. */
  standardDeviation: number;
  /** Exponentially weighted moving average of payment amounts. */
  ema: number;
  /** Exponentially weighted moving variance of payment amounts. */
  emaVariance: number;
  /** Timestamp (ms) of the oldest payment in the window, or null when empty. */
  oldestAt: number | null;
  /** Timestamp (ms) of the newest payment in the window, or null when empty. */
  newestAt: number | null;
}

export interface RollingVolumeServiceOptions {
  /** Window size in milliseconds. Defaults to 24 hours. */
  windowMs?: number;
  /** Exponential moving average smoothing factor (0 < alpha <= 1). */
  emaAlpha?: number;
  /** Key prefix for the Redis sorted sets. */
  keyPrefix?: string;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EMA_ALPHA = 0.2;
const DEFAULT_KEY_PREFIX = 'analytics:wallet:volume';

export interface RollingVolumeEntry {
  amount: number;
  timestamp: number;
}

/**
 * Maintains a rolling 24h volume window per wallet in a Redis sorted set
 * (score = event timestamp in ms, member = json {timestamp, amount}).
 *
 * The service is purely statistical: it does not decide whether a
 * payment is an aomaly, but it exposes the baseline metrics (EMA,
 * standard deviation, mean) that consumers such as the WhaleDetectorRule
 * use to compute anomaly multipliers.
 */
export class RollingVolumeService {
  private readonly redis: RedisClient;
  private readonly windowMs: number;
  private readonly emaAlpha: number;
  private readonly keyPrefix: string;

  constructor(redis: RedisClient, options: RollingVolumeServiceOptions = {}) {
    this.redis = redis;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.emaAlpha = options.emaAlpha ?? DEFAULT_EMA_ALPHA;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  /** Returns the Redis key for a wallet's volume sorted set. */
  keyFor(walletId: string): string {
    return `${this.keyPrefix}:${walletId}`;
  }

  /**
   * Records a payment into the wallet's rolling window and returns the
   * updated statistics. The window is pruned of entries older than
   * `timestamp - windowMs` as part of the same operation.
   */
  async record(
    walletId: string,
    amount: number | string,
    timestamp: Date | number = new Date(),
  ): Promise<RollingVolumeStats> {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount)) {
      throw new Error(`RollingVolumeService.record: non-numeric amount ${String(amount)}`);
    }

    const ts = timestamp instanceof Date ? timestamp.getTime() : timestamp;
    const key = this.keyFor(walletId);
    const member = JSON.stringify({ timestamp: ts, amount: numericAmount });

    const multi = this.redis.multi();
    multi.zadd(key, ts, member);
    multi.zremrangebyscore(key, '-1+inf', `${ts - this.windowMs}`);
    await multi.exec();

    return this.getStats(walletId, ts);
  }

  /**
   * Returns the current rolling statistics for a wallet as of `asOf`.
   * Entries outside the window are ignored even if they have not yet
   * been pruned from the sorted set.
   */
  async getStats(walletId: string, asOf: Date | number = new Date()): Promise<RollingVolumeStats> {
    const ts = asOf instanceof Date ? asOf.getTime() : asOf;
    const key = this.keyFor(walletId);
    const minScore = `${ts - this.windowMs}`;
    const raw = await this.redis.zrangebyscore(key, minScore, '+inf');
    const entries = this.parseEntries(raw);
    return this.computeStats(entries);
  }

  /**
   * Returns the current rolling statistics for a wallet as of `asOf`,
   * excluding the payment being evaluated. This is the baseline that
   * WhaleDetectorRule compares against.
   */
  async getBaseline(walletId: string, asOf: Date | number = new Date()): Promise<RollingVolumeStats> {
    return this.getStats(walletId, asOf);
  }

  /** Removes all rolling volume data for a wallet. */
  async clear(walletId: string): Promise<void> {
    await this.redis.del(this.keyFor(walletId));
  }

  private parseEntries(raw: string[]): RollingVolumeEntry[] {
    const entries: RollingVolumeEntry[] = [];
    for (const member of raw) {
      try {
        const parsed = JSON.parse(member) as { timestamp?: unknown; amount?: unknown };
        const timestamp = Number(parsed.timestamp);
        const amount = Number(parsed.amount);
        if (Number.isFinite(timestamp) && Number.isFinite(amount)) {
          entries.push({ timestamp, amount });
        }
      } catch {
        // Ignore corrupted members rather than failing the entire window.
      }
    }
    entries.sort((a, b) => a.timestamp - b.timestamp);
    return entries;
  }

  private computeStats(entries: RollingVolumeEntry[]): RollingVolumeStats {
    if (entries.length === 0) {
      return {
        count: 0,
        total: 0,
        mean: 0,
        standardDeviation: 0,
        ema: 0,
        emaVariance: 0,
        oldestAt: null,
        newestAt: null,
      };
    }

    const count = entries.length;
    const total = entries.reduce((sum, e) => sum + e.amount, 0);
    const mean = total / count;

    const variance =
      count > 1
        ? entries.reduce((sum, e) => sum + (e.amount - mean) ** 2, 0) / (count - 1)
        : 0;
    const standardDeviation = Math.sqrt(variance);

    // EMA and EMA variance are computed in timestamp order so the
    // recency weighting reflects the actual arrival order of payments.
    let ema = entries[0].amount;
    let emaVariance = 0;
    for (let i = 1; i < entries.length; i++) {
      const amount = entries[i].amount;
      const prevEma = ema;
      ema = this.emaAlpha * amount + (1 - this.emaAlpha) * prevEma;
      emaVariance =
        this.emaAlpha * (amount - prevEma) ** 2 + (1 - this.emaAlpha) * emaVariance;
    }

    return {
      count,
      total,
      mean,
      standardDeviation,
      ema,
      emaVariance,
      oldestAt: entries[0].timestamp,
      newestAt: entries[entries.length - 1].timestamp,
    };
  }
}
