import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock stellar-sdk BEFORE importing soroban so TransactionBuilder.fromXDR
// is controlled in all simulateTransaction tests.
// ---------------------------------------------------------------------------
vi.mock('stellar-sdk', async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    TransactionBuilder: {
      ...original.TransactionBuilder,
      fromXDR: vi.fn().mockReturnValue({ fee: '100', toXDR: () => 'mock-xdr' }),
    },
  };
});

import {
  stroopsToXlm,
  parseLedgerFootprint,
  buildRentBreakdown,
  simulateTransaction,
  sorobanServer,
  SorobanFeeEstimate,
} from '../../../lib/soroban';

// ---------------------------------------------------------------------------
// stroopsToXlm
// ---------------------------------------------------------------------------
describe('stroopsToXlm', () => {
  it('converts zero stroops to 0.0000000 XLM', () => {
    expect(stroopsToXlm('0')).toBe('0.0000000');
  });

  it('converts 10_000_000 stroops to exactly 1 XLM', () => {
    expect(stroopsToXlm('10000000')).toBe('1.0000000');
  });

  it('converts 1 stroop to 0.0000001 XLM', () => {
    expect(stroopsToXlm('1')).toBe('0.0000001');
  });

  it('converts 15_000_000 stroops to 1.5000000 XLM', () => {
    expect(stroopsToXlm('15000000')).toBe('1.5000000');
  });

  it('accepts a numeric argument', () => {
    expect(stroopsToXlm(10_000_000)).toBe('1.0000000');
  });

  it('converts large fee values (e.g. 123_456_789 stroops)', () => {
    expect(stroopsToXlm('123456789')).toBe('12.3456789');
  });
});

