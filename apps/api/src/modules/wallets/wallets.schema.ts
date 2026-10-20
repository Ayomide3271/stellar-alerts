import { z } from 'zod';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';
import { cursorSchema, limitSchema } from '../../utils/pagination';

export const createWalletSchema = z.object({
  publicKey: z.string().refine((val) => isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar public key format or checksum',
  }),
  label: z.string().optional(),
  tags: z.array(z.string()).optional(),
  zkProof: z.any().optional(),
  publicSignals: z.array(z.string()).optional(),
});

export const deleteWalletSchema = z.object({
  id: z.string(),
});

export const updateWalletMetadataSchema = z.object({
  nickname: z.string().max(50).optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a 6-digit hex code').optional(),
  tags: z.array(z.string()).optional(),
}).refine((metadata) => Object.keys(metadata).length > 0, {
  message: 'At least one metadata field must be provided',
});

export const updateWalletTagsSchema = z.object({
  tags: z.array(z.string()),
});

export const listWalletsQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
  tag: z.string().optional(),
});
