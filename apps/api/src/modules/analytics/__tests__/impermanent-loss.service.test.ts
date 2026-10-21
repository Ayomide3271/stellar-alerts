import { describe, expect, it } from 'vitest';
import {
  ImpermanentLossService,
  HorizonOrderbookPriceAdapter,
  IlPositionSnapshot,
} from '../../analytics/impermanent-loss.service';
import {
  ImpermanentLossRuleEvaluator,
  type AlertRuleLike,
} from '../../alerts/rules/impermanent-loss.rule';

// #727: Predictive Impermanent Loss & Volatility Engine for Soroban LP tokens.

function makeSnapshot(overrides: Partial<IlPositionSnapshot> = {}): IlPositionSnapshot {
  return {
    positionId: 'pos-1',
    userId: 'user-1',
    poolId: 'pool-1',
    pair: {
      token0: { code: 'XLM' },
      token1: { code: 'USDC', issuer: 'GISSUER1111111111111111111111111111111111111111111111' },
    },
    depositAmount0: 100,
    depositAmount1: 100,
    depositPrice0: 1,
    depositPrice1: 1,
    accruedFees: 0,
    ...overrides,
  };
}

describe('ImpermanentLossService math (#727)', () => {
  const service = new ImpermanentLossService();

  it('measures zero IL when the price ratio is unchanged', () => {
    const result = service.analyze(makeSnapshot(), { price0: 1, price1: 1 });
    expect(result.ilPct).toBe(0);
    expect(result.impermanentLoss).toBe(0);
    expect(result.severity).toBe('OK');
    expect(result.hodlValue).toBeCloseTo(200, 6);
    expect(result.lpValue).toBeCloseTo(200, 6);
  });

  it('matches the standard fixture: 2x divergence → ~5.72% IL', () => {
    const { il, ilPct } = service.computeFromRatios({
      initialPriceRatio: 1,
      currentPriceRatio: 2,
    });
    expect(il).toBeCloseTo(2 * Math.sqrt(2) / (1 + 2) - 1, 9);
    expect(ilPct).toBeCloseTo(5.7191, 3);
  });

  it('matches the IL(r) closed form for 3x divergence → ~13.40% IL', () => {
    const { ilPct } = service.computeFromRatios({
      initialPriceRatio: 1,
      currentPriceRatio: 3,
    });
    expect(ilPct).toBeCloseTo(13.3975, 3);
  });

  it('is symmetric: r and 1/r give the same IL', () => {
    const up = service.computeFromRatios({ initialPriceRatio: 1, currentPriceRatio: 2 });
    const down = service.computeFromRatios({ initialPriceRatio: 1, currentPriceRatio: 0.5 });
    expect(down.il).toBeCloseTo(up.il, 9);
  });

  it('marks IL as loss (positive pct) vs HODL and compares values', () => {
    // Initially balanced: 100 XLM + 100 USDC at $1 each. XLM then doubles.
    const result = service.analyze(
      makeSnapshot(),
      { price0: 2, price1: 1 },
    );
    expect(result.currentPriceRatio).toBeCloseTo(2, 6);
    expect(result.initialPriceRatio).toBeCloseTo(1, 6);
    expect(result.hodlValue).toBeCloseTo(300, 6);
    expect(result.lpValue).toBeCloseTo(300 * (1 + (2 * Math.sqrt(2)) / 3 - 1), 4);
    expect(result.ilPct).toBeCloseTo(5.7191, 3);
  });

  it('lifts IL accounting when fee income offsets the divergence', () => {
    const result = service.analyze(
      makeSnapshot({ accruedFees: 5 }),
      { price0: 2, price1: 1 },
    );
    expect(result.netOfFeesPct).toBeLessThan(result.ilPct);
    expect(result.netOfFeesPct).toBeCloseTo(-4.0524, 2);
  });

  it('classifies severity against configured thresholds', () => {
    const harsh = new ImpermanentLossService({ warningThresholdPct: 1, criticalThresholdPct: 10 });
    expect(harsh.analyze(makeSnapshot(), { price0: 2, price1: 1 }).severity).toBe('WARNING');
    expect(
      harsh.analyze(makeSnapshot({ accruedFees: 0 }), { price0: 4, price1: 1 }).severity,
    ).toBe('CRITICAL');
    const lenient = new ImpermanentLossService({ warningThresholdPct: 50, criticalThresholdPct: 60 });
    expect(lenient.analyze(makeSnapshot(), { price0: 4, price1: 1 }).severity).toBe('OK');
  });

  it('returns an alert object only when the loss exceeds the threshold', () => {
    const snapshot = makeSnapshot();
    expect(service.evaluateThreshold(snapshot, { price0: 2, price1: 1 }, 5)).not.toBeNull();
    expect(service.evaluateThreshold(snapshot, { price0: 2, price1: 1 }, 10)).toBeNull();
    const alert = service.evaluateThreshold(snapshot, { price0: 4, price1: 1 }, 5);
    expect(alert!.ilPct).toBeGreaterThan(10);
    expect(alert!.message).toContain('Impermanent loss');
  });

  it('fetches live prices via the injected Horizon price adapter', async () => {
    const adapter = {
      getLivePrices: async () => ({ price0: 2, price1: 1 }),
    };
    const liveService = new ImpermanentLossService({ priceAdapter: adapter });
    const result = await liveService.analyzeLivePosition(makeSnapshot());
    expect(result.ilPct).toBeCloseTo(5.7191, 3);
    expect(HorizonOrderbookPriceAdapter).toBeDefined();
  });
});

