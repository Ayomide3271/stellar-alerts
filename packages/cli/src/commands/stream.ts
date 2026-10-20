import { Command } from 'commander';
import chalk from 'chalk';
import { render } from 'ink';
import { ApiClient } from '../lib/api.js';
import { PaymentDTO } from '../lib/types.js';
import { resolveAuth } from '../lib/auth.js';
import { CursorStore, defaultCursorFile } from '../lib/cursor-store.js';
import { runResilientStream } from '../lib/resilient-stream.js';
import StreamTui, { type StreamTuiAction } from '../tui/stream-tui.js';

interface WatchOptions {
  wallet?: string;
  token?: string;
  color?: boolean;
  cursor?: string;
  cursorFile?: string;
  resume?: boolean;
  maxRetries?: string;
  maxBackoff?: string;
  tui?: boolean;
}

function warn(message: string): void {
  console.warn(chalk.yellow(`⚠  ${message}`));
}

/** Returns undefined when unset, null (after reporting) when invalid. */
function parseNonNegativeInt(value: string | undefined, flag: string): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(chalk.red(`❌ ${flag} must be a non-negative integer, got "${value}"`));
    return null;
  }
  return parsed;
}

function formatPayment(payment: PaymentDTO): string {
  const time = new Date(payment.receivedAt).toLocaleTimeString();
  const amount = chalk.bold.green(`+${payment.amount}`);
  const asset = chalk.cyan(payment.asset);
  const from = chalk.gray(payment.fromAddress.slice(0, 12) + '...' + payment.fromAddress.slice(-4));
  const memo = payment.memo ? chalk.yellow(` [${payment.memo}]`) : '';

  return `${chalk.gray(time)} │ ${amount.padStart(15)} ${asset.padEnd(8)} │ ${from}${memo}`;
}

function printHeader(): void {
  console.log(chalk.bold.blue('\n🌊 Stellar Payment Stream\n'));
  console.log(chalk.gray('─'.repeat(80)));
  console.log(
    chalk.bold(
      'Time'.padEnd(12) +
      '│ ' +
      'Amount'.padEnd(15) +
      'Asset'.padEnd(10) +
      '│ From'.padEnd(25) +
      'Memo'
    )
  );
  console.log(chalk.gray('─'.repeat(80)));
}

export function registerStreamCommands(program: Command): void {
  const stream = program
    .command('stream')
    .description('Watch real-time payment streams');

  stream
    .command('watch')
    .description('Watch real-time payment feed')
    .option('-w, --wallet <walletId>', 'Filter by specific wallet ID')
    .option('-t, --token <token>', 'API authentication token (overrides profile)')
    .option('--no-color', 'Disable colored output')
    .option('--cursor <token>', 'Resume after this cursor ("now" = live tail, ignore saved cursor)')
    .option('--cursor-file <path>', 'Where the resume cursor is stored (default: ~/.stellar-alerts/stream-cursor[-<wallet>].json)')
    .option('--no-resume', 'Do not read or write the saved cursor')
    .option('--max-retries <number>', 'Consecutive reconnect attempts before giving up (default: unlimited)')
    .option('--max-backoff <ms>', 'Upper bound for the reconnect delay in milliseconds', '60000')
    .option('--tui', 'Enable interactive Terminal UI (TUI) mode')
    .action(async (options: WatchOptions) => {
      const abortController = new AbortController();
      const onSigInt = () => {
        if (abortController.signal.aborted) {
          // Second signal: the user wants out now.
          process.exit(130);
        }
        abortController.abort();
      };
      const onSigTerm = () => {
        if (abortController.signal.aborted) {
          // Second signal: the user wants out now.
          process.exit(130);
        }
        abortController.abort();
      };

      process.on('SIGINT', onSigInt);
      process.on('SIGTERM', onSigTerm);

      try {
        const auth = resolveAuth(options.token, program.opts().apiUrl);
        const client = new ApiClient(auth.apiUrl, auth.token);

        const maxRetries = parseNonNegativeInt(options.maxRetries, '--max-retries');
        const maxDelayMs = parseNonNegativeInt(options.maxBackoff, '--max-backoff');
        if (maxRetries === null || maxDelayMs === null) {
          process.exitCode = 1;
          return;
        }

        const store = options.resume === false
          ? undefined
          : new CursorStore(options.cursorFile ?? defaultCursorFile(options.wallet), warn);
        const initialCursor = options.cursor === undefined ? undefined : options.cursor === 'now' ? '' : options.cursor;

        // TUI Mode
        if (options.tui) {
          // For now, TUI mode is a separate command that can be launched
          // Full integration with the stream would require passing dispatch function
          console.log(chalk.yellow('TUI mode is available as a standalone feature.'));
          console.log(chalk.gray('To launch the TUI dashboard separately, use: stellar-alerts-cli tui'));
          console.log(chalk.gray('Full stream integration coming soon.'));
          return;
        }

        // Default text mode
        printHeader();
        console.log(chalk.gray('Connecting to payment stream...'));

        const result = await runResilientStream({
          connect: (cursor, signal) =>
            client.openPaymentStream({ cursor: cursor || undefined, walletId: options.wallet, signal }),
          onPayment: (payment: PaymentDTO) => {
            console.log(formatPayment(payment));
          },
          signal: abortController.signal,
          store,
          initialCursor,
          maxRetries: maxRetries ?? Infinity,
          maxDelayMs: maxDelayMs ?? undefined,
          onConnected: (cursor) => {
            console.log(chalk.gray(cursor ? `Connected (resuming after ${cursor}).` : 'Connected (live).'));
          },
          onReconnect: ({ attempt, delayMs, error }) => {
            console.log(
              chalk.yellow(`⚠  Stream interrupted (${(error as Error)?.message ?? error}); reconnecting in ${(delayMs / 1000).toFixed(1)}s [attempt ${attempt}]`)
            );
          },
          onWarning: warn,
        });

        console.log(chalk.yellow('\n⏹  Stream stopped.'));
        console.log(chalk.gray(`Total payments received: ${result.received}`));
        if (result.suppressed > 0) {
          console.log(chalk.gray(`Duplicates suppressed: ${result.suppressed}`));
        }
      } catch (error) {
        console.error(chalk.red(`\n❌ Error: ${(error as Error).message}`));
        process.exitCode = 1;
      } finally {
        process.off('SIGINT', onSigInt);
        process.off('SIGTERM', onSigTerm);
      }
    });

  stream
    .command('history')
    .description('Show recent payment history')
    .option('-w, --wallet <walletId>', 'Filter by specific wallet ID')
    .option('-l, --limit <number>', 'Number of payments to show', '20')
    .option('-t, --token <token>', 'API authentication token (overrides profile)')
    .action(async (options: { wallet?: string; limit?: string; token?: string }) => {
      try {
        const auth = resolveAuth(options.token, program.opts().apiUrl);
        const client = new ApiClient(auth.apiUrl, auth.token);

        const limit = parseInt(options.limit || '20', 10);
        const payments = await client.getPayments(options.wallet, limit);

        if (payments.length === 0) {
          console.log(chalk.yellow('📭 No payments found.'));
          return;
        }

        console.log(chalk.blue(`\n📜 Recent Payments (${payments.length})\n`));
        printHeader();

        for (const payment of payments) {
          console.log(formatPayment(payment));
        }

        console.log(chalk.gray('─'.repeat(80)));
        console.log('');
      } catch (error) {
        console.error(chalk.red(`❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}
