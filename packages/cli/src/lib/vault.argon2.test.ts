import { describe, it, expect } from 'vitest';
import {
  sealArgon2Vault,
  openArgon2Vault,
  openVault,
  deriveArgon2idKey,
  validateArgon2idParams,
} from './vault.js';
import type { VaultFile, VaultPayload, Argon2idParams } from './profile-types.js';
import { DEFAULT_ARGON2ID_PARAMS, ProfileError } from './profile-types.js';

// Fast parameters for testing roundtrips without burning CPU
const FAST_ARGON2_PARAMS: Argon2idParams = {
  memoryCost: 1024, // 1MB
  timeCost: 1,
  parallelism: 1,
  keyLen: 32,
};

const TEST_PASSWORD = 'test-argon2-password-12345!';
const WRONG_PASSWORD = 'test-wrong-password-99999!';

function samplePayload(): VaultPayload {
  return {
    version: 1,
    secrets: {
      production: {
        apiKey: 'test-api-key-live-1234567890',
        extra: { webhookSecret: 'test-webhook-secret-1234567890' },
      },
      development: {
        apiKey: 'test-api-key-dev-1234567890',
      },
    },
  };
}

describe('Argon2id Vault — sealArgon2Vault & openArgon2Vault', () => {
  it('successfully encrypts and decrypts payload using Argon2id and AES-256-GCM', async () => {
    const payload = samplePayload();
    const vaultFile = await sealArgon2Vault(payload, TEST_PASSWORD, FAST_ARGON2_PARAMS);

    expect(vaultFile.version).toBe(1);
    expect(vaultFile.kdf).toBe('argon2id');
    expect(vaultFile.cipher).toBe('aes-256-gcm');
    expect(vaultFile.salt).toHaveLength(64); // 32 bytes hex
    expect(vaultFile.nonce).toHaveLength(24); // 12 bytes hex
    expect(vaultFile.authTag).toHaveLength(32); // 16 bytes hex

    const decrypted = await openArgon2Vault(vaultFile, TEST_PASSWORD);
    expect(decrypted).toEqual(payload);
  });

  it('openVault detects kdf=argon2id and unlocks correctly', async () => {
    const payload = samplePayload();
    const vaultFile = await sealArgon2Vault(payload, TEST_PASSWORD, FAST_ARGON2_PARAMS);

    const decrypted = await openVault(vaultFile, TEST_PASSWORD);
    expect(decrypted).toEqual(payload);
  });

  it('rejects wrong password with VAULT_WRONG_PASSWORD without revealing payload', async () => {
    const payload = samplePayload();
    const vaultFile = await sealArgon2Vault(payload, TEST_PASSWORD, FAST_ARGON2_PARAMS);

    await expect(openArgon2Vault(vaultFile, WRONG_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
    await expect(openVault(vaultFile, WRONG_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
  });

  it('detects tampered ciphertext', async () => {
    const payload = samplePayload();
    const vaultFile = await sealArgon2Vault(payload, TEST_PASSWORD, FAST_ARGON2_PARAMS);

    const tamperedCiphertext = vaultFile.ciphertext.slice(0, -2) + 'aa';
    const tampered = { ...vaultFile, ciphertext: tamperedCiphertext };

    await expect(openArgon2Vault(tampered, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
  });

  it('detects tampered authTag', async () => {
    const payload = samplePayload();
    const vaultFile = await sealArgon2Vault(payload, TEST_PASSWORD, FAST_ARGON2_PARAMS);

    const tamperedTag = vaultFile.authTag.slice(0, -2) + '00';
    const tampered = { ...vaultFile, authTag: tamperedTag };

    await expect(openArgon2Vault(tampered, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
  });

  it('detects tampered salt', async () => {
    const payload = samplePayload();
    const vaultFile = await sealArgon2Vault(payload, TEST_PASSWORD, FAST_ARGON2_PARAMS);

    const saltBuf = Buffer.from(vaultFile.salt, 'hex');
    saltBuf[0] ^= 0xff;
    const tampered = { ...vaultFile, salt: saltBuf.toString('hex') };

    await expect(openArgon2Vault(tampered, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
  });

  it('validates DEFAULT_ARGON2ID_PARAMS specifications (64MB memoryCost, 3 iterations, 256-bit key)', () => {
    expect(DEFAULT_ARGON2ID_PARAMS.memoryCost).toBe(65536);
    expect(DEFAULT_ARGON2ID_PARAMS.timeCost).toBe(3);
    expect(DEFAULT_ARGON2ID_PARAMS.parallelism).toBe(1);
    expect(DEFAULT_ARGON2ID_PARAMS.keyLen).toBe(32);
    expect(() => validateArgon2idParams(DEFAULT_ARGON2ID_PARAMS)).not.toThrow();
  });

  it('rejects invalid Argon2id parameters', () => {
    expect(() => validateArgon2idParams({ memoryCost: 4, timeCost: 3, parallelism: 1, keyLen: 32 })).toThrow(
      ProfileError
    );
    expect(() => validateArgon2idParams({ memoryCost: 65536, timeCost: 0, parallelism: 1, keyLen: 32 })).toThrow(
      ProfileError
    );
    expect(() => validateArgon2idParams({ memoryCost: 65536, timeCost: 3, parallelism: 1, keyLen: 16 })).toThrow(
      ProfileError
    );
  });

  it('derives consistent 32-byte key from password and salt', async () => {
    const salt = Buffer.alloc(32, 7);
    const key1 = await deriveArgon2idKey('test-pass', salt, FAST_ARGON2_PARAMS);
    const key2 = await deriveArgon2idKey('test-pass', salt, FAST_ARGON2_PARAMS);

    expect(key1).toHaveLength(32);
    expect(key1.equals(key2)).toBe(true);
  });
});
