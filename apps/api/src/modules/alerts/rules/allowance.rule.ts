import {
  AllowanceSentinelEngine,
  AllowanceRiskAssessment,
  TokenApproval,
  type AllowanceSeverity,
} from '../../../services/allowance-sentinel';
import { parseApprovalEvent, type ParsedSorobanApproval } from '../../../lib/soroban';

export interface AllowanceRuleConfig {
  /** Minimum severity to trigger an alert (WARNING or CRITICAL). */
  minSeverity?: AllowanceSeverity;
  /** Custom warning threshold in raw token units. */
  warningThreshold?: bigint;
  /** Custom critical threshold in raw token units. */
  criticalThreshold?: bigint;
  /** Whether to treat zero expiry as unlimited. */
  treatZeroExpiryAsUnlimited?: boolean;
}

export interface AlertRuleLike {
  id: string;
  userId: string;
  walletId?: string | null;
  name?: string | null;
  isActive: boolean;
  conditions?: any;
}

export interface AllowanceMatchResult {
  matched: boolean;
  ruleId?: string;
  deliveryPayload?: {
    event: 'soroban.allowance_risk';
    ruleId: string;
    userId: string;
    contractId: string;
    from: string;
    spender: string;
    amount: string;
    severity: AllowanceSeverity;
    isUnlimited: boolean;
    message: string;
    revocationInstructions: string;
    metadata: Record<string, any>;
  };
}

export class AllowanceRuleEvaluator {
  private sentinel: AllowanceSentinelEngine;

  constructor(config?: AllowanceRuleConfig) {
    this.sentinel = new AllowanceSentinelEngine(config);
  }

  /**
   * Evaluates an incoming Soroban RPC event against an AlertRule.
   * If the event is an approve invocation that exceeds safety thresholds,
   * produces an alert delivery payload with revocation instructions.
   */
  public evaluate(
    rawEvent: any,
    rule: AlertRuleLike,
  ): AllowanceMatchResult {
    if (!rule.isActive) {
      return { matched: false };
    }

    const ruleConfig = this.extractRuleConfig(rule);
    if (!ruleConfig) {
      return { matched: false };
    }

    // Parse the event as an approval
    const approval = parseApprovalEvent(rawEvent);
    if (!approval) {
      return { matched: false };
    }

    // Create sentinel with rule-specific config
    const sentinel = new AllowanceSentinelEngine(ruleConfig);

    // Convert ParsedSorobanApproval to TokenApproval
    const tokenApproval: TokenApproval = {
      contractId: approval.contractId,
      from: approval.from,
      spender: approval.spender,
      amount: approval.amount,
      rawAmount: approval.rawAmount,
      liveUntilLedger: approval.liveUntilLedger,
      ledgerSeq: approval.ledgerSeq,
    };

    // Assess the approval
    const assessment = sentinel.assessApproval(tokenApproval);
    if (!assessment) {
      return { matched: false };
    }

    // Check minimum severity
    const minSeverity = ruleConfig.minSeverity ?? 'WARNING';
    if (!this.meetsSeverityThreshold(assessment.severity, minSeverity)) {
      return { matched: false };
    }

    return {
      matched: true,
      ruleId: rule.id,
      deliveryPayload: {
        event: 'soroban.allowance_risk',
        ruleId: rule.id,
        userId: rule.userId,
        contractId: assessment.contractId,
        from: assessment.from,
        spender: assessment.spender,
        amount: assessment.amount,
        severity: assessment.severity,
        isUnlimited: assessment.isUnlimited,
        message: assessment.message,
        revocationInstructions: assessment.revocationInstructions,
        metadata: {
          rawAmount: assessment.rawAmount.toString(),
          liveUntilLedger: assessment.liveUntilLedger,
          ledgerSeq: approval.ledgerSeq,
          exceedsThreshold: assessment.exceedsThreshold,
        },
      },
    };
  }

  /**
   * Checks if a severity meets or exceeds the minimum threshold.
   */
  private meetsSeverityThreshold(
    severity: AllowanceSeverity,
    minSeverity: AllowanceSeverity,
  ): boolean {
    const order: AllowanceSeverity[] = ['OK', 'WARNING', 'CRITICAL'];
    return order.indexOf(severity) >= order.indexOf(minSeverity);
  }

  /**
   * Extracts allowance rule config from the AlertRule conditions.
   */
  private extractRuleConfig(rule: AlertRuleLike): AllowanceRuleConfig | null {
    if (!rule.conditions) return null;

    if (typeof rule.conditions === 'object') {
      const cond = rule.conditions as any;
      if (cond.allowance) {
        return cond.allowance as AllowanceRuleConfig;
      }
      // Support direct config in conditions
      if (cond.warningThreshold || cond.criticalThreshold || cond.minSeverity) {
        return cond as AllowanceRuleConfig;
      }
    }

    return null;
  }
}

/**
 * Default singleton instance with standard thresholds.
 */
export const allowanceRuleEvaluator = new AllowanceRuleEvaluator();
