import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DistributedLockManager,
  RedisClientLike,
  RENEW_LUA_SCRIPT,
  RELEASE_LUA_SCRIPT,
} from '../redlock';

class MockRedisCluster implements RedisClientLike {
  public store = new Map<string, { value: string; expiresAt: number }>();

  public async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  public async set(
    key: string,
    value: string,
    _px: string,
    ttl: number,
    nx: string
  ): Promise<string | null> {
    const current = await this.get(key);
    if (nx === 'NX' && current !== null) {
      return null;
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
    return 'OK';
  }

  public async eval(
    script: string,
    _numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    const key = String(args[0]);
    const val = String(args[1]);

    if (script === RELEASE_LUA_SCRIPT) {
      const current = await this.get(key);
      if (current === val) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }

    if (script === RENEW_LUA_SCRIPT) {
      const ttl = Number(args[2]);
      const current = await this.get(key);
      if (current === val) {
        this.store.set(key, {
          value: val,
          expiresAt: Date.now() + ttl,
        });
        return 1;
      }
      return 0;
    }

    return 0;
  }
}

describe('DistributedLockManager via Redlock (#744)', () => {
  let mockRedis: MockRedisCluster;

  beforeEach(() => {
    mockRedis = new MockRedisCluster();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should acquire lock for wallet and prevent second worker replica from acquiring active lock on same wallet', async () => {
    const worker1 = new DistributedLockManager(mockRedis);
    const worker2 = new DistributedLockManager(mockRedis);

    const walletId = 'wallet_stellar_abc';

    // Worker 1 acquires lock
    const lock1 = await worker1.acquireWalletLock(walletId, { ttlMs: 15_000 });
    expect(lock1).not.toBeNull();
    expect(lock1?.active).toBe(true);
    expect(worker1.isWalletLockedByThisWorker(walletId)).toBe(true);

    // Worker 2 attempts to acquire lock for same wallet
    const lock2 = await worker2.acquireWalletLock(walletId, { ttlMs: 15_000 });
    expect(lock2).toBeNull();
    expect(worker2.isWalletLockedByThisWorker(walletId)).toBe(false);

    // Worker 1 releases lock
    const released = await worker1.releaseWalletLock(walletId);
    expect(released).toBe(true);
    expect(lock1?.active).toBe(false);

    // Worker 2 can now acquire the lock
    const lock2After = await worker2.acquireWalletLock(walletId, { ttlMs: 15_000 });
    expect(lock2After).not.toBeNull();
    expect(worker2.isWalletLockedByThisWorker(walletId)).toBe(true);

    await worker2.releaseAll();
  });

  it('should renew lock lease periodically while worker process is healthy', async () => {
    vi.useFakeTimers();

    const worker = new DistributedLockManager(mockRedis);
    const walletId = 'wallet_heartbeat_test';

    const lock = await worker.acquireWalletLock(walletId, {
      ttlMs: 6_000,
      heartbeatIntervalMs: 2_000,
    });
    expect(lock).not.toBeNull();

    // Advance time by 4 seconds (2 heartbeat ticks)
    await vi.advanceTimersByTimeAsync(4_000);

    // Lock must still be active and not expired
    const currentVal = await mockRedis.get(`lock:wallet:${walletId}`);
    expect(currentVal).toBe(lock?.value);

    await worker.releaseAll();
  });

  it('should verify lock expiration and takeover when owning process simulates crash without release', async () => {
    vi.useFakeTimers();

    const worker1 = new DistributedLockManager(mockRedis);
    const worker2 = new DistributedLockManager(mockRedis);

    const walletId = 'wallet_crash_test';

    // Worker 1 acquires a 5-second lock
    const lock1 = await worker1.acquireWalletLock(walletId, {
      ttlMs: 5_000,
      heartbeatIntervalMs: 10_000, // heartbeat won't run before 5s
    });
    expect(lock1).not.toBeNull();

    // Worker 2 cannot acquire immediately
    const lock2Initial = await worker2.acquireWalletLock(walletId);
    expect(lock2Initial).toBeNull();

    // Simulate worker 1 crash: no release() is called, process halts.
    // Advance time past the 5-second lease expiration
    await vi.advanceTimersByTimeAsync(6_000);

    // Worker 2 can now claim the expired wallet lock!
    const lock2Takeover = await worker2.acquireWalletLock(walletId, { ttlMs: 5_000 });
    expect(lock2Takeover).not.toBeNull();
    expect(worker2.isWalletLockedByThisWorker(walletId)).toBe(true);

    await worker2.releaseAll();
  });

  it('should release all locks immediately on releaseAll (graceful shutdown)', async () => {
    const worker = new DistributedLockManager(mockRedis);

    await worker.acquireWalletLock('w1');
    await worker.acquireWalletLock('w2');
    await worker.acquireWalletLock('w3');

    expect(worker.getActiveLocksCount()).toBe(3);

    await worker.releaseAll();

    expect(worker.getActiveLocksCount()).toBe(0);
    expect(await mockRedis.get('lock:wallet:w1')).toBeNull();
    expect(await mockRedis.get('lock:wallet:w2')).toBeNull();
    expect(await mockRedis.get('lock:wallet:w3')).toBeNull();
  });
});
