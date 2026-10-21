import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  READ_REPLICA_URL: z.string().url().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  // Signs Slack slash-command requests (see modules/slack). Optional so the
  // API stays bootable without the Slack app configured; the /slack/commands
  // route fails closed (503) when it is missing.
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),
  REDIS_URL: z.string().url(),
  REDIS_SENTINELS: z.string().optional(),
  REDIS_SENTINEL_ADDRESSES: z.string().optional(),
  REDIS_SENTINEL_MASTER_NAME: z.string().optional().default("mymaster"),
  REDIS_SENTINEL_PASSWORD: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  PORT: z.string().optional().default("3001"),
  // Comma-separated browser origins allowed to send cookie-authenticated mutations.
  CSRF_ALLOWED_ORIGINS: z.string().optional().default("http://localhost:3000"),
  MASTER_ENCRYPTION_KEY: z
    .string()
    .min(32)
    .describe("Master key for encrypting webhook secrets (AES-256-GCM)"),
  MASTER_ENCRYPTION_KEY_VERSION: z.string().optional().default("1"),
  MASTER_ENCRYPTION_OLD_KEYS: z.string().optional().default("{}"),
  // Discord application public key used to verify interaction webhooks
  // (acknowledge / snooze / re-route buttons on alert messages). Unset disables
  // the /integrations/discord/interactions route.
  DISCORD_PUBLIC_KEY: z.string().optional(),
  // Requests/minute allowed per client before @fastify/rate-limit responds 429.
  // Overridable so load-test runs (k6, etc.) can measure real server capacity
  // instead of hitting the rate limiter almost immediately.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().optional().default(100),
  WORKER_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .default(5),
  SOROBAN_RENT_WORKER_ENABLED: z.string().optional().default("true"),
  SOROBAN_RENT_WORKER_INTERVAL_MS: z.string().optional().default("60000"),
  SOROBAN_RENT_WORKER_SECRET: z.string().optional(),
  SOROBAN_RENT_RENEWAL_THRESHOLD: z.string().optional().default("5000"),
  SOROBAN_RENT_TARGET_TTL: z.string().optional().default("10000"),
  SOROBAN_RENT_MAX_CONCURRENCY: z.string().optional().default("5"),
  SOROBAN_INDEXER_WORKER_ENABLED: z.string().optional().default("true"),
  SOROBAN_INDEXER_INTERVAL_MS: z.string().optional().default("15000"),
  SOROBAN_INDEXER_BACKFILL_WINDOW: z.string().optional().default("200"),
  SOROBAN_INDEXER_PAGE_SIZE: z.string().optional().default("200"),
  SOROBAN_INDEXER_BENCHMARK_INTERVAL_MS: z
    .string()
    .optional()
    .default("3600000"),
  SOROBAN_INDEXER_BENCHMARK_DATA_ROWS: z.string().optional().default("10000"),
  SOROBAN_STAKING_REWARD_WORKER_ENABLED: z.string().optional().default("true"),
  SOROBAN_SAC_WORKER_ENABLED: z.string().optional().default("true"),
  // Restoration sentinel (#1005): detects evicted contract instance/code keys
  // and prices restoration before invocation fails.
  SOROBAN_RESTORATION_WORKER_ENABLED: z.string().optional().default("true"),
  SOROBAN_RESTORATION_WORKER_INTERVAL_MS: z
    .string()
    .optional()
    .default("60000"),
  SOROBAN_RESTORATION_WARNING_LEDGERS: z.string().optional().default("17280"),
  SOROBAN_RESTORATION_CRITICAL_LEDGERS: z.string().optional().default("1000"),
  SOROBAN_RESTORATION_MIN_RESTORE_LEDGERS: z
    .string()
    .optional()
    .default("4096"),
  // Impermanent loss watcher (#1007).
  IL_WATCHER_INTERVAL_MS: z.string().optional().default("60000"),
  IL_WATCHER_DEFAULT_THRESHOLD_PCT: z.string().optional().default("5"),
  // Multi-sig signer inactivity / key-weight-decay watcher (#1008).
  MULTISIG_INACTIVITY_WORKER_ENABLED: z.string().optional().default("true"),
  MULTISIG_INACTIVITY_INTERVAL_MS: z.string().optional().default("3600000"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .optional()
    .default("http://localhost:4318/v1/traces"),
  OTEL_SERVICE_NAME: z.string().optional().default("stellar-alerts-api"),
  // Workers register their own tracer so Jaeger can attribute webhook dispatch
  // spans to the dispatcher rather than to the API service.
  OTEL_WORKER_SERVICE_NAME: z
    .string()
    .optional()
    .default("stellar-alerts-webhook-dispatcher"),
  // Optional bearer token for /metrics endpoint authentication in production
  METRICS_AUTH_TOKEN: z.string().optional(),
  // Opt-in Prometheus scrape port for worker processes. Unset by default, in
  // which case no listener is opened.
  WORKER_METRICS_PORT: z.coerce.number().int().positive().optional(),
  // Provider timeouts & deadlines (#303)
  EXTERNAL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(10000),
  HORIZON_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(10000),
  SOROBAN_RPC_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(15000),
  NOTIFICATION_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(8000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(10000),
  // Replay defense for signed webhook / API-webhook requests (#718):
  // maximum allowed |now - request timestamp| drift, and the Redis TTL for
  // one-time nonce consumption.
  WEBHOOK_REPLAY_DRIFT_TOLERANCE_MS: z.coerce.number().int().positive().optional().default(30000),
  WEBHOOK_REPLAY_NONCE_TTL_SECONDS: z.coerce.number().int().positive().optional().default(300),
  // Notification batching (#719): coalesce per-target webhook notifications
  // into one JSON-array POST. The window is clamped to 1-10s at runtime.
  WEBHOOK_BATCH_WINDOW_MS: z.coerce.number().int().positive().optional().default(5000),
  WEBHOOK_BATCH_MAX_SIZE: z.coerce.number().int().positive().optional().default(100),
  // Worker concurrency and fairness rate budgets (#309)
  ALERT_WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(5),
  WATCHER_WALLET_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(5),
  PROVIDER_RATE_BUDGET_TELEGRAM: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(30),
  PROVIDER_RATE_BUDGET_DISCORD: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(30),
  PROVIDER_RATE_BUDGET_SLACK: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(20),
  PROVIDER_RATE_BUDGET_WEBHOOK: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(50),
  PROVIDER_RATE_BUDGET_EMAIL: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(10),
  WALLET_BURST_ALLOWANCE: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(20),
  // Wasm contract upload/analysis limits for the wasm-analyzer module.
  WASM_ANALYZER_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(5 * 1024 * 1024),
  WASM_ANALYZER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(5000),
  // Asynchronous export jobs (#321)
  EXPORT_WORKER_ENABLED: z.string().optional().default("true"),
  // Directory for generated export files; empty = <os tmpdir>/stellar-alerts-exports.
  EXPORT_STORAGE_DIR: z.string().optional().default(""),
  // How long a finished export stays downloadable before cleanup deletes it.
  EXPORT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(86400),
  // Lifetime of each signed download URL handed out by GET /exports/:id.
  EXPORT_DOWNLOAD_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(300),
  EXPORT_MAX_ROWS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(100000),
  EXPORT_BATCH_SIZE: z.coerce.number().int().positive().optional().default(500),
  EXPORT_MAX_ACTIVE_JOBS_PER_USER: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(3),
  EXPORT_WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(2),
  EXPORT_CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(600000),
  // A job stuck in `running` longer than this (e.g. worker crash) is failed.
  EXPORT_STALE_JOB_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(1800000),
  // ── Pre-execution simulation engine ──────────────────────────────────────
  // Thresholds for the envelope risk engine (apps/api/src/services/simulation).
  // Each maps to one rule family, so tuning a detection never requires a code
  // change; see docs/simulation.md for what each threshold gates.
  /** Outflow/pre-balance ratio at/above which an asset counts as drained. */
  SIMULATION_NEAR_TOTAL_OUTFLOW_RATIO: z.coerce
    .number()
    .positive()
    .max(1)
    .optional()
    .default(0.85),
  /** Distinct destinations in one envelope that count as a fan-out. */
  SIMULATION_FAN_OUT_DESTINATION_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(3),
  /** Outgoing transfers from one source that count as a burst. */
  SIMULATION_SEQUENTIAL_TRANSFER_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(8),
  /** Declared read-write footprint keys above this are flagged as unbounded growth. */
  SIMULATION_MAX_FOOTPRINT_READ_WRITE_KEYS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(64),
  /** Distinct contracts spanned by a footprint that count as key probing. */
  SIMULATION_FOOTPRINT_PROBE_CONTRACT_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(5),
  /** Invocations of one contract in one envelope that count as fan-out. */
  SIMULATION_MAX_INVOCATIONS_PER_CONTRACT: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(5),
  /** Threat score at/above which a result is reported as block-recommended. */
  SIMULATION_RISK_BLOCK_THRESHOLD: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .default(80),
  /**
   * Amounts at/below this (in stroops) are treated as dust by the drain
   * detector. Default 10 stroops == 0.000001 units.
   */
  SIMULATION_DUST_AMOUNT_STROOPS: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .default(10),
});
export type Env = z.infer<typeof envSchema>;

