'use client';

import React, { useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001';

type SignatureLanguage = 'node' | 'python' | 'curl';
export type SandboxEventType = 'payment' | 'soroban' | 'multisig';
export type MockStatus = 'live' | '200' | '429' | '500';

export interface SandboxAttempt {
  attempt: number;
  status: number | null;
  latencyMs: number;
  headers: Record<string, string>;
  body: string;
  error: string | null;
  retryable: boolean;
  backoffMs: number | null;
}

export interface SandboxReplayResponse {
  success: boolean;
  mode: 'mock' | 'live';
  eventType: SandboxEventType;
  attempts: SandboxAttempt[];
  totalLatencyMs: number;
}

const DEFAULT_WEBHOOK_URL = 'https://example.com/stellar-alerts/webhook';
const WEBHOOK_SECRET_PLACEHOLDER = 'whsec_test_secret';

const EVENT_OPTIONS: Array<{ value: SandboxEventType; label: string }> = [
  { value: 'payment', label: 'Payment' },
  { value: 'soroban', label: 'Soroban contract event' },
  { value: 'multisig', label: 'Multisig signature required' },
];

const MOCK_OPTIONS: Array<{ value: MockStatus; label: string }> = [
  { value: 'live', label: 'Live dispatch to target URL' },
  { value: '200', label: 'Simulate 200 OK' },
  { value: '429', label: 'Simulate 429 Too Many Requests' },
  { value: '500', label: 'Simulate 500 Server Error' },
];

/** Mirrors the envelopes the API sandbox sends so the preview matches the wire payload. */
export function buildSamplePayload(eventType: SandboxEventType, date: Date = new Date()) {
  const timestamp = date.toISOString();
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

function escapeSingleQuotedShellValue(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}

export function buildSignatureSnippets(
  webhookUrl: string,
  payloadJson: string,
  secret: string = WEBHOOK_SECRET_PLACEHOLDER
): Record<SignatureLanguage, string> {
  const endpoint = webhookUrl.trim() || DEFAULT_WEBHOOK_URL;

  return {
    node: [
      "import crypto from 'node:crypto';",
      '',
      `const payload = ${payloadJson};`,
      `const secret = '${secret}';`,
      "const signature = crypto.createHmac('sha256', secret)",
      '  .update(JSON.stringify(payload))',
      "  .digest('hex');",
      '',
      `await fetch('${endpoint}', {`,
      "  method: 'POST',",
      "  headers: {",
      "    'Content-Type': 'application/json',",
      "    'X-Stellar-Alerts-Signature': signature,",
      '  },',
      '  body: JSON.stringify(payload),',
      '});',
    ].join('\n'),
    python: [
      'import hashlib',
      'import hmac',
      'import json',
      'import requests',
      '',
      `payload = ${payloadJson}`,
      `secret = '${secret}'.encode()`,
      'body = json.dumps(payload, separators=(",", ":")).encode()',
      'signature = hmac.new(secret, body, hashlib.sha256).hexdigest()',
      '',
      `requests.post('${endpoint}', json=payload, headers={`,
      "    'X-Stellar-Alerts-Signature': signature,",
      '})',
    ].join('\n'),
    curl: [
      `curl -X POST '${escapeSingleQuotedShellValue(endpoint)}' \\`,
      "  -H 'Content-Type: application/json' \\",
      "  -H 'X-Stellar-Alerts-Signature: <computed-hmac-sha256>' \\",
      `  -d '${escapeSingleQuotedShellValue(payloadJson)}'`,
    ].join('\n'),
  };
}

function describeAttemptOutcome(attempt: SandboxAttempt): string {
  if (attempt.status === null) return attempt.error ?? 'No response';
  return String(attempt.status);
}

export const WebhookSandbox: React.FC = () => {
  const { data: session } = useSession();
  const [webhookUrl, setWebhookUrl] = useState(DEFAULT_WEBHOOK_URL);
  const [eventType, setEventType] = useState<SandboxEventType>('payment');
  const [mockStatus, setMockStatus] = useState<MockStatus>('live');
  const [selectedLanguage, setSelectedLanguage] = useState<SignatureLanguage>('node');
  const [result, setResult] = useState<SandboxReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [previewDate] = useState(() => new Date());

  const payloadText = useMemo(
    () => JSON.stringify(buildSamplePayload(eventType, previewDate), null, 2),
    [eventType, previewDate]
  );
  const signatureSnippets = useMemo(
    () => buildSignatureSnippets(webhookUrl, payloadText),
    [payloadText, webhookUrl]
  );

  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setResult(null);
    setIsSending(true);

    try {
      const response = await fetch(`${API_BASE_URL}/webhooks/sandbox/replay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.accessToken}`,
        },
        body: JSON.stringify({
          eventType,
          targetUrl: webhookUrl,
          ...(mockStatus === 'live' ? {} : { mockStatusCode: Number(mockStatus) }),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.message ?? data?.error ?? `Sandbox replay failed (${response.status})`);
        return;
      }
      setResult(data as SandboxReplayResponse);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Sandbox replay failed');
    } finally {
      setIsSending(false);
    }
  };

  const finalAttempt = result ? result.attempts[result.attempts.length - 1] : null;

  return (
    <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 backdrop-blur-xl shadow-xl mb-8">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">Webhook Sandbox</h2>
          <p className="text-sm text-slate-400 mt-1">
            Replay sample events against your receiver, or simulate 200, 429 and 500 responses to test retry handling.
          </p>
        </div>
        <div className="rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 px-3 py-1 text-xs font-semibold">
          Test Mode
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <form onSubmit={handleSend} className="space-y-4">
          <div>
            <label htmlFor="webhook-sandbox-url" className="block text-xs font-semibold text-slate-400 mb-1">
              Webhook URL
            </label>
            <input
              id="webhook-sandbox-url"
              type="url"
              required
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-slate-950/70 border border-slate-800 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/80 focus:ring-1 focus:ring-cyan-500/40"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="webhook-sandbox-event" className="block text-xs font-semibold text-slate-400 mb-1">
                Sample event
              </label>
              <select
                id="webhook-sandbox-event"
                value={eventType}
                onChange={(event) => setEventType(event.target.value as SandboxEventType)}
                className="w-full px-4 py-3 rounded-xl bg-slate-950/70 border border-slate-800 text-sm text-slate-100 focus:outline-none focus:border-cyan-500/80 focus:ring-1 focus:ring-cyan-500/40"
              >
                {EVENT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="webhook-sandbox-mock" className="block text-xs font-semibold text-slate-400 mb-1">
                Receiver response
              </label>
              <select
                id="webhook-sandbox-mock"
                value={mockStatus}
                onChange={(event) => setMockStatus(event.target.value as MockStatus)}
                className="w-full px-4 py-3 rounded-xl bg-slate-950/70 border border-slate-800 text-sm text-slate-100 focus:outline-none focus:border-cyan-500/80 focus:ring-1 focus:ring-cyan-500/40"
              >
                {MOCK_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="webhook-sandbox-payload" className="block text-xs font-semibold text-slate-400 mb-1">
              Payload preview
            </label>
            <textarea
              id="webhook-sandbox-payload"
              value={payloadText}
              readOnly
              rows={12}
              className="w-full px-4 py-3 rounded-xl bg-slate-950/70 border border-slate-800 text-xs font-mono text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/80 focus:ring-1 focus:ring-cyan-500/40"
            />
          </div>

          <button
            type="submit"
            disabled={isSending}
            className="w-full sm:w-auto px-5 py-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSending ? 'Sending...' : 'Send Test Webhook'}
          </button>
        </form>

        <div className="space-y-4">
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4 min-h-[168px]">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
              Response Inspector
            </div>
            {error ? (
              <div role="alert" className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg p-3">
                {error}
              </div>
            ) : result && finalAttempt ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-slate-900/80 border border-slate-800 p-3">
                    <div className="text-[11px] text-slate-500 uppercase font-semibold">Status</div>
                    <div data-testid="final-status" className="text-2xl font-bold text-cyan-300">
                      {finalAttempt.status ?? 'No response'}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-900/80 border border-slate-800 p-3">
                    <div className="text-[11px] text-slate-500 uppercase font-semibold">Round-trip latency</div>
                    <div data-testid="final-latency" className="text-2xl font-bold text-emerald-300">
                      {finalAttempt.latencyMs}ms
                    </div>
                  </div>
                </div>

                <div>
                  <div className="text-[11px] text-slate-500 uppercase font-semibold mb-1">
                    Attempts ({result.mode === 'mock' ? 'simulated' : 'live'}, {result.totalLatencyMs}ms total)
                  </div>
                  <ol data-testid="attempt-list" className="space-y-1 text-xs text-slate-300">
                    {result.attempts.map((attempt) => (
                      <li key={attempt.attempt} className="rounded-lg bg-black/30 border border-slate-800 px-3 py-2">
                        #{attempt.attempt}: {describeAttemptOutcome(attempt)} in {attempt.latencyMs}ms
                        {attempt.backoffMs !== null ? ` - retry in ${attempt.backoffMs}ms` : ''}
                      </li>
                    ))}
                  </ol>
                </div>

                <div>
                  <div className="text-[11px] text-slate-500 uppercase font-semibold mb-1">Headers</div>
                  <pre className="max-h-24 overflow-auto rounded-lg bg-black/30 border border-slate-800 p-3 text-xs text-slate-300">
                    {Object.keys(finalAttempt.headers).length > 0
                      ? Object.entries(finalAttempt.headers)
                          .map(([key, value]) => `${key}: ${value}`)
                          .join('\n')
                      : '(no readable response headers)'}
                  </pre>
                </div>
                <div>
                  <div className="text-[11px] text-slate-500 uppercase font-semibold mb-1">Body</div>
                  <pre className="max-h-32 overflow-auto rounded-lg bg-black/30 border border-slate-800 p-3 text-xs text-slate-300 whitespace-pre-wrap">
                    {finalAttempt.body || finalAttempt.error || '(empty response body)'}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="h-full min-h-[120px] rounded-lg bg-black/20 border border-slate-800/80 flex items-center justify-center text-sm text-slate-500">
                Awaiting test response
              </div>
            )}
          </div>

          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {(['node', 'python', 'curl'] as SignatureLanguage[]).map((language) => (
                <button
                  key={language}
                  type="button"
                  onClick={() => setSelectedLanguage(language)}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-semibold capitalize transition-colors ${
                    selectedLanguage === language
                      ? 'bg-purple-500/20 border-purple-400/60 text-purple-100'
                      : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {language}
                </button>
              ))}
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg bg-black/40 border border-slate-800 p-4 text-xs text-slate-300 whitespace-pre-wrap">
              {signatureSnippets[selectedLanguage]}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
