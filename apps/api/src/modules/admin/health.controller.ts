import { FastifyReply, FastifyRequest } from 'fastify';
import { dbHealthService } from '../maintenance/db-health.service';

export class HealthController {
  async dbHealth(request: FastifyRequest, reply: FastifyReply) {
    try {
      const report = await dbHealthService.generateReport();
      return reply.status(200).send({
        success: true,
        data: report,
      });
    } catch (error) {
      request.log.error({
        err: error,
        msg: 'DbHealthService report generation failed',
      });
      return reply.status(503).send({
        success: false,
        error: 'DB_HEATH_UNAVAILABLE',
        message: (error as Error).message,
      });
    }
  }
}

export const healthController = new HealthController();
