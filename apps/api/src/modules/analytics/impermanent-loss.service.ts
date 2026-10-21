import * as StellarSdk from 'stellar-sdk';
import { horizonPool } from '../../lib/horizon-pool';
import { constantProductIl } from '../../services/impermanentLossTracker';

/**
 * Predictive Impermanent Loss & Volatility Engine for Soroban LP tokens (#727).
 *
 * Computes real-time impermanent loss (IL) of a tracked liquidity-provider
 * position against a HODL benchmark — the value the depositor would hold had
 * they simply kept the token amounts deposited — using live Horizon price
 * feeds. Fee income is layered on top so callers can judge whether collected
 * trading fees offset the divergence loss.
 *
 * For a 50/50 constant-product AMM, the closed-form IL depends only on the
 * relative price ratio `r` between the deposit snapshot and now:
 *
 *   IL(r) = 2 * sqrt(r) / (1 + r) - 1
 *
 * The LP position value is derived from the HODL baseline (`LP = HODL * (1 + IL)`)
 * under the standard equal-value initial deposit assumption; callers with live
 * pool reserves can supply the exact LP value via `analyzeReserveBased`.
 */

export type ImpermanentLossSeverity = 'OK' | 'WARNING' | 'CRITICAL';

export interface TokenPairRef {
  token0: { code: string; issuer?: string | null };
  token1: { code: string; issuer?: string | null };
}

/** Snapshot of a provider's deposit, priced in a common numeraire (e.g. USD). */
export interface IlPositionSnapshot {
  positionId: string;
  userId: string;
  poolId: string;
  pair: TokenPairRef;
  /** Token amounts contributed at deposit time. */
  depositAmount0: number;
  depositAmount1: number;
  /** Spot prices per unit at deposit time, same numeraire as live prices. */
  depositPrice0: number;
  depositPrice1: number;
  /** Fee income earned so far, in the numeraire. */
  accruedFees?: number;
}

export interface LivePrices {
  price0: number;
  price1: number;
}

export interface ImpermanentLossResult {
  positionId: string;
  userId: string;
  poolId: string;
  pair: TokenPairRef;
  initialPriceRatio: number;
  currentPriceRatio: number;
  /** Relative price change of token0 vs token1 since deposit (`current / initial`). */
  priceRatioChange: number;
  /** Signed IL fraction (<= 0 = loss versus HODL). */
  impermanentLoss: number;
  /** IL expressed as a positive percentage magnitude of loss (0 if in profit). */
  ilPct: number;
  /** Value of keeping the deposited amounts (HODL baseline) at live prices. */
  hodlValue: number;
  /** Current LP position value versus the HODL baseline. */
  lpValue: number;
  /** IL after adding accrued fee income; negative = still worse than HODL. */
  netOfFeesPct: number;
  severity: ImpermanentLossSeverity;
}

export interface ImpermanentLossAlert extends ImpermanentLossResult {
  thresholdPct: number;
  message: string;
}

export interface ImpermanentLossServiceOptions {
  /** IL loss magnitude (percent) raising a WARNING. Default 5%. */
  warningThresholdPct?: number;
  /** IL loss magnitude (percent) raising a CRITICAL alert. Default 10%. */
  criticalThresholdPct?: number;
  /** Optional custom price adapter; defaults to the Horizon orderbook adapter. */
  priceAdapter?: HorizonPriceAdapterLike;
}

/** Adapter contract for live prices, so tests can pin deterministic prices. */
export interface HorizonPriceAdapterLike {
  /**
   * Returns a live spot price quote (in a common numeraire) for each token of
   * the pair, e.g. `USD` or `XLM` per unit.
   */
  getLivePrices(pair: TokenPairRef): Promise<LivePrices>;
}

/**
 * Default Horizon price feed: derives a mid-market price per token using the
 * XLM / asset orderbook so both sides land in the same numeraire.
 */
export class HorizonOrderbookPriceAdapter implements HorizonPriceAdapterLike {
  public async getLivePrices(pair: TokenPairRef): Promise<LivePrices> {
    const server = horizonPool.getActiveServer();
    const [price0, price1] = await Promise.all([
      this.quotePriceInXlm(server, pair.token0),
      this.quotePriceInXlm(server, pair.token1),
    ]);
    return { price0, price1 };
  }

  /** Mid-market XLM price of an asset from the native/orderbook spread. */
  private async quotePriceInXlm(
    server: StellarSdk.Horizon.Server,
    asset: { code: string; issuer?: string | null },
  ): Promise<number> {
    const nonNative = new StellarSdk.Asset(asset.code, asset.issuer ?? undefined);
    const orderbook = await server.orderbook(StellarSdk.Asset.native(), nonNative).call();

    const midFromSide = (bids: any[], asks: any[]): number => {
      const bestBid = bids.length ? Number(bids[0].price) : null;
      const bestAsk = asks.length ? Number(asks[0].price) : null;
      if (bestBid !== null && bestAsk !== null) return (bestBid + bestAsk) / 2;
      return bestBid ?? bestAsk ?? 0;
    };

    const native = orderbook?.native as
      | { bids?: any[]; asks?: any[] }
      | undefined;
    if (!native) return 0;

    // Horizon lists "asks" for the requested pair (SAC -> XLM therefore XLM price)
    const xlmPerUnit = midFromSide(native.asks ?? [], native.bids ?? []);
    return xlmPerUnit > 0 ? xlmPerUnit : 0;
  }
}

