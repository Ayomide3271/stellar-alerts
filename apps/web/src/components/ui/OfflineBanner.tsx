'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SSE_RECONNECT_EVENT } from '../../lib/sse-client';

export const OFFLINE_RETRY_SECONDS = 5;
const RECONNECTED_VISIBLE_MS = 3_000;

export interface OfflineBannerProps {
  /** Invoked every retry tick while offline and once when the network returns. */
  onReconnect?: () => void;
}

function defaultReconnect() {
  window.dispatchEvent(new Event(SSE_RECONNECT_EVENT));
}

export function OfflineBanner({ onReconnect }: OfflineBannerProps) {
  const [offline, setOffline] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  const [countdown, setCountdown] = useState(OFFLINE_RETRY_SECONDS);
  const reconnectRef = useRef(onReconnect ?? defaultReconnect);
  const offlineRef = useRef(false);

  useEffect(() => {
    reconnectRef.current = onReconnect ?? defaultReconnect;
  }, [onReconnect]);

  const goOffline = useCallback(() => {
    offlineRef.current = true;
    setOffline(true);
    setReconnected(false);
    setCountdown(OFFLINE_RETRY_SECONDS);
  }, []);

  const goOnline = useCallback(() => {
    if (!offlineRef.current) return;
    offlineRef.current = false;
    setOffline(false);
    setReconnected(true);
    reconnectRef.current();
  }, []);

  useEffect(() => {
    if (!navigator.onLine) goOffline();
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [goOffline, goOnline]);

  // Auto-retry every 5s while offline
  useEffect(() => {
    if (!offline) return;
    const id = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          reconnectRef.current();
          return OFFLINE_RETRY_SECONDS;
        }
        return prev - 1;
      });
    }, 1_000);
    return () => clearInterval(id);
  }, [offline]);

  // Hide the green confirmation after a short delay
  useEffect(() => {
    if (!reconnected) return;
    const id = setTimeout(() => setReconnected(false), RECONNECTED_VISIBLE_MS);
    return () => clearTimeout(id);
  }, [reconnected]);

  if (!offline && !reconnected) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className={`fixed top-0 left-0 right-0 z-50 px-4 py-2.5 text-sm font-semibold text-center border-b backdrop-blur-md ${
        offline
          ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
          : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-200'
      }`}
    >
      {offline ? (
        <span>
          You&apos;re offline. Live updates are paused. Retrying in {countdown}s…
        </span>
      ) : (
        <span>Reconnected!</span>
      )}
    </div>
  );
}
