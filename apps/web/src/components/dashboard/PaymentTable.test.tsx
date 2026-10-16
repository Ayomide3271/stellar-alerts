import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PaymentTable } from './PaymentTable';
import type { PaymentDTO } from '@stellar-alerts/shared';

// jsdom doesn't implement URL.createObjectURL/revokeObjectURL at all, and its
// Blob has no .text() method either, so exportToCSV / exportToJSON's Blob
// (issue #582) is captured here via a stubbed createObjectURL and read back
// with FileReader, which jsdom does implement, to assert on the exact bytes
// the browser would actually be asked to download.
function mockObjectUrlCapture() {
  if (!('createObjectURL' in URL)) {
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () => '';
  }
  if (!('revokeObjectURL' in URL)) {
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
  }

  const blobsByUrl = new Map<string, Blob>();
  let counter = 0;

  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob) => {
    const url = `blob:mock-${counter++}`;
    blobsByUrl.set(url, blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

  return {
    async contentsOf(url: string): Promise<string> {
      const blob = blobsByUrl.get(url);
      if (!blob) throw new Error(`no blob captured for ${url}`);
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsText(blob);
      });
    },
  };
}

function makePayment(overrides: Partial<PaymentDTO> = {}): PaymentDTO {
  return {
    id: 'pay-1',
    walletId: 'wallet-1',
    txHash: 'txhash1234567890',
    fromAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOP',
    amount: 100,
    asset: 'XLM',
    memo: 'payment memo',
    receivedAt: '2026-01-15T10:30:00.000Z',
    ...overrides,
  };
}

