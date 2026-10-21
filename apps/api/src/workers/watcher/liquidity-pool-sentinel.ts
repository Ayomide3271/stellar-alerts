import { prisma } from '../../lib/prisma';
import {
  fetchContractEvents,
  getSorobanLatestLedger,
} from '../../lib/soroban';
import {
  decodeScAddress,
  decodeScAmount,
  formatTokenAmount,
} from '../../lib/stellar';
import * as StellarSdk from 'stellar-sdk';
import { registerSupervisorHeartbeat } from '../supervisor';

// #717: Soroban AMM Liquidity Pool Deposit & Withdrawal Event Sentinel.
// Decodes `deposit_liquidity` / `withdraw_liquidity` events emitted by
// Soroswap/Phoenix-style constant-product AMM contracts, computes the
// resulting pool share and reserve movement, and dispatches alerts when the
// liquidity shift crosses configured thresholds (whale deposits / withdrawals
// that dilute LP positions and spike volatility).

const TAG = '[LiquidityPoolSentinel]';
const POLL_INTERVAL_MS = 30_000;
const DEFAULT_LOOKBACK_LEDGERS = 100;

/**
 * Liquidity delta (as a percentage of pool reserves) above which a shift
 * triggers a WARNING.  A 10% deposit/withdrawal in one event is whale-scale
 * for an AMM pool and will meaningfully dilute existing LPs.
 */
const WARNING_SHIFT_THRESHOLD_PCT = Number(
  process.env.LIQUIDITY_SENTINEL_WARNING_SHIFT_THRESHOLD_PCT || '10',
);

/**
 * Liquidity delta percentage above which a CRITICAL alert fires.
 * Defaults to 25% — a quarter of the pool's reserves moving in one event.
 */
const CRITICAL_SHIFT_THRESHOLD_PCT = Number(
  process.env.LIQUIDITY_SENTINEL_CRITICAL_SHIFT_THRESHOLD_PCT || '25',
);

const TOPIC_VARIANTS = {
  deposit: new Set(['deposit_liquidity', 'deposit', 'deposit_lp']),
  withdraw: new Set(['withdraw_liquidity', 'withdraw', 'withdraw_lp']),
} as const;

export type LiquidityOperationType = 'DEPOSIT' | 'WITHDRAW';

export type LiquidityShiftSeverity = 'OK' | 'WARNING' | 'CRITICAL';

/** Raw event decode result, with ledger-scale granularity (bigint units). */
export interface ParsedLiquidityPoolEvent {
  contractId: string;
  eventType: LiquidityOperationType;
  /** LP provider who deposited into / withdrew from the pool. */
  sender: string;
  tokenA: string;
  tokenB: string;
  /** Human-readable (7-decimals) amounts of token A / B moved. */
  amountA: string;
  amountB: string;
  rawAmountA: bigint;
  rawAmountB: bigint;
  /** LP shares minted (deposit) or burned (withdrawal), when the contract reports them. */
  rawLpTokens?: bigint;
  /** Contract-reported total LP share supply after the operation. */
  rawTotalShares?: bigint;
  /** Contract-reported token reserve balances after the operation. */
  rawReserveA?: bigint;
  rawReserveB?: bigint;
  ledgerSeq?: number;
  txHash?: string;
}

/** Pool share and reserve movement computed from a parsed liquidity event. */
export interface LiquidityShiftMetrics {
  /** Sender's share of the pool after the operation (percent, 0-100). */
  poolSharePct: number;
  /** Sender's share of the pool before the operation (percent). */
  poolSharePctBefore: number;
  /** Absolute change in the sender's pool share caused by this event. */
  poolShareDeltaPct: number;
  /** Signed percent change in token A reserves (positive = increase). */
  reserveChangeAPct: number;
  /** Signed percent change in token B reserves (positive = increase). */
  reserveChangeBPct: number;
  /** Magnitude of the largest single-side reserve movement (percent). */
  shiftPct: number;
}

