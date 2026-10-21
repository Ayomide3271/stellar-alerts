import { PrismaClient } from '../../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';
import { resolvePoolConfig, PoolConfig } from './db-pool';

export const DEFAULT_PRISMA_CONNECTION_LIMIT = 50;
export const DEFAULT_PRISMA_POOL_TIMEOUT_SECONDS = 15;

export interface DatabasePoolUrlOptions {
  connectionLimit?: number;
  poolTimeout?: number;
  idleTimeout?: number;
}

/**
 * Ensures `connection_limit` and `pool_timeout` are present in a PostgreSQL
 * connection URL so the Prisma connection pool can absorb high-concurrency
 * watcher bursts (50+ concurrent queries) without exhausting connections.
 * Existing query parameters on `databaseUrl` are preserved unless explicitly
 * overridden in `options`.
 */
export function buildPooledDatabaseUrl(
  databaseUrl: string,
  options: DatabasePoolUrlOptions = {}
): string {
  const url = new URL(databaseUrl);
  const params = url.searchParams;

  if (options.connectionLimit !== undefined) {
    params.set('connection_limit', String(options.connectionLimit));
  } else if (!params.has('connection_limit')) {
    params.set('connection_limit', String(DEFAULT_PRISMA_CONNECTION_LIMIT));
  }

  if (options.poolTimeout !== undefined) {
    params.set('pool_timeout', String(options.poolTimeout));
  } else if (!params.has('pool_timeout')) {
    params.set('pool_timeout', String(DEFAULT_PRISMA_POOL_TIMEOUT_SECONDS));
  }

  if (options.idleTimeout !== undefined) {
    params.set('idle_timeout', String(options.idleTimeout));
  }

  return url.toString();
}

let primaryPoolConfig: PoolConfig | null = null;
let replicaPoolConfig: PoolConfig | null = null;

function createClient(databaseUrl: string, label: string) {
  const pooledUrl = buildPooledDatabaseUrl(databaseUrl);
  const config = resolvePoolConfig(pooledUrl);
  if (label.startsWith('primary')) {
    primaryPoolConfig = config;
  } else if (label === 'replica') {
    replicaPoolConfig = config;
  }
  console.log(
    `[Prisma] ${label} pool: max=${config.max} connections, acquire timeout=${config.connectionTimeoutMillis}ms, idle timeout=${config.idleTimeoutMillis}ms`
  );

  return new PrismaClient({ adapter: new PrismaPg(config) });
}

export function getPrimaryPoolConfig(): PoolConfig | null {
  return primaryPoolConfig;
}

export function getReplicaPoolConfig(): PoolConfig | null {
  return replicaPoolConfig;
}

const primaryUrl = env.DATABASE_URL || process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/stellar_alerts';
const replicaUrl = env.READ_REPLICA_URL || process.env.READ_REPLICA_URL;

let primaryClient = createClient(primaryUrl, 'primary');

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const value = (primaryClient as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(primaryClient);
    }
    return value;
  },
});

/**
 * Client for read-only queries. Points at READ_REPLICA_URL when a read
 * replica is configured and falls back to the primary otherwise, so callers can
 * use it unconditionally.
 */
export const prismaRead = replicaUrl ? createClient(replicaUrl, 'replica') : prisma;
export const replicaPrisma = prismaRead;

export type DatabaseTarget = 'PRIMARY' | 'REPLICA';

export let activeReadTarget: DatabaseTarget = 'REPLICA';

export function setReadTarget(target: DatabaseTarget): void {
  activeReadTarget = target;
  console.log(`[DB Pool Engine] 🔀 Read traffic target updated to: ${target}`);
}

export function getReadTarget(): DatabaseTarget {
  return activeReadTarget;
}

export function getReadClient() {
  return activeReadTarget === 'PRIMARY' ? prisma : prismaRead;
}

export async function switchDatabaseUrl(newUrl: string): Promise<void> {
  console.log(`[Prisma] Switching database URL to: ${newUrl}`);
  process.env.DATABASE_URL = newUrl;
  setReadTarget('PRIMARY');

  try {
    await primaryClient.$disconnect();
  } catch {
    // Pool may not be connected during DR drills or unit tests.
  }

  primaryClient = createClient(newUrl, 'primary-promoted');

  if (process.env.VITEST !== 'true') {
    await primaryClient.$connect();
  }
}

export async function connectWithRetry() {
  await prisma.$connect();
}

/**
 * Executes a batch of watcher queries concurrently against the read client
 * (read replica when configured, primary otherwise), bounded by the configured
 * connection pool limit so bursts of 50+ concurrent watcher queries never
 * exhaust PostgreSQL connections.
 */
export async function executeConcurrentWatcherQueries<T>(
  tasks: Array<(client: PrismaClient) => Promise<T>>,
  maxConcurrency: number = primaryPoolConfig?.max ?? DEFAULT_PRISMA_CONNECTION_LIMIT
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const limit = Math.max(1, maxConcurrency);
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;
  const client = getReadClient();

  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      results[idx] = await tasks[idx](client);
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

