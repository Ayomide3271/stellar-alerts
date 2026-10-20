import { describe, expect, it } from 'vitest';
import {
  AllowanceSentinelEngine,
  type TokenApproval,
} from '../allowance-sentinel';

describe('AllowanceSentinelEngine (#639)', () => {
  const engine = new AllowanceSentinelEngine({
    warningThreshold: 1_000_000_000_000n,
    criticalThreshold: 18446744073709551615n,
    treatZeroExpiryAsUnlimited: true,
  });

  function makeApproval(overrides: Partial<TokenApproval> = {}): TokenApproval {
    return {
      contractId: 'CCONTRACT1',
      from: 'GAOWNER1',
      spender: 'GASPENDER1',
      amount: '1000',
      rawAmount: 1000n,
      liveUntilLedger: 100_000,
      ledgerSeq: 50_000,
      ...overrides,
    };
  }

  describe('assessApproval', () => {
    it('returns null for safe approvals below warning threshold', () => {
      const approval = makeApproval({ rawAmount: 999n, amount: '999' });
      const result = engine.assessApproval(approval);
      expect(result).toBeNull();
    });

    it('flags WARNING for approvals at or above warning threshold', () => {
      const approval = makeApproval({
        rawAmount: 1_000_000_000_000n,
        amount: '1000000000000',
      });
      const result = engine.assessApproval(approval);
      expect(result).not.toBeNull();
      expect(result?.severity).toBe('WARNING');
      expect(result?.exceedsThreshold).toBe(true);
      expect(result?.isUnlimited).toBe(false);
    });

    it('flags CRITICAL for unlimited approvals (u64::MAX)', () => {
      const approval = makeApproval({
        rawAmount: 18446744073709551615n,
        amount: '18446744073709551615',
      });
      const result = engine.assessApproval(approval);
      expect(result).not.toBeNull();
      expect(result?.severity).toBe('CRITICAL');
      expect(result?.isUnlimited).toBe(true);
      expect(result?.exceedsThreshold).toBe(true);
    });

    it('flags CRITICAL for zero expiry when treatZeroExpiryAsUnlimited is true', () => {
      const approval = makeApproval({
        rawAmount: 1000n,
        amount: '1000',
        liveUntilLedger: 0,
      });
      const result = engine.assessApproval(approval);
      expect(result).not.toBeNull();
      expect(result?.severity).toBe('CRITICAL');
      expect(result?.isUnlimited).toBe(true);
    });

    it('does not flag zero expiry as unlimited when treatZeroExpiryAsUnlimited is false', () => {
      const engineNoZero = new AllowanceSentinelEngine({
        warningThreshold: 1_000_000_000_000n,
        treatZeroExpiryAsUnlimited: false,
      });
      const approval = makeApproval({
        rawAmount: 1000n,
        amount: '1000',
        liveUntilLedger: 0,
      });
      const result = engineNoZero.assessApproval(approval);
      expect(result).toBeNull();
    });

    it('includes revocation instructions in the assessment', () => {
      const approval = makeApproval({
        rawAmount: 1_000_000_000_000n,
        amount: '1000000000000',
      });
      const result = engine.assessApproval(approval);
      expect(result?.revocationInstructions).toContain('revoke');
      expect(result?.revocationInstructions).toContain(approval.spender.slice(0, 8));
      expect(result?.revocationInstructions).toContain(approval.contractId.slice(0, 8));
    });

    it('includes a descriptive risk message', () => {
      const approval = makeApproval({
        rawAmount: 1_000_000_000_000n,
        amount: '1000000000000',
      });
      const result = engine.assessApproval(approval);
      expect(result?.message).toContain('WARNING');
      expect(result?.message).toContain('High-value');
      expect(result?.message).toContain(approval.spender.slice(0, 8));
    });

    it('includes unlimited-specific message for u64::MAX', () => {
      const approval = makeApproval({
        rawAmount: 18446744073709551615n,
        amount: '18446744073709551615',
      });
      const result = engine.assessApproval(approval);
      expect(result?.message).toContain('Unlimited');
      expect(result?.message).toContain('full access');
    });
  });

  describe('assessApprovals', () => {
    it('returns only risky approvals from a batch', () => {
      const approvals = [
        makeApproval({ rawAmount: 500n, amount: '500' }), // Safe
        makeApproval({ rawAmount: 1_000_000_000_000n, amount: '1000000000000' }), // Warning
        makeApproval({ rawAmount: 100n, amount: '100' }), // Safe
        makeApproval({ rawAmount: 18446744073709551615n, amount: '18446744073709551615' }), // Critical
      ];

      const results = engine.assessApprovals(approvals);
      expect(results).toHaveLength(2);
      expect(results[0].severity).toBe('WARNING');
      expect(results[1].severity).toBe('CRITICAL');
    });

    it('returns empty array when no approvals exceed threshold', () => {
      const approvals = [
        makeApproval({ rawAmount: 100n, amount: '100' }),
        makeApproval({ rawAmount: 500n, amount: '500' }),
      ];

      const results = engine.assessApprovals(approvals);
      expect(results).toHaveLength(0);
    });

    it('handles empty input array', () => {
      const results = engine.assessApprovals([]);
      expect(results).toHaveLength(0);
    });
  });

  describe('custom thresholds', () => {
    it('respects custom warning threshold', () => {
      const customEngine = new AllowanceSentinelEngine({
        warningThreshold: 500n,
        criticalThreshold: 18446744073709551615n,
      });
      const approval = makeApproval({ rawAmount: 500n, amount: '500' });
      const result = customEngine.assessApproval(approval);
      expect(result).not.toBeNull();
      expect(result?.severity).toBe('WARNING');
    });

    it('respects custom critical threshold', () => {
      const customEngine = new AllowanceSentinelEngine({
        warningThreshold: 100n,
        criticalThreshold: 1000n,
      });
      const approval = makeApproval({ rawAmount: 1000n, amount: '1000' });
      const result = customEngine.assessApproval(approval);
      expect(result).not.toBeNull();
      expect(result?.severity).toBe('CRITICAL');
    });
  });
});
