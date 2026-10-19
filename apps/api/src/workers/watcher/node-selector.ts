/**
 * Horizon Node Selector for Ingestion Watcher (#640).
 *
 * Uses the adaptive Horizon connection pool to select healthy RPC nodes
 * and stream payment events with automatic zero-downtime failover.
 */

import { horizonPool, HorizonPool } from '../../lib/horizon-pool';

export function getActiveHorizonNode(pool: HorizonPool = horizonPool): string {
  return pool.getActiveNode();
}

export function streamPaymentsWithFailover(
  publicKey: string,
  initialCursor: string,
  onMessage: (record: any, nodeUrl: string) => Promise<void> | void,
  onError?: (error: unknown, nodeUrl: string) => void,
  pool: HorizonPool = horizonPool,
): () => void {
  return pool.streamPaymentsWithFailover(publicKey, initialCursor, onMessage, onError);
}
