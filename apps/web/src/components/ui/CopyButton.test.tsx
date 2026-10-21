import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CopyButton } from './CopyButton';

// ---------------------------------------------------------------------------
// Clipboard mock helpers
// ---------------------------------------------------------------------------
function mockClipboard(shouldReject = false) {
  const writeText = vi.fn(() =>
    shouldReject ? Promise.reject(new Error('clipboard unavailable')) : Promise.resolve(),
  );
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    writable: true,
    configurable: true,
  });
  return writeText;
}

// ---------------------------------------------------------------------------
// Timer helpers — we use fake timers so the 2-second revert is deterministic.
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
describe('CopyButton rendering', () => {
  it('renders a button with the default accessible label', () => {
    mockClipboard();
    render(<CopyButton text="GABC123" />);
    expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeInTheDocument();
  });

  it('accepts a custom label prop', () => {
    mockClipboard();
    render(<CopyButton text="GABC123" label="Copy public key" />);
    expect(screen.getByRole('button', { name: /copy public key/i })).toBeInTheDocument();
  });

  it('shows the copy icon initially (not the checkmark)', () => {
    mockClipboard();
    const { container } = render(<CopyButton text="GABC123" />);
    // The checkmark polyline is only present in the copied state.
    expect(container.querySelector('polyline')).not.toBeInTheDocument();
    // The copy rect IS present in the default state.
    expect(container.querySelector('rect')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Copy interaction
// ---------------------------------------------------------------------------
describe('CopyButton copy interaction', () => {
  it('calls navigator.clipboard.writeText with the provided text on click', async () => {
    const writeText = mockClipboard();
    render(<CopyButton text="GABCDEF1234567890" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('GABCDEF1234567890');
  });

  it('switches to the checkmark icon after a successful copy', async () => {
    mockClipboard();
    const { container } = render(<CopyButton text="GABC" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    // Checkmark polyline should now be present.
    expect(container.querySelector('polyline')).toBeInTheDocument();
    // The copy rect should be gone.
    expect(container.querySelector('rect')).not.toBeInTheDocument();
  });

  it('updates the aria-label to "Copied!" in the copied state', async () => {
    mockClipboard();
    render(<CopyButton text="GABC" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('shows the "Copied!" tooltip in the copied state', async () => {
    mockClipboard();
    render(<CopyButton text="GABC" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(screen.getByRole('tooltip')).toHaveTextContent('Copied!');
  });

  it('announces "Copied!" via an aria-live region', async () => {
    mockClipboard();
    render(<CopyButton text="GABC" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Copied!');
  });
});

// ---------------------------------------------------------------------------
// Auto-revert after 2 seconds
// ---------------------------------------------------------------------------
describe('CopyButton auto-revert', () => {
  it('reverts back to the copy icon after 2 seconds', async () => {
    mockClipboard();
    const { container } = render(<CopyButton text="GABC" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    // Copied state active.
    expect(container.querySelector('polyline')).toBeInTheDocument();

    // Advance by 2 000 ms — the revert timeout fires.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Back to copy icon.
    expect(container.querySelector('polyline')).not.toBeInTheDocument();
    expect(container.querySelector('rect')).toBeInTheDocument();
  });

  it('clears the aria-live announcement after reverting', async () => {
    mockClipboard();
    render(<CopyButton text="GABC" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(screen.getByRole('status')).toHaveTextContent('Copied!');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('does not revert before 2 seconds have elapsed', async () => {
    mockClipboard();
    const { container } = render(<CopyButton text="GABC" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    await act(async () => {
      vi.advanceTimersByTime(1999);
    });

    expect(container.querySelector('polyline')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Keyboard accessibility
// ---------------------------------------------------------------------------
describe('CopyButton keyboard accessibility', () => {
  it('is focusable via tab', () => {
    mockClipboard();
    const { container } = render(<CopyButton text="GABC" />);
    const btn = container.querySelector('button');
    expect(btn).not.toBeNull();
    // A button is naturally in the tab order unless tabIndex=-1.
    expect(btn!.tabIndex).not.toBe(-1);
  });

  it('copies when Enter key is pressed', async () => {
    const writeText = mockClipboard();
    render(<CopyButton text="GABC" />);
    const btn = screen.getByRole('button');

    await act(async () => {
      fireEvent.keyDown(btn, { key: 'Enter', code: 'Enter' });
      fireEvent.click(btn); // browsers fire click on Enter for button elements
    });

    expect(writeText).toHaveBeenCalledWith('GABC');
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------
describe('CopyButton error handling', () => {
  it('does not throw or enter copied state when clipboard write fails', async () => {
    mockClipboard(/* shouldReject= */ true);
    const { container } = render(<CopyButton text="GABC" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    // Should still show the copy icon, not the checkmark.
    expect(container.querySelector('polyline')).not.toBeInTheDocument();
    expect(container.querySelector('rect')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Extra prop pass-through
// ---------------------------------------------------------------------------
describe('CopyButton className prop', () => {
  it('appends extra className to the button element', () => {
    mockClipboard();
    render(<CopyButton text="GABC" className="my-custom-class" />);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('my-custom-class');
  });
});