/** Full assessment: metrics + severity + alert copy. */
export interface LiquidityShiftAssessment {
  event: 'soroban.liquidity_pool_shift';
  contractId: string;
  eventType: LiquidityOperationType;
  sender: string;
  tokenA: string;
  tokenB: string;
  amountA: string;
  amountB: string;
  metrics: LiquidityShiftMetrics;
  severity: LiquidityShiftSeverity;
  message: string;
  ledgerSeq?: number;
  txHash?: string;
}

export interface LiquidityPoolSentinelOptions {
  warningShiftThresholdPct?: number;
  criticalShiftThresholdPct?: number;
}

/** Engine that turns parsed liquidity events into severity-rated assessments. */
export class LiquidityPoolSentinelEngine {
  readonly warningShiftThresholdPct: number;
  readonly criticalShiftThresholdPct: number;

  constructor(options: LiquidityPoolSentinelOptions = {}) {
    this.warningShiftThresholdPct = options.warningShiftThresholdPct ?? WARNING_SHIFT_THRESHOLD_PCT;
    this.criticalShiftThresholdPct = options.criticalShiftThresholdPct ?? CRITICAL_SHIFT_THRESHOLD_PCT;
  }

  /**
   * Computes pool-share and reserve deltas for a parsed liquidity event.
   *
   * Reserves: when the contract reports post-op reserves we derive the
   * pre-operation balance from the event direction; otherwise the shift is
   * estimated from the LP share delta against reported total supply.
   */
  public computeMetrics(parsed: ParsedLiquidityPoolEvent): LiquidityShiftMetrics {
    const lpTokens = parsed.rawLpTokens ?? 0n;
    const totalSharesAfter = parsed.rawTotalShares ?? 0n;

    // Post-op share of the sender when the contract reports the sender's
    // resulting share balance; for one-off events we approximate the sender's
    // post-op share as the freshly minted/burned LP tokens vs total supply.
    const poolSharePct = totalSharesAfter > 0n
      ? Number((lpTokens * 1_000_000n) / totalSharesAfter) / 10_000
      : 0;

    const totalSharesBefore =
      parsed.eventType === 'DEPOSIT'
        ? totalSharesAfter - lpTokens
        : totalSharesAfter + lpTokens;
    const poolSharePctBefore = totalSharesBefore > 0n
      ? Number((lpTokens * 1_000_000n) / totalSharesBefore) / 10_000
      : 0;

    const { reserveChangeAPct, reserveChangeBPct } = this.computeReserveChanges(parsed);

    // Primary signal: post-op reserve movement. When the contract doesn't
    // report reserves, fall back to the LP share delta vs. total supply.
    const hasReserveData = parsed.rawReserveA !== undefined || parsed.rawReserveB !== undefined;
    const shareDeltaFallbackPct =
      totalSharesAfter > 0n && lpTokens > 0n
        ? Number((lpTokens * 100n) /
            (parsed.eventType === 'DEPOSIT'
              ? totalSharesAfter
              : totalSharesAfter + lpTokens))
        : 0;
    const shiftPct = hasReserveData
      ? Math.max(Math.abs(reserveChangeAPct), Math.abs(reserveChangeBPct))
      : shareDeltaFallbackPct;

    return {
      poolSharePct: round(poolSharePct, 4),
      poolSharePctBefore: round(poolSharePctBefore, 4),
      poolShareDeltaPct: round(poolSharePct - poolSharePctBefore, 4),
      reserveChangeAPct: round(reserveChangeAPct, 4),
      reserveChangeBPct: round(reserveChangeBPct, 4),
      shiftPct: round(shiftPct, 4),
    };
  }

