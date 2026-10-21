import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StrKey } from 'stellar-sdk';

export const DEFAULT_MOCK_HORIZON_PORT = 8000;
export const MOCK_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

const HISTORY_LIMIT = 1000;
const MAX_RATE_PER_SECOND = 10_000;
const GENESIS_LEDGER = 1_000_000;

export interface MockHorizonOptions {
  host?: string;
  /** 0 picks a free port (the bound port is available from `start()` / `url`). */
  port?: number;
  /** Synthetic payments per second. 0 disables auto-emission (use `emitPayment()`). */
  rate?: number;
  /** Size of the synthetic account pool. */
  accountCount?: number;
  /** Abruptly close every open stream after each N emitted payments. 0 disables drops. */
  dropEvery?: number;
  /** After a drop, answer stream requests with 503 for this many milliseconds. */
  dropDurationMs?: number;
  /** How often a synthetic ledger closes. 0 disables ledger auto-close. */
  ledgerIntervalMs?: number;
  /** Seed for the payment generator; the same seed yields the same payment sequence. */
  seed?: number;
}

export interface MockAsset {
  code: string;
  issuer?: string;
}

export interface MockPayment {
  /** Monotonic position in the sandbox history; also the Horizon paging token. */
  seq: number;
  pagingToken: string;
  ledger: number;
  txHash: string;
  from: string;
  to: string;
  amount: string;
  asset: MockAsset;
  memo?: string;
  createdAt: string;
}

export interface MockLedger {
  sequence: number;
  hash: string;
  prevHash: string;
  closedAt: string;
  paymentCount: number;
}

type StreamKind = 'sse-payments' | 'sse-ledgers' | 'ndjson-payments';

interface Subscriber {
  res: http.ServerResponse;
  kind: StreamKind;
  accountId?: string;
}

/**
 * Parses a `--rate` value such as `5`, `5/s`, `0.5/s` or `30/m` into payments per second.
 * Throws on anything else so the CLI can report a precise message.
 */
export function parseRate(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(?:\/(s|m))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`invalid rate "${value}" (expected e.g. 5, 5/s, 0.5/s or 30/m)`);
  }
  const perSecond = Number(match[1]) / (match[2] === 'm' ? 60 : 1);
  if (perSecond > MAX_RATE_PER_SECOND) {
    throw new Error(`rate "${value}" exceeds the maximum of ${MAX_RATE_PER_SECOND}/s`);
  }
  return perSecond;
}

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest();
}

/** Deterministic, checksum-valid G... address so the CLI's strkey validation accepts it. */
function mockAddress(label: string): string {
  return StrKey.encodeEd25519PublicKey(sha256(label));
}

/** mulberry32: tiny seedable PRNG, enough for reproducible synthetic data. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tokenFor(seq: number): string {
  return String(seq).padStart(19, '0');
}

/**
 * In-memory stand-in for the parts of Horizon that Stellar Alerts consumes, so
 * streaming and ingestion can be exercised without Testnet or Friendbot.
 *
 * Served on one port:
 *  - `GET /`                          root document
 *  - `GET /ledgers`                   HAL list, or SSE with `Accept: text/event-stream`
 *  - `GET /accounts/:id`              account record
 *  - `GET /accounts/:id/payments`     HAL list, or SSE
 *  - `GET /payments`                  HAL list, or SSE
 *  - `GET /payments/stream`           NDJSON in the Stellar Alerts API shape (works with `stream watch`)
 */
export class MockHorizonServer {
  private readonly options: Required<MockHorizonOptions>;
  private readonly random: () => number;
  private readonly accounts: string[];
  private readonly issuer: string;
  private readonly assets: MockAsset[];
  private readonly subscribers = new Set<Subscriber>();
  private readonly payments: MockPayment[] = [];
  private readonly ledgers: MockLedger[] = [];

  private server?: http.Server;
  private emitTimer?: NodeJS.Timeout;
  private ledgerTimer?: NodeJS.Timeout;
  private nextSeq = 1;
  private emittedTotal = 0;
  private outageUntil = 0;
  private baseUrl = '';

