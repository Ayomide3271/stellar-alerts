import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { deleteWalletSchema } from './wallets.schema';
import { exportService } from './export.service';
import { NotFoundError, zodValidationError } from '../../lib/errors';

export const exportQuerySchema = z.object({
  format: z.enum(['csv', 'ndjson']).default('ndjson'),
});

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  ndjson: 'application/x-ndjson; charset=utf-8',
} as const;

export class ExportController {
  async exportWallet(request: FastifyRequest, reply: FastifyReply) {
    const params = deleteWalletSchema.safeParse(request.params);
    if (!params.success) {
      throw zodValidationError(params, 'Invalid parameters');
    }
    const query = exportQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw zodValidationError(query, 'Invalid query');
    }

    const userId = (request as any).user.id;
    const wallet = await exportService.findWallet(userId, params.data.id);
    if (!wallet) {
      throw new NotFoundError('Wallet not found');
    }

    const { format } = query.data;
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `stellar-alerts-${wallet.publicKey}-transactions-${stamp}.${format === 'csv' ? 'csv' : 'ndjson'}`;

    reply
      .header('Content-Type', CONTENT_TYPES[format])
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Cache-Control', 'no-store');

    // Sending a stream makes Node use chunked transfer encoding (no Content-Length).
    return reply.send(exportService.createExportStream(wallet.id, format));
  }
}

export const exportController = new ExportController();
