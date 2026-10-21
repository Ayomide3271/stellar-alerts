import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BulkImportService, parseCsvWallets } from '../bulk-import.service';
import { prisma } from '../../../lib/prisma';
import * as shared from '@stellar-alerts/shared';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    wallet: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

describe('BulkImportService (#771)', () => {
  let service: BulkImportService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new BulkImportService();
  });

  it('parses CSV wallets correctly including labels and tags', () => {
    const csv = `publicKey,label,tags
GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN,HotWallet,treasury;hot
GBBM6BKZPEHWYO3E3YKREDPQXMS4KZVNGBBM6BKZPEHWYO3E3YKREDPQ,ColdStorage,cold`;

    const items = parseCsvWallets(csv);
    expect(items).toHaveLength(2);
    expect(items[0].publicKey).toBe('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
    expect(items[0].label).toBe('HotWallet');
    expect(items[0].tags).toEqual(['treasury', 'hot']);
    expect(items[1].label).toBe('ColdStorage');
  });

  it('imports valid wallets and filters out duplicates and invalid keys in a single transaction', async () => {
    vi.spyOn(shared, 'isValidEd25519PublicKey').mockImplementation((k: string) => {
      return k.startsWith('GVALID');
    });

    (prisma.wallet.findMany as any).mockResolvedValue([
      { publicKey: 'GVALID_EXISTING' },
    ]);

    (prisma.$transaction as any).mockImplementation(async (callback: any) => {
      const mockTx = {
        wallet: {
          create: vi.fn().mockImplementation(({ data }: any) => ({
            id: 'wallet-uuid',
            ...data,
          })),
        },
      };
      return callback(mockTx);
    });

    const items = [
      { publicKey: 'GVALID_1', label: 'Primary' },
      { publicKey: 'GVALID_EXISTING', label: 'ShouldSkip' },
      { publicKey: 'GINVALID_BAD_KEY', label: 'Invalid' },
      { publicKey: 'GVALID_1', label: 'BatchDuplicate' },
    ];

    const result = await service.importWallets('user-123', items);

    expect(result.total).toBe(4);
    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(2);
    expect(result.invalidKeys).toHaveLength(1);
    expect(result.invalidKeys[0].publicKey).toBe('GINVALID_BAD_KEY');
    expect(result.wallets).toHaveLength(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('enforces maximum 100 batch limit', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      publicKey: `GVALID_${i}`,
    }));

    await expect(service.importWallets('user-123', items)).rejects.toThrow(
      'Batch size exceeds maximum limit of 100 wallets',
    );
  });
});
