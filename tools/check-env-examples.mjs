#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ENV_EXAMPLES = Object.freeze([
  Object.freeze({
    filePath: 'apps/api/.env.example',
    // Keep this list aligned with apps/api/src/config/env.ts and direct
    // process.env reads under apps/api/src.
    allowedKeys: Object.freeze([
      'ALERT_WORKER_CONCURRENCY',
      'ANCHOR_SEP31_AUTH_TOKEN',
      'DATABASE_URL',
      'DISCORD_PUBLIC_KEY',
      'EMAIL_FROM',
      'EXTERNAL_REQUEST_TIMEOUT_MS',
      'FLASH_LOAN_CONTRACT_IDS',
      'HORIZON_REQUEST_TIMEOUT_MS',
      'HORIZON_URL',
      'HORIZON_URL_NODE2',
      'HORIZON_URL_NODE3',
      'JWT_SECRET',
      'LOG_LEVEL',
      'MASTER_ENCRYPTION_KEY',
      'MASTER_ENCRYPTION_KEY_VERSION',
      'MASTER_ENCRYPTION_OLD_KEYS',
      'NODE_ENV',
      'NOTIFICATION_PROVIDER_TIMEOUT_MS',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_SERVICE_NAME',
      'PORT',
      'PROVIDER_RATE_BUDGET_DISCORD',
      'PROVIDER_RATE_BUDGET_EMAIL',
      'PROVIDER_RATE_BUDGET_SLACK',
      'PROVIDER_RATE_BUDGET_TELEGRAM',
      'PROVIDER_RATE_BUDGET_WEBHOOK',
      'PUSH_PROTOCOL_API_KEY',
      'PUSH_PROTOCOL_API_URL',
      'RATE_LIMIT_MAX',
      'READ_REPLICA_URL',
      'REDIS_HOST',
      'REDIS_PORT',
      'REDIS_REGION',
      'REDIS_SENTINELS',
      'REDIS_SENTINEL_MASTER_NAME',
      'REDIS_SENTINEL_PASSWORD',
      'REDIS_URL',
      'RESEND_API_KEY',
      'SERVICE_NAME',
      'SLACK_SIGNING_SECRET',
      'SOROBAN_BACKFILL_START_LEDGER',
      'SOROBAN_CONTRACT_ID',
      'SOROBAN_INDEXER_BACKFILL_WINDOW',
      'SOROBAN_INDEXER_BENCHMARK_DATA_ROWS',
      'SOROBAN_INDEXER_BENCHMARK_INTERVAL_MS',
      'SOROBAN_INDEXER_INTERVAL_MS',
      'SOROBAN_INDEXER_PAGE_SIZE',
      'SOROBAN_INDEXER_WORKER_ENABLED',
      'SOROBAN_RENT_MAX_CONCURRENCY',
      'SOROBAN_RENT_RENEWAL_THRESHOLD',
      'SOROBAN_RENT_TARGET_TTL',
      'SOROBAN_RENT_WORKER_ENABLED',
      'SOROBAN_RENT_WORKER_INTERVAL_MS',
      'SOROBAN_RENT_WORKER_SECRET',
      'SOROBAN_RPC_TIMEOUT_MS',
      'SOROBAN_RPC_URL',
      'SOROBAN_SAC_WORKER_ENABLED',
      'SOROBAN_STAKING_REWARD_WORKER_ENABLED',
      'STAKING_REWARD_CONTRACT_IDS',
      'START_WORKER',
      'STELLAR_NETWORK_PASSPHRASE',
      'TELEGRAM_BOT_TOKEN',
      'TSS_VERIFICATION_KEYS',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_WHATSAPP_FROM',
      'VITEST',
      'WALLET_BURST_ALLOWANCE',
      'WASM_ANALYZER_MAX_UPLOAD_BYTES',
      'WASM_ANALYZER_TIMEOUT_MS',
      'WATCHER_WALLET_CONCURRENCY',
      'WEBHOOK_BATCH_MAX_SIZE',
      'WEBHOOK_BATCH_WINDOW_MS',
      'WEBHOOK_TIMEOUT_MS',
    ]),
    requiredKeys: Object.freeze([
      'DATABASE_URL',
      'JWT_SECRET',
      'TELEGRAM_BOT_TOKEN',
      'REDIS_URL',
      'MASTER_ENCRYPTION_KEY',
    ]),
  }),
  Object.freeze({
    filePath: 'apps/web/.env.example',
    // Application reads under apps/web plus the Next.js lockfile escape hatch
    // consumed by the framework during install/build.
    allowedKeys: Object.freeze([
      'NEXTAUTH_SECRET',
      'NEXTAUTH_URL',
      'NEXT_IGNORE_INCORRECT_LOCKFILE',
      'NEXT_PUBLIC_API_BASE_URL',
      'NEXT_PUBLIC_API_URL',
      'NEXT_PUBLIC_HORIZON_URL',
      'NEXT_PUBLIC_YJS_WS_URL',
      'NODE_ENV',
    ]),
    requiredKeys: Object.freeze([
      'NEXTAUTH_URL',
      'NEXTAUTH_SECRET',
      'NEXT_PUBLIC_API_URL',
    ]),
  }),
]);

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Validate one environment example without retaining assignment values.
 *
 * @param {string} source
 * @param {{ filePath?: string, allowedKeys?: readonly string[], requiredKeys?: readonly string[] }} options
 * @returns {{ filePath: string, keys: string[], errors: Array<{ code: string, filePath: string, line?: number, key?: string }> }}
 */
