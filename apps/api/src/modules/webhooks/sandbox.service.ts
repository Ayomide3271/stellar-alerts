import { performance } from 'node:perf_hooks';
import { ssrfSafeFetch, SsrfValidationError } from '../../utils/ssrf';
import type { SandboxReplayInput } from './webhooks.schema';

export const SANDBOX_REQUEST_TIMEOUT_MS = 5000;
export const SANDBOX_BASE_BACKOFF_MS = 1000;
export const SANDBOX_MAX_BACKOFF_MS = 30_000;
const MAX_RESPONSE_HEADERS = 50;

export type SandboxEventType = SandboxReplayInput['eventType'];

export interface SandboxAttempt {
  attempt: number;
  status: number | null;
  latencyMs: number;
  headers: Record<string, string>;
  body: string;
  error: string | null;
  retryable: boolean;
  /** Delay a real dispatcher would wait before the next attempt; null on the last attempt. */
  backoffMs: number | null;
}

export interface SandboxReplayResult {
  success: boolean;
  mode: 'mock' | 'live';
  eventType: SandboxEventType;
  request: { headers: Record<string, string>; body: string };
  attempts: SandboxAttempt[];
  totalLatencyMs: number;
}

export function buildSandboxEnvelope(eventType: SandboxEventType, now: Date = new Date()) {
  const timestamp = now.toISOString();
  switch (eventType) {
    case 'payment':
      return {
        event: 'payment.received',
        timestamp,
        data: {
          txHash: 'sandbox-test-transaction',
          walletPublicKey: 'GDASHBOARDSANDBOXTESTPUBLICKEY000000000000000000000000',
          asset: 'XLM',
          amount: '25.0000000',
          memo: 'Webhook sandbox replay',
        },
      };
    case 'soroban':
      return {
        event: 'soroban.contract_event',
        timestamp,
        data: {
          txHash: 'sandbox-test-transaction',
          contractId: 'CSANDBOXTESTCONTRACT0000000000000000000000000000000000000000',
          topic: ['transfer'],
          value: { amount: '1000000' },
        },
      };
    case 'multisig':
      return {
        event: 'multisig.signature_required',
        timestamp,
        data: {
          txHash: 'sandbox-test-transaction',
          accountId: 'GSANDBOXMULTISIGACCOUNT000000000000000000000000000000000000',
          threshold: 2,
          signaturesCollected: 1,
        },
      };
  }
}

export function isRetryableStatus(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

/** Retry-After in seconds (RFC 9110 delay-seconds form), or null when absent/invalid. */
function parseRetryAfterMs(headers: Record<string, string>): number | null {
  const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim()) * 1000;
}

/** 429 honours Retry-After (capped); everything else uses exponential backoff. */
export function computeBackoffMs(attempt: number, status: number | null, headers: Record<string, string>): number {
  const exponential = SANDBOX_BASE_BACKOFF_MS * 2 ** (attempt - 1);
  const retryAfter = status === 429 ? parseRetryAfterMs(headers) : null;
  return Math.min(retryAfter ?? exponential, SANDBOX_MAX_BACKOFF_MS);
}

function mockResponse(status: number): { status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'X-Stellar-Sandbox': 'mock-response' };
  if (status === 429) headers['Retry-After'] = '2';
  const body =
    status === 200
      ? JSON.stringify({ received: true })
      : JSON.stringify({ error: status === 429 ? 'rate_limited' : 'internal_error' });
  return { status, headers, body };
}

export class WebhookSandboxReplayService {
  async replay(input: SandboxReplayInput): Promise<SandboxReplayResult> {
    const body = JSON.stringify(buildSandboxEnvelope(input.eventType));
    const requestHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'StellarAlerts-Sandbox/1.0',
      'X-Stellar-Alerts-Sandbox': 'true',
    };

    const mode = input.mockStatusCode === undefined ? 'live' : 'mock';
    const attempts: SandboxAttempt[] = [];
    const startedAt = performance.now();

    for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
      const record =
        mode === 'mock'
          ? this.simulateAttempt(attempt, input.mockStatusCode!)
          : await this.dispatchAttempt(attempt, input.targetUrl, requestHeaders, body);

      record.retryable = isRetryableStatus(record.status);
      const hasNext = record.retryable && attempt < input.maxAttempts;
      record.backoffMs = hasNext ? computeBackoffMs(attempt, record.status, record.headers) : null;
      attempts.push(record);

      if (!hasNext) break;
    }

    const last = attempts[attempts.length - 1];
    return {
      success: last.status !== null && last.status >= 200 && last.status < 300,
      mode,
      eventType: input.eventType,
      request: { headers: requestHeaders, body },
      attempts,
      totalLatencyMs: Math.round(performance.now() - startedAt),
    };
  }

  private simulateAttempt(attempt: number, status: number): SandboxAttempt {
    const startedAt = performance.now();
    const mock = mockResponse(status);
    return {
      attempt,
      status: mock.status,
      latencyMs: Math.round(performance.now() - startedAt),
      headers: mock.headers,
      body: mock.body,
      error: null,
      retryable: false,
      backoffMs: null,
    };
  }

  private async dispatchAttempt(
    attempt: number,
    targetUrl: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<SandboxAttempt> {
    const startedAt = performance.now();
    try {
      const response = await ssrfSafeFetch(targetUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      return {
        attempt,
        status: response.status,
        latencyMs: Math.round(performance.now() - startedAt),
        headers: Object.fromEntries(Array.from(response.headers.entries()).slice(0, MAX_RESPONSE_HEADERS)),
        body: text,
        error: null,
        retryable: false,
        backoffMs: null,
      };
    } catch (error) {
      // Policy violations are the caller's mistake, not a flaky receiver: no retries.
      if (error instanceof SsrfValidationError) throw error;
      return {
        attempt,
        status: null,
        latencyMs: Math.round(performance.now() - startedAt),
        headers: {},
        body: '',
        error: (error as Error).message,
        retryable: false,
        backoffMs: null,
      };
    }
  }
}

export const webhookSandboxReplayService = new WebhookSandboxReplayService();
