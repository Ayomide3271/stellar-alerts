import crypto from 'cypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pin the bot token deterministically so the signed initData fixtures below do
// not depend on whatever TELEGRAM_BOT_TOKEN the CI environment injects.
const { BOT_TOKEN } = vi.hoisted(() => ({ BOT_TOKEN: 'test-bot-token:AAABBB' }));

vi.mock('../../../config/env', () => ({
  env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN },
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    user: { upsert: vi.fn() },
    notificationPreference: { findUnique: vi.fn(), upsert: vi.fn() },
    notificationDelivery: { findMany: vi.fn() },
  },
}));

import {
  TelegramMiniAppService,
  applyAssetThreshold,
  readAssetThresholds,
  normalizeFeedLimit,
  isMiniAppRoute,
  routeToPreferenceField,
  MINIAPP_ROUTE_FIELDS,
} from '../telegram-miniapp.service';
import { TelegramInitDataError } from '../../../utils/telegram';
import { prisma } from '../../../lib/prisma';

/** Builds a correctly-signed initData string for the given fields. */
function signInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.keys()]
    .sort()
    .map((k) => `${k}=${params.get(k)}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

describe('TelegramMiniAppService pure helpers (#1006)', () => {
  describe('route mapping', () => {
    it('maps every supported route to its preference column', () => {
      expect(routeToPreferenceField('telegram')).toBe('telegramEnabled');
      expect(routeToPreferenceField('push')).toBe('pushEnabled');
      expect(Object.keys(MINIAPP_ROUTE_FIELDS)).toContain('slack');
    });

    it('recognises only known routes', () => {
      expect(isMiniAppRoute('email')).toBe(true);
      expect(isMiniAppRoute('carrier-pigeon')).toBe(false);
      expect(isMiniAppRoute(42)).toBe(false);
    });
  });

  describe('applyAssetThreshold', () => {
    it('adds a threshold and upper-cases the asset code', () => {
      const result = applyAssetThreshold(null, 'usdc', 100);
      expect(result.assetThresholds).toEqual({ USDC: 100 });
    });

    it('preserves other filterRules keys', () => {
      const result = applyAssetThreshold({ group: 'AND', assetThresholds: { XLM: 5 } }, 'usdc', 10);
      expect(result.group).toBe('AND');
      expect(result.assetThresholds).toEqual({ XLM: 5, USDC: 10 });
    });

    it('clears a threshold when minAmount is null or invalid', () => {
      const seeded = { assetThresholds: { USDC: 100, XLM: 5 } };
      expect(applyAssetThreshold(seeded, 'usdc', null).assetThresholds).toEqual({ XLM: 5 });
      expect(applyAssetThreshold(seeded, 'usdc', -1).assetThresholds).toEqual({ XLM: 5 });
      expect(applyAssetThreshold(seeded, 'usdc', NaN).assetThresholds).toEqual({ XLM: 5 });
    });
  });

  describe('readAssetThresholds', () => {
    it('returns a sorted list, ignoring non-numeric values', () => {
      const result = readAssetThresholds({ assetThresholds: { USDC: 100, XLM: 5, BAD: 'x' } });
      expect(result).toEqual([
        { asset: 'USDC', minAmount: 100 },
        { asset: 'XLM', minAmount: 5 },
      ]);
    });

    it('returns an empty list for missing/invalid blobs', () => {
      expect(readAssetThresholds(null)).toEqual([]);
      expect(readAssetThresholds({})).toEqual([]);
      expect(readAssetThresholds([1, 2, 3])).toEqual([]);
    });
  });

  describe('normalizeFeedLimit', () => {
    it('applies default, floor and ceiling', () => {
      expect(normalizeFeedLimit(undefined)).toBe(20);
      expect(normalizeFeedLimit(0)).toBe(20);
      expect(normalizeFeedLimit(-5)).toBe(20);
      expect(normalizeFeedLimit(500)).toBe(100);
      expect(normalizeFeedLimit('7')).toBe(7);
    });
  });
});

describe('TelegramMiniAppService.authenticate (#1006)', () => {
  let service: TelegramMiniAppService;

  beforeEach(() => {
    service = new TelegramMiniAppService();
    vi.clearAllMocks();
  });

  it('rejects a tampered signature without touching the database', async () => {
    const good = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42, first_name: 'Ada' }),
    });
    const tampered = good.replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));

    await expect(service.authenticate(tampered)).rejects.toBeInstanceOf(TelegramInitDataError);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('verifies a valid signature and resolves the synthetic user', async () => {
    vi.mocked(prisma.user.upsert).mockResolvedValue({ id: 'u-42' } as any);
    const initData = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42, first_name: 'Ada' }),
    });

    const session = await service.authenticate(initData);

    expect(session.userId).toBe('u-42');
    expect(session.telegram.id).toBe(42);
    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'tg_42@telegram.stellar-alerts.org' } }),
    );
  });
});

describe('TelegramMiniAppService route + threshold mutations (#1006)', () => {
  let service: TelegramMiniAppService;

  beforeEach(() => {
    service = new TelegramMiniAppService();
    vi.clearAllMocks();
  });

  it('toggles a route via upsert on the correct column', async () => {
    vi.mocked(prisma.notificationPreference.upsert).mockResolvedValue({} as any);
    const result = await service.toggleRoute('u-1', 'discord', true);

    expect(result).toEqual({ route: 'discord', enabled: true });
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u-1' },
        update: { discordEnabled: true },
      }),
    );
  });

  it('merges a new asset threshold into existing filterRules', async () => {
    vi.mocked(prisma.notificationPreference.findUnique).mockResolvedValue({
      filterRules: { assetThresholds: { XLM: 5 } },
    } as any);
    vi.mocked(prisma.notificationPreference.upsert).mockResolvedValue({} as any);

    const result = await service.setAssetThreshold('u-1', 'usdc', 250);

    expect(result).toEqual([
      { asset: 'USDC', minAmount: 250 },
      { asset: 'XLM', minAmount: 5 },
    ]);
  });
});