// ---------------------------------------------------------------------------
// parseLedgerFootprint
// ---------------------------------------------------------------------------
describe('parseLedgerFootprint', () => {
  it('returns empty arrays when simulationResult is null', () => {
    const { readFootprint, writeFootprint } = parseLedgerFootprint(null);
    expect(readFootprint).toEqual([]);
    expect(writeFootprint).toEqual([]);
  });

  it('returns empty arrays when simulationResult has no transactionData', () => {
    const { readFootprint, writeFootprint } = parseLedgerFootprint({});
    expect(readFootprint).toEqual([]);
    expect(writeFootprint).toEqual([]);
  });

  it('parses read-only entries from a mock footprint (function-based API)', () => {
    const mockReadOnlyKey = {
      toXDR: (_fmt: string) => 'deadbeef01',
      switch: () => ({ name: 'ledgerKeyContractData' }),
      contractData: () => ({ durability: () => ({ name: 'persistent' }) }),
    };
    const mockReadWriteKey = {
      toXDR: (_fmt: string) => 'cafebabe02',
      switch: () => ({ name: 'temporary' }),
    };

    const mockSimResult = {
      transactionData: {
        value: () => ({
          footprint: () => ({
            readOnly: () => [mockReadOnlyKey],
            readWrite: () => [mockReadWriteKey],
          }),
        }),
      },
    };

    const { readFootprint, writeFootprint } = parseLedgerFootprint(mockSimResult);

    expect(readFootprint).toHaveLength(1);
    expect(readFootprint[0].key).toBe('deadbeef01');
    expect(readFootprint[0].durability).toBe('persistent');

    expect(writeFootprint).toHaveLength(1);
    expect(writeFootprint[0].key).toBe('cafebabe02');
    expect(writeFootprint[0].durability).toBe('temporary');
  });

  it('parses footprint from plain-object (non-function) transactionData', () => {
    const mockSimResult = {
      transactionData: {
        footprint: {
          readOnly: [
            {
              toXDR: (_fmt: string) => 'aabbcc01',
              switch: () => ({ name: 'ledgerKeyContractCode' }),
            },
          ],
          readWrite: [],
        },
      },
    };

    const { readFootprint, writeFootprint } = parseLedgerFootprint(mockSimResult);
    expect(readFootprint).toHaveLength(1);
    expect(readFootprint[0].key).toBe('aabbcc01');
    expect(writeFootprint).toHaveLength(0);
  });

  it('marks entries as temporary when discriminant name contains "temp"', () => {
    const tmpKey = {
      toXDR: (_fmt: string) => 'tmp001',
      switch: () => ({ name: 'temporary' }),
    };

    const mockSimResult = {
      transactionData: {
        footprint: {
          readOnly: [tmpKey],
          readWrite: [],
        },
      },
    };

    const { readFootprint } = parseLedgerFootprint(mockSimResult);
    expect(readFootprint[0].durability).toBe('temporary');
  });

  it('defaults durability to persistent when switch name is unrecognised', () => {
    const persistentKey = {
      toXDR: (_fmt: string) => 'per001',
      switch: () => ({ name: 'ledgerKeyContractCode' }),
    };

    const mockSimResult = {
      transactionData: {
        footprint: {
          readOnly: [persistentKey],
          readWrite: [],
        },
      },
    };

    const { readFootprint } = parseLedgerFootprint(mockSimResult);
    expect(readFootprint[0].durability).toBe('persistent');
  });

  it('tolerates a broken footprint without throwing', () => {
    const badSimResult = {
      transactionData: {
        value: () => {
          throw new Error('xdr explosion');
        },
      },
    };
    expect(() => parseLedgerFootprint(badSimResult)).not.toThrow();
    const { readFootprint, writeFootprint } = parseLedgerFootprint(badSimResult);
    expect(readFootprint).toEqual([]);
    expect(writeFootprint).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// simulateTransaction – spy on sorobanServer.simulateTransaction directly
// ---------------------------------------------------------------------------
describe('simulateTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success:false with error message when RPC returns an error field', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({
      error: 'HostError: contract trap',
    } as any);

    const result = await simulateTransaction('FAKE_XDR==');
    expect(result.success).toBe(false);
    expect(result.error).toContain('HostError');
    expect(result.totalFeeStroops).toBe('0');
  });

  it('returns success:false when simulateTransaction throws', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockRejectedValue(
      new Error('Network timeout')
    );

    const result = await simulateTransaction('FAKE_XDR==');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Network timeout');
  });

  it('returns structured fee estimate on successful simulation', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({
      minResourceFee: '5000000',
      transactionData: {
        footprint: {
          readOnly: [
            {
              toXDR: (_f: string) => 'ro001',
              switch: () => ({ name: 'ledgerKeyContractData' }),
              contractData: () => ({ durability: () => ({ name: 'persistent' }) }),
            },
          ],
          readWrite: [
            {
              toXDR: (_f: string) => 'rw001',
              switch: () => ({ name: 'temporary' }),
            },
          ],
        },
      },
    } as any);

    const result: SorobanFeeEstimate = await simulateTransaction('FAKE_XDR==');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Resource fee should match minResourceFee
    expect(result.resourceFeeStroops).toBe('5000000');

    // Total = inclusionFee (100 from mock tx.fee) + resourceFee (5000000)
    expect(BigInt(result.totalFeeStroops)).toBe(BigInt(100) + BigInt(5000000));

    // XLM conversion: 5000100 / 10_000_000 = 0.5000100
    expect(result.totalFeeXlm).toBe('0.5000100');

    // Rent fee ≈ 30% of resource fee
    const rentFee = (BigInt(5000000) * BigInt(30)) / BigInt(100);
    expect(BigInt(result.rentFeeStroops)).toBe(rentFee);

    // Footprint counts
    expect(result.readCount).toBe(1);
    expect(result.writeCount).toBe(1);
    expect(result.readFootprint[0].key).toBe('ro001');
    expect(result.readFootprint[0].durability).toBe('persistent');
    expect(result.writeFootprint[0].key).toBe('rw001');
    expect(result.writeFootprint[0].durability).toBe('temporary');
  });

  it('handles simulation with zero resource fee', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({
      minResourceFee: '0',
      transactionData: null,
    } as any);

    const result = await simulateTransaction('FAKE_XDR==');

    expect(result.success).toBe(true);
    expect(result.resourceFeeStroops).toBe('0');
    expect(result.rentFeeStroops).toBe('0');
    expect(result.readCount).toBe(0);
    expect(result.writeCount).toBe(0);
  });

  it('returns correct XLM conversion for 10_000_100 total stroops', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({
      minResourceFee: '10000000', // exactly 1 XLM resource fee
      transactionData: null,
    } as any);

    const result = await simulateTransaction('FAKE_XDR==');
    // inclusion 100 + resource 10_000_000 = 10_000_100 stroops = 1.0000100 XLM
    expect(result.totalFeeXlm).toBe('1.0000100');
  });
});

// ---------------------------------------------------------------------------
// buildRentBreakdown – persistent vs temporary apportioning
// ---------------------------------------------------------------------------
describe('buildRentBreakdown', () => {
  const persistent = { key: 'p', durability: 'persistent' as const };
  const temporary = { key: 't', durability: 'temporary' as const };

  it('attributes all rent to persistent storage when there are no writes', () => {
    const b = buildRentBreakdown(BigInt(1000), []);
    expect(b.persistentStroops).toBe('1000');
    expect(b.temporaryStroops).toBe('0');
  });

  it('weights persistent entries at twice the temporary rate', () => {
    const b = buildRentBreakdown(BigInt(900), [persistent, temporary]);
    expect(b.persistentEntries).toBe(1);
    expect(b.temporaryEntries).toBe(1);
    expect(b.temporaryStroops).toBe('300');
    expect(b.persistentStroops).toBe('600');
  });

  it('always sums to the total rent fee and reports XLM', () => {
    const b = buildRentBreakdown(BigInt(10_000_001), [persistent, persistent, temporary]);
    expect(BigInt(b.persistentStroops) + BigInt(b.temporaryStroops)).toBe(BigInt(10_000_001));
    expect(b.persistentXlm).toMatch(/^\d+\.\d{7}$/);
  });
});
