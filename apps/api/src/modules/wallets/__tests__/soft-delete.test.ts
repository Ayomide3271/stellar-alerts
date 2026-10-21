import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WalletsService } from '../wallets.service';
import { CleanupWorker } from '../../../workers/cleanup.worker';
import { prisma } from '../../../lib/prisma';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    wallet: {
      findUnique: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
  },
  prismaRead: {
    wallet: {
      findMany: vi.fn(),
    },
  },
}));

describe('Soft-Delete Lifecycle & Cascade Cleanup Worker (#776)', () => {
  let walletsService: WalletsService;
  let cleanupWorker: CleanupWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    walletsService = new WalletsService();
    cleanupWorker = new CleanupWorker();
  });

  it('sets deletedAt timestamp on removeWallet rather than hard-deleting the row', async () => {
    (prisma.wallet.findUnique as any).mockResolvedValue({
      id: 'wallet-123',
      userId: 'user-abc',
      publicKey: 'GVALID_KEY',
    });
    (prisma.wallet.update as any).mockResolvedValue({
      id: 'wallet-123',
      deletedAt: new Date(),
    });

    await walletsService.removeWallet('user-abc', 'wallet-123');

    expect(prisma.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-123' },
      data: expect.objectContaining({
        deletedAt: expect.any(Date),
      }),
    });
  });

  it('excludes soft-deleted wallets by requiring deletedAt: null in getWallets query', async () => {
    (prisma.wallet.findMany as any).mockResolvedValue([]);

    await walletsService.getWallets('user-abc');

    expect(prisma.wallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-abc',
          deletedAt: null,
        }),
      }),
    );
  });

  it('cleanup worker purges soft-deleted records older than 30 days', async () => {
    (prisma.wallet.deleteMany as any).mockResolvedValue({ count: 5 });

    const result = await cleanupWorker.purgeExpiredSoftDeleted(30);

    expect(result.purgedWallets).toBe(5);
    expect(prisma.wallet.deleteMany).toHaveBeenCalledWith({
      where: {
        deletedAt: {
          not: null,
          lt: expect.any(Date),
        },
      },
    });
  });
});
