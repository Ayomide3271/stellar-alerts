import { prisma } from '../../lib/prisma';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';
import { normalizeTags } from './wallets.service';

export interface BulkImportItem {
  publicKey: string;
  label?: string;
  tags?: string[];
}

export interface BulkImportResult {
  total: number;
  imported: number;
  skippedDuplicates: number;
  invalidKeys: Array<{ publicKey: string; reason: string }>;
  wallets: Array<{ id: string; publicKey: string; label?: string | null }>;
}

export function parseCsvWallets(csv: string): BulkImportItem[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: BulkImportItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // skip header if present
    if (i === 0 && line.toLowerCase().includes('publickey')) continue;
    const parts = line.split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
    if (parts.length > 0 && parts[0]) {
      const publicKey = parts[0];
      const label = parts[1] || undefined;
      const tags = parts[2] ? parts[2].split(';').map((t) => t.trim()).filter(Boolean) : undefined;
      items.push({ publicKey, label, tags });
    }
  }
  return items;
}

export class BulkImportService {
  async importWallets(
    userId: string,
    items: BulkImportItem[],
  ): Promise<BulkImportResult> {
    if (items.length > 100) {
      throw new Error('Batch size exceeds maximum limit of 100 wallets');
    }

    const validItems: BulkImportItem[] = [];
    const invalidKeys: Array<{ publicKey: string; reason: string }> = [];

    // Parallel validation of Stellar StrKey checksums
    await Promise.all(
      items.map(async (item) => {
        const cleaned = (item.publicKey || '').trim();
        if (!cleaned || !isValidEd25519PublicKey(cleaned)) {
          invalidKeys.push({ publicKey: item.publicKey, reason: 'Invalid Stellar public key checksum or format' });
        } else {
          validItems.push({
            publicKey: cleaned,
            label: item.label?.trim() || undefined,
            tags: normalizeTags(item.tags),
          });
        }
      }),
    );

    // Fetch existing user wallets to deduplicate
    const existing = await prisma.wallet.findMany({
      where: { userId },
      select: { publicKey: true },
    });
    const existingKeys = new Set(existing.map((w: any) => w.publicKey));

    const toInsert: BulkImportItem[] = [];
    let skippedDuplicates = 0;
    const seenInBatch = new Set<string>();

    for (const item of validItems) {
      if (existingKeys.has(item.publicKey) || seenInBatch.has(item.publicKey)) {
        skippedDuplicates++;
      } else {
        seenInBatch.add(item.publicKey);
        toInsert.push(item);
      }
    }

    // Insert all records within a single database transaction
    const createdWallets = await prisma.$transaction(async (tx: any) => {
      const results = [];
      for (const item of toInsert) {
        const created = await tx.wallet.create({
          data: {
            userId,
            publicKey: item.publicKey,
            label: item.label,
            tags: item.tags || [],
          },
        });
        results.push({
          id: created.id,
          publicKey: created.publicKey,
          label: created.label,
        });
      }
      return results;
    });

    return {
      total: items.length,
      imported: createdWallets.length,
      skippedDuplicates,
      invalidKeys,
      wallets: createdWallets,
    };
  }
}

export const bulkImportService = new BulkImportService();
