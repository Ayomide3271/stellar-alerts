import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// The dashboard page pulls in heavy, browser-only neighbours (three.js,
// Yjs, the authenticated socket). The empty-state wiring is what this test
// covers, so they are stubbed with inert elements.
// A signed-in session, so the page actually fetches the portfolio; the empty
// state's visibility depends on that first fetch having resolved.
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { accessToken: 'test-token', user: { id: 'u-1' } } }),
}));
vi.mock('@/components/dashboard/NetworkVisualizer3D', () => ({
  default: () => <div data-testid="network-visualizer" />,
}));
vi.mock('@/components/dashboard/AuditWorkspace', () => ({
  default: () => <div data-testid="audit-workspace" />,
}));

const WALLET = {
  id: 'w-1',
  publicKey: 'GBQHHOH72M522QBF7SMY57JH6FIN7YKTZUWSO4S5IFBXV3B7FI2UQLIQ',
  label: 'Test Wallet',
};

const walletState: { wallets: (typeof WALLET)[] } = { wallets: [] };

vi.mock('@/lib/hooks/useBatchReader', () => ({
  useBatchReader: () => ({
    fetchUserPortfolioBatched: async () => ({
      wallets: walletState.wallets,
      payments: [],
      summary: { totalVolumeXLM: 0, totalPayments: 0 },
    }),
    invalidateAll: () => {},
  }),
}));

vi.mock('@/lib/socket', () => ({
  getSocket: () => ({
    connect: () => {},
    disconnect: () => {},
    on: () => () => {},
    onPayment: () => () => {},
    onDelivery: () => () => {},
  }),
}));

import DashboardPage from './page';

describe('DashboardPage empty watcher state', () => {
  beforeEach(() => {
    walletState.wallets = [];
    window.localStorage.clear();
  });

  it('shows the onboarding card, and no wallets widget, at zero wallets', async () => {
    render(<DashboardPage />);

    expect(await screen.findByTestId('empty-watchers-state')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-widget-wallets')).not.toBeInTheDocument();
  });

  it('hides the onboarding card once a wallet is registered', async () => {
    walletState.wallets = [WALLET];
    render(<DashboardPage />);

    expect(await screen.findByTestId('dashboard-widget-wallets')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-watchers-state')).not.toBeInTheDocument();
  });
});
