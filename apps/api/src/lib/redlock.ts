const logger = {
  info: (data: Record<string, unknown>, msg: string) => console.log(`[DistributedLockManager] ${msg}`, data),
  warn: (data: Record<string, unknown>, msg: string) => console.warn(`[DistributedLockManager] ${msg}`, data),
  error: (data: Record<string, unknown>, msg: string) => console.error(`[DistributedLockManager] ${msg}`, data),
};

export interface LockOptions {
  ttlMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  heartbeatIntervalMs?: number;
}

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: string, ttl: number, nx: string): Promise<string | null>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export const RENEW_LUA_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

export const RELEASE_LUA_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

const DEFAULT_TTL_MS = 15_000;

export class DistributedLock {
  public readonly key: string;
  public readonly value: string;
  public readonly walletId: string;
  public readonly ttlMs: number;
  private heartbeatIntervalMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private redisClient: RedisClientLike;
  private isReleased = false;

  constructor(
    walletId: string,
    key: string,
    value: string,
    ttlMs: number,
    redisClient: RedisClientLike,
    heartbeatIntervalMs?: number
  ) {
    this.walletId = walletId;
    this.key = key;
    this.value = value;
    this.ttlMs = ttlMs;
    this.redisClient = redisClient;
    this.heartbeatIntervalMs = heartbeatIntervalMs ?? Math.max(1000, Math.floor(ttlMs / 3));

    this.startHeartbeat();
  }

  public get active(): boolean {
    return !this.isReleased;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(async () => {
      if (this.isReleased) {
        this.stopHeartbeat();
        return;
      }

      const renewed = await this.renew();
      if (!renewed) {
        logger.warn(
          { key: this.key, walletId: this.walletId },
          '[DistributedLock] Heartbeat lease renewal failed or lock lost.'
        );
        this.stopHeartbeat();
      }
    }, this.heartbeatIntervalMs);

    // Prevent heartbeat from keeping process alive if everything else is shutting down
    if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Extends the TTL lease on Redis if this instance still holds the lock.
   */
  public async renew(): Promise<boolean> {
    if (this.isReleased) return false;

    try {
      const result = await this.redisClient.eval(
        RENEW_LUA_SCRIPT,
        1,
        this.key,
        this.value,
        this.ttlMs
      );
      return Number(result) === 1;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ key: this.key, err: errMsg }, '[DistributedLock] Redis renew error');
      return false;
    }
  }

  /**
   * Safely releases this lock using Lua compare-and-delete.
   */
  public async release(): Promise<boolean> {
    if (this.isReleased) return true;
    this.isReleased = true;
    this.stopHeartbeat();

    try {
      const result = await this.redisClient.eval(
        RELEASE_LUA_SCRIPT,
        1,
        this.key,
        this.value
      );
      return Number(result) === 1;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ key: this.key, err: errMsg }, '[DistributedLock] Redis release error');
      return false;
    }
  }
}

export class DistributedLockManager {
  private redisClient: RedisClientLike;
  private activeLocks = new Map<string, DistributedLock>();
  private instanceId: string;
  private signalsRegistered = false;

  constructor(client: RedisClientLike = redis as unknown as RedisClientLike) {
    this.redisClient = client;
    this.instanceId = `${process.pid}-${Math.random().toString(36).substring(2, 9)}`;
    this.registerSignalHandlers();
  }

  public getLockKey(walletId: string): string {
    return `lock:wallet:${walletId}`;
  }

  /**
   * Attempts to acquire a distributed lease lock for a wallet address/ID.
   */
  public async acquireWalletLock(
    walletId: string,
    options: LockOptions = {}
  ): Promise<DistributedLock | null> {
    const key = this.getLockKey(walletId);
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const retryCount = options.retryCount ?? 0;
    const retryDelayMs = options.retryDelayMs ?? 150;
    const value = `${this.instanceId}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        const result = await this.redisClient.set(key, value, 'PX', ttlMs, 'NX');
        if (result === 'OK') {
          const lock = new DistributedLock(
            walletId,
            key,
            value,
            ttlMs,
            this.redisClient,
            options.heartbeatIntervalMs
          );
          this.activeLocks.set(walletId, lock);
          logger.info({ walletId, key }, '[DistributedLockManager] 🔒 Distributed lock acquired');
          return lock;
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ walletId, err: errMsg }, '[DistributedLockManager] Redis error acquiring lock');
      }

      if (attempt < retryCount) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    return null;
  }

  /**
   * Releases an active wallet lock by walletId.
   */
  public async releaseWalletLock(walletId: string): Promise<boolean> {
    const lock = this.activeLocks.get(walletId);
    if (!lock) return false;

    this.activeLocks.delete(walletId);
    return await lock.release();
  }

  /**
   * Releases all locks held by this worker instance.
   * Called immediately during worker shutdown (SIGINT/SIGTERM) so peer replicas can claim wallets immediately.
   */
  public async releaseAll(): Promise<void> {
    const locksToRelease = Array.from(this.activeLocks.values());
    this.activeLocks.clear();

    if (locksToRelease.length === 0) return;

    logger.info(
      { count: locksToRelease.length },
      '[DistributedLockManager] 🔓 Releasing all held locks on shutdown...'
    );

    await Promise.allSettled(locksToRelease.map((lock) => lock.release()));
  }

  public getActiveLocksCount(): number {
    return this.activeLocks.size;
  }

  public isWalletLockedByThisWorker(walletId: string): boolean {
    const lock = this.activeLocks.get(walletId);
    return Boolean(lock && lock.active);
  }

  private registerSignalHandlers(): void {
    if (this.signalsRegistered) return;
    this.signalsRegistered = true;

    const gracefulRelease = async (signal: string) => {
      logger.info({ signal }, `[DistributedLockManager] Received ${signal}, releasing locks gracefully`);
      await this.releaseAll();
    };

    if (typeof process !== 'undefined' && process.on) {
      process.once('SIGTERM', () => void gracefulRelease('SIGTERM'));
      process.once('SIGINT', () => void gracefulRelease('SIGINT'));
    }
  }
}

function getDefaultRedisClient(): RedisClientLike {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { redis } = require('./redis');
    if (redis) return redis as RedisClientLike;
  } catch {
    // Return mock stub if redis module is unavailable
  }
  return {
    async get() { return null; },
    async set() { return null; },
    async eval() { return 0; },
  };
}

export const distributedLockManager = new DistributedLockManager(getDefaultRedisClient());