export class ImpermanentLossService {
  readonly warningThresholdPct: number;
  readonly criticalThresholdPct: number;
  private readonly priceAdapter: HorizonPriceAdapterLike;

  constructor(options: ImpermanentLossServiceOptions = {}) {
    this.warningThresholdPct = options.warningThresholdPct ?? 5;
    this.criticalThresholdPct = options.criticalThresholdPct ?? 10;
    this.priceAdapter = options.priceAdapter ?? new HorizonOrderbookPriceAdapter();
  }

  /**
   * Price-ratio based IL for the standard constant-product divergence:
   * initial deposit price ratio vs the current one.
   */
  public computeFromRatios(params: {
    initialPriceRatio: number;
    currentPriceRatio: number;
    hodlValue?: number;
  }): { il: number; ilPct: number; priceRatioChange: number } {
    const priceRatioChange =
      params.initialPriceRatio > 0
        ? params.currentPriceRatio / params.initialPriceRatio
        : 1;
    const il = constantProductIl(priceRatioChange);
    const ilPct = il < 0 ? Math.abs(il) * 100 : 0;
    return { il, ilPct, priceRatioChange };
  }

  /**
   * Full analysis of a tracked position against live prices. Returns the
   * signed IL, the HODL baseline comparison and a severity classification.
   */
  public analyze(snapshot: IlPositionSnapshot, live: LivePrices): ImpermanentLossResult {
    const initialPriceRatio = snapshot.depositPrice1 > 0
      ? snapshot.depositPrice0 / snapshot.depositPrice1
      : 0;
    const currentPriceRatio = live.price1 > 0 ? live.price0 / live.price1 : 0;

    const { il, ilPct, priceRatioChange } = this.computeFromRatios({
      initialPriceRatio,
      currentPriceRatio,
    });

    const hodlValue =
      snapshot.depositAmount0 * live.price0 + snapshot.depositAmount1 * live.price1;
    // Equal-value initial deposit assumption: LP value tracks the price-ratio
    // divergence from the HODL baseline.
    const lpValue = hodlValue * (1 + il);
    const accruedFees = snapshot.accruedFees ?? 0;
    const impermanentLoss = hodlValue > 0 ? (lpValue - hodlValue) / hodlValue : il;
    const ilPctLoss = impermanentLoss < 0 ? Math.abs(impermanentLoss) * 100 : 0;
    const feeFraction = hodlValue > 0 ? accruedFees / hodlValue : 0;
    const netOfFeesPct = (impermanentLoss + feeFraction) * 100;

    return {
      positionId: snapshot.positionId,
      userId: snapshot.userId,
      poolId: snapshot.poolId,
      pair: snapshot.pair,
      initialPriceRatio,
      currentPriceRatio,
      priceRatioChange,
      impermanentLoss: round(impermanentLoss, 6),
      ilPct: round(ilPctLoss, 4),
      hodlValue: round(hodlValue, 6),
      lpValue: round(lpValue, 6),
      netOfFeesPct: round(netOfFeesPct, 4),
      severity: this.classify(ilPctLoss),
    };
  }

  /**
   * Live variant: fetches current prices from the configured price adapter
   * (Horizon orderbook by default) before analyzing the snapshot.
   */
  public async analyzeLivePosition(
    snapshot: IlPositionSnapshot,
  ): Promise<ImpermanentLossResult> {
    const live = await this.priceAdapter.getLivePrices(snapshot.pair);
    return this.analyze(snapshot, live);
  }

  /**
   * Evaluates a position against a user-defined IL threshold (percent) and
   * returns an alert when the loss magnitude crosses it, otherwise null.
   */
  public evaluateThreshold(
    snapshot: IlPositionSnapshot,
    live: LivePrices,
    thresholdPct: number,
  ): ImpermanentLossAlert | null {
    const result = this.analyze(snapshot, live);
    if (result.ilPct < thresholdPct) return null;

    return {
      ...result,
      thresholdPct,
      message:
        `Impermanent loss on ${result.poolId} ` +
        `(${result.pair.token0.code}/${result.pair.token1.code}) reached ` +
        `${result.ilPct.toFixed(2)}% vs HODL (threshold ${thresholdPct}%). ` +
        `LP value ${result.lpValue.toFixed(2)} vs HODL ${result.hodlValue.toFixed(2)}.`,
    };
  }

  private classify(ilPct: number): ImpermanentLossSeverity {
    if (ilPct >= this.criticalThresholdPct) return 'CRITICAL';
    if (ilPct >= this.warningThresholdPct) return 'WARNING';
    return 'OK';
  }
}

function round(value: number, dp: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

export const impermanentLossService = new ImpermanentLossService();