export function validateEnvExample(
  source,
  { filePath = '<env-example>', allowedKeys, requiredKeys = [] } = {},
) {
  const errors = [];
  const keys = [];
  const firstLineByKey = new Map();
  const allowedKeySet = allowedKeys ? new Set(allowedKeys) : null;

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmedLine = lines[index].trim();

    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue;
    }

    const assignmentIndex = trimmedLine.indexOf('=');
    if (assignmentIndex === -1) {
      errors.push({ code: 'MALFORMED_ASSIGNMENT', filePath, line: lineNumber });
      continue;
    }

    const key = trimmedLine.slice(0, assignmentIndex).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      errors.push({ code: 'INVALID_KEY', filePath, line: lineNumber });
      continue;
    }

    keys.push(key);
    if (allowedKeySet && !allowedKeySet.has(key)) {
      errors.push({ code: 'UNKNOWN_KEY', filePath, line: lineNumber, key });
    }

    if (firstLineByKey.has(key)) {
      errors.push({ code: 'DUPLICATE_KEY', filePath, line: lineNumber, key });
      continue;
    }

    firstLineByKey.set(key, lineNumber);
  }

  for (const key of requiredKeys) {
    if (!firstLineByKey.has(key)) {
      errors.push({ code: 'MISSING_KEY', filePath, key });
    }
  }

  return { filePath, keys, errors };
}

/**
 * Render a validation error without including assignment values or source lines.
 *
 * @param {{ code: string, filePath: string, line?: number, key?: string }} error
 * @returns {string}
 */
export function formatValidationError(error) {
  const location = error.line ? `${error.filePath}:${error.line}` : error.filePath;

  switch (error.code) {
    case 'MALFORMED_ASSIGNMENT':
      return `${location}: malformed environment assignment`;
    case 'INVALID_KEY':
      return `${location}: invalid environment key name`;
    case 'DUPLICATE_KEY':
      return `${location}: duplicate environment key ${error.key}`;
    case 'UNKNOWN_KEY':
      return `${location}: unknown environment key ${error.key}`;
    case 'MISSING_KEY':
      return `${location}: missing required environment key ${error.key}`;
    case 'READ_ERROR':
      return `${location}: unable to read environment example`;
    default:
      return `${location}: environment example validation failed`;
  }
}

/**
 * Validate the documented environment examples beneath a repository root.
 *
 * @param {string} rootDir
 * @returns {Promise<Array<ReturnType<typeof validateEnvExample>>>}
 */
export async function validateEnvExamplesAtRoot(rootDir) {
  const results = [];

  for (const example of ENV_EXAMPLES) {
    const absolutePath = path.join(rootDir, example.filePath);
    try {
      const source = await readFile(absolutePath, 'utf8');
      results.push(validateEnvExample(source, example));
    } catch {
      results.push({
        filePath: example.filePath,
        keys: [],
        errors: [{ code: 'READ_ERROR', filePath: example.filePath }],
      });
    }
  }

  return results;
}

async function main() {
  const results = await validateEnvExamplesAtRoot(process.cwd());
  const errors = results.flatMap((result) => result.errors);

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(formatValidationError(error));
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${results.length} environment example files.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  await main();
}
