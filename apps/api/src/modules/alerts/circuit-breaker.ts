import { redis } from '../../lib/redis';
import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'RedisCircuitBreaker' });

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number; // default: 5
  windowSeconds?: number;     // default: 60
  cooldownSeconds?: number;   // default: 60
}

export interface CircuitBreakerSnapshot {
  endpointId: string;
  state: CircuitState;
  failureCount: number;
  openedAt?: number | null;
  cooldownRemainingSeconds?: number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly endpointId: string) {
    super(`Circuit breaker is OPEN for endpoint ${endpointId}`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class RedisCircuitBreaker {
  private failureThreshold: number;
  private windowSeconds: number;
  private cooldownSeconds: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.windowSeconds = options.windowSeconds ?? 60;
    this.cooldownSeconds = options.cooldownSeconds ?? 60;
  }

  private stateKey(endpointId: string): string {
    return `circuit_breaker:${endpointId}:state`;
  }

  private failuresKey(endpointId: string): string {
    return `circuit_breaker:${endpointId}:failures`;
  }

  private openedAtKey(endpointId: string): string {
    return `circuit_breaker:${endpointId}:opened_at`;
  }

  /**
   * Retrieves the current circuit breaker state from Redis.
   * If in OPEN state and cooldown has elapsed, automatically transitions to HALF_OPEN.
   */
  public async getState(endpointId: string): Promise<CircuitState> {
    try {
      const state = await redis.get(this.stateKey(endpointId));
      if (!state) {
        return 'CLOSED';
      }

      if (state === 'OPEN') {
        const openedAtStr = await redis.get(this.openedAtKey(endpointId));
        if (openedAtStr) {
          const openedAt = parseInt(openedAtStr, 10);
          const elapsed = Math.floor((Date.now() - openedAt) / 1000);
          if (elapsed >= this.cooldownSeconds) {
            // Cooldown passed: transition to HALF_OPEN for canary request
            await redis.set(this.stateKey(endpointId), 'HALF_OPEN');
            logger.info({ endpointId }, 'Circuit breaker transitioned OPEN -> HALF_OPEN (cooldown elapsed)');
            return 'HALF_OPEN';
          }
        }
        return 'OPEN';
      }

      if (state === 'HALF_OPEN') {
        return 'HALF_OPEN';
      }

      return 'CLOSED';
    } catch (err: any) {
      logger.warn({ err: err.message, endpointId }, 'Redis read error, defaulting state to CLOSED');
      return 'CLOSED';
    }
  }

  /**
   * Checks whether a request can be executed against this endpoint.
   * Returns true for CLOSED and HALF_OPEN (canary probe).
   * Returns false for OPEN (fast-fail without network blocking).
   */
  public async canExecute(endpointId: string): Promise<boolean> {
    const state = await this.getState(endpointId);
    return state !== 'OPEN';
  }

  /**
   * Records a successful delivery.
   * If circuit was in HALF_OPEN, resets state back to CLOSED and clears failure count.
   */
  public async recordSuccess(endpointId: string): Promise<void> {
    try {
      const state = await this.getState(endpointId);
      if (state === 'HALF_OPEN') {
        await Promise.all([
          redis.set(this.stateKey(endpointId), 'CLOSED'),
          redis.del(this.failuresKey(endpointId)),
          redis.del(this.openedAtKey(endpointId)),
        ]);
        logger.info({ endpointId }, 'Circuit breaker recovered and transitioned HALF_OPEN -> CLOSED');
      } else if (state === 'CLOSED') {
        // Clear any residual failure count
        await redis.del(this.failuresKey(endpointId));
      }
    } catch (err: any) {
      logger.warn({ err: err.message, endpointId }, 'Failed to record circuit breaker success in Redis');
    }
  }

  /**
   * Records a delivery failure (5xx server error, network timeout, or connection refusal).
   * Increments the failure counter with automatic TTL expiration.
   * If failure threshold is breached or if in HALF_OPEN, trips to OPEN state.
   */
  public async recordFailure(
    endpointId: string,
    details?: { statusCode?: number; isTimeout?: boolean; message?: string }
  ): Promise<CircuitState> {
    try {
      const currentState = await this.getState(endpointId);

      // If already in HALF_OPEN canary trial, a failure immediately re-trips back to OPEN
      if (currentState === 'HALF_OPEN') {
        const now = Date.now();
        await Promise.all([
          redis.set(this.stateKey(endpointId), 'OPEN'),
          redis.set(this.openedAtKey(endpointId), String(now)),
        ]);
        logger.warn({ endpointId, details }, 'Canary failed in HALF_OPEN; circuit re-tripped to OPEN');
        return 'OPEN';
      }

      // Increment failure count in rolling window
      const failuresKey = this.failuresKey(endpointId);
      const failures = await redis.incr(failuresKey);
      if (failures === 1) {
        // Set TTL on first failure in the window
        await redis.expire(failuresKey, this.windowSeconds);
      }

      logger.warn(
        { endpointId, failures, threshold: this.failureThreshold, details },
        `Webhook delivery failure recorded (${failures}/${this.failureThreshold})`
      );

      if (failures >= this.failureThreshold) {
        const now = Date.now();
        await Promise.all([
          redis.set(this.stateKey(endpointId), 'OPEN'),
          redis.set(this.openedAtKey(endpointId), String(now)),
        ]);
        logger.error(
          { endpointId, failures, cooldownSeconds: this.cooldownSeconds },
          `Circuit breaker tripped to OPEN after ${failures} consecutive failures within ${this.windowSeconds}s`
        );
        return 'OPEN';
      }

      return 'CLOSED';
    } catch (err: any) {
      logger.warn({ err: err.message, endpointId }, 'Failed to record circuit breaker failure in Redis');
      return 'CLOSED';
    }
  }

  /**
   * Executes an action protected by the circuit breaker.
   * Fast-fails immediately if the circuit is OPEN without executing fn.
   */
  public async execute<T>(endpointId: string, fn: () => Promise<T>): Promise<T> {
    const allowed = await this.canExecute(endpointId);
    if (!allowed) {
      throw new CircuitBreakerOpenError(endpointId);
    }

    try {
      const result = await fn();
      await this.recordSuccess(endpointId);
      return result;
    } catch (err: any) {
      await this.recordFailure(endpointId, {
        statusCode: err?.statusCode || err?.status,
        isTimeout: Boolean(err?.code === 'ETIMEDOUT' || err?.message?.includes('timeout')),
        message: err?.message,
      });
      throw err;
    }
  }

  /**
   * Force manually trips the circuit breaker to OPEN (e.g. for testing or administrative intervention).
   */
  public async trip(endpointId: string): Promise<void> {
    const now = Date.now();
    await Promise.all([
      redis.set(this.stateKey(endpointId), 'OPEN'),
      redis.set(this.openedAtKey(endpointId), String(now)),
    ]);
  }

  /**
   * Force manually resets the circuit breaker to CLOSED.
   */
  public async reset(endpointId: string): Promise<void> {
    await Promise.all([
      redis.set(this.stateKey(endpointId), 'CLOSED'),
      redis.del(this.failuresKey(endpointId)),
      redis.del(this.openedAtKey(endpointId)),
    ]);
  }

  /**
   * Gets a complete diagnostic snapshot for an endpoint.
   */
  public async getSnapshot(endpointId: string): Promise<CircuitBreakerSnapshot> {
    const state = await this.getState(endpointId);
    const failuresStr = await redis.get(this.failuresKey(endpointId));
    const openedAtStr = await redis.get(this.openedAtKey(endpointId));

    const failureCount = failuresStr ? parseInt(failuresStr, 10) : 0;
    const openedAt = openedAtStr ? parseInt(openedAtStr, 10) : null;

    let cooldownRemainingSeconds = 0;
    if (state === 'OPEN' && openedAt) {
      const elapsed = Math.floor((Date.now() - openedAt) / 1000);
      cooldownRemainingSeconds = Math.max(0, this.cooldownSeconds - elapsed);
    }

    return {
      endpointId,
      state,
      failureCount,
      openedAt,
      cooldownRemainingSeconds,
    };
  }
}

export const circuitBreaker = new RedisCircuitBreaker();
