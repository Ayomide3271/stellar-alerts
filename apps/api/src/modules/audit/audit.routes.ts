import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MerkleAuditService } from './merkle.service';
import { MerkleProof } from '@stellar-alerts/shared';

const merkleService = new MerkleAuditService();

/**
 * Audit routes for Merkle tree operations
 */
export async function auditRoutes(app: FastifyInstance) {
  /**
   * GET /audit/merkle-root/:date
   * Generate or retrieve Merkle root for a specific date
   */
  app.get<{ Params: { date: string } }>(
    '/audit/merkle-root/:date',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { date } = request.params;

        // Validate date format
        if (!isValidDateFormat(date)) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid date format. Expected YYYY-MM-DD',
          });
        }

        const result = await merkleService.generateDailyMerkleRoot(date);

        return reply.status(200).send({
          success: true,
          date,
          root: result.root,
          treeSize: result.treeSize,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate Merkle root';
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * GET /audit/proof/:alertId/:date
   * Generate Merkle inclusion proof for a specific alert
   */
  app.get<{ Params: { alertId: string; date: string } }>(
    '/audit/proof/:alertId/:date',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { alertId, date } = request.params;

        if (!isValidDateFormat(date)) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid date format. Expected YYYY-MM-DD',
          });
        }

        const proof = await merkleService.generateAlertInclusionProof(alertId, date);

        return reply.status(200).send({
          success: true,
          alertId,
          date,
          proof,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate inclusion proof';
        const statusCode = message.includes('not found') ? 404 : 500;
        return reply.status(statusCode).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /audit/verify
   * Verify a Merkle inclusion proof against a root hash
   * Independent verification that does not require database access
   */
  app.post<{ Body: { alertId: string; proof: MerkleProof; expectedRoot: string } }>(
    '/audit/verify',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { alertId, proof, expectedRoot } = request.body;

        if (!alertId || !proof || !expectedRoot) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required fields: alertId, proof, expectedRoot',
          });
        }

        const isValid = merkleService.verifyAlertInclusion(alertId, proof, expectedRoot);

        return reply.status(200).send({
          success: true,
          alertId,
          verified: isValid,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Verification failed';
        return reply.status(400).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /audit/commit
   * Store a Merkle root commitment for audit trail
   */
  app.post<{ Body: { date: string; root: string; treeSize: number } }>(
    '/audit/commit',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { date, root, treeSize } = request.body;

        if (!date || !root || treeSize === undefined) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required fields: date, root, treeSize',
          });
        }

        if (!isValidDateFormat(date)) {
          return reply.status(400).send({
            success: false,
            error: 'Invalid date format. Expected YYYY-MM-DD',
          });
        }

        const commitment = await merkleService.storeDailyMerkleCommitment(date, root, treeSize);

        return reply.status(200).send({
          success: true,
          commitment,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to store commitment';
        return reply.status(400).send({
          success: false,
          error: message,
        });
      }
    }
  );
}

/**
 * Helper: validates date format YYYY-MM-DD
 */
function isValidDateFormat(dateString: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateString) && !isNaN(Date.parse(`${dateString}T00:00:00Z`));
}
