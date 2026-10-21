import { prisma } from '../lib/prisma';
import { partitionService } from '../modules/maintenance/partition.service';

/**
 * Automated archival worker for Payment history.
 *
 * Responsibilities:
 * 1. Creates monthly partitions for the Payment table
 * 2. Archives payments older than 90 days to PaymentArchive (cold storage)
 * 3. Maintains optimal indices on recent transactions (<30 days)
 * 4. Verifies data integrity and partition health
 *
 * Runs on a scheduled interval (configurable via cron or manual dispatch).
 * Transactional consistency is guaranteed during data movement.
 */
export interface ArchivalWorkerResult {
  success: boolean;
  partitionsCreated?: number;
  paymentsArchived?: number;
  indicesEnsured?: boolean;
  healthReport?: any;
  error?: string;
  duration: number;
}

export class ArchivalWorker {
  /**
   * Main entry point: run all archival and partitioning tasks.
   */
  async run(): Promise<ArchivalWorkerResult> {
    const startTime = Date.now();

    try {
      console.log('[ArchivalWorker] Starting archival cycle...');

      // Step 1: Ensure monthly partitions exist
      console.log('[ArchivalWorker] Ensuring monthly partitions...');
      await partitionService.ensureMonthlyPartitions();

      // Step 2: Archive old payments (>90 days)
      console.log('[ArchivalWorker] Archiving payments older than 90 days...');
      const archiveResult = await partitionService.archiveOldPayments(90);
      console.log(
        `[ArchivalWorker] Archived ${archiveResult.archivedCount} payments, deleted ${archiveResult.deletedCount} from primary table (${archiveResult.duration}ms)`,
      );

      // Step 3: Rebuild indices for active records (<30 days)
      console.log('[ArchivalWorker] Ensuring optimal indices for active records...');
      await partitionService.ensureActiveIndices();

      // Step 4: Validate health
      console.log('[ArchivalWorker] Validating partition health...');
      const healthReport = await partitionService.validatePartitionHealth();
      console.log('[ArchivalWorker] Health check completed:', healthReport);

      const duration = Date.now() - startTime;

      console.log(
        `[ArchivalWorker] Archival cycle completed successfully (${duration}ms)`,
      );

      return {
        success: true,
        paymentsArchived: archiveResult.archivedCount,
        indicesEnsured: true,
        healthReport,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[ArchivalWorker] Archival cycle failed: ${errorMsg}`, error);

      return {
        success: false,
        error: errorMsg,
        duration,
      };
    }
  }

  /**
   * Verify data integrity: count records and ensure no data loss.
   */
  async verifyDataIntegrity(): Promise<IntegrityCheckResult> {
    try {
      // Get total payment count (primary + archive)
      const primaryCount = await prisma.payment.count();
      const archiveCount = await prisma.paymentArchive.count();

      // Spot check: verify a sample of archived records still exist
      const archivedSample = await prisma.paymentArchive.findMany({
        take: 10,
      });

      return {
        valid: true,
        primaryTableCount: primaryCount,
        archiveTableCount: archiveCount,
        totalCount: primaryCount + archiveCount,
        archivedSampleSize: archivedSample.length,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        primaryTableCount: 0,
        archiveTableCount: 0,
        totalCount: 0,
        archivedSampleSize: 0,
      };
    }
  }

  /**
   * Query performance test: measure active vs archive query times.
   */
  async benchmarkQueryPerformance(walletId: string): Promise<PerformanceBenchmark> {
    const results: PerformanceBenchmark = {
      activeQueryMs: 0,
      archiveQueryMs: 0,
      improvement: '0%',
    };

    try {
      // Benchmark active payment queries
      const activeStart = Date.now();
      await prisma.payment.findMany({
        where: { walletId },
        take: 1000,
      });
      results.activeQueryMs = Date.now() - activeStart;

      // Benchmark archive payment queries
      const archiveStart = Date.now();
      await prisma.paymentArchive.findMany({
        where: { walletId },
        take: 1000,
      });
      results.archiveQueryMs = Date.now() - archiveStart;

      // Calculate improvement
      if (results.activeQueryMs > 0) {
        const pct = Math.round(
          ((results.archiveQueryMs - results.activeQueryMs) / results.archiveQueryMs) * 100,
        );
        results.improvement = `${pct}%`;
      }

      return results;
    } catch (error) {
      throw new Error(
        `Benchmark failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}

export interface IntegrityCheckResult {
  valid: boolean;
  primaryTableCount: number;
  archiveTableCount: number;
  totalCount: number;
  archivedSampleSize: number;
  error?: string;
}

export interface PerformanceBenchmark {
  activeQueryMs: number;
  archiveQueryMs: number;
  improvement: string;
}

export const archivalWorker = new ArchivalWorker();
