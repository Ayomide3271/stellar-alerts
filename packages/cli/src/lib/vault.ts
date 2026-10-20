/**
 * Encrypted vault module for the Stellar Alerts CLI.
 *
 * Security design:
 *  - Key derivation: scrypt (N=131072, r=8, p=1, keyLen=32) — built into Node.js
 *    crypto, memory-hard, no extra dependency.
 *  - Cipher: AES-256-GCM — authenticated encryption that detects tampering and
 *    corruption via the auth tag.
 *  - A cryptographically random 32-byte salt and 12-byte nonce are generated for
 *    each seal() call, so two encryptions of the same data with the same password
 *    produce different ciphertexts.
 *  - The plaintext password is never persisted, logged, or included in errors.
 *  - Incorrect passwords or tampered ciphertext are rejected with a clear error.
 */

import {
  randomBytes,
  scrypt,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { promisify } from 'node:util';
import {
  VaultFile,
  VaultPayload,
  ScryptParams,
  Argon2idParams,
  DEFAULT_SCRYPT_PARAMS,
  DEFAULT_ARGON2ID_PARAMS,
  ProfileError,
} from './profile-types.js';
import {
  sealArgon2Vault,
  openArgon2Vault,
  deriveArgon2idKey,
  validateArgon2idParams,
} from './vault/argon2-vault.js';

export { sealArgon2Vault, openArgon2Vault, deriveArgon2idKey, validateArgon2idParams };

const scryptAsync = promisify<
  Buffer | string,
  Buffer | string,
  number,
  {
    N: number;
    r: number;
    p: number;
    maxmem: number;
  },
  Buffer
>(scrypt as any);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const VAULT_VERSION = 1 as const;
const PAYLOAD_VERSION = 1 as const;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Derives a 256-bit encryption key from `password` using scrypt with `params`.
 * A unique `salt` must be provided per vault file.
 */
async function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  // maxmem guard: 128 * N * r * p bytes (add 10% headroom)
  const maxmem = Math.ceil(128 * params.N * params.r * params.p * 1.1);

  return scryptAsync(password, salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  });
}

function validateKdfParams(params: unknown): asserts params is ScryptParams {
  if (
    typeof params !== 'object' ||
    params === null ||
    typeof (params as any).N !== 'number' ||
    typeof (params as any).r !== 'number' ||
    typeof (params as any).p !== 'number' ||
    typeof (params as any).keyLen !== 'number'
  ) {
    throw new ProfileError(
      'VAULT_INVALID_KDF_PARAMS',
      'Vault contains invalid KDF parameters. The vault file may be corrupt.',
    );
  }

  const { N, r, p, keyLen } = params as ScryptParams;

  // Safety: prevent unreasonably small or large values
  if (N < 1024 || (N & (N - 1)) !== 0) {
    throw new ProfileError(
      'VAULT_INVALID_KDF_PARAMS',
      'Vault KDF parameter N is invalid (must be a power of 2 ≥ 1024).',
    );
  }
  if (r < 1 || r > 256) {
    throw new ProfileError(
      'VAULT_INVALID_KDF_PARAMS',
      'Vault KDF parameter r is invalid (must be 1–256).',
    );
  }
  if (p < 1 || p > 128) {
    throw new ProfileError(
      'VAULT_INVALID_KDF_PARAMS',
      'Vault KDF parameter p is invalid (must be 1–128).',
    );
  }
  if (keyLen !== 32) {
    throw new ProfileError(
      'VAULT_INVALID_KDF_PARAMS',
      'Vault KDF keyLen must be 32 (AES-256 requires a 256-bit key).',
    );
  }
}

