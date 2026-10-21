/*
 * PagerDuty Events API v2 Incident Escalation Provider (#637).
 *
 * Implements enterprise on-call notification dispatching via PagerDuty Events API v2:
 * - Structured incident trigger payloads per official v2 schema
 * - Severity mapping (critical, error, warning) to PagerDuty severity levels
 * - Deduplication keys for incident correlation and auto-resolution
 * - Custom details for Stellar contract events (threshold change, pause, etc.)
 * - Rate limit handling (429 Retry-After) and retries with exponential backoff
 */

import { env } from '../../../config/env';
import { fetchWithTimeout } from '../../../lib/external-request';

export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info';

export type PagerDutyEventAction = 'trigger' | 'acknowledge' | 'resolve';

export interface PagerDutyCustomDetails {
  alertId?: string;
  contractId?: string;
  txHash?: string;
  network?: string;
  eventType?: string;
  dashboardUrl?: string;
  explorerUrl?: string;
  [key: string]: unknown;
}

export interface PagerDutyArticle {
  type?: 'link';
  href?: string;
  text?: string;
}

export interface PagerDutyEventPayload {
  routing_key: string;
  event_action: PagerDutyEventAction;
  dedup_key?: string;
  payload: {
    summary: string;
    source: string;
    severity: PagerDutySeverity;
    timestamp?: string;
    component?: string;
    group?: string;
    class?: string;
    custom_details?: PagerDutyCustomDetails;
  };
  images?: Array<{ src: string; href?: string; alt?: string }>;
  links?: Array<PagerDutyArticle>;
}

export interface PagerDutyAlertInput {
  alertId?: string;
  title?: string;
  message: string;
  severity: PagerDutySeverity;
  source?: string;
  component?: string;
  group?: string;
  class?: string;
  dedupKey?: string;
  timestamp?: string | Date;
  customDetails?: PagerDutyCustomDetails;
  links?: Array<PagerDutyArticle>;
  images?: Array<{ src: string; href?: string; alt?: string }>;
}

export interface PagerDutyDispatchOptions {
  routingKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export interface PagerDutyDispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  rateLimited?: boolean;
  retryAfterSeconds?: number;
  attempts?: number;
  dedupKey?: string;
  incidentKey?: string;
}

const PAGERDUTY_EVENTS_ENDPOINT = 'https://events.pagerduty.com/v2/enqueue';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 5000;

export class PagerDutyProvider {
  /**
   * Validate a PagerDuty Events API v2 routing key.
   * Routing keys are 32 character alphanumeric strings.
   */
  isValidRoutingKey(key?: string | null): boolean {
    if (!key) return false;
    return /^[A-Za-z0-9]{10,64}$/.test(key.trim());
  }

  /**
   * Normalize a severity value to a PagerDuty v2 severity level.
   */
  normalizeSeverity(severity?: string | null): PagerDutySeverity {
    const value = (severity || 'error').toLowerCase().trim();
    switch (value) {
      case 'critical':
      case 'fatal':
      case 'p1':
        return 'critical';
      case 'error':
      case 'high':
      case 'p2':
        return 'error';
      case 'warning':
      case 'medium':
      case 'p3':
        return 'warning';
      case 'info':
      case 'low':
      case 'p4':
        return 'info';
      default:
        return 'error';
    }
  }

  /**
   * Derive a deterministic deduplication key for an alert so repeated
   * dispatches for the same incident collapse into a single PagerDuty incident.
   */
  buildDedupKey(input: PagerDutyAlertInput): string {
    if (input.dedupKey) {
      return input.dedupKey;
    }
    const alertId = input.alertId || input.customDetails?.alertId;
    if (alertId) {
      return `stellar-alerts-${alertId}`;
    }
    const contractId = input.customDetails?.contractId;
    const eventType = input.customDetails?.eventType;
    if (contractId && eventType) {
      return `stellar-alerts-${contractId}-${eventType}`;
    }
    // Fall back to a stable hash of the summary so repeats still collapse.
    return `stellar-alerts-${this.hashString(input.message)}`;
  }

  /**
   * Build an official PagerDuty v2 trigger payload.
   */
  buildTriggerPayload(input: PagerDutyAlertInput, routingKey?: string): PagerDutyEventPayload {
    const key = routingKey || env.PAGERDUTY_ROUTING_KEY;
    if (!key) {
      throw new Error('PagerDuty routing key is required');
    }

    const timestamp =
      input.timestamp instanceof Date
        ? input.timestamp.toISOString()
        : input.timestamp || new Date().toISOString();

    const summary = input.title || input.message;

    return {
      routing_key: key,
      event_action: 'trigger',
      dedup_key: this.buildDedupKey(input),
      payload: {
        summary,
        source: input.source || 'stellar-alerts',
        severity: this.normalizeSeverity(input.severity),
        timestamp,
        component: input.component || 'stellar-contract',
        group: input.group,
        class: input.class || 'security-event',
        custom_details: input.customDetails,
      },
      images: input.images,
      links: input.links,
    };
  }