  private computeReserveChanges(parsed: ParsedLiquidityPoolEvent): {
    reserveChangeAPct: number;
    reserveChangeBPct: number;
  } {
    const change = (reserveAfter?: bigint, moved?: bigint): number => {
      if (reserveAfter === undefined || moved === undefined || moved <= 0n) return 0;
      // Pre-op balance inferred from the event direction.
      const reserveBefore =
        parsed.eventType === 'DEPOSIT' ? reserveAfter - moved : reserveAfter + moved;
      if (reserveBefore <= 0n) return 100;
      return Number(((moved * 100_000n) / reserveBefore)) / 1000 *
        (parsed.eventType === 'DEPOSIT' ? 1 : -1);
    };

    return {
      reserveChangeAPct: change(parsed.rawReserveA, parsed.rawAmountA),
      reserveChangeBPct: change(parsed.rawReserveB, parsed.rawAmountB),
    };
  }

  /**
   * Assesses a parsed liquidity event. Returns null when the shift is well
   * below the WARNING threshold (severity OK ⇒ no alert).
   */
  public assessLiquidityEvent(parsed: ParsedLiquidityPoolEvent): LiquidityShiftAssessment | null {
    const metrics = this.computeMetrics(parsed);
    const severity = this.classify(metrics.shiftPct);
    if (severity === 'OK') return null;

    const direction =
      parsed.eventType === 'DEPOSIT' ? 'deposit into' : 'withdrawal from';
    const message =
      `Large liquidity ${direction} pool ${parsed.contractId.slice(0, 12)}…: ` +
      `${parsed.amountA} / ${parsed.amountB} (${metrics.shiftPct.toFixed(2)}% of reserves) ` +
      `by ${parsed.sender.slice(0, 12)}… — pool share now ${metrics.poolSharePct.toFixed(4)}%.`;

    return {
      event: 'soroban.liquidity_pool_shift',
      contractId: parsed.contractId,
      eventType: parsed.eventType,
      sender: parsed.sender,
      tokenA: parsed.tokenA,
      tokenB: parsed.tokenB,
      amountA: parsed.amountA,
      amountB: parsed.amountB,
      metrics,
      severity,
      message,
      ledgerSeq: parsed.ledgerSeq,
      txHash: parsed.txHash,
    };
  }

  private classify(shiftPct: number): LiquidityShiftSeverity {
    if (shiftPct >= this.criticalShiftThresholdPct) return 'CRITICAL';
    if (shiftPct >= this.warningShiftThresholdPct) return 'WARNING';
    return 'OK';
  }
}

function round(value: number, dp: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// ── ScVal decoding ─────────────────────────────────────────────────────────

/**
 * Flattens a decoded ScVal native value into a string when meaningful:
 * symbols/strings come back as strings, addresses as `{ address }` objects.
 */
function nativeToString(native: unknown): string | null {
  if (typeof native === 'string' && native) return native;
  if (native && typeof native === 'object') {
    const address = (native as { address?: unknown }).address;
    if (typeof address === 'string' && address) return address;
  }
  return null;
}

/**
 * Decodes one event topic entry (the emit-side ScVal symbols plus decoded
 * strings / simple shapes returned by `getEvents`) into a plain string.
 * Handles plain strings, `{ symbol: 'x' }` decoded shapes and base64-XDR
 * ScVal blobs; address-shaped entries are flattened via nativeToString.
 */
export function decodeTopicValue(topicEntry: any): string | null {
  if (topicEntry === null || topicEntry === undefined) return null;

  if (typeof topicEntry === 'string') {
    const fromXdr = decodeXdrTopicString(topicEntry);
    if (fromXdr !== null) return fromXdr;
    return topicEntry;
  }

  if (typeof topicEntry === 'object') {
    if (typeof topicEntry.symbol === 'string' && topicEntry.symbol) {
      return topicEntry.symbol;
    }
    if (
      (topicEntry.type === 'symbol' || topicEntry.type === 'string') &&
      typeof topicEntry.value === 'string'
    ) {
      return topicEntry.value;
    }
    try {
      const fromNative = nativeToString(StellarSdk.scValToNative(topicEntry));
      if (fromNative) return fromNative;
    } catch {
      // Fall through — best-effort decoding only.
    }
  }

  return null;
}

/** Best-effort decode of a base64-XDR ScVal topic entry into a symbol/string. */
function decodeXdrTopicString(topicEntry: string): string | null {
  if (topicEntry.length === 0 || topicEntry.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(topicEntry)) return null;
  try {
    const scVal = StellarSdk.xdr.ScVal.fromXDR(topicEntry, 'base64');
    const fromNative = nativeToString(StellarSdk.scValToNative(scVal));
    if (fromNative) return fromNative;
  } catch {
    return null;
  }
  return null;
}

export const liquidityPoolSentinelEngine = new LiquidityPoolSentinelEngine();

/** Retrieves a numeric field accepting the common SCVal payload variants,
 *  including base64-XDR i128 ScVal blobs and plain numeric strings. */
function toRawAmount(value: any, record: Record<string, any>): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const fromXdr = tryDecodeXdrAmount(value);
    if (fromXdr !== undefined) return fromXdr;
  }
  return decodeScAmount(value) ?? undefined;
}

