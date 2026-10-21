import {
  ImpermanentLossAlert,
  ImpermanentLossService,
  IlPositionSnapshot,
  impermanentLossService,
  LivePrices,
} from '../../analytics/impermanent-loss.service';

export type IlSeverity = 'OK' | 'WARNING' | 'CRITICAL';

export interface ImpermanentLossRuleConfig {
  /** User-defined IL threshold in percent (e.g. 5 → alert at 5% loss). */
  ilThresholdPct?: number;
  /** Minimum severity the rule responds to (default WARNING). */
  minSeverity?: IlSeverity;
  /** Restrict alerts to these pools (all pools when empty/omitted). */
  poolIds?: string[];
}

export interface AlertRuleLike {
  id: string;
  userId: string;
  walletId?: string | null;
  name?: string | null;
  isActive: boolean;
  conditions?: unknown;
}

export interface ImpermanentLossMatchResult {
  matched: boolean;
  ruleId?: string;
  deliveryPayload?: {
    event: 'analytics.impermanent_loss_alert';
    ruleId: string;
    userId: string;
    positionId: string;
    poolId: string;
    pair: { token0: string; token1: string };
    severity: IlSeverity;
    ilPct: number;
    hodlValue: number;
    lpValue: number;
    netOfFeesPct: number;
    message: string;
    metadata: Record<string, unknown>;
  };
}

/**
 * Evaluates a liquidity-provider position against an impermanent-loss alert
 * rule.  Computes the constant-product IL divergence (initial deposit price
 * ratio vs current ratio) and warns when the loss versus the 100% HODL
 * baseline crosses the user-defined threshold.
 */
export class ImpermanentLossRuleEvaluator {
  private service: ImpermanentLossService;

  constructor(service?: ImpermanentLossService) {
    this.service = service ?? impermanentLossService;
  }

  public evaluate(
    snapshot: IlPositionSnapshot,
    livePrices: LivePrices,
    rule: AlertRuleLike,
  ): ImpermanentLossMatchResult {
    if (!rule.isActive) {
      return { matched: false };
    }

    const config = this.extractRuleConfig(rule);
    if (!config) {
      return { matched: false };
    }

    if (config.poolIds && config.poolIds.length > 0 && !config.poolIds.includes(snapshot.poolId)) {
      return { matched: false };
    }

    const thresholdPct = config.ilThresholdPct ?? this.service.warningThresholdPct;
    const alert = this.service.evaluateThreshold(snapshot, livePrices, thresholdPct);
    if (!alert) {
      return { matched: false };
    }

    const minSeverity = config.minSeverity ?? 'WARNING';
    if (!this.meetsSeverityThreshold(alert.severity, minSeverity)) {
      return { matched: false };
    }

    return {
      matched: true,
      ruleId: rule.id,
      deliveryPayload: {
        event: 'analytics.impermanent_loss_alert',
        ruleId: rule.id,
        userId: rule.userId,
        positionId: alert.positionId,
        poolId: alert.poolId,
        pair: {
          token0: alert.pair.token0.code,
          token1: alert.pair.token1.code,
        },
        severity: alert.severity,
        ilPct: alert.ilPct,
        hodlValue: alert.hodlValue,
        lpValue: alert.lpValue,
        netOfFeesPct: alert.netOfFeesPct,
        message: alert.message,
        metadata: {
          initialPriceRatio: alert.initialPriceRatio,
          currentPriceRatio: alert.currentPriceRatio,
          priceRatioChange: alert.priceRatioChange,
          thresholdPct: alert.thresholdPct,
          accruedFees: snapshot.accruedFees ?? null,
        },
      },
    };
  }

  /**
   * Compares severities: OK < WARNING < CRITICAL.
   */
  public meetsSeverityThreshold(
    severity: IlSeverity,
    minSeverity: IlSeverity,
  ): boolean {
    const order: IlSeverity[] = ['OK', 'WARNING', 'CRITICAL'];
    return order.indexOf(severity) >= order.indexOf(minSeverity);
  }

  private extractRuleConfig(rule: AlertRuleLike): ImpermanentLossRuleConfig | null {
    if (!rule.conditions || typeof rule.conditions !== 'object') return null;

    const conditions = rule.conditions as Record<string, any>;
    if (conditions.impermanentLoss && typeof conditions.impermanentLoss === 'object') {
      return conditions.impermanentLoss as ImpermanentLossRuleConfig;
    }
    if (conditions.ilThresholdPct !== undefined || conditions.minSeverity !== undefined) {
      return conditions as ImpermanentLossRuleConfig;
    }
    return null;
  }
}

/** Default singleton instance. */
export const impermanentLossRuleEvaluator = new ImpermanentLossRuleEvaluator();

export type { ImpermanentLossAlert };
