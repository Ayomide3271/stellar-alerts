import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditController } from './audit.controller';
import { MerkleAuditService } from './merkle.service';
import { HttpException } from '@nestjs/common';
import { MerkleProof } from '@stellar-alerts/shared';

describe('AuditController', () => {
  let controller: AuditController;
  let service: MerkleAuditService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        {
          provide: MerkleAuditService,
          useValue: {
            generateDailyMerkleRoot: vi.fn(),
            generateAlertInclusionProof: vi.fn(),
            verifyAlertInclusion: vi.fn(),
            storeDailyMerkleCommitment: vi.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<AuditController>(AuditController);
    service = module.get<MerkleAuditService>(MerkleAuditService);
  });

  describe('GET /audit/merkle-root/:date', () => {
    it('returns Merkle root for a valid date', async () => {
      const mockRoot = {
        root: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        treeSize: 5,
      };

      vi.mocked(service.generateDailyMerkleRoot).mockResolvedValue(mockRoot);

      const result = await controller.getMerkleRoot('2026-08-30');

      expect(result.success).toBe(true);
      expect(result.date).toBe('2026-08-30');
      expect(result.root).toBe(mockRoot.root);
      expect(result.treeSize).toBe(5);
      expect(result.timestamp).toBeDefined();
    });

    it('throws error for invalid date format', async () => {
      await expect(controller.getMerkleRoot('invalid-date')).rejects.toThrow(HttpException);
    });

    it('throws error when service fails', async () => {
      vi.mocked(service.generateDailyMerkleRoot).mockRejectedValue(
        new Error('No delivered alerts found')
      );

      await expect(controller.getMerkleRoot('2026-08-30')).rejects.toThrow(HttpException);
    });
  });

  describe('GET /audit/proof/:alertId/:date', () => {
    it('returns Merkle inclusion proof for valid alert and date', async () => {
      const mockProof: MerkleProof = {
        leafHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        path: [
          {
            siblingHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            direction: 'right',
          },
        ],
      };

      vi.mocked(service.generateAlertInclusionProof).mockResolvedValue(mockProof);

      const result = await controller.getInclusionProof('alert-123', '2026-08-30');

      expect(result.success).toBe(true);
      expect(result.alertId).toBe('alert-123');
      expect(result.date).toBe('2026-08-30');
      expect(result.proof).toEqual(mockProof);
      expect(result.timestamp).toBeDefined();
    });

    it('throws 404 when alert not found', async () => {
      vi.mocked(service.generateAlertInclusionProof).mockRejectedValue(
        new Error('Alert alert-123 not found in delivered alerts for date 2026-08-30')
      );

      try {
        await controller.getInclusionProof('alert-123', '2026-08-30');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
      }
    });

    it('throws error for invalid date format', async () => {
      await expect(controller.getInclusionProof('alert-123', 'bad-date')).rejects.toThrow(
        HttpException
      );
    });
  });

  describe('POST /audit/verify', () => {
    it('verifies a valid Merkle proof', async () => {
      const proof: MerkleProof = {
        leafHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        path: [],
      };
      const root = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      vi.mocked(service.verifyAlertInclusion).mockReturnValue(true);

      const result = await controller.verifyProof({
        alertId: 'alert-123',
        proof,
        expectedRoot: root,
      });

      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.alertId).toBe('alert-123');
    });

    it('returns false for invalid proof', async () => {
      const proof: MerkleProof = {
        leafHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        path: [],
      };
      const root = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      vi.mocked(service.verifyAlertInclusion).mockReturnValue(false);

      const result = await controller.verifyProof({
        alertId: 'alert-123',
        proof,
        expectedRoot: root,
      });

      expect(result.success).toBe(true);
      expect(result.verified).toBe(false);
    });

    it('throws error when required fields are missing', async () => {
      await expect(
        controller.verifyProof({
          alertId: '',
          proof: { leafHash: '', path: [] },
          expectedRoot: '',
        })
      ).rejects.toThrow(HttpException);
    });
  });

  describe('POST /audit/commit', () => {
    it('stores and returns Merkle root commitment', async () => {
      const mockCommitment = {
        id: 'commit-uuid',
        date: '2026-08-30',
        root: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        treeSize: 5,
      };

      vi.mocked(service.storeDailyMerkleCommitment).mockResolvedValue(mockCommitment);

      const result = await controller.commitMerkleRoot({
        date: '2026-08-30',
        root: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        treeSize: 5,
      });

      expect(result.success).toBe(true);
      expect(result.commitment).toEqual(mockCommitment);
    });

    it('throws error for invalid date format', async () => {
      await expect(
        controller.commitMerkleRoot({
          date: 'not-a-date',
          root: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          treeSize: 5,
        })
      ).rejects.toThrow(HttpException);
    });

    it('throws error when fields are missing', async () => {
      await expect(
        controller.commitMerkleRoot({
          date: '2026-08-30',
          root: '',
          treeSize: 0,
        })
      ).rejects.toThrow(HttpException);
    });
  });

  describe('Date Validation', () => {
    it('accepts valid ISO date formats', async () => {
      vi.mocked(service.generateDailyMerkleRoot).mockResolvedValue({
        root: 'aa',
        treeSize: 1,
      });

      await expect(controller.getMerkleRoot('2026-08-30')).resolves.toBeDefined();
      await expect(controller.getMerkleRoot('2025-01-01')).resolves.toBeDefined();
      await expect(controller.getMerkleRoot('2099-12-31')).resolves.toBeDefined();
    });

    it('rejects invalid date formats', async () => {
      const invalidDates = [
        '2026/08/30',
        '08-30-2026',
        '30-08-2026',
        '2026-13-01',
        '2026-08-32',
        'not-a-date',
        '',
      ];

      for (const date of invalidDates) {
        await expect(controller.getMerkleRoot(date)).rejects.toThrow(HttpException);
      }
    });
  });
});
