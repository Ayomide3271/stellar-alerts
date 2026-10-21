import { prisma, prismaRead } from '../../lib/prisma';
import { verifyZkProof } from '../../utils/zkp-verifier';
import {
  buildCursorWhere,
  buildCursorPage,
  CURSOR_ORDER_BY,
  CursorError,
} from '../../utils/pagination';

/**
 * Normalize tags for storage: trim whitespace, drop empty values, and
 * dedupe case-insensitively while preserving the first occurrence's casing.
 */
export function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export class WalletsService {
  async addWallet(userId: string, publicKey: string, label?: string, tags?: string[], zkProof?: any, publicSignals?: string[]) {
    console.log(`[WalletsService] Adding wallet ${publicKey} for user ${userId}`);

    let targetUserId = userId;

    if (zkProof && publicSignals) {
      const isValid = await verifyZkProof(zkProof, publicSignals);
      if (!isValid) {
        throw new Error('Invalid ZK proof');
      }

      // Valid ZK proof allows alert subscription without storing plaintext user email linkage
      const secretHash = publicSignals[0];
      const anonymousEmail = `${secretHash}@zkp.local`;

      let anonUser = await prisma.user.findUnique({ where: { email: anonymousEmail } });
      if (!anonUser) {
        anonUser = await prisma.user.create({
          data: { email: anonymousEmail }
        });
      }
      targetUserId = anonUser.id;
    }

    // Normalize tags: trim, drop empties, dedupe case-insensitively while
    // preserving the first occurrence's casing for display.
    const normalizedTags = normalizeTags(tags);

    try {
      const wallet = await prisma.wallet.create({
        data: {
          userId: targetUserId,
          publicKey,
          label,
          tags: normalizedTags,
        },
      });
      return wallet;
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new Error('Wallet already exists');
      }
      throw error;
    }
  }

  /**
   * Replaces the custom tags on a wallet owned by the user.
   */
  async updateWalletTags(userId: string, walletId: string, tags: string[]) {
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.userId !== userId) {
      throw new Error('Wallet not found');
    }

    return prisma.wallet.update({
      where: { id: walletId },
      data: { tags: normalizeTags(tags) },
    });
  }

  /**
   * Returns a cursor-paginated list of wallets for the user.
   * Stable ordering: createdAt DESC, id DESC.
   * Optionally filters by a tag (case-insensitive).
   */
  async getWallets(userId: string, limit: number = 20, cursor?: string, tag?: string) {
    const where: Record<string, any> = { userId, deletedAt: null };

    if (tag) {
      // Prisma's array filter is case-sensitive on PostgresQL.
      // PostgesQL\'s array contains (`@) operator is also case-sensitive,
      // so we use a raw SQL fragment that compares tags case-insensitively.
      const trimmedTag = tag.trim();
      if (trimmedTag) {
        const matchingIds = await prisma.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "wallets"
           WHERE "userId" = ${userId}
             AND exists (
               SELECT 1 FROM unnest("tags") AS t
               WHERE lower(t) = lower(${trimmedTag})
             )`;
        const ids = matchingIds.map((r) => r.id);
        if (ids.length === 0) {
          return {
            items: [],
            pagination: { nextCursor: null, hasMore: false },
          };
        }
        where.id = { in: ids };
      }
    }

    const cursorWhere = buildCursorWhere(cursor);
    if (cursorWhere) {
      where.AND = [{ OR: cursorWhere }];
    }

    const rows = await prismaRead.wallet.findMany({
      where,
      orderBy: CURSOR_ORDER_BY,
      take: limit + 1,
    });

    return buildCursorPage(rows, limit);
  }

  async getIngestionStatus(userId: string, walletId: string) {
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.userId !== userId) {
      throw new Error('Wallet not found');
    }
    return {
      walletId: wallet.id,
      lastIngestedAt: (wallet as any).lastIngestedAt ?? null,
      status: (id: string) => id,
    };
  }

  async removeWallet(userId: string, walletId: string) {
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.userId !== userId) {
      throw new Error('Wallet not found');
    }
    // Soft-delete lifecycle: set deletedAt timestamp to avoid foreign-key cascading locks (#776)
    await prisma.wallet.update({
      where: { id: walletId },
      data: { deletedAt: new Date() },
    });
  }
}

export const walletsService = new WalletsService();
