import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { idempotencyHooks } from '../../middleware/idempotency.middleware';
import { webhooksController } from './webhooks.controller';
import { webhookSandboxReplayController } from './sandbox.controller';

export async function webhooksRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  // Mutations carry the idempotency guard; reads do not (#334).
  const idempotent = idempotencyHooks();

  app.post(
    '/webhooks',
    { preValidation: idempotent.preValidation, onSend: idempotent.onSend, onResponse: idempotent.onResponse },
    webhooksController.addWebhook.bind(webhooksController)
  );
  app.get('/webhooks', webhooksController.getWebhooks.bind(webhooksController));
  app.delete(
    '/webhooks/:id',
    { preValidation: idempotent.preValidation, onSend: idempotent.onSend, onResponse: idempotent.onResponse },
    webhooksController.deleteWebhook.bind(webhooksController)
  );
  // Deliberately excluded: this route triggers an outbound delivery. It is a
  // diagnostic probe whose whole purpose is to send, so replaying a stored
  // response would make the second press look like it worked when nothing ran.
  app.post('/webhooks/:id/test', webhooksController.testWebhook.bind(webhooksController));
  // Same reasoning as /test: an outbound probe must actually run every time.
  app.post('/webhooks/sandbox/replay', webhookSandboxReplayController.replay.bind(webhookSandboxReplayController));
  app.get('/webhooks/:id/logs', webhooksController.getWebhookLogs.bind(webhooksController));
}
