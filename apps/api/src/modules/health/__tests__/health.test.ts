import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../../../app';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that pull these modules
// ---------------------------------------------------------------------------

// Prevent env.ts from calling process.exit(1) when env vars are absent
vi.mock('../../../config/env', () => ({
  env: {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    TELEGRAM_BOT_TOKEN: 'test-token',
    JWT_SECRET: 'test-secret-key-for-health-tests',
    REDIS_URL: 'redis://localhost:6379',
    PORT: '3001',
    DEEP_HEALTH_TIMEOUT_MS: 50,
  },
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
  prismaRead: {},
  setReadTarget: vi.fn(),
}));

// BullMQ exposes `Queue.client` as a Promise, so the mock must match that
// shape to catch regressions where the client promise is not awaited.
const { redisClientMock } = vi.hoisted(() => ({
  redisClientMock: {
    ping: vi.fn().mockResolvedValue('PONG'),
  },
}));

vi.mock('../../../lib/queue', () => ({
  alertQueue: {
    client: Promise.resolve(redisClientMock),
  },
  dlqQueue: null,
  alertQueueEvents: null,
  alertWorker: null,
}));

vi.mock('../../../lib/soroban', () => ({
  sorobanServer: {
    getLatestLedger: vi.fn(),
  },
}));

// Stub out all route modules so buildApp doesn't need a real DB / auth setup
vi.mock('../../../modules/auth/auth.routes', () => ({ authRoutes: async () => {} }));
vi.mock('../../../modules/wallets/wallets.routes', () => ({ walletsRoutes: async () => {} }));
vi.mock('../../../modules/payments/payments.routes', () => ({ paymentsRoutes: async () => {} }));
vi.mock('../../../modules/webhooks/webhooks.routes', () => ({ webhooksRoutes: async () => {} }));
vi.mock('../../../modules/account/account.routes', () => ({ accountRoutes: async () => {} }));
vi.mock('../../../modules/soroban-state/soroban-state.routes', () => ({ sorobanStateRoutes: async () => {} }));
vi.mock('../../../modules/notifications/notifications.routes', () => ({ notificationsRoutes: async () => {} }));
vi.mock('../../../modules/alert-rules/alert-rules.routes', () => ({ alertRulesRoutes: async () => {} }));
vi.mock('../../../modules/dead-letters/dead-letters.routes', () => ({ deadLettersRoutes: async () => {} }));
vi.mock('../../../modules/discord-interactions', () => ({ discordInteractionsRoutes: async () => {} }));
vi.mock('../../../modules/slack/slack.routes', () => ({ slackRoutes: async () => {} }));
vi.mock('../../../modules/graphql/graphql.routes', () => ({ graphqlRoutes: async () => {} }));
vi.mock('../../../modules/exports/exports.routes', () => ({ exportsRoutes: async () => {} }));
vi.mock('../../../modules/simulation/simulation.routes', () => ({ simulationRoutes: async () => {} }));
vi.mock('../../../modules/admin/admin.routes', () => ({ adminRoutes: async () => {} }));
vi.mock('../../../modules/audit/audit.routes', () => ({ auditRoutes: async () => {} }));

// Stub the prisma Fastify plugin
vi.mock('../../../plugins/prisma', () => ({
  default: async () => {},
}));

// Avoid starting the DB failover background poller in unit tests.
vi.mock('../../../plugins/degraded-mode', () => ({
  default: async () => {},
}));

