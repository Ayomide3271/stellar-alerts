import {
  ProtocolPauseSentinel,
  ProtocolInvocationRecord,
  ProtocolPauseAlertPayload,
  protocolPauseSentinel,
  PauseActionType,
} from '../../../workers/watcher/protocol-pause-sentinel';

export interface AlertRuleLike {
  id: string;
  userId: string;
  walletId?: string | null;
  name?: string | null;
  isActive: boolean;
  conditions?: unknown;
}

export interface ProtocolPauseRuleConfig {
  contractId?: string;
  monitoredContracts?: string[];
  actions?: PauseActionType[]; // e.g. ['PAUSE', 'FREEZE', 'HALT', 'EMERGENCY_SHUTDOWN']
  notifyOnUnpause?: boolean;
}

export interface ProtocolPauseRuleMatchResult {
  matched: boolean;
  ruleId?: string;
  deliveryPayload?: {
    event: 'soroban.protocol_pause_alert';
    ruleId: string;
    userId: string;
    contractId: string;
    alert: ProtocolPauseAlertPayload;
    metadata: Record<string, unknown>;
  };
}

export class ProtocolPauseRuleEvaluator {
  private sentinel: ProtocolPauseSentinel;

  constructor(sentinel: ProtocolPauseSentinel = protocolPauseSentinel) {
    this.sentinel = sentinel;
  }

  /**
   * Evaluates an incoming contract invocation against an AlertRule configured for circuit breaker/pause events.
   */
  public evaluate(
    record: ProtocolInvocationRecord | unknown,
    rule: AlertRuleLike,
    context: { txHash?: string; ledger?: number } = {}
  ): ProtocolPauseRuleMatchResult {
    if (!rule.isActive) {
      return { matched: false };
    }

    const config = this.extractRuleConfig(rule);
    if (!config) {
      return { matched: false };
    }

    const invocation =
      record && typeof record === 'object' && 'contractId' in record && 'functionName' in record
        ? (record as ProtocolInvocationRecord)
        : this.sentinel.parseTransactionRecord(record);

    if (!invocation) {
      return { matched: false };
    }

    if (context.txHash && !invocation.txHash) invocation.txHash = context.txHash;
    if (context.ledger && !invocation.ledger) invocation.ledger = context.ledger;

    // Check contract ID filter if configured
    if (config.contractId && config.contractId.toLowerCase() !== invocation.contractId.toLowerCase()) {
      return { matched: false };
    }

    if (config.monitoredContracts && config.monitoredContracts.length > 0) {
      const isMonitored = config.monitoredContracts.some(
        (c) => c.toLowerCase() === invocation.contractId.toLowerCase()
      );
      if (!isMonitored) {
        return { matched: false };
      }
    }

    const alert = this.sentinel.inspectInvocation(invocation);
    if (!alert) {
      return { matched: false };
    }

    // Filter by specific action types if configured
    if (config.actions && config.actions.length > 0) {
      if (!config.actions.includes(alert.action)) {
        return { matched: false };
      }
    }

    if (config.notifyOnUnpause === false && alert.action === 'UNPAUSE') {
      return { matched: false };
    }

    return {
      matched: true,
      ruleId: rule.id,
      deliveryPayload: {
        event: 'soroban.protocol_pause_alert',
        ruleId: rule.id,
        userId: rule.userId,
        contractId: alert.contractId,
        alert,
        metadata: {
          action: alert.action,
          isPaused: alert.isPaused,
          functionName: alert.functionName,
          callerAddress: alert.callerAddress,
          severity: alert.severity,
          parameters: alert.parameters,
        },
      },
    };
  }

  private extractRuleConfig(rule: AlertRuleLike): ProtocolPauseRuleConfig | null {
    if (!rule.conditions) return null;

    if (typeof rule.conditions === 'object' && rule.conditions !== null) {
      const cond = rule.conditions as Record<string, unknown>;

      if (cond.protocolPause && typeof cond.protocolPause === 'object') {
        return cond.protocolPause as ProtocolPauseRuleConfig;
      }

      if (
        'circuitBreaker' in cond ||
        'pauseMonitoring' in cond ||
        'contractId' in cond ||
        'actions' in cond
      ) {
        return cond as unknown as ProtocolPauseRuleConfig;
      }
    }

    return null;
  }
}

export const protocolPauseRuleEvaluator = new ProtocolPauseRuleEvaluator();
