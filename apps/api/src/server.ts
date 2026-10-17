import { env } from './config/env';
import { buildApp } from './app';
import { prisma, connectWithRetry } from './lib/prisma';
import { startTelemetry, shutdownTelemetry } from './lib/telemetry';
import { closeRedisConnections } from './lib/redis';
import { createGrpcServer } from './modules/grpc/grpc.server';
import { createLogger } from './lib/logger';

const log = createLogger({ module: 'ApiServer' });

const start = async () => {
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

    const shutdown = async () => {
      log.info('Graceful shutdown initiated');
      setTimeout(() => {
        log.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 5000);

      try {
        grpcServer.stop();
      } catch (err) {
        console.error('Error stopping gRPC server:', err);
      }
      
      await app.close();
      await prisma.$disconnect();
      await shutdownTelemetry();
      await closeRedisConnections();
      log.info('✅ Server, Prisma, and Redis closed cleanly');
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
};

start();
