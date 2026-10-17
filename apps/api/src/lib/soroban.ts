import * as StellarSdk from 'stellar-sdk';
import { getJson, setJson, getSacMetadataCacheKey, SAC_METADATA_TTL } from './cache';
import { formatTokenAmount } from './stellar';
import { env } from '../config/env';

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const STELLAR_NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;

export const sorobanServer = new (StellarSdk as any).rpc.Server(
  SOROBAN_RPC_URL,
  { timeout: env.SOROBAN_RPC_TIMEOUT_MS },
);

export interface ParsedSorobanTransfer {
  contractId: string;
  from: string;
  to: string;
  amount: string;
  topic: string;
  ledgerSeq?: number;
}

export interface ContractRegistry {
  contractId: string;
  topicRoutes: Map<string, string[]>;
  lastPolled?: number;
}

// In-memory registry for fast topic routing
const contractRegistry = new Map<string, ContractRegistry>();

/**
 * Loads active Soroban contract subscriptions into in-memory registry.
 * Maintains up to MAX_ACTIVE_CONTRACTS contracts.
 */
export async function loadContractRegistry(): Promise<
  Map<string, ContractRegistry>
> {
  try {
    const subscriptions = await prisma.sorobanContractSubscription.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: MAX_ACTIVE_CONTRACTS,
    });

    contractRegistry.clear();

    // Group by contractId
    const grouped = new Map<string, Map<string, Set<string>>>();

    for (const sub of subscriptions) {
      if (!grouped.has(sub.contractId)) {
        grouped.set(sub.contractId, new Map());
      }

      const topicMap = grouped.get(sub.contractId)!;
      const topic = sub.topic || "default";

      if (!topicMap.has(topic)) {
        topicMap.set(topic, new Set());
      }

      topicMap.get(topic)!.add(sub.userId);
    }

    // Convert to registry format
    for (const [contractId, topicMap] of grouped.entries()) {
      const topicRoutes = new Map<string, string[]>();

      for (const [topic, userIds] of topicMap.entries()) {
        topicRoutes.set(topic, Array.from(userIds));
      }

      contractRegistry.set(contractId, {
        contractId,
        topicRoutes,
        lastPolled: Date.now(),
      });
    }

    console.log(
      `[Registry] Loaded ${contractRegistry.size} active contracts (${subscriptions.length} subscriptions)`,
    );
    return contractRegistry;
  } catch (error: any) {
    console.error("[Registry] Error loading contract registry:", error.message);
    return contractRegistry;
  }
}

/**
 * Routes an event to matching subscribed users based on contract ID and topic.
 *
 * Accepts a typed `SorobanRpcEvent` instead of `any`, so callers are
 * required to pass a well-shaped event object at compile time.
 */
export function routeEventToUsers(
  event: SorobanRpcEvent,
): { contractId: string; topic: string; userIds: string[] }[] {
  const routes: { contractId: string; topic: string; userIds: string[] }[] = [];
  const contractId = event.contractId;

  if (!contractId) return routes;

  const contract = contractRegistry.get(contractId);
  if (!contract) return routes;

  // Determine topic from event.  The first element of the raw topic array
  // is conventionally the event name symbol (e.g. "transfer"); fall back
  // to "default" for events with an empty or missing topic array.
  const firstTopic = Array.isArray(event.topic) ? event.topic[0] : undefined;
  const topic =
    (typeof firstTopic === 'string'
      ? firstTopic
      : typeof firstTopic === 'object' &&
        firstTopic !== null &&
        'symbol' in firstTopic
      ? String((firstTopic as { symbol: unknown }).symbol)
      : null) ?? 'default';

  // Check for exact topic match
  let matchedUserIds = contract.topicRoutes.get(topic);

  // Fall back to 'default' topic if no exact match
  if (!matchedUserIds || matchedUserIds.length === 0) {
    matchedUserIds = contract.topicRoutes.get("default");
  }

  if (matchedUserIds && matchedUserIds.length > 0) {
    routes.push({
      contractId,
      topic,
      userIds: matchedUserIds,
    });
  }

  return routes;
}

