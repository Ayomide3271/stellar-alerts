import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import { MockHorizonServer, parseRate, type MockHorizonOptions } from './mock-horizon.js';
import { ApiClient } from './api.js';
import { runResilientStream } from './resilient-stream.js';
import { isValidStellarPublicKey, type PaymentDTO } from './types.js';

const servers: MockHorizonServer[] = [];

async function startServer(options: MockHorizonOptions = {}): Promise<MockHorizonServer> {
  const server = new MockHorizonServer({ port: 0, rate: 0, ledgerIntervalMs: 0, ...options });
  servers.push(server);
  await server.start();
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function getJson(server: MockHorizonServer, path: string) {
  const res = await fetch(`${server.url}${path}`);
  return { status: res.status, body: await res.json() };
}

/** Reads from a stream response until `text` has accumulated `count` occurrences of `marker`. */
async function readUntil(res: Response, marker: string, count: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.split(marker).length - 1 < count) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

describe('parseRate', () => {
  it.each([
    ['5', 5],
    ['5/s', 5],
    ['0.5/s', 0.5],
    ['30/m', 0.5],
    ['0', 0],
  ])('parses %s', (input, expected) => {
    expect(parseRate(input)).toBe(expected);
  });

  it.each(['', 'fast', '-1', '5/h', '5/s/s', '20000/s'])('rejects "%s"', (input) => {
    expect(() => parseRate(input)).toThrow(/rate/);
  });
});

describe('MockHorizonServer REST', () => {
  it('serves a Horizon-style root document', async () => {
    const server = await startServer();
    const { status, body } = await getJson(server, '/');
    expect(status).toBe(200);
    expect(body.network_passphrase).toBe('Test SDF Network ; September 2015');
    expect(body.history_latest_ledger).toBe(body.core_latest_ledger);
  });

  it('serves known accounts with checksum-valid addresses and 404s unknown ones', async () => {
    const server = await startServer({ accountCount: 3 });
    expect(server.accountIds).toHaveLength(3);
    for (const id of server.accountIds) expect(isValidStellarPublicKey(id)).toBe(true);

    const ok = await getJson(server, `/accounts/${server.accountIds[0]}`);
    expect(ok.status).toBe(200);
    expect(ok.body.account_id).toBe(server.accountIds[0]);
    expect(ok.body.balances[0].asset_type).toBe('native');

    const missing = await getJson(server, '/accounts/GNOTAREALACCOUNT');
    expect(missing.status).toBe(404);
    expect(missing.body.type).toContain('not_found');
  });

  it('paginates /payments with limit, order and cursor', async () => {
    const server = await startServer();
    for (let i = 0; i < 5; i++) server.emitPayment();

    const asc = await getJson(server, '/payments?limit=2');
    const ascTokens = asc.body._embedded.records.map((r: any) => r.paging_token);
    expect(ascTokens).toHaveLength(2);

    const next = await getJson(server, `/payments?limit=2&cursor=${ascTokens[1]}`);
    expect(next.body._embedded.records[0].paging_token > ascTokens[1]).toBe(true);

    const desc = await getJson(server, '/payments?order=desc&limit=1');
    expect(desc.body._embedded.records[0].paging_token).toBe('0000000000000000005');

    const bad = await getJson(server, '/payments?cursor=abc');
    expect(bad.status).toBe(400);
  });

  it('emits Horizon payment records for native and credit assets', async () => {
    const server = await startServer();
    server.emitPayment({ asset: { code: 'XLM' }, amount: '1.0000000' });
    server.emitPayment({ asset: { code: 'USDC', issuer: server.accountIds[0] } });

    const { body } = await getJson(server, '/payments');
    const [native, credit] = body._embedded.records;
    expect(native).toMatchObject({ type: 'payment', asset_type: 'native', amount: '1.0000000' });
    expect(native.asset_code).toBeUndefined();
    expect(credit).toMatchObject({ asset_type: 'credit_alphanum4', asset_code: 'USDC' });
    expect(native.from).not.toBe(native.to);
  });

  it('filters /accounts/:id/payments to that account', async () => {
    const server = await startServer({ accountCount: 4 });
    const [a, b, c] = server.accountIds;
    server.emitPayment({ from: a, to: b });
    server.emitPayment({ from: b, to: c });
    server.emitPayment({ from: c, to: a });

    const { body } = await getJson(server, `/accounts/${a}/payments`);
    expect(body._embedded.records).toHaveLength(2);
  });

  it('closes ledgers and lists them newest-first on request', async () => {
    const server = await startServer();
    const first = (await getJson(server, '/ledgers?order=desc&limit=1')).body._embedded.records[0];
    server.emitPayment();
    server.closeLedger();
    const latest = (await getJson(server, '/ledgers?order=desc&limit=2')).body._embedded.records;
    expect(latest[0].sequence).toBe(first.sequence + 1);
    expect(latest[0].prev_hash).toBe(first.hash);
    expect(latest[1].successful_transaction_count).toBe(1);
  });

  it('rejects non-GET methods and unknown paths with Horizon problem documents', async () => {
    const server = await startServer();
    const post = await fetch(`${server.url}/payments`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('content-type')).toContain('application/problem+json');
    expect((await getJson(server, '/nope')).status).toBe(404);
  });

  it('generates the same payment sequence for the same seed', async () => {
    const run = async () => {
      const server = await startServer({ seed: 99 });
      for (let i = 0; i < 4; i++) server.emitPayment();
      const { body } = await getJson(server, '/payments');
      await server.stop();
      return body._embedded.records.map((r: any) => [r.from, r.to, r.amount, r.transaction_hash]);
    };
    expect(await run()).toEqual(await run());
  });

  it('auto-emits payments at the configured rate', async () => {
    const server = await startServer({ rate: 100 });
    await vi.waitFor(async () => {
      const { body } = await getJson(server, '/payments?limit=200');
      expect(body._embedded.records.length).toBeGreaterThanOrEqual(5);
    });
  });
});

describe('MockHorizonServer streaming', () => {
  it('streams payments over SSE with paging-token ids', async () => {
    const server = await startServer();
    const res = await fetch(`${server.url}/payments`, { headers: { Accept: 'text/event-stream' } });
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const pending = readUntil(res, 'data: {', 2);
    await vi.waitFor(() => expect(server.streamCount).toBe(1));
    server.emitPayment();
    server.emitPayment();

    const text = await pending;
    expect(text).toContain('event: open');
    expect(text).toContain('id: 0000000000000000001\ndata: {');
    expect(text).toContain('id: 0000000000000000002\ndata: {');
  });

  it('replays history after a cursor before going live', async () => {
    const server = await startServer();
    for (let i = 0; i < 3; i++) server.emitPayment();

    const res = await fetch(`${server.url}/payments?cursor=0000000000000000001`, {
      headers: { Accept: 'text/event-stream' },
    });
    const text = await readUntil(res, 'data: {', 2);
    expect(text).not.toContain('id: 0000000000000000001\n');
    expect(text).toContain('id: 0000000000000000002\n');
    expect(text).toContain('id: 0000000000000000003\n');
  });

  it('streams only matching payments on account streams', async () => {
    const server = await startServer({ accountCount: 4 });
    const [a, b, c] = server.accountIds;
    const res = await fetch(`${server.url}/accounts/${a}/payments`, { headers: { Accept: 'text/event-stream' } });
    const pending = readUntil(res, 'data: {', 1);
    await vi.waitFor(() => expect(server.streamCount).toBe(1));

    server.emitPayment({ from: b, to: c });
    server.emitPayment({ from: b, to: a, amount: '7.0000000' });

    const text = await pending;
    expect(text).toContain('"amount":"7.0000000"');
    expect(text).not.toContain('0000000000000000001\n');
  });

  it('streams ledger closes over SSE', async () => {
    const server = await startServer();
    const res = await fetch(`${server.url}/ledgers`, { headers: { Accept: 'text/event-stream' } });
    const pending = readUntil(res, 'data: {', 1);
    await vi.waitFor(() => expect(server.streamCount).toBe(1));
    const ledger = server.closeLedger();
    expect(await pending).toContain(`id: ${ledger.sequence}\n`);
  });

  it('severs streams after every N payments and refuses reconnects during the outage', async () => {
    const server = await startServer({ dropEvery: 2, dropDurationMs: 60_000 });
    const res = await fetch(`${server.url}/payments/stream`);
    const reader = res.body!.getReader();
    await vi.waitFor(() => expect(server.streamCount).toBe(1));

    server.emitPayment();
    server.emitPayment();

    const drain = async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    };
    await expect(drain()).rejects.toThrow();
    expect(server.streamCount).toBe(0);

    const retry = await fetch(`${server.url}/payments/stream`);
    expect(retry.status).toBe(503);
    expect(retry.headers.get('retry-after')).not.toBeNull();
  });

  it('stop() ends open streams, frees the port and is idempotent', async () => {
    const server = await startServer();
    const res = await fetch(`${server.url}/payments/stream`);
    await vi.waitFor(() => expect(server.streamCount).toBe(1));
    const port = Number(new URL(server.url).port);

    await server.stop();
    await server.stop();

    expect(server.isListening).toBe(false);
    const reader = res.body!.getReader();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return 'ended';
      })()
    ).resolves.toBe('ended');

    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
    });
  });

  it('reports a port conflict from start()', async () => {
    const first = await startServer();
    const second = new MockHorizonServer({ port: Number(new URL(first.url).port) });
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('CLI stream client against the sandbox (offline)', () => {
  it('delivers payments through ApiClient.openPaymentStream', async () => {
    const server = await startServer();
    const client = new ApiClient(server.url, 'test-key');
    const abort = new AbortController();
    const stream = await client.openPaymentStream({ signal: abort.signal });

    const received: PaymentDTO[] = [];
    const done = (async () => {
      for await (const payment of stream) {
        received.push(payment);
        if (received.length === 3) break;
      }
    })();

    await vi.waitFor(() => expect(server.streamCount).toBe(1));
    const sent = [server.emitPayment(), server.emitPayment(), server.emitPayment()];
    await done;
    abort.abort();

    expect(received.map((p) => p.id)).toEqual(sent.map((p) => p.pagingToken));
    expect(received[0]).toMatchObject({ asset: expect.any(String), txHash: sent[0].txHash });
    expect(isValidStellarPublicKey(received[0].fromAddress)).toBe(true);
  });

  it('resumes from the cursor across simulated drops without losing or duplicating payments', async () => {
    const server = await startServer({ rate: 40, dropEvery: 5 });
    const client = new ApiClient(server.url, 'test-key');
    const abort = new AbortController();
    const reconnects: number[] = [];
    const ids: string[] = [];

    const run = runResilientStream({
      connect: (cursor, signal) => client.openPaymentStream({ cursor, signal }),
      onPayment: (payment) => {
        ids.push(payment.id);
        if (ids.length >= 20) abort.abort();
      },
      signal: abort.signal,
      baseDelayMs: 5,
      maxDelayMs: 20,
      onReconnect: ({ attempt }) => reconnects.push(attempt),
    });

    const result = await run;
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
    expect(result.received).toBe(ids.length);
    expect(new Set(ids).size).toBe(ids.length);
    // Only the first live connection has no cursor, so every id must be gapless after its first.
    const nums = ids.map(Number);
    nums.slice(1).forEach((n, i) => expect(n).toBe(nums[i] + 1));
  });
});
