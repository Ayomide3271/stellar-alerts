import { Controller, Get, Post, Body, Param, HttpException, HttpStatus } from '@nestjs/common';
import { MerkleAuditService } from './merkle.service';
import { MerkleProof } from '@stellar-alerts/shared';

/**
 * AuditController
 *
 * REST endpoints for Merkle tree audit operations.
 * Allows external clients to:
 * 1. Request Merkle roots for specific dates
 * 2. Generate and retrieve inclusion proofs
 * 3. Independently verify alert inclusion
 */
@Controller('audit')
export class AuditController {
  constructor(private readonly merkleService: MerkleAuditService) {}

  /**
   * Generates or retrieves the Merkle root for a specific date.
   * GET /audit/merkle-root/:date
   *
   * @param date ISO date string (YYYY-MM-DD)
   * @returns Merkle root hash and tree size
   */
  @Get('merkle-root/:date')
  async getMerkleRoot(@Param('date') date: string) {
    try {
      // Validate date format
      if (!this.isValidDateFormat(date)) {
        throw new Error('Invalid date format. Expected YYYY-MM-DD');
      }

      const result = await this.merkleService.generateDailyMerkleRoot(date);
      return {
        success: true,
        date,
        root: result.root,
        treeSize: result.treeSize,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to generate Merkle root',
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Generates a Merkle inclusion proof for a specific alert.
   * GET /audit/proof/:alertId/:date
   *
   * @param alertId The alert ID
   * @param date ISO date string (YYYY-MM-DD)
   * @returns Merkle inclusion proof (leaf hash + path)
   */
  @Get('proof/:alertId/:date')
  async getInclusionProof(@Param('alertId') alertId: string, @Param('date') date: string) {
    try {
      if (!this.isValidDateFormat(date)) {
        throw new Error('Invalid date format. Expected YYYY-MM-DD');
      }

      const proof = await this.merkleService.generateAlertInclusionProof(alertId, date);
      return {
        success: true,
        alertId,
        date,
        proof,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to generate inclusion proof',
        },
        error instanceof Error && error.message.includes('not found')
          ? HttpStatus.NOT_FOUND
          : HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Verifies a Merkle inclusion proof against a root hash.
   * This is an independent verification operation that does not require database access
   * and can be performed by third-party auditors.
   *
   * POST /audit/verify
   *
   * Request body:
   * {
   *   "alertId": "alert-uuid",
   *   "proof": { "leafHash": "...", "path": [...] },
   *   "expectedRoot": "merkle-root-hex"
   * }
   *
   * @returns Verification result (true/false)
   */
  @Post('verify')
  async verifyProof(
    @Body() body: { alertId: string; proof: MerkleProof; expectedRoot: string }
  ) {
    try {
      const { alertId, proof, expectedRoot } = body;

      if (!alertId || !proof || !expectedRoot) {
        throw new Error('Missing required fields: alertId, proof, expectedRoot');
      }

      const isValid = this.merkleService.verifyAlertInclusion(alertId, proof, expectedRoot);

      return {
        success: true,
        alertId,
        verified: isValid,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Verification failed',
        },
        HttpStatus.BAD_REQUEST
      );
    }
  }

  /**
   * Stores a Merkle root commitment for audit trail.
   * POST /audit/commit
   *
   * @param body Contains date, root, and treeSize
   */
  @Post('commit')
  async commitMerkleRoot(@Body() body: { date: string; root: string; treeSize: number }) {
    try {
      const { date, root, treeSize } = body;

      if (!date || !root || treeSize === undefined) {
        throw new Error('Missing required fields: date, root, treeSize');
      }

      if (!this.isValidDateFormat(date)) {
        throw new Error('Invalid date format. Expected YYYY-MM-DD');
      }

      const commitment = await this.merkleService.storeDailyMerkleCommitment(date, root, treeSize);

      return {
        success: true,
        commitment,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to store commitment',
        },
        HttpStatus.BAD_REQUEST
      );
    }
  }

  /**
   * Helper: validates date format YYYY-MM-DD
   */
  private isValidDateFormat(dateString: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(dateString) && !isNaN(Date.parse(`${dateString}T00:00:00Z`));
  }
}
