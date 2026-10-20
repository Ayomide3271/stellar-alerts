/**
 * Profile types and vault format definitions for the Stellar Alerts CLI.
 *
 * Storage layout (XDG conventions):
 *   ~/.config/stellar-alerts/
 *     profiles.json          – plaintext profile metadata (no secrets)
 *     vault.enc              – AES-256-GCM encrypted vault containing secrets
 *
 * Vault format version: 1
 * KDF: scrypt  (N=131072, r=8, p=1)  – chosen because it is built into
 *      Node.js crypto (no extra dependency) and is memory-hard.
 * Cipher: AES-256-GCM  (authenticated encryption)
 */

// ---------------------------------------------------------------------------
// Profile name validation
// ---------------------------------------------------------------------------

/** Valid profile name: 1–64 chars, alphanumeric, hyphens, underscores only. */
export const PROFILE_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_REGEX.test(name);
}

// ---------------------------------------------------------------------------
// Non-sensitive profile configuration
// ---------------------------------------------------------------------------

/**
 * Non-sensitive fields stored in plaintext `profiles.json`.
 * These are safe to read without a vault password.
 */
export interface ProfileConfig {
  /** Display name / human label */
  name: string;

  /** Stellar network hint (informational only; does not restrict API usage) */
  network?: 'testnet' | 'mainnet' | 'staging' | string;

  /** REST API base URL for this profile */
  apiUrl: string;

  /** Log level override for this profile */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';

  /** ISO-8601 timestamp when the profile was created */
  createdAt: string;

  /** ISO-8601 timestamp of the last modification */
  updatedAt: string;

  /**
   * Whether this profile has any secrets stored in the vault.
   * Allows callers to know a password will be required without opening the vault.
   */
  hasSecrets: boolean;
}

// ---------------------------------------------------------------------------
// Sensitive profile secrets (stored encrypted in vault)
// ---------------------------------------------------------------------------

/**
 * Sensitive fields stored encrypted inside the vault.
 * The vault maps profile names → ProfileSecrets.
 */
export interface ProfileSecrets {
  /** Bearer token / API key for authenticating against the Stellar Alerts API */
  apiKey?: string;

  /** Arbitrary user-defined key→value secret entries */
  extra?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Profiles store file format
// ---------------------------------------------------------------------------

/** Root structure of `profiles.json` */
export interface ProfilesFile {
  /** Schema version for future migration support */
  version: 1;

  /** Currently active profile name */
  activeProfile: string | null;

  /** Map of profile name → ProfileConfig */
  profiles: Record<string, ProfileConfig>;
}

// ---------------------------------------------------------------------------
// Encrypted vault format
// ---------------------------------------------------------------------------

/**
 * KDF parameters used during vault encryption.
 * Stored alongside the ciphertext so the vault can always be decrypted with
 * the correct parameters even after a future parameter upgrade.
 */
export interface ScryptParams {
  N: number;  // CPU/memory cost parameter (must be power of 2)
  r: number;  // Block size
  p: number;  // Parallelization factor
  keyLen: number;
}

/** Default scrypt parameters (OWASP recommended minimum for interactive logins) */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 131072, // 2^17
  r: 8,
  p: 1,
  keyLen: 32, // 256 bits for AES-256
};

/**
 * Argon2id KDF parameters (RFC 9106 recommended profile).
 * Memory-hard derivation (64MB memory cost, 3 iterations, 1 lane, 256-bit key).
 */
export interface Argon2idParams {
  memoryCost: number; // in KB, e.g. 65536 = 64MB
  timeCost: number;   // iterations, e.g. 3
  parallelism: number; // lanes/threads, default 1
  keyLen: number;     // 32 bytes for AES-256
}

export const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = {
  memoryCost: 65536, // 64 MB
  timeCost: 3,       // 3 iterations
  parallelism: 1,
  keyLen: 32,        // 256 bits
};

/**
 * The serialized vault format written to disk.
 * All binary values are stored as hex strings for JSON safety.
 */
export interface VaultFile {
  /** Vault schema version – used to detect unsupported future formats */
  version: 1;

  /** KDF algorithm identifier */
  kdf: 'scrypt' | 'argon2id';

  /** KDF parameters used to derive the encryption key */
  kdfParams: ScryptParams | Argon2idParams;

  /** Hex-encoded cryptographically random salt (32 bytes) for scrypt */
  salt: string;

  /** Cipher algorithm identifier */
  cipher: 'aes-256-gcm';

  /** Hex-encoded random nonce/IV (12 bytes for GCM) */
  nonce: string;

  /**
   * Hex-encoded authentication tag produced by AES-256-GCM (16 bytes).
   * Verifying this tag prevents silent data corruption and tampering.
   */
  authTag: string;

  /** Hex-encoded AES-256-GCM ciphertext of the JSON-serialised vault payload */
  ciphertext: string;
}

/**
 * Plaintext payload that lives inside the vault (after decryption).
 * Maps profile name → secrets for that profile.
 */
export interface VaultPayload {
  /** Payload format version */
  version: 1;

  /** Map of profile name → ProfileSecrets */
  secrets: Record<string, ProfileSecrets>;
}

// ---------------------------------------------------------------------------
// Well-known error codes
// ---------------------------------------------------------------------------

export type ProfileErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_ALREADY_EXISTS'
  | 'INVALID_PROFILE_NAME'
  | 'NO_ACTIVE_PROFILE'
  | 'VAULT_NOT_FOUND'
  | 'VAULT_WRONG_PASSWORD'
  | 'VAULT_CORRUPTED'
  | 'VAULT_UNSUPPORTED_VERSION'
  | 'VAULT_INVALID_METADATA'
  | 'VAULT_INVALID_KDF_PARAMS'
  | 'CONFIG_READ_ERROR'
  | 'CONFIG_WRITE_ERROR';

export class ProfileError extends Error {
  public readonly code: ProfileErrorCode;

  constructor(code: ProfileErrorCode, message: string) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}