describe('PaymentTable CSV/JSON export (issue #582)', () => {
  let capture: ReturnType<typeof mockObjectUrlCapture>;
  let anchorClicks: HTMLAnchorElement[];

  beforeEach(() => {
    capture = mockObjectUrlCapture();
    anchorClicks = [];
    // jsdom's anchor.click() doesn't trigger a real download; capture the
    // anchor at click time to read back its href/download attributes.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      anchorClicks.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables both export buttons when there are no payments', () => {
    render(<PaymentTable payments={[]} isLoading={false} />);

    expect(screen.getByRole('button', { name: /export csv/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /export json/i })).toBeDisabled();
  });

  it('enables both export buttons once payments exist', () => {
    render(<PaymentTable payments={[makePayment()]} isLoading={false} />);

    expect(screen.getByRole('button', { name: /export csv/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /export json/i })).not.toBeDisabled();
  });

  it('downloads a CSV with a header row and one row per payment', async () => {
    const payments = [
      makePayment({ id: 'pay-1', txHash: 'hash-a', amount: 100, asset: 'XLM' }),
      makePayment({ id: 'pay-2', txHash: 'hash-b', amount: 250.5, asset: 'USDC' }),
    ];
    render(<PaymentTable payments={payments} isLoading={false} />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(anchorClicks).toHaveLength(1);
    const anchor = anchorClicks[0];
    expect(anchor.getAttribute('download')).toBe('stellar-payments.csv');

    const csv = await capture.contentsOf(anchor.href);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toBe('ID,Wallet ID,Tx Hash,From Address,Amount,Asset,Memo,Received At');
    expect(lines[1]).toContain('pay-1');
    expect(lines[1]).toContain('hash-a');
    expect(lines[1]).toContain('100');
    expect(lines[1]).toContain('XLM');
    expect(lines[2]).toContain('pay-2');
    expect(lines[2]).toContain('250.5');
    expect(lines[2]).toContain('USDC');
  });

  it('quotes a CSV field containing a comma', async () => {
    const payments = [makePayment({ memo: 'lunch, dinner, and coffee' })];
    render(<PaymentTable payments={payments} isLoading={false} />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    const csv = await capture.contentsOf(anchorClicks[0].href);

    expect(csv).toContain('"lunch, dinner, and coffee"');
  });

  it('escapes a CSV field containing double quotes by doubling them', async () => {
    const payments = [makePayment({ memo: 'he said "hello"' })];
    render(<PaymentTable payments={payments} isLoading={false} />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    const csv = await capture.contentsOf(anchorClicks[0].href);

    expect(csv).toContain('"he said ""hello"""');
  });

  it('quotes a CSV field containing a newline', async () => {
    const payments = [makePayment({ memo: 'line one\nline two' })];
    render(<PaymentTable payments={payments} isLoading={false} />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    const csv = await capture.contentsOf(anchorClicks[0].href);

    expect(csv).toContain('"line one\nline two"');
  });

  it('renders an empty string for a null/undefined memo rather than the literal "null"', async () => {
    const payments = [makePayment({ memo: undefined })];
    render(<PaymentTable payments={payments} isLoading={false} />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    const csv = await capture.contentsOf(anchorClicks[0].href);
    const dataLine = csv.split('\n')[1];

    expect(dataLine).not.toContain('null');
    expect(dataLine).not.toContain('undefined');
  });

  it('downloads a JSON file with the exact payment objects, pretty-printed', async () => {
    const payments = [makePayment({ id: 'pay-json-1' })];
    render(<PaymentTable payments={payments} isLoading={false} />);

    fireEvent.click(screen.getByRole('button', { name: /export json/i }));

    expect(anchorClicks).toHaveLength(1);
    const anchor = anchorClicks[0];
    expect(anchor.getAttribute('download')).toBe('stellar-payments.json');

    const json = await capture.contentsOf(anchor.href);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(payments);
    // Pretty-printed (2-space indent), not minified onto one line.
    expect(json).toContain('\n  ');
  });

  it('exports only the filtered subset once a search query narrows the list', async () => {
    const payments = [
      makePayment({ id: 'pay-xlm', asset: 'XLM', fromAddress: 'GAAA' }),
      makePayment({ id: 'pay-usdc', asset: 'USDC', fromAddress: 'GBBB' }),
    ];
    render(<PaymentTable payments={payments} isLoading={false} />);

    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'GAAA' } });
    fireEvent.click(screen.getByRole('button', { name: /export json/i }));

    const json = await capture.contentsOf(anchorClicks[0].href);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('pay-xlm');
  });

  it('exports only the asset-filtered subset once an asset filter narrows the list', async () => {
    const payments = [
      makePayment({ id: 'pay-xlm', asset: 'XLM' }),
      makePayment({ id: 'pay-usdc', asset: 'USDC' }),
    ];
    render(<PaymentTable payments={payments} isLoading={false} />);

    fireEvent.change(screen.getByTestId('asset-filter-select'), { target: { value: 'USDC' } });
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    const csv = await capture.contentsOf(anchorClicks[0].href);
    expect(csv).toContain('pay-usdc');
    expect(csv).not.toContain('pay-xlm');
  });

  it('exports every payment again after filters are reset', async () => {
    const payments = [
      makePayment({ id: 'pay-xlm', asset: 'XLM' }),
      makePayment({ id: 'pay-usdc', asset: 'USDC' }),
    ];
    render(<PaymentTable payments={payments} isLoading={false} />);

    fireEvent.change(screen.getByTestId('asset-filter-select'), { target: { value: 'USDC' } });
    fireEvent.click(screen.getByTestId('reset-filters-btn'));
    fireEvent.click(screen.getByRole('button', { name: /export json/i }));

    const json = await capture.contentsOf(anchorClicks[0].href);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(2);
  });

  it('revokes the object URL after triggering the download, for both formats', () => {
    render(<PaymentTable payments={[makePayment()]} isLoading={false} />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    fireEvent.click(screen.getByRole('button', { name: /export json/i }));

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('does nothing when Export CSV is clicked with an empty payments list', () => {
    render(<PaymentTable payments={[]} isLoading={false} />);

    // The button is disabled, but exercise the handler's own empty-list
    // guard directly in case disabled-state styling is ever the only thing
    // preventing a click (e.g. a future variant without the disabled prop).
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(anchorClicks).toHaveLength(0);
  });
});
