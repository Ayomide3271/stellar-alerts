import { prisma, prismaRead } from '../../lib/prisma';
import { isSupportedFiatCurrency, convertUsdToFiat, SupportedFiatCurrency } from '../../lib/exchange-rates';
import { addDifferentialPrivacyNoise } from '../../utils/differential-privacy';
import {
  buildCursorWhere,
  buildCursorPage,
  encodeCursor,
  CursorError,
} from '../../utils/pagination';
import { withSummaryCache } from '../../lib/summaryCache';
import { simulateTransaction, SorobanFeeEstimate } from '../../lib/soroban';

export type PaymentSortField = 'receivedAt' | 'amount' | 'asset';
export type SortOrder = 'asc' | 'desc';

export interface GetPaymentsFilters {
  asset?: string;
  memo?: string;
  dateFrom?: Date;
  dateTo?: Date;
  /** @deprecated Use cursor-based pagination. sortBy/sortOrder still respected for export endpoints. */
  sortBy?: PaymentSortField;
  /** @deprecated Use cursor-based pagination. */
  sortOrder?: SortOrder;
  /** Opaque cursor returned by a previous page's `pagination.nextCursor`. */
  cursor?: string;
}

export class PaymentsService {
  /**
   * Returns a cursor-paginated page of payments for a user.
   *
   * Stable ordering: `receivedAt DESC, id DESC` — matches the existing
   * `Payment_walletId_receivedAt_idx` and `Payment_receivedAt_idx` DB indexes.
   * The cursor encodes `{ receivedAt, id }` so subsequent pages resume
   * exactly where the previous one ended.
   *
   * For bulk export callers (tax export, PDF) pass a large `limit` and omit
   * `cursor`; those callers never use the pagination envelope.
   */
  async getPayments(
    userId: string,
    walletId?: string,
    limit: number = 20,
    filters: GetPaymentsFilters = {},
  ) {
    // Authorization is always enforced here, never left to the caller: a
    // walletId filter is combined with wallet.userId so a request can never
    // read another user's payments by guessing a walletId.
    const where: any = walletId
      ? { walletId, wallet: { userId } }
      : { wallet: { userId } };

    if (filters.asset) {
      where.asset = filters.asset;
    }

    if (filters.memo) {
      where.memo = { contains: filters.memo, mode: 'insensitive' };
    }

    if (filters.dateFrom || filters.dateTo) {
      where.receivedAt = {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateTo ? { lte: filters.dateTo } : {}),
      };
    }

    // Cursor condition — payments use receivedAt (not createdAt) as the primary
    // sort key, so we encode { receivedAt, id } and apply the same
    // "earlier than cursor" OR clause against those two fields.
    if (filters.cursor) {
      const { receivedAt, id } = decodePaymentCursor(filters.cursor);
      const cursorWhere = {
        OR: [
          { receivedAt: { lt: receivedAt } },
          { receivedAt, id: { lt: id } },
        ],
      };
      // Merge with any existing receivedAt range filter carefully
      if (where.receivedAt) {
        where.AND = [{ receivedAt: where.receivedAt }, cursorWhere];
        delete where.receivedAt;
      } else {
        Object.assign(where, cursorWhere);
      }
    }

    const sortBy = filters.sortBy ?? 'receivedAt';
    const sortOrder = filters.sortOrder ?? 'desc';

