import https from 'https';
import tls from 'tls';
import crypto from 'crypto';
import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'PinningTransport' });

export interface PinningDeliveryOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Optional private CA bundle; the system trust store is used when omitted. */
  caBundle?: string;
}

export interface PinningDeliveryResult {
  status: number;
  data: string;
  headers: Record<string, string | string[] | undefined>;
}

export class SpkiPinMismatchError extends Error {
  readonly code = 'ERR_SPKI_PIN_MISMATCH';

  constructor(
    readonly host: string,
    readonly observedPin: string
  ) {
    super(`SPKI pin mismatch for ${host}`);
    this.name = 'SpkiPinMismatchError';
  }
}

const SHA256_BYTES = 32;

/**
 * Normalizes a user-supplied SPKI pin to base64-encoded SHA-256.
 * Accepts base64, hex, or the HPKP-style `sha256/<base64>` form.
 */
export function normalizeSpkiPin(pin: string): string {
  const value = pin.trim().replace(/^sha256[/=]/i, '');
  const bytes = /^[0-9a-f]+$/i.test(value) && value.length === SHA256_BYTES * 2
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');

  if (bytes.length !== SHA256_BYTES) {
    throw new Error('Invalid SPKI pin: expected a SHA-256 digest (32 bytes)');
  }
  return bytes.toString('base64');
}

/**
 * Computes the base64 SHA-256 digest of a certificate's Subject Public Key Info.
 */
export function computeSpkiPin(certDer: Buffer): string {
  const spki = new crypto.X509Certificate(certDer).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  return crypto.createHash('sha256').update(spki).digest('base64');
}

/**
 * Returns true when the certificate's SPKI hash matches any configured pin.
 */
export function matchesSpkiPin(certDer: Buffer, pins: string[]): boolean {
  const observed = Buffer.from(computeSpkiPin(certDer), 'base64');
  return pins.some((pin) => {
    const expected = Buffer.from(normalizeSpkiPin(pin), 'base64');
    return crypto.timingSafeEqual(observed, expected);
  });
}

/**
 * Delivers an HTTP POST over HTTPS, aborting the TLS handshake (before any
 * request bytes are written) unless the peer's SPKI hash matches a pin.
 */
export async function deliverPinnedWebhook(
  url: string,
  payload: string,
  pins: string[],
  options: PinningDeliveryOptions = {}
): Promise<PinningDeliveryResult> {
  if (pins.length === 0) {
    throw new Error('At least one SPKI pin is required');
  }
  const normalizedPins = pins.map(normalizeSpkiPin);
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('SPKI pinning requires an https:// URL');
  }

  const { headers = {}, timeoutMs = 10000, caBundle } = options;

  return new Promise((resolve, reject) => {
    const req = https.request(
      parsedUrl,
      {
        method: 'POST',
        agent: false,
        rejectUnauthorized: true,
        ca: caBundle,
        // Runs during the handshake, before the request is flushed to the socket.
        checkServerIdentity: (host, cert) => {
          const hostnameError = tls.checkServerIdentity(host, cert);
          if (hostnameError) return hostnameError;

          if (!matchesSpkiPin(cert.raw, normalizedPins)) {
            const observedPin = computeSpkiPin(cert.raw);
            logger.error(
              { event: 'security_audit', action: 'spki_pin_mismatch', host, observedPin },
              'Webhook egress aborted: peer SPKI fingerprint does not match any configured pin'
            );
            return new SpkiPinMismatchError(host, observedPin);
          }
          return undefined;
        },
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 200,
            data: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers as Record<string, string | string[] | undefined>,
          });
        });
      }
    );

    req.on('timeout', () => {
      const err = new Error('Pinned webhook request timeout');
      (err as any).code = 'ETIMEDOUT';
      req.destroy(err);
    });

    req.on('error', (err) => reject(err));

    req.write(payload);
    req.end();
  });
}
