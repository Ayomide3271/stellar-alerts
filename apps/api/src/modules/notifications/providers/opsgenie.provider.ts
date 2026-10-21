/*
 * Atlassian Opsgenie Incident Escalation Provider (#637).
 *
 * Implements enterprise on-call notification dispatching via Opsgenie Alert API:
 * - Structured alert creation payloads per official Opsgenie Alert API
 * - Priority mapping (critical, error, warning) to Opsgenie P1-P3 priorities
 * - Tag and details enrichment for Stellar contract events
 * - Deduplication via alias for alert correlation and auto-close
 * - Rate limit handling (429 Retry-After) and retries with exponential backoff
 */

import { env } from '../../../config/env';
import { fetchWithTimeout } from '../../../lib/external-request';

export type OpsgeniePriority = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

export type OpsgenieAlertAction = 'create' | 'close';

export interface OpsgenieDetails {
  alertId?: string;
  contractId?: string;
  txHash?: string;
  network?: string;
  eventType?: string;
  dashboardUrl?: string;
  explorerUrl?: string;
  [key: string]: unknown;
}

export interface OpsgenieCreatePayload {
  message: string;
  alias?: string;
  description?: string;
  responders?: Array<{ type: 'team' | 'user' | 'escalation' | 'schedule'; id?: string; name?: string; username?: string }>;
  visibleTo?: Array<{ type: 'team' | 'user'; id?: string; name?: string; username?: string }>;
  actions?: Array<{ action: string; description?: string; entity?: string }>;
  tags?: string[];
  details?: Record<string, string>;
  entity?: string;
  source?: string;
  priority?: OpsgeniePriority;
  user?: string;
  note?: string;
}

export interface OpsgenieClosePayload {
  note?: string;
  source?: string;
}

export interface OpsgenieAlertInput {
  alertId?: string;
  title?: string;
  message: string;
  severity?: string;
  priority?: OpsgeniePriority;
  alias?: string;
  description?: string;
  entity?: string;
  source?: string;
  tags?: string[];
  details?: OpsgenieDetails;
  responders?: OpsgenieCreatePayload['responders'];
  visibleTo?: OpsgenieCreatePayload['visibleTo'];
  actions?: OpsgenieCreatePayload['actions'];
  note?: string;
  user?: string;
}

export interface OpsgenieDispatchOptions {
  apiKey?: string;
  region?: 'us' | 'eu';
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export interface OpsgenieDispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  rateLimited?: boolean;
  retryAfterSeconds?: number;
  attempts?: number;
  alias?: string;
  requestId?: string;
}

const OPSGENIE_US_ENDPOINT = 'https://api.opsgenie.com/v2/alerts';
const OPSGENIE_EU_ENDPOINT = 'https://api.eu.opsgenie.com/v2/alerts';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 5000;

export class OpsgenieProvider {
  /**
   * Validate an Opsgenie API key. Opsgenie keys are UUID-like strings.
   */
  isValidApiKey(key?: string | null): boolean {
    if (!key) return false;
    return /^[A-Za-z0-9_-]{16,128}$/.test(key.trim());
  }

  /**
   * Map an alert severity to an Opsgenie priority (P1-P5).
   */
  mapSeverityToPriority(severity?: string | null): OpsgeniePriority {
    const value = (severity || 'error').toLowerCase().trim();
    switch (value) {
      case 'critical':
      case 'fatal':
      case 'p1':
        return 'P1';
      case 'error':
      case 'high':
      case 'p2':
        return 'P2';
      case 'warning':
      case 'medium':
      case 'p3':
        return 'P3';
      case 'info':
      case 'low':
      case 'p4':
        return 'P4';
      case 'debug':
      case 'trace':
      case 'p5':
        return 'P5';
      default:
        return 'P2';
    }
  }

  /**
   * Derive a deterministic alias for alert correlation and deduplication.
   */
  buildAlias(input: OpsgenieAlertInput): string {
    if (input.alias) {
      return input.alias;
    }
    const alertId = input.alertId || input.details?.alertId;
    if (alertId) {
      return `stellar-alerts-${alertId}`;
    }
    const contractId = input.details?.contractId;
    const eventType = input.details?.eventType;
    if (contractId && eventType) {
      return `stellar-alerts-${contractId}-${eventType}`;
    }
    return `stellar-alerts-${this.hashString(input.message)}`;
  }

