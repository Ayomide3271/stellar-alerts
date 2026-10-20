import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import { WalletsController } from '../wallets.controller';
import { walletsService } from '../wallets.service';
import { ConflictError, NotFoundError, ValidationError } from '../../../lib/errors';

vi.mock('../wallets.service', () => ({
  walletsService: {
    addWallet: vi.fn(),
    getWallets: vi.fn(),
    getIngestionStatus: vi.fn(),
    removeWallet: vi.fn(),
  },
}));

describe('WalletsController', () => {
  let walletsController: WalletsController;
  let mockRequest: any;
  let mockReply: any;

  beforeEach(() => {
    walletsController = new WalletsController();
    vi.clearAllMocks();

    mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
  });

  describe('addWallet', () => {
    it('returns status 201 when wallet is added successfully', async () => {
      mockRequest = {
        user: { id: 'u-1' },
        body: {
          publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
          label: 'Test Wallet',
        },
      };

      const mockWallet = { id: 'w-1', publicKey: mockRequest.body.publicKey };
      vi.mocked(walletsService.addWallet).mockResolvedValue(mockWallet as any);

      await walletsController.addWallet(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(201);
      expect(mockReply.send).toHaveBeenCalledWith({ success: true, wallet: mockWallet });
    });

    it('returns status 409 Conflict when duplicate wallet registration occurs', async () => {
      mockRequest = {
        user: { id: 'u-1' },
        body: {
          publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
        },
      };

      vi.mocked(walletsService.addWallet).mockRejectedValue(new Error('Wallet already exists'));

      const error = await walletsController.addWallet(mockRequest, mockReply).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictError);
      expect(error.statusCode).toBe(409);
      expect(error.message).toBe('Wallet address is already registered');
    });

    it('returns status 400 Bad Request when payload is invalid', async () => {
      mockRequest = {
        user: { id: 'u-1' },
        body: {
          publicKey: 'INVALID_STELLAR_ADDRESS',
        },
      };

      const error = await walletsController.addWallet(mockRequest, mockReply).catch((e) => e);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Invalid payload');
    });

    it('rejects a well-formed public key with a bad CRC16 checksum before any DB write', async () => {
      const valid = StellarSdk.Keypair.random().publicKey();
      const corrupted = valid.slice(0, -1) + (valid.at(-1) === 'A' ? 'B' : 'A');
      expect(StellarSdk.StrKey.isValidEd25519PublicKey(corrupted)).toBe(false);
      mockRequest = { user: { id: 'u-1' }, body: { publicKey: corrupted } };

      const error = await walletsController.addWallet(mockRequest, mockReply).catch((e) => e);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.statusCode).toBe(400);
      expect(walletsService.addWallet).not.toHaveBeenCalled();
    });
  });

  describe('getIngestionStatus', () => {
    it('returns cursor health for the requested wallet', async () => {
      mockRequest = { user: { id: 'u-1' }, params: { id: 'w-1' } };
      const ingestion = { walletId: 'w-1', status: 'active', consecutiveFailures: 0 };
      vi.mocked(walletsService.getIngestionStatus).mockResolvedValue(ingestion as any);

      await walletsController.getIngestionStatus(mockRequest, mockReply);

      expect(walletsService.getIngestionStatus).toHaveBeenCalledWith('u-1', 'w-1');
      expect(mockReply.send).toHaveBeenCalledWith({ success: true, ingestion });
    });

    it('returns 404 when the wallet does not exist or is not owned by the requester', async () => {
      mockRequest = { user: { id: 'u-1' }, params: { id: 'w-missing' } };
      vi.mocked(walletsService.getIngestionStatus).mockRejectedValue(new Error('Wallet not found'));

      const error = await walletsController.getIngestionStatus(mockRequest, mockReply).catch((e) => e);

      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('Wallet not found');
    });
  });

  describe('deleteWallet', () => {
    it('returns success: true and forwards userId and walletId to service', async () => {
      mockRequest = { user: { id: 'u-1' }, params: { id: 'w-1' } };
      vi.mocked(walletsService.removeWallet).mockResolvedValue({ success: true });

      await walletsController.deleteWallet(mockRequest, mockReply);

      expect(walletsService.removeWallet).toHaveBeenCalledWith('u-1', 'w-1');
      expect(mockReply.send).toHaveBeenCalledWith({ success: true });
    });

    it('returns 404 NotFoundError when the wallet does not belong to the user', async () => {
      mockRequest = { user: { id: 'u-1' }, params: { id: 'w-other' } };
      vi.mocked(walletsService.removeWallet).mockRejectedValue(new Error('Wallet not found'));

      const error = await walletsController.deleteWallet(mockRequest, mockReply).catch((e) => e);

      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('Wallet not found');
    });

    it('returns 400 ValidationError when wallet id param is invalid', async () => {
      mockRequest = { user: { id: 'u-1' }, params: { id: 123 } };

      const error = await walletsController.deleteWallet(mockRequest, mockReply).catch((e) => e);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.statusCode).toBe(400);
    });
  });
});
