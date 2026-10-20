import { prisma } from '../lib/prisma';

export interface CleanupResult {
  purgedWallets: number;
  purgedAt: Date;
}

export class CleanupWorker {
  /**
   * Purges soft-deleted wallet records older than retentionDays (default 30 days).
   * Executes off-peak cascade cleanup to prevent lock contention (#776).
   */
  async purgeExpiredSoftDeleted(retentionDays: number = 30): Promise<CleanupResult> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const result = await prisma.wallet.deleteMany({
      where: {
        deletedAt: {
          not: null,
          lt: cutoff,
        },
      },
    });

    return {
      purgedWallets: result.count,
      purgedAt: new Date(),
    };
  }
}

export const cleanupWorker = new CleanupWorker();