  /**
   * Build an Opsgenie alert creation payload.
   */
  buildCreatePayload(input: OpsgenieAlertInput): OpsgenieCreatePayload {
    const alias = this.buildAlias(input);
    const priority = input.priority || this.mapSeverityToPriority(input.severity);

    const tags = this.normalizeTags(input.tags, input.severity);

    const details = this.normalizeDetails(input.details);

    const payload: OpsgenieCreatePayload = {
      message: input.title || input.message,
      alias,
      description: input.description || input.message,
      entity: input.entity || input.details?.contractId || 'stellar-alerts',
      source: input.source || 'stellar-alerts',
      priority,
      tags,
      details,
    };

    if (input.responders) payload.responders = input.responders;
    if (input.visibleTo) payload.visibleTo = input.visibleTo;
    if (input.actions) payload.actions = input.actions;
    if (input.note) payload.note = input.note;
    if (input.user) payload.user = input.user;

    return payload;
  }

  /**
   * Build an Opsgenie alert close payload.
   */
  buildClosePayload(note?: string, source?: string): OpsgenieClosePayload {
    const payload: OpsgenieClosePayload = {};
    if (note) payload.note = note;
    if (source) payload.source = source;
    return payload;
  }

  /**
   * Dispatch an Opsgenie alert creation with rate limit handling and
   * exponential backoff retries.
   */
  async dispatchAlert(
    input: OpsgenieAlertInput,
    options: OpsgenieDispatchOptions = {},
  ): Promise<OpsgenieDispatchResult> {
    const payload = this.buildCreatePayload(input);
    return this.sendPayload('create', payload, payload.alias, options);
  }

  /**
   * Close an existing Opsgenie alert by alias.
   */
  async closeAlert(
    alias: string,
    options: OpsgenieDispatchOptions = {},
    note?: string,
  ): Promise<OpsgenieDispatchResult> {
    const payload = this.buildClosePayload(note);
    return this.sendPayload('close', payload, alias, options);
  }

  /**
   * Send an Opsgenie payload with retry and backoff handling.
   */
  async sendPayload(
    action: OpsgenieAlertAction,
    payload: OpsgenieCreatePayload | OpsgenieClosePayload,
    alias: string,
    options: OpsgenieDispatchOptions = {},
  ): Promise<OpsgenieDispatchResult> {
    const timeoutMs = options.timeoutMs ?? env.NOTIFICATION_PROVIDER_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

    const endpoint = this.resolveEndpoint(action, alias, options.region);
    const apiKey = options.apiKey || env.OPSGENIE_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        alias,
        error: 'Opsgenie API key is required',
      };
    }

    let lastResult: OpsgenieDispatchResult = {
      success: false,
      alias,
      error: 'Opsgenie dispatch did not run',
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      lastResult = await this.sendOnce(endpoint, apiKey, payload, alias, timeoutMs, options.signal);
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

  private resolveEndpoint(action: OpsgenieAlertAction, alias: string, region?: 'us' | 'eu'): string {
    const base = region === 'eu' ? OPSGENIE_EU_ENDPOINT : OPSGENIE_US_ENDPOINT;
    if (action === 'close') {
      return `${base}/${encodeURIComponent(alias)}/close?source=stellar-alerts`;
    }
    return base;
  }

  private async sendOnce(
    endpoint: string,
    apiKey: string,
    payload: OpsgenieCreatePayload | OpsgenieClosePayload,
    alias: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<OpsgenieDispatchResult> {
    try {
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
        timeoutMs,
        signal,
        'Opsgenie',
      );

      if (response.status === 429) {
        const retryHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryHeader ? parseInt(retryHeader, 10) : undefined;
        return {
          success: false,
          statusCode: 429,
          rateLimited: true,
          retryAfterSeconds,
          alias,
          error: `Opsgenie rate limited (429); retry after ${retryAfterSeconds ?? 'unknown'}s`,
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
        const message = parsed?.message || parsed?.error || rawBody || 'no body';
        return {
          success: false,
          statusCode: response.status,
          alias,
          error: `Opsgenie responded with HTTP ${response.status}: ${message}`,
        };
      }

      return {
        success: true,
        statusCode: response.status,
        alias,
        requestId: parsed?.requestId,
      };
    } catch (err: any) {
      return {
        success: false,
        alias,
        error: err.message || 'Failed to dispatch Opsgenie alert',
      };
    }
  }

  private normalizeTags(tags?: string[], severity?: string): string[] {
    const base = new Set<string>(['stellar-alerts', 'security']);
    if (severity) base.add(severity.toLowerCase());
    if (tags) {
      for (const tag of tags) {
        if (tag && tag.trim()) base.add(tag.trim());
      }
    }
    return Array.from(base);
  }

  private normalizeDetails(details?: OpsgenieDetails): Record<string, string> {
    const out: Record<string, string> = {};
    if (!details) return out;
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined || value === null) continue;
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return out;
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
        reject(new Error('Opsgenie retry aborted'));
      };
      const clean = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) {
        if (signal.aborted) {
          clean();
          reject(new Error('Opsgenie retry aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  private hashString(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }
}

export const opsgenieProvider = new OpsgenieProvider();
