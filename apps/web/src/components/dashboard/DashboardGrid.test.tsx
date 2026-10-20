import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DashboardGrid, DashboardWidgetItem } from './DashboardGrid';

function makeDataTransfer() {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: 'move',
    dropEffect: 'none',
  };
}

const items: DashboardWidgetItem[] = [
  { id: 'summary', label: 'Summary Overview', content: <div>Summary Content</div> },
  { id: 'wallets', label: 'Wallets', content: <div>Wallets Content</div> },
  { id: 'payments', label: 'Payments', content: <div>Payments Content</div> },
];

describe('DashboardGrid', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders all widgets in their defined order by default', () => {
    render(<DashboardGrid items={items} />);

    const labels = screen
      .getAllByTestId(/dashboard-widget-handle-/)
      .map((el) => el.textContent ?? '');

    expect(screen.getByTestId('dashboard-widget-summary')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-widget-wallets')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-widget-payments')).toBeInTheDocument();
    expect(labels[0]).toContain('Summary Overview');
    expect(labels[1]).toContain('Wallets');
    expect(labels[2]).toContain('Payments');
  });

  it('reorders widgets when a card header is dragged and dropped', () => {
    render(<DashboardGrid items={items} />);

    const firstHandle = screen.getByTestId('dashboard-widget-handle-summary');
    const lastSection = screen.getByTestId('dashboard-widget-payments');
    const dt = makeDataTransfer();

    fireEvent.dragStart(firstHandle, { dataTransfer: dt });
    fireEvent.dragOver(lastSection, { dataTransfer: dt });
    fireEvent.drop(lastSection, { dataTransfer: dt });
    fireEvent.dragEnd(firstHandle, { dataTransfer: dt });

    const labels = screen
      .getAllByTestId(/dashboard-widget-handle-/)
      .map((el) => el.textContent ?? '');

    expect(labels[0]).toContain('Wallets');
    expect(labels[1]).toContain('Payments');
    expect(labels[2]).toContain('Summary Overview');
  });

  it('persists the custom order to localStorage', () => {
    const storageKey = 'test-dashboard-order';
    const { unmount } = render(<DashboardGrid items={items} storageKey={storageKey} />);

    const firstHandle = screen.getByTestId('dashboard-widget-handle-summary');
    const lastSection = screen.getByTestId('dashboard-widget-payments');
    const dt = makeDataTransfer();

    fireEvent.dragStart(firstHandle, { dataTransfer: dt });
    fireEvent.drop(lastSection, { dataTransfer: dt });
    fireEvent.dragEnd(firstHandle, { dataTransfer: dt });

    const persisted = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}');
    expect(persisted.order).toEqual(['wallets', 'payments', 'summary']);
    expect(persisted.visible).toEqual({
      summary: true,
      wallets: true,
      payments: true,
    });
    unmount();
  });

  it('restores a previously saved order on mount', () => {
    const storageKey = 'test-dashboard-order';
    window.localStorage.setItem(storageKey, JSON.stringify(['payments', 'summary', 'wallets']));

    render(<DashboardGrid items={items} storageKey={storageKey} />);

    const labels = screen
      .getAllByTestId(/dashboard-widget-handle-/)
      .map((el) => el.textContent ?? '');

    expect(labels[0]).toContain('Payments');
    expect(labels[1]).toContain('Summary Overview');
    expect(labels[2]).toContain('Wallets');
  });

  it('opens customization modal and toggles widget visibility, asserting DOM removal', () => {
    render(<DashboardGrid items={items} />);

    expect(screen.getByTestId('dashboard-widget-summary')).toBeInTheDocument();

    // Open modal
    fireEvent.click(screen.getByTestId('customize-layout-btn'));
    expect(screen.getByTestId('customize-layout-modal')).toBeInTheDocument();

    // Uncheck summary widget
    const summaryToggle = screen.getByTestId('widget-toggle-summary');
    expect(summaryToggle).toBeChecked();
    fireEvent.click(summaryToggle);

    // Summary widget should now be removed from DOM
    expect(screen.queryByTestId('dashboard-widget-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-widget-wallets')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-widget-payments')).toBeInTheDocument();
  });

  it('restores initial layout and hidden widgets when "Reset to Default" is clicked', () => {
    const storageKey = 'test-dashboard-reset';
    render(<DashboardGrid items={items} storageKey={storageKey} />);

    // Open modal and hide summary
    fireEvent.click(screen.getByTestId('customize-layout-btn'));
    fireEvent.click(screen.getByTestId('widget-toggle-summary'));
    expect(screen.queryByTestId('dashboard-widget-summary')).not.toBeInTheDocument();

    // Click Reset to Default
    fireEvent.click(screen.getByTestId('reset-layout-btn'));

    // Summary should be restored to the DOM
    expect(screen.getByTestId('dashboard-widget-summary')).toBeInTheDocument();
    expect(screen.getByTestId('widget-toggle-summary')).toBeChecked();
  });

  it('reorders widgets using move up and move down buttons in the modal', () => {
    render(<DashboardGrid items={items} />);

    // Open modal
    fireEvent.click(screen.getByTestId('customize-layout-btn'));

    // Summary is at index 0, move down
    fireEvent.click(screen.getByTestId('widget-move-down-summary'));

    // Check visible widgets order in DOM
    const labels = screen
      .getAllByTestId(/dashboard-widget-handle-/)
      .map((el) => el.textContent ?? '');

    expect(labels[0]).toContain('Wallets');
    expect(labels[1]).toContain('Summary Overview');
    expect(labels[2]).toContain('Payments');
  });

  it('restores both custom order and visibility state from localStorage on mount', () => {
    const storageKey = 'test-dashboard-restored';
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        order: ['payments', 'wallets', 'summary'],
        visible: { payments: true, wallets: false, summary: true },
      }),
    );

    render(<DashboardGrid items={items} storageKey={storageKey} />);

    expect(screen.getByTestId('dashboard-widget-payments')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-widget-wallets')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-widget-summary')).toBeInTheDocument();

    const labels = screen
      .getAllByTestId(/dashboard-widget-handle-/)
      .map((el) => el.textContent ?? '');

    expect(labels[0]).toContain('Payments');
    expect(labels[1]).toContain('Summary Overview');
  });

  it('renders empty state when all widgets are hidden and allows resetting from empty state', () => {
    render(<DashboardGrid items={items} />);

    fireEvent.click(screen.getByTestId('customize-layout-btn'));
    fireEvent.click(screen.getByTestId('widget-toggle-summary'));
    fireEvent.click(screen.getByTestId('widget-toggle-wallets'));
    fireEvent.click(screen.getByTestId('widget-toggle-payments'));
    fireEvent.click(screen.getByTestId('close-modal-btn'));

    expect(screen.getByTestId('dashboard-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-widget-summary')).not.toBeInTheDocument();

    // Click Reset in empty state
    fireEvent.click(screen.getByText('Reset to Default Layout'));
    expect(screen.getByTestId('dashboard-widget-summary')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-widget-wallets')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-widget-payments')).toBeInTheDocument();
  });
});

