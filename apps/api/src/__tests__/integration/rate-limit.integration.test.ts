/**
 * Integration test for Issue #563: Add Request Rate Limiting Middleware (@fastify/rate-limit)
 *
 * Verifies that:
 *  - The @fastify/rate-limit plugin is registered globally on the Fastify app
 *  - Requests within the limit (≤100 req/min) receive normal responses
 *  - The 101st request in the same time window receives HTTP 429
 *  - The HTTP 429 response includes a `Retry-After` header
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any imports that validate env / connect to DB
// ---------------------------------------------------------------------------

vi.mock('../../config/env', () => ({
  env: {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    JWT_SECRET: 'test-secret-key-for-rate-limit-tests',
    REDIS_URL: 'redis://localhost:6379',
    PORT: '3001',
    // Use the default 100 req/min limit — matching production behaviour
    RATE_LIMIT_MAX: 100,
    WASM_ANALYZER_MAX_UPLOAD_BYTES: 5242880,
    MASTER_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    MASTER_ENCRYPTION_KEY_VERSION: '1',
    MASTER_ENCRYPTION_OLD_KEYS: '{}',
    SOROBAN_RENT_WORKER_ENABLED: 'false',
    SOROBAN_INDEXER_WORKER_ENABLED: 'false',
  },
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    $connect: vi.fn(),
  },
}));

vi.mock('../../lib/queue', () => ({
  alertQueue: {
    client: Promise.resolve({ ping: vi.fn().mockResolvedValue('PONG') }),
  },
  dlqQueue: null,
  alertQueueEvents: null,
  alertWorker: null,
}));

vi.mock('../../lib/soroban', () => ({
  sorobanServer: {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 12345 }),
  },
}));

// Stub all route modules so buildApp does not require a live DB/Redis/auth setup
vi.mock('../../modules/auth/auth.routes', () => ({ authRoutes: async () => {} }));
vi.mock('../../modules/wallets/wallets.routes', () => ({ walletsRoutes: async () => {} }));
vi.mock('../../modules/payments/payments.routes', () => ({ paymentsRoutes: async () => {} }));
vi.mock('../../modules/webhooks/webhooks.routes', () => ({ webhooksRoutes: async () => {} }));
vi.mock('../../modules/account/account.routes', () => ({ accountRoutes: async () => {} }));
vi.mock('../../modules/notifications/notifications.routes', () => ({ notificationsRoutes: async () => {} }));
vi.mock('../../modules/alert-rules/alert-rules.routes', () => ({ alertRulesRoutes: async () => {} }));
vi.mock('../../modules/dead-letters/dead-letters.routes', () => ({ deadLettersRoutes: async () => {} }));
vi.mock('../../modules/discord-interactions', () => ({ discordInteractionsRoutes: async () => {} }));
vi.mock('../../modules/slack/slack.routes', () => ({ slackRoutes: async () => {} }));
vi.mock('../../modules/graphql/graphql.routes', () => ({ graphqlRoutes: async () => {} }));
vi.mock('../../modules/exports/exports.routes', () => ({ exportsRoutes: async () => {} }));
vi.mock('../../modules/simulation/simulation.routes', () => ({ simulationRoutes: async () => {} }));
vi.mock('../../modules/admin/admin.routes', () => ({ adminRoutes: async () => {} }));
vi.mock('../../modules/soroban-state/soroban-state.routes', () => ({ sorobanStateRoutes: async () => {} }));

// Stub Fastify plugins that require live infrastructure
vi.mock('../../plugins/prisma', () => ({ default: async () => {} }));
vi.mock('../../plugins/metrics', () => ({ default: async () => {} }));
vi.mock('../../plugins/degraded-mode', () => ({ default: async () => {} }));
vi.mock('../../plugins/websocket', () => ({ registerSSEPushPlugin: async () => {} }));

// ---------------------------------------------------------------------------
// Import buildApp after mocks are established
// ---------------------------------------------------------------------------
import { buildApp } from '../../app';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh Fastify instance for each test so the rate-limit counter
 * starts at zero. Using Fastify's `app.inject()` keeps everything in-process
 * without spinning up a real TCP socket.
 */
async function buildTestApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests — Issue #563
// ---------------------------------------------------------------------------

describe('Rate Limiting Middleware — Issue #563 (@fastify/rate-limit)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Test 1: requests within the limit succeed
  // -------------------------------------------------------------------------
  it('allows the first 100 requests within the time window', async () => {
    // Send the first request and verify it resolves normally (not rate-limited)
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  // -------------------------------------------------------------------------
  // Test 2: 101st request receives HTTP 429 with Retry-After header
  // Acceptance criteria from issue:
  //   ✅ Exceeding rate limit returns HTTP 429
  //   ✅ Retry-After header included in response
  // -------------------------------------------------------------------------
  it('returns HTTP 429 with Retry-After header after 101 requests in the same window', async () => {
    const RATE_LIMIT = 100;
    const TOTAL_REQUESTS = RATE_LIMIT + 1; // 101

    let lastResponse: Awaited<ReturnType<typeof app.inject>> | null = null;

    // Fire all 101 requests sequentially against the same app instance
    // so they share the same in-memory rate-limit counter for this time window
    for (let i = 0; i < TOTAL_REQUESTS; i++) {
      lastResponse = await app.inject({
        method: 'GET',
        url: '/health',
      });
    }

    // The 101st response must be rate-limited
    expect(lastResponse!.statusCode).toBe(429);

    // Retry-After header must be present (value is in seconds as a string)
    const retryAfter = lastResponse!.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    // The value should be a positive numeric string representing seconds until reset
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: First 100 requests all succeed (none are rate-limited)
  // -------------------------------------------------------------------------
  it('does not rate-limit the first 100 requests in a window', async () => {
    const RATE_LIMIT = 100;
    const statuses: number[] = [];

    for (let i = 0; i < RATE_LIMIT; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      statuses.push(res.statusCode);
    }

    // Every one of the first 100 requests should succeed (200)
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: Response body on 429 follows the expected error shape
  // -------------------------------------------------------------------------
  it('returns a structured error body on HTTP 429', async () => {
    const TOTAL_REQUESTS = 101;

    let lastResponse: Awaited<ReturnType<typeof app.inject>> | null = null;
    for (let i = 0; i < TOTAL_REQUESTS; i++) {
      lastResponse = await app.inject({ method: 'GET', url: '/health' });
    }

    expect(lastResponse!.statusCode).toBe(429);

    // @fastify/rate-limit sets statusCode and message in the body
    const body = lastResponse!.json();
    expect(body).toHaveProperty('statusCode', 429);
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('message');
  });
});