/** Best-effort decode of a base64-XDR ScVal amount blob into a bigint. */
function tryDecodeXdrAmount(entry: string): bigint | undefined {
  if (entry.length === 0 || entry.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(entry)) return undefined;
  try {
    const scVal = StellarSdk.xdr.ScVal.fromXDR(entry, 'base64');
    const native = StellarSdk.scValToNative(scVal);
    if (typeof native === 'bigint') return native;
    if (typeof native === 'number' && Number.isFinite(native)) {
      return BigInt(Math.trunc(native));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** First defined numeric candidate from a list of payload field names. */
function fieldAmount(record: Record<string, any>, keys: string[]): bigint | undefined {
  for (const key of keys) {
    const raw = toRawAmount(record[key], record);
    if (raw !== undefined) return raw;
  }
  return undefined;
}

/** First defined string candidate from a list of payload field names. */
function fieldAddress(record: Record<string, any>, keys: string[]): string {
  for (const key of keys) {
    const decoded = decodeScAddress(record[key]);
    if (decoded) return decoded;
  }
  return '';
}

/** Pulls (amountA, amountB) out of either `amount_a`/`amount_b` fields or an
 *  `amounts` / `to`-style pair payload used by Phoenix/Soroswap contracts. */
function extractPairAmounts(record: Record<string, any>): {
  rawAmountA: bigint | undefined;
  rawAmountB: bigint | undefined;
} {
  const directA = fieldAmount(record, [
    'amount_a', 'amountA', 'amounts_a', 'amountsA',
  ]);
  const directB = fieldAmount(record, [
    'amount_b', 'amountB', 'amounts_b', 'amountsB',
  ]);

  if (directA !== undefined && directB !== undefined) {
    return { rawAmountA: directA, rawAmountB: directB };
  }

  // Phoenix-style aggregated `amounts: [a, b]` / `amounts: { asset0, asset1 }`.
  const amountsField = record.amounts ?? record.token_amounts ?? record.reserves_during;
  if (Array.isArray(amountsField)) {
    const a = toRawAmount(amountsField[0], record);
    const b = toRawAmount(amountsField[1], record);
    return { rawAmountA: a, rawAmountB: b };
  }
  if (amountsField && typeof amountsField === 'object') {
    return {
      rawAmountA: fieldAmount(amountsField, ['asset0', 'amount_a']) ?? undefined,
      rawAmountB: fieldAmount(amountsField, ['asset1', 'amount_b']) ?? undefined,
    };
  }

  return { rawAmountA: directA, rawAmountB: directB };
}

/**
 * Decodes a raw Soroban RPC event into an AMM liquidity pool operation, if it
 * carries a `deposit_liquidity` / `withdraw_liquidity` topic. Contracts vary
 * between emitting amounts in the event data (`amount_a` / `amount_b`, often
 * i128 XDR blobs) and in an `amounts` array, and between locating the provider
 * and token addresses in the topics and in the value — all common shapes are
 * accepted.
 *
 * Returns null for any event that isn't a liquidity op or is missing amounts.
 */
export function parseLiquidityPoolEvent(event: any): ParsedLiquidityPoolEvent | null {
  if (!event?.topic || !Array.isArray(event.topic) || event.topic.length === 0) {
    return null;
  }

  const action = decodeTopicValue(event.topic[0]);
  if (!action) return null;

  const eventType: LiquidityOperationType = TOPIC_VARIANTS.deposit.has(action.trim())
    ? 'DEPOSIT'
    : TOPIC_VARIANTS.withdraw.has(action.trim())
      ? 'WITHDRAW'
      : (null as never);
  if (!eventType) return null;

  const contractId = typeof event.contractId === 'string' ? event.contractId : '';
  const value: Record<string, any> = (event.value ?? event.data ?? {}) as Record<string, any>;
  if (typeof value !== 'object' || value === null) return null;

  const { rawAmountA, rawAmountB } = extractPairAmounts(value);
  if (rawAmountA === undefined && rawAmountB === undefined) return null;

  // Provider: value field first, then the second topic (symbol/address ScVal).
  const sender =
    fieldAddress(value, ['sender', 'provider', 'user', 'from', 'to']) ||
    decodeTopicValue(event.topic[1]) ||
    '';

  const tokenA =
    fieldAddress(value, ['token_a', 'tokenA', 'asset_a', 'assetA', 'token0']) ||
    decodeTopicValue(event.topic[2]) ||
    '';
  const tokenB =
    fieldAddress(value, ['token_b', 'tokenB', 'asset_b', 'assetB', 'token1']) ||
    decodeTopicValue(event.topic[3]) ||
    '';

  const rawLpTokens = fieldAmount(value, [
    'shares_minted', 'lp_amount', 'lp_tokens', 'lp', 'shares',
    'shares_burned', 'unwrapped_share', 'issued_shares',
  ]);
  const rawTotalShares = fieldAmount(value, [
    'total_shares', 'totalShares', 'total_supply', 'share_supply',
  ]);
  const rawReserveA = fieldAmount(value, ['reserve_a', 'reserveA', 'reserves_a']);
  const rawReserveB = fieldAmount(value, ['reserve_b', 'reserveB', 'reserves_b']);

  return {
    contractId,
    eventType,
    sender,
    tokenA,
    tokenB,
    amountA: formatTokenAmount(rawAmountA ?? 0n),
    amountB: formatTokenAmount(rawAmountB ?? 0n),
    rawAmountA: rawAmountA ?? 0n,
    rawAmountB: rawAmountB ?? 0n,
    rawLpTokens,
    rawTotalShares,
    rawReserveA,
    rawReserveB,
    ledgerSeq: event.ledgerSeq ?? event.ledger ?? undefined,
    txHash: event.txHash ?? event.transactionHash ?? undefined,
  };
}

// ── Notification + worker loop ─────────────────────────────────────────────

export type LiquidityShiftNotifier = (assessment: LiquidityShiftAssessment) => Promise<void> | void;

export const defaultLiquidityShiftNotifier: LiquidityShiftNotifier = (assessment) => {
  const tag = assessment.severity === 'CRITICAL' ? '🚨' : '⚠️';
  console.log(
    `${TAG} ${tag} [${assessment.severity}] ${assessment.eventType} ` +
    `${assessment.contractId.slice(0, 8)}… shift=${assessment.metrics.shiftPct.toFixed(2)}% ` +
    `poolShare=${assessment.metrics.poolSharePct.toFixed(4)}% - ${assessment.message}`,
  );
};

/**
 * Processes an event batch and returns assessments sorted by severity.
 */
export function detectLiquidityShiftsFromEventBatch(
  events: any[],
  engine: LiquidityPoolSentinelEngine = liquidityPoolSentinelEngine,
): LiquidityShiftAssessment[] {
  const assessments: LiquidityShiftAssessment[] = [];

  for (const rawEvent of events) {
    const parsed = parseLiquidityPoolEvent(rawEvent);
    if (!parsed) continue;

    const assessment = engine.assessLiquidityEvent(parsed);
    if (assessment) assessments.push(assessment);
  }

  const severityOrder: Record<LiquidityShiftSeverity, number> = {
    CRITICAL: 0,
    WARNING: 1,
    OK: 2,
  };
  return assessments.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}

/** Contract IDs to poll, from env; falls back to AMM-liquidity subscriptions. */
export function getLiquidityWatchedContractIds(): string[] {
  return (process.env.LIQUIDITY_SENTINEL_CONTRACT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Processes a single AMM contract for liquidity shifts: fetches events since
 * the last snapshot, assesses them, dedupes via snapshot rows and notifies.
 */
export async function processLiquidityContract(
  contractId: string,
  latestLedger: number,
  notify: LiquidityShiftNotifier = defaultLiquidityShiftNotifier,
  engine: LiquidityPoolSentinelEngine = liquidityPoolSentinelEngine,
) {
  const lastSnapshot = await prisma.sorobanEventSnapshot.findFirst({
    where: { contractId, eventType: 'liquidity_pool_shift' },
    orderBy: { ledgerSeq: 'desc' },
    select: { ledgerSeq: true },
  });

  const startLedger = lastSnapshot
    ? lastSnapshot.ledgerSeq + 1
    : Math.max(1, latestLedger - DEFAULT_LOOKBACK_LEDGERS);

  if (startLedger > latestLedger) return;

  const events = await fetchContractEvents(contractId, startLedger);
  const assessments = detectLiquidityShiftsFromEventBatch(events, engine);

  for (const assessment of assessments) {
    try {
      await prisma.sorobanEventSnapshot.create({
        data: {
          contractId: assessment.contractId,
          from: assessment.sender,
          to: null as never,
          amount: assessment.metrics.shiftPct.toString(),
          ledgerSeq: assessment.ledgerSeq ?? latestLedger,
          eventType: 'liquidity_pool_shift',
        },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') continue; // Already processed.
      console.error(
        `${TAG} Failed to persist liquidity shift snapshot for ${contractId}:`,
        error?.message || error,
      );
      continue;
    }

    await notify(assessment);
  }
}

/** Runs a single pass over every watched AMM contract. */
export async function runLiquidityPoolSentinelPass(
  notify: LiquidityShiftNotifier = defaultLiquidityShiftNotifier,
  engine: LiquidityPoolSentinelEngine = liquidityPoolSentinelEngine,
) {
  let contractIds = getLiquidityWatchedContractIds();

  if (contractIds.length === 0) {
    const subscriptions = await prisma.sorobanContractSubscription.findMany({
      where: {
        isActive: true,
        topic: {
          in: [
            'deposit_liquidity', 'deposit',
            'withdraw_liquidity', 'withdraw',
          ],
        },
      },
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
    console.warn(`${TAG} Could not fetch latest Soroban ledger this pass, skipping`);
    return;
  }

  for (const contractId of contractIds) {
    try {
      await processLiquidityContract(contractId, latestLedger, notify, engine);
    } catch (error: any) {
      console.error(`${TAG} Failed to process contract ${contractId}:`, error?.message || error);
    }
  }
}

/** Main entry point for the liquidity pool sentinel watcher worker. */
export async function runLiquidityPoolSentinel() {
  console.log(`${TAG} 🚀 Starting Soroban AMM Liquidity Pool Deposit & Withdrawal Sentinel...`);

  let isProcessing = false;
  const poll = async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
      await runLiquidityPoolSentinelPass();
    } catch (error: any) {
      console.error(`${TAG} Polling error:`, error?.message || error);
    } finally {
      isProcessing = false;
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runLiquidityPoolSentinel();
}
