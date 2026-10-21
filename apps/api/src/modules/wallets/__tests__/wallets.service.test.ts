import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WalletsService } from '../wallets.service';
import { prisma } from '../../../lib/prisma';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    wallet: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

describe('WalletsService', () => {
  let walletsService: WalletsService;

  beforeEach(() => {
    walletsService = new WalletsService();
    vi.clearAllMocks();
  });

  describe('addWallet', () => {
    it('creates and returns a wallet successfully', async () => {
      const mockWallet = {
        id: 'w-1',
        userId: 'u-1',
        publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
        label: 'Treasury',
        createdAt: new Date(),
      };
      vi.mocked(prisma.wallet.create).mockResolvedValue(mockWallet as any);

      const result = await walletsService.addWallet('u-1', 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72', 'Treasury');
      expect(result).toEqual(mockWallet);
      expect(prisma.wallet.create).toHaveBeenCalledWith({
        data: {
          userId: 'u-1',
          publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
          label: 'Treasury',
          tags: [],
        },
      });
    });

    it('throws "Wallet already exists" error on Prisma P2002 duplicate key constraint failure', async () => {
      const duplicateError = new Error('Unique constraint failed') as any;
      duplicateError.code = 'P2002';
      vi.mocked(prisma.wallet.create).mockRejectedValue(duplicateError);

      await expect(
        walletsService.addWallet('u-1', 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72')
      ).rejects.toThrow('Wallet already exists');
    });
  });

  describe('getIngestionStatus', () => {
    it('returns cursor health for a wallet owned by the requesting user', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
        cursor: {
          pagingToken: '12345',
          status: 'gap_detected',
          consecutiveFailures: 2,
          lastError: 'All Horizon nodes unreachable',
          lastSuccessAt: new Date('2026-09-20T00:00:00.000Z'),
          lastSyncedAt: new Date('2026-09-23T00:00:00.000Z'),
          gapDetectedAt: new Date('2026-09-23T00:00:00.000Z'),
          lastGapLedgerDelta: 42,
        },
      } as any);

      const result = await walletsService.getIngestionStatus('u-1', 'w-1');

      expect(result).toEqual({
        walletId: 'w-1',
        publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
        pagingToken: '12345',
        status: 'gap_detected',
        consecutiveFailures: 2,
        lastError: 'All Horizon nodes unreachable',
        lastSuccessAt: new Date('2026-09-20T00:00:00.000Z'),
        lastSyncedAt: new Date('2026-09-23T00:00:00.000Z'),
        gapDetectedAt: new Date('2026-09-23T00:00:00.000Z'),
        lastGapLedgerDelta: 42,
      });
    });

    it('defaults to a healthy status when no cursor has been created yet', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        publicKey: 'GBPDX2...',
        cursor: null,
      } as any);

      const result = await walletsService.getIngestionStatus('u-1', 'w-1');

      expect(result).toEqual(
        expect.objectContaining({ status: 'active', consecutiveFailures: 0, pagingToken: null }),
      );
    });

    it('throws "Wallet not found" for a missing wallet', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue(null as any);

      await expect(walletsService.getIngestionStatus('u-1', 'w-missing')).rejects.toThrow('Wallet not found');
    });

    it('throws "Wallet not found" when the wallet belongs to a different user', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({ id: 'w-1', userId: 'someone-else', cursor: null } as any);

      await expect(walletsService.getIngestionStatus('u-1', 'w-1')).rejects.toThrow('Wallet not found');
    });
  });

  describe('updateWalletMetadata', () => {
    it('updates nickname, color, and normalized tags while preserving existing metadata', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({
        id: 'w-1', userId: 'u-1', metadata: { source: 'import' },
      } as any);
      const updated = { id: 'w-1', metadata: { source: 'import', nickname: 'Treasury', colorHex: '#112233', tags: ['Payroll'] }, tags: ['Payroll'] };
      vi.mocked(prisma.wallet.update).mockResolvedValue(updated as any);

      const result = await walletsService.updateWalletMetadata('u-1', 'w-1', {
        nickname: 'Treasury', colorHex: '#112233', tags: [' Payroll ', 'payroll'],
      });

      expect(prisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'w-1' },
        data: { metadata: updated.metadata, tags: ['Payroll'] },
      });
      expect(result).toEqual(updated);
    });

    it('does not update wallets owned by another user', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({ id: 'w-1', userId: 'other-user' } as any);

      await expect(walletsService.updateWalletMetadata('u-1', 'w-1', { nickname: 'Private' }))
        .rejects.toThrow('Wallet not found');
      expect(prisma.wallet.update).not.toHaveBeenCalled();
    });
  });

  describe('removeWallet', () => {
    it('removes wallet successfully when owned by the user', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({ id: 'w-1', userId: 'u-1' } as any);
      vi.mocked(prisma.wallet.delete).mockResolvedValue({} as any);

      const result = await walletsService.removeWallet('u-1', 'w-1');
      expect(result).toEqual({ success: true });
      expect(prisma.wallet.delete).toHaveBeenCalledWith({ where: { id: 'w-1' } });
    });

    it('throws "Wallet not found" when wallet belongs to another user', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({ id: 'w-1', userId: 'other-user' } as any);

      await expect(walletsService.removeWallet('u-1', 'w-1')).rejects.toThrow('Wallet not found');
      expect(prisma.wallet.delete).not.toHaveBeenCalled();
    });

    it('throws "Wallet not found" when wallet does not exist', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue(null);

      await expect(walletsService.removeWallet('u-1', 'w-invalid')).rejects.toThrow('Wallet not found');
    });

    it('throws "Wallet not found" when Prisma P2025 error occurs on delete', async () => {
      vi.mocked(prisma.wallet.findUnique).mockResolvedValue({ id: 'w-1', userId: 'u-1' } as any);
      const notFoundError = new Error('Record not found') as any;
      notFoundError.code = 'P2025';
      vi.mocked(prisma.wallet.delete).mockRejectedValue(notFoundError);

      await expect(walletsService.removeWallet('u-1', 'w-1')).rejects.toThrow('Wallet not found');
    });
  });
});
