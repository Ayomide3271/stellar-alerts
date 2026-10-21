'use client';

/**
 * React hook for subscribing to the SSE payment push stream (Issue #64).
 * Uses the native EventSource API with automatic exponential-backoff reconnect.
 */
import { useEffect, useCallback, useRef, useState } from 'react';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:3001';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Window event dispatched (e.g. by OfflineBanner) to force an SSE reconnect. */
export const SSE_RECONNECT_EVENT = 'sse:reconnect';

export interface PaymentEvent {
  paymentId: string;
  txHash: string;
  walletId: string;
  amount: string;
  asset: string;
  assetIssuer: string | null;
  fromAddress: string;
  receivedAt: string;
}

/**
 * Subscribes to real-time payment events from the Fastify SSE endpoint.
 *
 * @param onPayment  Callback invoked with each incoming payment event payload.
 *
 * Usage:
 *   const { connected } = usePaymentStream((payment) => {
 *     console.log('New payment:', payment);
 *   });
 */
export function usePaymentStream(onPayment: (data: PaymentEvent) => void) {
  const [connected, setConnected] = useState(false);
  const onPaymentRef = useRef(onPayment);
  const reconnectDelayRef = useRef(RECONNECT_BASE_MS);
  const esRef = useRef<EventSource | null>(null);
  const unmountedRef = useRef(false);

  // Keep the callback ref current so we don't need to re-subscribe when it changes
  useEffect(() => {
    onPaymentRef.current = onPayment;
  }, [onPayment]);

  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    const es = new EventSource(`${API_URL}/events`);
    esRef.current = es;

    es.addEventListener('connected', () => {
      setConnected(true);
      // Reset backoff on successful connection
      reconnectDelayRef.current = RECONNECT_BASE_MS;
    });

    es.addEventListener('payment', (event: MessageEvent) => {
      try {
        const data: PaymentEvent = JSON.parse(event.data);
        onPaymentRef.current(data);
      } catch (err) {
        console.warn('[SSE] Failed to parse payment event:', err);
      }
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setConnected(false);

      if (unmountedRef.current) return;

      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS);

      setTimeout(() => {
        connectRef.current();
      }, delay);
    };
  }, []);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Reconnect immediately when the offline banner requests it
  useEffect(() => {
    const handler = () => {
      if (unmountedRef.current || esRef.current) return;
      reconnectDelayRef.current = RECONNECT_BASE_MS;
      connectRef.current();
    };
    window.addEventListener(SSE_RECONNECT_EVENT, handler);
    return () => window.removeEventListener(SSE_RECONNECT_EVENT, handler);
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [connect]);

  return { connected };
}
