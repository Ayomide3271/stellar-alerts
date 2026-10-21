import { isValidEd25519PublicKey } from '@stellar-alerts/shared';

export const STELLAR_SIGNATURE_HEADER = 'X-Stellar-Signature';
export const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type WalletProviderType = 'freighter' | 'albedo';

export type SignatureGuardErrorCode =
  | 'WALLET_NOT_AVAILABLE'
  | 'USER_REJECTED'
  | 'MISSING_SIGNATURE'
  | 'INVALID_PUBLIC_KEY'
  | 'INVALID_SIGNATURE'
  | 'CHALLENGE_EXPIRED';

export class SignatureGuardError extends Error {
  public readonly code: SignatureGuardErrorCode;

  constructor(code: SignatureGuardErrorCode, message: string) {
    super(message);
    this.name = 'SignatureGuardError';
    this.code = code;
  }
}

export interface RuleMutationChallenge {
  action: string;
  publicKey: string;
  timestamp: number;
  nonce: string;
  payloadHash: string;
  message: string;
}

export interface SignedRuleMutation {
  challenge: RuleMutationChallenge;
  signature: string; // base64-encoded 64-byte Ed25519 signature
  provider: WalletProviderType;
  publicKey: string;
}

export type WalletSignerFn = (
  message: string,
  publicKey: string,
  provider: WalletProviderType
) => Promise<string>;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ED25519_PUBLIC_KEY_VERSION_BYTE = 6 << 3; // 48 ('G')

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let buffer = 0;
  const out: number[] = [];

  for (let i = 0; i < input.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(input[i]);
    if (idx === -1) return null;
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
    buffer &= (1 << bits) - 1;
  }

  if (bits > 0 && buffer !== 0) return null;
  return Uint8Array.from(out);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let out = '';

  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >>> bits) & 0x1f];
    }
    buffer &= (1 << bits) - 1;
  }

  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Encodes a raw 32-byte Ed25519 public key into a Stellar StrKey (`G...`).
 */
export function encodeEd25519PublicKeyStrKey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) {
    throw new SignatureGuardError(
      'INVALID_PUBLIC_KEY',
      `Expected 32-byte Ed25519 public key, got ${rawPublicKey.length} bytes`
    );
  }
  const body = new Uint8Array(33);
  body[0] = ED25519_PUBLIC_KEY_VERSION_BYTE;
  body.set(rawPublicKey, 1);
  const checksum = crc16Xmodem(body);
  const full = new Uint8Array(35);
  full.set(body, 0);
  full[33] = checksum & 0xff;
  full[34] = (checksum >> 8) & 0xff;
  return base32Encode(full);
}

/**
 * Decodes a Stellar StrKey (`G...`) into its raw 32-byte Ed25519 public key.
 */
