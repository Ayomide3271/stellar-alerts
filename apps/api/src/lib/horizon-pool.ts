/**
 * Resilient Multi-Node Horizon Connection Pool with Latency Probing & Failover (#640).
 *
 * Maintains an adaptive priority-ordered pool of Horizon RPC nodes with:
 * - Background latency and ledger-height health probing (every 30s)
 * - Automatic zero-downtime failover on 429 rate limit or 5xx outage
 * - Stream failover preserving cursor continuity without duplicate event emissions
 */

import * as StellarSdk from 'stellar-sdk';
import { stellarNetwork } from '../config/network';
import { env } from '../config/env';
import { createLogger } from './logger';
import {
  HorizonOperationRecord,
  isHorizonOperationRecord,
  getHorizonPagingToken,
  getHorizonTxHash,
} from '../types/horizon';

const log = createLogger({ module: 'HorizonPool' });

export interface HorizonNodeStats {
  url: string;
  healthy: boolean;
  latencyMs: number;
  ledgerHeight: number;
  lastCheckedAt: number;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface HorizonPoolOptions {
  endpoints?: string[];
  probeIntervalMs?: number;
  maxConsecutiveFailures?: number;
  requestTimeoutMs?: number;
}

export class HorizonPool {
  public endpoints: string[];
  public nodeStats: Map<string, HorizonNodeStats> = new Map();
  public servers: Map<string, StellarSdk.Horizon.Server> = new Map();
  private probeTimer: NodeJS.Timeout | null = null;
  private readonly probeIntervalMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly requestTimeoutMs: number;

  constructor(options: HorizonPoolOptions = {}) {
    this.endpoints = options.endpoints && options.endpoints.length > 0
      ? [...options.endpoints]
      : [...stellarNetwork.horizonEndpoints];

    this.probeIntervalMs = options.probeIntervalMs ?? 30_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 2;
    this.requestTimeoutMs = options.requestTimeoutMs ?? env.HORIZON_REQUEST_TIMEOUT_MS;

    for (const url of this.endpoints) {
      this.nodeStats.set(url, {
        url,
        healthy: true,
        latencyMs: 0,
        ledgerHeight: 0,
        lastCheckedAt: 0,
        consecutiveFailures: 0,
        lastError: null,
      });
      this.servers.set(url, new StellarSdk.Horizon.Server(url));
    }
  }

  public getServer(url: string): StellarSdk.Horizon.Server {
    let server = this.servers.get(url);
    if (!server) {
      server = new StellarSdk.Horizon.Server(url);
      this.servers.set(url, server);
    }
    return server;
  }

  /**
   * Probe a single Horizon node for latency and current ledger height.
   */
  public async probeNode(url: string): Promise<HorizonNodeStats> {
    const stats = this.nodeStats.get(url) ?? {
      url,
      healthy: true,
      latencyMs: 0,
      ledgerHeight: 0,
      lastCheckedAt: 0,
      consecutiveFailures: 0,
      lastError: null,
    };

    const server = this.getServer(url);
    const start = Date.now();

    try {
      const response = await server.ledgers().order('desc').limit(1).call();
      const latencyMs = Date.now() - start;
      const ledgerRecord = response.records?.[0];
      const ledgerHeight = ledgerRecord?.sequence ?? 0;

      stats.healthy = true;
      stats.latencyMs = latencyMs;
      stats.ledgerHeight = ledgerHeight;
      stats.consecutiveFailures = 0;
      stats.lastError = null;
      stats.lastCheckedAt = Date.now();
      this.nodeStats.set(url, stats);
      return stats;
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      const errMsg = err?.message || String(err);
      const isRateLimit = err?.response?.status === 429 || errMsg.includes('429');

      stats.consecutiveFailures += isRateLimit ? this.maxConsecutiveFailures : 1;
      if (stats.consecutiveFailures >= this.maxConsecutiveFailures) {
        stats.healthy = false;
      }
      stats.latencyMs = latencyMs;
      stats.lastError = errMsg;
      stats.lastCheckedAt = Date.now();
      this.nodeStats.set(url, stats);

      log.warn(
        { url, latencyMs, isRateLimit, error: errMsg },
        'Horizon node probe failure',
      );
      return stats;
    }
  }

  /**
   * Probe all nodes in the pool.
   */
  public async probeAll(): Promise<HorizonNodeStats[]> {
    const results = await Promise.all(this.endpoints.map((url) => this.probeNode(url)));
    return results;
  }

  /**
   * Start periodic health probing every 30s (or custom interval).
   */
  public startHealthProbing(): void {
    if (this.probeTimer) return;
    void this.probeAll().catch((err) => log.error({ err }, 'Initial probeAll failed'));
    this.probeTimer = setInterval(() => {
      void this.probeAll().catch((err) => log.error({ err }, 'Periodic probeAll failed'));
    }, this.probeIntervalMs);
  }