/**
 * Gets all active contract IDs from registry.
 */
export function getActiveContractIds(): string[] {
  return Array.from(contractRegistry.keys());
}

/**
 * Gets contract subscriber count for a specific contract.
 */
export function getContractSubscriberCount(contractId: string): number {
  const contract = contractRegistry.get(contractId);
  if (!contract) return 0;

  let total = 0;
  for (const userIds of contract.topicRoutes.values()) {
    total += userIds.length;
  }

  return total;
}

export interface SacMetadata {
  contractId: string;
  name: string;
  symbol: string;
  decimals: number;
}

/**
 * Fetches latest ledger sequence from Soroban RPC endpoint.
 */
export interface SorobanContractStateProofInput {
  /** Base64-encoded XDR of the ledger entry's key (xdr.LedgerKey). */
  ledgerKeyXdr: string;
  /** Base64-encoded XDR of the ledger entry's value (xdr.LedgerEntryData). */
  ledgerEntryXdr: string;
  /** Inclusion proof path from the entry's leaf hash up to the ledger's state root. */
  proof: MerkleProofStep[];
  /**
   * Hex-encoded state root to verify against — the target ledger header's
   * bucketListHash (xdr.LedgerHeader.bucketListHash), the Stellar protocol's
   * cryptographic commitment to the full ledger state at that ledger.
   */
  ledgerStateRoot: string;
}

/**
 * Computes the canonical Merkle leaf hash for a Soroban contract storage
 * entry: the SHA-256 (leaf-domain-separated) hash of its key XDR
 * concatenated with its value XDR. Binding both means the proof commits to
 * the *exact* stored value, not just the fact that some value exists for
 * that key.
 */
export function hashSorobanLedgerEntry(ledgerKeyXdr: string, ledgerEntryXdr: string): string {
  const keyBytes = Buffer.from(ledgerKeyXdr, "base64");
  const entryBytes = Buffer.from(ledgerEntryXdr, "base64");
  return hashMerkleLeaf(Buffer.concat([keyBytes, entryBytes]));
}

/**
 * Cryptographically verifies that a Soroban contract storage entry is
 * included in a ledger's state, given an inclusion proof and that ledger's
 * state root — without needing to run a full node. Never throws: any
 * malformed input (bad base64/XDR, malformed proof, wrong root format)
 * simply fails verification.
 */
export function verifySorobanContractStateProof(input: SorobanContractStateProofInput): boolean {
  try {
    const leafHash = hashSorobanLedgerEntry(input.ledgerKeyXdr, input.ledgerEntryXdr);
    return verifyMerkleProof({ leafHash, path: input.proof }, input.ledgerStateRoot);
  } catch {
    return false;
  }
}

export interface SorobanLedgerEntrySnapshot {
  key: string;
  value: unknown;
}

/**
 * Fetches contract storage entries at a ledger and records JSON state diffs.
 * RPC errors are allowed to propagate so callers can retry the ledger.
 */
export async function snapshotContractState(
  contractId: string,
  ledgerSeq: number,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? env.SOROBAN_RPC_TIMEOUT_MS;
  const response: any = await withDeadline(
    () => sorobanServer.getLedgerEntries([getContractInstanceLedgerKey(contractId)]),
    timeoutMs,
    options.signal,
    'Soroban RPC getLedgerEntries',
  );
  const entries = response.entries || [];
  let recorded = 0;

  for (const entry of entries) {
    const ledgerKey = typeof entry.key === 'string' ? entry.key : JSON.stringify(entry.key);
    const snapshot = (typeof entry.val === 'string' ? { value: entry.val } : entry.val) as any;
    await sorobanStateService.recordSnapshot({ contractId, ledgerKey, ledgerSeq, snapshot });
    recorded++;
  }
  return recorded;
}

