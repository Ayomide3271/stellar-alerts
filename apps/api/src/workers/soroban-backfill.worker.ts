import { prisma } from '../lib/prisma';
import {
  fetchContractEventsInRange,
  parseSorobanTransferEvent,
  getSorobanLatestLedger,
} from '../lib/soroban';

const CONTRACT_ID = process.env.SOROBAN_CONTRACT_ID || '';
const BACKFILL_BATCH_SIZE = 1000; // Insert in batches for performance
const BACKFILL_START_LEDGER = parseInt(process.env.SOROBAN_BACKFILL_START_LEDGER || '1', 10);

export interface BackfillStats {
  totalEventsProcessed: number;
  eventsStored: number;
  eventsDuplicated: number;
  errorCount: number;
}

/**
 * Deduplicates events using in-batch fingerprinting and database unique constraint.
 * Returns inserted and duplicated counts.
 */
export async function deduplicateAndStoreEvents(
  events: any[]
): Promise<{ stored: number; duplicated: number }> {
  if (events.length === 0) return { stored: 0, duplicated: 0 };

  let stored = 0;
  let duplicated = 0;
  const seenInBatch = new Set<string>();

  for (const event of events) {
    const parsed = parseSorobanTransferEvent(event);
    if (!parsed) continue;

    const ledgerSeq = parsed.ledgerSeq || 0;
    const fingerprint = `${parsed.contractId}:${ledgerSeq}:${parsed.from}:${parsed.to}:${parsed.amount}`;
    if (seenInBatch.has(fingerprint)) {
      duplicated++;
      continue;
    }
    seenInBatch.add(fingerprint);

    try {
      await prisma.sorobanEventSnapshot.create({
        data: {
          contractId: parsed.contractId,
          from: parsed.from,
          to: parsed.to,
          amount: parsed.amount,
          ledgerSeq,
          eventType: 'transfer',
        },
      });
      stored++;
    } catch (error: any) {
      // Unique constraint violation = duplicate
      if (error.code === 'P2002') {
        duplicated++;
      } else {
        console.error(`[Backfill] Error storing event:`, error.message);
      }
    }
  }

  return { stored, duplicated };
}

/**
 * Backfills historical Soroban contract events from ledger range.
 */
export async function runSorobanBackfill(
  contractId: string = CONTRACT_ID,
  startLedger: number = BACKFILL_START_LEDGER,
  targetEndLedger?: number
): Promise<BackfillStats | undefined> {
  if (!contractId) {
    console.error('[Backfill] SOROBAN_CONTRACT_ID not set');
    return;
  }

  console.log(
    `[Backfill] Starting Soroban event backfill for contract ${contractId.substring(0, 8)}... from ledger ${startLedger}`
  );

  const stats: BackfillStats = {
    totalEventsProcessed: 0,
    eventsStored: 0,
    eventsDuplicated: 0,
    errorCount: 0,
  };

  try {
    // Resolve target end ledger or fetch current latest ledger
    const latestLedger =
      typeof targetEndLedger === 'number' && targetEndLedger > 0
        ? targetEndLedger
        : await getSorobanLatestLedger();
    if (latestLedger === 0) {
      console.error('[Backfill] Could not fetch latest ledger');
      return;
    }

    console.log(`[Backfill] Latest ledger: ${latestLedger}`);

    // Iterate through ledger ranges
    for await (const eventBatch of fetchContractEventsInRange(contractId, startLedger, latestLedger)) {
      stats.totalEventsProcessed += eventBatch.length;

      // Store batch with deduplication
      try {
        const result = await deduplicateAndStoreEvents(eventBatch);
        stats.eventsStored += result.stored;
        stats.eventsDuplicated += result.duplicated;

        console.log(
          `[Backfill] Batch: processed ${eventBatch.length}, stored ${result.stored}, duplicated ${result.duplicated}`
        );
      } catch (error: any) {
        stats.errorCount++;
        console.error(`[Backfill] Batch storage error:`, error.message);
      }
    }

    console.log(`[Backfill] ✅ Backfill complete:`, stats);
    return stats;
  } catch (error: any) {
    console.error(`[Backfill] Fatal error:`, error.message);
    return stats;
  }
}

/**
 * Incremental backfill: fetches events since last known ledger.
 */
export async function runIncrementalBackfill(
  contractId: string = CONTRACT_ID
): Promise<BackfillStats | undefined> {
  if (!contractId) {
    console.error('[IncrementalBackfill] SOROBAN_CONTRACT_ID not set');
    return;
  }

  console.log(`[IncrementalBackfill] Starting for contract ${contractId.substring(0, 8)}...`);

  try {
    // Get last processed ledger
    const lastSnapshot = await prisma.sorobanEventSnapshot.findFirst({
      where: { contractId },
      orderBy: { ledgerSeq: 'desc' },
      select: { ledgerSeq: true },
    });

    const startLedger = lastSnapshot ? lastSnapshot.ledgerSeq + 1 : BACKFILL_START_LEDGER;
    const latestLedger = await getSorobanLatestLedger();

    if (latestLedger === 0 || startLedger > latestLedger) {
      console.log(`[IncrementalBackfill] No new ledgers to process (start: ${startLedger}, latest: ${latestLedger})`);
      return;
    }

    console.log(
      `[IncrementalBackfill] Fetching events from ledger ${startLedger} to ${latestLedger}`
    );

    const stats: BackfillStats = {
      totalEventsProcessed: 0,
      eventsStored: 0,
      eventsDuplicated: 0,
      errorCount: 0,
    };

    for await (const eventBatch of fetchContractEventsInRange(contractId, startLedger, latestLedger)) {
      stats.totalEventsProcessed += eventBatch.length;

      const result = await deduplicateAndStoreEvents(eventBatch);
      stats.eventsStored += result.stored;
      stats.eventsDuplicated += result.duplicated;

      console.log(
        `[IncrementalBackfill] Batch: stored ${result.stored}, duplicated ${result.duplicated}`
      );
    }

    console.log(`[IncrementalBackfill] ✅ Complete:`, stats);
    return stats;
  } catch (error: any) {
    console.error(`[IncrementalBackfill] Error:`, error.message);
    return;
  }
}

// Run backfill if executed directly
if (require.main === module) {
  const mode = process.argv[2] || 'full';
  const contractId = process.argv[3] || CONTRACT_ID;

  if (mode === 'full') {
    runSorobanBackfill(contractId);
  } else if (mode === 'incremental') {
    runIncrementalBackfill(contractId);
  } else {
    console.log('Usage: ts-node soroban-backfill.worker.ts [full|incremental] [contractId]');
  }
}