  public stopHealthProbing(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /**
   * Mark a node as failed immediately upon receiving 429 or 5xx.
   */
  public markNodeFailure(url: string, error?: unknown): void {
    const stats = this.nodeStats.get(url);
    if (!stats) return;

    const errMsg = (error as any)?.message || String(error || 'Node request failed');
    const isRateLimit = (error as any)?.response?.status === 429 || errMsg.includes('429');

    stats.consecutiveFailures += isRateLimit ? this.maxConsecutiveFailures : 1;
    if (stats.consecutiveFailures >= this.maxConsecutiveFailures) {
      stats.healthy = false;
    }
    stats.lastError = errMsg;
    stats.lastCheckedAt = Date.now();
    this.nodeStats.set(url, stats);

    log.warn({ url, consecutiveFailures: stats.consecutiveFailures, isRateLimit }, 'Node marked with failure');
  }

  /**
   * Selects active node based on priority and health.
   * Traverses endpoints in priority order; returns the first healthy node.
   * If all are unhealthy, falls back to the lowest latency or primary node.
   */
  public getActiveNode(): string {
    for (const url of this.endpoints) {
      const stats = this.nodeStats.get(url);
      if (stats && stats.healthy) {
        return url;
      }
    }

    // Fallback: choose the node with fewest consecutive failures or first endpoint
    let bestUrl = this.endpoints[0];
    let minFailures = Infinity;
    for (const url of this.endpoints) {
      const stats = this.nodeStats.get(url);
      const failures = stats?.consecutiveFailures ?? 0;
      if (failures < minFailures) {
        minFailures = failures;
        bestUrl = url;
      }
    }
    return bestUrl;
  }

  public getActiveServer(): StellarSdk.Horizon.Server {
    const url = this.getActiveNode();
    return this.getServer(url);
  }

  /**
   * Connect an SSE payments stream with automatic node failover.
   * If the active connection encounters an error (429 rate limit or 5xx / dropped connection),
   * it rotates to the next healthy node in the pool and resumes from the latest observed cursor.
   */
  public streamPaymentsWithFailover(
    publicKey: string,
    initialCursor: string,
    onMessage: (record: HorizonOperationRecord, nodeUrl: string) => Promise<void> | void,
    onError?: (error: unknown, nodeUrl: string) => void,
  ): () => void {
    let isClosed = false;
    let currentCursor = initialCursor;
    let activeCloseFn: (() => void) | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    const seenTokens = new Set<string>();

    const connectToNextNode = () => {
      if (isClosed) return;

      const nodeUrl = this.getActiveNode();
      const server = this.getServer(nodeUrl);

      log.info({ nodeUrl, publicKey, cursor: currentCursor }, 'Connecting Horizon stream');

      try {
        const closeStream = server
          .payments()
          .forAccount(publicKey)
          .cursor(currentCursor)
          .stream({
            onmessage: async (record: unknown) => {
              if (isClosed) return;
              if (!isHorizonOperationRecord(record)) return;

              const token = getHorizonPagingToken(record) || getHorizonTxHash(record);
              if (token) {
                if (seenTokens.has(token)) return; // prevent duplicate dispatch
                seenTokens.add(token);
                currentCursor = token;

                // Bound memory
                if (seenTokens.size > 10_000) {
                  const oldest = seenTokens.values().next().value;
                  if (oldest) seenTokens.delete(oldest);
                }
              }

              try {
                await onMessage(record, nodeUrl);
              } catch (msgErr) {
                if (onError) onError(msgErr, nodeUrl);
                else log.error({ msgErr, nodeUrl }, 'Error handling stream payment message');
              }
            },
            onerror: (streamErr: unknown) => {
              if (isClosed) return;
              this.markNodeFailure(nodeUrl, streamErr);
              if (onError) onError(streamErr, nodeUrl);

              if (activeCloseFn) {
                try {
                  activeCloseFn();
                } catch {}
                activeCloseFn = null;
              }

              // Reconnect to next healthy node with cursor continuation
              if (!reconnectTimeout) {
                reconnectTimeout = setTimeout(() => {
                  reconnectTimeout = null;
                  connectToNextNode();
                }, 1000);
              }
            },
          }) as unknown as () => void;

        activeCloseFn = () => {
          if (closeStream && typeof closeStream === 'function') {
            closeStream();
          }
        };
      } catch (connErr) {
        this.markNodeFailure(nodeUrl, connErr);
        if (onError) onError(connErr, nodeUrl);

        if (!reconnectTimeout && !isClosed) {
          reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            connectToNextNode();
          }, 1000);
        }
      }
    };

    connectToNextNode();

    return () => {
      isClosed = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (activeCloseFn) {
        try {
          activeCloseFn();
        } catch {}
        activeCloseFn = null;
      }
      seenTokens.clear();
    };
  }
}

export const horizonPool = new HorizonPool();
