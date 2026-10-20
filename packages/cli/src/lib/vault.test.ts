/**
 * Comprehensive tests for the encrypted vault module.
 *
 * Coverage:
 *  - sealVault / openVault round-trip
 *  - Correct password decryption
 *  - Incorrect password rejection
 *  - Tampered ciphertext detection
 *  - Tampered auth tag detection
 *  - Corrupted / truncated vault
 *  - Unsupported vault version
 *  - Invalid/missing metadata fields
 *  - Invalid KDF parameters
 *  - Plaintext secret NOT in sealed vault
 *  - Random salts/nonces per seal
 *  - Multiple profiles in one vault
 *  - parseVaultFile validation
 *  - emptyVaultPayload
 */

import { describe, it, expect } from 'vitest';
import {
  sealVault,
  openVault,
  parseVaultFile,
  emptyVaultPayload,
} from './vault.js';
import type { VaultFile, VaultPayload } from './profile-types.js';
import { ProfileError } from './profile-types.js';
import { DEFAULT_SCRYPT_PARAMS } from './profile-types.js';

// Use very low scrypt parameters for test speed (still valid for testing correctness)
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLen: 32 };

const TEST_PASSWORD = 'test-vault-password-123!';
const WRONG_PASSWORD = 'wrong-password-xyz-999!';

