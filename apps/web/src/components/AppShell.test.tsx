import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

vi.mock('next/link', () => ({
  default: ({
    children,
    onClick,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
    className?: string;
  }) => (
    <a
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next-auth/react', () => ({
  signOut: vi.fn(),
  useSession: () => ({
    data: {
      accessToken: 'test-token',
      user: { name: 'Explorer', email: 'explorer@example.com' },
    },
  }),
}));

vi.mock('@/components/CommandPalette', () => ({
  CommandPalette: () => null,
}));

vi.mock('@/components/dashboard', () => ({
  NotificationModal: () => null,
}));

vi.mock('@/components/onboarding', () => ({
  OnboardingWizard: () => null,
}));

vi.mock('@/lib/adapters/wallet.adapter', () => ({
  WalletAdapter: class WalletAdapter {},
}));

vi.mock('@/lib/adapters/notifications.adapter', () => ({
  NotificationsAdapter: class NotificationsAdapter {},
}));

vi.mock('@/lib/hooks/useBatchReader', () => ({
  useBatchReader: () => ({ invalidateAll: vi.fn() }),
}));

describe('AppShell mobile navigation', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  it('opens a labeled drawer with the application navigation', () => {
    render(
      <AppShell>
        <div>Dashboard content</div>
      </AppShell>,
    );

    expect(screen.queryByLabelText('Mobile navigation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));

    const drawer = screen.getByLabelText('Mobile navigation');
    expect(drawer).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Inspectors' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open navigation menu' })).toHaveAttribute('aria-expanded', 'true');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('closes through the close control, backdrop, Escape, and navigation selection', () => {
    render(
      <AppShell>
        <div>Dashboard content</div>
      </AppShell>,
    );

    const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));

    openMenu();
    fireEvent.click(within(screen.getByLabelText('Mobile navigation')).getByRole('button', { name: 'Close navigation menu' }));
    expect(screen.queryByLabelText('Mobile navigation')).not.toBeInTheDocument();

    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByLabelText('Mobile navigation')).not.toBeInTheDocument();

    openMenu();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close navigation menu' })[0]);
    expect(screen.queryByLabelText('Mobile navigation')).not.toBeInTheDocument();

    openMenu();
    fireEvent.click(within(screen.getByLabelText('Mobile navigation')).getByRole('link', { name: 'Inspectors' }));
    expect(screen.queryByLabelText('Mobile navigation')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });
});