export async function getSorobanLatestLedger(
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? env.SOROBAN_RPC_TIMEOUT_MS;
  try {
    const health: any = await withDeadline(
      () => sorobanServer.getLatestLedger(),
      timeoutMs,
      options.signal,
      'Soroban RPC getLatestLedger',
    );
    return health.sequence;
  } catch (error: any) {
    console.warn(
      `[SorobanRPC] Could not fetch latest ledger: ${error.message}`,
    );
    return 0;
  }
}

/**
 * Fetches contract events from Soroban RPC for a specific contract address.
 */
export async function fetchContractEvents(
  contractId: string,
  startLedger: number,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<any[]> {
  const timeoutMs = options.timeoutMs ?? env.SOROBAN_RPC_TIMEOUT_MS;
  try {
    const response: any = await withDeadline(
      () =>
        sorobanServer.getEvents({
          startLedger,
          filters: [
            {
              type: "contract",
              contractIds: [contractId],
            },
          ],
        }),
      timeoutMs,
      options.signal,
      'Soroban RPC getEvents',
    );
    return response.events || [];
  } catch (error: any) {
    console.error(
      `[SorobanRPC] Error fetching contract events for ${contractId}:`,
      error.message,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Issue #43 – State Snapshot & Historical Event Backfill
// ---------------------------------------------------------------------------

export interface SorobanStateSnapshot {
  contractId: string;
  ledgerSequence: number;
  capturedAt: string; // ISO timestamp
  keyCount: number;
  entries: Array<{ key: string; value: string; durability: 'persistent' | 'temporary' }>;
}

/**
 * Captures a state snapshot of a Soroban contract by fetching all
 * ledger entries for the given contract ID at the current ledger.
 * Falls back gracefully if the RPC call fails.
 */
export async function captureContractSnapshot(
  contractId: string
): Promise<SorobanStateSnapshot> {
  const capturedAt = new Date().toISOString();
  const entries: SorobanStateSnapshot['entries'] = [];

  let ledgerSequence = 0;

  try {
    ledgerSequence = await getSorobanLatestLedger();

    // Build a ContractData ledger key for the contract's instance entry.
    // The stellar-sdk exposes xdr.LedgerKey.contractData(…) for this purpose.
    const xdr = (StellarSdk as any).xdr;

    const contractAddress = new (StellarSdk as any).Address(contractId);
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractAddress.toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );

    const response = await sorobanServer.getLedgerEntries(instanceKey);
    const rawEntries: any[] = response?.entries ?? [];

    for (const entry of rawEntries) {
      try {
        const keyXdr: string = entry.key?.toXDR?.('base64') ?? String(entry.key ?? '');
        const valXdr: string = entry.val?.toXDR?.('base64') ?? String(entry.val ?? '');
        const durability = _detectDurability(entry.key);
        entries.push({ key: keyXdr, value: valXdr, durability });
      } catch {
        // best-effort – skip unparseable entries
      }
    }
  } catch (error: any) {
    console.warn(
      `[SorobanRPC] captureContractSnapshot failed for ${contractId}: ${error?.message ?? error}`
    );
  }

  return {
    contractId,
    ledgerSequence,
    capturedAt,
    keyCount: entries.length,
    entries,
  };
}

export interface BackfillResult {
  contractId: string;
  startLedger: number;
  endLedger: number;
  eventsProcessed: number;
  errors: number;
}

/** Page size (ledgers) used when backfilling historical events. */
const BACKFILL_PAGE_SIZE = 100;

/**
 * Backfills historical Soroban contract events between startLedger and endLedger.
 * Processes events in pages of 100 ledgers and calls `onEvent` for each event.
 */
export async function backfillContractEvents(
  contractId: string,
  startLedger: number,
  endLedger: number,
  onEvent: (event: any) => Promise<void>
): Promise<BackfillResult> {
  let eventsProcessed = 0;
  let errors = 0;

  for (
    let pageStart = startLedger;
    pageStart <= endLedger;
    pageStart += BACKFILL_PAGE_SIZE
  ) {
    try {
      const events = await fetchContractEvents(contractId, pageStart);

      for (const event of events) {
        try {
          await onEvent(event);
          eventsProcessed++;
        } catch (handlerError: any) {
          console.error(
            `[SorobanRPC] backfillContractEvents handler error for ${contractId} at ledger ${pageStart}:`,
            handlerError?.message ?? handlerError
          );
          errors++;
        }
      }
    } catch (fetchError: any) {
      console.error(
        `[SorobanRPC] backfillContractEvents fetch error for ${contractId} at ledger ${pageStart}:`,
        fetchError?.message ?? fetchError
      );
      errors++;
    }
  }

  return {
    contractId,
    startLedger,
    endLedger,
    eventsProcessed,
    errors,
  };
}

// ---------------------------------------------------------------------------

/**
 * Fetches contract events within a ledger range with pagination.
 *
 * Each yielded batch contains `EnrichedSorobanEvent` objects — the raw RPC
 * records with a guaranteed `ledgerSeq` field so callers never have to
 * fall back to `(parsed as any).ledgerSeq`.
 */
export async function* fetchContractEventsInRange(
  contractId: string,
  startLedger: number,
  endLedger: number,
): AsyncGenerator<EnrichedSorobanEvent[]> {
  let currentStart = startLedger;

  while (currentStart <= endLedger) {
    const batchEnd = Math.min(currentStart + LEDGER_BATCH_SIZE, endLedger);

    try {
      console.log(
        `[SorobanRPC] Fetching events for ${contractId} from ledger ${currentStart} to ${batchEnd}`,
      );

      const response: any = await withDeadline(
        () =>
          sorobanServer.getEvents({
            startLedger: currentStart,
            endLedger: batchEnd,
            filters: [
              {
                type: "contract",
                contractIds: [contractId],
              },
            ],
          }),
        env.SOROBAN_RPC_TIMEOUT_MS,
        undefined,
        'Soroban RPC getEvents',
      );

      const events: SorobanRpcEvent[] = response.events || [];

      if (events.length > 0) {
        const enrichedEvents: EnrichedSorobanEvent[] = events.map((evt) => ({
          ...evt,
          // Guarantee a numeric ledgerSeq — evt.ledger is the authoritative
          // source; fall back to the batch start when the field is absent.
          ledgerSeq: evt.ledger ?? currentStart,
        }));
        yield enrichedEvents;
      }

      if (events.length > 0 && events[events.length - 1]?.ledger) {
        currentStart = (events[events.length - 1].ledger as number) + 1;
      } else {
        currentStart = batchEnd + 1;
      }

      if (events.length === 0) break;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[SorobanRPC] Error fetching events for ${contractId} in range [${currentStart}, ${batchEnd}]:`,
        errMsg,
      );
      currentStart = batchEnd + 1;
    }
  }
}

export interface ParsedSorobanSwap {
  contractId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  /**
   * Price impact of the swap as a percentage string (e.g. "2.35" = 2.35%),
   * taken directly from the event when the contract reports it. Null when
   * the event doesn't include enough pricing context to know it.
   */
  priceImpactPct: string | null;
  ledgerSeq?: number;
  txHash?: string;
}

function extractSwapTopicValue(topicEntry: any): string | null {
  if (typeof topicEntry === "string") return topicEntry;
  if (topicEntry && typeof topicEntry === "object") {
    if (typeof topicEntry.symbol === "string") {
      return topicEntry.symbol;
    }
    if (topicEntry.type === "symbol" && typeof topicEntry.value === "string") {
      return topicEntry.value;
    }
    if (topicEntry.type === "string" && typeof topicEntry.value === "string") {
      return topicEntry.value;
    }
  }
  return null;
}

function asAddressString(value: any): string {
  return decodeScAddress(value) ?? (typeof value === "string" ? value : "");
}

/**
 * Parses a raw Soroban RPC event into a DEX swap, if it looks like one.
 * Matches the `swap` topic emitted by Phoenix / Soroswap-style liquidity
 * pool contracts. The exact event shape varies slightly by DEX, so this
 * accepts a handful of common field name variants rather than committing to
 * one contract's ABI:
 *
 *   topic: ["swap", ...]
 *   value: {
 *     token_in | tokenIn | asset_in,
 *     token_out | tokenOut | asset_out,
 *     amount_in | amountIn,
 *     amount_out | amountOut,
 *     price_impact | priceImpact (optional, already a percentage),
 *   }
 *
 * Returns null for any event that isn't a swap or is missing the amounts
 * needed to describe one.
 */
export function parseSwapEvent(event: any): ParsedSorobanSwap | null {
  if (!event || !event.topic || event.topic.length === 0) {
    return null;
  }

  const action = extractSwapTopicValue(event.topic[0]);
  if (action !== "swap") {
    return null;
  }

  const value = event.value || event.data || {};

  const tokenIn = asAddressString(value.token_in ?? value.tokenIn ?? value.asset_in);
  const tokenOut = asAddressString(value.token_out ?? value.tokenOut ?? value.asset_out);

  const rawAmountIn = decodeScAmount(value.amount_in ?? value.amountIn);
  const rawAmountOut = decodeScAmount(value.amount_out ?? value.amountOut);

  if (rawAmountIn === null || rawAmountOut === null) {
    return null;
  }

  const rawPriceImpact = value.price_impact ?? value.priceImpact;
  const priceImpactPct =
    rawPriceImpact !== undefined && rawPriceImpact !== null && !Number.isNaN(Number(rawPriceImpact))
      ? String(rawPriceImpact)
      : null;

  return {
    contractId: event.contractId || "",
    tokenIn,
    tokenOut,
    amountIn: formatTokenAmount(rawAmountIn),
    amountOut: formatTokenAmount(rawAmountOut),
    priceImpactPct,
    ledgerSeq: event.ledgerSeq || event.ledger,
    txHash: event.txHash || event.transactionHash,
  };
}

/**
 * Parses raw Soroban RPC event data into a clean transfer object.
 */
export function parseSorobanTransferEvent(
  event: any,
): ParsedSorobanTransfer | null {
  if (!event || !event.topic || event.topic.length === 0) {
    return null;
  }

  const contractId = event.contractId || "";
  const topic = event.topic[0] || "";

  const value = event.value || {};
  const from = value.from || value.transfer?.from || "";
  const to = value.to || value.transfer?.to || "";
  const amount = value.amount ? String(value.amount) : "0";

  return {
    contractId,
    from,
    to,
    amount,
    topic,
    ledgerSeq: event.ledgerSeq || event.ledger,
  };
}

export interface ParsedSorobanMintBurn {
  contractId: string;
  eventType: 'MINT' | 'BURN';
  amount: string;
  rawAmount?: bigint;
  from: string;
  to: string;
  ledgerSeq?: number;
}

export function parseSorobanMintBurnEvent(event: any): ParsedSorobanMintBurn | null {
  if (!event?.topic?.length) return null;
  const topic = extractSwapTopicValue(event.topic[0]);
  if (topic !== 'mint' && topic !== 'burn') return null;

  const value = event.value ?? event.data ?? {};
  const contractId = event.contractId || '';
  const rawAmount = decodeScAmount(
    value.amount ?? value.mint?.amount ?? value.burn?.amount ?? value,
  );
  if (rawAmount === null) return null;

  const topicFrom = topic === 'burn' ? asAddressString(event.topic[1]) : '';
  const topicTo = topic === 'mint' ? asAddressString(event.topic[event.topic.length - 1]) : '';
  const from = asAddressString(value.from ?? value.burn?.from) || topicFrom;
  const to = asAddressString(value.to ?? value.mint?.to) || topicTo;

  return {
    contractId,
    eventType: topic === 'mint' ? 'MINT' : 'BURN',
    amount: formatTokenAmount(rawAmount),
    rawAmount,
    from,
    to,
    ledgerSeq: event.ledgerSeq ?? event.ledger,
  };
}

export interface ParsedSorobanApproval {
  contractId: string;
  from: string;
  spender: string;
  amount: string;
  rawAmount: bigint;
  liveUntilLedger: number;
  ledgerSeq?: number;
}

/**
 * Parses a raw Soroban RPC event into a SEP-41 token `approve` event, if it
 * looks like one. Topics: `["approve", from, spender]`. Data carries the new
 * allowance `amount` and the ledger it's valid through — contracts vary
 * between `live_until_ledger` (the field name in the SEP-41 reference
 * implementation) and `expiration_ledger` (seen in some earlier/custom
 * token contracts), so both are accepted.
 */
export function parseApprovalEvent(event: any): ParsedSorobanApproval | null {
  if (!event?.topic?.length) return null;
  const topic = extractSwapTopicValue(event.topic[0]);
  if (topic !== 'approve') return null;

  const value = event.value ?? event.data ?? {};
  const contractId = event.contractId || '';

  const rawAmount = decodeScAmount(value.amount ?? value.approve?.amount);
  if (rawAmount === null) return null;

  const from = asAddressString(value.from ?? value.approve?.from) || asAddressString(event.topic[1]);
  const spender =
    asAddressString(value.spender ?? value.approve?.spender) || asAddressString(event.topic[2]);

  const liveUntilRaw =
    value.live_until_ledger ??
    value.liveUntilLedger ??
    value.expiration_ledger ??
    value.expirationLedger ??
    value.approve?.live_until_ledger ??
    0;
  const liveUntilLedger = Number(liveUntilRaw) || 0;

  return {
    contractId,
    from: from || '',
    spender: spender || '',
    amount: formatTokenAmount(rawAmount),
    rawAmount,
    liveUntilLedger,
    ledgerSeq: event.ledgerSeq ?? event.ledger,
  };
}

/**
 * Helper to build the LedgerKey for a contract instance.
 */
export function getContractInstanceLedgerKey(contractId: string): StellarSdk.xdr.LedgerKey {
  const address = StellarSdk.Address.fromString(contractId);
  const scAddress = address.toScAddress();

  const contractDataKey = new StellarSdk.xdr.LedgerKeyContractData({
    contract: scAddress,
    key: StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: StellarSdk.xdr.ContractDataDurability.persistent(),
  });

  return StellarSdk.xdr.LedgerKey.contractData(contractDataKey);
}

/**
 * Extracts the WASM code hash from a contract instance LedgerEntryData.
 * Returns null if not a WASM contract or if parsing fails.
 */
export function getWasmHashFromContractInstance(val: StellarSdk.xdr.LedgerEntryData): Buffer | null {
  try {
    if (val.switch() === StellarSdk.xdr.LedgerEntryType.contractData()) {
      const contractData = val.contractData();
      const value = contractData.val();
      if (value.switch() === StellarSdk.xdr.ScValType.scvContractInstance()) {
        const instance = value.instance();
        const executable = instance.executable();
        if (executable.switch() === StellarSdk.xdr.ContractExecutableType.contractExecutableWasm()) {
          return executable.wasmHash();
        }
      }
    }
  } catch (error: any) {
    console.error("[Soroban] Failed to parse contract instance WASM hash:", error.message || error);
  }
  return null;
}

/**
 * Deterministic calculation of remaining TTL in ledgers.
 */
export function getRemainingTtl(liveUntilLedgerSeq: number, currentLedger: number): number {
  return liveUntilLedgerSeq - currentLedger;
}

/**
 * Deterministic helper to check if renewal is needed.
 */
export function shouldRenew(remainingTtl: number, threshold: number): boolean {
  return remainingTtl <= threshold;
}

export type FlashLoanOperationType = "borrow" | "repay" | "swap" | "transfer" | "invoke";

export interface SorobanTransactionOperationInput {
  id: string;
  parentId?: string;
  type: string;
  asset?: string;
  amount?: string | number | bigint;
  contractId?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string | number | bigint;
  amountOut?: string | number | bigint;
  profit?: string | number | bigint;
  fee?: string | number | bigint;
}

export interface FlashLoanOperationNode {
  id: string;
  parentId?: string;
  type: FlashLoanOperationType;
  asset: string;
  amount: bigint;
  amountFormatted: string;
  contractId?: string;
  children: FlashLoanOperationNode[];
}

export interface ParsedFlashLoanAlert {
  txHash: string;
  ledgerSeq?: number;
  contractId: string;
  borrowedAsset: string;
  borrowedAmount: string;
  feeAmount: string;
  netArbitrageProfit: string;
}

const FLASH_LOAN_BORROW_TOPICS = new Set(["borrow", "flash_loan", "loan", "flashloan"]);
const FLASH_LOAN_REPAY_TOPICS = new Set(["repay", "flash_repay", "repay_loan", "repay_flash_loan"]);

function normalizeOperationType(rawType: string): FlashLoanOperationType {
  const normalized = rawType.toLowerCase();
  if (FLASH_LOAN_BORROW_TOPICS.has(normalized)) return "borrow";
  if (FLASH_LOAN_REPAY_TOPICS.has(normalized)) return "repay";
  if (normalized === "swap") return "swap";
  if (normalized === "transfer") return "transfer";
  return "invoke";
}

function toBigIntAmount(value: string | number | bigint | undefined | null): bigint | null {
  if (value === undefined || value === null) return null;
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    const decoded = decodeScAmount(value);
    if (decoded !== null) return decoded;
    if (/^\d+$/.test(String(value))) return BigInt(String(value));
    return null;
  } catch {
    return null;
  }
}

function formatAmount(value: bigint): string {
  return formatTokenAmount(value);
}

/**
 * Parses a Soroban contract event into a normalized flash-loan operation node input.
 */
export function parseFlashLoanOperationFromEvent(event: any): SorobanTransactionOperationInput | null {
  if (!event?.topic?.length) return null;

  const topic = extractSwapTopicValue(event.topic[0]);
  if (!topic) return null;

  const normalized = topic.toLowerCase();
  if (
    !FLASH_LOAN_BORROW_TOPICS.has(normalized) &&
    !FLASH_LOAN_REPAY_TOPICS.has(normalized) &&
    normalized !== "swap" &&
    normalized !== "transfer"
  ) {
    return null;
  }

  const value = event.value || event.data || {};
  const contractId = event.contractId || value.contract_id || value.contractId;

  if (normalized === "swap") {
    const amountIn = decodeScAmount(value.amount_in ?? value.amountIn);
    const amountOut = decodeScAmount(value.amount_out ?? value.amountOut);
    if (amountIn === null || amountOut === null) return null;

    return {
      id: `${event.txHash || event.transactionHash || contractId || "swap"}:${event.id || event.eventIndex || `${value.token_in}-${value.token_out}`}`,
      parentId: value.parent_id || value.parentId,
      type: "swap",
      contractId,
      tokenIn: asAddressString(value.token_in ?? value.tokenIn ?? value.asset_in),
      tokenOut: asAddressString(value.token_out ?? value.tokenOut ?? value.asset_out),
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
    };
  }

  const asset = asAddressString(value.asset ?? value.token ?? value.currency);
  const amount = decodeScAmount(value.amount ?? value.borrowed_amount ?? value.repaid_amount);
  if (!asset || amount === null) return null;

  return {
    id: `${event.txHash || event.transactionHash || contractId}:${event.id || event.eventIndex || `${normalized}-${asset}`}`,
    parentId: value.parent_id || value.parentId,
    type: normalized,
    asset,
    amount: amount.toString(),
    contractId,
    fee: value.fee ?? value.flash_fee,
    profit: value.profit ?? value.arbitrage_profit ?? value.net_profit,
  };
}

/**
 * Simulates a read-only method invocation on a Soroban contract via RPC.
 */
export async function simulateContractCall(
  contractId: string,
  method: string,
  args: any[] = []
): Promise<any> {
  try {
    if (!contractId) return null;

    const contract = new StellarSdk.Contract(contractId);
    const op = contract.call(method, ...args);

    const dummySource = new StellarSdk.Account(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      '0'
    );

    const tx = new StellarSdk.TransactionBuilder(dummySource, {
      fee: '100',
      networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await sorobanServer.simulateTransaction(tx);

    if (!sim) {
      return null;
    }

    // Check if simulation was successful and has return value
    const retval = sim.result?.retval || (sim as any).retval;
    if (retval) {
      return StellarSdk.scValToNative(retval);
    }

    return null;
  } catch (error: any) {
    return null;
  }
}

/**
 * Queries SAC token metadata (decimals, symbol, name) from Soroban RPC.
 */
export async function fetchSacMetadataFromRpc(contractId: string): Promise<SacMetadata> {
  const fallback: SacMetadata = {
    contractId,
    name: 'Unknown Token',
    symbol: contractId ? contractId.substring(0, 8) : 'Unknown',
    decimals: 7,
  };

  if (!contractId) {
    return fallback;
  }

  try {
    // Query decimals, symbol, name via contract simulation in parallel
    const [decimalsVal, symbolVal, nameVal] = await Promise.all([
      simulateContractCall(contractId, 'decimals'),
      simulateContractCall(contractId, 'symbol'),
      simulateContractCall(contractId, 'name'),
    ]);

    let decimals = fallback.decimals;
    if (typeof decimalsVal === 'number' && Number.isInteger(decimalsVal) && decimalsVal >= 0) {
      decimals = decimalsVal;
    } else if (typeof decimalsVal === 'bigint') {
      decimals = Number(decimalsVal);
    } else if (typeof decimalsVal === 'string' && /^\d+$/.test(decimalsVal)) {
      decimals = parseInt(decimalsVal, 10);
    }

    const symbol =
      typeof symbolVal === 'string' && symbolVal.trim().length > 0
        ? symbolVal.trim()
        : fallback.symbol;

    const name =
      typeof nameVal === 'string' && nameVal.trim().length > 0
        ? nameVal.trim()
        : symbol !== fallback.symbol
        ? symbol
        : fallback.name;

    return {
      contractId,
      name,
      symbol,
      decimals,
    };
  } catch (error: any) {
    console.warn(`[SorobanRPC] Error fetching SAC metadata for contract ${contractId}:`, error.message);
    return fallback;
  }
}

/**
 * Retrieves SAC metadata from Redis cache (24h TTL) or discovers it from Soroban RPC.
 */
export async function getSacMetadata(
  contractId: string,
  forceRefresh: boolean = false
): Promise<SacMetadata> {
  if (!contractId) {
    return {
      contractId: '',
      name: 'Unknown Token',
      symbol: 'Unknown',
      decimals: 7,
    };
  }

  const cacheKey = getSacMetadataCacheKey(contractId);

  if (!forceRefresh) {
    const cached = await getJson<SacMetadata>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const metadata = await fetchSacMetadataFromRpc(contractId);
  await setJson(cacheKey, metadata, SAC_METADATA_TTL);
  return metadata;
}

/**
 * Formats a raw SAC amount into a human-readable string using the contract's discovered decimals.
 */
export async function formatSacAmountWithDiscovery(
  rawAmount: string | number | bigint,
  contractId: string
): Promise<{ formattedAmount: string; metadata: SacMetadata }> {
  const metadata = await getSacMetadata(contractId);
  const formattedAmount = formatTokenAmount(rawAmount, metadata.decimals);
  return {
    formattedAmount,
    metadata,
  };
}