    // Hot path (dashboard + k6 load test): avoid per-request console.log —
    // synchronous stdout blocks the event loop under concurrent load.
    // Debug logging stays available via LOG_LEVEL=debug.
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(
        `[PaymentsService] Fetching up to ${limit} payments for user ${userId}${
          walletId ? ` (wallet ${walletId})` : ' (all wallets)'
        }, sorted by ${sortBy} ${sortOrder}${filters.cursor ? ' (cursor page)' : ''}`,
      );
    }

    // Fetch limit+1 to detect whether a next page exists.
    // Export callers pass limit=5000 and no cursor, so the +1 is negligible.
    // where.walletId / where.asset are indexed (Payment_walletId_idx,
    // Payment_asset_idx, Payment_walletId_receivedAt_idx).
    const rows = await prismaRead.payment.findMany({
      where,
      orderBy: [{ [sortBy]: sortOrder }, { id: sortOrder }],
      take: limit + 1,
    });

    const hasNextPage = rows.length > limit;
    const items = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasNextPage && items.length > 0
        ? encodePaymentCursor(items[items.length - 1])
        : undefined;

    return {
      items,
      pagination: { limit, nextCursor, hasNextPage },
    };
  }
  
  async getPaymentsSummary(userId: string, walletId?: string, fiatCurrency?: string) {
    const { value } = await withSummaryCache({
      kind: 'payments',
      userId,
      walletId,
      fiat: fiatCurrency,
      load: async () => {
        const where: any = walletId
          ? { walletId, wallet: { userId } }
          : { wallet: { userId } };

        if (process.env.LOG_LEVEL === 'debug') {
          console.debug(
            `[PaymentsService] Fetching summary for user ${userId}${
              walletId ? ` (wallet ${walletId})` : ' (all wallets)'
            }`,
          );
        }

        const result = await prismaRead.payment.aggregate({
          where,
          _sum: { amount: true },
          _count: { id: true },
        });

    return {
      totalReceived: result._sum.amount || 0,
      paymentCount: result._count.id || 0,
    };

        if (fiatCurrency && isSupportedFiatCurrency(fiatCurrency)) {
          const conversion = await convertUsdToFiat(
            totalReceivedUsd,
            fiatCurrency as SupportedFiatCurrency,
          );
          summary.fiatConversion = {
            currency: conversion.currency,
            convertedTotal: conversion.convertedAmount,
            exchangeRate: conversion.rate,
          };
        }

        return summary;
      },
    });

    return value;
  }

  
  /**
   * Fetches public volume statistics protected with Laplace differential privacy noise.
   * Epsilon parameter controls privacy budget (lower epsilon = more privacy/noise).
   */
  async getPublicVolumeStats(epsilon: number = 0.5) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(`[PaymentsService] Fetching differentially private public volume stats (epsilon=${epsilon})`);
    }
    const aggregate = await prisma.payment.aggregate({
      _sum: { amount: true },
      _count: { id: true },
    });

    const rawTotalVolume = Number(aggregate._sum.amount || 0);
    const noisyVolume = addDifferentialPrivacyNoise(rawTotalVolume, epsilon, 1.0);

    return {
      rawTotalVolume,
      noisyTotalVolume: noisyVolume,
      totalPayments: aggregate._count.id || 0,
      epsilon,
      anonymized: true,
    };
  }

  /**
   * Cross-Ledger Settlement Analytics aggregator combining Stellar Classic and Soroban streams.
   * Calculates combined daily volume, transaction count, and average payment size.
   */
  // PR placeholder for issue #553 – cross‑ledger analytics
  async getCrossLedgerAnalytics(userId?: string, walletId?: string) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(
        `[PaymentsService] Fetching cross-ledger analytics for user ${userId || 'all'}${walletId ? ` (wallet ${walletId})` : ''}`,
      );
    }

    const paymentsWhere = walletId
      ? { walletId, wallet: { userId } }
      : userId
        ? { wallet: { userId } }
        : {};

    const payments = await prisma.payment.findMany({
      where: paymentsWhere,
      orderBy: { receivedAt: 'asc' },
    });

    let sorobanEvents: Array<{ amount: string; createdAt: Date }> = [];
    if ((prisma as any).sorobanEventSnapshot?.findMany) {
      if (userId) {
        let contractIds: string[] = [];
        if ((prisma as any).sorobanContractSubscription?.findMany) {
          const subs = await (prisma as any).sorobanContractSubscription.findMany({
            where: { userId },
          });
          contractIds = subs.map((s: any) => s.contractId);
        }

        if (contractIds.length > 0) {
          sorobanEvents = await (prisma as any).sorobanEventSnapshot.findMany({
            where: { contractId: { in: contractIds } },
            orderBy: { createdAt: 'asc' },
          });
        } else {
          sorobanEvents = await (prisma as any).sorobanEventSnapshot.findMany({
            orderBy: { createdAt: 'asc' },
          });
        }
      } else {
        sorobanEvents = await (prisma as any).sorobanEventSnapshot.findMany({
          orderBy: { createdAt: 'asc' },
        });
      }
    }

    const dailyMap = new Map<
      string,
      { classicVolume: number; classicCount: number; sorobanVolume: number; sorobanCount: number }
    >();

    for (const p of payments) {
      const dateStr = (p.receivedAt || p.createdAt).toISOString().split('T')[0];
      const amt = Number(p.amount) || 0;
      const current = dailyMap.get(dateStr) || {
        classicVolume: 0,
        classicCount: 0,
        sorobanVolume: 0,
        sorobanCount: 0,
      };
      current.classicVolume += amt;
      current.classicCount += 1;
      dailyMap.set(dateStr, current);
    }

    for (const e of sorobanEvents) {
      const dateStr = e.createdAt.toISOString().split('T')[0];
      const amt = parseFloat(e.amount) || 0;
      const current = dailyMap.get(dateStr) || {
        classicVolume: 0,
        classicCount: 0,
        sorobanVolume: 0,
        sorobanCount: 0,
      };
      current.sorobanVolume += amt;
      current.sorobanCount += 1;
      dailyMap.set(dateStr, current);
    }

    let classicVolumeTotal = 0;
    let classicCountTotal = 0;
    let sorobanVolumeTotal = 0;
    let sorobanCountTotal = 0;

    const daily = Array.from(dailyMap.entries())
      .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
      .map(([date, data]) => {
        classicVolumeTotal += data.classicVolume;
        classicCountTotal += data.classicCount;
        sorobanVolumeTotal += data.sorobanVolume;
        sorobanCountTotal += data.sorobanCount;

        const totalVol = data.classicVolume + data.sorobanVolume;
        const totalCnt = data.classicCount + data.sorobanCount;
        const avgSize = totalCnt > 0 ? totalVol / totalCnt : 0;

        return {
          date,
          totalVolume: Number(totalVol.toFixed(4)),
          totalCount: totalCnt,
          averagePaymentSize: Number(avgSize.toFixed(4)),
          classicVolume: Number(data.classicVolume.toFixed(4)),
          classicCount: data.classicCount,
          sorobanVolume: Number(data.sorobanVolume.toFixed(4)),
          sorobanCount: data.sorobanCount,
        };
      });

    const totalVolume = classicVolumeTotal + sorobanVolumeTotal;
    const totalTransactionCount = classicCountTotal + sorobanCountTotal;
    const averagePaymentSize =
      totalTransactionCount > 0 ? totalVolume / totalTransactionCount : 0;

    const summary = {
      totalVolume: Number(totalVolume.toFixed(4)),
      totalTransactionCount,
      averagePaymentSize: Number(averagePaymentSize.toFixed(4)),
      breakdown: {
        classic: {
          volume: Number(classicVolumeTotal.toFixed(4)),
          count: classicCountTotal,
          averageSize:
            classicCountTotal > 0
              ? Number((classicVolumeTotal / classicCountTotal).toFixed(4))
              : 0,
        },
        soroban: {
          volume: Number(sorobanVolumeTotal.toFixed(4)),
          count: sorobanCountTotal,
          averageSize:
            sorobanCountTotal > 0
              ? Number((sorobanVolumeTotal / sorobanCountTotal).toFixed(4))
              : 0,
        },
      },
    };

    return { summary, daily };
  }

  /**
   * Estimates Soroban transaction fees including storage rent and read/write
   * ledger footprints by delegating to the Soroban RPC `simulateTransaction`
   * method.
   *
   * @param xdrEnvelope - Base64-encoded XDR TransactionEnvelope to simulate.
   * @returns A {@link SorobanFeeEstimate} with full fee breakdown and footprint.
   */
  async estimateFee(xdrEnvelope: string): Promise<SorobanFeeEstimate> {
    console.log('[PaymentsService] Estimating Soroban transaction fee via RPC simulation');
    return simulateTransaction(xdrEnvelope);
  }
}

export const paymentsService = new PaymentsService();

// ---------------------------------------------------------------------------
// Payment-specific cursor helpers
// Payments use `receivedAt` (not `createdAt`) as the primary sort key, so
// we keep a dedicated encode/decode pair rather than the generic utility.
// ---------------------------------------------------------------------------

interface PaymentCursorPayload {
  receivedAt: string;
  id: string;
}

/**
 * Encodes the last payment on a page into an opaque base64url cursor.
 */
export function encodePaymentCursor(item: { id: string; receivedAt: Date }): string {
  const payload: PaymentCursorPayload = {
    receivedAt: item.receivedAt.toISOString(),
    id: item.id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes an opaque payment cursor.
 * Throws {@link CursorError} if the cursor is malformed or missing required fields.
 */
export function decodePaymentCursor(cursor: string): { receivedAt: Date; id: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new CursorError();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new CursorError();
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as any).receivedAt !== 'string' ||
    typeof (payload as any).id !== 'string' ||
    isNaN(Date.parse((payload as any).receivedAt))
  ) {
    throw new CursorError();
  }

  return {
    receivedAt: new Date((payload as PaymentCursorPayload).receivedAt),
    id: (payload as PaymentCursorPayload).id,
  };
}