function makePayload(overrides: Partial<VaultPayload> = {}): VaultPayload {
  return {
    version: 1,
    secrets: {
      testnet: { apiKey: 'sk_testnet_secret_abc123' },
      mainnet: { apiKey: 'sk_mainnet_secret_xyz789' },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sealVault / openVault round-trip
// ---------------------------------------------------------------------------

describe('vault – sealVault / openVault round-trip', () => {
  it('encrypts and decrypts a payload successfully', async () => {
    const payload = makePayload();
    const sealed = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    const decrypted = await openVault(sealed, TEST_PASSWORD);
    expect(decrypted).toEqual(payload);
  });

  it('preserves all secret fields after round-trip', async () => {
    const payload: VaultPayload = {
      version: 1,
      secrets: {
        staging: {
          apiKey: 'sk_staging_key',
          extra: { webhookSecret: 'wh_secret_value', customToken: 'ct_value' },
        },
      },
    };
    const sealed = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    const decrypted = await openVault(sealed, TEST_PASSWORD);
    expect(decrypted.secrets['staging']?.apiKey).toBe('sk_staging_key');
    expect(decrypted.secrets['staging']?.extra?.['webhookSecret']).toBe('wh_secret_value');
    expect(decrypted.secrets['staging']?.extra?.['customToken']).toBe('ct_value');
  });

  it('encrypts an empty vault payload', async () => {
    const payload = emptyVaultPayload();
    const sealed = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    const decrypted = await openVault(sealed, TEST_PASSWORD);
    expect(decrypted.secrets).toEqual({});
    expect(decrypted.version).toBe(1);
  });

  it('preserves version=1 in sealed vault file', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    expect(sealed.version).toBe(1);
    expect(sealed.kdf).toBe('scrypt');
    expect(sealed.cipher).toBe('aes-256-gcm');
  });
});

// ---------------------------------------------------------------------------
// Password correctness and rejection
// ---------------------------------------------------------------------------

describe('vault – password handling', () => {
  it('rejects an incorrect password with VAULT_WRONG_PASSWORD', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    await expect(openVault(sealed, WRONG_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
  });

  it('rejects an empty password if it was not used to seal', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    await expect(openVault(sealed, '')).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
  });

  it('decrypts correctly with the exact password used to seal', async () => {
    const password = 'c0mp!ex-P@ssw0rd-with-symbols-#42';
    const payload = makePayload();
    const sealed = await sealVault(payload, password, FAST_PARAMS);
    const decrypted = await openVault(sealed, password);
    expect(decrypted).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Security: plaintext secrets are NOT in the vault file
// ---------------------------------------------------------------------------

describe('vault – security: secrets not in ciphertext', () => {
  it('does not expose the secret value in the vault JSON', async () => {
    const secret = 'sk_super_secret_api_key_12345';
    const payload: VaultPayload = { version: 1, secrets: { prod: { apiKey: secret } } };
    const sealed = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain(secret);
  });

  it('does not expose the password in the vault JSON', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain(TEST_PASSWORD);
  });

  it('does not expose plaintext profile keys in the vault JSON', async () => {
    const payload = makePayload();
    const sealed = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    const serialized = JSON.stringify(sealed);
    // The profile names exist only in the encrypted ciphertext, not raw
    expect(serialized).not.toContain('sk_testnet_secret_abc123');
    expect(serialized).not.toContain('sk_mainnet_secret_xyz789');
  });
});

// ---------------------------------------------------------------------------
// Security: random salt/nonce per seal
// ---------------------------------------------------------------------------

describe('vault – randomness', () => {
  it('generates different salts on each seal call', async () => {
    const payload = makePayload();
    const sealed1 = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    const sealed2 = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    expect(sealed1.salt).not.toBe(sealed2.salt);
  });

  it('generates different nonces on each seal call', async () => {
    const payload = makePayload();
    const sealed1 = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    const sealed2 = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    expect(sealed1.nonce).not.toBe(sealed2.nonce);
  });

  it('generates different ciphertexts on each seal call (same payload, same password)', async () => {
    const payload = makePayload();
    const sealed1 = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    const sealed2 = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    expect(sealed1.ciphertext).not.toBe(sealed2.ciphertext);
  });
});

// ---------------------------------------------------------------------------
// Tamper detection
// ---------------------------------------------------------------------------

describe('vault – tamper detection', () => {
  it('detects single-byte ciphertext modification', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const tamperedCiphertext = sealed.ciphertext.slice(0, -2) + '00';
    const tampered: VaultFile = { ...sealed, ciphertext: tamperedCiphertext };
    await expect(openVault(tampered, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
  });

  it('detects auth tag modification', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const tamperedTag = sealed.authTag.slice(0, -2) + '00';
    const tampered: VaultFile = { ...sealed, authTag: tamperedTag };
    await expect(openVault(tampered, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
  });

  it('detects salt modification (causes key derivation with wrong key)', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    // Change a byte in the salt → different derived key → auth failure
    const saltBuf = Buffer.from(sealed.salt, 'hex');
    saltBuf[0] ^= 0xff;
    const tampered: VaultFile = { ...sealed, salt: saltBuf.toString('hex') };
    await expect(openVault(tampered, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
  });

  it('detects nonce modification', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const nonceBuf = Buffer.from(sealed.nonce, 'hex');
    nonceBuf[0] ^= 0x01;
    const tampered: VaultFile = { ...sealed, nonce: nonceBuf.toString('hex') };
    await expect(openVault(tampered, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_WRONG_PASSWORD',
    });
  });
});

// ---------------------------------------------------------------------------
// Invalid vault metadata
// ---------------------------------------------------------------------------

describe('vault – invalid metadata validation', () => {
  it('rejects unsupported vault version', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad = { ...sealed, version: 99 as any };
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_UNSUPPORTED_VERSION',
    });
  });

  it('rejects unknown KDF algorithm', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad: any = { ...sealed, kdf: 'pbkdf2' };
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_INVALID_METADATA',
    });
  });

  it('rejects unknown cipher algorithm', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad: any = { ...sealed, cipher: 'chacha20-poly1305' };
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_INVALID_METADATA',
    });
  });

  it('rejects short salt (wrong byte length)', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad: VaultFile = { ...sealed, salt: 'deadbeef' }; // 4 bytes, not 32
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_INVALID_METADATA',
    });
  });

  it('rejects short nonce (wrong byte length)', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad: VaultFile = { ...sealed, nonce: 'deadbeef' }; // 4 bytes, not 12
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_INVALID_METADATA',
    });
  });

  it('rejects non-hex salt', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad: VaultFile = { ...sealed, salt: 'not-hex-!@#$' };
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_INVALID_METADATA',
    });
  });

  it('rejects non-hex ciphertext', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad: any = { ...sealed, ciphertext: 'not-hex-content-!@#' };
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_INVALID_METADATA',
    });
  });
});

