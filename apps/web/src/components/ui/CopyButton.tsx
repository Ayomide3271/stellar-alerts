'use client';

import React, { useState, useCallback, useRef } from 'react';

interface CopyButtonProps {
  /** The text string to copy to the clipboard (e.g. a public key or tx hash). */
  text: string;
  /** Optional accessible label describing what is being copied. */
  label?: string;
  /** Additional Tailwind class names applied to the outer button element. */
  className?: string;
}

/**
 * CopyButton — one-click clipboard copy with animated checkmark feedback.
 *
 * Behaviour:
 *  - Calls `navigator.clipboard.writeText` on click.
 *  - Swaps the copy icon to a green checkmark for 2 seconds, then reverts.
 *  - Announces the "Copied!" state to screen readers via an `aria-live` region.
 *  - Fully keyboard-accessible (tab-focusable, activates on Enter/Space).
 */
export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  label = 'Copy to clipboard',
  className = '',
}) => {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async () => {
    if (copied) return;

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);

      // Clear any outstanding timer so rapid clicks do not double-schedule.
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        setCopied(false);
        timeoutRef.current = null;
      }, 2000);
    } catch {
      // Clipboard write may fail in unsupported or sandboxed environments;
      // fail silently so the UI is never broken.
    }
  }, [copied, text]);

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied!' : label}
        title={copied ? 'Copied!' : label}
        className={[
          'inline-flex items-center justify-center',
          'w-6 h-6 rounded-md',
          'text-slate-400 transition-colors duration-150',
          copied
            ? 'text-emerald-400 bg-emerald-500/10'
            : 'hover:text-slate-200 hover:bg-slate-700/50',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/70',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {copied ? (
          /* Checkmark icon */
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-3.5 h-3.5"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          /* Clipboard / copy icon */
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-3.5 h-3.5"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>

      {/* "Copied!" tooltip shown above the button when state is active */}
      {copied && (
        <span
          role="tooltip"
          className={[
            'pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5',
            'px-2 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap',
            'bg-emerald-600 text-white shadow-lg',
          ].join(' ')}
        >
          Copied!
        </span>
      )}

      {/* Screen-reader live region — announces state change without moving focus */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {copied ? 'Copied!' : ''}
      </span>
    </span>
  );
};
