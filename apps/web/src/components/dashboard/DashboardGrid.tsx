'use client';

import React, { useState } from 'react';
import { useDashboardLayout, DEFAULT_STORAGE_KEY } from '../../hooks/useDashboardLayout';

export interface DashboardWidgetItem {
  id: string;
  label: string;
  content: React.ReactNode;
}

export interface DashboardGridProps {
  items: DashboardWidgetItem[];
  storageKey?: string;
}

export const DashboardGrid: React.FC<DashboardGridProps> = ({
  items,
  storageKey = DEFAULT_STORAGE_KEY,
}) => {
  const itemIds = items.map((item) => item.id);

  const {
    order,
    isWidgetVisible,
    toggleWidget,
    reorderWidgets,
    resetLayout,
    setOrder,
  } = useDashboardLayout({
    storageKey,
    defaultIds: itemIds,
  });

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // Filter only visible widgets in the custom order
  const orderedVisibleItems = order
    .filter((id) => isWidgetVisible(id))
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is DashboardWidgetItem => Boolean(item));

  // Map of full items for the modal in current order
  const orderedAllItems = order
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is DashboardWidgetItem => Boolean(item));

  const handleDragStart =
    (index: number) =>
    (e: React.DragEvent<HTMLElement>) => {
      e.dataTransfer.setData('text/plain', String(index));
      e.dataTransfer.effectAllowed = 'move';
      setDragIndex(index);
    };

  const handleDragOver =
    (index: number) =>
    (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (index !== overIndex) setOverIndex(index);
    };

  const handleDrop =
    (targetVisibleIndex: number) =>
    (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      const sourceVisibleIndex = Number(e.dataTransfer.getData('text/plain'));
      if (
        Number.isNaN(sourceVisibleIndex) ||
        sourceVisibleIndex === targetVisibleIndex ||
        sourceVisibleIndex < 0 ||
        sourceVisibleIndex >= orderedVisibleItems.length
      ) {
        setDragIndex(null);
        setOverIndex(null);
        return;
      }

      const sourceItem = orderedVisibleItems[sourceVisibleIndex];
      const targetItem = orderedVisibleItems[targetVisibleIndex];
      if (!sourceItem || !targetItem) return;

      const sourceOrderIndex = order.indexOf(sourceItem.id);
      const targetOrderIndex = order.indexOf(targetItem.id);

      if (sourceOrderIndex !== -1 && targetOrderIndex !== -1) {
        const nextOrder = [...order];
        const [moved] = nextOrder.splice(sourceOrderIndex, 1);
        nextOrder.splice(targetOrderIndex, 0, moved);
        setOrder(nextOrder);
      }

      setDragIndex(null);
      setOverIndex(null);
    };

  const handleDragEnd = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className="relative">
      {/* Controls Bar */}
      <div className="flex items-center justify-end mb-4">
        <button
          type="button"
          data-testid="customize-layout-btn"
          onClick={() => setIsModalOpen(true)}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg text-slate-300 bg-slate-800/80 hover:bg-slate-700 hover:text-white border border-slate-700/60 shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
          title="Customize dashboard widgets layout and visibility"
        >
          <span aria-hidden="true">🎛️</span>
          <span>Customize Layout</span>
        </button>
      </div>

      {/* Grid of Visible Widgets */}
      {orderedVisibleItems.length === 0 ? (
        <div
          data-testid="dashboard-empty-state"
          className="p-8 text-center rounded-xl border border-slate-800 bg-slate-900/50"
        >
          <p className="text-sm text-slate-400 mb-3">All dashboard widgets are currently hidden.</p>
          <button
            type="button"
            onClick={resetLayout}
            className="px-4 py-2 text-xs font-semibold text-cyan-400 hover:text-cyan-300 bg-cyan-950/40 border border-cyan-800/60 rounded-lg transition-colors"
          >
            Reset to Default Layout
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {orderedVisibleItems.map((item, index) => (
            <section
              key={item.id}
              data-testid={`dashboard-widget-${item.id}`}
              draggable
              onDragStart={handleDragStart(index)}
              onDragOver={handleDragOver(index)}
              onDrop={handleDrop(index)}
              onDragEnd={handleDragEnd}
              className={`min-w-0 transition-opacity duration-150 ${
                dragIndex === index ? 'opacity-50' : ''
              }`}
            >
              <div
                data-testid={`dashboard-widget-handle-${item.id}`}
                className={`flex items-center gap-2 mb-3 px-2 py-1 rounded-lg cursor-grab active:cursor-grabbing select-none group transition-colors ${
                  overIndex === index
                    ? 'ring-2 ring-cyan-500/60 bg-cyan-500/5'
                    : 'hover:bg-white/5'
                }`}
                title="Drag to reorder dashboard widget"
              >
                <span
                  className="text-slate-500 group-hover:text-cyan-400 transition-colors"
                  aria-hidden="true"
                >
                  ⠿
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 group-hover:text-slate-300 transition-colors">
                  {item.label}
                </span>
              </div>
              {item.content}
            </section>
          ))}
        </div>
      )}

      {/* Layout Customization Modal */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="customize-layout-title"
          data-testid="customize-layout-modal"
        >
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden p-6 text-slate-100">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div>
                <h3 id="customize-layout-title" className="text-lg font-bold text-white">
                  Customize Dashboard Layout
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Show or hide widgets and rearrange their display order.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg transition-colors"
                aria-label="Close layout customization modal"
              >
                ✕
              </button>
            </div>

            {/* Widget Toggles & Ordering List */}
            <div className="py-4 space-y-2 max-h-[60vh] overflow-y-auto">
              {orderedAllItems.map((item, index) => {
                const visible = isWidgetVisible(item.id);
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-3 rounded-xl bg-slate-800/40 border border-slate-800 hover:border-slate-700 transition-colors"
                  >
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={visible}
                        onChange={() => toggleWidget(item.id)}
                        data-testid={`widget-toggle-${item.id}`}
                        className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-slate-900 cursor-pointer"
                      />
                      <span
                        className={`text-sm font-medium ${
                          visible ? 'text-slate-200' : 'text-slate-500 line-through'
                        }`}
                      >
                        {item.label}
                      </span>
                    </label>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => reorderWidgets(index, index - 1)}
                        disabled={index === 0}
                        data-testid={`widget-move-up-${item.id}`}
                        className="p-1.5 text-xs text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed rounded hover:bg-slate-700/50 transition-colors"
                        title="Move Up"
                        aria-label={`Move ${item.label} up`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => reorderWidgets(index, index + 1)}
                        disabled={index === orderedAllItems.length - 1}
                        data-testid={`widget-move-down-${item.id}`}
                        className="p-1.5 text-xs text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed rounded hover:bg-slate-700/50 transition-colors"
                        title="Move Down"
                        aria-label={`Move ${item.label} down`}
                      >
                        ↓
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-between pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={resetLayout}
                data-testid="reset-layout-btn"
                className="px-3 py-1.5 text-xs font-semibold text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 rounded-lg border border-rose-900/40 transition-colors"
              >
                Reset to Default
              </button>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                data-testid="close-modal-btn"
                className="px-4 py-1.5 text-xs font-semibold text-slate-900 bg-cyan-400 hover:bg-cyan-300 rounded-lg shadow-sm transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
