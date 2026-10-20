import { Command } from 'commander';
import chalk from 'chalk';

export interface ClusterStatus {
  apiStatus: 'healthy' | 'degraded' | 'offline';
  databaseStatus: 'connected' | 'error' | 'unknown';
  redisStatus: 'connected' | 'error' | 'unknown';
  activeWatchers: number;
  latencyMs: number;
}

/**
 * Probes the backend cluster and parses health / metrics status.
 */
export async function probeClusterStatus(
  apiUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<ClusterStatus> {
  const start = Date.now();
  let apiStatus: 'healthy' | 'degraded' | 'offline' = 'offline';
  let databaseStatus: 'connected' | 'error' | 'unknown' = 'unknown';
  let redisStatus: 'connected' | 'error' | 'unknown' = 'unknown';
  let activeWatchers = 0;

  try {
    const healthRes = await fetchFn(`${apiUrl}/health`);
    if (!healthRes.ok) {
      return {
        apiStatus: 'degraded',
        databaseStatus: 'unknown',
        redisStatus: 'unknown',
        activeWatchers: 0,
        latencyMs: Date.now() - start,
      };
    }
    const healthData: any = await healthRes.json();
    apiStatus = healthData.status === 'ok' || healthData.status === 'healthy' ? 'healthy' : 'degraded';
    if (healthData.services) {
      databaseStatus = healthData.services.database === 'up' ? 'connected' : 'error';
      redisStatus = healthData.services.redis === 'up' ? 'connected' : 'error';
    } else {
      databaseStatus = 'connected';
      redisStatus = 'connected';
    }
  } catch {
    return {
      apiStatus: 'offline',
      databaseStatus: 'error',
      redisStatus: 'error',
      activeWatchers: 0,
      latencyMs: Date.now() - start,
    };
  }

  try {
    const metricsRes = await fetchFn(`${apiUrl}/metrics/summary`);
    if (metricsRes.ok) {
      const metricsData: any = await metricsRes.json();
      activeWatchers = metricsData.activeWatchers ?? metricsData.watchersCount ?? 0;
    }
  } catch {
    // Non-fatal if metrics summary endpoint is unavailable
  }

  return {
    apiStatus,
    databaseStatus,
    redisStatus,
    activeWatchers,
    latencyMs: Date.now() - start,
  };
}

export function formatClusterStatusTable(status: ClusterStatus): string {
  const statusColor =
    status.apiStatus === 'healthy'
      ? chalk.green('HEALTHY')
      : status.apiStatus === 'degraded'
      ? chalk.yellow('DEGRADED')
      : chalk.red('OFFLINE');

  const dbColor =
    status.databaseStatus === 'connected'
      ? chalk.green('CONNECTED')
      : chalk.red(status.databaseStatus.toUpperCase());

  const redisColor =
    status.redisStatus === 'connected'
      ? chalk.green('CONNECTED')
      : chalk.red(status.redisStatus.toUpperCase());

  return `
┌────────────────────────────────────────────────────────┐
│             Stellar Alerts Cluster Status              │
├────────────────────────┬───────────────────────────────┤
│ API Health             │ ${statusColor.padEnd(30)}│
│ Database Connection    │ ${dbColor.padEnd(30)}│
│ Redis Ingestion Queue  │ ${redisColor.padEnd(30)}│
│ Active Watcher Streams │ ${chalk.cyan(String(status.activeWatchers)).padEnd(30)}│
│ Round-trip Latency     │ ${chalk.gray(`${status.latencyMs}ms`).padEnd(30)}│
└────────────────────────┴───────────────────────────────┘
`;
}

export function registerStatusCommands(program: Command) {
  program
    .command('status')
    .description('Probe cluster health, database connection, Redis stream, and active watchers (#774)')
    .option('--api-url <url>', 'Backend API URL to probe', process.env.STELLAR_ALERTS_API_URL || 'http://localhost:3000')
    .action(async (options) => {
      console.log(chalk.blue(`Probing cluster at ${options.apiUrl}...`));
      const status = await probeClusterStatus(options.apiUrl);
      console.log(formatClusterStatusTable(status));

      if (status.apiStatus === 'offline' || status.apiStatus === 'degraded') {
        process.exitCode = 1;
      }
    });
}
