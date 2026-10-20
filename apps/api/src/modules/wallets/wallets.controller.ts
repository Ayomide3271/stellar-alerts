import { FastifyRequest, FastifyReply } from 'fastify';
import {
  createWalletSchema,
  deleteWalletSchema,
  listWalletsQuerySchema,
  updateWalletMetadataSchema,
  updateWalletTagsSchema,
} from './wallets.schema';
import { walletsService } from './wallets.service';
import { CursorError } from '../../utils/pagination';
import { ConflictError, NotFoundError, ValidationError, zodValidationError } from '../../lib/errors';

export class WalletsController {
  async addWallet(request: FastifyRequest, reply: FastifyReply) {
    const parsed = createWalletSchema.safeParse(request.body);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid payload');
    }

    const userId = (request as any).user.id;
    try {
      const wallet = await walletsService.addWallet(
        userId,
        parsed.data.publicKey,
        parsed.data.label,
        parsed.data.tags,
        parsed.data.zkProof,
        parsed.data.publicSignals
      );
      return reply.status(201).send({ success: true, wallet });
    } catch (error: any) {
      if (error.message === 'Invalid ZK proof') {
        throw new ValidationError('Invalid ZK proof');
      }
      if (error.message === 'Wallet already exists' || error.code === 'P2002') {
        throw new ConflictError('Wallet address is already registered');
      }
      throw error;
    }
  }

  async getWallets(request: FastifyRequest, reply: FastifyReply) {
    const parsed = listWalletsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid query');
    }

    const userId = (request as any).user.id;
    try {
      const result = await walletsService.getWallets(
        userId,
        parsed.data.limit,
        parsed.data.cursor,
        parsed.data.tag
      );
      return reply.send({ success: true, wallets: result.items, pagination: result.pagination });
    } catch (err) {
      if (err instanceof CursorError) {
        return reply.status(400).send({ error: 'Invalid cursor', message: (err as Error).message });
      }
      throw err;
    }
  }

  async updateWalletTags(request: FastifyRequest, reply: FastifyReply) {
    const params = deleteWalletSchema.safeParse(request.params);
    if (!params.success) {
      throw zodValidationError(params, 'Invalid parameters');
    }

    const body = updateWalletTagsSchema.safeParse(request.body);
    if (!body.success) {
      throw zodValidationError(body, 'Invalid payload');
    }

    const userId = (request as any).user.id;
    try {
      const wallet = await walletsService.updateWalletTags(userId, params.data.id, body.data.tags);
      return reply.send({ success: true, wallet });
    } catch (error: any) {
      if (error.message === 'Wallet not found') {
        throw new NotFoundError(error.message);
      }
      throw error;
    }
  }

  async updateWalletMetadata(request: FastifyRequest, reply: FastifyReply) {
    const params = deleteWalletSchema.safeParse(request.params);
    if (!params.success) {
      throw zodValidationError(params, 'Invalid parameters');
    }

    const body = updateWalletMetadataSchema.safeParse(request.body);
    if (!body.success) {
      throw zodValidationError(body, 'Invalid payload');
    }

    const userId = (request as any).user.id;
    try {
      const wallet = await walletsService.updateWalletMetadata(userId, params.data.id, body.data);
      return reply.send({ success: true, wallet });
    } catch (error: any) {
      if (error.message === 'Wallet not found') {
        throw new NotFoundError(error.message);
      }
      throw error;
    }
  }

  async getIngestionStatus(request: FastifyRequest, reply: FastifyReply) {
    const parsed = deleteWalletSchema.safeParse(request.params);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid parameters');
    }

    const userId = (request as any).user.id;
    try {
      const ingestion = await walletsService.getIngestionStatus(userId, parsed.data.id);
      return reply.send({ success: true, ingestion });
    } catch (error: any) {
      if (error.message === 'Wallet not found') {
        throw new NotFoundError(error.message);
      }
      throw error;
    }
  }

  async deleteWallet(request: FastifyRequest, reply: FastifyReply) {
    const parsed = deleteWalletSchema.safeParse(request.params);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid parameters');
    }

    const userId = (request as any).user.id;
    try {
      await walletsService.removeWallet(userId, parsed.data.id);
      return reply.send({ success: true });
    } catch (error: any) {
      if (error.message === 'Wallet not found') {
        throw new NotFoundError(error.message);
      }
      throw error;
    }
  }
}

export const walletsController = new WalletsController();
