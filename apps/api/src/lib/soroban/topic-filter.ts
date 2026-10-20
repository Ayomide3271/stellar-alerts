import * as StellarSdk from 'stellar-sdk';
import { decodeScVal, decodeTopicArray, type TopicValue } from '../soroban-topic-indexer';

export interface SorobanRpcRawEvent {
  contractId?: string;
  id?: string;
  type?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  topic: (string | any)[];
  value?: any;
  txHash?: string;
}

export interface DecodedTopicFilterResult {
  contractId: string;
  topics: string[];
  structuredTopics: TopicValue[];
  leadSymbol: string | null;
  payloadMetadata: {
    contractId: string;
    leadSymbol: string | null;
    topics: string[];
    txHash?: string;
    ledger?: number;
    timestamp?: string;
    matchedPattern?: string;
  };
}

export interface TopicFilterPattern {
  /**
   * Exact topic string (e.g. "transfer"), wildcard pattern (e.g. "swap:*", "*"),
   * or regex string (e.g. "^(swap|deposit|liquidation)$").
   */
  pattern: string;
  /**
   * Position index in topic array (0 for lead event name, 1, 2...), or undefined to match ANY topic.
   */
  position?: number;
  /**
   * Optional target contract ID.
   */
  contractId?: string;
}

/**
 * Decodes an ScVal (base64 string or ScVal object) into a human-readable string representation.
 * Handles ScVal Symbol, Vec, Address, String, numbers, and Booleans.
 */
export function decodeTopicToString(topicEntry: any): string {
  if (topicEntry === null || topicEntry === undefined) return '';

  let scv: any = topicEntry;
  if (typeof topicEntry === 'string') {
    try {
      scv = StellarSdk.xdr.ScVal.fromXDR(topicEntry, 'base64');
    } catch {
      return topicEntry;
    }
  }

  const decoded = decodeScVal(scv);

  function stringifyValue(val: TopicValue): string {
    switch (val.type) {
      case 'symbol':
      case 'string':
      case 'address':
      case 'u64':
      case 'i64':
      case 'u128':
      case 'i128':
      case 'u256':
      case 'i256':
      case 'timepoint':
      case 'duration':
      case 'error':
      case 'raw':
      case 'scv':
        return val.value;
      case 'u32':
      case 'i32':
        return String(val.value);
      case 'bool':
        return String(val.value);
      case 'void':
        return '';
      case 'bytes':
        return val.value;
      case 'vec':
        return `[${val.value.map(stringifyValue).join(',')}]`;
      case 'map':
        return `{${val.value.map((e) => `${stringifyValue(e.key)}:${stringifyValue(e.value)}`).join(',')}}`;
    }
  }

  return stringifyValue(decoded);
}

/**
 * Parses all topics in a Soroban RPC event into human-readable strings and structured values.
 */
export function decodeSorobanEventTopics(rawEvent: SorobanRpcRawEvent): DecodedTopicFilterResult {
  const contractId = rawEvent.contractId || '';
  const rawTopics = Array.isArray(rawEvent.topic) ? rawEvent.topic : [];

  const structured = decodeTopicArray(rawTopics);
  const topics: string[] = rawTopics.map(decodeTopicToString);
  const leadSymbol = structured.topicSymbol || (topics.length > 0 ? topics[0] : null);

  return {
    contractId,
    topics,
    structuredTopics: structured.topics,
    leadSymbol,
    payloadMetadata: {
      contractId,
      leadSymbol,
      topics,
      txHash: rawEvent.txHash,
      ledger: rawEvent.ledger,
      timestamp: rawEvent.ledgerClosedAt || new Date().toISOString(),
    },
  };
}

/**
 * Matches a single topic value against a pattern (exact string, wildcard, or regex).
 */
export function matchesTopicPattern(topicValue: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true;
  if (topicValue === pattern) return true;

  // Wildcard pattern matching (e.g. "swap:*" or "transfer_*")
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`, 'i');
    return regex.test(topicValue);
  }

  // Regex pattern matching (if enclosed in /.../ or starts with ^)
  if (pattern.startsWith('^') || pattern.endsWith('$') || (pattern.startsWith('/') && pattern.endsWith('/'))) {
    try {
      const cleanPattern = pattern.startsWith('/') && pattern.endsWith('/')
        ? pattern.slice(1, -1)
        : pattern;
      const regex = new RegExp(cleanPattern);
      return regex.test(topicValue);
    } catch {
      // Invalid regex falls back to exact match
      return topicValue === pattern;
    }
  }

  // Case-insensitive exact match
  return topicValue.toLowerCase() === pattern.toLowerCase();
}

/**
 * Evaluates whether a decoded Soroban event matches a given topic filter criteria.
 * Enforces zero false positives.
 */
export function evaluateSorobanTopicFilter(
  decodedEvent: DecodedTopicFilterResult,
  filter: TopicFilterPattern
): { matches: boolean; matchedPattern?: string; metadata?: Record<string, any> } {
  // 1. Contract ID check (if specified)
  if (filter.contractId && decodedEvent.contractId.toLowerCase() !== filter.contractId.toLowerCase()) {
    return { matches: false };
  }

  // 2. Position-specific match
  if (filter.position !== undefined) {
    const valAtPos = decodedEvent.topics[filter.position];
    if (valAtPos === undefined) {
      return { matches: false };
    }
    if (matchesTopicPattern(valAtPos, filter.pattern)) {
      return {
        matches: true,
        matchedPattern: filter.pattern,
        metadata: {
          ...decodedEvent.payloadMetadata,
          matchedPattern: filter.pattern,
          matchedTopicIndex: filter.position,
          matchedTopicValue: valAtPos,
        },
      };
    }
    return { matches: false };
  }

  // 3. Any topic in array match
  const matchedIndex = decodedEvent.topics.findIndex((t) => matchesTopicPattern(t, filter.pattern));
  if (matchedIndex !== -1) {
    return {
      matches: true,
      matchedPattern: filter.pattern,
      metadata: {
        ...decodedEvent.payloadMetadata,
        matchedPattern: filter.pattern,
        matchedTopicIndex: matchedIndex,
        matchedTopicValue: decodedEvent.topics[matchedIndex],
      },
    };
  }

  return { matches: false };
}
