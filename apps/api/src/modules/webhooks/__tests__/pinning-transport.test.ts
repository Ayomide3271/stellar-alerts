import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import https from 'https';
import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));
vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: loggerError,
  }),
}));

import {
  computeSpkiPin,
  deliverPinnedWebhook,
  matchesSpkiPin,
  normalizeSpkiPin,
  SpkiPinMismatchError,
} from '../pinning-transport';

describe('SPKI public key pinning for webhook egress (#752)', () => {
  let tmpDir: string;
  let serverCert: string;
  let serverKey: string;
  let correctPin: string;
  let wrongPin: string;
  let server: https.Server;
  let serverPort: number;
  let requestsReceived: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinning-test-'));

    const sanConfig = `
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = localhost
[v3]
subjectAltName = @alt
[alt]
DNS.1 = localhost
IP.1 = 127.0.0.1
`;
    fs.writeFileSync(path.join(tmpDir, 'san.cnf'), sanConfig);
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${tmpDir}/server.key" -out "${tmpDir}/server.crt" -days 1 -config "${tmpDir}/san.cnf"`,
      { stdio: 'ignore' }
    );
    serverCert = fs.readFileSync(path.join(tmpDir, 'server.crt'), 'utf8');
    serverKey = fs.readFileSync(path.join(tmpDir, 'server.key'), 'utf8');

    correctPin = computeSpkiPin(new crypto.X509Certificate(serverCert).raw);
    wrongPin = crypto.createHash('sha256').update('not-the-server-key').digest('base64');

    server = https.createServer({ cert: serverCert, key: serverKey }, (req, res) => {
      requestsReceived++;
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverPort = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    requestsReceived = 0;
    loggerError.mockClear();
  });

  const url = () => `https://localhost:${serverPort}/hook`;

  describe('pin handling', () => {
    it('matches the SPKI hash against base64, hex and sha256/ prefixed pins', () => {
      const der = new crypto.X509Certificate(serverCert).raw;
      const hex = Buffer.from(correctPin, 'base64').toString('hex');
      expect(matchesSpkiPin(der, [correctPin])).toBe(true);
      expect(matchesSpkiPin(der, [hex])).toBe(true);
      expect(matchesSpkiPin(der, [`sha256/${correctPin}`])).toBe(true);
      expect(matchesSpkiPin(der, [wrongPin])).toBe(false);
    });

    it('matches when any one of several pins (e.g. a backup pin) is correct', () => {
      const der = new crypto.X509Certificate(serverCert).raw;
      expect(matchesSpkiPin(der, [wrongPin, correctPin])).toBe(true);
    });

    it('rejects pins that are not a SHA-256 digest', () => {
      expect(() => normalizeSpkiPin('abc')).toThrow(/Invalid SPKI pin/);
    });
  });

  describe('deliverPinnedWebhook', () => {
    it('delivers the payload when the peer SPKI hash matches the pin', async () => {
      const result = await deliverPinnedWebhook(url(), '{"a":1}', [correctPin], {
        caBundle: serverCert,
      });
      expect(result.status).toBe(200);
      expect(result.data).toBe('ok');
      expect(requestsReceived).toBe(1);
    });

    it('terminates the connection and sends no payload when the pin mismatches', async () => {
      await expect(
        deliverPinnedWebhook(url(), '{"a":1}', [wrongPin], { caBundle: serverCert })
      ).rejects.toBeInstanceOf(SpkiPinMismatchError);
      expect(requestsReceived).toBe(0);
    });

    it('writes a security audit log entry on mismatch', async () => {
      await expect(
        deliverPinnedWebhook(url(), '{"a":1}', [wrongPin], { caBundle: serverCert })
      ).rejects.toThrow(/SPKI pin mismatch/);

      expect(loggerError).toHaveBeenCalledTimes(1);
      const [fields] = loggerError.mock.calls[0];
      expect(fields).toMatchObject({
        event: 'security_audit',
        action: 'spki_pin_mismatch',
        host: 'localhost',
        observedPin: correctPin,
      });
    });

    it('still enforces CA trust: a matching pin does not bypass chain validation', async () => {
      await expect(deliverPinnedWebhook(url(), '{"a":1}', [correctPin])).rejects.toThrow();
      expect(requestsReceived).toBe(0);
    });

    it('requires at least one pin and an https URL', async () => {
      await expect(deliverPinnedWebhook(url(), '{}', [])).rejects.toThrow(/At least one SPKI pin/);
      await expect(
        deliverPinnedWebhook('http://localhost/hook', '{}', [correctPin])
      ).rejects.toThrow(/https/);
    });
  });
});