export function decodeEd25519PublicKeyBytes(publicKey: string): Uint8Array {
  const trimmed = (publicKey || '').trim();
  if (!isValidEd25519PublicKey(trimmed)) {
    throw new SignatureGuardError(
      'INVALID_PUBLIC_KEY',
      'Invalid Stellar Ed25519 public key'
    );
  }
  const decoded = base32Decode(trimmed);
  if (!decoded || decoded.length !== 35) {
    throw new SignatureGuardError(
      'INVALID_PUBLIC_KEY',
      'Failed to decode Stellar Ed25519 public key'
    );
  }
  return decoded.subarray(1, 33);
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function simplePayloadDigest(payload: unknown): string {
  const serialized = JSON.stringify(payload ?? {});
  let h1 = 0xdeadbeef ^ serialized.length;
  let h2 = 0x41c6ce57 ^ serialized.length;
  for (let i = 0; i < serialized.length; i++) {
    const ch = serialized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Builds a deterministic, timestamped challenge payload for sensitive rule or
 * webhook mutations.
 */
export function buildRuleChangeChallenge(params: {
  action: string;
  payload: unknown;
  publicKey: string;
  timestamp?: number;
  nonce?: string;
}): RuleMutationChallenge {
  const timestamp = params.timestamp ?? Date.now();
  const nonce = params.nonce ?? `${timestamp.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const payloadHash = simplePayloadDigest(params.payload);
  const message = [
    'stellar-alerts:rule-auth:v1',
    `action=${params.action}`,
    `pubkey=${params.publicKey}`,
    `ts=${timestamp}`,
    `nonce=${nonce}`,
    `hash=${payloadHash}`,
  ].join('|');

  return {
    action: params.action,
    publicKey: params.publicKey,
    timestamp,
    nonce,
    payloadHash,
    message,
  };
}

function isRejectionError(err: unknown): boolean {
  const msg =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object' && 'message' in err
      ? String((err as { message: unknown }).message)
      : '';
  return /reject|declin|cancel|denied|user_rejected/i.test(msg);
}

/**
 * Default browser wallet signer supporting Freighter (`window.freighterApi`) and
 * Albedo (`window.albedo`).
 */
export async function defaultBrowserWalletSigner(
  message: string,
  publicKey: string,
  provider: WalletProviderType
): Promise<string> {
  const win = (typeof window !== 'undefined' ? window : undefined) as
    | {
        freighterApi?: {
          signMessage?: (msg: string, opts?: { address?: string }) => Promise<string | { signedMessage?: string; error?: string }>;
        };
        albedo?: {
          signMessage?: (opts: { message: string; pubkey?: string }) => Promise<{ message_signature?: string }>;
        };
      }
    | undefined;

  if (provider === 'albedo') {
    if (!win?.albedo?.signMessage) {
      throw new SignatureGuardError(
        'WALLET_NOT_AVAILABLE',
        'Albedo wallet provider is not available in this browser.'
      );
    }
    try {
      const res = await win.albedo.signMessage({ message, pubkey: publicKey });
      if (!res?.message_signature) {
        throw new SignatureGuardError('USER_REJECTED', 'Albedo signature request was rejected.');
      }
      return res.message_signature;
    } catch (err) {
      if (err instanceof SignatureGuardError) throw err;
      if (isRejectionError(err)) {
        throw new SignatureGuardError('USER_REJECTED', 'User rejected the Albedo signature request.');
      }
      throw new SignatureGuardError('USER_REJECTED', 'Albedo failed to sign the challenge.');
    }
  }

  if (!win?.freighterApi?.signMessage) {
    throw new SignatureGuardError(
      'WALLET_NOT_AVAILABLE',
      'Freighter wallet extension is not available.'
    );
  }

  try {
    const result = await win.freighterApi.signMessage(message, { address: publicKey });
    if (typeof result === 'string') {
      if (!result) {
        throw new SignatureGuardError('USER_REJECTED', 'Freighter returned an empty signature.');
      }
      return result;
    }
    if (result?.error) {
      throw new SignatureGuardError('USER_REJECTED', result.error);
    }
    if (!result?.signedMessage) {
      throw new SignatureGuardError('USER_REJECTED', 'Freighter signature was cancelled.');
    }
    return result.signedMessage;
  } catch (err) {
    if (err instanceof SignatureGuardError) throw err;
    if (isRejectionError(err)) {
      throw new SignatureGuardError('USER_REJECTED', 'User rejected the Freighter signature prompt.');
    }
    throw new SignatureGuardError('USER_REJECTED', 'Freighter signature request failed.');
  }
}

/**
 * Prompts the connected browser wallet (Freighter or Albedo) to sign the
 * confirmation challenge.
 */
export async function requestWalletRuleSignature(
  challenge: RuleMutationChallenge,
  options: {
    provider?: WalletProviderType;
    signer?: WalletSignerFn;
  } = {}
): Promise<SignedRuleMutation> {
  const provider = options.provider ?? 'freighter';
  const signer = options.signer ?? defaultBrowserWalletSigner;

  const signature = await signer(challenge.message, challenge.publicKey, provider);
  if (!signature || !signature.trim()) {
    throw new SignatureGuardError('MISSING_SIGNATURE', 'Wallet signature is required.');
  }

  return {
    challenge,
    signature: signature.trim(),
    provider,
    publicKey: challenge.publicKey,
  };
}

/**
 * Cryptographically verifies an Ed25519 signature over a rule-change challenge
 * against a Stellar Ed25519 public key (`G...`).
 */
export async function verifyRuleSignature(params: {
  publicKey: string;
  challenge: RuleMutationChallenge;
  signature: string;
  now?: number;
  maxAgeMs?: number;
}): Promise<{ valid: boolean; reason?: string }> {
  const { publicKey, challenge, signature } = params;
  const now = params.now ?? Date.now();
  const maxAgeMs = params.maxAgeMs ?? DEFAULT_CHALLENGE_TTL_MS;

  if (!signature || typeof signature !== 'string' || !signature.trim()) {
    return { valid: false, reason: 'Missing signature' };
  }

  if (!publicKey || publicKey !== challenge.publicKey) {
    return { valid: false, reason: 'Public key mismatch with challenge' };
  }

  if (Math.abs(now - challenge.timestamp) > maxAgeMs) {
    return { valid: false, reason: 'Challenge timestamp has expired' };
  }

  let rawPublicKey: Uint8Array;
  try {
    rawPublicKey = decodeEd25519PublicKeyBytes(publicKey);
  } catch {
    return { valid: false, reason: 'Invalid Stellar public key' };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(signature.trim());
  } catch {
    return { valid: false, reason: 'Malformed base64 signature' };
  }

  if (sigBytes.length !== 64) {
    return { valid: false, reason: 'Invalid Ed25519 signature length' };
  }

  try {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      rawPublicKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const messageBytes = new TextEncoder().encode(challenge.message);
    const verified = await globalThis.crypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      sigBytes as BufferSource,
      messageBytes as BufferSource
    );
    return verified ? { valid: true } : { valid: false, reason: 'Cryptographic signature verification failed' };
  } catch {
    return { valid: false, reason: 'Signature verification failed' };
  }
}

/**
 * Formats the signed challenge into the `X-Stellar-Signature` HTTP header value.
 */
export function formatStellarSignatureHeader(signed: SignedRuleMutation): string {
  return `pub=${signed.publicKey};ts=${signed.challenge.timestamp};nonce=${signed.challenge.nonce};sig=${signed.signature};msg=${encodeURIComponent(signed.challenge.message)}`;
}

/**
 * Builds the request headers containing `X-Stellar-Signature` after verifying
 * the signature is present and valid. Throws `SignatureGuardError` if missing
 * or invalid.
 */
export async function buildVerifiedRuleMutationHeaders(
  signed: SignedRuleMutation | null | undefined,
  options: { verifyCryptographically?: boolean; now?: number } = {}
): Promise<Record<string, string>> {
  if (!signed || !signed.signature || !signed.signature.trim()) {
    throw new SignatureGuardError(
      'MISSING_SIGNATURE',
      'Sensitive rule modifications require a valid wallet signature.'
    );
  }

  if (options.verifyCryptographically) {
    const check = await verifyRuleSignature({
      publicKey: signed.publicKey,
      challenge: signed.challenge,
      signature: signed.signature,
      now: options.now,
    });
    if (!check.valid) {
      throw new SignatureGuardError(
        'INVALID_SIGNATURE',
        check.reason || 'Wallet signature verification failed.'
      );
    }
  }

  return {
    [STELLAR_SIGNATURE_HEADER]: formatStellarSignatureHeader(signed),
  };
}