// ---------------------------------------------------------------------------
// Invalid KDF parameters
// ---------------------------------------------------------------------------

describe('vault – invalid KDF parameters', () => {
  it('rejects N that is not a power of 2', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad: VaultFile = { ...sealed, kdfParams: { N: 1025, r: 8, p: 1, keyLen: 32 } };
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_INVALID_KDF_PARAMS',
    });
  });

  it('rejects N that is too small', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad: VaultFile = { ...sealed, kdfParams: { N: 256, r: 8, p: 1, keyLen: 32 } };
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_INVALID_KDF_PARAMS',
    });
  });

  it('rejects keyLen that is not 32', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad: VaultFile = { ...sealed, kdfParams: { N: 1024, r: 8, p: 1, keyLen: 16 } };
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_INVALID_KDF_PARAMS',
    });
  });

  it('rejects non-object kdfParams', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const bad: any = { ...sealed, kdfParams: null };
    await expect(openVault(bad, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_INVALID_KDF_PARAMS',
    });
  });
});

// ---------------------------------------------------------------------------
// parseVaultFile
// ---------------------------------------------------------------------------

describe('vault – parseVaultFile', () => {
  it('parses a valid serialized VaultFile', async () => {
    const sealed = await sealVault(makePayload(), TEST_PASSWORD, FAST_PARAMS);
    const json = JSON.stringify(sealed);
    const parsed = parseVaultFile(json);
    expect(parsed.version).toBe(1);
    expect(parsed.kdf).toBe('scrypt');
  });

  it('throws VAULT_CORRUPTED on non-JSON input', () => {
    expect(() => parseVaultFile('not json at all {{{')).toThrow(
      expect.objectContaining({ code: 'VAULT_CORRUPTED' }),
    );
  });

  it('throws VAULT_CORRUPTED on JSON null', () => {
    expect(() => parseVaultFile('null')).toThrow(
      expect.objectContaining({ code: 'VAULT_CORRUPTED' }),
    );
  });

  it('throws VAULT_UNSUPPORTED_VERSION on numeric unknown version', () => {
    const json = JSON.stringify({ version: 999, kdf: 'scrypt' });
    expect(() => parseVaultFile(json)).toThrow(
      expect.objectContaining({ code: 'VAULT_UNSUPPORTED_VERSION' }),
    );
  });

  it('throws VAULT_CORRUPTED on missing version field', () => {
    const json = JSON.stringify({ kdf: 'scrypt' });
    expect(() => parseVaultFile(json)).toThrow(
      expect.objectContaining({ code: 'VAULT_CORRUPTED' }),
    );
  });
});

// ---------------------------------------------------------------------------
// emptyVaultPayload
// ---------------------------------------------------------------------------

describe('vault – emptyVaultPayload', () => {
  it('returns a payload with version 1 and no secrets', () => {
    const payload = emptyVaultPayload();
    expect(payload.version).toBe(1);
    expect(payload.secrets).toEqual({});
  });

  it('can be sealed and re-opened', async () => {
    const payload = emptyVaultPayload();
    const sealed = await sealVault(payload, TEST_PASSWORD, FAST_PARAMS);
    const decrypted = await openVault(sealed, TEST_PASSWORD);
    expect(decrypted).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SCRYPT_PARAMS sanity checks
// ---------------------------------------------------------------------------

describe('vault – DEFAULT_SCRYPT_PARAMS', () => {
  it('has N = 131072 (2^17)', () => {
    expect(DEFAULT_SCRYPT_PARAMS.N).toBe(131072);
  });

  it('has keyLen = 32 (256-bit key for AES-256)', () => {
    expect(DEFAULT_SCRYPT_PARAMS.keyLen).toBe(32);
  });
});
