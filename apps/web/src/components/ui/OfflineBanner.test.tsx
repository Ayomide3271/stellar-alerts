import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OfflineBanner } from './OfflineBanner';

function setOnLine(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}

describe('OfflineBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setOnLine(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is hidden while online and shows an amber banner when offline', () => {
    const { queryByTestId, getByTestId } = render(<OfflineBanner onReconnect={vi.fn()} />);
    expect(queryByTestId('offline-banner')).toBeNull();

    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event('offline'));
    });

    const banner = getByTestId('offline-banner');
    expect(banner.className).toContain('amber');
    expect(banner.textContent).toMatch(/Retrying in 5s/);
  });

  it('retries every 5 seconds with a countdown', () => {
    const onReconnect = vi.fn();
    const { getByTestId } = render(<OfflineBanner onReconnect={onReconnect} />);

    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event('offline'));
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(getByTestId('offline-banner').textContent).toMatch(/Retrying in 3s/);
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(getByTestId('offline-banner').textContent).toMatch(/Retrying in 5s/);
  });

  it('shows green Reconnected! and invokes reconnect when network returns', () => {
    const onReconnect = vi.fn();
    const { getByTestId, queryByTestId } = render(<OfflineBanner onReconnect={onReconnect} />);

    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event('online'));
    });

    const banner = getByTestId('offline-banner');
    expect(banner.textContent).toMatch(/Reconnected!/);
    expect(banner.className).toContain('emerald');
    expect(onReconnect).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(queryByTestId('offline-banner')).toBeNull();
  });
});
