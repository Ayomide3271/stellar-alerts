import { z } from 'zod';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';
import { cursorSchema, limitSchema } from '../../utils/pagination';

export const createWalletSchema = z.object({
  publicKey: z.string().refine((val) => isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar public key format or checksum',
  }),
  label: z.string().optional(),
  zkProof: z.any().optional(),
  publicSignals: z.array(z.string()).optional(),
});

export const deleteWalletSchema = z.object({
  id: z.string(),
});

export const listWalletsQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
});