function validateHex(value: unknown, fieldName: string, expectedBytes: number): Buffer {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value)) {
    throw new ProfileError(
      'VAULT_INVALID_METADATA',
      `Vault field '${fieldName}' must be a hex string. The vault file may be corrupt.`,
    );
  }
  const buf = Buffer.from(value, 'hex');
  if (buf.length !== expectedBytes) {
    throw new ProfileError(
      'VAULT_INVALID_METADATA',
      `Vault field '${fieldName}' has unexpected length ${buf.length} (expected ${expectedBytes} bytes).`,
    );
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypts `payload` with `password` and returns a serializable `VaultFile`.
 *
 * A fresh random salt and nonce are generated on each call.
 */
export async function sealVault(
  payload: VaultPayload,
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<VaultFile> {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);

  const key = await deriveKey(password, salt, params);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Zero out the key buffer — best-effort in JS (GC may keep copies)
  key.fill(0);

  return {
    version: VAULT_VERSION,
    kdf: 'scrypt',
    kdfParams: { ...params },
    salt: salt.toString('hex'),
    cipher: 'aes-256-gcm',
    nonce: nonce.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Decrypts `vaultFile` with `password` and returns the plaintext `VaultPayload`.
 *
 * Throws `ProfileError` for:
 *  - Unsupported vault version
 *  - Invalid/corrupt metadata
 *  - Invalid KDF parameters
 *  - Wrong password or tampered ciphertext (GCM auth tag failure)
 */
export async function openVault(
  vaultFile: VaultFile,
  password: string,
): Promise<VaultPayload> {
  // Version guard
  if (vaultFile.version !== 1) {
    throw new ProfileError(
      'VAULT_UNSUPPORTED_VERSION',
      `Unsupported vault format version: ${vaultFile.version}. ` +
        'Please upgrade the Stellar Alerts CLI.',
    );
  }

  if (vaultFile.kdf === 'argon2id') {
    return openArgon2Vault(vaultFile, password);
  }

  if (vaultFile.kdf !== 'scrypt') {
    throw new ProfileError(
      'VAULT_INVALID_METADATA',
      `Unsupported KDF algorithm: '${vaultFile.kdf}'. Only 'argon2id' and 'scrypt' are supported.`,
    );
  }

  if (vaultFile.cipher !== 'aes-256-gcm') {
    throw new ProfileError(
      'VAULT_INVALID_METADATA',
      `Unsupported cipher: '${vaultFile.cipher}'. Only 'aes-256-gcm' is supported.`,
    );
  }

  validateKdfParams(vaultFile.kdfParams);

  const salt = validateHex(vaultFile.salt, 'salt', SALT_BYTES);
  const nonce = validateHex(vaultFile.nonce, 'nonce', NONCE_BYTES);
  const authTag = validateHex(vaultFile.authTag, 'authTag', AUTH_TAG_BYTES);

  if (typeof vaultFile.ciphertext !== 'string' || !/^[0-9a-f]*$/i.test(vaultFile.ciphertext)) {
    throw new ProfileError(
      'VAULT_INVALID_METADATA',
      "Vault field 'ciphertext' must be a hex string.",
    );
  }
  const ciphertext = Buffer.from(vaultFile.ciphertext, 'hex');

  const key = await deriveKey(password, salt, vaultFile.kdfParams);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Key zero-out before re-throwing
    key.fill(0);
    throw new ProfileError(
      'VAULT_WRONG_PASSWORD',
      'Vault could not be unlocked. The password is incorrect or the vault is corrupted.',
    );
  }

  key.fill(0);

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new ProfileError(
      'VAULT_CORRUPTED',
      'Vault decrypted successfully but the payload is not valid JSON. The vault file may be corrupt.',
    );
  }

  // Basic shape validation
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as any).version !== PAYLOAD_VERSION ||
    typeof (parsed as any).secrets !== 'object'
  ) {
    throw new ProfileError(
      'VAULT_CORRUPTED',
      'Vault payload has an unexpected structure. The vault file may be corrupt.',
    );
  }

  return parsed as VaultPayload;
}

/**
 * Parses a raw JSON string into a `VaultFile`, validating the top-level structure.
 * Does NOT decrypt or verify the ciphertext.
 */
export function parseVaultFile(raw: string): VaultFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProfileError('VAULT_CORRUPTED', 'Vault file is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProfileError('VAULT_CORRUPTED', 'Vault file has an unexpected format.');
  }

  const obj = parsed as Record<string, unknown>;

  if (obj['version'] !== 1) {
    if (typeof obj['version'] === 'number') {
      throw new ProfileError(
        'VAULT_UNSUPPORTED_VERSION',
        `Unsupported vault format version: ${obj['version']}. Please upgrade the Stellar Alerts CLI.`,
      );
    }
    throw new ProfileError('VAULT_CORRUPTED', "Vault file is missing the 'version' field.");
  }

  // Return the parsed object; full validation happens in openVault
  return parsed as VaultFile;
}

/**
 * Creates a fresh empty `VaultPayload` (no secrets).
 */
export function emptyVaultPayload(): VaultPayload {
  return { version: PAYLOAD_VERSION, secrets: {} };
}
