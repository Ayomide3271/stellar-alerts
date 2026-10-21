import { FastifyRequest, FastifyReply } from 'fastify';
import { sandboxReplaySchema } from './webhooks.schema';
import { webhookSandboxReplayService } from './sandbox.service';
import { SsrfValidationError } from '../../utils/ssrf';
import { zodValidationError } from '../../lib/errors';

export class WebhookSandboxReplayController {
  async replay(request: FastifyRequest, reply: FastifyReply) {
    const parsed = sandboxReplaySchema.safeParse(request.body);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid payload');
    }

    try {
      const result = await webhookSandboxReplayService.replay(parsed.data);
      return reply.send(result);
    } catch (error) {
      if (error instanceof SsrfValidationError) {
        return reply.status(400).send({ error: 'Target URL rejected', code: error.code, message: error.message });
      }
      throw error;
    }
  }
}

export const webhookSandboxReplayController = new WebhookSandboxReplayController();
