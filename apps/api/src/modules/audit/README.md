# Merkle Audit Module

Cryptographic Merkle tree generation and verification for historical alert audit logs.

## Overview

This module implements tamper-evident proof generation for alert delivery records using standard binary Merkle trees with SHA-256 hashing. Enables independent verification that delivered alerts have not been altered or deleted without cryptographic evidence.

## Architecture

### Core Components

1. **MerkleAuditService** (`merkle.service.ts`)
   - Generates daily Merkle roots over delivered alerts
   - Produces compact inclusion proofs for individual alerts
   - Verifies proofs independently (no database required)
   - Stores audit commitments for trail

2. **Audit Routes** (`audit.routes.ts`)
   - REST endpoints for Merkle operations
   - Fastify-based HTTP handlers
   - Integrates with main app

3. **Shared Merkle Library** (`packages/shared/src/merkle.ts`)
   - Single source of truth for all Merkle primitives
   - Domain-separated SHA-256 hashing (leaf vs node)
   - Proof generation and verification
   - Used by both API and CLI

## API Endpoints

### GET /audit/merkle-root/:date

Generate or retrieve the Merkle root for a specific date.

**Parameters:**
- `date` (string): ISO date format `YYYY-MM-DD`

**Response:**
```json
{
  "success": true,
  "date": "2026-08-30",
  "root": "aaaa...bbbb",
  "treeSize": 42,
  "timestamp": "2026-08-30T14:22:10Z"
}
```

### GET /audit/proof/:alertId/:date

Generate a Merkle inclusion proof for a specific alert.

**Parameters:**
- `alertId` (string): UUID of the alert
- `date` (string): ISO date `YYYY-MM-DD` when alert was delivered

**Response:**
```json
{
  "success": true,
  "alertId": "alert-123",
  "date": "2026-08-30",
  "proof": {
    "leafHash": "aaaa...bbbb",
    "path": [
      { "siblingHash": "cccc...dddd", "direction": "right" },
      { "siblingHash": "eeee...ffff", "direction": "left" }
    ]
  },
  "timestamp": "2026-08-30T14:22:10Z"
}
```

### POST /audit/verify

Independently verify a Merkle inclusion proof against a root hash.

**Request Body:**
```json
{
  "alertId": "alert-123",
  "proof": { "leafHash": "...", "path": [...] },
  "expectedRoot": "aaaa...bbbb"
}
```

**Response:**
```json
{
  "success": true,
  "alertId": "alert-123",
  "verified": true,
  "timestamp": "2026-08-30T14:22:10Z"
}
```

### POST /audit/commit

Store a daily Merkle root commitment as an immutable audit checkpoint.

**Request Body:**
```json
{
  "date": "2026-08-30",
  "root": "aaaa...bbbb",
  "treeSize": 42
}
```

## Security Properties

### Tamper Detection

- **Leaf Modification**: Changing any alert's data invalidates its leaf hash, breaking the proof
- **Tree Deletion**: Removing or adding alerts changes the tree structure and root
- **Root Tampering**: Modifying the root hash will not verify against the proof path

### Cryptographic Guarantees

- **SHA-256 domain separation**: Leaf hashes (0x00 prefix) cannot collide with node hashes (0x01 prefix)
- **Deterministic**: Same alert set always produces identical root (reproducible audit trail)
- **Compact proofs**: O(log n) proof size for n alerts (e.g., 10 steps for 1024 alerts)
- **Independent verification**: No database or service access required to verify proofs

## Usage Example

```typescript
// 1. Generate daily root (service queries delivered alerts)
const { root, treeSize } = await merkleService.generateDailyMerkleRoot('2026-08-30');

// 2. Generate proof for an alert
const proof = await merkleService.generateAlertInclusionProof('alert-123', '2026-08-30');

// 3. Publish root and proofs (immutable storage, blockchain, etc.)
await publishAuditChecksum(root);

// 4. Independent verification (can run offline, in auditor's environment)
const isValid = merkleService.verifyAlertInclusion('alert-123', proof, root);
```

## Data Model

### Leaf Payload (Alert Record)

Each alert becomes a leaf by JSON-serializing:
```typescript
{
  id: string;
  recipientAddress: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  txHash: string;
  createdAt: Date;
  deliveredAt: Date;
}
```

Serialization is deterministic (sorted keys, consistent formatting) to ensure reproducibility.

### Merkle Proof Structure

```typescript
{
  leafHash: string;        // Hex-encoded SHA256 of leaf
  path: [
    {
      siblingHash: string; // Hex-encoded sibling hash
      direction: 'left' | 'right'; // Which side sibling is on
    },
    // ... more steps from leaf to root
  ]
}
```

## Testing

### Unit Tests (`merkle.service.test.ts`)
- Tree construction and verification
- Proof generation for all leaves
- Tamper detection (leaf, root, structural changes)
- Odd-node pairing (self-duplication)
- Invalid input handling
- Large tree performance

### Controller Tests (`audit.controller.test.ts`)
- Endpoint request/response validation
- Date format validation
- Error handling and HTTP status codes
- Service integration

### Integration Tests (`merkle.integration.test.ts`)
- Complete audit flow: generate → prove → verify
- Tamper-evident properties
- Audit report generation
- Large-scale proof efficiency

Run tests:
```bash
npm run test -- audit
```

## Compliance & Audit Trail

This module supports:

1. **Regulatory Compliance**: Cryptographic evidence that records haven't been modified
2. **Audit Logs**: Immutable daily checkpoints with independent verification
3. **Third-Party Verification**: Auditors can verify proofs without database access
4. **Blockchain Publication**: Root hashes can be published to distributed ledgers for added immutability

## Performance

- **Tree generation**: O(n log n) for n alerts (dominated by sorting)
- **Proof generation**: O(log n)
- **Proof verification**: O(log n)
- **Proof size**: ~640 bytes for proof path of 10 steps (typical for 1024 alerts)

## References

- Bitcoin Transaction Merkle Tree: https://developer.bitcoin.org/reference/block_chain.html
- RFC 6962 Certificate Transparency: https://tools.ietf.org/html/rfc6962 (second preimage attack prevention)
- Domain Separation: https://eprint.iacr.org/2016/1019.pdf
