import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import {
  parseSorobanTransferEvent,
  fetchSacMetadataFromRpc,
  getSacMetadata,
  simulateContractCall,
  formatSacAmountWithDiscovery,
  withSacDecimals,
  sorobanServer,
} from '../../lib/soroban';
import * as cache from '../../lib/cache';

describe('Soroban RPC Event & SAC Metadata Discovery Utilities', () => {
  beforeEach(() => {
    cache.clearMemoryCache();
    vi.restoreAllMocks();
  });

  describe('parseSorobanTransferEvent', () => {
    it('should return null when event payload is invalid or missing topics', () => {
      expect(parseSorobanTransferEvent(null)).toBeNull();
      expect(parseSorobanTransferEvent({})).toBeNull();
      expect(parseSorobanTransferEvent({ topic: [] })).toBeNull();
    });

    it('should parse valid Soroban contract transfer event', () => {
      const mockEvent = {
        contractId: 'CA3D525ZJGCS2JA7SXG5E5Z265WJCCAKTHR5EEXY355E55E55E55E55E',
        topic: ['transfer'],
        value: {
          from: 'GBRPYHIL2CI3FNQ4BXLFMNDLFPPPU2HY4ZDM4T6VKFZ4MVEXDHJA5W5T',
          to: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSFMG4BVI',
          amount: 500000000,
        },
      };

      const parsed = parseSorobanTransferEvent(mockEvent);
      expect(parsed).not.toBeNull();
      expect(parsed?.contractId).toBe(mockEvent.contractId);
      expect(parsed?.topic).toBe('transfer');
      expect(parsed?.from).toBe(mockEvent.value.from);
      expect(parsed?.to).toBe(mockEvent.value.to);
      expect(parsed?.amount).toBe('500000000');
    });
  });

  describe('simulateContractCall', () => {
    it('returns null if contractId is empty', async () => {
      const result = await simulateContractCall('', 'decimals');
      expect(result).toBeNull();
    });

    it('simulates contract call and decodes ScVal return value', async () => {
      const validContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 1));
      const mockRetval = StellarSdk.nativeToScVal(6, { type: 'u32' });

      vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({
        result: {
          retval: mockRetval,
        },
      } as any);

      const result = await simulateContractCall(validContractId, 'decimals');
      expect(result).toBe(6);
    });

    it('returns null if simulation fails or throws', async () => {
      const validContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 1));
      vi.spyOn(sorobanServer, 'simulateTransaction').mockRejectedValue(new Error('RPC Timeout'));

      const result = await simulateContractCall(validContractId, 'decimals');
      expect(result).toBeNull();
    });
  });

  describe('fetchSacMetadataFromRpc', () => {
    it('fetches and parses decimals, symbol, and name for SAC contract', async () => {
      const validContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 2));

      vi.spyOn(sorobanServer, 'simulateTransaction').mockImplementation(async (tx: any) => {
        // Inspect operation method name or mock sequential responses
        return {
          result: {
            retval: StellarSdk.nativeToScVal(6, { type: 'u32' }),
          },
        } as any;
      });

      // Mock specific responses for decimals, symbol, and name
      vi.spyOn(sorobanServer, 'simulateTransaction')
        .mockResolvedValueOnce({
          result: { retval: StellarSdk.nativeToScVal(6, { type: 'u32' }) },
        } as any)
        .mockResolvedValueOnce({
          result: { retval: StellarSdk.nativeToScVal('USDC', { type: 'string' }) },
        } as any)
        .mockResolvedValueOnce({
          result: { retval: StellarSdk.nativeToScVal('USD Coin', { type: 'string' }) },
        } as any);

      const metadata = await fetchSacMetadataFromRpc(validContractId);
      expect(metadata.contractId).toBe(validContractId);
      expect(metadata.decimals).toBe(6);
      expect(metadata.symbol).toBe('USDC');
      expect(metadata.name).toBe('USD Coin');
    });

    it('falls back to default decimals (7) and symbol if RPC simulation returns null', async () => {
      const validContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 3));
      vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue(null as any);

      const metadata = await fetchSacMetadataFromRpc(validContractId);
      expect(metadata.decimals).toBe(7);
      expect(metadata.symbol).toBe(validContractId.substring(0, 8));
      expect(metadata.name).toBe('Unknown Token');
    });
  });

  describe('getSacMetadata & Redis Caching (24h TTL)', () => {
    it('fetches on cache miss and stores in Redis for 24h', async () => {
      const validContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 4));

      vi.spyOn(sorobanServer, 'simulateTransaction')
        .mockResolvedValueOnce({
          result: { retval: StellarSdk.nativeToScVal(18, { type: 'u32' }) },
        } as any)
        .mockResolvedValueOnce({
          result: { retval: StellarSdk.nativeToScVal('ETH', { type: 'string' }) },
        } as any)
        .mockResolvedValueOnce({
          result: { retval: StellarSdk.nativeToScVal('Wrapped Ethereum', { type: 'string' }) },
        } as any);

      const setJsonSpy = vi.spyOn(cache, 'setJson');

      // 1. First call -> Cache Miss -> Queries RPC
      const metadata = await getSacMetadata(validContractId);
      expect(metadata.decimals).toBe(18);
      expect(metadata.symbol).toBe('ETH');
      expect(setJsonSpy).toHaveBeenCalledWith(
        `sac:metadata:${validContractId}`,
        metadata,
        86400 // 24h TTL
      );

      // 2. Second call -> Cache Hit -> Does NOT query RPC again
      const simulateSpy = vi.spyOn(sorobanServer, 'simulateTransaction');
      const cachedMetadata = await getSacMetadata(validContractId);
      expect(cachedMetadata).toEqual(metadata);
      expect(simulateSpy).not.toHaveBeenCalled();
    });

    it('forces refresh when forceRefresh flag is true', async () => {
      const validContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 5));

      // Seed cache
      await cache.setJson(`sac:metadata:${validContractId}`, {
        contractId: validContractId,
        decimals: 6,
        symbol: 'OLD',
        name: 'Old Token',
      });

      vi.spyOn(sorobanServer, 'simulateTransaction')
        .mockResolvedValueOnce({
          result: { retval: StellarSdk.nativeToScVal(8, { type: 'u32' }) },
        } as any)
        .mockResolvedValueOnce({
          result: { retval: StellarSdk.nativeToScVal('NEW', { type: 'string' }) },
        } as any)
        .mockResolvedValueOnce({
          result: { retval: StellarSdk.nativeToScVal('New Token', { type: 'string' }) },
        } as any);

      const refreshed = await getSacMetadata(validContractId, true);
      expect(refreshed.symbol).toBe('NEW');
      expect(refreshed.decimals).toBe(8);
    });
  });

  describe('formatSacAmountWithDiscovery', () => {
    it('formats amount according to discovered contract decimals', async () => {
      const usdcContract = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 6));

      await cache.setJson(`sac:metadata:${usdcContract}`, {
        contractId: usdcContract,
        decimals: 6,
        symbol: 'USDC',
        name: 'USD Coin',
      });

      // 10,000,000 raw units with 6 decimals = 10 USDC
      const result = await formatSacAmountWithDiscovery('10000000', usdcContract);
      expect(result.formattedAmount).toBe('10');
      expect(result.metadata.symbol).toBe('USDC');
      expect(result.metadata.decimals).toBe(6);

      // 1,500,000 raw units with 6 decimals = 1.5 USDC
      const result2 = await formatSacAmountWithDiscovery('1500000', usdcContract);
      expect(result2.formattedAmount).toBe('1.5');
    });

    it('formats 18-decimal token amounts accurately', async () => {
      const wethContract = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 7));

      await cache.setJson(`sac:metadata:${wethContract}`, {
        contractId: wethContract,
        decimals: 18,
        symbol: 'WETH',
        name: 'Wrapped Ether',
      });

      // 1.5 * 10^18 raw units with 18 decimals = 1.5 WETH
      const result = await formatSacAmountWithDiscovery('1500000000000000000', wethContract);
      expect(result.formattedAmount).toBe('1.5');
      expect(result.metadata.symbol).toBe('WETH');
    });
  });
  describe('failed discovery & decimal enrichment', () => {
    it('caches a failed discovery only briefly so wrong decimals are not pinned for 24h', async () => {
      const contractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 8));
      vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue(null as any);
      const setJsonSpy = vi.spyOn(cache, 'setJson');

      const metadata = await getSacMetadata(contractId);
      expect(metadata.decimals).toBe(7);
      expect(setJsonSpy).toHaveBeenCalledWith(`sac:metadata:${contractId}`, metadata, 60);
    });

    it('shares one RPC discovery between concurrent lookups', async () => {
      const contractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 9));
      const simulateSpy = vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({
        result: { retval: StellarSdk.nativeToScVal(6, { type: 'u32' }) },
      } as any);

      const [a, b] = await Promise.all([getSacMetadata(contractId), getSacMetadata(contractId)]);
      expect(a).toEqual(b);
      // decimals + symbol + name, once
      expect(simulateSpy).toHaveBeenCalledTimes(3);
    });

    it('withSacDecimals re-formats the raw amount using the token decimals', async () => {
      const contractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 10));
      await cache.setJson(`sac:metadata:${contractId}`, {
        contractId,
        decimals: 6,
        symbol: 'USDC',
        name: 'USD Coin',
      });

      const out = await withSacDecimals({ contractId, amount: '10', rawAmount: 10_000_000n });
      expect(out.amount).toBe('10');

      const out2 = await withSacDecimals({ contractId, amount: '0.15', rawAmount: 1_500_000n });
      expect(out2.amount).toBe('1.5');
    });
  });
});
