import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from '../auth.service';
import { generateMagicToken } from '../../../utils/jwt';

const mockRedisStore = new Map<string, string>();
const mockRedis = vi.hoisted(() => ({
  set: vi.fn(async (key: string, val: string) => {
    mockRedisStore.set(key, val);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => {
    return mockRedisStore.get(key) ?? null;
  }),
  del: vi.fn(async (key: string) => {
    return mockRedisStore.delete(key) ? 1 : 0;
  }),
}));

vi.mock('../../../config/env', () => ({
  env: {
    JWT_SECRET: 'test-super-secret-jwt-key-12345',
  },
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    user: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../../lib/redis', () => ({
  redis: mockRedis,
}));

import { prisma } from '../../../lib/prisma';

describe('AuthService', () => {
  let authService: AuthService;

  beforeEach(() => {
    authService = new AuthService();
    vi.clearAllMocks();
    mockRedisStore.clear();
  });

  describe('requestMagicLink', () => {
    it('should return a valid magic token string', async () => {
      const email = 'maintainer@stellar-alerts.org';
      const token = await authService.requestMagicLink(email);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(20);
    });
  });

  describe('verifyMagicLink', () => {
    it('should successfully verify a valid magic token and upsert user', async () => {
      const email = 'maintainer@stellar-alerts.org';
      const magicToken = await authService.requestMagicLink(email);

      const mockUser = { id: 'user_cuid_123', email, createdAt: new Date() };
      (prisma.user.upsert as any).mockResolvedValue(mockUser);

      const result = await authService.verifyMagicLink(magicToken);

      expect(prisma.user.upsert).toHaveBeenCalledWith({
        where: { email },
        update: {},
        create: { email },
      });
      expect(result.user).toEqual({ id: mockUser.id, email: mockUser.email });
      expect(typeof result.token).toBe('string');
    });

    it('rejects a second verification of the same magic token (single use)', async () => {
      const email = 'replay@stellar-alerts.org';
      const magicToken = await authService.requestMagicLink(email);
      (prisma.user.upsert as any).mockResolvedValue({ id: 'u1', email });

      await expect(authService.verifyMagicLink(magicToken)).resolves.toBeDefined();
      await expect(authService.verifyMagicLink(magicToken)).rejects.toThrow('Invalid or expired token');
      expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
    });

    it('allows only one of two concurrent verifications to succeed', async () => {
      const email = 'race@stellar-alerts.org';
      const magicToken = await authService.requestMagicLink(email);
      (prisma.user.upsert as any).mockResolvedValue({ id: 'u2', email });

      const results = await Promise.allSettled([
        authService.verifyMagicLink(magicToken),
        authService.verifyMagicLink(magicToken),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('fails closed in production when Redis cannot confirm token consumption', async () => {
      const magicToken = await authService.requestMagicLink('down@stellar-alerts.org');
      mockRedis.del.mockRejectedValueOnce(new Error('redis down'));
      vi.stubEnv('NODE_ENV', 'production');

      try {
        await expect(authService.verifyMagicLink(magicToken)).rejects.toThrow('Invalid or expired token');
        expect(prisma.user.upsert).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('should throw error for an invalid magic token', async () => {
      await expect(authService.verifyMagicLink('invalid.token.str')).rejects.toThrow(
        'Invalid or expired token'
      );
    });
  });

  describe('getMe', () => {
    it('should return user profile with wallets and notifyPrefs', async () => {
      const userId = 'user_cuid_123';
      const mockUser = {
        id: userId,
        email: 'user@stellar.org',
        wallets: [],
        notifyPrefs: null,
      };

      (prisma.user.findUnique as any).mockResolvedValue(mockUser);

      const user = await authService.getMe(userId);
      expect(user).toEqual(mockUser);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: userId },
        include: { wallets: true, notifyPrefs: true },
      });
    });

    it('should throw error if user is not found', async () => {
      (prisma.user.findUnique as any).mockResolvedValue(null);
      await expect(authService.getMe('nonexistent_id')).rejects.toThrow('User not found');
    });
  });
});
