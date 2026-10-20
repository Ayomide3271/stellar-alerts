import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { normalizeTransactionHash } from '@stellar-alerts/shared';
import { generateTaxExportCsv } from '../../utils/tax-exporter';
import { generateLedgerStatementPdf } from '../../utils/pdf-generator';
import { generateTransactionReceiptPdf } from '../../utils/receipt-generator';
import { prismaRead, prisma } from '../../lib/prisma';
import { paymentsService } from './payments.service';
import { CursorError, cursorSchema, limitSchema } from '../../utils/pagination';
import { AuthenticationError, AuthorizationError, NotFoundError, ValidationError, zodValidationError } from '../../lib/errors';

const getPaymentsSchema = z
  .object({
    // Optional: omitted by the dashboard's "All Wallets" view (see apps/web
    // src/app/(app)/dashboard/page.tsx fetchPayments), which previously 400'd here.
    walletId: z.string().optional(),
    limit: limitSchema,
    cursor: cursorSchema,
    asset: z.string().optional(),
    memo: z.string().optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
    sortBy: z.enum(['receivedAt', 'amount', 'asset']).optional().default('receivedAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  })
  .refine((data) => !data.dateFrom || !data.dateTo || data.dateFrom <= data.dateTo, {
    message: 'dateFrom must be before or equal to dateTo',
    path: ['dateFrom'],
  });

const getSummarySchema = z.object({
  walletId: z.string().optional(),
  fiat: z.string().optional(),
});

const getTaxExportSchema = z.object({
  walletId: z.string().optional(),
  format: z.enum(['cointracker', 'koinly', 'irs8949']).optional().default('cointracker'),
});

const getCrossLedgerSchema = z.object({
  walletId: z.string().optional(),
});

const estimateFeeBodySchema = z.object({
  /** Base64-encoded XDR TransactionEnvelope of the Soroban transaction to simulate */
  xdrEnvelope: z.string().min(1, 'xdrEnvelope is required'),
});

export class PaymentsController {
  async getPayments(request: FastifyRequest, reply: FastifyReply) {
    const parsed = getPaymentsSchema.safeParse(request.query);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid query');
    }
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    try {
      const result = await paymentsService.getPayments(
        request.user.id,
        parsed.data.walletId,
        parsed.data.limit,
        {
          asset: parsed.data.asset,
          memo: parsed.data.memo,
          dateFrom: parsed.data.dateFrom,
          dateTo: parsed.data.dateTo,
          sortBy: parsed.data.sortBy,
          sortOrder: parsed.data.sortOrder,
          cursor: parsed.data.cursor,
        },
      );
      return reply.send({ success: true, payments: result.items, pagination: result.pagination });
    } catch (err) {
      if (err instanceof CursorError) {
        return reply.status(400).send({ error: 'Invalid cursor', message: err.message });
      }
      throw err;
    }
  }

  async getSummary(request: FastifyRequest, reply: FastifyReply) {
    const parsed = getSummarySchema.safeParse(request.query);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid query');
    }
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const summary = await paymentsService.getPaymentsSummary(
      request.user.id,
      parsed.data.walletId,
      parsed.data.fiat,
    );
    return reply.send({ success: true, summary });
  }

  // PR placeholder for issue #533 – payment summary endpoint
  async getPaymentsSummary(request: FastifyRequest, reply: FastifyReply) {
    return this.getSummary(request, reply);
  }

  /**
   * POST /payments/estimate-fee
   *
   * Accepts a base64-encoded XDR TransactionEnvelope and returns a simulated
   * fee breakdown including:
   *  - inclusion fee (classic base fee in stroops)
   *  - resource fee (execution + state rent in stroops)
   *  - rent fee component in stroops
   *  - total fee in stroops and XLM
   *  - read/write ledger entry footprints
   *  - CPU instructions and memory bytes estimates
   */
  async estimateFee(request: FastifyRequest, reply: FastifyReply) {
    const parsed = estimateFeeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.format() });
    }

    const estimate = await paymentsService.estimateFee(parsed.data.xdrEnvelope);

    if (!estimate.success) {
      return reply.status(422).send({
        success: false,
        error: 'Simulation failed',
        details: estimate.error,
      });
    }

    return reply.send({ success: true, estimate });
  }

  async getReceipt(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const { txHash } = request.params as { txHash: string };
    if (!txHash) {
      throw new ValidationError('Missing transaction hash parameter');
    }

    // The route accepts either a 64-hex transaction hash (optionally
    // 0x-prefixed, in any case) or a payment id. Normalize the hash form
    // through the shared validator; ids are passed through untouched so the
    // existing OR lookup keeps working.
    const normalizedTxHash = normalizeTransactionHash(txHash);

    const payment = await prisma.payment.findFirst({
      where: {
        OR: [
          { txHash: normalizedTxHash ?? txHash },
          { id: txHash },
        ],
      },
      include: {
        wallet: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundError('Payment transaction not found');
    }

    if (payment.wallet.userId !== request.user.id) {
      throw new AuthorizationError('Unauthorized access to transaction receipt');
    }

    const { buffer, verificationHash } = await generateTransactionReceiptPdf({
      paymentId: payment.id,
      txHash: payment.txHash,
      fromAddress: payment.fromAddress,
      toWalletPublicKey: payment.wallet.publicKey,
      walletLabel: payment.wallet.label,
      amount: payment.amount.toString(),
      asset: payment.asset,
      assetIssuer: payment.assetIssuer,
      memo: payment.memo,
      receivedAt: payment.receivedAt,
      userEmail: payment.wallet.user.email,
    });

    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="receipt-${payment.txHash.slice(0, 12)}.pdf"`)
      .header('X-Receipt-Verification-Hash', verificationHash)
      .send(buffer);
  }
}

export const paymentsController = new PaymentsController();
