import { FastifyRequest, FastifyReply } from 'fastify';
import { webhookParamsSchema, listWebhookLogsQuerySchema } from './webhooks.schema';
import { validateWebhookRegistration } from './webhook.validator';
import { webhooksService } from './webhooks.service';
import { CursorError } from '../../utils/pagination';
import { NotFoundError, zodValidationError } from '../../lib/errors';

export class WebhooksController {
  async addWebhook(request: FastifyRequest, reply: FastifyReply) {
    const validated = await validateWebhookRegistration(request.body);

    const userId = (request as any).user.id;
    const webhook = await webhooksService.addWebhook(
      userId,
      validated.url,
      validated.payloadTemplate
    );
    return reply.status(201).send({ success: true, webhook });
  }

  async getWebhooks(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const webhooks = await webhooksService.getWebhooks(userId);
    return reply.send({ success: true, webhooks });
  }

  async deleteWebhook(request: FastifyRequest, reply: FastifyReply) {
    const parsed = webhookParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid parameters');
    }

    try {
      const userId = (request as any).user.id;
      await webhooksService.removeWebhook(parsed.data.id, userId);
      return reply.send({ success: true });
    } catch (error: any) {
      if (error.message === 'Webhook not found') {
        throw new NotFoundError(error.message);
      }
      throw error;
    }
  }

  async testWebhook(request: FastifyRequest, reply: FastifyReply) {
    const parsed = webhookParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid parameters');
    }

    try {
      const userId = (request as any).user.id;
      const result = await webhooksService.sendTestWebhook(parsed.data.id, userId);
      return reply.send({ success: result.success, result });
    } catch (error: any) {
      if (error.message === 'Webhook not found') {
        throw new NotFoundError(error.message);
      }
      throw error;
    }
  }

  async getWebhookLogs(request: FastifyRequest, reply: FastifyReply) {
    const params = webhookParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw zodValidationError(params, 'Invalid parameters');
    }

    const query = listWebhookLogsQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw zodValidationError(query, 'Invalid query');
    }

    const userId = (request as any).user.id;
    try {
      const result = await webhooksService.getWebhookLogs(
        params.data.id,
        userId,
        query.data.limit,
        query.data.cursor,
      );
      return reply.send({ success: true, logs: result.items, pagination: result.pagination });
    } catch (err: any) {
      if (err instanceof CursorError) {
        return reply.status(400).send({ error: 'Invalid cursor', message: err.message });
      }
      if (err.message === 'Webhook not found') {
        throw new NotFoundError(err.message);
      }
      throw err;
    }
  }
}

export const webhooksController = new WebhooksController();