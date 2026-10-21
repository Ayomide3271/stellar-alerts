import { describe, it, expect, vi } from 'vitest';
import {
  buildPooledDatabaseUrl,
  DEFAULT_PRISMA_CONNECTION_LIMIT,
  DEFAULT_PRISMA_POOL_TIMEOUT_SECONDS,
  getPrimaryPoolConfig,
  executeConcurrentWatcherQueries,
  getReadClient,
  setReadTarget,
  prisma,
  prismaRead,
} from '../prisma';
import { resolvePoolConfig } from '../db-pool';

describe('Prisma Connection Pooling & Concurrent Watcher Load (#527)', () => {
  it('injects default connection_limit=50 and pool_timeout=15 into DATABASE_URL', () => {
    const rawUrl = 'postgresql://postgres:postgres@localhost:5432/stellar_alerts?schema=public';
    const pooledUrl = buildPooledDatabaseUrl(rawUrl);
    const parsed = new URL(pooledUrl);

    expect(parsed.searchParams.get('connection_limit')).toBe(
      String(DEFAULT_PRISMA_CONNECTION_LIMIT)
    );
    expect(parsed.searchParams.get('pool_timeout')).toBe(
      String(DEFAULT_PRISMA_POOL_TIMEOUT_SECONDS)
    );
    expect(parsed.searchParams.get('schema')).toBe('public');

    const poolConfig = resolvePoolConfig(pooledUrl);
    expect(poolConfig.max).toBe(50);
    expect(poolConfig.connectionTimeoutMillis).toBe(15_000);
  });

  it('preserves explicit connection_limit and pool_timeout already set in DATABASE_URL', () => {
    const customUrl =
      'postgresql://postgres:postgres@localhost:5432/stellar_alerts?connection_limit=75&pool_timeout=20';
    const pooledUrl = buildPooledDatabaseUrl(customUrl);
    const poolConfig = resolvePoolConfig(pooledUrl);

    expect(poolConfig.max).toBe(75);
    expect(poolConfig.connectionTimeoutMillis).toBe(20_000);
  });

  it('configures primary Prisma client pool with max >= 50 connections', () => {
    const primaryConfig = getPrimaryPoolConfig();
    expect(primaryConfig).not.toBeNull();
    expect(primaryConfig!.max).toBeGreaterThanOrEqual(50);
  });

  it('routes read queries via getReadClient() and switches target dynamically', () => {
    setReadTarget('REPLICA');
    expect(getReadClient()).toBe(prismaRead);

    setReadTarget('PRIMARY');
    expect(getReadClient()).toBe(prisma);

    // Restore default
    setReadTarget('REPLICA');
  });

  it('handles 50 concurrent watcher queries without connection exhaustion', async () => {
    let activeConnections = 0;
    let peakConnections = 0;
    const maxPoolSize = 50;

    const tasks = Array.from({ length: 50 }, (_, index) => {
      return vi.fn(async () => {
        activeConnections++;
        peakConnections = Math.max(peakConnections, activeConnections);
        if (activeConnections > maxPoolSize) {
          throw new Error(`Pool exhausted: ${activeConnections} > ${maxPoolSize}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeConnections--;
        return { walletId: `wallet-${index}`, paymentsChecked: index + 1 };
      });
    });

    const results = await executeConcurrentWatcherQueries(tasks, maxPoolSize);

    expect(results).toHaveLength(50);
    expect(peakConnections).toBeLessThanOrEqual(maxPoolSize);
    expect(peakConnections).toBeGreaterThan(1);
    expect(results[0]).toEqual({ walletId: 'wallet-0', paymentsChecked: 1 });
    expect(results[49]).toEqual({ walletId: 'wallet-49', paymentsChecked: 50 });
  });

  it('queues bursts exceeding 50 concurrent watcher queries without dropping or failing', async () => {
    let activeConnections = 0;
    let peakConnections = 0;
    const maxPoolSize = 50;

    const tasks = Array.from({ length: 80 }, (_, index) => {
      return async () => {
        activeConnections++;
        peakConnections = Math.max(peakConnections, activeConnections);
        if (activeConnections > maxPoolSize) {
          throw new Error(`Pool limit exceeded: ${activeConnections}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeConnections--;
        return index;
      };
    });

    const results = await executeConcurrentWatcherQueries(tasks, maxPoolSize);

    expect(results).toHaveLength(80);
    expect(peakConnections).toBeLessThanOrEqual(maxPoolSize);
    expect(results[79]).toBe(79);
  });
});
