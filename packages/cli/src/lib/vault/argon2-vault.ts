/**
 * Argon2id Key Derivation & AES-256-GCM Vault for CLI Profile Secrets.
 *
 * Implements memory-hard key derivation using Argon2id with AES-256-GCM
 * authenticated encryption, providing high resistance to GPU/ASIC brute-force
 * attacks on profile credentials and API tokens.
 */

import { argon2id } from '@noble/hashes/argon2';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  VaultFile,
  VaultPayload,
  Argon2idParams,
  DEFAULT_ARGON2ID_PARAMS,
  ProfileError,
} from '../profile-types.js';

const VAULT_VERSION = 1 as const;
const PAYLOAD_VERSION = 1 as const;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Validates Argon2id KDF parameters.
 */
export function validateArgon2idParams(params: unknown): asserts params is Argon2idParams {
  if (
    typeof params !== 'object' ||
    params === null ||
    typeof (params as any).memoryCost !== 'number' ||
    typeof (params as any).timeCost !== 'number' ||
    typeof (params as any).parallelism !== 'number' ||
    typeof (params as any).keyLen !== 'number'
  ) {
    throw new ProfileError(
      'VAULT_INVALID_KDF_PARAMS',
      'Vault contains invalid Argon2id KDF parameters. The vault file may be corrupt.',
    );
  }

  const { memoryCost, timeCost, parallelism, keyLen } = params as Argon2idParams;

  if (memoryCost < 8) {
    throw new ProfileError(
      'VAULT_INVALID_KDF_PARAMS',
      'Argon2id parameter memoryCost is invalid (must be ≥ 8 KB).',
    );
  }
  if (timeCost < 1 || timeCost > 1000) {
    throw new ProfileError(
      'VAULT_INVALID_KDF_PARAMS',
      'Argon2id parameter timeCost is invalid (must be 1–1000).',
    );
  }
  if (parallelism < 1 || parallelism > 64) {
    throw new ProfileError(
      'VAULT_INVALID_KDF_PARAMS',
      'Argon2id parameter parallelism is invalid (must be 1–64).',
    );
  }
  if (keyLen !== 32) {
    throw new ProfileError(
      'VAULT_INVALID_KDF_PARAMS',
      'Vault KDF keyLen must be 32 (AES-256 requires a 256-bit key).',
    );
  }
}

/**
 * Derives a 256-bit key using Argon2id with memory-hard parameters.
 */
export async function deriveArgon2idKey(
  password: string,
  salt: Buffer,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
): Promise<Buffer> {
  const derived = argon2id(password, salt, {
    m: params.memoryCost,
    t: params.timeCost,
    p: params.parallelism,
    dkLen: params.keyLen,
  });

  return Buffer.from(derived.buffer, derived.byteOffset, derived.byteLength);
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

/**
 * Encrypts and authenticates profile secret store using Argon2id + AES-256-GCM.
 */
export async function sealArgon2Vault(
  payload: VaultPayload,
  password: string,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
): Promise<VaultFile> {
  validateArgon2idParams(params);

  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);

  const key = await deriveArgon2idKey(password, salt, params);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  key.fill(0);

  return {
    version: VAULT_VERSION,
    kdf: 'argon2id',
    kdfParams: { ...params },
    salt: salt.toString('hex'),
    cipher: 'aes-256-gcm',
    nonce: nonce.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Decrypts and authenticates an Argon2id vault file using AES-256-GCM.
 */
export async function openArgon2Vault(
  vaultFile: VaultFile,
  password: string,
): Promise<VaultPayload> {
  if (vaultFile.version !== 1) {
    throw new ProfileError(
      'VAULT_UNSUPPORTED_VERSION',
      `Unsupported vault format version: ${vaultFile.version}. Please upgrade the Stellar Alerts CLI.`,
    );
  }

  if (vaultFile.kdf !== 'argon2id') {
    throw new ProfileError(
      'VAULT_INVALID_METADATA',
      `Unsupported KDF algorithm: '${vaultFile.kdf}'. Expected 'argon2id'.`,
    );
  }

  if (vaultFile.cipher !== 'aes-256-gcm') {
    throw new ProfileError(
      'VAULT_INVALID_METADATA',
      `Unsupported cipher: '${vaultFile.cipher}'. Only 'aes-256-gcm' is supported.`,
    );
  }

  validateArgon2idParams(vaultFile.kdfParams);

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

  const key = await deriveArgon2idKey(password, salt, vaultFile.kdfParams as Argon2idParams);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
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