const defaultEnvFallback: Env = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/stellar_alerts",
  READ_REPLICA_URL: undefined,
  TELEGRAM_BOT_TOKEN: "dummy-telegram-bot-token",
  JWT_SECRET: "dummy-jwt-secret-key-12345",
  REDIS_URL: "redis://localhost:6379",
  REDIS_SENTINELS: undefined,
  REDIS_SENTINEL_ADDRESSES: undefined,
  REDIS_SENTINEL_MASTER_NAME: "mymaster",
  REDIS_SENTINEL_PASSWORD: undefined,
  REDIS_PASSWORD: undefined,
  PORT: "3001",
  MASTER_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  MASTER_ENCRYPTION_KEY_VERSION: "1",
  MASTER_ENCRYPTION_OLD_KEYS: "{}",
  RATE_LIMIT_MAX: 100,
  SOROBAN_RENT_WORKER_ENABLED: "true",
  SOROBAN_RENT_WORKER_INTERVAL_MS: "60000",
  SOROBAN_RENT_WORKER_SECRET: undefined,
  SOROBAN_RENT_RENEWAL_THRESHOLD: "5000",
  SOROBAN_RENT_TARGET_TTL: "10000",
  SOROBAN_RENT_MAX_CONCURRENCY: "5",
  SOROBAN_INDEXER_WORKER_ENABLED: "true",
  SOROBAN_INDEXER_INTERVAL_MS: "15000",
  SOROBAN_INDEXER_BACKFILL_WINDOW: "200",
  SOROBAN_INDEXER_PAGE_SIZE: "200",
  SOROBAN_INDEXER_BENCHMARK_INTERVAL_MS: "3600000",
  SOROBAN_INDEXER_BENCHMARK_DATA_ROWS: "10000",
  SOROBAN_STAKING_REWARD_WORKER_ENABLED: "true",
  SOROBAN_SAC_WORKER_ENABLED: "true",
  WEBHOOK_REPLAY_DRIFT_TOLERANCE_MS: 30000,
  WEBHOOK_REPLAY_NONCE_TTL_SECONDS: 300,
  WEBHOOK_BATCH_WINDOW_MS: 5000,
  WEBHOOK_BATCH_MAX_SIZE: 100,
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/v1/traces",
  OTEL_SERVICE_NAME: "stellar-alerts-api",
};

