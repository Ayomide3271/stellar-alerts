/**
 * Token Allowance & Spender Approval Risk Sentinel (#639)
 *
 * dApps can request excessive token allowances, putting user wallets at risk
 * of fund drainage. This sentinel detects Soroban 'approve' invocations on
 * tracked wallets, calculates the approved exposure, and dispatches high-priority
 * warning alerts when an allowance exceeds safety thresholds.
 *
 * This engine is pure logic: given an approval event and configured thresholds,
 * it classifies allowance risk and produces actionable alerts with revocation
 * instructions.
 */

export type AllowanceSeverity = 'OK' | 'WARNING' | 'CRITICAL';

export interface TokenApproval {
  /** The token contract ID (Soroban contract address). */
  contractId: string;
  /** The wallet public key granting the allowance. */
  from: string;
  /** The spender address being granted approval. */
  spender: string;
  /** Raw allowance amount in the token's smallest unit. */
  rawAmount: bigint;
  /** Formatted allowance amount for display. */
  amount: string;
  /** Ledger when this approval expires (0 for unlimited/permanent). */
  liveUntilLedger: number;
  /** Ledger sequence where this approval was made. */
  ledgerSeq?: number;
}

export interface AllowanceRiskAssessment {
  contractId: string;
  from: string;
  spender: string;
  amount: string;
  rawAmount: bigint;
  liveUntilLedger: number;
  severity: AllowanceSeverity;
  isUnlimited: boolean;
  exceedsThreshold: boolean;
  message: string;
  revocationInstructions: string;
}

export interface AllowanceSentinelOptions {
  /**
   * Allowance amount (in raw token units) above which a newly granted approval
   * is flagged as WARNING. Defaults to 1 trillion units.
   */
  warningThreshold?: bigint;
  /**
   * Allowance amount (in raw token units) above which a newly granted approval
   * is flagged as CRITICAL. Defaults to unlimited allowance detection (u64 max).
   */
  criticalThreshold?: bigint;
  /**
   * Whether to treat any approval with liveUntilLedger 0 as unlimited.
   * Defaults to true.
   */
  treatZeroExpiryAsUnlimited?: boolean;
}

/**
 * u64::MAX value used to detect unlimited approvals in Soroban contracts.
 */
const U64_MAX = 18446744073709551615n;

export class AllowanceSentinelEngine {
  private readonly warningThreshold: bigint;
  private readonly criticalThreshold: bigint;
  private readonly treatZeroExpiryAsUnlimited: boolean;

  constructor(options: AllowanceSentinelOptions = {}) {
    this.warningThreshold = options.warningThreshold ?? 1_000_000_000_000n;
    this.criticalThreshold = options.criticalThreshold ?? U64_MAX;
    this.treatZeroExpiryAsUnlimited = options.treatZeroExpiryAsUnlimited ?? true;
  }

  /**
   * Assesses a single token approval for risk based on the configured thresholds.
   * Returns null if the approval is considered safe (below warning threshold).
   */
  public assessApproval(approval: TokenApproval): AllowanceRiskAssessment | null {
    const isUnlimited = this.isUnlimitedApproval(approval);
    const exceedsThreshold = approval.rawAmount >= this.warningThreshold;

    // Safe: not unlimited and below warning threshold
    if (!isUnlimited && !exceedsThreshold) {
      return null;
    }

    // Determine severity
    let severity: AllowanceSeverity;
    if (isUnlimited || approval.rawAmount >= this.criticalThreshold) {
      severity = 'CRITICAL';
    } else if (exceedsThreshold) {
      severity = 'WARNING';
    } else {
      severity = 'OK';
    }

    // Build message
    const message = this.buildRiskMessage(approval, severity, isUnlimited);

    // Build revocation instructions
    const revocationInstructions = this.buildRevocationInstructions(approval);

    return {
      contractId: approval.contractId,
      from: approval.from,
      spender: approval.spender,
      amount: approval.amount,
      rawAmount: approval.rawAmount,
      liveUntilLedger: approval.liveUntilLedger,
      severity,
      isUnlimited,
      exceedsThreshold,
      message,
      revocationInstructions,
    };
  }

  /**
   * Checks if an approval should be considered unlimited based on amount
   * or expiration (liveUntilLedger).
   */
  private isUnlimitedApproval(approval: TokenApproval): boolean {
    // Check for u64::MAX amount (standard unlimited in Soroban)
    if (approval.rawAmount === U64_MAX) {
      return true;
    }

    // Check for zero expiry (often used to indicate permanent/unlimited)
    if (this.treatZeroExpiryAsUnlimited && approval.liveUntilLedger === 0) {
      return true;
    }

    return false;
  }

  /**
   * Builds a human-readable risk message based on severity and approval details.
   */
  private buildRiskMessage(
    approval: TokenApproval,
    severity: AllowanceSeverity,
    isUnlimited: boolean,
  ): string {
    const spenderShort = approval.spender.slice(0, 8);
    const contractShort = approval.contractId.slice(0, 8);

    if (isUnlimited) {
      return (
        `${severity}: Unlimited token approval granted to spender ${spenderShort}... ` +
        `on contract ${contractShort}.... This gives the spender full access to your ${approval.amount} tokens.`
      );
    }

    return (
      `${severity}: High-value token approval of ${approval.amount} granted to spender ` +
      `${spenderShort}... on contract ${contractShort}.... Review this spender's trustworthiness.`
    );
  }

  /**
   * Builds actionable revocation instructions for the user.
   */
  private buildRevocationInstructions(approval: TokenApproval): string {
    const spenderShort = approval.spender.slice(0, 8);
    const contractShort = approval.contractId.slice(0, 8);

    return (
      `To revoke this approval, call the 'approve' function on contract ${contractShort}... ` +
      `with spender ${spenderShort}... and amount 0. Alternatively, reduce the allowance to a ` +
      `safer minimum amount needed for the dApp to function.`
    );
  }

  /**
   * Batch assesses multiple approvals and returns only those that trigger alerts.
   */
  public assessApprovals(approvals: TokenApproval[]): AllowanceRiskAssessment[] {
    const alerts: AllowanceRiskAssessment[] = [];

    for (const approval of approvals) {
      const assessment = this.assessApproval(approval);
      if (assessment) {
        alerts.push(assessment);
      }
    }

    return alerts;
  }
}

/**
 * Default singleton instance with standard thresholds.
 */
export const allowanceSentinel = new AllowanceSentinelEngine();
