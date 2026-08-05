import { describe, it, expect } from 'vitest';
import { generateWebhookSignature, verifyWebhookSignature } from '../webhook-signer';

describe('Webhook HMAC Signer', () => {
  const payload = JSON.stringify({ event: 'payment.received', amount: '100.00', asset: 'XLM' });
  const secret = 'webhook_secret_key_9988776655';

  it('should generate valid HMAC signature header', () => {
    const timestamp = 1700000000000;
    const result = generateWebhookSignature(payload, secret, timestamp);

    expect(result.timestamp).toBe(timestamp);
    expect(result.signature).toHaveLength(64); // SHA256 hex length
    expect(result.headerValue).toBe(`t=1700000000000,v1=${result.signature}`);
  });

  it('should verify valid signature header', () => {
    const now = Date.now();
    const result = generateWebhookSignature(payload, secret, now);

    const isValid = verifyWebhookSignature(payload, result.headerValue, secret);
    expect(isValid).toBe(true);
  });

  it('should reject tampered payload', () => {
    const now = Date.now();
    const result = generateWebhookSignature(payload, secret, now);

    const tamperedPayload = JSON.stringify({ event: 'payment.received', amount: '999.00', asset: 'XLM' });
    const isValid = verifyWebhookSignature(tamperedPayload, result.headerValue, secret);
    expect(isValid).toBe(false);
  });

  it('should reject invalid secret', () => {
    const now = Date.now();
    const result = generateWebhookSignature(payload, secret, now);

    const isValid = verifyWebhookSignature(payload, result.headerValue, 'wrong_secret_key');
    expect(isValid).toBe(false);
  });
});
