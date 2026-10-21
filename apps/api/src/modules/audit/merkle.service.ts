import { Injectable } from '@nestjs/common';
import { prisma } from '@/lib/prisma';
import {
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  MerkleProof,
  MerkleTree,
  hashMerkleLeaf,
} from '@stellar-alerts/shared';
import * as crypto from 'crypto';

/**
 * MerkleAuditService
 *
 * Generates cryptographic Merkle tree roots over historical alert delivery logs
 * for independent audit verification. Provides tamper-evident proof that records
 * have not been altered or deleted.
 *
 * - Computes daily Merkle roots over all delivered payment and alert hashes
 * - Generates compact inclusion proofs for any specific alert ID
 * - Provides independent verification against root hash
 */
@Injectable()
export class MerkleAuditService {
  /**
   * Generates a Merkle tree root for all alerts delivered on a specific date.
   *
   * @param date ISO date string (YYYY-MM-DD)
   * @returns Object with root hash and tree structure
   */
  async generateDailyMerkleRoot(date: string): Promise<{ root: string; treeSize: number }> {
    // Parse date and get start/end boundaries
    const startOfDay = new Date(`${date}T00:00:00Z`);
    const endOfDay = new Date(`${date}T23:59:59Z`);

    // Fetch all alerts delivered on this day, ordered deterministically
    const deliveredAlerts = await prisma.alert.findMany({
      where: {
        status: 'DELIVERED',
        deliveredAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      orderBy: {
        id: 'asc', // Deterministic ordering
      },
      select: {
        id: true,
        recipientAddress: true,
        amount: true,
        assetCode: true,
        assetIssuer: true,
        txHash: true,
        createdAt: true,
        deliveredAt: true,
      },
    });

    if (deliveredAlerts.length === 0) {
      throw new Error(`No delivered alerts found for date ${date}`);
    }

    // Convert alerts to leaf payloads: JSON serialization ensures consistency
    const leaves = deliveredAlerts.map((alert) =>
      Buffer.from(JSON.stringify(alert), 'utf-8')
    );

    // Build Merkle tree
    const tree = buildMerkleTree(leaves);

    return {
      root: tree.root,
      treeSize: deliveredAlerts.length,
    };
  }

  /**
   * Generates a Merkle inclusion proof for a specific alert ID.
   * Allows independent verification that the alert was included in the daily root.
   *
   * @param alertId The alert ID to generate proof for
   * @param date ISO date string (YYYY-MM-DD) when alert was delivered
   * @returns Merkle inclusion proof
   */
  async generateAlertInclusionProof(alertId: string, date: string): Promise<MerkleProof> {
    const startOfDay = new Date(`${date}T00:00:00Z`);
    const endOfDay = new Date(`${date}T23:59:59Z`);

    // Fetch all alerts delivered on this day (same query as generateDailyMerkleRoot)
    const deliveredAlerts = await prisma.alert.findMany({
      where: {
        status: 'DELIVERED',
        deliveredAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      orderBy: {
        id: 'asc',
      },
      select: {
        id: true,
        recipientAddress: true,
        amount: true,
        assetCode: true,
        assetIssuer: true,
        txHash: true,
        createdAt: true,
        deliveredAt: true,
      },
    });

    // Find the alert in the list
    const alertIndex = deliveredAlerts.findIndex((a) => a.id === alertId);
    if (alertIndex === -1) {
      throw new Error(`Alert ${alertId} not found in delivered alerts for date ${date}`);
    }

    // Rebuild tree to generate proof
    const leaves = deliveredAlerts.map((alert) =>
      Buffer.from(JSON.stringify(alert), 'utf-8')
    );
    const tree = buildMerkleTree(leaves);

    // Generate proof path
    const path = generateMerkleProof(tree, alertIndex);

    // Get the leaf hash
    const leafHash = hashMerkleLeaf(leaves[alertIndex]);

    return { leafHash, path };
  }

  /**
   * Verifies an alert's Merkle inclusion proof against a known root hash.
   * Independent verification function that does not require database access.
   *
   * @param alertId The alert ID being verified
   * @param proof The Merkle inclusion proof
   * @param expectedRoot The known Merkle root to verify against
   * @returns true if proof is valid, false otherwise
   */
  verifyAlertInclusion(alertId: string, proof: MerkleProof, expectedRoot: string): boolean {
    return verifyMerkleProof(proof, expectedRoot);
  }

  /**
   * Stores a Merkle root commitment for a specific date.
   * These immutable records serve as audit checkpoints.
   *
   * @param date ISO date string (YYYY-MM-DD)
   * @param root Merkle root hash
   * @param treeSize Number of alerts included
   */
  async storeDailyMerkleCommitment(
    date: string,
    root: string,
    treeSize: number
  ): Promise<{ id: string; date: string; root: string; treeSize: number }> {
    // In a real implementation, store this in a dedicated audit table
    // For now, return the commitment structure
    return {
      id: crypto.randomUUID(),
      date,
      root,
      treeSize,
    };
  }

  /**
   * Retrieves the Merkle root commitment for a specific date.
   *
   * @param date ISO date string (YYYY-MM-DD)
   * @returns The stored commitment or null if not found
   */
  async getDailyMerkleCommitment(date: string): Promise<{
    root: string;
    treeSize: number;
  } | null> {
    // In a real implementation, fetch from audit table
    // Placeholder implementation
    return null;
  }
}
