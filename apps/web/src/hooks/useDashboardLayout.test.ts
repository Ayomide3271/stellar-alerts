import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDashboardLayout, DEFAULT_STORAGE_KEY } from './useDashboardLayout';

describe('useDashboardLayout', () => {
  const defaultIds = ['watchers', 'volume', 'activity'];
  const storageKey = 'test-dashboard-layout';

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('initializes with default order and all widgets visible', () => {
    const { result } = renderHook(() =>
      useDashboardLayout({ storageKey, defaultIds }),
    );

    expect(result.current.order).toEqual(defaultIds);
    expect(result.current.visibleOrder).toEqual(defaultIds);
    expect(result.current.isWidgetVisible('watchers')).toBe(true);
    expect(result.current.isWidgetVisible('volume')).toBe(true);
    expect(result.current.isWidgetVisible('activity')).toBe(true);
  });

  it('toggles widget visibility and updates visibleOrder', () => {
    const { result } = renderHook(() =>
      useDashboardLayout({ storageKey, defaultIds }),
    );

    act(() => {
      result.current.toggleWidget('volume');
    });

    expect(result.current.isWidgetVisible('volume')).toBe(false);
    expect(result.current.visibleOrder).toEqual(['watchers', 'activity']);
    expect(result.current.order).toEqual(defaultIds);

    // Toggle back
    act(() => {
      result.current.toggleWidget('volume');
    });

    expect(result.current.isWidgetVisible('volume')).toBe(true);
    expect(result.current.visibleOrder).toEqual(defaultIds);
  });

  it('persists layout changes to localStorage', () => {
    const { result } = renderHook(() =>
      useDashboardLayout({ storageKey, defaultIds }),
    );

    act(() => {
      result.current.toggleWidget('activity');
      result.current.reorderWidgets(0, 1); // move watchers after volume
    });

    const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}');
    expect(stored.order).toEqual(['volume', 'watchers', 'activity']);
    expect(stored.visible).toEqual({
      watchers: true,
      volume: true,
      activity: false,
    });
  });

  it('restores layout accurately from localStorage on reload', () => {
    const savedLayout = {
      order: ['activity', 'volume', 'watchers'],
      visible: {
        activity: true,
        volume: false,
        watchers: true,
      },
    };
    window.localStorage.setItem(storageKey, JSON.stringify(savedLayout));

    const { result } = renderHook(() =>
      useDashboardLayout({ storageKey, defaultIds }),
    );

    expect(result.current.order).toEqual(['activity', 'volume', 'watchers']);
    expect(result.current.visibleOrder).toEqual(['activity', 'watchers']);
    expect(result.current.isWidgetVisible('volume')).toBe(false);
    expect(result.current.isWidgetVisible('activity')).toBe(true);
  });

  it('supports backwards compatibility with legacy array format in localStorage', () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify(['activity', 'watchers', 'volume']),
    );

    const { result } = renderHook(() =>
      useDashboardLayout({ storageKey, defaultIds }),
    );

    expect(result.current.order).toEqual(['activity', 'watchers', 'volume']);
    expect(result.current.visibleOrder).toEqual(['activity', 'watchers', 'volume']);
    expect(result.current.isWidgetVisible('activity')).toBe(true);
  });

  it('resets layout to default configuration', () => {
    const { result } = renderHook(() =>
      useDashboardLayout({ storageKey, defaultIds }),
    );

    act(() => {
      result.current.toggleWidget('watchers');
      result.current.reorderWidgets(0, 2);
    });

    expect(result.current.visibleOrder).not.toEqual(defaultIds);

    act(() => {
      result.current.resetLayout();
    });

    expect(result.current.order).toEqual(defaultIds);
    expect(result.current.visibleOrder).toEqual(defaultIds);
    expect(result.current.isWidgetVisible('watchers')).toBe(true);
    expect(result.current.isWidgetVisible('volume')).toBe(true);
    expect(result.current.isWidgetVisible('activity')).toBe(true);
    const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}');
    expect(stored.order).toEqual(defaultIds);
    expect(stored.visible).toEqual({
      watchers: true,
      volume: true,
      activity: true,
    });
  });
});
