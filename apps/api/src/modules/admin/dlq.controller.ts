import { FastifyRequest, FastifyReply } from 'fastify';
import { dlqReplayService, DlqFilterParams } from './dlq-replay.service';

export class DlqController {
  async inspect(
    req: FastifyRequest<{ Querystring: DlqFilterParams }>,
    reply: FastifyReply,
  ) {
    try {
      const result = await dlqReplayService.inspectDlq(req.query);
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  }

  async replay(
    req: FastifyRequest<{
      Body: {
        ids?: string[];
        filter?: DlqFilterParams;
        force?: boolean;
      };
    }>,
    reply: FastifyReply,
  ) {
    try {
      const actorUserId = (req as any).user?.id;
      const result = await dlqReplayService.replayJobs({
        ...req.body,
        actorUserId,
      });
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  }

  async purge(
    req: FastifyRequest<{
      Body: {
        olderThanDays?: number;
        olderThanDate?: string;
        status?: string;
        channel?: string;
      };
    }>,
    reply: FastifyReply,
  ) {
    try {
      const actorUserId = (req as any).user?.id;
      const result = await dlqReplayService.purgeJobs({
        ...req.body,
        actorUserId,
      });
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  }
}

export const dlqController = new DlqController();
