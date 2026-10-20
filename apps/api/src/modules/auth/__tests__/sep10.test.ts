import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import { SEP10Service } from '../sep10.service';

vi.mock('../../../config/env', () => ({
  env: {
    JWT_SECRET: 'test-sep10-jwt-secret-key-32-chars-long!!',
    STELLAR_NETWORK_PASSPHRASE: StellarSdk.Networks.TESTNET,
  },
}));

const mockPrisma = vi.hoisted(() => ({
  wallet: {
    findUnique: vi.fn(),
  },
  user: {
    create: vi.fn(),
  },
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: mockPrisma,
}));

describe('SEP-0010 Stellar Web Authentication API (#634)', () => {
  let sep10Service: SEP10Service;
  let serverKeypair: StellarSdk.Keypair;
  const homeDomain = 'stellar-alerts.org';
  const networkPassphrase = StellarSdk.Networks.TESTNET;

  beforeEach(() => {
    vi.clearAllMocks();
    serverKeypair = StellarSdk.Keypair.random();
    sep10Service = new SEP10Service(
      serverKeypair.secret(),
      homeDomain,
      networkPassphrase
    );
  });

  describe('generateChallenge', () => {
    it('generates a valid SEP-0010 challenge transaction envelope signed by the server', () => {
      const clientKeypair = StellarSdk.Keypair.random();
      const challenge = sep10Service.generateChallenge(clientKeypair.publicKey());

      expect(challenge).toHaveProperty('transaction');
      expect(challenge).toHaveProperty('networkPassphrase', networkPassphrase);

      const tx = StellarSdk.TransactionBuilder.fromXDR(challenge.transaction, networkPassphrase) as StellarSdk.Transaction;
      
      // Sequence number must be 0
      expect(tx.sequence).toBe('0');
      // Source account must match server public key
      expect(tx.source).toBe(serverKeypair.publicKey());
      // Timebounds must exist
      expect(tx.timeBounds).toBeDefined();
      expect(Number(tx.timeBounds?.minTime)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      expect(Number(tx.timeBounds?.maxTime)).toBeGreaterThan(Math.floor(Date.now() / 1000));

      // Operations: manageData with client public key as source
      expect(tx.operations).toHaveLength(1);
      const op = tx.operations[0] as StellarSdk.Operation.ManageData;
      expect(op.type).toBe('manageData');
      expect(op.source).toBe(clientKeypair.publicKey());
      expect(op.name).toBe(`${homeDomain} auth`);
      expect(op.value).toBeDefined();

      // Signed by server key
      const txHash = tx.hash();
      const serverSigValid = tx.signatures.some((sig) => {
        try {
          return serverKeypair.verify(txHash, sig.signature());
        } catch {
          return false;
        }
      });
      expect(serverSigValid).toBe(true);
    });

    it('throws error for invalid client public key', () => {
      expect(() => sep10Service.generateChallenge('invalid-key')).toThrow(
        /Invalid client Stellar public key/
      );
    });
  });

  describe('verifyChallenge', () => {
    it('successfully validates when client signs the challenge envelope', () => {
      const clientKeypair = StellarSdk.Keypair.random();
      const challenge = sep10Service.generateChallenge(clientKeypair.publicKey());

      // Client signs the challenge transaction
      const tx = StellarSdk.TransactionBuilder.fromXDR(challenge.transaction, networkPassphrase) as StellarSdk.Transaction;
      tx.sign(clientKeypair);

      const clientSignedXdr = tx.toEnvelope().toXDR('base64');
      const result = sep10Service.verifyChallenge(clientSignedXdr);

      expect(result.valid).toBe(true);
      expect(result.clientPublicKey).toBe(clientKeypair.publicKey());
    });

    it('rejects challenge if client has not signed', () => {
      const clientKeypair = StellarSdk.Keypair.random();
      const challenge = sep10Service.generateChallenge(clientKeypair.publicKey());

      expect(() => sep10Service.verifyChallenge(challenge.transaction)).toThrow(
        /Challenge transaction is missing a valid signature from client/
      );
    });

    it('rejects challenge if signed by wrong client key', () => {
      const clientKeypair = StellarSdk.Keypair.random();
      const attackerKeypair = StellarSdk.Keypair.random();
      const challenge = sep10Service.generateChallenge(clientKeypair.publicKey());

      const tx = StellarSdk.TransactionBuilder.fromXDR(challenge.transaction, networkPassphrase) as StellarSdk.Transaction;
      tx.sign(attackerKeypair);

      const signedXdr = tx.toEnvelope().toXDR('base64');
      expect(() => sep10Service.verifyChallenge(signedXdr)).toThrow(
        /Challenge transaction is missing a valid signature from client/
      );
    });

    it('rejects expired challenge transaction', () => {
      const clientKeypair = StellarSdk.Keypair.random();
      const serverAccount = new StellarSdk.Account(serverKeypair.publicKey(), '-1');

      // Expired timebounds (in the past)
      const pastTime = Math.floor(Date.now() / 1000) - 500;
      const expiredTx = new StellarSdk.TransactionBuilder(serverAccount, {
        fee: '100',
        networkPassphrase,
        timebounds: { minTime: pastTime - 100, maxTime: pastTime },
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            source: clientKeypair.publicKey(),
            name: `${homeDomain} auth`,
            value: Buffer.from('test-nonce', 'utf-8'),
          })
        )
        .build();

      expiredTx.sign(serverKeypair);
      expiredTx.sign(clientKeypair);

      const xdr = expiredTx.toEnvelope().toXDR('base64');
      expect(() => sep10Service.verifyChallenge(xdr)).toThrow(/expired/);
    });

    it('rejects tampered transaction with non-zero sequence number', () => {
      const clientKeypair = StellarSdk.Keypair.random();
      const serverAccount = new StellarSdk.Account(serverKeypair.publicKey(), '100'); // sequence != 0

      const tx = new StellarSdk.TransactionBuilder(serverAccount, {
        fee: '100',
        networkPassphrase,
        timebounds: {
          minTime: Math.floor(Date.now() / 1000) - 10,
          maxTime: Math.floor(Date.now() / 1000) + 300,
        },
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            source: clientKeypair.publicKey(),
            name: `${homeDomain} auth`,
            value: Buffer.from('test-nonce', 'utf-8'),
          })
        )
        .build();

      tx.sign(serverKeypair);
      tx.sign(clientKeypair);

      const xdr = tx.toEnvelope().toXDR('base64');
      expect(() => sep10Service.verifyChallenge(xdr)).toThrow(/Invalid sequence number/);
    });

    it('rejects tampered transaction where server signature is missing', () => {
      const clientKeypair = StellarSdk.Keypair.random();
      const serverAccount = new StellarSdk.Account(serverKeypair.publicKey(), '-1');

      const tx = new StellarSdk.TransactionBuilder(serverAccount, {
        fee: '100',
        networkPassphrase,
        timebounds: {
          minTime: Math.floor(Date.now() / 1000) - 10,
          maxTime: Math.floor(Date.now() / 1000) + 300,
        },
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            source: clientKeypair.publicKey(),
            name: `${homeDomain} auth`,
            value: Buffer.from('test-nonce', 'utf-8'),
          })
        )
        .build();

      // Only client signs, server did NOT sign
      tx.sign(clientKeypair);

      const xdr = tx.toEnvelope().toXDR('base64');
      expect(() => sep10Service.verifyChallenge(xdr)).toThrow(
        /Challenge transaction was not signed by the server key/
      );
    });
  });

  describe('verifyAndIssueSession', () => {
    it('creates new user and wallet and issues session token for new client', async () => {
      const clientKeypair = StellarSdk.Keypair.random();
      const challenge = sep10Service.generateChallenge(clientKeypair.publicKey());

      const tx = StellarSdk.TransactionBuilder.fromXDR(challenge.transaction, networkPassphrase) as StellarSdk.Transaction;
      tx.sign(clientKeypair);
      const signedXdr = tx.toEnvelope().toXDR('base64');

      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: 'user-new-sep10',
        email: `${clientKeypair.publicKey().substring(0, 12).toLowerCase()}@stellar-alerts.org`,
      });

      const session = await sep10Service.verifyAndIssueSession(signedXdr);

      expect(session).toBeDefined();
      expect(session.token).toBeDefined();
      expect(session.accessToken).toBe(session.token);
      expect(session.user.id).toBe('user-new-sep10');
      expect(session.user.publicKey).toBe(clientKeypair.publicKey());
      expect(mockPrisma.user.create).toHaveBeenCalled();
    });

    it('returns existing user if wallet already registered', async () => {
      const clientKeypair = StellarSdk.Keypair.random();
      const challenge = sep10Service.generateChallenge(clientKeypair.publicKey());

      const tx = StellarSdk.TransactionBuilder.fromXDR(challenge.transaction, networkPassphrase) as StellarSdk.Transaction;
      tx.sign(clientKeypair);
      const signedXdr = tx.toEnvelope().toXDR('base64');

      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'wallet-1',
        publicKey: clientKeypair.publicKey(),
        user: {
          id: 'user-existing',
          email: 'existing@stellar-alerts.org',
        },
      });

      const session = await sep10Service.verifyAndIssueSession(signedXdr);

      expect(session.user.id).toBe('user-existing');
      expect(session.user.email).toBe('existing@stellar-alerts.org');
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });
  });
});
