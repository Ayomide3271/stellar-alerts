import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  WebhookSandbox,
  buildSignatureSnippets,
  buildSamplePayload,
  type SandboxAttempt,
  type SandboxReplayResponse,
} from './WebhookSandbox';

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { accessToken: 'test-token' } }),
}));

function attempt(overrides: Partial<SandboxAttempt> = {}): SandboxAttempt {
  return {
    attempt: 1,
    status: 200,
    latencyMs: 42,
    headers: { 'x-sandbox': 'accepted' },
    body: '{"received":true}',
    error: null,
    retryable: false,
    backoffMs: null,
    ...overrides,
  };
}

function mockReplay(body: Partial<SandboxReplayResponse> | Record<string, unknown>, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebhookSandbox', () => {
  it('builds a deterministic sample payload for each event type', () => {
    const date = new Date('2026-08-29T00:00:00.000Z');

    expect(buildSamplePayload('payment', date).event).toBe('payment.received');
    expect(buildSamplePayload('soroban', date).event).toBe('soroban.contract_event');
    expect(buildSamplePayload('multisig', date).event).toBe('multisig.signature_required');
    expect(buildSamplePayload('payment', date).timestamp).toBe('2026-08-29T00:00:00.000Z');
  });

  it('renders signature snippets for each supported runtime', () => {
    const snippets = buildSignatureSnippets(
      'https://example.com/hook',
      JSON.stringify(buildSamplePayload('payment', new Date('2026-08-29T00:00:00.000Z')), null, 2)
    );

    expect(snippets.node).toContain('createHmac');
    expect(snippets.python).toContain('hmac.new');
    expect(snippets.curl).toContain('curl -X POST');
  });

  it('updates the payload preview when a different sample event is selected', () => {
    render(<WebhookSandbox />);

    fireEvent.change(screen.getByLabelText(/Sample event/i), { target: { value: 'soroban' } });

    expect((screen.getByLabelText(/Payload preview/i) as HTMLTextAreaElement).value).toContain(
      'soroban.contract_event'
    );
  });

  it('posts the selected event and target URL to the sandbox endpoint and shows headers, body and latency', async () => {
    const fetchMock = mockReplay({
      success: true,
      mode: 'live',
      eventType: 'multisig',
      attempts: [attempt({ latencyMs: 137 })],
      totalLatencyMs: 140,
    });

    render(<WebhookSandbox />);
    fireEvent.change(screen.getByLabelText(/Webhook URL/i), { target: { value: 'https://example.com/hook' } });
    fireEvent.change(screen.getByLabelText(/Sample event/i), { target: { value: 'multisig' } });
    fireEvent.click(screen.getByRole('button', { name: /Send Test Webhook/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/webhooks\/sandbox\/replay$/);
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(sentBody(fetchMock)).toEqual({ eventType: 'multisig', targetUrl: 'https://example.com/hook' });

    expect(await screen.findByTestId('final-status')).toHaveTextContent('200');
    expect(screen.getByTestId('final-latency')).toHaveTextContent('137ms');
    expect(screen.getByText(/x-sandbox: accepted/)).toBeInTheDocument();
    expect(screen.getByText(/"received":true/)).toBeInTheDocument();
  });

  it.each(['200', '429', '500'])('sends mockStatusCode %s when a simulated response is selected', async (code) => {
    const fetchMock = mockReplay({
      success: code === '200',
      mode: 'mock',
      eventType: 'payment',
      attempts: [attempt({ status: Number(code) })],
      totalLatencyMs: 1,
    });

    render(<WebhookSandbox />);
    fireEvent.change(screen.getByLabelText(/Receiver response/i), { target: { value: code } });
    fireEvent.click(screen.getByRole('button', { name: /Send Test Webhook/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody(fetchMock).mockStatusCode).toBe(Number(code));
    expect(await screen.findByTestId('final-status')).toHaveTextContent(code);
  });

  it('renders every retry attempt with its backoff when the endpoint returns 429 then 500', async () => {
    mockReplay({
      success: false,
      mode: 'mock',
      eventType: 'payment',
      attempts: [
        attempt({ attempt: 1, status: 429, latencyMs: 3, retryable: true, backoffMs: 2000 }),
        attempt({ attempt: 2, status: 500, latencyMs: 4, retryable: true, backoffMs: 2000 }),
        attempt({ attempt: 3, status: 500, latencyMs: 5, retryable: true }),
      ],
      totalLatencyMs: 12,
    });

    render(<WebhookSandbox />);
    fireEvent.click(screen.getByRole('button', { name: /Send Test Webhook/i }));

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('#1: 429 in 3ms - retry in 2000ms');
    expect(items[1]).toHaveTextContent('#2: 500 in 4ms - retry in 2000ms');
    expect(items[2]).toHaveTextContent('#3: 500 in 5ms');
    expect(items[2]).not.toHaveTextContent('retry in');
    expect(screen.getByTestId('final-status')).toHaveTextContent('500');
  });

  it('shows the network error when the receiver never answered', async () => {
    mockReplay({
      success: false,
      mode: 'live',
      eventType: 'payment',
      attempts: [attempt({ status: null, body: '', error: 'connect ECONNREFUSED', headers: {} })],
      totalLatencyMs: 9,
    });

    render(<WebhookSandbox />);
    fireEvent.click(screen.getByRole('button', { name: /Send Test Webhook/i }));

    expect(await screen.findByTestId('final-status')).toHaveTextContent('No response');
    expect(screen.getAllByText(/connect ECONNREFUSED/).length).toBeGreaterThan(0);
  });

  it('surfaces API rejections such as blocked target URLs', async () => {
    mockReplay({ error: 'Target URL rejected', message: 'Destination resolves to restricted or private IP' }, false, 400);

    render(<WebhookSandbox />);
    fireEvent.click(screen.getByRole('button', { name: /Send Test Webhook/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/private IP/);
  });

  it('shows a request error when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')));

    render(<WebhookSandbox />);
    fireEvent.click(screen.getByRole('button', { name: /Send Test Webhook/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
  });
});