const parseEnv = (): Env => {
  const envInput = {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ||
      (process.env.NODE_ENV === "test" || process.env.VITEST
        ? "postgresql://postgres:postgres@localhost:5432/stellar_alerts"
        : undefined),
    TELEGRAM_BOT_TOKEN:
      process.env.TELEGRAM_BOT_TOKEN ||
      (process.env.NODE_ENV === "test" || process.env.VITEST
        ? "dummy-telegram-bot-token"
        : undefined),
    JWT_SECRET:
      process.env.JWT_SECRET ||
      (process.env.NODE_ENV === "test" || process.env.VITEST
        ? "dummy-jwt-secret-key-12345"
        : undefined),
    SLACK_SIGNING_SECRET:
      process.env.SLACK_SIGNING_SECRET ||
      (process.env.NODE_ENV === "test" || process.env.VITEST
        ? "test-slack-signing-secret"
        : undefined),
    REDIS_URL:
      process.env.REDIS_URL ||
      (process.env.NODE_ENV === "test" || process.env.VITEST
        ? "redis://localhost:6379"
        : undefined),
    MASTER_ENCRYPTION_KEY:
      process.env.MASTER_ENCRYPTION_KEY ||
      (process.env.NODE_ENV === "test" || process.env.VITEST
        ? "0123456789abcdef0123456789abcdef"
        : undefined),
    MASTER_ENCRYPTION_KEY_VERSION:
      process.env.MASTER_ENCRYPTION_KEY_VERSION || "1",
    MASTER_ENCRYPTION_OLD_KEYS: process.env.MASTER_ENCRYPTION_OLD_KEYS || "{}",
    REDIS_SENTINELS:
      process.env.REDIS_SENTINELS || process.env.REDIS_SENTINEL_ADDRESSES,
    REDIS_SENTINEL_ADDRESSES:
      process.env.REDIS_SENTINEL_ADDRESSES || process.env.REDIS_SENTINELS,
    REDIS_SENTINEL_MASTER_NAME:
      process.env.REDIS_SENTINEL_MASTER_NAME || "mymaster",
    REDIS_SENTINEL_PASSWORD: process.env.REDIS_SENTINEL_PASSWORD,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD,
    SOROBAN_RENT_WORKER_ENABLED:
      process.env.SOROBAN_RENT_WORKER_ENABLED || "true",
    SOROBAN_RENT_WORKER_INTERVAL_MS:
      process.env.SOROBAN_RENT_WORKER_INTERVAL_MS || "60000",
    SOROBAN_RENT_WORKER_SECRET: process.env.SOROBAN_RENT_WORKER_SECRET,
    SOROBAN_RENT_RENEWAL_THRESHOLD:
      process.env.SOROBAN_RENT_RENEWAL_THRESHOLD || "5000",
    SOROBAN_RENT_TARGET_TTL: process.env.SOROBAN_RENT_TARGET_TTL || "10000",
    SOROBAN_RENT_MAX_CONCURRENCY:
      process.env.SOROBAN_RENT_MAX_CONCURRENCY || "5",
    SOROBAN_INDEXER_WORKER_ENABLED:
      process.env.SOROBAN_INDEXER_WORKER_ENABLED || "true",
    SOROBAN_INDEXER_INTERVAL_MS:
      process.env.SOROBAN_INDEXER_INTERVAL_MS || "15000",
    SOROBAN_INDEXER_BACKFILL_WINDOW:
      process.env.SOROBAN_INDEXER_BACKFILL_WINDOW || "200",
    SOROBAN_INDEXER_PAGE_SIZE: process.env.SOROBAN_INDEXER_PAGE_SIZE || "200",
    SOROBAN_INDEXER_BENCHMARK_INTERVAL_MS: process.env.SOROBAN_INDEXER_BENCHMARK_INTERVAL_MS || "3600000",
    SOROBAN_INDEXER_BENCHMARK_DATA_ROWS: process.env.SOROBAN_INDEXER_BENCHMARK_DATA_ROWS || "10000",
    SOROBAN_STAKING_REWARD_WORKER_ENABLED: process.env.SOROBAN_STAKING_REWARD_WORKER_ENABLED || "true",
    SOROBAN_SAC_WORKER_ENABLED: process.env.SOROBAN_SAC_WORKER_ENABLED || "true",
    WEBHOOK_REPLAY_DRIFT_TOLERANCE_MS: process.env.WEBHOOK_REPLAY_DRIFT_TOLERANCE_MS || "30000",
    WEBHOOK_REPLAY_NONCE_TTL_SECONDS: process.env.WEBHOOK_REPLAY_NONCE_TTL_SECONDS || "300",
    WEBHOOK_BATCH_WINDOW_MS: process.env.WEBHOOK_BATCH_WINDOW_MS || "5000",
    WEBHOOK_BATCH_MAX_SIZE: process.env.WEBHOOK_BATCH_MAX_SIZE || "100",
    SOROBAN_RESTORATION_WORKER_ENABLED: process.env.SOROBAN_RESTORATION_WORKER_ENABLED || "true",
    SOROBAN_RESTORATION_WORKER_INTERVAL_MS: process.env.SOROBAN_RESTORATION_WORKER_INTERVAL_MS || "60000",
    SOROBAN_RESTORATION_WARNING_LEDGERS: process.env.SOROBAN_RESTORATION_WARNING_LEDGERS || "17280",
    SOROBAN_RESTORATION_CRITICAL_LEDGERS: process.env.SOROBAN_RESTORATION_CRITICAL_LEDGERS || "1000",
    SOROBAN_RESTORATION_MIN_RESTORE_LEDGERS: process.env.SOROBAN_RESTORATION_MIN_RESTORE_LEDGERS || "4096",
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || "stellar-alerts-api",
  };

  const isProd = process.env.NODE_ENV === "production";
  const isTest = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);

  // In production, reject known placeholder / insecure secrets fail-fast
  if (isProd) {
    const insecureKeys: string[] = [];
    const insecureDefaults = [
      "dummy-jwt-secret-key-12345",
      "0123456789abcdef0123456789abcdef",
      "dummy-telegram-bot-token",
    ];
    for (const [k, v] of Object.entries(envInput)) {
      if (typeof v === "string" && insecureDefaults.includes(v)) {
        insecureKeys.push(k);
      }
    }
    if (insecureKeys.length > 0) {
      const msg = `[Config] ❌ FATAL: Insecure default credentials detected in production: ${insecureKeys.join(", ")}. Server cannot start with placeholder secrets.`;
      console.error(msg);
      if (!isTest) {
        process.exit(1);
      }
      throw new Error(msg);
    }
  }

  const parsed = envSchema.safeParse(envInput);

  if (!parsed.success) {
    console.error("❌ Invalid environment variables:", parsed.error.format());
    if (isProd || (!isTest && process.env.NODE_ENV !== "development")) {
      process.exit(1);
    }
    // Return a typed fallback matching Env so downstream code has consistent shape
    return defaultEnvFallback;
  }

  return parsed.data || defaultEnvFallback;
};

export const env = parseEnv();
