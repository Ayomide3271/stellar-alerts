import { FastifyRequest, FastifyReply } from 'fastify';
import { sep10Service } from './sep10.service';

export interface SEP10ChallengeQuery {
  publicKey?: string;
  account?: string;
}

export interface SEP10VerifyBody {
  transaction: string;
}

export class SEP10Controller {
  /**
   * GET /auth/sep10/challenge
   * Generates a SEP-0010 challenge transaction envelope for the given client public key.
   */
  async getChallenge(
    request: FastifyRequest<{ Querystring: SEP10ChallengeQuery }>,
    reply: FastifyReply
  ) {
    const publicKey = request.query.publicKey || request.query.account;
    if (!publicKey) {
      return reply.status(400).send({
        error: 'Missing required query parameter: "publicKey" or "account"',
      });
    }

    try {
      const challenge = sep10Service.generateChallenge(publicKey);
      return reply.status(200).send(challenge);
    } catch (err: any) {
      return reply.status(400).send({
        error: err.message || 'Failed to generate SEP-0010 challenge transaction',
      });
    }
  }

  /**
   * POST /auth/sep10/verify
   * Cryptographically verifies client signature against challenge transaction envelope
   * and issues JWT session tokens.
   */
  async verify(
    request: FastifyRequest<{ Body: SEP10VerifyBody }>,
    reply: FastifyReply
  ) {
    const { transaction } = request.body || {};
    if (!transaction) {
      return reply.status(400).send({
        error: 'Missing required field: "transaction" (base64 XDR)',
      });
    }

    try {
      const session = await sep10Service.verifyAndIssueSession(transaction);
      return reply.status(200).send(session);
    } catch (err: any) {
      return reply.status(400).send({
        error: err.message || 'SEP-0010 challenge verification failed',
      });
    }
  }
}

export const sep10Controller = new SEP10Controller();
