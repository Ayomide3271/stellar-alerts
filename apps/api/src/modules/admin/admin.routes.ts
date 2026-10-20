import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { dlqController } from './dlq.controller';
import { dbHealthController } from '../maintenance/db-health.controller';

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  app.get('/admin/dlq', dlqController.inspect.bind(dlqController));
  app.post('/admin/dlq/replay', dlqController.replay.bind(dlqController));
  app.post('/admin/dlq/purge', dlqController.purge.bind(dlqController));
  app.get('/admin/health/db', dbHealthController.report.bind(dbHealthController));
}
