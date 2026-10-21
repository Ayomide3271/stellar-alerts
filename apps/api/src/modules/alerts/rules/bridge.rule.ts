import type { BridgeEvent } from '../../../workers/watcher/bridge-sentinel';

export interface BridgeRuleConfig {
  id: string;
  name: string;
  thresholdAmount: bigint;
  watchedChains?: string[];
  watchedEventTypes?: Array<BridgeEvent['type']>;
}

export interface BridgeAlertPayload {
  ruleId: string;
  ruleName: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  transfer: {
    eventId: string;
    eventType: BridgeEvent['type'];
    contractId: string;
    txHash: string;
    ledger: number;
    token: string;
    amount: string;
    sourceChain: string;
    destinationChain: string;
    destinationAddress: string;
    sender: string;
    timestamp: number;
  };
}

export interface BridgeRuleEvaluation {
  matched: boolean;
  alert: BridgeAlertPayload | null;
  reason?: string;
}

function parseAmount(amount: string): bigint | null {
  if (!/^[0-9]+$/.test(amount)) {
    return null;
  }
  try {
    return BigInt(amount);
  } catch {
    return null;
  }
}

export class BridgeRule {
  constructor(readonly config: BridgeRuleConfig) {}

  evaluate(event: BridgeEvent): BridgeRuleEvaluation {
    const { config } = this;

    if (config.watchedEventTypes && !config.watchedEventTypes.includes(event.type)) {
      return { matched: false, alert: null, reason: 'event type not watched' };
    }

    if (config.watchedChains && !config.watchedChains.includes(event.destinationChain)) {
      return { matched: false, alert: null, reason: 'destination chain not watched' };
    }

    const amount = parseAmount(event.amount);
    if (amount === null) {
      return { matched: false, alert: null, reason: 'invalid amount' };
    }

    if (amount < config.thresholdAmount) {
      return { matched: false, alert: null, reason: 'below threshold' };
    }

    const severity = this.resolveSeverity(amount);
    const alert: BridgeAlertPayload = {
      ruleId: config.id,
      ruleName: config.name,
      severity,
      title: `Bridge ${event.type} on ${event.sourceChain} -> ${event.destinationChain}`,
      message: this.formatMessage(event),
      transfer: {
        eventId: event.id,
        eventType: event.type,
        contractId: event.contractId,
        txHash: event.txHash,
        ledger: event.ledger,
        token: event.token,
        amount: event.amount,
        sourceChain: event.sourceChain,
        destinationChain: event.destinationChain,
        destinationAddress: event.destinationAddress,
        sender: event.sender,
        timestamp: event.timestamp,
      },
    };

    return { matched: true, alert };
  }

  private resolveSeverity(amount: bigint): BridgeAlertPayload['severity'] {
    const threshold = this.config.thresholdAmount;
    if (threshold > BigInt(0)) {
      const criticalThreshold = threshold * BigInt(10);
      if (amount >= criticalThreshold) {
        return 'critical';
      }
    }
    return 'warning';
  }

  private formatMessage(event: BridgeEvent): string {
    return [
      `Bridge ${event.type} detected on contract ${event.contractId}.`,
      `Amount: ${event.amount} ${event.token}.`,
      `Route: ${event.sourceChain} -> ${event.destinationChain} (${event.destinationAddress}).`,
      `Tx: ${event.txHash} at ledger ${event.ledger}.`,
    ].join(' ');
  }
}
