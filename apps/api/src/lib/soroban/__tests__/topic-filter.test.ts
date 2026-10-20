import { describe, it, expect } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import {
  decodeTopicToString,
  decodeSorobanEventTopics,
  matchesTopicPattern,
  evaluateSorobanTopicFilter,
} from '../topic-filter';
import {
  SorobanTopicRuleEvaluator,
  type AlertRuleLike,
} from '../../../modules/alerts/rules/soroban-topic.rule';

describe('Soroban Smart Contract Event Topic Filtering Engine (#631)', () => {
  const contractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  describe('XDR topic parsing and decoding', () => {
    it('accurately decodes ScVal Symbol topic from base64 XDR', () => {
      const symScv = StellarSdk.xdr.ScVal.scvSymbol('transfer');
      const b64 = symScv.toXDR('base64');

      const decoded = decodeTopicToString(b64);
      expect(decoded).toBe('transfer');
    });

    it('accurately decodes ScVal Vec topic from base64 XDR', () => {
      const vecScv = StellarSdk.xdr.ScVal.scvVec([
        StellarSdk.xdr.ScVal.scvSymbol('path_a'),
        StellarSdk.xdr.ScVal.scvSymbol('path_b'),
      ]);
      const b64 = vecScv.toXDR('base64');

      const decoded = decodeTopicToString(b64);
      expect(decoded).toBe('[path_a,path_b]');
    });

    it('accurately decodes ScVal Address and integer topics', () => {
      const kp = StellarSdk.Keypair.random();
      const addrScv = new StellarSdk.Address(kp.publicKey()).toScVal();
      const numScv = StellarSdk.xdr.ScVal.scvU32(100);

      expect(decodeTopicToString(addrScv.toXDR('base64'))).toBe(kp.publicKey());
      expect(decodeTopicToString(numScv.toXDR('base64'))).toBe('100');
    });

    it('decodes full Soroban RPC raw event topics', () => {
      const transferScv = StellarSdk.xdr.ScVal.scvSymbol('transfer').toXDR('base64');
      const kp = StellarSdk.Keypair.random();
      const addrScv = new StellarSdk.Address(kp.publicKey()).toScVal().toXDR('base64');

      const rawEvent = {
        contractId,
        topic: [transferScv, addrScv],
        txHash: '0xabc123',
        ledger: 12345,
      };

      const result = decodeSorobanEventTopics(rawEvent);

      expect(result.contractId).toBe(contractId);
      expect(result.leadSymbol).toBe('transfer');
      expect(result.topics[0]).toBe('transfer');
      expect(result.topics[1]).toBe(kp.publicKey());
      expect(result.payloadMetadata.txHash).toBe('0xabc123');
      expect(result.payloadMetadata.ledger).toBe(12345);
    });
  });

  describe('Topic pattern matching (exact, wildcard, regex)', () => {
    it('matches exact topic strings and rejects non-matching topics', () => {
      expect(matchesTopicPattern('transfer', 'transfer')).toBe(true);
      expect(matchesTopicPattern('swap', 'transfer')).toBe(false);
      expect(matchesTopicPattern('mint', 'burn')).toBe(false);
    });

    it('matches wildcard patterns correctly', () => {
      expect(matchesTopicPattern('swap_v2', 'swap_*')).toBe(true);
      expect(matchesTopicPattern('swap_v3_exact', 'swap_*')).toBe(true);
      expect(matchesTopicPattern('deposit', 'swap_*')).toBe(false);
      expect(matchesTopicPattern('anything', '*')).toBe(true);
    });

    it('matches regex patterns accurately with zero false positives', () => {
      const regexPattern = '^(swap|deposit|withdraw)$';
      expect(matchesTopicPattern('swap', regexPattern)).toBe(true);
      expect(matchesTopicPattern('deposit', regexPattern)).toBe(true);
      expect(matchesTopicPattern('withdraw', regexPattern)).toBe(true);
      expect(matchesTopicPattern('liquidation', regexPattern)).toBe(false);
      expect(matchesTopicPattern('swap_extra', regexPattern)).toBe(false);
    });
  });

  describe('AlertRule Evaluator with Soroban topic filters', () => {
    const evaluator = new SorobanTopicRuleEvaluator();

    const sampleEvent = {
      contractId,
      topic: [
        StellarSdk.xdr.ScVal.scvSymbol('swap').toXDR('base64'),
        StellarSdk.xdr.ScVal.scvSymbol('USDC').toXDR('base64'),
        StellarSdk.xdr.ScVal.scvSymbol('XLM').toXDR('base64'),
      ],
      txHash: 'tx-swap-999',
      ledger: 5001,
    };

    it('triggers alert dispatch when topic pattern matches', () => {
      const rule: AlertRuleLike = {
        id: 'rule-swap-alert',
        userId: 'user-dex-trader',
        isActive: true,
        conditions: {
          contractId,
          topicPattern: 'swap',
          topicPosition: 0,
        },
      };

      const result = evaluator.evaluate(sampleEvent, rule);

      expect(result.matched).toBe(true);
      expect(result.deliveryPayload).toBeDefined();
      expect(result.deliveryPayload?.ruleId).toBe('rule-swap-alert');
      expect(result.deliveryPayload?.leadSymbol).toBe('swap');
      expect(result.deliveryPayload?.topics).toContain('swap');
      expect(result.deliveryPayload?.topics).toContain('USDC');
      expect(result.deliveryPayload?.txHash).toBe('tx-swap-999');
      expect(result.deliveryPayload?.metadata).toHaveProperty('matchedPattern', 'swap');
    });

    it('does not trigger when contract ID does not match (zero false positives)', () => {
      const rule: AlertRuleLike = {
        id: 'rule-other-contract',
        userId: 'user-dex-trader',
        isActive: true,
        conditions: {
          contractId: 'CDLZDIFFERENTCONTRACTID00000000000000000000000000000000',
          topicPattern: 'swap',
        },
      };

      const result = evaluator.evaluate(sampleEvent, rule);
      expect(result.matched).toBe(false);
      expect(result.deliveryPayload).toBeUndefined();
    });

    it('does not trigger when topic pattern does not match (zero false positives)', () => {
      const rule: AlertRuleLike = {
        id: 'rule-liquidation-alert',
        userId: 'user-dex-trader',
        isActive: true,
        conditions: {
          contractId,
          topicPattern: 'liquidation',
        },
      };

      const result = evaluator.evaluate(sampleEvent, rule);
      expect(result.matched).toBe(false);
      expect(result.deliveryPayload).toBeUndefined();
    });

    it('does not trigger when rule is inactive', () => {
      const rule: AlertRuleLike = {
        id: 'rule-inactive',
        userId: 'user-dex-trader',
        isActive: false,
        conditions: {
          contractId,
          topicPattern: 'swap',
        },
      };

      const result = evaluator.evaluate(sampleEvent, rule);
      expect(result.matched).toBe(false);
    });
  });
});
