import { prisma } from '../../lib/prisma';
import {
  fetchContractEvents,
  getSorobanLatestLedger,
  parseApprovalEvent,
  type ParsedSorobanApproval,
} from '../../lib/soroban';
import {
  AllowanceSentinelEngine,
  AllowanceRiskAssessment,
  TokenApproval,
} from '../../services/allowance-sentinel';
import { registerSupervisorHeartbeat } from '../supervisor';

// #639: Token Allowance & Spender Approval Risk Sentinel
// Detects Soroban 'approve' invocations on tracked wallets, calculates approved
// exposure, and dispatches high-priority warning alerts when an allowance exceeds
// safety thresholds.

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_LOOKBACK_LEDGERS = 100;

/** Allowance amount (in the token's raw integer units) above which a newly
 *  granted approval is flagged as WARNING. */
const WARNING_THRESHOLD = BigInt(
  process.env.ALLOWANCE_SENTINEL_WARNING_THRESHOLD || '1000000000000',
);

/** Allowance amount (in the token's raw integer units) above which a newly
 *  granted approval is flagged as CRITICAL. */
const CRITICAL_THRESHOLD = BigInt(
  process.env.ALLOWANCE_SENTINEL_CRITICAL_THRESHOLD || '18446744073709551615',
);

/** Whether to treat zero expiry as unlimited approval. */
const TREAT_ZERO_EXPIRY_AS_UNLIMITED = process.env.ALLOWANCE_SENTINEL_TREAT_ZERO_AS_UNLIMITED !== 'false';

let isProcessing = false;

export const allowanceSentinelEngine = new AllowanceSentinelEngine({
  warningThreshold: WARNING_THRESHOLD,
  criticalThreshold: CRITICAL_THRESHOLD,
  treatZeroExpiryAsUnlimited: TREAT_ZERO_EXPIRY_AS_UNLIMITED,
});

export type AllowanceRiskNotifier = (assessment: AllowanceRiskAssessment) => Promise<void> | void;

export const defaultAllowanceRiskNotifier: AllowanceRiskNotifier = (assessment) => {
  const tag = assessment.severity === 'CRITICAL' ? '🚨' : '⚠️';
  console.log(
    `[AllowanceSentinel] ${tag} ${assessment.contractId.slice(0, 8)}... [${assessment.severity}] ` +
    `${assessment.from.slice(0, 8)}... -> ${assessment.spender.slice(0, 8)}... ` +
    `amount=${assessment.amount} - ${assessment.message}`,
  );
};

/**
 * Converts a ParsedSorobanApproval to a TokenApproval for the sentinel engine.
 */
function parsedApprovalToTokenApproval(approval: ParsedSorobanApproval): TokenApproval {
  return {
    contractId: approval.contractId,
    from: approval.from,
    spender: approval.spender,
    amount: approval.amount,
    rawAmount: approval.rawAmount,
    liveUntilLedger: approval.liveUntilLedger,
    ledgerSeq: approval.ledgerSeq,
  };
}

/**
 * Processes a batch of raw Soroban events and returns risk assessments.
 */
export function detectAllowanceRisksFromEventBatch(
  events: any[],
  engine: AllowanceSentinelEngine = allowanceSentinelEngine,
): AllowanceRiskAssessment[] {
  const assessments: AllowanceRiskAssessment[] = [];

  for (const rawEvent of events) {
    const approval = parseApprovalEvent(rawEvent);
    if (!approval) continue;

    const tokenApproval = parsedApprovalToTokenApproval(approval);
    const assessment = engine.assessApproval(tokenApproval);
    if (assessment) {
      assessments.push(assessment);
    }
  }

  return assessments;
}

/**
 * Gets the list of contract IDs to monitor for allowance risks.
 * First checks environment variable, then falls back to active subscriptions.
 */
export function getAllowanceWatchedContractIds(): string[] {
  const fromEnv = (process.env.ALLOWANCE_SENTINEL_CONTRACT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (fromEnv.length > 0) {
    return Array.from(new Set(fromEnv));
  }

  return [];
}

/**
 * Processes a single contract for allowance risks.
 * Fetches events since the last snapshot, assesses them, and notifies on risks.
 */
export async function processAllowanceContract(
  contractId: string,
  latestLedger: number,
  notify: AllowanceRiskNotifier = defaultAllowanceRiskNotifier,
) {
  const lastSnapshot = await prisma.sorobanEventSnapshot.findFirst({
    where: {
      contractId,
      eventType: 'allowance_risk',
    },
    orderBy: { ledgerSeq: 'desc' },
    select: { ledgerSeq: true },
  });

  const startLedger = lastSnapshot
    ? lastSnapshot.ledgerSeq + 1
    : Math.max(1, latestLedger - DEFAULT_LOOKBACK_LEDGERS);

  if (startLedger > latestLedger) return;

  const events = await fetchContractEvents(contractId, startLedger);
  const assessments = detectAllowanceRisksFromEventBatch(events);

  for (const assessment of assessments) {
    try {
      // Snapshot the risk event to avoid duplicate notifications
      await prisma.sorobanEventSnapshot.create({
        data: {
          contractId: assessment.contractId,
          from: assessment.from,
          to: assessment.spender,
          amount: assessment.amount,
          ledgerSeq: assessment.liveUntilLedger,
          eventType: 'allowance_risk',
        },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        // Duplicate - already processed, skip notification
        continue;
      }
      console.error(
        `[AllowanceSentinel] Failed to persist allowance risk snapshot for ${contractId}:`,
        error?.message || error,
      );
      continue;
    }

    await notify(assessment);
  }
}

/**
 * Runs a single pass over all watched contracts for allowance risks.
 */
export async function runAllowanceSentinelPass(
  notify: AllowanceRiskNotifier = defaultAllowanceRiskNotifier,
) {
  let contractIds = getAllowanceWatchedContractIds();

  // Fall back to active Soroban contract subscriptions if no env override
  if (contractIds.length === 0) {
    const subscriptions = await prisma.sorobanContractSubscription.findMany({
      where: { isActive: true, topic: { in: ['approve', 'allowance'] } },
      select: { contractId: true },
    });
    for (const subscription of subscriptions) {
      if (!contractIds.includes(subscription.contractId)) {
        contractIds.push(subscription.contractId);
      }
    }
  }

  if (contractIds.length === 0) return;

  const latestLedger = await getSorobanLatestLedger();
  if (latestLedger === 0) {
    console.warn('[AllowanceSentinel] Could not fetch latest Soroban ledger this pass, skipping');
    return;
  }

  for (const contractId of contractIds) {
    try {
      await processAllowanceContract(contractId, latestLedger, notify);
    } catch (error: any) {
      console.error(
        `[AllowanceSentinel] Failed to process contract ${contractId}:`,
        error?.message || error,
      );
    }
  }
}

/**
 * Main entry point for the Allowance Sentinel watcher worker.
 * Polls watched contracts at regular intervals for allowance risks.
 */
export async function runAllowanceSentinel() {
  console.log('[AllowanceSentinel] 🚀 Starting Token Allowance & Spender Approval Risk Sentinel...');

  const poll = async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
      await runAllowanceSentinelPass();
    } catch (error: any) {
      console.error('[AllowanceSentinel] Polling error:', error?.message || error);
    } finally {
      isProcessing = false;
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runAllowanceSentinel();
}
