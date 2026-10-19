import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGracefulShutdownHandler } from '../server';
import { createWatcherShutdownHandler } from '../workers/watcher.worker';
import { WorkerLifecycleManager } from '../lib/worker-lifecycle';

describe('Issue #536: Graceful Process Shutdown Handler for API and Watcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  describe('API Server Graceful Shutdown', () => {
    it('closes Fastify, Prisma, Redis, and telemetry within 5s and exits with code 0 on SIGTERM', async () => {
      const mockApp = { close: vi.fn().mockResolvedValue(undefined) };
      const mockPrisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };
      const mockGrpc = { stop: vi.fn() };
      const mockShutdownTelemetry = vi.fn().mockResolvedValue(undefined);
      const mockCloseRedis = vi.fn().mockResolvedValue(undefined);
      const mockExit = vi.fn();

      const shutdown = createGracefulShutdownHandler({
        app: mockApp,
        prisma: mockPrisma,
        grpcServer: mockGrpc,
        shutdownTelemetry: mockShutdownTelemetry,
        closeRedisConnections: mockCloseRedis,
        exitFn: mockExit,
        timeoutMs: 5000,
      });

      const shutdownPromise = shutdown('SIGTERM');
      await vi.runAllTimersAsync();
      await shutdownPromise;

      expect(mockGrpc.stop).toHaveBeenCalledTimes(1);
      expect(mockApp.close).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$disconnect).toHaveBeenCalledTimes(1);
      expect(mockShutdownTelemetry).toHaveBeenCalledTimes(1);
      expect(mockCloseRedis).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(0);
      expect(mockExit).not.toHaveBeenCalledWith(1);
    });

    it('forces process exit with code 1 if API server connections do not close within 5s', async () => {
      const hangingApp = {
        close: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      };
      const mockPrisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };
      const mockExit = vi.fn();

      const shutdown = createGracefulShutdownHandler({
        app: hangingApp,
        prisma: mockPrisma,
        exitFn: mockExit,
        timeoutMs: 5000,
      });

      void shutdown('SIGTERM');

      // Advance timers by 5s (5000ms)
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('Watcher Worker Graceful Shutdown', () => {
    it('clears intervals, drains tasks, disconnects Prisma, and exits with code 0 within 5s', async () => {
      const lifecycle = new WorkerLifecycleManager({
        workerName: 'TestWatcher',
        drainTimeoutMs: 5000,
      });
      const drainSpy = vi.spyOn(lifecycle, 'drainAndShutdown');
      const mockPrisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };
      const mockExit = vi.fn();
      const mockTimer = setInterval(() => {}, 1000);

      const shutdown = createWatcherShutdownHandler({
        watcherLifecycle: lifecycle,
        prisma: mockPrisma,
        watcherIntervalId: mockTimer,
        exitFn: mockExit,
        timeoutMs: 5000,
      });

      const shutdownPromise = shutdown('SIGTERM');
      await vi.runAllTimersAsync();
      await shutdownPromise;

      expect(drainSpy).toHaveBeenCalledWith('SIGTERM');
      expect(mockPrisma.$disconnect).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(0);
      expect(mockExit).not.toHaveBeenCalledWith(1);
    });

    it('forces process exit with code 1 if watcher shutdown hangs past 5s', async () => {
      const hangingLifecycle = {
        drainAndShutdown: vi.fn().mockImplementation(() => new Promise(() => {})),
      } as any;
      const mockPrisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };
      const mockExit = vi.fn();

      const shutdown = createWatcherShutdownHandler({
        watcherLifecycle: hangingLifecycle,
        prisma: mockPrisma,
        exitFn: mockExit,
        timeoutMs: 5000,
      });

      void shutdown('SIGTERM');

      await vi.advanceTimersByTimeAsync(5000);

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
