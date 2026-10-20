import { Readable, Transform } from 'stream';
import { prisma } from '../../lib/prisma';

export type ExportFormat = 'csv' | 'ndjson';

export const EXPORT_BATCH_SIZE = 500;

export const CSV_COLUMNS = [
  'id',
  'txHash',
  'fromAddress',
  'amount',
  'asset',
  'assetIssuer',
  'memo',
  'receivedAt',
] as const;

export interface ExportRow {
  id: string;
  txHash: string;
  fromAddress: string;
  amount: { toString(): string } | string | number;
  asset: string;
  assetIssuer: string | null;
  memo: string | null;
  receivedAt: Date;
}

/** Escape one CSV field per RFC 4180 and neutralise spreadsheet formula injection. */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function toRecord(row: ExportRow) {
  return {
    id: row.id,
    txHash: row.txHash,
    fromAddress: row.fromAddress,
    amount: row.amount.toString(),
    asset: row.asset,
    assetIssuer: row.assetIssuer,
    memo: row.memo,
    receivedAt: row.receivedAt.toISOString(),
  };
}

export class ExportService {
  async findWallet(userId: string, walletId: string) {
    return prisma.wallet.findFirst({
      where: { id: walletId, userId },
      select: { id: true, publicKey: true },
    });
  }

  /** Keyset-paginated async iterator: only one batch is ever held in memory. */
  async *iteratePayments(walletId: string, batchSize = EXPORT_BATCH_SIZE): AsyncGenerator<ExportRow> {
    let cursor: string | undefined;
    for (;;) {
      const batch: ExportRow[] = await prisma.payment.findMany({
        where: { walletId },
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of batch) yield row;
      if (batch.length < batchSize) return;
      cursor = batch[batch.length - 1].id;
    }
  }

  /** Object-mode rows in, string chunks out. */
  createFormatter(format: ExportFormat): Transform {
    let first = true;
    return new Transform({
      writableObjectMode: true,
      readableObjectMode: false,
      transform(row: ExportRow, _enc, cb) {
        const record = toRecord(row);
        let out = '';
        if (format === 'csv') {
          if (first) out += CSV_COLUMNS.join(',') + '\r\n';
          out += CSV_COLUMNS.map((c) => escapeCsvField(record[c])).join(',') + '\r\n';
        } else {
          out = JSON.stringify(record) + '\n';
        }
        first = false;
        cb(null, out);
      },
      flush(cb) {
        // Empty CSV exports still carry the header row.
        if (first && format === 'csv') this.push(CSV_COLUMNS.join(',') + '\r\n');
        cb();
      },
    });
  }

  createExportStream(walletId: string, format: ExportFormat, batchSize = EXPORT_BATCH_SIZE): Readable {
    const source = Readable.from(this.iteratePayments(walletId, batchSize), { objectMode: true });
    const formatter = this.createFormatter(format);
    source.on('error', (err) => formatter.destroy(err));
    return source.pipe(formatter);
  }
}

export const exportService = new ExportService();
