import { CryptoVault } from '../crypto-vault';

describe('CryptoVault', () => {
  const key = 'test-master-key-32-characters-minimum';
  const vault = new CryptoVault(key, '1');

  it('should encrypt and decrypt a secret', () => {
    const original = 'mySecret123';
    const encrypted = vault.encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(vault.decrypt(encrypted)).toBe(original);
  });

  it('should produce unique ciphertext for the same plaintext (random IV)', () => {
    const original = 'secret';
    const first = vault.encrypt(original);
    const second = vault.encrypt(original);
    expect(first).not.toBe(second);
  });

  it('should reject tampered ciphertext', () => {
    const encrypted = vault.encrypt('secret');
    const parts = encrypted.split(':');
    // Corrupt the ciphertext portion (base64 for "tampered")
    parts[3] = 'dGFwcW9udQ=';
    const tampered = parts.join(':');
    expect(() => vault.decrypt(tampered)).toThrow();
  });

  it('should decrypt data encrypted with an older key version (rotation)', () => {
    const oldVault = new CryptoVault('old-master-key-32-characters-minimum', '1');
    const newVault = new CryptoVault('new-master-key-32-characters-minimum', '2', {
      '1': 'old-master-key-32-characters-minimum',
    });

    const oldEncrypted = oldVault.encrypt('legacy-secret');
    expect(newVault.decrypt(oldEncrypted)).toBe('legacy-secret');
  });

  it('should throw on unknown key version', () => {
    const vaultWithNoOldKeys = new CryptoVault('new-key', '2');
    const oldEncrypted = new CryptoVault('old-key', '1').encrypt('data');
    expect(() => vaultWithNoOldKeys.decrypt(oldEncrypted)).toThrow('Unknown encryption key version: 1');
  });

  it('should encrypt and decrypt using structured parts matching DB schema columns', () => {
    const original = 'whsec_secret_key_db_column_value';
    const parts = vault.encryptParts(original);

    expect(parts.version).toBe('1');
    expect(parts.iv).toBeTruthy();
    expect(parts.authTag).toBeTruthy();
    expect(parts.ciphertext).toBeTruthy();

    expect(vault.decryptParts(parts)).toBe(original);
    expect(
      vault.decryptParts({
        keyVersion: parts.version,
        secretIv: parts.iv,
        secretAuthTag: parts.authTag,
        secretCiphertext: parts.ciphertext,
      })
    ).toBe(original);
  });

  it('should re-encrypt secrets from older key versions to current active key version', () => {
    const oldVault = new CryptoVault('legacy-master-key-32-chars-long!', '1');
    const rotatedVault = new CryptoVault('next-gen-master-key-32-chars-long!', '2', {
      '1': 'legacy-master-key-32-chars-long!',
    });

    const oldSecret = oldVault.encrypt('webhook_key_to_rotate');
    const reencrypted = rotatedVault.reencrypt(oldSecret);

    expect(reencrypted.startsWith('2:')).toBe(true);
    expect(rotatedVault.decrypt(reencrypted)).toBe('webhook_key_to_rotate');
  });
});
