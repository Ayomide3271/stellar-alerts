import { describe, expect, it } from 'vitest';
import {
  LiquidityPoolSentinelEngine,
  detectLiquidityShiftsFromEventBatch,
  decodeTopicValue,
  parseLiquidityPoolEvent,
  type ParsedLiquidityPoolEvent,
} from '../liquidity-pool-sentinel';
import {
  LiquidityPoolRuleEvaluator,
  type AlertRuleLike,
} from '../../../modules/alerts/rules/liquidity-pool.rule';
import * as StellarSdk from 'stellar-sdk';

// #717: Soroban AMM Liquidity Pool Deposit & Withdrawal Event Sentinel.

const CONTRACT_ID = 'CAMMPOOLDEADBEEF0000000000000000000000000000000000000000001';
const SENDER = StellarSdk.Keypair.random().publicKey();
const TOKEN_A = 'CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'CTOKENBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

/** Builds a symbol ScVal and returns its base64-XDR form (RPC `getEvents`). */
function symbolTopic(name: string): string {
  return StellarSdk.xdr.ScVal.toXDR(
    StellarSdk.nativeToScVal(name, { type: 'symbol' }),
    'base64',
  );
}

function addressTopic(address: string): string {
  return StellarSdk.xdr.ScVal.toXDR(
    StellarSdk.nativeToScVal(address, { type: 'address' }),
    'base64',
  );
}

describe('ScVal topic decoding (#717)', () => {
  it('decodes base64-XDR symbol topics (raw RPC getEvents shape)', () => {
    expect(decodeTopicValue(symbolTopic('deposit_liquidity'))).toBe('deposit_liquidity');
    expect(decodeTopicValue(symbolTopic('withdraw_liquidity'))).toBe('withdraw_liquidity');
    expect(decodeTopicValue(symbolTopic('swap'))).toBe('swap');
  });

  it('decodes base64-XDR address topics to contract / account IDs', () => {
    expect(decodeTopicValue(addressTopic(SENDER))).toBe(SENDER);
  });

  it('passes pre-decoded plain string topics through unchanged', () => {
    expect(decodeTopicValue('deposit_liquidity')).toBe('deposit_liquidity');
  });

  it('decodes decoded { symbol } and plain string topics', () => {
    expect(decodeTopicValue({ symbol: 'deposit_liquidity' })).toBe('deposit_liquidity');
    expect(decodeTopicValue('withdraw_liquidity')).toBe('withdraw_liquidity');
  });

  it('decodes { type: symbol, value } ScVal JSON shapes', () => {
    expect(
      decodeTopicValue({ type: 'symbol', value: 'deposit_liquidity' }),
    ).toBe('deposit_liquidity');
  });
});

describe('parseLiquidityPoolEvent', () => {
  it('parses a deposit event with i128 XDR data amount payloads', () => {
    const amountA = StellarSdk.xdr.ScVal.toXDR(
      StellarSdk.nativeToScVal(50_000_000_000n, { type: 'i128' }),
      'base64',
    );
    const event = {
      contractId: CONTRACT_ID,
      topic: [symbolTopic('deposit_liquidity'), addressTopic(SENDER)],
      value: {
        token_a: TOKEN_A,
        token_b: TOKEN_B,
        amounts: [amountA, '6000000000'],
        total_shares: '1000000000000',
        reserve_a: '50_500_000_000',
        reserve_b: '9_000_000',
      },
      ledgerSeq: 123_456,
    };

    const parsed = parseLiquidityPoolEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.eventType).toBe('DEPOSIT');
    expect(parsed!.sender).toBe(SENDER);
    expect(parsed!.tokenA).toBe(TOKEN_A);
    expect(parsed!.tokenB).toBe(TOKEN_B);
    expect(parsed!.rawAmountA).toBe(50_000_000_000n);
    expect(parsed!.rawAmountB).toBe(6_000_000_000n);
    expect(parsed!.ledgerSeq).toBe(123_456);
  });

  it('parses a withdrawal event using amount_a / amount_b fields', () => {
    const event = {
      contractId: CONTRACT_ID,
      topic: ['withdraw_liquidity', SENDER, TOKEN_A, TOKEN_B],
      value: {
        amount_a: '4000000000',
        amount_b: '800000000',
        shares_burned: '2000000000',
        total_shares: '400000000',
      },
      ledgerSeq: 124_000,
    };

    const parsed = parseLiquidityPoolEvent(event);
    expect(parsed!.eventType).toBe('WITHDRAW');
    expect(parsed!.sender).toBe(SENDER);
    expect(parsed!.rawAmountA).toBe(4_000_000_000n);
    expect(parsed!.rawAmountB).toBe(800_000_000n);
    expect(parsed!.rawLpTokens).toBe(2_000_000_000n);
    expect(parsed!.rawTotalShares).toBe(400_000_000n);
  });

  it('returns null for non-liquidity topics', () => {
    const event = {
      contractId: CONTRACT_ID,
      topic: ['swap', SENDER],
      value: { amount_a: '10', amount_b: '20' },
    };
    expect(parseLiquidityPoolEvent(event)).toBeNull();
  });

  it('returns null when no amounts can be decoded', () => {
    const event = {
      contractId: CONTRACT_ID,
      topic: ['deposit_liquidity', SENDER],
      value: { user: SENDER },
    };
    expect(parseLiquidityPoolEvent(event)).toBeNull();
  });
});

