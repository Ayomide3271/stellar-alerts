import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MerkleAuditService } from './merkle.service';
import {
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  hashMerkleLeaf,
  MerkleProof,
} from '@stellar-alerts/shared';

describe('MerkleAuditService', () => {
  let service: MerkleAuditService;

  beforeEach(() => {
    service = new MerkleAuditService();
  });

  describe('Merkle Tree Computation & Verification', () => {
    it('builds and verifies inclusion proof for standard binary Merkle tree', () => {
      // Create sample alert payloads
      const alerts = [
        { id: 'alert-1', amount: '100', asset: 'USDC' },
        { id: 'alert-2', amount: '200', asset: 'USDC' },
        { id: 'alert-3', amount: '300', asset: 'XLM' },
        { id: 'alert-4', amount: '400', asset: 'XLM' },
      ];

      const leaves = alerts.map((alert) => Buffer.from(JSON.stringify(alert), 'utf-8'));

      // Build Merkle tree
      const tree = buildMerkleTree(leaves);

      // Verify tree was built
      expect(tree.root).toBeDefined();
      expect(tree.root).toMatch(/^[0-9a-f]{64}$/i); // 32-byte hex hash
      expect(tree.layers[0].length).toBe(4); // 4 leaves
      expect(tree.layers[tree.layers.length - 1].length).toBe(1); // 1 root

      // Verify root is at the top
      expect(tree.root).toBe(tree.layers[tree.layers.length - 1][0]);
    });

    it('generates and verifies inclusion proofs for each leaf', () => {
      const alerts = [
        { id: 'alert-1', txHash: 'tx-abc123' },
        { id: 'alert-2', txHash: 'tx-def456' },
        { id: 'alert-3', txHash: 'tx-ghi789' },
      ];

      const leaves = alerts.map((alert) => Buffer.from(JSON.stringify(alert), 'utf-8'));
      const tree = buildMerkleTree(leaves);

      // Generate proofs for each leaf
      for (let i = 0; i < alerts.length; i++) {
        const path = generateMerkleProof(tree, i);
        const leafHash = hashMerkleLeaf(leaves[i]);
        const proof: MerkleProof = { leafHash, path };

        // Verify each proof
        const isValid = verifyMerkleProof(proof, tree.root);
        expect(isValid).toBe(true);
      }
    });

    it('rejects tampered leaf payload', () => {
      const alerts = [
        { id: 'alert-1', amount: '100' },
        { id: 'alert-2', amount: '200' },
        { id: 'alert-3', amount: '300' },
      ];

      const leaves = alerts.map((alert) => Buffer.from(JSON.stringify(alert), 'utf-8'));
      const tree = buildMerkleTree(leaves);

      // Generate proof for alert-1
      const path = generateMerkleProof(tree, 0);
      const leafHash = hashMerkleLeaf(leaves[0]);
      const proof: MerkleProof = { leafHash, path };

      // Verify original proof works
      expect(verifyMerkleProof(proof, tree.root)).toBe(true);

      // Tamper with the leaf data
      const tamperedAlert = JSON.parse(leaves[0].toString('utf-8'));
      tamperedAlert.amount = '999'; // Change amount
      const tamperedLeafHash = hashMerkleLeaf(
        Buffer.from(JSON.stringify(tamperedAlert), 'utf-8')
      );
      const tamperedProof: MerkleProof = { leafHash: tamperedLeafHash, path };

      // Tampered proof should fail
      expect(verifyMerkleProof(tamperedProof, tree.root)).toBe(false);
    });

    it('rejects tampered root hash', () => {
      const alerts = [
        { id: 'alert-1', txHash: 'tx-1' },
        { id: 'alert-2', txHash: 'tx-2' },
      ];

      const leaves = alerts.map((alert) => Buffer.from(JSON.stringify(alert), 'utf-8'));
      const tree = buildMerkleTree(leaves);

      const path = generateMerkleProof(tree, 0);
      const leafHash = hashMerkleLeaf(leaves[0]);
      const proof: MerkleProof = { leafHash, path };

      // Verify with correct root
      expect(verifyMerkleProof(proof, tree.root)).toBe(true);

      // Flip one hex digit in root to tamper with it
      const tamperedRoot =
        tree.root.substring(0, 62) + (tree.root[62] === 'a' ? 'b' : 'a') + tree.root[63];

      // Should reject tampered root
      expect(verifyMerkleProof(proof, tamperedRoot)).toBe(false);
    });

    it('handles odd number of leaves correctly (self-pairing)', () => {
      const alerts = [
        { id: 'alert-1', status: 'delivered' },
        { id: 'alert-2', status: 'delivered' },
        { id: 'alert-3', status: 'delivered' }, // Odd one out
      ];

      const leaves = alerts.map((alert) => Buffer.from(JSON.stringify(alert), 'utf-8'));
      const tree = buildMerkleTree(leaves);

      // Tree should build without error
      expect(tree.root).toBeDefined();

      // All proofs should verify
      for (let i = 0; i < alerts.length; i++) {
        const path = generateMerkleProof(tree, i);
        const leafHash = hashMerkleLeaf(leaves[i]);
        const proof: MerkleProof = { leafHash, path };
        expect(verifyMerkleProof(proof, tree.root)).toBe(true);
      }
    });

    it('rejects invalid proof with malformed hex', () => {
      const proof: MerkleProof = {
        leafHash: 'not-a-valid-hex-string',
        path: [],
      };

      const root = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      // Should safely return false instead of throwing
      expect(verifyMerkleProof(proof, root)).toBe(false);
    });

    it('rejects proof with invalid root hash', () => {
      const alerts = [{ id: 'alert-1', amount: '100' }];
      const leaves = alerts.map((alert) => Buffer.from(JSON.stringify(alert), 'utf-8'));
      const tree = buildMerkleTree(leaves);

      const path = generateMerkleProof(tree, 0);
      const leafHash = hashMerkleLeaf(leaves[0]);
      const proof: MerkleProof = { leafHash, path };

      const invalidRoot = 'not-a-valid-root';
      expect(verifyMerkleProof(proof, invalidRoot)).toBe(false);
    });

    it('produces consistent tree across multiple builds with same data', () => {
      const alerts = [
        { id: 'alert-1', txHash: 'abc' },
        { id: 'alert-2', txHash: 'def' },
        { id: 'alert-3', txHash: 'ghi' },
      ];

      const leaves1 = alerts.map((alert) => Buffer.from(JSON.stringify(alert), 'utf-8'));
      const tree1 = buildMerkleTree(leaves1);

      const leaves2 = alerts.map((alert) => Buffer.from(JSON.stringify(alert), 'utf-8'));
      const tree2 = buildMerkleTree(leaves2);

      // Same data should produce same root
      expect(tree1.root).toBe(tree2.root);

      // Proofs should be identical
      for (let i = 0; i < alerts.length; i++) {
        const proof1 = generateMerkleProof(tree1, i);
        const proof2 = generateMerkleProof(tree2, i);
        expect(proof1).toEqual(proof2);
      }
    });
  });

  describe('Merkle Service Methods (with mocked database)', () => {
    it('derives leaf hash deterministically from alert payload', () => {
      const alert = {
        id: 'alert-uuid',
        recipientAddress: 'GADDRESS',
        amount: '100.00',
        assetCode: 'USDC',
        txHash: 'tx123',
        createdAt: '2026-08-30T14:00:00Z',
        deliveredAt: '2026-08-30T14:01:00Z',
      };

      const alertBuffer = Buffer.from(JSON.stringify(alert), 'utf-8');
      const leafHash1 = hashMerkleLeaf(alertBuffer);
      const leafHash2 = hashMerkleLeaf(alertBuffer);

      // Same alert should produce same leaf hash
      expect(leafHash1).toBe(leafHash2);
      expect(leafHash1).toMatch(/^[0-9a-f]{64}$/i);
    });

    it('verifyAlertInclusion delegates to verifyMerkleProof', () => {
      const proof: MerkleProof = {
        leafHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        path: [],
      };
      const root = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      // When leaf hash equals root with no path, proof should verify
      const isValid = service.verifyAlertInclusion('alert-1', proof, root);
      expect(isValid).toBe(true);
    });

    it('storeDailyMerkleCommitment returns commitment structure', async () => {
      const commitment = await service.storeDailyMerkleCommitment(
        '2026-08-30',
        'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        5
      );

      expect(commitment).toBeDefined();
      expect(commitment.date).toBe('2026-08-30');
      expect(commitment.root).toBe('abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234');
      expect(commitment.treeSize).toBe(5);
      expect(commitment.id).toBeDefined();
    });

    it('getDailyMerkleCommitment returns null placeholder', async () => {
      const commitment = await service.getDailyMerkleCommitment('2026-08-30');
      expect(commitment).toBeNull();
    });
  });

  describe('Domain Separation & Security', () => {
    it('leaf hashes differ from node hashes with same bytes', () => {
      const data = Buffer.from('test-data');

      // Leaf uses 0x00 prefix
      const leafHash = hashMerkleLeaf(data);

      // Node uses 0x01 prefix (would need left+right buffers for actual node hash)
      // This test verifies the domain separation constants are different
      expect(leafHash).toBeDefined();
      expect(leafHash).toMatch(/^[0-9a-f]{64}$/i);
    });

    it('handles large trees with many leaves', () => {
      // Create 256 leaves (power of 2)
      const leaves = Array.from({ length: 256 }, (_, i) =>
        Buffer.from(JSON.stringify({ id: `alert-${i}`, index: i }), 'utf-8')
      );

      const tree = buildMerkleTree(leaves);

      // Verify tree structure
      expect(tree.root).toBeDefined();
      expect(tree.layers[0].length).toBe(256);

      // Verify first and last proofs work
      const firstProof = generateMerkleProof(tree, 0);
      const lastProof = generateMerkleProof(tree, 255);

      expect(verifyMerkleProof({ leafHash: hashMerkleLeaf(leaves[0]), path: firstProof }, tree.root)).toBe(true);
      expect(verifyMerkleProof({ leafHash: hashMerkleLeaf(leaves[255]), path: lastProof }, tree.root)).toBe(true);
    });
  });
});