  constructor(options: MockHorizonOptions = {}) {
    this.options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? DEFAULT_MOCK_HORIZON_PORT,
      rate: options.rate ?? 1,
      accountCount: options.accountCount ?? 5,
      dropEvery: options.dropEvery ?? 0,
      dropDurationMs: options.dropDurationMs ?? 0,
      ledgerIntervalMs: options.ledgerIntervalMs ?? 5000,
      seed: options.seed ?? 742,
    };
    if (this.options.accountCount < 2) {
      throw new Error('accountCount must be at least 2');
    }
    this.random = createRandom(this.options.seed);
    this.accounts = Array.from({ length: this.options.accountCount }, (_, i) =>
      mockAddress(`stellar-alerts-sandbox-account-${i}`)
    );
    this.issuer = mockAddress('stellar-alerts-sandbox-issuer');
    this.assets = [
      { code: 'XLM' },
      { code: 'USDC', issuer: this.issuer },
      { code: 'EURT', issuer: this.issuer },
    ];
    this.closeLedger();
  }

  get url(): string {
    return this.baseUrl;
  }

  get accountIds(): readonly string[] {
    return this.accounts;
  }

  get streamCount(): number {
    return this.subscribers.size;
  }

  get isListening(): boolean {
    return this.server?.listening ?? false;
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.server) throw new Error('MockHorizonServer already started');

    const server = http.createServer((req, res) => this.handle(req, res));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.port, this.options.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }

    const { port } = server.address() as AddressInfo;
    const host = this.options.host;
    this.baseUrl = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

    const { rate, ledgerIntervalMs } = this.options;
    if (rate > 0) this.startEmitter(rate);
    if (ledgerIntervalMs > 0) {
      this.ledgerTimer = setInterval(() => this.closeLedger(), ledgerIntervalMs);
    }
    return { host, port, url: this.baseUrl };
  }

  /** Stops emitting, ends every open stream and releases the port. Safe to call twice. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;

    clearInterval(this.emitTimer);
    clearInterval(this.ledgerTimer);
    this.emitTimer = undefined;
    this.ledgerTimer = undefined;

    for (const subscriber of this.subscribers) subscriber.res.end();
    this.subscribers.clear();

    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }

  /** Creates one synthetic payment, records it and pushes it to every matching stream. */
  emitPayment(overrides: Partial<Pick<MockPayment, 'from' | 'to' | 'amount' | 'asset' | 'memo'>> = {}): MockPayment {
    const seq = this.nextSeq++;
    const from = overrides.from ?? this.pickAccount();
    const to = overrides.to ?? this.pickAccount(from);
    const memo = 'memo' in overrides ? overrides.memo : this.random() < 0.3 ? `sandbox-${seq}` : undefined;
    const ledger = this.ledgers[this.ledgers.length - 1];

    const payment: MockPayment = {
      seq,
      pagingToken: tokenFor(seq),
      ledger: ledger.sequence,
      txHash: sha256(`sandbox-tx-${this.options.seed}-${seq}`).toString('hex'),
      from,
      to,
      amount: overrides.amount ?? (0.01 + this.random() * 999.99).toFixed(7),
      asset: overrides.asset ?? this.assets[Math.floor(this.random() * this.assets.length)],
      memo,
      createdAt: new Date().toISOString(),
    };

    ledger.paymentCount++;
    this.payments.push(payment);
    if (this.payments.length > HISTORY_LIMIT) this.payments.shift();

    for (const subscriber of this.subscribers) {
      if (subscriber.kind === 'sse-ledgers') continue;
      if (subscriber.accountId && payment.from !== subscriber.accountId && payment.to !== subscriber.accountId) continue;
      this.writePayment(subscriber, payment);
    }

    this.emittedTotal++;
    const { dropEvery } = this.options;
    if (dropEvery > 0 && this.emittedTotal % dropEvery === 0) this.dropConnections();
    return payment;
  }

  /** Closes a synthetic ledger and notifies ledger streams. */
  closeLedger(): MockLedger {
    const previous = this.ledgers[this.ledgers.length - 1];
    const sequence = previous ? previous.sequence + 1 : GENESIS_LEDGER;
    const ledger: MockLedger = {
      sequence,
      hash: sha256(`sandbox-ledger-${sequence}`).toString('hex'),
      prevHash: previous?.hash ?? '0'.repeat(64),
      closedAt: new Date().toISOString(),
      paymentCount: 0,
    };
    this.ledgers.push(ledger);
    if (this.ledgers.length > HISTORY_LIMIT) this.ledgers.shift();

    for (const subscriber of this.subscribers) {
      if (subscriber.kind === 'sse-ledgers') {
        subscriber.res.write(`id: ${sequence}\ndata: ${JSON.stringify(this.ledgerRecord(ledger))}\n\n`);
      }
    }
    return ledger;
  }

  /**
   * Simulates a network failure: severs every open stream and, when
   * `dropDurationMs` is set, refuses new streams with 503 for that long.
   */
  dropConnections(): void {
    this.outageUntil = Date.now() + this.options.dropDurationMs;
    for (const subscriber of this.subscribers) subscriber.res.destroy();
    this.subscribers.clear();
  }

  private startEmitter(rate: number): void {
    const tickMs = Math.max(10, Math.min(1000, Math.round(1000 / rate)));
    let credit = 0;
    let last = Date.now();
    this.emitTimer = setInterval(() => {
      const now = Date.now();
      credit += ((now - last) / 1000) * rate;
      last = now;
      const due = Math.floor(credit);
      credit -= due;
      for (let i = 0; i < due; i++) this.emitPayment();
    }, tickMs);
  }

  private pickAccount(exclude?: string): string {
    const pool = exclude ? this.accounts.filter((a) => a !== exclude) : this.accounts;
    return pool[Math.floor(this.random() * pool.length)];
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'GET') {
      this.sendProblem(res, 405, 'method_not_allowed', 'Method Not Allowed', 'The mock Horizon server is read-only.');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://sandbox.local');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const wantsSse = (req.headers.accept ?? '').includes('text/event-stream');

    if (segments.length === 0) return this.sendJson(res, 200, this.rootRecord());

    if (segments[0] === 'ledgers' && segments.length === 1) {
      if (wantsSse) return this.openStream(req, res, url, 'sse-ledgers');
      return this.sendPage(res, url, this.ledgers.map((l) => ({ seq: l.sequence, record: this.ledgerRecord(l) })));
    }

    if (segments[0] === 'payments' && segments.length === 1) {
      if (wantsSse) return this.openStream(req, res, url, 'sse-payments');
      return this.sendPage(res, url, this.payments.map((p) => ({ seq: p.seq, record: this.paymentRecord(p) })));
    }

    if (segments[0] === 'payments' && segments[1] === 'stream' && segments.length === 2) {
      return this.openStream(req, res, url, 'ndjson-payments');
    }

    if (segments[0] === 'accounts' && segments.length >= 2) {
      const accountId = segments[1];
      if (!this.accounts.includes(accountId)) {
        return this.sendProblem(res, 404, 'not_found', 'Resource Missing', 'The resource at the url requested was not found.');
      }
      if (segments.length === 2) return this.sendJson(res, 200, this.accountRecord(accountId));
      if (segments[2] === 'payments' && segments.length === 3) {
        if (wantsSse) return this.openStream(req, res, url, 'sse-payments', accountId);
        const records = this.payments
          .filter((p) => p.from === accountId || p.to === accountId)
          .map((p) => ({ seq: p.seq, record: this.paymentRecord(p) }));
        return this.sendPage(res, url, records);
      }
    }

    this.sendProblem(res, 404, 'not_found', 'Resource Missing', 'The resource at the url requested was not found.');
  }

  private openStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    kind: StreamKind,
    accountId?: string
  ): void {
    if (Date.now() < this.outageUntil) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((this.outageUntil - Date.now()) / 1000))));
      return this.sendProblem(res, 503, 'service_unavailable', 'Service Unavailable', 'Simulated network outage.');
    }

    const rawCursor = url.searchParams.get('cursor') ?? (req.headers['last-event-id'] as string | undefined);
    let replayAfter: number | undefined;
    if (rawCursor && rawCursor !== 'now') {
      if (!/^\d+$/.test(rawCursor)) {
        return this.sendProblem(res, 400, 'bad_request', 'Bad Request', `Invalid cursor "${rawCursor}".`);
      }
      replayAfter = Number(rawCursor);
    }

    const contentType = kind === 'ndjson-payments' ? 'application/x-ndjson' : 'text/event-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (kind !== 'ndjson-payments') res.write('retry: 1000\nevent: open\ndata: "hello"\n\n');
    else res.write('\n');

    const subscriber: Subscriber = { res, kind, accountId };
    if (replayAfter !== undefined && kind !== 'sse-ledgers') {
      for (const payment of this.payments) {
        if (payment.seq <= replayAfter) continue;
        if (accountId && payment.from !== accountId && payment.to !== accountId) continue;
        this.writePayment(subscriber, payment);
      }
    }

    this.subscribers.add(subscriber);
    res.on('close', () => this.subscribers.delete(subscriber));
  }

  private writePayment(subscriber: Subscriber, payment: MockPayment): void {
    if (subscriber.kind === 'ndjson-payments') {
      subscriber.res.write(`${JSON.stringify(this.paymentDto(payment))}\n`);
    } else {
      subscriber.res.write(`id: ${payment.pagingToken}\ndata: ${JSON.stringify(this.paymentRecord(payment))}\n\n`);
    }
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(JSON.stringify(body));
  }

  private sendProblem(res: http.ServerResponse, status: number, code: string, title: string, detail: string): void {
    this.sendJson(
      res,
      status,
      { type: `https://stellar.org/horizon-errors/${code}`, title, status, detail },
      'application/problem+json'
    );
  }

  private sendPage(res: http.ServerResponse, url: URL, items: Array<{ seq: number; record: unknown }>): void {
    const order = url.searchParams.get('order') === 'desc' ? 'desc' : 'asc';
    const rawLimit = Number(url.searchParams.get('limit') ?? 10);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 10;
    const rawCursor = url.searchParams.get('cursor');
    if (rawCursor && !/^\d+$/.test(rawCursor)) {
      return this.sendProblem(res, 400, 'bad_request', 'Bad Request', `Invalid cursor "${rawCursor}".`);
    }

    let selected = items;
    if (rawCursor) {
      const cursor = Number(rawCursor);
      selected = items.filter((i) => (order === 'asc' ? i.seq > cursor : i.seq < cursor));
    }
    if (order === 'desc') selected = [...selected].reverse();
    const records = selected.slice(0, limit).map((i) => i.record) as Array<{ paging_token: string }>;

    const link = (cursor?: string) => {
      const next = new URL(url.pathname, this.baseUrl || 'http://sandbox.local');
      next.searchParams.set('order', order);
      next.searchParams.set('limit', String(limit));
      if (cursor) next.searchParams.set('cursor', cursor);
      return { href: next.toString() };
    };
    const last = records[records.length - 1]?.paging_token;
    const first = records[0]?.paging_token;
    this.sendJson(res, 200, {
      _links: { self: link(rawCursor ?? undefined), next: link(last), prev: link(first) },
      _embedded: { records },
    });
  }

  private rootRecord() {
    const latest = this.ledgers[this.ledgers.length - 1].sequence;
    return {
      horizon_version: 'mock-sandbox',
      core_version: 'mock-sandbox',
      network_passphrase: MOCK_NETWORK_PASSPHRASE,
      current_protocol_version: 22,
      history_latest_ledger: latest,
      core_latest_ledger: latest,
      _links: { self: { href: `${this.baseUrl}/` } },
    };
  }

  private ledgerRecord(ledger: MockLedger) {
    return {
      id: ledger.hash,
      paging_token: String(ledger.sequence),
      hash: ledger.hash,
      prev_hash: ledger.prevHash,
      sequence: ledger.sequence,
      successful_transaction_count: ledger.paymentCount,
      failed_transaction_count: 0,
      operation_count: ledger.paymentCount,
      closed_at: ledger.closedAt,
      protocol_version: 22,
      _links: { self: { href: `${this.baseUrl}/ledgers/${ledger.sequence}` } },
    };
  }

  private accountRecord(accountId: string) {
    return {
      id: accountId,
      account_id: accountId,
      sequence: '1',
      subentry_count: 0,
      last_modified_ledger: this.ledgers[this.ledgers.length - 1].sequence,
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      balances: [
        { balance: '10000.0000000', asset_type: 'native' },
        { balance: '500.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: this.issuer },
      ],
      _links: {
        self: { href: `${this.baseUrl}/accounts/${accountId}` },
        payments: { href: `${this.baseUrl}/accounts/${accountId}/payments{?cursor,limit,order}`, templated: true },
      },
    };
  }

  private paymentRecord(payment: MockPayment) {
    const native = !payment.asset.issuer;
    return {
      id: payment.pagingToken,
      paging_token: payment.pagingToken,
      transaction_successful: true,
      source_account: payment.from,
      type: 'payment',
      type_i: 1,
      created_at: payment.createdAt,
      transaction_hash: payment.txHash,
      asset_type: native ? 'native' : 'credit_alphanum4',
      ...(native ? {} : { asset_code: payment.asset.code, asset_issuer: payment.asset.issuer }),
      from: payment.from,
      to: payment.to,
      amount: payment.amount,
      _links: {
        self: { href: `${this.baseUrl}/operations/${payment.pagingToken}` },
        transaction: { href: `${this.baseUrl}/transactions/${payment.txHash}` },
      },
    };
  }

  /** Shape served by the Stellar Alerts API `/payments/stream`, consumed by the CLI. */
  private paymentDto(payment: MockPayment) {
    return {
      id: payment.pagingToken,
      walletId: payment.to,
      txHash: payment.txHash,
      fromAddress: payment.from,
      amount: payment.amount,
      asset: payment.asset.code,
      memo: payment.memo ?? null,
      receivedAt: payment.createdAt,
      pagingToken: payment.pagingToken,
    };
  }
}