describe('LiquidityPoolSentinelEngine metrics (#717)', () => {
  const engine = new LiquidityPoolSentinelEngine();

  const depositFixture: ParsedLiquidityPoolEvent = {
    contractId: CONTRACT_ID,
    eventType: 'DEPOSIT',
    sender: SENDER,
    tokenA: TOKEN_A,
    tokenB: TOKEN_B,
    amountA: '10000',
    amountB: '5000',
    rawAmountA: 10_000_000_000n,
    rawAmountB: 5_000_000_000n,
    rawLpTokens: 5_000_000_000n,
    rawTotalShares: 105_000_000_000n,
    rawReserveA: 110_000_000_000n,
    rawReserveB: 55_000_000_000n,
    ledgerSeq: 100,
  };

  it('computes pool share before/after a whale deposit', () => {
    const metrics = engine.computeMetrics(depositFixture);
    // Post-op fraccional share of the sender: 5000 / 105000 ≈ 4.76%.
    expect(metrics.poolSharePct).toBeCloseTo(4.7619, 3);
    expect(metrics.poolSharePctBefore).toBeCloseTo(5.0, 3);
  });

  it('computes reserve change percentages around a deposit', () => {
    const metrics = engine.computeMetrics(depositFixture);
    // Before = 110000 - 10000 = 100000 → +10%.
    expect(metrics.reserveChangeAPct).toBeCloseTo(10, 3);
    // Before = 55000 - 5000 = 50000 → +10%.
    expect(metrics.reserveChangeBPct).toBeCloseTo(10, 3);
    expect(metrics.shiftPct).toBeCloseTo(10, 3);
  });

  it('classifies a deposit at the WARNING threshold', () => {
    const assessment = engine.assessLiquidityEvent(depositFixture);
    expect(assessment).not.toBeNull();
    expect(assessment!.severity).toBe('WARNING');
    expect(assessment!.event).toBe('soroban.liquidity_pool_shift');
    expect(assessment!.message).toContain('deposit');
  });

  it('classifies a 30% withdrawal as CRITICAL', () => {
    const withdrawal: ParsedLiquidityPoolEvent = {
      ...depositFixture,
      eventType: 'WITHDRAW',
      rawAmountA: 30_000_000_000n,
      rawAmountB: 20_000_000_000n,
      rawLpTokens: 30_000_000_000n,
      rawTotalShares: 74_000_000_000n,
      rawReserveA: 70_000_000_000n,
      rawReserveB: 80_000_000_000n,
    };
    const assessment = engine.assessLiquidityEvent(withdrawal);
    expect(assessment!.severity).toBe('CRITICAL');
    // 30000 / 100000 reserves → 30%.
    expect(assessment!.metrics.shiftPct).toBeCloseTo(30, 3);
  });

  it('returns null (OK severity) for small liquidity shifts', () => {
    const smallDeposit: ParsedLiquidityPoolEvent = {
      ...depositFixture,
      rawAmountA: 500_000n,
      rawAmountB: 250_000n,
      rawReserveA: 2_000_000_000n,
      rawReserveB: 1_000_000_000n,
    };
    expect(engine.assessLiquidityEvent(smallDeposit)).toBeNull();
  });

  it('honors custom rule thresholds', () => {
    const custom = new LiquidityPoolSentinelEngine({
      warningShiftThresholdPct: 0.01,
      criticalShiftThresholdPct: 5,
    });
    const assessment = custom.assessLiquidityEvent(depositFixture);
    expect(assessment!.severity).toBe('CRITICAL');
  });
});

describe('detectLiquidityShiftsFromEventBatch', () => {
  it('sorts assessments by severity', () => {
    const engine = new LiquidityPoolSentinelEngine();
    const small = {
      contractId: CONTRACT_ID,
      topic: ['deposit_liquidity', SENDER],
      value: {
        token_a: TOKEN_A,
        token_b: TOKEN_B,
        amount_a: '1000000000',
        amount_b: '500000000',
        reserve_a: '11000000000',
        reserve_b: '5500000000',
      },
    };
    const big = {
      contractId: CONTRACT_ID,
      topic: ['withdraw_liquidity', SENDER],
      value: {
        amount_a: '3000000',
        amount_b: '2000000',
        reserve_a: '7000000',
        reserve_b: '18000000',
      },
    };

    const assessments = detectLiquidityShiftsFromEventBatch([big, small], engine);
    expect(assessments).toHaveLength(2);
    expect(assessments[0].eventType).toBe('WITHDRAW');
    expect(assessments[0].severity).toBe('CRITICAL');
    expect(assessments[1].severity).toBe('WARNING');
  });
});

