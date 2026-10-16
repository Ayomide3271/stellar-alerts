import * as StellarSdk from "stellar-sdk";
import { prisma } from "./prisma";
import {
  hashMerkleLeaf,
  verifyMerkleProof,
  MerkleProofStep,
} from "../utils/merkle-verifier";
import { decodeScAddress, decodeScAmount, formatTokenAmount } from "./stellar";
import { stellarNetwork } from "../config/network";
import { sorobanStateService } from "../modules/soroban-state/soroban-state.service";
import { env } from "../config/env";
import { getJson, setJson, getSacMetadataCacheKey, SAC_METADATA_TTL } from "./cache";
import { withDeadline } from "./external-request";
import type { EnrichedSorobanEvent, SorobanRpcEvent } from "../types/soroban-event";

export const SOROBAN_RPC_URL = stellarNetwork.sorobanRpcUrl;
const LEDGER_BATCH_SIZE = 100;
/** Maximum number of distinct contracts the router tracks at once. */
export const MAX_ACTIVE_CONTRACTS = 100;

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
    const allSubscriptions = await prisma.sorobanContractSubscription.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    });

    // The cap applies to distinct contracts, not subscription rows: many users
    // can share one contract. Newest contracts win; every subscription of an
    // admitted contract is kept so no subscriber is silently dropped.
    const admitted = new Set<string>();
    const subscriptions = allSubscriptions.filter((sub) => {
      if (admitted.has(sub.contractId)) return true;
      if (admitted.size >= MAX_ACTIVE_CONTRACTS) return false;
      admitted.add(sub.contractId);
      return true;
    });
    if (admitted.size >= MAX_ACTIVE_CONTRACTS && subscriptions.length < allSubscriptions.length) {
      console.warn(
        `[Registry] Contract limit (${MAX_ACTIVE_CONTRACTS}) reached; ${allSubscriptions.length - subscriptions.length} subscription(s) on additional contracts are not being watched`,
      );
    }

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
 * Extracts the event name (first topic, conventionally a symbol such as
 * "transfer") from an event; "default" when the topic array is empty/missing.
 */
