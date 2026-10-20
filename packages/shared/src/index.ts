import { z } from 'zod';
import { isValidEd25519PublicKey } from './strkey';

// Generated from the API's OpenAPI schema — see scripts/generate-types.ts.
// Re-exported under a `Api` namespace to avoid clashing with the
// hand-written DTOs below (`components["schemas"]["RequestLinkInput"]`, etc).
export type { components as ApiComponents, paths as ApiPaths } from './generated/api-types';
export * from './config/index';
export * from './merkle';
// Single source of truth for Stellar StrKey / transaction-hash validation
// (Ed25519 public keys, contract IDs, muxed addresses, transaction hashes).
export * from './strkey';

const dateDTO = z.union([z.date(), z.string()]);

export const userDTOSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    createdAt: dateDTO,
  })
  .passthrough();
export type UserDTO = z.infer<typeof userDTOSchema>;

export const walletDTOSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    publicKey: z.string(),
    label: z.string().nullable().optional(),
    createdAt: dateDTO,
  })
  .passthrough();
export type WalletDTO = z.infer<typeof walletDTOSchema>;

export const paymentDTOSchema = z
  .object({
    id: z.string(),
    walletId: z.string(),
    txHash: z.string(),
    fromAddress: z.string(),
    amount: z.union([z.number(), z.string()]),
    asset: z.string(),
    memo: z.string().nullable().optional(),
    receivedAt: dateDTO,
  })
  .passthrough();
export type PaymentDTO = z.infer<typeof paymentDTOSchema>;

export interface DeliveryEventDTO {
  id: string;
  webhookId: string;
  statusCode?: number | null;
  responseBody?: string | null;
  error?: string | null;
  sentAt: Date | string;
}

export interface NotificationPreferenceDTO {
  id: string;
  userId: string;
  telegramChatId?: string | null;
  telegramEnabled: boolean;
  emailEnabled: boolean;
  whatsappNumber?: string | null;
  whatsappEnabled: boolean;
}

/**
 * Validates whether a given string is a valid Stellar Ed25519 Public Key.
 *
 * Backwards-compatible name for {@link isValidEd25519PublicKey}; it now
 * performs full StrKey validation (version byte + CRC16-XMODEM checksum)
 * through the shared `strkey` module instead of the previous shape-only check
 * (`length === 56 && startsWith('G')`) that accepted corrupted keys.
 */
export function isValidStellarPublicKey(publicKey: string): boolean {
  return isValidEd25519PublicKey(publicKey);
}

/**
 * Filters a list of payments by search query (address, txHash, asset, memo) and asset code.
 */
export function filterPayments<T extends PaymentDTO>(
  payments: T[],
  searchQuery: string,
  selectedAsset: string = 'ALL'
): T[] {
  const query = searchQuery.trim().toLowerCase();
  return payments.filter((payment) => {
    const matchesQuery =
      !query ||
      (payment.fromAddress && payment.fromAddress.toLowerCase().includes(query)) ||
      (payment.txHash && payment.txHash.toLowerCase().includes(query)) ||
      (payment.asset && payment.asset.toLowerCase().includes(query)) ||
      (payment.memo && payment.memo.toLowerCase().includes(query));

    const matchesAsset =
      selectedAsset === 'ALL' ||
      (payment.asset && payment.asset.toUpperCase() === selectedAsset.toUpperCase());

    return matchesQuery && matchesAsset;
  });
}

/**
 * Extracts unique asset codes from a payments list with 'ALL' as the first default option.
 */
export function extractAvailableAssets(payments: PaymentDTO[]): string[] {
  const assets = new Set<string>();
  payments.forEach((p) => {
    if (p.asset) {
      assets.add(p.asset.toUpperCase());
    }
  });
  return ['ALL', ...Array.from(assets).sort()];
}
