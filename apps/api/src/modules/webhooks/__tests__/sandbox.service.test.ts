import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/ssrf', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/ssrf')>('../../../utils/ssrf');
  return { ...actual, ssrfSafeFetch: vi.fn() };
});

import { ssrfSafeFetch, SsrfValidationError } from '../../../utils/ssrf';
import {
  WebhookSandboxReplayService,
  buildSandboxEnvelope,
  computeBackoffMs,
  isRetryableStatus,
  SANDBOX_MAX_BACKOFF_MS,
} from '../sandbox.service';
import { sandboxReplaySchema } from '../webhooks.schema';

const fetchMock = vi.mocked(ssrfSafeFetch);

function response(status: number, body = '', headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

const base = { targetUrl: 'https://receiver.example.com/hook', maxAttempts: 3 } as const;

describe('sandboxReplaySchema', () => {
  it('accepts a supported event type and mock status, defaulting maxAttempts', () => {
    const parsed = sandboxReplaySchema.parse({
      eventType: 'soroban',
      targetUrl: 'https://example.com/hook',
      mockStatusCode: 429,
    });
    expect(parsed.maxAttempts).toBe(3);
  });

  it.each([
    ['unknown event type', { eventType: 'trade', targetUrl: 'https://example.com' }],
    ['unsupported mock status', { eventType: 'payment', targetUrl: 'https://example.com', mockStatusCode: 404 }],
    ['non-URL target', { eventType: 'payment', targetUrl: 'not a url' }],
    ['too many attempts', { eventType: 'payment', targetUrl: 'https://example.com', maxAttempts: 6 }],
  ])('rejects %s', (_label, input) => {
    expect(sandboxReplaySchema.safeParse(input).success).toBe(false);
  });
});

describe('buildSandboxEnvelope', () => {
  it.each([
    ['payment', 'payment.received'],
    ['soroban', 'soroban.contract_event'],
    ['multisig', 'multisig.signature_required'],
  ] as const)('builds the %s sample', (eventType, event) => {
    const envelope = buildSandboxEnvelope(eventType, new Date('2026-10-20T00:00:00.000Z'));
    expect(envelope.event).toBe(event);
    expect(envelope.timestamp).toBe('2026-10-20T00:00:00.000Z');
  });
});

describe('retry policy helpers', () => {
  it('treats 429, 5xx and network errors as retryable only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(null)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
  });

  it('uses exponential backoff for 500s', () => {
    expect(computeBackoffMs(1, 500, {})).toBe(1000);
    expect(computeBackoffMs(2, 500, {})).toBe(2000);
    expect(computeBackoffMs(3, 500, {})).toBe(4000);
  });

  it('honours Retry-After on 429 and falls back when it is invalid', () => {
    expect(computeBackoffMs(1, 429, { 'retry-after': '5' })).toBe(5000);
    expect(computeBackoffMs(2, 429, { 'Retry-After': 'soon' })).toBe(2000);
  });

  it('caps the backoff', () => {
    expect(computeBackoffMs(1, 429, { 'Retry-After': '3600' })).toBe(SANDBOX_MAX_BACKOFF_MS);
  });
});

describe('WebhookSandboxReplayService', () => {
  const service = new WebhookSandboxReplayService();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  describe('mock mode', () => {
    it('simulates a 200 in one attempt without touching the network', async () => {
      const result = await service.replay({ ...base, eventType: 'payment', mockStatusCode: 200 });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.mode).toBe('mock');
      expect(result.success).toBe(true);
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({ status: 200, retryable: false, backoffMs: null });
      expect(result.attempts[0].latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.attempts[0].headers['X-Stellar-Sandbox']).toBe('mock-response');
    });

    it('retries a simulated 429 using Retry-After and gives up at maxAttempts', async () => {
      const result = await service.replay({ ...base, eventType: 'soroban', mockStatusCode: 429 });

      expect(result.success).toBe(false);
      expect(result.attempts.map((a) => a.status)).toEqual([429, 429, 429]);
      expect(result.attempts.map((a) => a.backoffMs)).toEqual([2000, 2000, null]);
      expect(result.attempts[0].headers['Retry-After']).toBe('2');
    });

    it('retries a simulated 500 with exponential backoff', async () => {
      const result = await service.replay({ ...base, eventType: 'multisig', mockStatusCode: 500 });

      expect(result.success).toBe(false);
      expect(result.attempts.map((a) => a.backoffMs)).toEqual([1000, 2000, null]);
    });

    it('does not retry when maxAttempts is 1', async () => {
      const result = await service.replay({ ...base, maxAttempts: 1, eventType: 'payment', mockStatusCode: 500 });
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].backoffMs).toBeNull();
    });
  });

  describe('live mode', () => {
    it('dispatches the selected event and reports status, headers, body and latency', async () => {
      fetchMock.mockResolvedValueOnce(response(202, '{"ok":true}', { 'x-receiver': 'abc' }));

      const result = await service.replay({ ...base, eventType: 'soroban' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(base.targetUrl);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string).event).toBe('soroban.contract_event');
      expect(result.mode).toBe('live');
      expect(result.success).toBe(true);
      expect(result.attempts[0]).toMatchObject({ status: 202, body: '{"ok":true}', error: null });
      expect(result.attempts[0].headers['x-receiver']).toBe('abc');
      expect(result.attempts[0].latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('retries a 500 then a 429 and succeeds on the next attempt', async () => {
      fetchMock
        .mockResolvedValueOnce(response(500, 'boom'))
        .mockResolvedValueOnce(response(429, 'slow down', { 'Retry-After': '7' }))
        .mockResolvedValueOnce(response(200, 'ok'));

      const result = await service.replay({ ...base, eventType: 'payment' });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.success).toBe(true);
      expect(result.attempts.map((a) => a.status)).toEqual([500, 429, 200]);
      expect(result.attempts.map((a) => a.backoffMs)).toEqual([1000, 7000, null]);
    });

    it('does not retry non-retryable client errors', async () => {
      fetchMock.mockResolvedValueOnce(response(404, 'nope'));

      const result = await service.replay({ ...base, eventType: 'payment' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.attempts[0]).toMatchObject({ status: 404, retryable: false, backoffMs: null });
    });

    it('records network failures as retryable attempts with an error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED')).mockResolvedValueOnce(response(200));

      const result = await service.replay({ ...base, eventType: 'payment' });

      expect(result.attempts[0]).toMatchObject({
        status: null,
        error: 'connect ECONNREFUSED',
        retryable: true,
        backoffMs: 1000,
      });
      expect(result.success).toBe(true);
    });

    it('propagates SSRF policy violations without retrying', async () => {
      fetchMock.mockRejectedValueOnce(
        new SsrfValidationError('private IP', 'http://127.0.0.1', 'PRIVATE_IP_BLOCKED'),
      );

      await expect(service.replay({ ...base, targetUrl: 'http://127.0.0.1/x', eventType: 'payment' })).rejects.toMatchObject({
        code: 'PRIVATE_IP_BLOCKED',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
