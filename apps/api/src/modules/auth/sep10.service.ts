import * as StellarSdk from 'stellar-sdk';
import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { generateSessionToken } from '../../utils/jwt';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';

export interface SEP10ChallengeResult {
  transaction: string;
  networkPassphrase: string;
}

export interface SEP10VerificationResult {
  valid: boolean;
  clientPublicKey: string;
}

export interface SEP10AuthSessionResponse {
  token: string;
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    publicKey: string;
  };
}

export class SEP10Service {
  private homeDomain: string;
  private networkPassphrase: string;
  private serverKeypair: StellarSdk.Keypair;

  constructor(
    serverSecret?: string,
    homeDomain?: string,
    networkPassphrase?: string
  ) {
    this.homeDomain = homeDomain || process.env.SEP10_HOME_DOMAIN || 'stellar-alerts.org';
    this.networkPassphrase = networkPassphrase || process.env.STELLAR_NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;

    const secret = serverSecret || process.env.STELLAR_SERVER_SECRET || process.env.STELLAR_SIGNING_KEY;
    if (secret && secret.startsWith('S') && secret.length === 56) {
      this.serverKeypair = StellarSdk.Keypair.fromSecret(secret);
    } else {
      // Deterministic fallback server key derived from JWT_SECRET or default seed
      const seedMaterial = (env.JWT_SECRET || 'stellar_alerts_sep10_default_master_signing_seed_key!').padEnd(32, '0').slice(0, 32);
      const rawSeed = crypto.createHash('sha256').update(seedMaterial).digest();
      this.serverKeypair = StellarSdk.Keypair.fromRawEd25519Seed(rawSeed);
    }
  }

  public getServerPublicKey(): string {
    return this.serverKeypair.publicKey();
  }

