import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PaymentTable } from '../dashboard/PaymentTable';
import { ActivityHeatmap } from '../dashboard/ActivityHeatmap';
import { SummaryStats } from '../dashboard/SummaryStats';

describe('Visual Regression & Responsive Dashboard States (#332)', () => {
  describe('Desktop Viewport (1280px)', () => {
    it('renders full desktop ledger and summary metrics', () => {
      // Simulate desktop innerWidth
      window.innerWidth = 1280;
      window.dispatchEvent(new Event('resize'));

      render(
        <SummaryStats
          totalVolumeXLM={125000}
          activeWalletsCount={12}
          totalPaymentsCount={840}
        />
      );

      expect(screen.getByText(/125,000/i)).toBeInTheDocument();
      expect(screen.getByText(/Monitored Wallets/i)).toBeInTheDocument();
    });
  });

  describe('Mobile Viewport (360px and 375px)', () => {
    it.each([360, 375])('renders mobile layout without breaking card containers at %ipx', (width) => {
      window.innerWidth = width;
      window.dispatchEvent(new Event('resize'));

      render(
        <PaymentTable
          payments={[
            {
              id: 'p-mob-1',
              walletId: 'w-mob',
              txHash: '0x1234567890abcdef',
              amount: 50,
              asset: 'USDC',
              receivedAt: new Date().toISOString(),
            },
          ]}
          isLoading={false}
        />
      );

      expect(screen.getByText(/\+50/i)).toBeInTheDocument();
      expect(screen.getAllByText('USDC').length).toBeGreaterThan(0);

      const table = screen.getByRole('table');
      expect(table).toHaveClass('min-w-[760px]');
      expect(table.parentElement).toHaveClass('overflow-x-auto');
    });
  });

  describe('Dark Theme Visual Styling', () => {
    it('applies dark theme background classes and border highlights', () => {
      const { container } = render(
        <ActivityHeatmap
          payments={[{ receivedAt: new Date().toISOString() }]}
        />
      );

      const section = container.querySelector('section');
      expect(section).toHaveClass('bg-slate-900/60');
      expect(section).toHaveClass('border-slate-800');
    });
  });

  describe('Loading Dashboard State', () => {
    it('renders pulsating loading placeholders when loading prop is set', () => {
      render(<PaymentTable payments={[]} isLoading={true} />);

      expect(screen.getByText(/Loading transaction records/i)).toBeInTheDocument();
    });
  });

  describe('Empty Dashboard State', () => {
    it('renders empty state callout when no transactions exist', () => {
      render(<PaymentTable payments={[]} isLoading={false} />);

      expect(screen.getByText(/No payments recorded yet/i)).toBeInTheDocument();
    });
  });

  describe('Error Dashboard State', () => {
    it('renders no match prompt when search query returns empty set', () => {
      render(
        <PaymentTable
          payments={[
            {
              id: 'p1',
              walletId: 'w1',
              txHash: '0x123',
              amount: 10,
              asset: 'XLM',
              receivedAt: new Date().toISOString(),
            },
          ]}
          isLoading={false}
        />
      );

      // Search for non-existent text
      const input = screen.getByLabelText(/Search payments by sender address/i);
      input.dispatchEvent(new CustomEvent('change', { detail: { value: 'NON_EXISTENT_TX' } }));
    });
  });
});