describe('LiquidityPoolRuleEvaluator (#717)', () => {
  const evaluator = new LiquidityPoolRuleEvaluator();

  function makeRule(overrides: Partial<AlertRuleLike> = {}): AlertRuleLike {
    return {
      id: 'rule-lp-1',
      userId: 'user-1',
      walletId: null,
      name: 'AMM pool shift rule',
      isActive: true,
      conditions: {
        liquidityPool: {
          minSeverity: 'WARNING',
          warningShiftPct: 10,
          criticalShiftPct: 25,
        },
      },
      ...overrides,
    };
  }

  function makeDepositEvent(overrides: any = {}): any {
    return {
      contractId: CONTRACT_ID,
      topic: ['deposit_liquidity', SENDER, TOKEN_A, TOKEN_B],
      value: {
        token_a: TOKEN_A,
        token_b: TOKEN_B,
        amount_a: '100000',
        amount_b: '50000',
        reserve_a: '1100000',
        reserve_b: '550000',
      },
      ledgerSeq: 100,
      ...overrides,
    };
  }

  it('matches a deposit that exceeds the WARNING shift threshold', () => {
    const result = evaluator.evaluate(makeDepositEvent(), makeRule());
    expect(result.matched).toBe(true);
    expect(result.ruleId).toBe('rule-lp-1');
    expect(result.deliveryPayload?.event).toBe('soroban.liquidity_pool_shift');
    expect(result.deliveryPayload?.severity).toBe('WARNING');
    expect(result.deliveryPayload?.eventType).toBe('DEPOSIT');
    expect(result.deliveryPayload?.metrics.shiftPct).toBeGreaterThanOrEqual(10);
  });

  it('matches a whale withdrawal payload as CRITICAL', () => {
    const event = {
      contractId: CONTRACT_ID,
      topic: ['withdraw_liquidity', SENDER],
      value: {
        amount_a: '3000000',
        amount_b: '2000000',
        reserve_a: '7000000',
        reserve_b: '18000000',
      },
    };
    const result = evaluator.evaluate(event, makeRule());
    expect(result.matched).toBe(true);
    expect(result.deliveryPayload?.severity).toBe('CRITICAL');
    expect(result.deliveryPayload?.eventType).toBe('WITHDRAW');
    expect(result.deliveryPayload?.metadata.shiftPct).toBeCloseTo(30, 1);
  });

  it('does not match small shifts', () => {
    const result = evaluator.evaluate(
      makeDepositEvent({ value: { amount_a: '5', amount_b: '5', reserve_a: '1000000', reserve_b: '1000000' } }),
      makeRule(),
    );
    expect(result.matched).toBe(false);
  });

  it('returns false for inactive rules', () => {
    const result = evaluator.evaluate(makeDepositEvent(), makeRule({ isActive: false }));
    expect(result.matched).toBe(false);
  });

  it('returns false for non-liquidity events', () => {
    const result = evaluator.evaluate(
      {
        contractId: CONTRACT_ID,
        topic: ['clawback', SENDER],
        value: { amount: '999' },
      },
      makeRule(),
    );
    expect(result.matched).toBe(false);
  });

  it('respects minSeverity = CRITICAL for WARNING shifts', () => {
    const rule = makeRule({
      conditions: {
        liquidityPool: {
          minSeverity: 'CRITICAL',
          warningShiftPct: 10,
          criticalShiftPct: 25,
        },
      },
    });
    const result = evaluator.evaluate(makeDepositEvent(), rule);
    expect(result.matched).toBe(false);
  });

  it('filters by pool contract id', () => {
    const rule = makeRule({
      conditions: {
        liquidityPool: {
          minSeverity: 'WARNING',
          poolContractIds: ['COTHERPOOL0000000000000000000000000000000000000000000001'],
        },
      },
    });
    const result = evaluator.evaluate(makeDepositEvent(), rule);
    expect(result.matched).toBe(false);
  });

  it('filters by event type', () => {
    const rule = makeRule({
      conditions: {
        liquidityPool: {
          minSeverity: 'WARNING',
          eventTypes: ['WITHDRAW'],
        },
      },
    });
    const result = evaluator.evaluate(makeDepositEvent(), rule);
    expect(result.matched).toBe(false);
  });
});