// ---------------------------------------------------------------------------
// Import mocked modules so we can control their behaviour per test
// ---------------------------------------------------------------------------
import { prisma } from '../../../lib/prisma';
import { sorobanServer } from '../../../lib/soroban';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildTestApp = async () => {
  const app = await buildApp();
  return app;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /health/deep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: All services healthy → 200 { status: 'ok', checks: all 'ok' }
  // -------------------------------------------------------------------------
  it('returns 200 with status ok when all services are healthy', async () => {
    (prisma.$queryRaw as any).mockResolvedValue([{ '?column?': 1 }]);
    (redisClientMock.ping as any).mockResolvedValue('PONG');
    (sorobanServer.getLatestLedger as any).mockResolvedValue({ sequence: 12345 });

    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health/deep' });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({
      postgres: 'ok',
      redis: 'ok',
      horizon: 'ok',
    });

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Test 2: PostgreSQL fails → 503 with postgres: 'error'
  // -------------------------------------------------------------------------
  it('returns 503 with postgres error when database is unreachable', async () => {
    (prisma.$queryRaw as any).mockRejectedValue(new Error('ECONNREFUSED 5432'));
    (redisClientMock.ping as any).mockResolvedValue('PONG');
    (sorobanServer.getLatestLedger as any).mockResolvedValue({ sequence: 12345 });

    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health/deep' });

    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.postgres).toBe('error');
    expect(body.checks.redis).toBe('ok');
    expect(body.checks.horizon).toBe('ok');

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Test 3: Redis fails → 503 with redis: 'error'
  // -------------------------------------------------------------------------
  it('returns 503 with redis error when Redis is unreachable', async () => {
    (prisma.$queryRaw as any).mockResolvedValue([{ '?column?': 1 }]);
    (redisClientMock.ping as any).mockRejectedValue(new Error('Redis connection refused'));
    (sorobanServer.getLatestLedger as any).mockResolvedValue({ sequence: 12345 });

    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health/deep' });

    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.postgres).toBe('ok');
    expect(body.checks.redis).toBe('error');
    expect(body.checks.horizon).toBe('ok');

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Test 4: Horizon/Soroban RPC fails → 503 with horizon: 'error'
  // -------------------------------------------------------------------------
  it('returns 503 with horizon error when Soroban RPC is unreachable', async () => {
    (prisma.$queryRaw as any).mockResolvedValue([{ '?column?': 1 }]);
    (redisClientMock.ping as any).mockResolvedValue('PONG');
    (sorobanServer.getLatestLedger as any).mockRejectedValue(new Error('Network timeout'));

    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health/deep' });

    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.postgres).toBe('ok');
    expect(body.checks.redis).toBe('ok');
    expect(body.checks.horizon).toBe('error');

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Test 5: All services fail → 503 with all checks showing 'error'
  // -------------------------------------------------------------------------
  it('returns 503 with all checks errored when every service is down', async () => {
    (prisma.$queryRaw as any).mockRejectedValue(new Error('DB unavailable'));
    (redisClientMock.ping as any).mockRejectedValue(new Error('Redis down'));
    (sorobanServer.getLatestLedger as any).mockRejectedValue(new Error('Horizon RPC down'));

    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health/deep' });

    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.status).toBe('degraded');
    expect(body.checks).toEqual({
      postgres: 'error',
      redis: 'error',
      horizon: 'error',
    });

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Test 6: Endpoint is accessible without authentication
  // -------------------------------------------------------------------------
  it('does not require an Authorization header', async () => {
    (prisma.$queryRaw as any).mockResolvedValue([{ '?column?': 1 }]);
    (redisClientMock.ping as any).mockResolvedValue('PONG');
    (sorobanServer.getLatestLedger as any).mockResolvedValue({ sequence: 99 });

    const app = await buildTestApp();

    // Send without any Authorization header — should not get a 401 or 403
    const response = await app.inject({
      method: 'GET',
      url: '/health/deep',
      // deliberately omitting headers
    });

    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(403);
    // Status is 200 when healthy
    expect(response.statusCode).toBe(200);

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Test 7: A dependency that hangs is bounded by the probe deadline
  // -------------------------------------------------------------------------
  it('returns 503 instead of hanging when a dependency stops responding', async () => {
    (prisma.$queryRaw as any).mockImplementation(() => new Promise(() => {}));
    (redisClientMock.ping as any).mockResolvedValue('PONG');
    (sorobanServer.getLatestLedger as any).mockResolvedValue({ sequence: 12345 });

    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health/deep' });

    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.status).toBe('degraded');
    expect(body.checks).toEqual({
      postgres: 'error',
      redis: 'ok',
      horizon: 'ok',
    });

    await app.close();
  });
});
