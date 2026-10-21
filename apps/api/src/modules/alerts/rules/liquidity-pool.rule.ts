import {
  LiquidityPoolSentinelEngine,
  LiquidityShiftAssessment,
  LiquidityShiftSeverity,
  ParsedLiquidityPoolEvent,
  liquidityPoolSentinelEngine,
  parseLiquidityPoolEvent,
} from '../../../workers/watcher/liquidity-pool-sentinel';

export type PoolShiftSeverity = LiquidityShiftSeverity;

export interface LiquidityPoolRuleConfig {
  /**
   * Minimum severity to alert on (default WARNING).  'OK' matches every
   * decoded liquidity event regardless of shift magnitude.
   */
  minSeverity?: PoolShiftSeverity;
  /** Custom WARNING shift threshold (percent of reserves). */
  warningShiftPct?: number;
  /** Custom CRITICAL shift threshold (percent of reserves). */
  criticalShiftPct?: number;
  /** Restrict alerts to these AMM pool contract IDs (all pools when empty). */
  poolContractIds?: string[];
  /** Restrict alerts to these operation types (both when empty). */
  eventTypes?: ('DEPOSIT' | 'WITHDRAW')[];
}

export interface AlertRuleLike {
  id: string;
  userId: string;
  walletId?: string | null;
  name?: string | null;
  isActive: boolean;
  conditions?: unknown;
}

export interface LiquidityPoolMatchResult {
  matched: boolean;
  ruleId?: string;
  deliveryPayload?: {
    event: 'soroban.liquidity_pool_shift';
    ruleId: string;
    userId: string;
    contractId: string;
    eventType: 'DEPOSIT' | 'WITHDRAW';
    sender: string;
    tokenA: string;
    tokenB: string;
    amountA: string;
    amountB: string;
    severity: PoolShiftSeverity;
    metrics: LiquidityShiftAssessment['metrics'];
    message: string;
    metadata: Record<string, unknown>;
  };
}

/**
 * Evaluates an incoming Soroban RPC event against an AMM liquidity-pool
 * alert rule.  Decodes `deposit_liquidity` / `withdraw_liquidity` topics
 * (co-locating the threshold configuration in the rule), measures the pool
 * share / reserve movement, and produces a delivery payload for dispatch
 * when the shift exceeds the configured threshold.
 */
export class LiquidityPoolRuleEvaluator {
  private sentinel: LiquidityPoolSentinelEngine;

  constructor(config?: LiquidityPoolRuleConfig) {
    this.sentinel = new LiquidityPoolSentinelEngine(config ?? {});
  }

  public evaluate(rawEvent: any, rule: AlertRuleLike): LiquidityPoolMatchResult {
    if (!rule.isActive) {
      return { matched: false };
    }

    const parsed = parseLiquidityPoolEvent(rawEvent);
    if (!parsed) {
      return { matched: false };
    }

    // Rule-specific thresholds override the global sentinel defaults.
    const ruleConfig = this.extractRuleConfig(rule);
    const engine = ruleConfig
      ? new LiquidityPoolSentinelEngine({
          warningShiftThresholdPct: ruleConfig.warningShiftPct,
          criticalShiftThresholdPct: ruleConfig.criticalShiftPct,
        })
      : liquidityPoolSentinelEngine;

    const assessment = engine.assessLiquidityEvent(parsed);
    if (!assessment) {
      return { matched: false };
    }

    if (ruleConfig) {
      if (
        ruleConfig.poolContractIds &&
        ruleConfig.poolContractIds.length > 0 &&
        !ruleConfig.poolContractIds.includes(parsed.contractId)
      ) {
        return { matched: false };
      }
      if (
        ruleConfig.eventTypes &&
        ruleConfig.eventTypes.length > 0 &&
        !ruleConfig.eventTypes.includes(parsed.eventType)
      ) {
        return { matched: false };
      }
    }

    const minSeverity = ruleConfig?.minSeverity ?? 'WARNING';
    if (!this.meetsSeverityThreshold(assessment.severity, minSeverity)) {
      return { matched: false };
    }

    return {
      matched: true,
      ruleId: rule.id,
      deliveryPayload: {
        event: 'soroban.liquidity_pool_shift',
        ruleId: rule.id,
        userId: rule.userId,
        contractId: assessment.contractId,
        eventType: assessment.eventType,
        sender: assessment.sender,
        tokenA: assessment.tokenA,
        tokenB: assessment.tokenB,
        amountA: assessment.amountA,
        amountB: assessment.amountB,
        severity: assessment.severity,
        metrics: assessment.metrics,
        message: assessment.message,
        metadata: {
          poolSharePct: assessment.metrics.poolSharePct,
          poolSharePctBefore: assessment.metrics.poolSharePctBefore,
          poolShareDeltaPct: assessment.metrics.poolShareDeltaPct,
          reserveChangeAPct: assessment.metrics.reserveChangeAPct,
          reserveChangeBPct: assessment.metrics.reserveChangeBPct,
          shiftPct: assessment.metrics.shiftPct,
          ledgerSeq: parsed.ledgerSeq,
          txHash: parsed.txHash ?? null,
        },
      },
    };
  }

  /**
   * Compares severities: OK < WARNING < CRITICAL.
   */
  public meetsSeverityThreshold(
    severity: PoolShiftSeverity,
    minSeverity: PoolShiftSeverity,
  ): boolean {
    const order: PoolShiftSeverity[] = ['OK', 'WARNING', 'CRITICAL'];
    return order.indexOf(severity) >= order.indexOf(minSeverity);
  }

  private extractRuleConfig(rule: AlertRuleLike): LiquidityPoolRuleConfig | null {
    if (!rule.conditions || typeof rule.conditions !== 'object') return null;

    const conditions = rule.conditions as Record<string, any>;
    if (conditions.liquidityPool && typeof conditions.liquidityPool === 'object') {
      return conditions.liquidityPool as LiquidityPoolRuleConfig;
    }
    if (
      conditions.warningShiftPct !== undefined ||
      conditions.criticalShiftPct !== undefined ||
      conditions.minSeverity !== undefined
    ) {
      return conditions as LiquidityPoolRuleConfig;
    }
    return null;
  }
}

/** Default singleton instance with standard thresholds. */
export const liquidityPoolRuleEvaluator = new LiquidityPoolRuleEvaluator();