export function getEventTopicName(event: Pick<SorobanRpcEvent, "topic">): string {
  const firstTopic = Array.isArray(event.topic) ? event.topic[0] : undefined;
  return (
    (typeof firstTopic === "string"
      ? firstTopic
      : typeof firstTopic === "object" &&
        firstTopic !== null &&
        "symbol" in firstTopic
      ? String((firstTopic as { symbol: unknown }).symbol)
      : null) ?? "default"
  );
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

  const topic = getEventTopicName(event);

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

// ---------------------------------------------------------------------------
// Fee-estimation types
// ---------------------------------------------------------------------------

/**
 * Footprint entry describing a single ledger key that will be read or written
 * by the simulated transaction.
 */
export interface LedgerFootprintEntry {
  /** Hex-encoded ledger key XDR */
  key: string;
  /** Durability of the storage entry */
  durability: 'persistent' | 'temporary';
}

/**
 * Rent fee split by storage durability. Persistent entries are archived rather
 * than deleted and are charged at a higher rate than temporary entries.
 */
export interface SorobanRentBreakdown {
  persistentStroops: string;
  persistentXlm: string;
  persistentEntries: number;
  temporaryStroops: string;
  temporaryXlm: string;
  temporaryEntries: number;
}

/**
 * Detailed fee breakdown returned by {@link simulateTransaction}.
 *
 * All fee values are expressed in *stroops* (1 XLM = 10,000,000 stroops) as
 * strings so they can be used directly with Stellar SDK big-number helpers.
 */
export interface SorobanFeeEstimate {
  /** Total inclusion fee (base network fee) in stroops */
  inclusionFeeStroops: string;
  /** Total resource fee (execution + state rent) in stroops */
  resourceFeeStroops: string;
  /** Rent fee for all ledger entries in stroops */
  rentFeeStroops: string;
  /** Total of all fees in stroops */
  totalFeeStroops: string;
  /** Human-readable total fee in XLM */
  totalFeeXlm: string;
  /** Inclusion fee in XLM */
  inclusionFeeXlm: string;
  /** Resource fee (execution + state rent) in XLM */
  resourceFeeXlm: string;
  /** Rent fee in XLM */
  rentFeeXlm: string;
  /** Rent fee split between persistent and temporary storage footprints */
  rentBreakdown: SorobanRentBreakdown;
  /** Whether archived entries must be restored before this transaction can run */
  restoreRequired: boolean;
  /** Fee of the separate restore transaction in stroops ('0' when not required) */
  restoreFeeStroops: string;
  /** Fee of the separate restore transaction in XLM */
  restoreFeeXlm: string;
  /** Ledger entries that will be *read* during execution */
  readFootprint: LedgerFootprintEntry[];
  /** Ledger entries that will be *written* during execution */
  writeFootprint: LedgerFootprintEntry[];
  /** Number of read-only ledger entries */
  readCount: number;
  /** Number of read-write ledger entries */
  writeCount: number;
  /** Estimated CPU instructions */
  cpuInstructions: number;
  /** Estimated memory bytes */
  memoryBytes: number;
  /** Whether the simulation succeeded */
  success: boolean;
  /** Error description when success is false */
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stroops per XLM */
const STROOPS_PER_XLM = 10_000_000;

/**
 * Converts a stroops string or number to XLM with 7 decimal places.
 */
export function stroopsToXlm(stroops: string | number): string {
  const n = typeof stroops === 'string' ? BigInt(stroops) : BigInt(Math.round(Number(stroops)));
  const xlmWhole = n / BigInt(STROOPS_PER_XLM);
  const xlmFrac = n % BigInt(STROOPS_PER_XLM);
  return `${xlmWhole}.${xlmFrac.toString().padStart(7, '0')}`;
}

/**
 * Parses the `sorobanData` XDR field inside a SimulateTransactionResponse and
 * extracts read/write footprint entries.  Falls back gracefully when the field
 * is absent (e.g., non-Soroban transactions or unit-test mocks).
 */
export function parseLedgerFootprint(simulationResult: any): {
  readFootprint: LedgerFootprintEntry[];
  writeFootprint: LedgerFootprintEntry[];
} {
  const readFootprint: LedgerFootprintEntry[] = [];
  const writeFootprint: LedgerFootprintEntry[] = [];

  try {
    // The stellar-sdk v13 SimulateTransactionResponse exposes a `result` with
    // `auth` and the raw transaction envelope, but the footprint lives inside
    // the `transactionData` / `sorobanData` field that the SDK attaches.
    const sorobanData =
      simulationResult?.transactionData?.value?.() ??
      simulationResult?.transactionData ??
      simulationResult?.result?.sorobanData ??
      null;

    if (!sorobanData) {
      return { readFootprint, writeFootprint };
    }

    // `footprint()` returns an XDR LedgerFootprint with readOnly / readWrite arrays
    const footprint =
      typeof sorobanData.footprint === 'function'
        ? sorobanData.footprint()
        : sorobanData.footprint ?? null;

    if (!footprint) {
      return { readFootprint, writeFootprint };
    }

    const readOnly: any[] =
      typeof footprint.readOnly === 'function'
        ? footprint.readOnly()
        : footprint.readOnly ?? [];

    const readWrite: any[] =
      typeof footprint.readWrite === 'function'
        ? footprint.readWrite()
        : footprint.readWrite ?? [];

    for (const entry of readOnly) {
      readFootprint.push({
        key: entry.toXDR?.('hex') ?? String(entry),
        durability: _detectDurability(entry),
      });
    }

    for (const entry of readWrite) {
      writeFootprint.push({
        key: entry.toXDR?.('hex') ?? String(entry),
        durability: _detectDurability(entry),
      });
    }
  } catch {
    // Footprint parsing is best-effort; never throw.
  }

  return { readFootprint, writeFootprint };
}

/**
 * Detects whether a ledger key belongs to a persistent or temporary storage
 * entry by inspecting the XDR discriminant.
 */
function _detectDurability(ledgerKey: any): 'persistent' | 'temporary' {
  try {
    const arm: string =
      typeof ledgerKey.switch === 'function'
        ? ledgerKey.switch().name ?? ''
        : '';
    if (arm.toLowerCase().includes('temp') || arm.toLowerCase().includes('temporary')) {
      return 'temporary';
    }
    if (
      typeof ledgerKey.contractData === 'function' ||
      typeof ledgerKey.contractCode === 'function'
    ) {
      const data = ledgerKey.contractData?.();
      const durabilityArm: string =
        typeof data?.durability === 'function' ? data.durability().name ?? '' : '';
      if (durabilityArm.toLowerCase().includes('temp')) {
        return 'temporary';
      }
    }
  } catch {
    // ignore
  }
  return 'persistent';
}

/**
 * Relative per-ledger rent weight of each storage class. Mirrors the network
 * rent-rate denominators (temporary entries are charged half the persistent
 * rate), so the rent estimate is apportioned accordingly.
 */
const PERSISTENT_RENT_WEIGHT = BigInt(2);
const TEMPORARY_RENT_WEIGHT = BigInt(1);

/**
 * Apportions the total rent fee over the write footprint by storage durability.
 * Only written (created / extended) entries accrue rent; with no writes the
 * rent is attributed to persistent storage. The two parts always sum to
 * `rentFeeStroops`.
 */
export function buildRentBreakdown(
  rentFeeStroops: bigint,
  writeFootprint: LedgerFootprintEntry[],
): SorobanRentBreakdown {
  const persistentEntries = writeFootprint.filter((e) => e.durability === 'persistent').length;
  const temporaryEntries = writeFootprint.length - persistentEntries;

  const persistentShare = BigInt(persistentEntries) * PERSISTENT_RENT_WEIGHT;
  const temporaryShare = BigInt(temporaryEntries) * TEMPORARY_RENT_WEIGHT;
  const totalShare = persistentShare + temporaryShare;

  const temporary =
    totalShare === BigInt(0) ? BigInt(0) : (rentFeeStroops * temporaryShare) / totalShare;
  const persistent = rentFeeStroops - temporary;

  return {
    persistentStroops: persistent.toString(),
    persistentXlm: stroopsToXlm(persistent.toString()),
    persistentEntries,
    temporaryStroops: temporary.toString(),
    temporaryXlm: stroopsToXlm(temporary.toString()),
    temporaryEntries,
  };
}

function failedFeeEstimate(error: string): SorobanFeeEstimate {
  return {
    inclusionFeeStroops: '0',
    resourceFeeStroops: '0',
    rentFeeStroops: '0',
    totalFeeStroops: '0',
    totalFeeXlm: '0.0000000',
    inclusionFeeXlm: '0.0000000',
    resourceFeeXlm: '0.0000000',
    rentFeeXlm: '0.0000000',
    rentBreakdown: buildRentBreakdown(BigInt(0), []),
    restoreRequired: false,
    restoreFeeStroops: '0',
    restoreFeeXlm: '0.0000000',
    readFootprint: [],
    writeFootprint: [],
    readCount: 0,
    writeCount: 0,
    cpuInstructions: 0,
    memoryBytes: 0,
    success: false,
    error,
  };
}

// ---------------------------------------------------------------------------
// simulateTransaction
// ---------------------------------------------------------------------------

/**
 * Wraps the Soroban RPC `simulateTransaction` call and returns a structured
 * {@link SorobanFeeEstimate} with read/write ledger entry footprints and a
 * complete fee breakdown including storage rent.
 *
 * @param xdrEnvelope - Base64-encoded XDR TransactionEnvelope of the Soroban
 *                      transaction to simulate.
 */
export async function simulateTransaction(xdrEnvelope: string): Promise<SorobanFeeEstimate> {
  try {
    // Decode the envelope and let the SDK build a Transaction object so the
    // RPC call receives a proper Transaction instance.
    const transaction = StellarSdk.TransactionBuilder.fromXDR(
      xdrEnvelope,
      (StellarSdk as any).Networks?.TESTNET ?? 'Test SDF Network ; September 2015'
    );

    const simulationResult: any = await sorobanServer.simulateTransaction(transaction);

    // -----------------------------------------------------------------------
    // Error path
    // -----------------------------------------------------------------------
    if (simulationResult?.error) {
      return failedFeeEstimate(String(simulationResult.error));
    }

    // -----------------------------------------------------------------------
    // Extract fees
    // The SDK returns minResourceFee as a string (stroops) and the classic
    // base fee is embedded in the transaction itself.  We also surface the
    // rent fee component separately when available.
    // -----------------------------------------------------------------------
    const minResourceFee: string = String(simulationResult?.minResourceFee ?? '0');

    // Inclusion (base) fee: use 100 stroops as the minimum network default
    // when we cannot read it from the transaction directly.
    let inclusionFeeStroops = '100';
    try {
      const fee = transaction.fee;
      if (fee && Number(fee) > 0) {
        inclusionFeeStroops = String(fee);
      }
    } catch {
      // keep default
    }

    // Rent fee is part of the resource fee; the SDK >= v13 may expose it via
    // `transactionData.resourceFee()` decomposition.  We attempt to extract it
    // and fall back to a proportional estimate.
    let rentFeeStroops = '0';
    try {
      const td =
        simulationResult?.transactionData?.value?.() ??
        simulationResult?.transactionData ??
        null;
      const rf: bigint =
        typeof td?.resourceFee === 'function'
          ? BigInt(td.resourceFee().toString())
          : BigInt(0);
      if (rf > BigInt(0)) {
        rentFeeStroops = rf.toString();
      } else if (BigInt(minResourceFee) > BigInt(0)) {
        // Estimate: rent ≈ 30 % of total resource fee
        rentFeeStroops = ((BigInt(minResourceFee) * BigInt(30)) / BigInt(100)).toString();
      }
    } catch {
      if (BigInt(minResourceFee) > BigInt(0)) {
        rentFeeStroops = ((BigInt(minResourceFee) * BigInt(30)) / BigInt(100)).toString();
      }
    }

    const totalFeeStroops = (
      BigInt(inclusionFeeStroops) + BigInt(minResourceFee)
    ).toString();

    // -----------------------------------------------------------------------
    // Extract CPU / memory resource usage
    // -----------------------------------------------------------------------
    let cpuInstructions = 0;
    let memoryBytes = 0;
    try {
      const resources = simulationResult?.result?.auth?.[0]?.resources?.() ?? null;
      if (resources) {
        cpuInstructions = Number(resources.instructions?.() ?? 0);
        memoryBytes = Number(resources.readBytes?.() ?? 0);
      }
    } catch {
      // best-effort
    }

    // -----------------------------------------------------------------------
    // Footprint
    // -----------------------------------------------------------------------
    const { readFootprint, writeFootprint } = parseLedgerFootprint(simulationResult);
    const rentBreakdown = buildRentBreakdown(BigInt(rentFeeStroops), writeFootprint);

    // Archived entries need a separate RestoreFootprint transaction first.
    const restoreFeeStroops = String(simulationResult?.restorePreamble?.minResourceFee ?? '0');

    return {
      inclusionFeeStroops,
      resourceFeeStroops: minResourceFee,
      rentFeeStroops,
      totalFeeStroops,
      totalFeeXlm: stroopsToXlm(totalFeeStroops),
      inclusionFeeXlm: stroopsToXlm(inclusionFeeStroops),
      resourceFeeXlm: stroopsToXlm(minResourceFee),
      rentFeeXlm: stroopsToXlm(rentFeeStroops),
      rentBreakdown,
      restoreRequired: BigInt(restoreFeeStroops) > BigInt(0),
      restoreFeeStroops,
      restoreFeeXlm: stroopsToXlm(restoreFeeStroops),
      readFootprint,
      writeFootprint,
      readCount: readFootprint.length,
      writeCount: writeFootprint.length,
      cpuInstructions,
      memoryBytes,
      success: true,
    };
  } catch (error: any) {
    return failedFeeEstimate(error?.message ?? String(error));
  }
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

/** Soroban RPC allows 5 filters per request, each with up to 5 contract IDs. */
const EVENT_FILTERS_PER_REQUEST = 5;
const CONTRACT_IDS_PER_FILTER = 5;
export const CONTRACTS_PER_EVENT_REQUEST = EVENT_FILTERS_PER_REQUEST * CONTRACT_IDS_PER_FILTER;

/**
 * Fetches events for many contracts at once, packing up to
 * {@link CONTRACTS_PER_EVENT_REQUEST} contract IDs into each `getEvents`
 * request, so 100 subscribed contracts cost 4 RPC calls instead of 100.
 * A failing batch is logged and skipped without losing the others.
 */
export async function fetchEventsForContracts(
  contractIds: string[],
  startLedger: number,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<any[]> {
  const unique = Array.from(new Set(contractIds.filter(Boolean)));
  const timeoutMs = options.timeoutMs ?? env.SOROBAN_RPC_TIMEOUT_MS;
  const events: any[] = [];

  for (let i = 0; i < unique.length; i += CONTRACTS_PER_EVENT_REQUEST) {
    const batch = unique.slice(i, i + CONTRACTS_PER_EVENT_REQUEST);
    const filters = [];
    for (let j = 0; j < batch.length; j += CONTRACT_IDS_PER_FILTER) {
      filters.push({ type: "contract", contractIds: batch.slice(j, j + CONTRACT_IDS_PER_FILTER) });
    }

    try {
      const response: any = await withDeadline(
        () => sorobanServer.getEvents({ startLedger, filters }),
        timeoutMs,
        options.signal,
        "Soroban RPC getEvents (multi-contract)",
      );
      events.push(...(response.events || []));
    } catch (error: any) {
      console.error(
        `[SorobanRPC] Error fetching events for ${batch.length} contract(s):`,
        error.message,
      );
    }
  }

  return events;
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
 * Builds an atomic transaction operation tree from flat Soroban invocation records.
 */
export function buildFlashLoanOperationTree(
  operations: SorobanTransactionOperationInput[],
): FlashLoanOperationNode[] {
  const nodes = new Map<string, FlashLoanOperationNode>();

  for (const operation of operations) {
    const type = normalizeOperationType(operation.type);
    const asset =
      operation.asset ||
      (type === "swap" ? operation.tokenIn || operation.tokenOut || "" : "");
    const amount =
      type === "swap"
        ? toBigIntAmount(operation.amountIn)
        : toBigIntAmount(operation.amount);

    if (!asset || amount === null) continue;

    nodes.set(operation.id, {
      id: operation.id,
      parentId: operation.parentId,
      type,
      asset,
      amount,
      amountFormatted: formatAmount(amount),
      contractId: operation.contractId,
      children: [],
    });
  }

  const roots: FlashLoanOperationNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function calculateNetArbitrageProfit(
  operations: SorobanTransactionOperationInput[],
  borrowedAsset: string,
  borrowAmount: bigint,
  repayAmount: bigint,
): bigint {
  for (const operation of operations) {
    const explicitProfit = toBigIntAmount(operation.profit);
    if (explicitProfit !== null && explicitProfit > 0n) {
      return explicitProfit;
    }
  }

  let swapDelta = 0n;
  for (const operation of operations) {
    if (normalizeOperationType(operation.type) !== "swap") continue;

    const tokenIn = operation.tokenIn || "";
    const tokenOut = operation.tokenOut || "";
    const amountIn = toBigIntAmount(operation.amountIn);
    const amountOut = toBigIntAmount(operation.amountOut);
    if (amountIn === null || amountOut === null) continue;

    if (tokenOut === borrowedAsset) swapDelta += amountOut;
    if (tokenIn === borrowedAsset) swapDelta -= amountIn;
  }

  const surplus = borrowAmount + swapDelta - repayAmount;
  return surplus > 0n ? surplus : 0n;
}

/**
 * Detects atomic flash-loan borrow/repay invariants within a single transaction tree.
 */
export function detectFlashLoanInTransaction(
  txHash: string,
  operations: SorobanTransactionOperationInput[],
  ledgerSeq?: number,
): ParsedFlashLoanAlert | null {
  if (!txHash || operations.length === 0) return null;

  buildFlashLoanOperationTree(operations);

  const borrowOps = operations.filter((op) => normalizeOperationType(op.type) === "borrow");
  const repayOps = operations.filter((op) => normalizeOperationType(op.type) === "repay");

  if (borrowOps.length === 0 || repayOps.length === 0) return null;

  for (const borrowOp of borrowOps) {
    const borrowedAsset = borrowOp.asset || "";
    const borrowAmount = toBigIntAmount(borrowOp.amount);
    if (!borrowedAsset || borrowAmount === null || borrowAmount <= 0n) continue;

    const matchingRepay = repayOps.find((repayOp) => (repayOp.asset || "") === borrowedAsset);
    if (!matchingRepay) continue;

    const repayAmount = toBigIntAmount(matchingRepay.amount);
    if (repayAmount === null || repayAmount < borrowAmount) continue;

    let feeAmount = repayAmount - borrowAmount;
    const explicitFee = toBigIntAmount(matchingRepay.fee ?? borrowOp.fee);
    if (explicitFee !== null && explicitFee >= 0n) {
      feeAmount = explicitFee;
    }

    const netArbitrageProfit = calculateNetArbitrageProfit(
      operations,
      borrowedAsset,
      borrowAmount,
      repayAmount,
    );

    return {
      txHash,
      ledgerSeq,
      contractId: borrowOp.contractId || matchingRepay.contractId || "",
      borrowedAsset,
      borrowedAmount: formatAmount(borrowAmount),
      feeAmount: formatAmount(feeAmount),
      netArbitrageProfit: formatAmount(netArbitrageProfit),
    };
  }

  return null;
}

/**
 * Parses atomic transaction operation trees for flash-loan borrow/repay invariants.
 */
export class FlashLoanDetector {
  parseOperationTree(operations: SorobanTransactionOperationInput[]): FlashLoanOperationNode[] {
    return buildFlashLoanOperationTree(operations);
  }

  detect(transaction: {
    txHash: string;
    ledgerSeq?: number;
    operations: SorobanTransactionOperationInput[];
  }): ParsedFlashLoanAlert | null {
    return detectFlashLoanInTransaction(
      transaction.txHash,
      transaction.operations,
      transaction.ledgerSeq,
    );
  }

  detectFromEvents(events: any[], txHash: string, ledgerSeq?: number): ParsedFlashLoanAlert | null {
    const operations = events
      .map((event) => parseFlashLoanOperationFromEvent(event))
      .filter((operation): operation is SorobanTransactionOperationInput => operation !== null);

    return this.detect({ txHash, ledgerSeq, operations });
  }
}

export const flashLoanDetector = new FlashLoanDetector();

export interface ParsedStakingRewardEvent {
  contractId: string;
  account: string;
  rewardToken: string;
  poolContractId: string;
  amount: string;
  rawAmount: bigint;
  topic: string;
  epoch?: number;
  ledgerSeq?: number;
  txHash?: string;
}

const STAKING_REWARD_TOPICS = new Set([
  "distribute",
  "reward",
  "claim",
  "emitted",
  "emission",
  "stake_reward",
  "yield_distribution",
  "reward_distributed",
  "yield",
  "reward_emission",
  "staking_reward",
]);

/**
 * Parses a raw Soroban RPC event into a staking / LP yield reward distribution event.
 */
export function parseStakingRewardEvent(event: any): ParsedStakingRewardEvent | null {
  if (!event || !event.topic || event.topic.length === 0) {
    return null;
  }

  const rawTopic = extractSwapTopicValue(event.topic[0]);
  if (!rawTopic) return null;

  const topicNormalized = rawTopic.toLowerCase();
  if (!STAKING_REWARD_TOPICS.has(topicNormalized)) {
    return null;
  }

  const value = event.value || event.data || {};
  const contractId = event.contractId || "";

  const account = asAddressString(
    value.account ??
      value.recipient ??
      value.staker ??
      value.user ??
      value.to ??
      (value.distribute && (value.distribute.account || value.distribute.recipient))
  );

  if (!account) return null;

  const rewardToken = asAddressString(
    value.reward_token ??
      value.rewardToken ??
      value.asset ??
      value.token ??
      value.reward_asset ??
      value.rewardAsset ??
      contractId
  );

  const poolContractId = asAddressString(
    value.pool_contract_id ??
      value.poolContractId ??
      value.pool ??
      value.lp_token ??
      value.lpToken ??
      value.staking_pool ??
      contractId
  );

  const rawAmount = decodeScAmount(
    value.amount ??
      value.reward_amount ??
      value.rewardAmount ??
      value.yield ??
      value.emission ??
      value.reward_emission
  );

  if (rawAmount === null || rawAmount <= 0n) {
    return null;
  }

  const epoch =
    value.epoch !== undefined && value.epoch !== null && !Number.isNaN(Number(value.epoch))
      ? Number(value.epoch)
      : undefined;

  return {
    contractId,
    account,
    rewardToken,
    poolContractId,
    amount: formatTokenAmount(rawAmount),
    rawAmount,
    topic: topicNormalized,
    epoch,
    ledgerSeq: event.ledgerSeq || event.ledger,
    txHash: event.txHash || event.transactionHash,
  };
}

/**
 * StakingRewardTracker aggregates cumulative LP yield emissions and staking reward distributions
 * across Soroban liquidity pools per account.
 */
export class StakingRewardTracker {
  private accountTotals = new Map<string, Map<string, bigint>>();
  private poolTotals = new Map<string, bigint>();

  /**
   * Aggregates a single parsed reward event into cumulative tracker state.
   */
  processRewardEvent(event: ParsedStakingRewardEvent): {
    accountCumulativeAmount: string;
    poolCumulativeAmount: string;
  } {
    const { account, rewardToken, poolContractId, rawAmount } = event;

    // Account cumulative total
    if (!this.accountTotals.has(account)) {
      this.accountTotals.set(account, new Map());
    }
    const tokenMap = this.accountTotals.get(account)!;
    const currentAccountTotal = tokenMap.get(rewardToken) || 0n;
    const newAccountTotal = currentAccountTotal + rawAmount;
    tokenMap.set(rewardToken, newAccountTotal);

    // Pool-specific account total
    const poolKey = `${account}:${poolContractId}:${rewardToken}`;
    const currentPoolTotal = this.poolTotals.get(poolKey) || 0n;
    const newPoolTotal = currentPoolTotal + rawAmount;
    this.poolTotals.set(poolKey, newPoolTotal);

    return {
      accountCumulativeAmount: formatTokenAmount(newAccountTotal),
      poolCumulativeAmount: formatTokenAmount(newPoolTotal),
    };
  }

  /**
   * Processes a batch of raw Soroban RPC events, parsing reward events and aggregating yield emissions.
   */
  processEventBatch(events: any[]): {
    event: ParsedStakingRewardEvent;
    accountCumulativeAmount: string;
    poolCumulativeAmount: string;
  }[] {
    const results: {
      event: ParsedStakingRewardEvent;
      accountCumulativeAmount: string;
      poolCumulativeAmount: string;
    }[] = [];

    for (const rawEvent of events) {
      const parsed = parseStakingRewardEvent(rawEvent);
      if (!parsed) continue;

      const totals = this.processRewardEvent(parsed);
      results.push({
        event: parsed,
        accountCumulativeAmount: totals.accountCumulativeAmount,
        poolCumulativeAmount: totals.poolCumulativeAmount,
      });
    }

    return results;
  }

  /**
   * Gets cumulative yield emission for a specific account and reward token.
   */
  getCumulativeYield(account: string, rewardToken: string = "default"): string {
    const tokenMap = this.accountTotals.get(account);
    if (!tokenMap) return "0";

    if (rewardToken === "default") {
      let total = 0n;
      for (const amount of tokenMap.values()) {
        total += amount;
      }
      return formatTokenAmount(total);
    }

    const amount = tokenMap.get(rewardToken) || 0n;
    return formatTokenAmount(amount);
  }

  /**
   * Gets cumulative yield emission for an account within a specific pool and reward token.
   */
  getCumulativeYieldByPool(account: string, poolContractId: string, rewardToken: string): string {
    const poolKey = `${account}:${poolContractId}:${rewardToken}`;
    const amount = this.poolTotals.get(poolKey) || 0n;
    return formatTokenAmount(amount);
  }

  /**
   * Resets all accumulated yield metrics.
   */
  reset(): void {
    this.accountTotals.clear();
    this.poolTotals.clear();
  }
}

export const stakingRewardTracker = new StakingRewardTracker();

export class SacMintBurnAnalyticsAggregator {
  private mintTotals = new Map<string, bigint>();
  private burnTotals = new Map<string, bigint>();

  processParsedEvent(event: ParsedSorobanMintBurn): void {
    const contractId = event.contractId || "unknown";
    const amount = event.rawAmount ?? 0n;
    if (event.eventType === "MINT") {
      this.mintTotals.set(contractId, (this.mintTotals.get(contractId) || 0n) + amount);
    } else {
      this.burnTotals.set(contractId, (this.burnTotals.get(contractId) || 0n) + amount);
    }
  }

  processEventBatch(events: any[]): void {
    for (const rawEvent of events) {
      const parsed = parseSorobanMintBurnEvent(rawEvent);
      if (parsed) this.processParsedEvent(parsed);
    }
  }

  getCumulativeMintedAmount(contractId: string): string {
    return formatTokenAmount(this.mintTotals.get(contractId) || 0n);
  }

  getCumulativeBurnedAmount(contractId: string): string {
    return formatTokenAmount(this.burnTotals.get(contractId) || 0n);
  }

  getNetSupply(contractId: string): string {
    return formatTokenAmount(
      (this.mintTotals.get(contractId) || 0n) -
        (this.burnTotals.get(contractId) || 0n),
    );
  }

  reset(): void {
    this.mintTotals.clear();
    this.burnTotals.clear();
  }
}

export const sacMintBurnAnalyticsAggregator = new SacMintBurnAnalyticsAggregator();

export interface SorobanErrorInfo {
  type: 'custom_error' | 'panic' | 'host_error' | 'invocation_error';
  code?: number;
  message: string;
  contractId?: string;
  function?: string;
  details?: string;
}

export interface SorobanDiagnosticResult {
  errors: SorobanErrorInfo[];
  summary: string;
  contractId?: string;
}

const SOROBAN_PANIC_CODES: Record<number, string> = {
  1: 'Assertion failed',
  2: 'Arithmetic overflow',
  3: 'Division by zero',
  4: 'Index out of bounds',
  5: 'Invalid value',
  6: 'Missing value',
  7: 'Already exists',
  8: 'Unexpected error',
  9: 'Memory limit exceeded',
  10: 'Quota exceeded',
  11: 'Execution limit exceeded',
  12: 'CPU instruction limit exceeded',
  13: 'Stack limit exceeded',
  14: 'Storage limit exceeded',
  15: 'Budget exceeded',
  16: 'Context error',
  17: 'Invalid argument',
  18: 'Invalid data',
  19: 'Invalid contract',
  20: 'Invalid invocation',
};

const SOROBAN_HOST_ERROR_CODES: Record<number, string> = {
  100: 'Invalid XDR',
  101: 'Invalid ledger entry',
  102: 'Invalid contract',
  103: 'Invalid invocation',
  104: 'Missing entry',
  105: 'Already exists',
  106: 'Invalid auth',
  107: 'Missing auth',
  108: 'Too many operations',
  109: 'Too many bytes',
  110: 'Fee bumped',
  111: 'No funds',
  112: 'Bad sequence',
  113: 'Insufficient balance',
  114: 'No source account',
  115: 'Invalid signature',
  116: 'Too many signatures',
  117: 'Invalid threshold',
  118: 'Low threshold',
  119: 'Op too complex',
  120: 'No network',
  121: 'Network error',
  122: 'Transaction too large',
  123: 'Duplicate operation',
  124: 'Invalid memo',
  125: 'Memo required',
  126: 'Fee too low',
  127: 'Too many ledgers',
  128: 'Invalid limit',
  129: 'Operation disabled',
  130: 'Contract not found',
  131: 'Function not found',
  132: 'Bad auth',
  133: 'Invalid argument',
  134: 'Internal error',
};

function parsePanicCode(code: number): string {
  return SOROBAN_PANIC_CODES[code] || `Unknown panic code: ${code}`;
}

function parseHostErrorCode(code: number): string {
  return SOROBAN_HOST_ERROR_CODES[code] || `Unknown host error code: ${code}`;
}

function parseCustomError(result: any): SorobanErrorInfo | null {
  try {
    if (!result?.error || typeof result.error !== 'string') return null;

    const errorMatch = result.error.match(/Error\(Contract, (\d+)\)/);
    if (errorMatch) {
      const code = parseInt(errorMatch[1], 10);
      return {
        type: 'custom_error',
        code,
        message: `Custom contract error ${code}`,
        contractId: result.contractId,
        function: result.function,
        details: result.error,
      };
    }

    const panicMatch = result.error.match(/Panic\((\d+)\)/);
    if (panicMatch) {
      const code = parseInt(panicMatch[1], 10);
      return {
        type: 'panic',
        code,
        message: parsePanicCode(code),
        contractId: result.contractId,
        function: result.function,
        details: result.error,
      };
    }

    const hostErrorMatch = result.error.match(/HostError\((\d+)\)/);
    if (hostErrorMatch) {
      const code = parseInt(hostErrorMatch[1], 10);
      return {
        type: 'host_error',
        code,
        message: parseHostErrorCode(code),
        contractId: result.contractId,
        function: result.function,
        details: result.error,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function parseInvocationError(result: any): SorobanErrorInfo | null {
  try {
    if (!result?.error) return null;

    const errorStr = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);

    if (errorStr.includes('Error(Contract,')) {
      return parseCustomError(result);
    }

    if (errorStr.includes('Panic(')) {
      return parseCustomError(result);
    }

    if (errorStr.includes('HostError(')) {
      return parseCustomError(result);
    }

    return {
      type: 'invocation_error',
      message: errorStr,
      contractId: result.contractId,
      function: result.function,
      details: errorStr,
    };
  } catch {
    return null;
  }
}

export function parseSorobanDiagnosticError(
  simulationResult: any,
  executionResult?: any,
): SorobanDiagnosticResult {
  const errors: SorobanErrorInfo[] = [];
  let contractId: string | undefined;

  if (simulationResult) {
    const simError = parseInvocationError(simulationResult);
    if (simError) {
      errors.push(simError);
      contractId = simError.contractId;
    }
  }

  if (executionResult) {
    const execError = parseInvocationError(executionResult);
    if (execError) {
      errors.push(execError);
      contractId = contractId || execError.contractId;
    }
  }

  const summary = errors.length === 0
    ? 'No errors detected'
    : errors.length === 1
    ? errors[0].message
    : `${errors.length} errors detected: ${errors.map(e => e.message).join(', ')}`;

  return {
    errors,
    summary,
    contractId,
  };
}

export function decodeSorobanErrorFromXdr(xdrBase64: string): SorobanErrorInfo | null {
  try {
    const scError = StellarSdk.xdr.ScError.fromXDR(Buffer.from(xdrBase64, 'base64'));
    const errorType = scError.switch();
    const typeName: string = (errorType as { name?: string }).name ?? String(errorType);

    // The sceContract arm carries a ScErrorCode in contractCode()
    if (typeName === 'sceContract') {
      const contractCode = scError.contractCode();
      return {
        type: 'custom_error',
        code: contractCode,
        message: `Custom contract error (${contractCode})`,
        details: `ScError(sceContract, ${contractCode})`,
      };
    }

    // All other system-level errors (sceWasmVm, sceContext, sceStorage, sceObject,
    // sceCrypto, sceEvents, sceBudget, sceValue, sceAuth) carry a ScErrorCode in code()
    const code = scError.code() as unknown as { name: string; value: number };
    return {
      type: 'host_error',
      code: code.value,
      message: `Soroban ${typeName} error: ${code.name} (${code.value})`,
      details: `ScError(${typeName}, ${code.name})`,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SAC metadata auto-discovery
// ---------------------------------------------------------------------------

export interface SacMetadata {
  contractId: string;
  name: string;
  symbol: string;
  decimals: number;
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
      networkPassphrase: stellarNetwork.networkPassphrase,
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

/** How long a fallback (undiscovered) SAC result is cached, so a flaky RPC is retried soon. */
const SAC_FALLBACK_TTL = 60;

interface SacDiscoveryResult {
  metadata: SacMetadata;
  /** True only when `decimals()` was actually read from the contract. */
  discovered: boolean;
}

function defaultSacMetadata(contractId: string): SacMetadata {
  return {
    contractId,
    name: 'Unknown Token',
    symbol: contractId ? contractId.substring(0, 8) : 'Unknown',
    decimals: 7,
  };
}

/**
 * Queries `decimals()`, `symbol()` and `name()` on the SAC contract and reports
 * whether the decimals were genuinely discovered (as opposed to defaulted).
 */
async function discoverSacMetadata(contractId: string): Promise<SacDiscoveryResult> {
  const fallback = defaultSacMetadata(contractId);

  if (!contractId) {
    return { metadata: fallback, discovered: false };
  }

  try {
    // Query decimals, symbol, name via contract simulation in parallel
    const [decimalsVal, symbolVal, nameVal] = await Promise.all([
      simulateContractCall(contractId, 'decimals'),
      simulateContractCall(contractId, 'symbol'),
      simulateContractCall(contractId, 'name'),
    ]);

    let decimals = fallback.decimals;
    let discovered = false;
    if (typeof decimalsVal === 'number' && Number.isInteger(decimalsVal) && decimalsVal >= 0) {
      decimals = decimalsVal;
      discovered = true;
    } else if (typeof decimalsVal === 'bigint') {
      decimals = Number(decimalsVal);
      discovered = true;
    } else if (typeof decimalsVal === 'string' && /^\d+$/.test(decimalsVal)) {
      decimals = parseInt(decimalsVal, 10);
      discovered = true;
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

    return { metadata: { contractId, name, symbol, decimals }, discovered };
  } catch (error: any) {
    console.warn(`[SorobanRPC] Error fetching SAC metadata for contract ${contractId}:`, error.message);
    return { metadata: fallback, discovered: false };
  }
}

/**
 * Queries SAC token metadata (decimals, symbol, name) from Soroban RPC.
 */
export async function fetchSacMetadataFromRpc(contractId: string): Promise<SacMetadata> {
  return (await discoverSacMetadata(contractId)).metadata;
}

/** In-flight discoveries, so concurrent first sightings share one RPC round-trip. */
const inflightSacDiscoveries = new Map<string, Promise<SacMetadata>>();

/**
 * Retrieves SAC metadata from Redis cache (24h TTL) or discovers it from Soroban RPC.
 *
 * Successful discoveries are cached for 24h. A failed discovery returns the
 * 7-decimal default but is only cached briefly, so a transient RPC error can
 * never pin wrong decimals for a day.
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

  const inflight = inflightSacDiscoveries.get(contractId);
  if (inflight) {
    return inflight;
  }

  const discovery = (async () => {
    const { metadata, discovered } = await discoverSacMetadata(contractId);
    await setJson(cacheKey, metadata, discovered ? SAC_METADATA_TTL : SAC_FALLBACK_TTL);
    return metadata;
  })().finally(() => {
    inflightSacDiscoveries.delete(contractId);
  });

  inflightSacDiscoveries.set(contractId, discovery);
  return discovery;
}

/**
 * Re-formats a parsed event's raw amount using the contract's real decimals.
 * Events without a raw amount are returned untouched.
 */
export async function withSacDecimals<T extends { contractId: string; amount: string; rawAmount?: bigint }>(
  parsed: T
): Promise<T> {
  if (parsed.rawAmount === undefined || !parsed.contractId) return parsed;
  const { formattedAmount } = await formatSacAmountWithDiscovery(parsed.rawAmount, parsed.contractId);
  return { ...parsed, amount: formattedAmount };
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
