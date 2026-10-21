import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExportService, escapeCsvField } from '../export.service';
import { prisma } from '../../../lib/prisma';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    wallet: { findFirst: vi.fn() },
    payment: { findMany: vi.fn() },
  },
}));

const makeRow = (i: number, memo: string | null = null) => ({
  id: `p-${String(i).padStart(5, '0')}`,
  txHash: `hash${i}`,
  fromAddress: 'GABC',
  amount: { toString: () => `${i}.5000000` },
  asset: 'XLM',
  assetIssuer: null,
  memo,
  receivedAt: new Date('2025-01-01T00:00:00.000Z'),
});

function mockDataset(total: number, memoFor?: (i: number) => string | null) {
  const rows = Array.from({ length: total }, (_, i) => makeRow(i, memoFor ? memoFor(i) : null));
  vi.mocked(prisma.payment.findMany).mockImplementation((async (args: any) => {
    let start = 0;
    if (args.cursor) start = rows.findIndex((r) => r.id === args.cursor.id) + (args.skip ?? 0);
    return rows.slice(start, start + args.take);
  }) as any);
}

async function collect(stream: NodeJS.ReadableStream): Promise<string[]> {
  const chunks: string[] = [];
  for await (const c of stream) chunks.push(c.toString());
  return chunks;
}

describe('escapeCsvField', () => {
  it('escapes commas, quotes and newlines', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField(null)).toBe('');
  });

  it('neutralises formula injection', () => {
    expect(escapeCsvField('=SUM(A1)')).toBe("'=SUM(A1)");
  });
});

describe('ExportService streaming', () => {
  let service: ExportService;

  beforeEach(() => {
    service = new ExportService();
    vi.clearAllMocks();
  });

  it('streams 1,200 records as NDJSON in many chunks, batching queries', async () => {
    mockDataset(1200);
    const chunks = await collect(service.createExportStream('w-1', 'ndjson', 500));
    expect(chunks.length).toBeGreaterThan(1);
    const lines = chunks.join('').trim().split('\n');
    expect(lines).toHaveLength(1200);
    expect(JSON.parse(lines[0]).txHash).toBe('hash0');
    expect(JSON.parse(lines[1199]).amount).toBe('1199.5000000');
    expect(vi.mocked(prisma.payment.findMany)).toHaveBeenCalledTimes(3);
  });

  it('streams CSV with a single header and escaped fields', async () => {
    mockDataset(1100, (i) => (i === 1 ? 'a,"b"\nc' : null));
    const out = (await collect(service.createExportStream('w-1', 'csv', 500))).join('');
    expect(out.startsWith('id,txHash,')).toBe(true);
    expect(out.match(/^id,txHash/gm)).toHaveLength(1);
    expect(out).toContain('"a,""b""\nc"');
    expect(out.trim().split('\r\n')).toHaveLength(1101);
  });

  it('emits only the header for an empty CSV export', async () => {
    mockDataset(0);
    const out = (await collect(service.createExportStream('w-1', 'csv'))).join('');
    expect(out).toBe('id,txHash,fromAddress,amount,asset,assetIssuer,memo,receivedAt\r\n');
  });
});
