import {
  detectAllowanceRisksFromEventBatch,
  parsedApprovalToTokenApproval,
} from '../allowance-sentinel';
import { parseApprovalEvent, type ParsedSorobanApproval } from '../../lib/soroban';
import { AllowanceSentinelEngine } from '../../../services/allowance-sentinel';

describe('AllowanceSentinel Worker (#639)', () => {
  const engine = new AllowanceSentinelEngine({
    warningThreshold: 1_000_000_000_000n,
    criticalThreshold: 18446744073709551615n,
  });

  function makeApprovalEvent(overrides: any = {}): any {
    return {
      contractId: 'CCONTRACT1',
      topic: ['approve', 'GAOWNER1', 'GASPENDER1'],
      value: {
        from: 'GAOWNER1',
        spender: 'GASPENDER1',
        amount: '1000000000000',
        live_until_ledger: 123456,
      },
      ledgerSeq: 99999,
      ...overrides,
    };
  }

  describe('parsedApprovalToTokenApproval', () => {
    it('converts ParsedSorobanApproval to TokenApproval', () => {
      const parsed: ParsedSorobanApproval = {
        contractId: 'CCONTRACT1',
        from: 'GAOWNER1',
        spender: 'GASPENDER1',
        amount: '1000',
        rawAmount: 1000n,
        liveUntilLedger: 100_000,
        ledgerSeq: 50_000,
      };

      const tokenApproval = parsedApprovalToTokenApproval(parsed);
      expect(tokenApproval.contractId).toBe('CCONTRACT1');
      expect(tokenApproval.from).toBe('GAOWNER1');
      expect(tokenApproval.spender).toBe('GASPENDER1');
      expect(tokenApproval.amount).toBe('1000');
      expect(tokenApproval.rawAmount).toBe(1000n);
      expect(tokenApproval.liveUntilLedger).toBe(100_000);
      expect(tokenApproval.ledgerSeq).toBe(50_000);
    });
  });

  describe('detectAllowanceRisksFromEventBatch', () => {
    it('detects high-value approvals in event batch', () => {
      const events = [
        makeApprovalEvent({
          value: {
            from: 'GAOWNER1',
            spender: 'GASPENDER1',
            amount: '1000000000000',
            live_until_ledger: 123456,
          },
        }),
      ];

      const assessments = detectAllowanceRisksFromEventBatch(events, engine);
      expect(assessments).toHaveLength(1);
      expect(assessments[0].severity).toBe('WARNING');
      expect(assessments[0].contractId).toBe('CCONTRACT1');
    });

    it('detects unlimited approvals in event batch', () => {
      const events = [
        makeApprovalEvent({
          value: {
            from: 'GAOWNER1',
            spender: 'GASPENDER1',
            amount: '18446744073709551615',
            live_until_ledger: 123456,
          },
        }),
      ];

      const assessments = detectAllowanceRisksFromEventBatch(events, engine);
      expect(assessments).toHaveLength(1);
      expect(assessments[0].severity).toBe('CRITICAL');
      expect(assessments[0].isUnlimited).toBe(true);
    });

    it('ignores non-approve events in batch', () => {
      const events = [
        {
          contractId: 'CCONTRACT1',
          topic: ['transfer'],
          value: { amount: '100' },
        },
      ];

      const assessments = detectAllowanceRisksFromEventBatch(events, engine);
      expect(assessments).toHaveLength(0);
    });

    it('ignores safe approvals below threshold', () => {
      const events = [
        makeApprovalEvent({
          value: {
            from: 'GAOWNER1',
            spender: 'GASPENDER1',
            amount: '100',
            live_until_ledger: 123456,
          },
        }),
      ];

      const assessments = detectAllowanceRisksFromEventBatch(events, engine);
      expect(assessments).toHaveLength(0);
    });

    it('handles mixed event batch with both risky and safe approvals', () => {
      const events = [
        makeApprovalEvent({
          value: {
            from: 'GAOWNER1',
            spender: 'GASPENDER1',
            amount: '100',
            live_until_ledger: 123456,
          },
        }),
        makeApprovalEvent({
          value: {
            from: 'GAOWNER2',
            spender: 'GASPENDER2',
            amount: '1000000000000',
            live_until_ledger: 123456,
          },
        }),
        {
          contractId: 'CCONTRACT1',
          topic: ['transfer'],
          value: { amount: '100' },
        },
      ];

      const assessments = detectAllowanceRisksFromEventBatch(events, engine);
      expect(assessments).toHaveLength(1);
      expect(assessments[0].from).toBe('GAOWNER2');
    });

    it('handles empty event batch', () => {
      const assessments = detectAllowanceRisksFromEventBatch([], engine);
      expect(assessments).toHaveLength(0);
    });

    it('respects custom engine thresholds', () => {
      const customEngine = new AllowanceSentinelEngine({
        warningThreshold: 500n,
        criticalThreshold: 18446744073709551615n,
      });

      const events = [
        makeApprovalEvent({
          value: {
            from: 'GAOWNER1',
            spender: 'GASPENDER1',
            amount: '500',
            live_until_ledger: 123456,
          },
        }),
      ];

      const assessments = detectAllowanceRisksFromEventBatch(events, customEngine);
      expect(assessments).toHaveLength(1);
      expect(assessments[0].severity).toBe('WARNING');
    });
  });
});
