import { useState, useEffect, useCallback, useMemo } from 'react';

export interface DashboardLayoutState {
  order: string[];
  visible: Record<string, boolean>;
}

export interface UseDashboardLayoutOptions {
  storageKey?: string;
  defaultIds: string[];
}

export const DEFAULT_STORAGE_KEY = 'stellar-alerts:dashboard-layout';

function readStoredLayout(
  storageKey: string,
  defaultIds: string[],
): DashboardLayoutState {
  if (typeof window === 'undefined') {
    return {
      order: defaultIds,
      visible: Object.fromEntries(defaultIds.map((id) => [id, true])),
    };
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return {
        order: defaultIds,
        visible: Object.fromEntries(defaultIds.map((id) => [id, true])),
      };
    }

    const parsed = JSON.parse(raw);

    // Support legacy array format where only order was stored: ['id1', 'id2']
    if (Array.isArray(parsed)) {
      const known = parsed.filter(
        (id): id is string => typeof id === 'string' && defaultIds.includes(id),
      );
      const missing = defaultIds.filter((id) => !known.includes(id));
      return {
        order: [...known, ...missing],
        visible: Object.fromEntries(defaultIds.map((id) => [id, true])),
      };
    }

    // Support object format: { order: string[], visible: Record<string, boolean> }
    if (parsed && typeof parsed === 'object') {
      const rawOrder = Array.isArray(parsed.order) ? parsed.order : [];
      const knownOrder = rawOrder.filter(
        (id: unknown): id is string => typeof id === 'string' && defaultIds.includes(id),
      );
      const missingOrder = defaultIds.filter((id) => !knownOrder.includes(id));
      const order = [...knownOrder, ...missingOrder];

      const rawVisible =
        parsed.visible && typeof parsed.visible === 'object' ? parsed.visible : {};
      const visible: Record<string, boolean> = {};
      for (const id of defaultIds) {
        visible[id] = typeof rawVisible[id] === 'boolean' ? rawVisible[id] : true;
      }

      return { order, visible };
    }

    return {
      order: defaultIds,
      visible: Object.fromEntries(defaultIds.map((id) => [id, true])),
    };
  } catch {
    return {
      order: defaultIds,
      visible: Object.fromEntries(defaultIds.map((id) => [id, true])),
    };
  }
}

export function useDashboardLayout({
  storageKey = DEFAULT_STORAGE_KEY,
  defaultIds,
}: UseDashboardLayoutOptions) {
  const [layout, setLayout] = useState<DashboardLayoutState>(() =>
    readStoredLayout(storageKey, defaultIds),
  );

  // Sync to localStorage on layout changes
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(layout));
    } catch {
      // Ignore storage errors (private mode / quota exceeded)
    }
  }, [layout, storageKey]);

  const isWidgetVisible = useCallback(
    (id: string): boolean => {
      return layout.visible[id] !== false;
    },
    [layout.visible],
  );

  const toggleWidget = useCallback((id: string) => {
    setLayout((prev) => {
      const current = prev.visible[id] !== false;
      return {
        ...prev,
        visible: {
          ...prev.visible,
          [id]: !current,
        },
      };
    });
  }, []);

  const setWidgetVisible = useCallback((id: string, isVisible: boolean) => {
    setLayout((prev) => ({
      ...prev,
      visible: {
        ...prev.visible,
        [id]: isVisible,
      },
    }));
  }, []);

  const reorderWidgets = useCallback((sourceIndex: number, destinationIndex: number) => {
    setLayout((prev) => {
      if (
        sourceIndex < 0 ||
        sourceIndex >= prev.order.length ||
        destinationIndex < 0 ||
        destinationIndex >= prev.order.length ||
        sourceIndex === destinationIndex
      ) {
        return prev;
      }
      const nextOrder = [...prev.order];
      const [moved] = nextOrder.splice(sourceIndex, 1);
      nextOrder.splice(destinationIndex, 0, moved);
      return {
        ...prev,
        order: nextOrder,
      };
    });
  }, []);

  const setOrder = useCallback((newOrder: string[]) => {
    setLayout((prev) => ({
      ...prev,
      order: newOrder,
    }));
  }, []);

  const resetLayout = useCallback(() => {
    const defaultState: DashboardLayoutState = {
      order: defaultIds,
      visible: Object.fromEntries(defaultIds.map((id) => [id, true])),
    };
    setLayout(defaultState);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Ignore storage errors
    }
  }, [defaultIds, storageKey]);

  const visibleOrder = useMemo(() => {
    return layout.order.filter((id) => layout.visible[id] !== false);
  }, [layout.order, layout.visible]);

  return {
    order: layout.order,
    visible: layout.visible,
    visibleOrder,
    isWidgetVisible,
    toggleWidget,
    setWidgetVisible,
    reorderWidgets,
    setOrder,
    resetLayout,
  };
}