describe('ImpermanentLossRuleEvaluator (#727)', () => {
  const evaluator = new ImpermanentLossRuleEvaluator();

  function makeRule(overrides: Partial<AlertRuleLike> = {}): AlertRuleLike {
    return {
      id: 'rule-il-1',
      userId: 'user-1',
      walletId: null,
      name: 'High IL guard',
      isActive: true,
      conditions: {
        impermanentLoss: {
          ilThresholdPct: 5,
          minSeverity: 'WARNING',
        },
      },
      ...overrides,
    };
  }

  it('triggers when IL crosses the user-defined 5% threshold', () => {
    // 100 XLM + 100 USDC at deposit; XLM more than doubles → IL ≈ 5.72% ≥ 5.
    const snapshot = makeSnapshot();
    const result = evaluator.evaluate(snapshot, { price0: 2.02, price1: 1 }, makeRule());
    expect(result.matched).toBe(true);
    expect(result.ruleId).toBe('rule-il-1');
    expect(result.deliveryPayload?.event).toBe('analytics.impermanent_loss_alert');
    expect(result.deliveryPayload?.ilPct).toBeGreaterThan(5);
    expect(result.deliveryPayload?.severity).toBe('WARNING');
    expect(result.deliveryPayload?.metadata.initialPriceRatio).toBe(1);
  });

  it('does not trigger below the threshold', () => {
    const result = evaluator.evaluate(
      makeSnapshot(),
      { price0: 1.05, price1: 1 },
      makeRule(),
    );
    expect(result.matched).toBe(false);
  });

  it('escalates to CRITICAL on large divergence and still matches CRITICAL rules', () => {
    const result = evaluator.evaluate(
      makeSnapshot(),
      { price0: 4, price1: 1 },
      makeRule({
        conditions: { impermanentLoss: { ilThresholdPct: 5, minSeverity: 'CRITICAL' } },
      }),
    );
    expect(result.matched).toBe(true);
    expect(result.deliveryPayload?.severity).toBe('CRITICAL');
    expect(result.deliveryPayload?.lpValue).toBeLessThan(result.deliveryPayload!.hodlValue);
  });

  it('suppresses WARNING-level losses for CRITICAL-min-severity rules', () => {
    const result = evaluator.evaluate(
      makeSnapshot(),
      { price0: 2.02, price1: 1 },
      makeRule({
        conditions: { impermanentLoss: { ilThresholdPct: 5, minSeverity: 'CRITICAL' } },
      }),
    );
    expect(result.matched).toBe(false);
  });

  it('returns false for inactive rules', () => {
    const result = evaluator.evaluate(
      makeSnapshot(),
      { price0: 4, price1: 1 },
      makeRule({ isActive: false }),
    );
    expect(result.matched).toBe(false);
  });

  it('filters by pool id', () => {
    const result = evaluator.evaluate(
      makeSnapshot({ poolId: 'other-pool' }),
      { price0: 4, price1: 1 },
      makeRule({
        conditions: { impermanentLoss: { ilThresholdPct: 5, poolIds: ['pool-1'] } },
      }),
    );
    expect(result.matched).toBe(false);
  });

  it('returns false when rule config is missing', () => {
    const result = evaluator.evaluate(
      makeSnapshot(),
      { price0: 4, price1: 1 },
      makeRule({ conditions: { unrelated: true } }),
    );
    expect(result.matched).toBe(false);
  });
});
