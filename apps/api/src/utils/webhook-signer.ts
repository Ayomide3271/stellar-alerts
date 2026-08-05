import crypto from 'crypto';

export interface WebhookHeaderResult {
  signature: string;
  timestamp: number;
  headerValue: string;
}

/**
 * Generates an HMAC SHA256 signature for a webhook payload to prevent payload spoofing.
 */
export function generateWebhookSignature(
  payload: string,
  secret: string,
  timestamp: number = Date.now()
): WebhookHeaderResult {
  const hmac = crypto.createHmac('sha256', secret);
  const dataToSign = `${timestamp}.${payload}`;
  const signature = hmac.update(dataToSign).digest('hex');
  const headerValue = `t=${timestamp},v1=${signature}`;

  return {
    signature,
    timestamp,
    headerValue,
  };
}

/**
 * Verifies an incoming webhook signature header against secret key.
 */
export function verifyWebhookSignature(
  payload: string,
  headerValue: string,
  secret: string,
  toleranceMs: number = 300000 // 5 minutes
): boolean {
  if (!headerValue || !headerValue.includes('t=') || !headerValue.includes('v1=')) {
    return false;
  }

  const parts = headerValue.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) return false;

  const timestamp = parseInt(timestampPart.substring(2), 10);
  const signature = signaturePart.substring(3);

  if (isNaN(timestamp)) return false;

  // Check clock drift tolerance
  if (Math.abs(Date.now() - timestamp) > toleranceMs) {
    return false;
  }

  const expected = generateWebhookSignature(payload, secret, timestamp);
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected.signature));
}
