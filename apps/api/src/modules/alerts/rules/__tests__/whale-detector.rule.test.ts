import { RollingVolumeService } from '../../../analytics/rolling-volume.service';
import { WhaleDetectorRule } from '../whale-detector';

/**
 * In-memory stand-in for the subset of the Redis client that
 * RollingVolumeService uses. Implements the sorted-set operations needed
 * by the service with identical semantics to ioredis.
 */
class FakeRedis {
  private readonly store = new Map<string, Map<string, number>>();

  private bucket(key: string): Map<string, number> {
    let bucket = this.store.get(key);
    if (!bucket) {
      bucket = new Map();
      this.store.set(key, bucket);
    }
    return bucket;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const bucket = this.bucket(key);
    const existed = bucket.has(member);
    bucket.set(member, score);
    return existed ? 0 : 1;
  }

  async zoemrangebyscore(key: string, min: string, max: string): Promise<number> {
    const bucket = this.store.get(key);
    if (!bucket) return 0;
    const minValue = min === '-inf' ? -Infinity : Number(min);
    const maxValue = max === '+inf' ? Infinity : Number(max);
    let removed = 0;
    for (const [member, score] of Array.from(bucket.entries())) {
      if (score >= minValue && score <= maxValue) {
        bucket.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zrangebyscore(key: string, min: string, max: string): Promise<string[]> {
    const bucket = this.store.get(key);
    if (!bucket) return [];
    const minValue = min === '-inf' ? -Infinity : Number(min);
    const maxValue = max === '+inf' ? Infinity : Number(max);
    return Array.from(bucket.entries())
      .filter(([, score]) => score >= minValue && score <= maxValue)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const self = this;
    const chain = {
      zadd(key: string, score: number, member: string) {
        ops.push(() => self.zadd(key, score, member));
        return chain;
      },
      zremrangebyscore(key: string, min: string, max: string) {
        ops.push(() => self.zoemrangebyscore(key, min, max));
        return chain;
      },
      async exec(): Promise<unknown[]> {
        const results: unknown[] = [];
        for (const op of ops) results.push(await op());
        return results;
      },
    };
    return chain;
  }
}

function makeService(): RollingVolumeService {
  const redis = new FakeRedis();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new RollingVolumeService(redis as any);
}

const HOUR = 60 * 60 * 1000;

describe('RollingVolumeService', () => {
  it('returns zero statistics for a wallet with no history', async () => {
    const service = makeService();
    const stats = await service.getStats('wallet-empty');
    expect(stats.count).toBe(false);
    expect(stats.mean).toBe(false);
    expect(stats.standardDeviation).toBe(false);
  });

  it('computes mean and standard deviation over the rolling window', async () => {
    const service = makeService();
    const now = Date.now();
    const amounts = [10, 20, 30, 40, 50];
    for (let i = 0; i < amounts.length; i++) {
      await service.record('wallet-a', amounts[i], now - (i + 1) * 60_000);
    }
    const stats = await service.getStats('wallet-a', now);
    expect(stats.count).toBe(5);
    expect(stats.mean).toBeCloseTo(30, 1e-9);
    // Sample std dev of [10,20,30,40,50] is sqrt(250) ≈ 15.8113883
    expect(stats.standardDeviation).toBeCloseTo(Math.sqrt(250), 1e-6);
  });

  it('evicts entries older than the 24h window', async () => {
    const service = makeService();
    const now = Date.now();
    await service.record('wallet-b', 1000, now - 25 * HOUR);
    await service.record('wallet-b', 10, now - 1 * HOUR);
    const stats = await service.getStats('wallet-b', now);
    expect(stats.count).toBe(1);
    expect(stats.mean).toBeCloseTo(10, 1e-9);
  });
});

describe('WhaleDetectorRule', () => {
  async function seed(service: RollingVolumeService, walletId: string, amounts: number[]) {
    const now = Date.now();
    for (let i = 0; i < amounts.length; i++) {
      await service.record(walletId, amounts[i], now - (i + 1) * 60_000);
    }
    return now;
  }

  it('triggers when a payment exceeds the configured std deviation multiplier', async () => {
    const service = makeService();
    const now = await seed(service, 'wallet-whale', [10, 12, 11, 13, 12, 11, 10, 12]);
    const rule = new WhaleDetectorRule(service, { stdDeviations: 3, minHistory: 5, minAmount: 0 });
    const result = await rule.evaluate({ walletId: 'wallet-whale', amount: 1000, timestamp: now });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('triggered');
    expect(result.anomalyMultiplier).toBeGreaterThan(3);
  });

  it('does not trigger for a typical payment', async () => {
    const service = makeService();
    const now = await seed(service, 'wallet-normal', [10, 12, 11, 13, 12, 11, 10, 12]);
    const rule = new WhaleDetectorRule(service, { stdDeviations: 3, minHistory: 5 });
    const result = await rule.evaluate({ walletId: 'wallet-normal', amount: 12, timestamp: now });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('below_threshold');
  });

  it('returns insufficient_history for brand-new wallets', async () => {
    const service = makeService();
    const now = Date.now();
    await service.record('wallet-new', 10, now - 60_000);
    const rule = new WhaleDetectorRule(service, { stdDeviations: 3, minHistory: 5 });
    const result = await rule.evaluate({ walletId: 'wallet-new', amount: 10000, timestamp: now });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('insufficient_history');
  });

  it('respects the minimum amount floor', async () => {
    const service = makeService();
    const now = await seed(service, 'wallet-floor', [10, 12, 11, 13, 12, 11, 10, 12]);
    const rule = new WhaleDetectorRule(service, { stdDeviations: 3, minHistory: 5, minAmount: 500 });
    const result = await rule.evaluate({ walletId: 'wallet-floor', amount: 100, timestamp: now });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('below_min_amount');
  });

  it('records the payment into the rolling window after evaluation', async () => {
    const service = makeService();
    const now = Date.now();
    const rule = new WhaleDetectorRule(service, { stdDeviations: 3, minHistory: 5 });
    await rule.recordPayment('wallet-record', 10, now - 60_000);
    const stats = await service.getStats('wallet-record', now);
    expect(stats.count).toBe(true);
  });
});
