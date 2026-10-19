import * as StellarSdk from 'stellar-sdk';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';
import { env } from '../config/env';
import { stellarNetwork } from '../config/network';
import { withDeadline } from './external-request';
import { isHorizonOperationRecord, asHorizonOperationRecords, type HorizonOperationRecord } from '../types/horizon';
import type { SorobanRpcEvent } from '../types/soroban-event';

// Configure global Horizon AxiosClient default timeout
if ((StellarSdk.Horizon as any)?.AxiosClient?.defaults) {
  (StellarSdk.Horizon as any).AxiosClient.defaults.timeout = env.HORIZON_REQUEST_TIMEOUT_MS;
}

const server = new StellarSdk.Horizon.Server(stellarNetwork.horizonEndpoints[0]);

export const STROOPS_PER_UNIT = 10_000_000;

function logPaymentsError(publicKey: string, error: any) {
  console.error(
    `[Stellar] Error fetching payments for ${publicKey.substring(0, 8)}...:`,
    error?.message ?? error
  );
}

export interface DecodedStellarAsset {
  assetCode: string;
  assetIssuer: string | null;
}

export interface SacTransfer {
  contractId: string;
  assetCode: string | null;
  assetIssuer: string | null;
  from: string;
  to: string;
  amount: string;
  rawAmount: string;
}

/**
 * Decodes a Horizon payment record into an asset code and issuer address.
 * Native XLM payments resolve to { assetCode: 'XLM', assetIssuer: null } while
 * credit_alphanum4 / credit_alphanum12 records carry their own code + issuer.
 */
export function decodeHorizonAsset(record: HorizonOperationRecord): DecodedStellarAsset {
  const rec = record as {
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
  };

  if (rec.asset_type === 'native' || !rec.asset_type) {
    return { assetCode: 'XLM', assetIssuer: null };
  }

  return {
    assetCode: rec.asset_code || 'Unknown',
    assetIssuer: rec.asset_issuer || null,
  };
}

/**
 * Converts a raw token amount (stroops / smallest SAC unit) into a human
 * readable decimal string using the given number of decimals.
 */
