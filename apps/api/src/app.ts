import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { z } from "zod";
import { randomUUID } from "crypto";
import prismaPlugin from "./plugins/prisma";
import { registerSSEPushPlugin } from "./plugins/websocket";
import { prisma } from "./lib/prisma";
import { alertQueue } from "./lib/queue";
import { sorobanServer } from "./lib/soroban";
import { authRoutes } from "./modules/auth/auth.routes";
import { walletsRoutes } from "./modules/wallets/wallets.routes";
import { paymentsRoutes } from "./modules/payments/payments.routes";
import { webhooksRoutes } from "./modules/webhooks/webhooks.routes";
import { accountRoutes } from "./modules/account/account.routes";
import { registerSecurityHeaders } from "./middleware/security.middleware";
import { registerCorrelation } from "./middleware/correlation.middleware";
import { sorobanStateRoutes } from "./modules/soroban-state/soroban-state.routes";
import { notificationsRoutes } from "./modules/notifications/notifications.routes";
import { alertRulesRoutes } from "./modules/alert-rules/alert-rules.routes";
import { deadLettersRoutes } from "./modules/dead-letters/dead-letters.routes";
import { discordInteractionsRoutes } from "./modules/discord-interactions";
import { slackRoutes } from "./modules/slack/slack.routes";
import { graphqlRoutes } from "./modules/graphql/graphql.routes";
import { exportsRoutes } from "./modules/exports/exports.routes";
import { simulationRoutes } from "./modules/simulation/simulation.routes";
import { adminRoutes } from "./modules/admin/admin.routes";
import { auditRoutes } from "./modules/audit/audit.routes";
import { openApiOptions } from "./openapi.config";
import { loggerOptions } from "./lib/logger";
import { env } from "./config/env";
import metricsPlugin from "./plugins/metrics";

import { checkRedisReadiness, getRedisStatus } from "./lib/redis";
import { dbFailover } from "./lib/db-failover";
import degradedModePlugin from "./plugins/degraded-mode";
import { AppError } from "./lib/errors";

export { openApiComponentSchemas, openApiOptions } from "./openapi.config";

export const buildApp = async () => {
  // Issue #19: Correlation IDs — read x-request-id header or generate a UUID
  const app = Fastify({
    logger: loggerOptions,
    requestIdLogLabel: "requestId",
    pluginTimeout: 30000,
    requestIdHeader: "x-request-id",
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      if (incoming) {
        return Array.isArray(incoming) ? incoming[0] : incoming;
      }
      return randomUUID();
    },
  });

  await app.register(cors, {
    origin: true, // Allow all origins for dev, or specify 'http://localhost:3000'
  });

  // Issue #567: correlation IDs — attach x-request-id to every request's
  // logger so all log lines include a stable reqId for tracing.
  // Called directly (not via app.register) so the hooks are global rather
  // than scoped to a plugin encapsulation boundary.
  await registerCorrelation(app);
  await registerSecurityHeaders(app);

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
  });

  await app.register(multipart, {
    limits: {
      // Per-file cap; the wasm-analyzer route additionally enforces
      // env.WASM_ANALYZER_MAX_UPLOAD_BYTES per request via request.file().
      fileSize: env.WASM_ANALYZER_MAX_UPLOAD_BYTES,
      files: 1,
    },
  });

  await app.register(swagger, openApiOptions);

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  await app.register(prismaPlugin);
  await app.register(metricsPlugin);
  await app.register(degradedModePlugin);

  // Issue #64: SSE push endpoint — GET /events
  await app.register(registerSSEPushPlugin);

  app.get("/health", async () => {
    return { status: "ok" };
  });

  // Issue #18: Deep Health Inspection Probe — no authentication required
  app.get("/health/deep", async (_req, reply) => {
    const checks: {
      postgres: "ok" | "error";
      redis: "ok" | "error";
      horizon: "ok" | "error";
    } = {
      postgres: "error",
      redis: "error",
      horizon: "error",
    };

    // PostgreSQL ping
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = "ok";
    } catch {
      // leave as 'error'
    }

    // Redis ping via BullMQ queue's underlying ioredis client
    try {
      if (alertQueue && alertQueue.client) {
        const redisClient = await alertQueue.client;
        await (redisClient as any).ping();
        checks.redis = "ok";
      }
    } catch {
      // leave as 'error'
    }

    // Horizon / Soroban RPC ping
    try {
      await sorobanServer.getLatestLedger();
      checks.horizon = "ok";
    } catch {
      // leave as 'error'
    }

    const allOk =
      checks.postgres === "ok" &&
      checks.redis === "ok" &&
      checks.horizon === "ok";
    const status = allOk ? "ok" : "degraded";
    const statusCode = allOk ? 200 : 503;

    return reply.code(statusCode).send({ status, checks });
  });

  app.register(authRoutes);
  app.register(walletsRoutes);
  app.register(paymentsRoutes);
  app.register(webhooksRoutes);
  app.register(accountRoutes);
  app.register(notificationsRoutes);
  app.register(alertRulesRoutes);
  app.register(deadLettersRoutes);
  app.register(slackRoutes);
  await app.register(graphqlRoutes);
  app.register(exportsRoutes);
  app.register(simulationRoutes);
  app.register(discordInteractionsRoutes);
  app.register(adminRoutes);
  app.register(auditRoutes);

  return app;
};
