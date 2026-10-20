import https from 'https';
import crypto from 'crypto';
import { createMTLSAgent, MTLSAgentOptions } from '../../utils/mtls';
import { cryptoVault } from '../../utils/crypto-vault';
import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'MTLSTransport' });

export interface MTLSCredentials {
  clientCert: string;
  clientKey: string;
  caBundle?: string;
}

export interface EncryptedMTLSCredentials {
  encryptedCert: string;
  encryptedKey: string;
  caBundle?: string;
}

export interface MTLSDeliveryResult {
  status: number;
  data: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Encrypts client certificate and private key at rest using AES-256-GCM via cryptoVault.
 */
export function encryptMTLSCredentials(credentials: MTLSCredentials): EncryptedMTLSCredentials {
  return {
    encryptedCert: cryptoVault.encrypt(credentials.clientCert),
    encryptedKey: cryptoVault.encrypt(credentials.clientKey),
    caBundle: credentials.caBundle,
  };
}

/**
 * Decrypts encrypted client certificate and private key at rest.
 */
export function decryptMTLSCredentials(encrypted: EncryptedMTLSCredentials): MTLSCredentials {
  return {
    clientCert: cryptoVault.decrypt(encrypted.encryptedCert),
    clientKey: cryptoVault.decrypt(encrypted.encryptedKey),
    caBundle: encrypted.caBundle,
  };
}

/**
 * Sanitizes TLS and network error messages so private keys or internal memory fragments
 * are never leaked into application logs.
 */
export function sanitizeTLSError(err: any): string {
  if (!err) return 'Unknown TLS error';

  const code = err.code || err.name || 'TLS_HANDSHAKE_ERROR';
  const rawMessage = String(err.message || err);

  // Strip out any potential PEM keys or certificate content
  const sanitized = rawMessage
    .replace(/-----BEGIN[A-Z\s]+-----[\s\S]*?-----END[A-Z\s]+-----/g, '[REDACTED_PEM]')
    .replace(/key|secret|password|private/gi, (match) => `[REDACTED_${match.toUpperCase()}]`);

  return `TLS handshake verification failed (${code}): ${sanitized}`;
}

/**
 * Delivers an HTTP POST payload over HTTPS using mutual TLS (mTLS) client certificate negotiation.
 */
export async function deliverMTLSWebhook(
  url: string,
  payload: string,
  credentials: MTLSCredentials,
  headers: Record<string, string> = {},
  timeoutMs = 10000
): Promise<MTLSDeliveryResult> {
  const agent = createMTLSAgent({
    clientCert: credentials.clientCert,
    clientKey: credentials.clientKey,
    caBundle: credentials.caBundle,
    rejectUnauthorized: true,
  });

  const parsedUrl = new URL(url);

  return new Promise((resolve, reject) => {
    const req = https.request(
      parsedUrl,
      {
        method: 'POST',
        agent,
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
      req.destroy();
      const err = new Error('mTLS request timeout');
      (err as any).code = 'ETIMEDOUT';
      logger.error({ url: parsedUrl.hostname }, sanitizeTLSError(err));
      reject(err);
    });

    req.on('error', (err: any) => {
      const sanitized = sanitizeTLSError(err);
      logger.error({ url: parsedUrl.hostname, code: err.code }, sanitized);
      reject(new Error(sanitized));
    });

    req.write(payload);
    req.end();
  });
}
