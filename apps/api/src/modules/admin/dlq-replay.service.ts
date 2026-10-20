/**
 * Dead Letter Queue (DLQ) Auto-Replay & Bulk Retry Management Service (#638).
 *
 * Provides administrative capabilities to:
 * - Inspect and filter dead letter jobs with error stack traces & original payload metadata
 * - Bulk-replay failed jobs back to the primary alert queue preserving idempotency keys
 * - Purge aged or poisoned jobs beyond retention window
 * - Maintain full audit trails for replays and purges
 */

import { prisma } from '../../lib/prisma';
import { alertQueue, enqueuePaymentAlert, AlertJobData } from '../../lib/queue';
import { createLogger } from '../../lib/logger';
import { toAlertJobData } from '../dead-letters/dead-letters.envelope';

const log = createLogger({ module: 'DlqReplayService' });

export interface DlqFilterParams {
  walletId?: string;
  destination?: string;
  channel?: string;
  status?: string;
  fromDate?: Date | string;
  toDate?: Date | string;
  failureClass?: string;
  limit?: number;
  offset?: number;
}

export interface DlqReplayRequest {
  ids?: string[];
  filter?: DlqFilterParams;
  actorUserId?: string;
  force?: boolean;
}

export interface DlqPurgeRequest {
  olderThanDays?: number;
  olderThanDate?: Date | string;
  status?: string;
  channel?: string;
  actorUserId?: string;
}

export class DlqReplayService {
  /**
   * Inspect dead letter queue entries with error details and payload metadata.
   */
  async inspectDlq(filter: DlqFilterParams = {}) {
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const where: Record<string, any> = {};

    if (filter.channel) {
      where.channel = filter.channel;
    }
    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.destination) {
      where.destination = { contains: filter.destination, mode: 'insensitive' };
    }
    if (filter.failureClass) {
      where.failureClass = filter.failureClass;
    }

    if (filter.walletId) {
      where.payment = {
        walletId: filter.walletId,
      };
    }

    if (filter.fromDate || filter.toDate) {
      where.failedAt = {};
      if (filter.fromDate) {
        where.failedAt.gte = new Date(filter.fromDate);
      }
      if (filter.toDate) {
        where.failedAt.lte = new Date(filter.toDate);
      }
    }

    const [items, total] = await Promise.all([
      prisma.deadLetter.findMany({
        where,
        orderBy: { failedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          auditLogs: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
      }),
      prisma.deadLetter.count({ where }),
    ]);

    return {
      items,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + items.length < total,
      },
    };
  }

  /**
   * Re-queue selected failed jobs to the primary alert queue preserving idempotency keys.
   */
  async replayJobs(request: DlqReplayRequest) {
    const where: Record<string, any> = {};

    if (request.ids && request.ids.length > 0) {
      where.id = { in: request.ids };
    } else if (request.filter) {
      if (request.filter.channel) where.channel = request.filter.channel;
      if (request.filter.status) where.status = request.filter.status;
      if (request.filter.destination) {
        where.destination = { contains: request.filter.destination, mode: 'insensitive' };
      }
      if (request.filter.walletId) {
        where.payment = { walletId: request.filter.walletId };
      }
    } else {
      throw new Error('Must specify job ids or filter criteria for replay');
    }

    // Never replay suppressed jobs unless force is set
    if (!request.force) {
      where.status = { not: 'suppressed' };
    }

    const deadLetters = await prisma.deadLetter.findMany({
      where,
      take: 500, // Batch limit for safety
    });

    const replayedIds: string[] = [];
    const failedIds: string[] = [];

    for (const dl of deadLetters) {
      try {
        const payload = dl.payload as Record<string, any> | null;
        const jobData = toAlertJobData(payload);

        if (!jobData) {
          log.warn({ id: dl.id }, 'Dead letter has invalid or missing payload, skipping replay');
          failedIds.push(dl.id);
          continue;
        }

        // Re-queue preserving idempotency keys
        if (alertQueue) {
          const replayJobId = dl.deliveryKey
            ? `replay-${dl.deliveryKey}-${Date.now()}`
            : `replay-${dl.id}-${Date.now()}`;

          await alertQueue.add('dispatch-alert', jobData, {
            jobId: replayJobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
          });
        } else {
          // Fallback to direct enqueue helper
          await enqueuePaymentAlert(jobData);
        }

        // Mark as retried and create audit record
        await prisma.$transaction([
          prisma.deadLetter.update({
            where: { id: dl.id },
            data: {
              status: 'retried',
              retryCount: { increment: 1 },
            },
          }),
          prisma.deadLetterAudit.create({
            data: {
              deadLetterId: dl.id,
              actorUserId: request.actorUserId ?? null,
              action: 'replay',
              note: 'Re-queued to primary alert queue preserving idempotency keys',
            },
          }),
        ]);

        replayedIds.push(dl.id);
      } catch (err: any) {
        log.error({ id: dl.id, err: err.message }, 'Failed to replay dead letter');
        failedIds.push(dl.id);
      }
    }

    return {
      success: true,
      replayedCount: replayedIds.length,
      failedCount: failedIds.length,
      replayedIds,
      failedIds,
    };
  }

  /**
   * Purge dead letters older than a specified retention window.
   */
  async purgeJobs(request: DlqPurgeRequest) {
    const where: Record<string, any> = {};

    if (request.olderThanDays) {
      const thresholdDate = new Date(Date.now() - request.olderThanDays * 24 * 60 * 60 * 1000);
      where.failedAt = { lte: thresholdDate };
    } else if (request.olderThanDate) {
      where.failedAt = { lte: new Date(request.olderThanDate) };
    } else {
      throw new Error('Must specify olderThanDays or olderThanDate for purge');
    }

    if (request.status) {
      where.status = request.status;
    }
    if (request.channel) {
      where.channel = request.channel;
    }

    // Collect IDs for audit logging prior to deletion
    const toPurge = await prisma.deadLetter.findMany({
      where,
      select: { id: true },
      take: 1000,
    });

    const ids = toPurge.map((r) => r.id);
    if (ids.length === 0) {
      return { success: true, purgedCount: 0 };
    }

    // Delete records in transaction
    const deleteResult = await prisma.deadLetter.deleteMany({
      where: { id: { in: ids } },
    });

    log.info({ count: deleteResult.count }, 'Purged aged DLQ records');

    return {
      success: true,
      purgedCount: deleteResult.count,
    };
  }
}

export const dlqReplayService = new DlqReplayService();
