import { describe, it, expect } from 'vitest';
import {
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  hashMerkleLeaf,
  MerkleProof,
} from '@stellar-alerts/shared';

/**
 * Integration test: Complete Merkle tree audit flow
 * Demonstrates tamper-evident proof generation and verification
 */
describe('Merkle Tree Audit - Complete Integration', () => {
  it('generates Merkle root, creates proof, and verifies independently', () => {
    // Simulate a day's delivered alerts
    const deliveredAlerts = [
      {
        id: 'alert-001',
        recipientAddress: 'GUSER1234567890',
        amount: '100.00',
        assetCode: 'USDC',
        txHash: 'tx-abc123',
        createdAt: '2026-08-30T10:00:00Z',
        deliveredAt: '2026-08-30T10:01:00Z',
      },
      {
        id: 'alert-002',
        recipientAddress: 'GUSER2345678901',
        amount: '50.00',
        assetCode: 'XLM',
        txHash: 'tx-def456',
        createdAt: '2026-08-30T11:00:00Z',
        deliveredAt: '2026-08-30T11:01:00Z',
      },
      {
        id: 'alert-003',
        recipientAddress: 'GUSER3456789012',
        amount: '200.00',
        assetCode: 'USDC',
        txHash: 'tx-ghi789',
        createdAt: '2026-08-30T12:00:00Z',
        deliveredAt: '2026-08-30T12:01:00Z',
      },
      {
        id: 'alert-004',
        recipientAddress: 'GUSER4567890123',
        amount: '75.50',
        assetCode: 'ETH',
        txHash: 'tx-jkl012',
        createdAt: '2026-08-30T13:00:00Z',
        deliveredAt: '2026-08-30T13:01:00Z',
      },
    ];

    // Step 1: Convert alerts to leaf payloads
    const leaves = deliveredAlerts.map((alert) =>
      Buffer.from(JSON.stringify(alert), 'utf-8')
    );

    // Step 2: Build Merkle tree (simulates generateDailyMerkleRoot)
    const tree = buildMerkleTree(leaves);
    const dailyRoot = tree.root;

    console.log('✓ Daily Merkle Root:', dailyRoot);
    console.log('✓ Tree size:', leaves.length, 'alerts');

    // Step 3: Generate proof for alert-002 (index 1)
    const alertToProve = deliveredAlerts[1];
    const leafIndex = 1;
    const path = generateMerkleProof(tree, leafIndex);
    const leafHash = hashMerkleLeaf(leaves[leafIndex]);
    const proof: MerkleProof = { leafHash, path };

    console.log(`✓ Generated proof for ${alertToProve.id}`);
    console.log(`✓ Proof has ${proof.path.length} steps`);

    // Step 4: Independent verification (no database access needed)
    // This can be done by an external auditor
    const isProofValid = verifyMerkleProof(proof, dailyRoot);
    expect(isProofValid).toBe(true);
    console.log('✓ Proof verified against daily root');

    // Step 5: Simulate tampering attack — modify the alert amount
    const tamperedAlert = JSON.parse(JSON.stringify(alertToProve));
    tamperedAlert.amount = '9999.99'; // Attacker modifies amount
    const tamperedLeafHash = hashMerkleLeaf(
      Buffer.from(JSON.stringify(tamperedAlert), 'utf-8')
    );
    const tamperedProof: MerkleProof = { leafHash: tamperedLeafHash, path };

    // Tampered proof should NOT verify
    const isTamperedValid = verifyMerkleProof(tamperedProof, dailyRoot);
    expect(isTamperedValid).toBe(false);
    console.log('✗ Tampered alert: proof rejection successful');

    // Step 6: Simulate root tampering by administrator
    const tamperedRoot =
      dailyRoot.substring(0, 30) +
      (dailyRoot[30] === 'a' ? 'f' : 'a') +
      dailyRoot.substring(31);

    const isTamperedRootValid = verifyMerkleProof(proof, tamperedRoot);
    expect(isTamperedRootValid).toBe(false);
    console.log('✗ Tampered root: proof rejection successful');

    // Step 7: Reconstruct tree from same alerts (deterministic)
    const leaves2 = deliveredAlerts.map((alert) =>
      Buffer.from(JSON.stringify(alert), 'utf-8')
    );
    const tree2 = buildMerkleTree(leaves2);

    // Same data = same root (cryptographic commitment)
    expect(tree2.root).toBe(dailyRoot);
    console.log('✓ Deterministic: same data produces same root');

    // Step 8: Generate all proofs for full audit trail
    const allProofs = deliveredAlerts.map((alert, idx) => {
      const proofPath = generateMerkleProof(tree, idx);
      const leafH = hashMerkleLeaf(leaves[idx]);
      return {
        alertId: alert.id,
        proof: { leafHash: leafH, path: proofPath },
      };
    });

    // Verify all proofs
    const allValid = allProofs.every((p) => verifyMerkleProof(p.proof, dailyRoot));
    expect(allValid).toBe(true);
    console.log(`✓ All ${allProofs.length} alerts have valid proofs`);

    // Step 9: Audit report structure
    const auditReport = {
      date: '2026-08-30',
      dailyRoot,
      alertsCount: deliveredAlerts.length,
      proofs: allProofs,
      generatedAt: new Date().toISOString(),
      tamperEvidenceChecksum: dailyRoot, // Publication checksum
    };

    expect(auditReport.alertsCount).toBe(4);
    expect(auditReport.proofs.length).toBe(4);
    console.log('✓ Audit report generated with tamper-evident checksum');
    console.log('\n📋 Audit Report Summary:');
    console.log(JSON.stringify(auditReport, null, 2));
  });

  it('detects addition/deletion of alerts in the tree', () => {
    const originalAlerts = [
      { id: 'alert-1', txHash: 'tx1' },
      { id: 'alert-2', txHash: 'tx2' },
      { id: 'alert-3', txHash: 'tx3' },
    ];

    const originalLeaves = originalAlerts.map((a) =>
      Buffer.from(JSON.stringify(a), 'utf-8')
    );
    const originalTree = buildMerkleTree(originalLeaves);
    const originalRoot = originalTree.root;

    // Generate proof for alert-2
    const proof = generateMerkleProof(originalTree, 1);
    const leafHash = hashMerkleLeaf(originalLeaves[1]);

    // Proof is valid for original tree
    expect(verifyMerkleProof({ leafHash, path: proof }, originalRoot)).toBe(true);

    // Simulate deletion attack: remove alert-3
    const deletedAlerts = originalAlerts.slice(0, 2);
    const deletedLeaves = deletedAlerts.map((a) =>
      Buffer.from(JSON.stringify(a), 'utf-8')
    );
    const deletedTree = buildMerkleTree(deletedLeaves);

    // Root changes when tree structure changes
    expect(deletedTree.root).not.toBe(originalRoot);
    console.log('✓ Deletion detected: root hash changed');

    // Original proof doesn't verify against new root
    const isValidAgainstNewRoot = verifyMerkleProof({ leafHash, path: proof }, deletedTree.root);
    expect(isValidAgainstNewRoot).toBe(false);
    console.log('✓ Proof rejection: alert deletion detected');
  });

  it('demonstrates compact proof size for large audit logs', () => {
    // Simulate a large day's delivery (1024 alerts)
    const alerts = Array.from({ length: 1024 }, (_, i) => ({
      id: `alert-${i.toString().padStart(4, '0')}`,
      txHash: `tx-${i.toString(16)}`,
      amount: (Math.random() * 1000).toFixed(2),
    }));

    const leaves = alerts.map((a) => Buffer.from(JSON.stringify(a), 'utf-8'));
    const tree = buildMerkleTree(leaves);

    // Generate proof for middle alert
    const midIndex = 512;
    const proof = generateMerkleProof(tree, midIndex);

    // Proof size (number of steps) = log2(1024) = 10
    expect(proof.length).toBe(10);
    console.log(
      `✓ Large tree (1024 leaves): proof size = ${proof.length} steps (log2(${leaves.length}))`
    );
    console.log(`  Each step is ~64 bytes (32-byte hash + direction + metadata)`);
    console.log(`  Total proof size: ~${proof.length * 64} bytes`);
    console.log(`  Without Merkle tree, storing all ${leaves.length} hashes would be ${leaves.length * 32} bytes`);
  });
});
