import { env } from './config/env';
import { buildApp } from './app';
import { prisma, connectWithRetry } from './lib/prisma';
import { startTelemetry, shutdownTelemetry } from './lib/telemetry';
import { closeRedisConnections } from './lib/redis';
import { createGrpcServer } from './modules/grpc/grpc.server';
import { createLogger } from './lib/logger';

const log = createLogger({ module: 'ApiServer' });

export interface ServerShutdownResources {
  app: { close: () => Promise<unknown> };
  prisma: { $disconnect: () => Promise<unknown> };
  grpcServer?: { stop: () => void };
  shutdownTelemetry?: () => Promise<unknown>;
  closeRedisConnections?: () => Promise<unknown>;
  exitFn?: (code: number) => void;
  timeoutMs?: number;
}

export function createGracefulShutdownHandler(resources: ServerShutdownResources) {
  let isShuttingDown = false;
  return async (signal = 'SIGTERM') => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const exit = resources.exitFn ?? process.exit;
    const timeoutMs = resources.timeoutMs ?? 5000;

    log.info(`Graceful shutdown initiated (${signal})`);
    const forceTimer = setTimeout(() => {
      log.error('Could not close connections in time, forcefully shutting down');
      exit(1);
    }, timeoutMs);
    if (typeof forceTimer.unref === 'function') {
      forceTimer.unref();
    }

    try {
      if (resources.grpcServer) {
        try {
          resources.grpcServer.stop();
        } catch (err) {
          console.error('Error stopping gRPC server:', err);
        }
      }

      await resources.app.close();
      await resources.prisma.$disconnect();
      if (resources.shutdownTelemetry) {
        await resources.shutdownTelemetry();
      }
      if (resources.closeRedisConnections) {
        await resources.closeRedisConnections();
      }
      clearTimeout(forceTimer);
      log.info('✅ Server, Prisma, and Redis closed cleanly');
      exit(0);
    } catch (err) {
      clearTimeout(forceTimer);
      log.error({ err }, 'Error during graceful shutdown');
      exit(1);
    }
  };
}

export const start = async () => {
  try {
    await connectWithRetry();
    await startTelemetry();
    const app = await buildApp();
    const port = parseInt(env.PORT, 10);

    await app.listen({ port, host: '0.0.0.0' });
    log.info({ port }, 'Server listening');

    const grpcServer = createGrpcServer(50051);
    grpcServer.start();

    if (process.env.START_WORKER !== 'false') {
      const { runWatcher } = await import('./workers/watcher.worker');
      runWatcher().catch((err) =>
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Watcher worker error')
      );
    }

    // Without a dedicated export worker, exports run in-process (see
    // lib/export-queue.ts), so expiry/cleanup has to run here too.
    if (env.EXPORT_WORKER_ENABLED !== 'true') {
      const { exportsService } = await import('./modules/exports/exports.service');
      const cleanupExports = () =>
        exportsService.cleanupExpiredExports().catch((err) => console.error('⚠️ Export cleanup error:', err));
      void cleanupExports();
      setInterval(cleanupExports, env.EXPORT_CLEANUP_INTERVAL_MS).unref();
    }

    const shutdown = createGracefulShutdownHandler({
      app,
      prisma,
      grpcServer,
      shutdownTelemetry,
      closeRedisConnections,
    });

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (err) {
    log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
};

if (require.main === module || (process.env.NODE_ENV !== 'test' && !process.env.VITEST)) {
  start();
}
