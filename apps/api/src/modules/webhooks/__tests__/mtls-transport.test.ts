import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import https from 'https';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  encryptMTLSCredentials,
  decryptMTLSCredentials,
  sanitizeTLSError,
  deliverMTLSWebhook,
} from '../mtls-transport';

describe('Mutual TLS (mTLS) Client Certificate Egress (#632)', () => {
  let tmpDir: string;
  let caCert: string;
  let serverCert: string;
  let serverKey: string;
  let clientCert: string;
  let clientKey: string;
  let untrustedClientCert: string;
  let untrustedClientKey: string;
  let server: https.Server;
  let serverPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtls-test-'));

    // 1. Generate Root CA
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${tmpDir}/ca.key" -out "${tmpDir}/ca.crt" -days 1 -subj "/CN=TestCA"`, { stdio: 'ignore' });
    caCert = fs.readFileSync(path.join(tmpDir, 'ca.crt'), 'utf8');

    // 2. Generate Server Key & Cert signed by Root CA with SAN
    const sanConfig = `
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no
[req_distinguished_name]
CN = 127.0.0.1
[v3_req]
subjectAltName = @alt_names
[alt_names]
IP.1 = 127.0.0.1
DNS.1 = localhost
`;
    fs.writeFileSync(path.join(tmpDir, 'san.cnf'), sanConfig);

    execSync(`openssl req -newkey rsa:2048 -nodes -keyout "${tmpDir}/server.key" -out "${tmpDir}/server.csr" -config "${tmpDir}/san.cnf"`, { stdio: 'ignore' });
    execSync(`openssl x509 -req -in "${tmpDir}/server.csr" -CA "${tmpDir}/ca.crt" -CAkey "${tmpDir}/ca.key" -CAcreateserial -out "${tmpDir}/server.crt" -days 1 -extfile "${tmpDir}/san.cnf" -extensions v3_req`, { stdio: 'ignore' });
    serverCert = fs.readFileSync(path.join(tmpDir, 'server.crt'), 'utf8');
    serverKey = fs.readFileSync(path.join(tmpDir, 'server.key'), 'utf8');

    // 3. Generate Trusted Client Key & Cert signed by Root CA
    execSync(`openssl req -newkey rsa:2048 -nodes -keyout "${tmpDir}/client.key" -out "${tmpDir}/client.csr" -subj "/CN=TrustedClient"`, { stdio: 'ignore' });
    execSync(`openssl x509 -req -in "${tmpDir}/client.csr" -CA "${tmpDir}/ca.crt" -CAkey "${tmpDir}/ca.key" -CAcreateserial -out "${tmpDir}/client.crt" -days 1`, { stdio: 'ignore' });
    clientCert = fs.readFileSync(path.join(tmpDir, 'client.crt'), 'utf8');
    clientKey = fs.readFileSync(path.join(tmpDir, 'client.key'), 'utf8');

    // 4. Generate Untrusted Client Key & Self-Signed Cert
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${tmpDir}/untrusted.key" -out "${tmpDir}/untrusted.crt" -days 1 -subj "/CN=UntrustedClient"`, { stdio: 'ignore' });
    untrustedClientCert = fs.readFileSync(path.join(tmpDir, 'untrusted.crt'), 'utf8');
    untrustedClientKey = fs.readFileSync(path.join(tmpDir, 'untrusted.key'), 'utf8');

    // 5. Spin up local HTTPS server requiring client certificate (mTLS)
    server = https.createServer(
      {
        key: serverKey,
        cert: serverCert,
        ca: caCert,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'mtls_authenticated', received: body }));
        });
      }
    );

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as any;
        serverPort = address.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Encrypted credential storage (AES-256-GCM)', () => {
    it('encrypts and decrypts client certificate and private key at rest', () => {
      const credentials = {
        clientCert,
        clientKey,
        caBundle: caCert,
      };

      const encrypted = encryptMTLSCredentials(credentials);
      expect(encrypted.encryptedCert).toBeDefined();
      expect(encrypted.encryptedKey).toBeDefined();
      expect(encrypted.encryptedCert).not.toContain('BEGIN CERTIFICATE');
      expect(encrypted.encryptedKey).not.toContain('BEGIN PRIVATE KEY');

      const decrypted = decryptMTLSCredentials(encrypted);
      expect(decrypted.clientCert).toBe(clientCert);
      expect(decrypted.clientKey).toBe(clientKey);
      expect(decrypted.caBundle).toBe(caCert);
    });
  });

  describe('Sanitized TLS error logging', () => {
    it('strips private keys and PEM blocks from logged errors', () => {
      const sensitiveError = new Error(`Handshake failed with private key: ${clientKey}`);
      const sanitized = sanitizeTLSError(sensitiveError);

      expect(sanitized).not.toContain('BEGIN PRIVATE KEY');
      expect(sanitized).toContain('[REDACTED_PEM]');
      expect(sanitized).toContain('TLS handshake verification failed');
    });
  });

  describe('Mutual TLS Dispatcher', () => {
    it('successfully negotiates mTLS with trusted client certificate', async () => {
      const url = `https://127.0.0.1:${serverPort}/webhook`;
      const payload = JSON.stringify({ event: 'payment.dispatched', amount: '100' });

      const response = await deliverMTLSWebhook(
        url,
        payload,
        {
          clientCert,
          clientKey,
          caBundle: caCert,
        },
        {},
        5000
      );

      expect(response.status).toBe(200);
      const data = JSON.parse(response.data);
      expect(data.status).toBe('mtls_authenticated');
    });

    it('rejects delivery when untrusted client certificate is presented', async () => {
      const url = `https://127.0.0.1:${serverPort}/webhook`;
      const payload = JSON.stringify({ event: 'untrusted.attempt' });

      await expect(
        deliverMTLSWebhook(
          url,
          payload,
          {
            clientCert: untrustedClientCert,
            clientKey: untrustedClientKey,
            caBundle: caCert,
          },
          {},
          5000
        )
      ).rejects.toThrow(/TLS handshake verification failed/);
    });
  });
});
