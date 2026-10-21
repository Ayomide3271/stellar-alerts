import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyWatchersState } from './EmptyWatchersState';

describe('EmptyWatchersState', () => {
  it('renders the onboarding card when the user has no wallets', () => {
    render(<EmptyWatchersState walletCount={0} onAddWallet={() => {}} />);

    expect(screen.getByTestId('empty-watchers-state')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /watch your first stellar wallet/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/streams every incoming payment in real time/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add your first wallet/i })).toBeInTheDocument();
  });

  it('renders nothing once at least one wallet is registered', () => {
    const { container } = render(<EmptyWatchersState walletCount={1} onAddWallet={() => {}} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('empty-watchers-state')).not.toBeInTheDocument();
  });

  it('triggers the add-wallet flow from the primary call to action', () => {
    const onAddWallet = vi.fn();
    render(<EmptyWatchersState walletCount={0} onAddWallet={onAddWallet} />);

    fireEvent.click(screen.getByRole('button', { name: /add your first wallet/i }));

    expect(onAddWallet).toHaveBeenCalledTimes(1);
  });

  it('is a named region with a decorative illustration and a real button', () => {
    const { container } = render(<EmptyWatchersState walletCount={0} onAddWallet={() => {}} />);

    // The card is announced as a labelled region, not as an unlabelled div.
    const region = screen.getByRole('region', { name: /watch your first stellar wallet/i });
    expect(region).toBe(screen.getByTestId('empty-watchers-state'));

    // The artwork carries no meaning: nothing for a screen reader to read out.
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');

    const cta = screen.getByRole('button', { name: /add your first wallet/i });
    expect(cta).toHaveAttribute('type', 'button');
  });
});
