import { Command } from 'commander';
import chalk from 'chalk';
import {
  DEFAULT_MOCK_HORIZON_PORT,
  MockHorizonServer,
  parseRate,
  type MockHorizonOptions,
} from '../lib/mock-horizon.js';

interface SandboxOptions {
  host: string;
  port: string;
  rate: string;
  accounts: string;
  ledgerInterval: string;
  dropEvery?: string;
  dropDuration?: string;
  seed?: string;
}

export interface RunningSandbox {
  server: MockHorizonServer;
  /** Resolves once the server has fully stopped (after SIGINT/SIGTERM or `shutdown()`). */
  closed: Promise<void>;
  shutdown: () => Promise<void>;
}

function parseIntInRange(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}, got "${value}"`);
  }
  return parsed;
}

export function resolveSandboxOptions(options: SandboxOptions): MockHorizonOptions {
  let rate: number;
  try {
    rate = parseRate(options.rate);
  } catch (error) {
    throw new Error(`--rate: ${(error as Error).message}`);
  }
  return {
    host: options.host,
    port: parseIntInRange(options.port, '--port', 0, 65535),
    rate,
    accountCount: parseIntInRange(options.accounts, '--accounts', 2, 1000),
    ledgerIntervalMs: parseIntInRange(options.ledgerInterval, '--ledger-interval', 0, 3_600_000),
    dropEvery: parseIntInRange(options.dropEvery ?? '0', '--drop-every', 0, 1_000_000),
    dropDurationMs: parseIntInRange(options.dropDuration ?? '0', '--drop-duration', 0, 3_600_000),
    seed: options.seed === undefined ? undefined : parseIntInRange(options.seed, '--seed', 0, 0xffffffff),
  };
}

/**
 * Starts the sandbox and wires SIGINT/SIGTERM to a graceful stop. A second
 * signal while stopping exits immediately, matching `stream watch`.
 */
export async function startSandbox(options: MockHorizonOptions): Promise<RunningSandbox> {
  const server = new MockHorizonServer(options);
  await server.start();

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping ??= server.stop().finally(() => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolveClosed();
    });
    return stopping;
  };
  const onSignal = () => {
    if (stopping) process.exit(130);
    void shutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return { server, closed, shutdown };
}

export function registerSandboxCommands(program: Command): void {
  program
    .command('dev-sandbox')
    .description('Run an in-memory mock Horizon server that emits synthetic payments (offline testing)')
    .option('--host <host>', 'Interface to bind', '127.0.0.1')
    .option('-p, --port <number>', 'Port to listen on', String(DEFAULT_MOCK_HORIZON_PORT))
    .option('-r, --rate <rate>', 'Payment emission rate, e.g. 5/s, 0.5/s, 30/m (0 = none)', '1/s')
    .option('--accounts <number>', 'Number of synthetic accounts', '5')
    .option('--ledger-interval <ms>', 'Milliseconds between synthetic ledger closes (0 = never)', '5000')
    .option('--drop-every <n>', 'Abruptly sever all streams after every N payments (simulated network drop)')
    .option('--drop-duration <ms>', 'Refuse new streams with 503 for this long after a drop', '0')
    .option('--seed <number>', 'Seed for reproducible payment data')
    .action(async (options: SandboxOptions) => {
      try {
        const resolved = resolveSandboxOptions(options);
        const sandbox = await startSandbox(resolved);
        const { server } = sandbox;
        const { rate, dropEvery } = resolved;

        console.log(chalk.bold.blue('\n🏖  Stellar Alerts mock Horizon sandbox\n'));
        console.log(`  Listening on ${chalk.green(server.url)}`);
        console.log(chalk.gray(`  Emitting ${rate}/s across ${server.accountIds.length} accounts`));
        if (dropEvery) console.log(chalk.yellow(`  Simulating a network drop after every ${dropEvery} payments`));
        console.log(chalk.gray('\n  GET /payments  /accounts/:id  /accounts/:id/payments  /ledgers  (JSON or SSE)'));
        console.log(chalk.gray('  GET /payments/stream  (NDJSON, for `stream watch`)'));
        console.log(chalk.gray(`\n  Try: stellar-alerts-cli --api-url ${server.url} stream watch --no-resume`));
        console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

        await sandbox.closed;
        console.log(chalk.yellow('⏹  Sandbox stopped.'));
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        const message = err.code === 'EADDRINUSE' ? `port ${options.port} is already in use` : err.message;
        console.error(chalk.red(`❌ Error: ${message}`));
        process.exitCode = 1;
      }
    });
}