export function formatTokenAmount(
  rawAmount: string | number | bigint,
  decimals: number = 7
): string {
  let raw: bigint;
  try {
    raw = typeof rawAmount === 'bigint' ? rawAmount : BigInt(String(rawAmount).trim());
  } catch {
    raw = 0n;
  }

  const sign = raw < 0n ? '-' : '';
  const abs = sign ? -raw : raw;
  const divisor = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');

  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Decodes a Soroban ScVal address (or an already decoded strkey) into its
 * string representation (G... for accounts, C... for contracts).
 */
export function decodeScAddress(scVal: any): string | null {
  if (!scVal) return null;

  if (typeof scVal === 'string') {
    return scVal.startsWith('G') || scVal.startsWith('C') ? scVal : null;
  }

  if (typeof scVal === 'object') {
    try {
      const native = StellarSdk.scValToNative(scVal);
      if (typeof native === 'string') {
        return native.startsWith('G') || native.startsWith('C') ? native : null;
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Decodes a Soroban i128 amount (raw ScVal, { lo, hi } shape or plain value)
 * into a bigint of stroops.
 */
export function decodeScAmount(value: any): bigint | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'bigint') return value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }

  if (typeof value === 'object') {
    const i128 = value.i128 ?? value.value?.i128;
    if (i128 && typeof i128 === 'object' && i128.lo !== undefined) {
      const lo = BigInt(i128.lo >>> 0);
      const hi = BigInt(i128.hi >>> 0);
      return (hi << 64n) + lo;
    }
    if (typeof i128 === 'string' && /^-?\d+$/.test(i128)) {
      return BigInt(i128);
    }
    try {
      const native = StellarSdk.scValToNative(value);
      if (typeof native === 'bigint') return native;
      if (typeof native === 'number' && Number.isFinite(native)) {
        return BigInt(Math.trunc(native));
      }
    } catch {
      return null;
    }
  }

  return null;
}

function extractTopicValue(topicEntry: any): string | null {
  if (topicEntry === null || topicEntry === undefined) return null;
  if (typeof topicEntry === 'string') return topicEntry;
  if (typeof topicEntry === 'object' && typeof topicEntry.symbol === 'string') {
    return topicEntry.symbol;
  }
  return null;
}

/**
 * Parses a Soroban Asset Contract (SAC) transfer event into a structured
 * transfer with the decimal-adjusted amount. Supports both canonical RPC
 * events (topic: [symbol, from, to] + i128 data) and simplified payloads.
 */
export function parseSacTransferEvent(event: SorobanRpcEvent, decimals: number = 7): SacTransfer | null {
  if (!event) return null;

  const topics = Array.isArray(event.topic) ? event.topic : [];
  const action = extractTopicValue(topics[0]) ?? (typeof event.topic === 'string' ? event.topic : '');

  const rawValue = (event.value ?? event.data ?? {}) as Record<string, unknown>;
  const from = (topics.length > 1 ? decodeScAddress(topics[1]) : null) ?? (rawValue['from'] as string | undefined) ?? '';
  const to = (topics.length > 2 ? decodeScAddress(topics[2]) : null) ?? (rawValue['to'] as string | undefined) ?? '';

  let rawAmount = decodeScAmount(rawValue['amount']);
  if (rawAmount === null && !rawValue['amount'] && !rawValue['from'] && !rawValue['to']) {
    rawAmount = decodeScAmount(rawValue);
  }

  if (!action || action !== 'transfer' || rawAmount === null) {
    return null;
  }

  if (!from && !to) {
    return null;
  }

  return {
    contractId: event.contractId || '',
    assetCode: event.assetCode ?? null,
    assetIssuer: event.assetIssuer ?? null,
    from,
    to,
    amount: formatTokenAmount(rawAmount, decimals),
    rawAmount: rawAmount.toString(),
  };
}

export interface MultisigSigner {
  key: string;
  weight: number;
}

export interface MultisigThresholds {
  low: number;
  medium: number;
  high: number;
}

export type MultisigThresholdLevel = 'low' | 'medium' | 'high';

export interface MultisigSignatureProgress {
  requiredThreshold: number;
  collectedWeight: number;
  /** Public keys of known signers whose signature was found and verified. */
  signedBy: string[];
  /** Known signers who have not yet contributed a valid signature. */
  remainingSigners: MultisigSigner[];
  thresholdMet: boolean;
  totalSigners: number;
  /** Count of signatures in the envelope matched to a known signer and verified. */
  validSignatureCount: number;
  /** Count of signatures in the envelope that could not be matched/verified against any known signer. */
  invalidSignatureCount: number;
}

/**
 * Counts how much of a Stellar multisig account's signing weight a
 * (possibly partially-signed) transaction envelope has collected so far,
 * and which of the account's known signers still need to add theirs.
 *
 * Each signature in the envelope is matched to a candidate signer by its
 * 4-byte hint and then cryptographically verified against the transaction
 * hash — a hint match alone doesn't prove authorship (hint collisions,
 * while rare, are possible), so only a verified signature counts toward
 * the threshold. Non-ed25519 signers (sha256-hash / pre-authorized
 * transaction signers) can't be matched against a normal signature this
 * way and are simply treated as not-yet-signed; they still count toward
 * `remainingSigners`.
 *
 * `thresholdLevel` selects which of the account's three threshold tiers
 * (low/medium/high) the transaction must clear — most payment/transfer
 * operations require "medium"; operations that change signers or account
 * options require "high".
 */
export function countMultisigSignatures(
  envelopeXdr: string,
  signers: MultisigSigner[],
  thresholds: MultisigThresholds,
  networkPassphrase: string,
  thresholdLevel: MultisigThresholdLevel = 'medium'
): MultisigSignatureProgress {
  const parsed = StellarSdk.TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  const tx = 'innerTransaction' in parsed ? parsed.innerTransaction : parsed;
  const txHash = tx.hash();

  const requiredThreshold =
    thresholdLevel === 'low'
      ? thresholds.low
      : thresholdLevel === 'high'
        ? thresholds.high
        : thresholds.medium;

  const signedBy = new Set<string>();
  let invalidSignatureCount = 0;

  for (const decoratedSig of tx.signatures) {
    const hint = decoratedSig.hint();
    const rawSignature = decoratedSig.signature();
    let matched = false;

    for (const signer of signers) {
      if (signedBy.has(signer.key)) continue;

      let keypair: StellarSdk.Keypair;
      try {
        keypair = StellarSdk.Keypair.fromPublicKey(signer.key);
      } catch {
        continue; // not an ed25519 signer key — can't verify a standard signature against it
      }

      if (!keypair.signatureHint().equals(hint)) continue;

      if (keypair.verify(txHash, rawSignature)) {
        signedBy.add(signer.key);
        matched = true;
        break;
      }
    }

    if (!matched) invalidSignatureCount++;
  }

  const collectedWeight = signers
    .filter((s) => signedBy.has(s.key))
    .reduce((sum, s) => sum + s.weight, 0);

  const remainingSigners = signers.filter((s) => !signedBy.has(s.key));

  return {
    requiredThreshold,
    collectedWeight,
    signedBy: Array.from(signedBy),
    remainingSigners,
    thresholdMet: collectedWeight >= requiredThreshold,
    totalSigners: signers.length,
    validSignatureCount: signedBy.size,
    invalidSignatureCount,
  };
}

export const DEFAULT_HORIZON_ENDPOINTS = [
  ...stellarNetwork.horizonEndpoints,
];

const STREAM_QUORUM_FALLBACK_MS = 1000;

export class MultiNodeHorizonClient {
  public endpoints: string[];
  public servers: StellarSdk.Horizon.Server[];

  constructor(endpoints: string[] = DEFAULT_HORIZON_ENDPOINTS) {
    this.endpoints = endpoints;
    this.servers = endpoints.map((url) => new StellarSdk.Horizon.Server(url));
  }

  async getPaymentsSince(publicKey: string, cursor: string, limit = 50): Promise<HorizonOperationRecord[]> {
    const result = await this.getPaymentsSinceResult(publicKey, cursor, limit);
    return result.records;
  }

  /**
   * Same lookup as {@link getPaymentsSince}, but distinguishes "no new
   * payments" (every node reached, none had anything new) from "provider
   * outage" (every node in the failover list errored) — the caller needs
   * that distinction to avoid silently treating an outage as "fully caught
   * up" and to surface it for operator visibility (see lib/cursor-recovery.ts).
   */
  async getPaymentsSinceResult(
    publicKey: string,
    cursor: string,
    limit = 50,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ records: any[]; allNodesFailed: boolean; lastError: string | null }> {
    if (!publicKey || !isValidEd25519PublicKey(publicKey)) {
      console.warn(`[MultiNodeHorizon] Skipping invalid public key checksum: "${publicKey}"`);
      return { records: [], allNodesFailed: false, lastError: null };
    }

    const timeoutMs = options.timeoutMs ?? env.HORIZON_REQUEST_TIMEOUT_MS;
    let lastError: string | null = null;

    for (let i = 0; i < this.servers.length; i++) {
      const server = this.servers[i];
      try {
        const payments = await server
          .payments()
          .forAccount(publicKey)
          .cursor(cursor)
          .order('asc')
          .limit(limit)
          .call();
        return { records: asHorizonOperationRecords(payments.records), allNodesFailed: false, lastError: null };
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        lastError = errMsg;
        console.warn(
          `[MultiNodeHorizon] Horizon node ${this.endpoints[i]} failed: ${lastError}. Trying fallback node...`,
        );
      }
    }
    return { records: [], allNodesFailed: true, lastError };
  }

  streamPaymentsMultiNode(
    publicKey: string,
    cursor: string,
    onMessage: (record: HorizonOperationRecord, nodeUrl: string) => Promise<void> | void,
    onError?: (error: unknown, nodeUrl: string) => void,
  ): () => void {
    const pendingVotes = new Map<string, {
      record: HorizonOperationRecord;
      nodeUrl: string;
      nodeIndexes: Set<number>;
      timeout: NodeJS.Timeout;
    }>();
    const emittedPagingTokens = new Set<string>();
    const activeCloseFns: Array<() => void> = [];
    const reconnectTimers = new Set<NodeJS.Timeout>();
    const quorumSize = Math.floor(this.servers.length / 2) + 1;
    let isClosed = false;

    const emit = async (token: string) => {
      const vote = pendingVotes.get(token);
      if (!vote || emittedPagingTokens.has(token) || isClosed) return;

      clearTimeout(vote.timeout);
      pendingVotes.delete(token);
      emittedPagingTokens.add(token);
      if (emittedPagingTokens.size > 10000) {
        const oldest = emittedPagingTokens.values().next().value;
        if (oldest) emittedPagingTokens.delete(oldest);
      }

      try {
        await onMessage(vote.record, vote.nodeUrl);
      } catch (error: unknown) {
        if (onError) onError(error, vote.nodeUrl);
        else console.error(`[MultiNodeHorizon] Failed to process stream event from ${vote.nodeUrl}:`, error);
      }
    };

    this.servers.forEach((s, index) => {
      let isNodeClosed = false;
      let reconnectTimer: NodeJS.Timeout | null = null;
      const nodeUrl = this.endpoints[index] || s.serverURL.toString();

      const scheduleReconnect = () => {
        if (isClosed || isNodeClosed || reconnectTimer) return;
        const timer = setTimeout(() => {
          reconnectTimers.delete(timer);
          reconnectTimer = null;
          connect();
        }, 5000);
        reconnectTimer = timer;
        reconnectTimers.add(timer);
      };

      const connect = () => {
        if (isClosed || isNodeClosed) return;
        try {
          const closeStream = s
            .payments()
            .forAccount(publicKey)
            .cursor(cursor)
            .stream({
              onmessage: async (record: unknown) => {
                const typedRecord = isHorizonOperationRecord(record) ? record : null;
                if (!typedRecord) return;

                const token = typedRecord.paging_token || typedRecord.transaction_hash;
                if (!token || emittedPagingTokens.has(token)) return;

                let vote = pendingVotes.get(token);
                if (!vote) {
                  vote = {
                    record: typedRecord,
                    nodeUrl,
                    nodeIndexes: new Set<number>(),
                    timeout: setTimeout(() => void emit(token), STREAM_QUORUM_FALLBACK_MS),
                  };
                  pendingVotes.set(token, vote);
                }
                vote.nodeIndexes.add(index);
                if (vote.nodeIndexes.size >= quorumSize) await emit(token);
              },
              onerror: (error: unknown) => {
                if (onError) onError(error, nodeUrl);
                else console.warn(`[MultiNodeHorizon] Stream node ${nodeUrl} failed:`, error);
                scheduleReconnect();
              },
            }) as unknown as () => void;

          activeCloseFns.push(() => {
            isNodeClosed = true;
            if (closeStream) closeStream();
          });
        } catch (err: unknown) {
          if (onError) onError(err, nodeUrl);
          else console.warn(`[MultiNodeHorizon] Could not open stream to ${nodeUrl}:`, err);
          scheduleReconnect();
        }
      };

      connect();
    });

    return () => {
      isClosed = true;
      for (const vote of pendingVotes.values()) clearTimeout(vote.timeout);
      pendingVotes.clear();
      for (const timer of reconnectTimers) clearTimeout(timer);
      reconnectTimers.clear();
      activeCloseFns.forEach((fn) => fn());
    };
  }
}

export const multiNodeClient = new MultiNodeHorizonClient();

export interface SetOptionsOperationSummary {
  type: 'set_options';
  signer_key?: string;
  signer_weight?: number;
  master_weight?: number;
  low_threshold?: number;
  med_threshold?: number;
  high_threshold?: number;
  transaction_hash?: string;
  created_at?: string;
}

export const stellar = {
  server,
  multiNode: multiNodeClient,

  // Fetches an account's current signer list and multisig thresholds from
  // Horizon. Returns null for an invalid public key or if the account
  // cannot be loaded (e.g. not yet funded on this network).
  async getAccountSigners(
    publicKey: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{
    signers: MultisigSigner[];
    thresholds: MultisigThresholds;
    masterWeight: number;
  } | null> {
    if (!publicKey || !isValidEd25519PublicKey(publicKey)) {
      console.warn(`[Stellar] Skipping invalid public key format or checksum: "${publicKey}"`);
      return null;
    }

    const timeoutMs = options.timeoutMs ?? env.HORIZON_REQUEST_TIMEOUT_MS;
    try {
      const account = await withDeadline(
        () => server.loadAccount(publicKey),
        timeoutMs,
        options.signal,
        'Horizon',
      );
      const masterSigner = account.signers.find(
        (s) => s.key === (account.account_id || (account as any).id),
      );
      return {
        signers: account.signers.map((s) => ({ key: s.key, weight: s.weight })),
        thresholds: {
          low: account.thresholds.low_threshold,
          medium: account.thresholds.med_threshold,
          high: account.thresholds.high_threshold,
        },
        masterWeight: masterSigner ? Number(masterSigner.weight) : 0,
      };
    } catch (error: any) {
      console.error(`[Stellar] Error fetching signers for account ${publicKey}:`, error?.message || error);
      return null;
    }
  },

  async getRecentSetOptionsOperations(
    publicKey: string,
    options: { timeoutMs?: number; signal?: AbortSignal; limit?: number } = {},
  ): Promise<SetOptionsOperationSummary[]> {
    if (!publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      return [];
    }

    const timeoutMs = options.timeoutMs ?? env.HORIZON_REQUEST_TIMEOUT_MS;
    const limit = options.limit ?? 10;

    try {
      const operations = await withDeadline(
        () =>
          server
            .operations()
            .forAccount(publicKey)
            .order('desc')
            .limit(limit)
            .call(),
        timeoutMs,
        options.signal,
        'Horizon',
      );

      return operations.records
        .filter((record: any) => record?.type === 'set_options')
        .map((record: any) => ({
          type: 'set_options',
          signer_key: record.signer_key ?? record.signerKey ?? undefined,
          signer_weight: record.signer_weight ?? record.signerWeight ?? undefined,
          master_weight: record.master_weight ?? record.masterWeight ?? undefined,
          low_threshold: record.low_threshold ?? record.lowThreshold ?? undefined,
          med_threshold: record.med_threshold ?? record.medThreshold ?? undefined,
          high_threshold: record.high_threshold ?? record.highThreshold ?? undefined,
          transaction_hash: record.transaction_hash ?? record.transactionHash ?? undefined,
          created_at: record.created_at ?? undefined,
        }));
    } catch (error: any) {
      console.warn(
        `[Stellar] Error fetching set_options operations for ${publicKey}:`,
        error?.message || error,
      );
      return [];
    }
  },
  // Helper to fetch recent payments for a given account
  async getRecentPayments(
    publicKey: string,
    limit: number = 10,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    if (!publicKey || !isValidEd25519PublicKey(publicKey)) {
      console.warn(`[Stellar] Skipping invalid public key format or checksum: "${publicKey}"`);
      return [];
    }

    const timeoutMs = options.timeoutMs ?? env.HORIZON_REQUEST_TIMEOUT_MS;
    try {
      const payments = await server.payments()
        .forAccount(publicKey)
        .order('desc')
        .limit(limit)
        .call();

      return asHorizonOperationRecords(payments.records);
    } catch (error: unknown) {
      logPaymentsError(publicKey, error);
      return [];
    }
  },

  // Fetch payments recorded after the given Horizon paging token, oldest first
  async getPaymentsSince(publicKey: string, cursor: string, limit: number = 50) {
    return multiNodeClient.getPaymentsSince(publicKey, cursor, limit);
  },

  // Same as getPaymentsSince, but reports whether every failover node
  // errored (a provider outage) instead of masking it as "no new payments".
  async getPaymentsSinceResult(publicKey: string, cursor: string, limit: number = 50) {
    return multiNodeClient.getPaymentsSinceResult(publicKey, cursor, limit);
  },

  // Paging token of the most recent payment, used to seed a fresh cursor
  async getLatestPagingToken(publicKey: string): Promise<string> {
    const records = await this.getRecentPayments(publicKey, 1);
    return records[0]?.paging_token || '0';
  }
};
