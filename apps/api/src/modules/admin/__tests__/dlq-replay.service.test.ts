import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dlqReplayService } from '../dlq-replay.service';

const mockPrisma = vi.hoisted(() => ({
  deadLetter: {
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  deadLetterAudit: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const mockAlertQueue = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue({ id: 'job-123' }),
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../../lib/queue', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../lib/queue')>();
  return {
    ...original,
    alertQueue: mockAlertQueue,
    enqueuePaymentAlert: vi.fn().mockResolvedValue(undefined),
  };
});

const sampleDeadLetter = {
  id: 'dl-test-1',
  deliveryKey: 'deliv-key-1',
  paymentId: 'pay-test-1',
  channel: 'webhook',
  destination: 'https://example.com/webhook',
  payload: {
    event: 'payment.received',
    data: {
      paymentId: 'pay-test-1',
      txHash: '0xabc123',
      amount: '500.0',
      asset: 'XLM',
      fromAddress: 'GA123',
      receivedAt: '2026-10-19T12:00:00.000Z',
    },
  },
  error: 'Endpoint timeout 504 Gateway Timeout',
  status: 'pending',
  retryCount: 1,
  failedAt: new Date('2026-10-19T10:00:00.000Z'),
  createdAt: new Date('2026-10-19T10:00:00.000Z'),
  updatedAt: new Date('2026-10-19T10:00:00.000Z'),
  auditLogs: [],
};

describe('DlqReplayService (#638)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (queries: any[]) => {
      const results = [];
      for (const q of queries) results.push(await q);
      return results;
    });
  });

  describe('inspectDlq', () => {
    it('queries dead letters with filters and pagination', async () => {
      mockPrisma.deadLetter.findMany.mockResolvedValue([sampleDeadLetter]);
      mockPrisma.deadLetter.count.mockResolvedValue(1);

      const result = await dlqReplayService.inspectDlq({
        channel: 'webhook',
        destination: 'example.com',
        status: 'pending',
        limit: 10,
        offset: 0,
      });

      expect(mockPrisma.deadLetter.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          channel: 'webhook',
          status: 'pending',
          destination: { contains: 'example.com', mode: 'insensitive' },
        }),
        orderBy: { failedAt: 'desc' },
        take: 10,
        skip: 0,
        include: {
          auditLogs: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
      });

      expect(result.items).toHaveLength(1);
      expect(result.pagination).toEqual({
        total: 1,
        limit: 10,
        offset: 0,
        hasMore: false,
      });
    });

    it('filters by wallet and date range', async () => {
      mockPrisma.deadLetter.findMany.mockResolvedValue([]);
      mockPrisma.deadLetter.count.mockResolvedValue(0);

      await dlqReplayService.inspectDlq({
        walletId: 'wallet-123',
        fromDate: '2026-10-01T00:00:00.000Z',
        toDate: '2026-10-19T00:00:00.000Z',
      });

      expect(mockPrisma.deadLetter.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            payment: { walletId: 'wallet-123' },
            failedAt: {
              gte: new Date('2026-10-01T00:00:00.000Z'),
              lte: new Date('2026-10-19T00:00:00.000Z'),
            },
          }),
        }),
      );
    });
  });

  describe('replayJobs', () => {
    it('re-queues failed jobs preserving idempotency keys and records audit logs', async () => {
      mockPrisma.deadLetter.findMany.mockResolvedValue([sampleDeadLetter]);
      mockPrisma.deadLetter.update.mockResolvedValue({ ...sampleDeadLetter, status: 'retried' });
      mockPrisma.deadLetterAudit.create.mockResolvedValue({ id: 'audit-1' });

      const result = await dlqReplayService.replayJobs({
        ids: ['dl-test-1'],
        actorUserId: 'admin-1',
      });

      expect(result.success).toBe(true);
      expect(result.replayedCount).toBe(1);
      expect(result.failedCount).toBe(0);

      expect(mockAlertQueue.add).toHaveBeenCalledWith(
        'dispatch-alert',
        expect.objectContaining({
          paymentId: 'pay-test-1',
          txHash: '0xabc123',
          amount: '500.0',
          asset: 'XLM',
        }),
        expect.objectContaining({
          jobId: expect.stringContaining('replay-deliv-key-1-'),
          attempts: 3,
        }),
      );

      expect(mockPrisma.deadLetter.update).toHaveBeenCalledWith({
        where: { id: 'dl-test-1' },
        data: {
          status: 'retried',
          retryCount: { increment: 1 },
        },
      });

      expect(mockPrisma.deadLetterAudit.create).toHaveBeenCalledWith({
        data: {
          deadLetterId: 'dl-test-1',
          actorUserId: 'admin-1',
          action: 'replay',
          note: 'Re-queued to primary alert queue preserving idempotency keys',
        },
      });
    });

    it('refuses to replay suppressed dead letters unless force is true', async () => {
      mockPrisma.deadLetter.findMany.mockResolvedValue([]);

      await dlqReplayService.replayJobs({ ids: ['dl-test-1'] });

      expect(mockPrisma.deadLetter.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['dl-test-1'] },
          status: { not: 'suppressed' },
        },
        take: 500,
      });

      mockPrisma.deadLetter.findMany.mockClear();
      await dlqReplayService.replayJobs({ ids: ['dl-test-1'], force: true });

      expect(mockPrisma.deadLetter.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['dl-test-1'] },
        },
        take: 500,
      });
    });

    it('rejects replay when neither ids nor filter are specified', async () => {
      await expect(dlqReplayService.replayJobs({})).rejects.toThrow(
        'Must specify job ids or filter criteria for replay',
      );
    });
  });

  describe('purgeJobs', () => {
    it('purges dead letters older than retention days with channel and status filters', async () => {
      mockPrisma.deadLetter.findMany.mockResolvedValue([{ id: 'dl-old-1' }, { id: 'dl-old-2' }]);
      mockPrisma.deadLetter.deleteMany.mockResolvedValue({ count: 2 });

      const result = await dlqReplayService.purgeJobs({
        olderThanDays: 30,
        status: 'suppressed',
        channel: 'email',
        actorUserId: 'admin-1',
      });

      expect(result.success).toBe(true);
      expect(result.purgedCount).toBe(2);

      expect(mockPrisma.deadLetter.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          failedAt: { lte: expect.any(Date) },
          status: 'suppressed',
          channel: 'email',
        }),
        select: { id: true },
        take: 1000,
      });

      expect(mockPrisma.deadLetter.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['dl-old-1', 'dl-old-2'] } },
      });
    });

    it('returns purgedCount 0 when no records match retention window', async () => {
      mockPrisma.deadLetter.findMany.mockResolvedValue([]);

      const result = await dlqReplayService.purgeJobs({
        olderThanDays: 14,
      });

      expect(result.success).toBe(true);
      expect(result.purgedCount).toBe(0);
      expect(mockPrisma.deadLetter.deleteMany).not.toHaveBeenCalled();
    });

    it('throws error when retention window is missing', async () => {
      await expect(dlqReplayService.purgeJobs({})).rejects.toThrow(
        'Must specify olderThanDays or olderThanDate for purge',
      );
    });
  });
});
