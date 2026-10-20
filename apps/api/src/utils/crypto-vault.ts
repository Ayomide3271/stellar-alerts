import crypto from 'crypto';

const SEPARATOR = ':';

export interface EncryptedSecretParts {
  version: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class CryptoVault {
  private currentKey: Buffer;
  private currentVersion: string;
  private keys: Map<string, Buffer>;

  constructor(
    currentKey: string,
    currentVersion: string = '1',
    oldKeys: Record<string, string> = {}
  ) {
    this.currentVersion = currentVersion;
    this.currentKey = this.deriveKey(currentKey);
    this.keys = new Map([[currentVersion, this.currentKey]]);

    for (const [version, key] of Object.entries(oldKeys)) {
      this.keys.set(version, this.deriveKey(key));
    }
  }

  private deriveKey(key: string): Buffer {
    // Ensure consistent 32-byte key for AES-256-GCM
    const safeKey = key || 'default_master_encryption_key_32bytes_long!';
    return crypto.createHash('sha256').update(safeKey).digest();
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.currentKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      this.currentVersion,
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(SEPARATOR);
  }

  decrypt(encrypted: string): string {
    const parts = encrypted.split(SEPARATOR);
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted secret format');
    }

    const [version, iv, authTag, ciphertext] = parts;
    const key = this.keys.get(version);

    if (!key) {
      throw new Error(`Unknown encryption key version: ${version}`);
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  encryptParts(plaintext: string): EncryptedSecretParts {
    const encrypted = this.encrypt(plaintext);
    const [version, iv, authTag, ciphertext] = encrypted.split(SEPARATOR);
    return { version, iv, authTag, ciphertext };
  }

  decryptParts(
    parts:
      | EncryptedSecretParts
      | WebhookSecretParts
      | {
          keyVersion?: string | number;
          version?: string | number;
          secretIv?: string;
          iv?: string;
          secretAuthTag?: string;
          authTag?: string;
          secretCiphertext?: string;
          ciphertext?: string;
        }
  ): string {
    const version = String((parts as any).version ?? (parts as any).keyVersion ?? '');
    const iv = (parts as any).iv ?? (parts as any).secretIv ?? '';
    const authTag = (parts as any).authTag ?? (parts as any).secretAuthTag ?? '';
    const ciphertext = (parts as any).ciphertext ?? (parts as any).secretCiphertext ?? '';
    return this.decrypt([version, iv, authTag, ciphertext].join(SEPARATOR));
  }

  reencrypt(
    encrypted:
      | string
      | EncryptedSecretParts
      | WebhookSecretParts
      | Record<string, any>
  ): string {
    const plaintext = typeof encrypted === 'string' ? this.decrypt(encrypted) : this.decryptParts(encrypted);
    return this.encrypt(plaintext);
  }

  reencryptParts(
    encrypted:
      | string
      | EncryptedSecretParts
      | WebhookSecretParts
      | Record<string, any>
  ): EncryptedSecretParts {
    return this.encryptParts(
      typeof encrypted === 'string' ? this.decrypt(encrypted) : this.decryptParts(encrypted)
    );
  }
}

const oldKeys = process.env.MASTER_ENCRYPTION_OLD_KEYS
  ? JSON.parse(process.env.MASTER_ENCRYPTION_OLD_KEYS)
  : {};

export const cryptoVault = new CryptoVault(
  process.env.MASTER_ENCRYPTION_KEY!,
  process.env.MASTER_ENCRYPTION_KEY_VERSION ?? '1',
  oldKeys
);

export interface WebhookSecretParts {
  secretCiphertext: string;
  secretIv: string;
  secretAuthTag: string;
  keyVersion: number;
}

/** Combines split DB secret fields into the `version:iv:authTag:ciphertext` format CryptoVault expects. */
export function joinEncryptedSecretParts(parts: WebhookSecretParts): string {
  return [String(parts.keyVersion), parts.secretIv, parts.secretAuthTag, parts.secretCiphertext].join(SEPARATOR);
}

/** Splits a CryptoVault-encrypted string into the DB's separate secret fields. */
export function splitEncryptedSecret(encrypted: string): WebhookSecretParts {
  const [version, iv, authTag, ciphertext] = encrypted.split(SEPARATOR);
  return { secretCiphertext: ciphertext, secretIv: iv, secretAuthTag: authTag, keyVersion: Number(version) };
}

/** Decrypts a webhook secret from its combined encrypted string form. */
export function decryptSecret(encrypted: string): string {
  return cryptoVault.decrypt(encrypted);
}

/** Re-encrypts a webhook record with the latest master encryption key. */
export function reencryptWebhookSecret(parts: WebhookSecretParts): WebhookSecretParts {
  const partsEncrypted = cryptoVault.reencryptParts(parts);
  return {
    secretCiphertext: partsEncrypted.ciphertext,
    secretIv: partsEncrypted.iv,
    secretAuthTag: partsEncrypted.authTag,
    keyVersion: Number(partsEncrypted.version),
  };
}
