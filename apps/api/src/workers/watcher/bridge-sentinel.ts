import { EventEmitter } from 'node:events';

export type BridgeEventType = 'lock' | 'burn' | 'mint' | 'unlock';

export interface BridgeEvent {
  id: string;
  type: BridgeEventType;
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
}

export interface BridgeContractConfig {
  contractId: string;
  name: string;
  sourceChain: string;
  eventTypes: BridgeEventType[];
}

export interface SorobanEventRecord {
  id: string;
  contractId: string;
  txHash: string;
  ledger: number;
  topics: string[];
  value: string;
  closedAt: number;
}

export interface SorobanEventSource {
  fetchEvents(contractIds: string[], fromLedger: number): Promise<SorobanEventRecord[]>;
  getLatestLedger(): Promise<number>;
}

export const BRIDGE_EVENT_SIGNATURES: Record<BridgeEventType, string> = {
  lock: 'lock',
  burn: 'burn',
  mint: 'mint',
  unlock: 'unlock',
};

const CHAIN_ID_MAP: Record<string, string> = {
  '1': 'ethereum',
  '137': 'polygon',
  '1399814246': 'solana',
  '2': 'stellar',
};

function decodeSymbol(topic: string): string {
  if (topic.startsWith('0')) {
    try {
      const buf = Buffer.from(topic, 'hex');
      const text = buf.toString('utf-8').replace(/\0/g, '');
      if (/^[a-z]+$/i.test(text)) {
        return text.toLowerCase();
      }
    } catch {
      // fallback to raw topic below
    }
  }
  return topic.toLowerCase();
}

function decodeScvalue(raw: string): string {
  if (!raw) {
    return '';
  }
  if (raw.startsWith('0x') && /^0x[0-9a-fA-F]+$/.test(raw)) {
    try {
      const buf = Buffer.from(raw.slice(2), 'hex');
      const text = buf.toString('utf-8').replace(/\0/g, '');
      if (text && /^[\u0020-\u026F]+$/.test(text)) {
        return text;
      }
    } catch {
      // fallback to raw value below
    }
  }
  return raw;
}

function normalizeChain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return 'unknown';
  }
  return CHAIN_ID_MAP[trimmed] ?? trimmed;
}

export function parseBridgeEvent(
  record: SorobanEventRecord,
  config?: BridgeContractConfig,
): BridgeEvent | null {
  if (!record.topics || record.topics.length < 2) {
    return null;
  }

  const eventType = decodeSymbol(record.topics[0]);
  if (!Object.prototype.hasOwnProperty(BRIDGE_EVENT_SIGNATURES, eventType)) {
    return null;
  }
  const type = eventType as BridgeEventType;
  if (config && !config.eventTypes.includes(type)) {
    return null;
  }

  const payload = decodeScvalue(record.value);
  const parts = payload.split('|');
  if (parts.length < 5) {
    return null;
  }

  const [token, amount, destinationChainRaw, destinationAddress, sender] = parts;
  if (!token || !amount || !destinationAddress) {
    return null;
  }

  return {
    id: record.id,
    type,
    contractId: record.contractId,
    txHash: record.txHash,
    ledger: record.ledger,
    token,
    amount,
    sourceChain: config?.sourceChain ?? 'stellar',
    destinationChain: normalizeChain(destinationChainRaw),
    destinationAddress,
    sender: sender ?? '',
    timestamp: record.closedAt,
  };
}

export interface BridgeSentinelOptions {
  source: SorobanEventSource;
  contracts: BridgeContractConfig[];
  pollIntervalMs?: number;
  onEvent?: (event: BridgeEvent) => Promise<void> | true | void;
}

export class BridgeSentinel extends EventEmitter {
  private readonly source: SorobanEventSource;
  private readonly contracts: BridgeContractConfig[];
  private readonly pollIntervalMs: number;
  private readonly onEvent?: (event: BridgeEvent) => Promise<void> | void;
  private lastLedger: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private seenEventIds = new Set<string>();

  constructor(options: BridgeSentinelOptions) {
    super();
    this.source = options.source;
    this.contracts = options.contracts;
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    if (this.lastLedger === null) {
      this.lastLedger = await this.source.getLatestLedger();
    }
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll().catch((err) => this.emit('error', err));
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll(): Promise<void> {
    if (!this.running) {
      return;
    }
    const fromLedger = this.lastLedger ?? 0;
    const contractIds = this.contracts.map((c) => c.contractId);
    const records = await this.source.fetchEvents(contractIds, fromLedger);

    const configById = new Map(this.contracts.map((c) => [c.contractId, c] as const));
    let maxLedger = fromLedger;

    for (const record of records) {
      maxLedger = Math.max(maxLedger, record.ledger);
      if (this.seenEventIds.has(record.id)) {
        continue;
      }
      const config = configById.get(record.contractId);
      if (!config) {
        continue;
      }
      const event = parseBridgeEvent(record, config);
      this.seenEventIds.add(record.id);
      if (!event) {
        continue;
      }
      this.emit('event', event);
      if (this.onEvent) {
        await this.onEvent(event);
      }
    }

    this.lastLedger = maxLedger + 1;
  }
}