  /**
   * Generates a valid SEP-0010 challenge transaction envelope signed by the server.
   * - Sequence number: 0 (represented as Account with sequence "-1")
   * - Source account: serverKeypair.publicKey()
   * - Time bounds: minTime = now - 30s grace, maxTime = now + 300s (5 mins)
   * - Operation: ManageData with source = clientPublicKey, name = `${homeDomain} auth`, value = 64-byte random nonce
   * - Signed by serverKeypair
   */
  public generateChallenge(
    clientPublicKey: string,
    timeoutSeconds = 300
  ): SEP10ChallengeResult {
    if (!clientPublicKey || !isValidEd25519PublicKey(clientPublicKey)) {
      throw new Error(`Invalid client Stellar public key: ${clientPublicKey}`);
    }

    const now = Math.floor(Date.now() / 1000);
    const minTime = Math.max(0, now - 30); // 30s grace for clock skew
    const maxTime = now + timeoutSeconds;

    // Sequence -1 produces sequence number 0 in the built transaction envelope
    const serverAccount = new StellarSdk.Account(this.serverKeypair.publicKey(), '-1');

    // Generate random 64-byte cryptographic nonce for value
    const nonce = crypto.randomBytes(48).toString('base64'); // base64 string <= 64 bytes

    const tx = new StellarSdk.TransactionBuilder(serverAccount, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
      timebounds: { minTime, maxTime },
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          source: clientPublicKey,
          name: `${this.homeDomain} auth`,
          value: Buffer.from(nonce, 'utf-8'),
        })
      )
      .build();

    // Server signs first
    tx.sign(this.serverKeypair);

    return {
      transaction: tx.toEnvelope().toXDR('base64'),
      networkPassphrase: this.networkPassphrase,
    };
  }

  /**
   * Validates client signature against challenge transaction envelope with strict
   * sequence number, time bounds, server signature, and client signature checks.
   */
  public verifyChallenge(transactionXdr: string): SEP10VerificationResult {
    if (!transactionXdr || typeof transactionXdr !== 'string') {
      throw new Error('Missing or invalid challenge transaction envelope XDR');
    }

    let tx: StellarSdk.Transaction;
    try {
      const parsed = StellarSdk.TransactionBuilder.fromXDR(transactionXdr, this.networkPassphrase);
      if (!(parsed instanceof StellarSdk.Transaction)) {
        throw new Error('Expected standard Transaction, received FeeBumpTransaction');
      }
      tx = parsed;
    } catch (err: any) {
      throw new Error(`Failed to decode transaction XDR: ${err.message}`);
    }

    // 1. Strict sequence number check: must be 0
    if (tx.sequence !== '0') {
      throw new Error(`Invalid sequence number: expected "0", got "${tx.sequence}"`);
    }

    // 2. Source account must match server public key
    if (tx.source !== this.serverKeypair.publicKey()) {
      throw new Error(`Invalid transaction source account: expected server key "${this.serverKeypair.publicKey()}", got "${tx.source}"`);
    }

    // 3. Strict time bounds check
    const now = Math.floor(Date.now() / 1000);
    if (!tx.timeBounds) {
      throw new Error('Transaction is missing time bounds');
    }
    const minTime = Number(tx.timeBounds.minTime);
    const maxTime = Number(tx.timeBounds.maxTime);
    if (now < minTime) {
      throw new Error(`Challenge transaction is not yet active (current: ${now}, min: ${minTime})`);
    }
    if (now > maxTime) {
      throw new Error(`Challenge transaction has expired (current: ${now}, max: ${maxTime})`);
    }

    // 4. Validate operations: must have at least 1 operation, which is ManageData
    if (!tx.operations || tx.operations.length === 0) {
      throw new Error('Challenge transaction has no operations');
    }

    const firstOp = tx.operations[0];
    if (firstOp.type !== 'manageData') {
      throw new Error(`Invalid first operation type: expected "manageData", got "${firstOp.type}"`);
    }

    const clientPublicKey = firstOp.source;
    if (!clientPublicKey || !isValidEd25519PublicKey(clientPublicKey)) {
      throw new Error('Invalid or missing client public key in challenge manageData operation source');
    }

    if (firstOp.name !== `${this.homeDomain} auth`) {
      throw new Error(`Invalid manageData operation key: expected "${this.homeDomain} auth", got "${firstOp.name}"`);
    }

    // 5. Verify server signature
    const txHash = tx.hash();
    const serverKey = this.serverKeypair;
    const hasServerSignature = tx.signatures.some((sig) => {
      try {
        return serverKey.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    if (!hasServerSignature) {
      throw new Error('Challenge transaction was not signed by the server key');
    }

    // 6. Verify client signature
    const clientKeypair = StellarSdk.Keypair.fromPublicKey(clientPublicKey);
    const hasClientSignature = tx.signatures.some((sig) => {
      try {
        return clientKeypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    if (!hasClientSignature) {
      throw new Error(`Challenge transaction is missing a valid signature from client "${clientPublicKey}"`);
    }

    return {
      valid: true,
      clientPublicKey,
    };
  }

  /**
   * Verifies challenge transaction, upserts the user & wallet, and issues JWT session tokens.
   */
  public async verifyAndIssueSession(transactionXdr: string): Promise<SEP10AuthSessionResponse> {
    const { clientPublicKey } = this.verifyChallenge(transactionXdr);

    // Find or create wallet and linked user
    let wallet = await prisma.wallet.findUnique({
      where: { publicKey: clientPublicKey },
      include: { user: true },
    });

    let userId: string;
    let email: string;

    if (wallet && wallet.user) {
      userId = wallet.user.id;
      email = wallet.user.email;
    } else {
      // Find existing user with placeholder email or create new user
      const placeholderEmail = `${clientPublicKey.substring(0, 12).toLowerCase()}@stellar-alerts.org`;
      const user = await prisma.user.create({
        data: {
          email: placeholderEmail,
          wallets: {
            create: {
              publicKey: clientPublicKey,
            },
          },
        },
      });
      userId = user.id;
      email = user.email;
    }

    const token = generateSessionToken({ id: userId, email });

    return {
      token,
      accessToken: token,
      refreshToken: token,
      user: {
        id: userId,
        email,
        publicKey: clientPublicKey,
      },
    };
  }
}

export const sep10Service = new SEP10Service();
