import { FastifyReply, FastifyRequest } from 'fastify';
import { DbHealthService, DbHealthReport } from '../../lib/db-health';

export class HealthController {
  private readonly service: DbHealthService;

  constructor(service: DbHealthService = new DbHealthService(true)) {
    this.service = service;
  }

  /**
   * GET /admin/health/db
   * Returns a structured diagnostic report covering index bloat, dead tuples, and cache hit ratios.
   * Runs using read-only system stat views against the reading client.
   */
  dbhealth = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const report: DbHealthReport = await this.service.generateReport();
      reply.code(200).send({ success: true, data: report });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to generate DB health report');
      reply.code(503).send({
        success: false,
        error: 'DB_HEALTH_REPORT_FAILED',
        message: (error as Error).message,
      });
    }
  };
}

export const healthController = new HealthController();
