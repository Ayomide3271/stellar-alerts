import {
  decodeSorobanEventTopics,
  evaluateSorobanTopicFilter,
  type SorobanRpcRawEvent,
  type TopicFilterPattern,
  type DecodedTopicFilterResult,
} from '../../../lib/soroban/topic-filter';

export interface SorobanTopicRuleConfig {
  contractId?: string;
  topicPattern?: string; // e.g. "swap", "transfer:*", "^(deposit|withdraw)$"
  topicPosition?: number; // 0 for lead symbol, etc.
  patterns?: TopicFilterPattern[];
}

export interface AlertRuleLike {
  id: string;
  userId: string;
  walletId?: string | null;
  name?: string | null;
  isActive: boolean;
  conditions?: any;
}

export interface SorobanTopicMatchResult {
  matched: boolean;
  ruleId?: string;
  deliveryPayload?: {
    event: 'soroban.contract_event';
    ruleId: string;
    userId: string;
    contractId: string;
    leadSymbol: string | null;
    topics: string[];
    structuredTopics: any[];
    txHash?: string;
    ledger?: number;
    metadata: Record<string, any>;
  };
}

export class SorobanTopicRuleEvaluator {
  /**
   * Evaluates an incoming raw Soroban RPC event against an AlertRule.
   * If topic patterns match, produces an alert delivery payload with enriched decoded topic metadata.
   */
  public evaluate(
    rawEvent: SorobanRpcRawEvent,
    rule: AlertRuleLike
  ): SorobanTopicMatchResult {
    if (!rule.isActive) {
      return { matched: false };
    }

    const decoded = decodeSorobanEventTopics(rawEvent);
    const ruleConfig = this.extractRuleConfig(rule);

    if (!ruleConfig) {
      return { matched: false };
    }

    // 1. Contract ID match
    if (ruleConfig.contractId && ruleConfig.contractId.toLowerCase() !== decoded.contractId.toLowerCase()) {
      return { matched: false };
    }

    // 2. Evaluate individual or array patterns
    const patternsToTest: TopicFilterPattern[] = [];
    if (ruleConfig.patterns && ruleConfig.patterns.length > 0) {
      patternsToTest.push(...ruleConfig.patterns);
    } else if (ruleConfig.topicPattern) {
      patternsToTest.push({
        pattern: ruleConfig.topicPattern,
        position: ruleConfig.topicPosition,
        contractId: ruleConfig.contractId,
      });
    }

    if (patternsToTest.length === 0) {
      return { matched: false };
    }

    for (const pattern of patternsToTest) {
      const result = evaluateSorobanTopicFilter(decoded, pattern);
      if (result.matches) {
        return {
          matched: true,
          ruleId: rule.id,
          deliveryPayload: {
            event: 'soroban.contract_event',
            ruleId: rule.id,
            userId: rule.userId,
            contractId: decoded.contractId,
            leadSymbol: decoded.leadSymbol,
            topics: decoded.topics,
            structuredTopics: decoded.structuredTopics,
            txHash: rawEvent.txHash,
            ledger: rawEvent.ledger,
            metadata: result.metadata || decoded.payloadMetadata,
          },
        };
      }
    }

    return { matched: false };
  }

  private extractRuleConfig(rule: AlertRuleLike): SorobanTopicRuleConfig | null {
    if (!rule.conditions) return null;

    if (typeof rule.conditions === 'object') {
      const cond = rule.conditions as any;
      if (cond.sorobanTopic) {
        return cond.sorobanTopic as SorobanTopicRuleConfig;
      }
      if (cond.topicPattern || cond.contractId || cond.patterns) {
        return cond as SorobanTopicRuleConfig;
      }
    }

    return null;
  }
}

export const sorobanTopicRuleEvaluator = new SorobanTopicRuleEvaluator();