  /**
   * Build an acknowledge or resolve payload for an existing incident.
   */
  buildLifecyclePayload(
    action: 'acknowledge' | 'resolve',
    dedupKey: string,
    routingKey?: string,
  ): PagerDutyEventPayload {
    const key = routingKey || env.PAGERDUTY_ROUTING_KEY;
    if (!key) {
      throw new Error('PagerDuty routing key is required');
    }
    return {
      routing_key: key,
      event_action: action,
      dedup_key: dedupKey,
      payload: {
        summary: `${action === 'resolve' ? 'Resolved' : 'Acknowledged'}: ${dedupKey}`,
        source: 'stellar-alerts',
        severity: 'info',
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Dispatch a trigger event to PagerDuty with rate limit handling and
   * exponential backoff retries.
   */
  async dispatchTrigger(
    input: PagerDutyAlertInput,
    options: PagerDutyDispatchOptions = {},
  ): Promise<PagerDutyDispatchResult> {
    const payload = this.buildTriggerPayload(input, options.routingKey);
    return this.sendPayload(payload, options);
  }

  /**
   * Dispatch an acknowledge or resolve event to PagerDuty.
   */
  async dispatchLifecycle(
    action: 'acknowledge' | 'resolve',
    dedupKey: string,
    options: PagerDutyDispatchOptions = {},
  ): Promise<PagerDutyDispatchResult> {
    const payload = this.buildLifecyclePayload(action, dedupKey, options.routingKey);
    return this.sendPayload(payload, options);
  }

  /**
   * Send a PagerDuty v2 payload with retry and backoff handling.
   */
  async sendPayload(
    payload: PagerDutyEventPayload,
    options: PagerDutyDispatchOptions = {},
  ): Promise<PagerDutyDispatchResult> {
    const timeoutMs = options.timeoutMs ?? env.NOTIFICATION_PROVIDER_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

    let lastResult: PagerDutyDispatchResult = {
      success: false,
      error: 'PagerDuty dispatch did not run',
      dedupKey: payload.dedup_key,
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      lastResult = await this.sendOnce(payload, timeoutMs, options.signal);
      lastResult.attempts = attempt + 1;

      if (lastResult.success) {
        return lastResult;
      }

      const isRetryable =
        lastResult.rateLimited ||
        (lastResult.statusCode !== undefined && lastResult.statusCode >= 500) ||
        lastResult.statusCode === undefined;

      if (!isRetryable || attempt === maxRetries) {
        return lastResult;
      }

      const backoff = Math.min(
        maxRetryDelayMs,
        baseRetryDelayMs * Math.pow(2, attempt),
      );
      const retryAfterMs = lastResult.rateLimited && lastResult.retryAfterSeconds
        ? lastResult.retryAfterSeconds * 1000
        : 0;
      const delayMs = Math.min(maxRetryDelayMs, Math.max(backoff, retryAfterMs));
      await this.sleep(delayMs, options.signal);
    }

    return lastResult;
  }

  private async sendOnce(
    payload: PagerDutyEventPayload,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PagerDutyDispatchResult> {
    try {
      const response = await fetchWithTimeout(
        PAGERDUTY_EVENTS_ENDPOINT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
        timeoutMs,
        signal,
        'PagerDuty',
      );

      if (response.status === 429) {
        const retryHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryHeader ? parseInt(retryHeader, 10) : undefined;
        return {
          success: false,
          statusCode: 429,
          rateLimited: true,
          retryAfterSeconds,
          dedupKey: payload.dedup_key,
          error: `PagerDuty rate limited (429); retry after ${retryAfterSeconds ?? 'unknown'}s`,
        };
      }

      const rawBody = await response.text();
      let parsed: any = undefined;
      try {
        parsed = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        parsed = undefined;
      }

      if (!response.ok) {
        return {
          success: false,
          statusCode: response.status,
          dedupKey: payload.dedup_key,
          error: `PagerDuty responded with HTTP ${response.status}: ${rawBody || 'no body'}`,
        };
      }

      return {
        success: true,
        statusCode: response.status,
        dedupKey: payload.dedup_key,
        incidentKey: parsed?.dedup_key || parsed?.incident_key,
      };
    } catch (err: any) {
      return {
        success: false,
        dedupKey: payload.dedup_key,
        error: err.message || 'Failed to dispatch PagerDuty event',
      };
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clean();
        resolve();
      }, ms);
      const onAbort = () => {
        clean();
        reject(new Error('PagerDuty retry aborted'));
      };
      const clean = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) {
        if (signal.aborted) {
          clean();
          reject(new Error('PagerDuty retry aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  private hashString(value: string): string {
    // Deterministic FNV-1a-style hash for stable dedupKeys.
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }
}

export const pagerDutyProvider = new PagerDutyProvider();
