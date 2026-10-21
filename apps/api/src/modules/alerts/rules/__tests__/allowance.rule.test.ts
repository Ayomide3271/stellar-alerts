import { describe, expect, it } from 'vitest';
import {
  AllowanceRuleEvaluator,
  type AlertRuleLike,
} from '../allowance.rule';

describe('AllowanceRuleEvaluator (#639)', () => {
  const evaluator = new AllowanceRuleEvaluator();

  function makeRule(overrides: Partial<AlertRuleLike> = {}): AlertRuleLike {
    return {
      id: 'rule-1',
      userId: 'user-1',
      walletId: 'wallet-1',
      name: 'Test Allowance Rule',
      isActive: true,
      conditions: {
        allowance: {
          minSeverity: 'WARNING',
          warningThreshold: '1000000000000',
          criticalThreshold: '18446744073709551615',
        },
      },
      ...overrides,
    };
  }

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

  describe('evaluate', () => {
    it('returns false for inactive rules', () => {
      const rule = makeRule({ isActive: false });
      const event = makeApprovalEvent();
      const result = evaluator.evaluate(event, rule);
      expect(result.matched).toBe(false);
    });

    it('returns false for non-approve events', () => {
      const rule = makeRule();
      const event = {
        contractId: 'CCONTRACT1',
        topic: ['transfer'],
        value: { amount: '100' },
      };
      const result = evaluator.evaluate(event, rule);
      expect(result.matched).toBe(false);
    });

    it('matches approve events that exceed warning threshold', () => {
      const rule = makeRule();
      const event = makeApprovalEvent();
      const result = evaluator.evaluate(event, rule);
      expect(result.matched).toBe(true);
      expect(result.ruleId).toBe('rule-1');
      expect(result.deliveryPayload?.event).toBe('soroban.allowance_risk');
      expect(result.deliveryPayload?.severity).toBe('WARNING');
    });

    it('matches approve events with unlimited amount', () => {
      const rule = makeRule();
      const event = makeApprovalEvent({
        value: {
          from: 'GAOWNER1',
          spender: 'GASPENDER1',
          amount: '18446744073709551615',
          live_until_ledger: 123456,
        },
      });
      const result = evaluator.evaluate(event, rule);
      expect(result.matched).toBe(true);
      expect(result.deliveryPayload?.severity).toBe('CRITICAL');
      expect(result.deliveryPayload?.isUnlimited).toBe(true);
    });

    it('respects minSeverity configuration', () => {
      const rule = makeRule({
        conditions: {
          allowance: {
            minSeverity: 'CRITICAL',
            warningThreshold: '1000000000000',
            criticalThreshold: '18446744073709551615',
          },
        },
      });
      const event = makeApprovalEvent({
        value: {
          from: 'GAOWNER1',
          spender: 'GASPENDER1',
          amount: '1000000000000',
          live_until_ledger: 123456,
        },
      });
      const result = evaluator.evaluate(event, rule);
      expect(result.matched).toBe(false); // WARNING < CRITICAL threshold
    });

    it('includes revocation instructions in delivery payload', () => {
      const rule = makeRule();
      const event = makeApprovalEvent();
      const result = evaluator.evaluate(event, rule);
      expect(result.deliveryPayload?.revocationInstructions).toContain('revoke');
    });

    it('includes metadata with raw amount and ledger info', () => {
      const rule = makeRule();
      const event = makeApprovalEvent();
      const result = evaluator.evaluate(event, rule);
      expect(result.deliveryPayload?.metadata).toBeDefined();
      expect(result.deliveryPayload?.metadata.rawAmount).toBe('1000000000000');
      expect(result.deliveryPayload?.metadata.liveUntilLedger).toBe(123456);
      expect(result.deliveryPayload?.metadata.ledgerSeq).toBe(99999);
    });

    it('handles rules without nested allowance condition', () => {
      const rule = makeRule({
        conditions: {
          minSeverity: 'WARNING',
          warningThreshold: '1000000000000',
          criticalThreshold: '18446744073709551615',
        },
      });
      const event = makeApprovalEvent();
      const result = evaluator.evaluate(event, rule);
      expect(result.matched).toBe(true);
    });

    it('returns false for rules without allowance config', () => {
      const rule = makeRule({
        conditions: {
          someOtherCondition: true,
        },
      });
      const event = makeApprovalEvent();
      const result = evaluator.evaluate(event, rule);
      expect(result.matched).toBe(false);
    });
  });

  describe('meetsSeverityThreshold', () => {
    it('correctly compares severity levels', () => {
      const evaluator = new AllowanceRuleEvaluator();
      // OK < WARNING < CRITICAL
      expect(evaluator['meetsSeverityThreshold']('OK', 'OK')).toBe(true);
      expect(evaluator['meetsSeverityThreshold']('WARNING', 'OK')).toBe(true);
      expect(evaluator['meetsSeverityThreshold']('CRITICAL', 'OK')).toBe(true);
      expect(evaluator['meetsSeverityThreshold']('WARNING', 'WARNING')).toBe(true);
      expect(evaluator['meetsSeverityThreshold']('CRITICAL', 'WARNING')).toBe(true);
      expect(evaluator['meetsSeverityThreshold']('CRITICAL', 'CRITICAL')).toBe(true);
      expect(evaluator['meetsSeverityThreshold']('OK', 'WARNING')).toBe(false);
      expect(evaluator['meetsSeverityThreshold']('WARNING', 'CRITICAL')).toBe(false);
      expect(evaluator['meetsSeverityThreshold']('OK', 'CRITICAL')).toBe(false);
    });
  });
});
