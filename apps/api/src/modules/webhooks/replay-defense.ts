import type { FastifyReply, FastifyRequest } from 'fastify';
import type Redis from 'ioredis';

import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { checkAndStoreNonce } from '../../lib/nonceCache';
import { redis } from '../../lib/redis';
import { AuthenticationError } from '../../lib/errors';

/**
 * Replay-defense for signed webhook and API-webhook requests (#718).
 *
 * Signed requests are only trustworthy exactly once: an attacker who
 * intercepts a valid `X-Stellar-Signature` header can otherwise replay the
 * identical request forever. Two independent controls close that hole:
 *
 *  1. **Timestamp drift bound** — the request timestamp (`t=` in the
 *     signature header, or `X-Stellar-Alerts-Timestamp`) must be within
 *     ±30 seconds of server time. Anything further is rejected outright.
 *  2. **One-time nonce** — the nonce (`n=` in the signature header, or
 *     `X-Stellar-Alerts-Nonce`) is atomically consumed in Redis via
 *     `SET key 1 EX <ttl> NX` with a 5-minute TTL. A second request that
 *     presents an already-consumed nonce is rejected even if its timestamp
 *     is still inside the drift window.
 *
 * Rejections are answered with HTTP 401 and recorded as a `HIGH` severity
 * `WEBHOOK_REPLAY_ATTEMPT` entry in `SecurityAuditLog`.
 */

export const REPLAY_DRIFT_TOLERANCE_MS = 30_000;
export const REPLAY_NONCE_TTL_SECONDS = 300; // 5 minutes

export const REPLAY_NONCE_HEADER = 'x-stellar-alerts-nonce';
export const REPLAY_TIMESTAMP_HEADER = 'x-stellar-alerts-timestamp';
export const REPLAY_SIGNATURE_HEADER = 'x-stellar-signature';

export type ReplayRejectionReason =
  | 'MISSING_NONCE'
  | 'INVALID_NONCE'
  | 'MISSING_TIMESTAMP'
  | 'INVALID_TIMESTAMP'
  | 'TIMESTAMP_DRIFT_EXCEEDED'
  | 'NONCE_ALREADY_CONSUMED';

export interface ReplayCheckContext {
  /** Route or logical endpoint the request targeted (for the audit trail). */
  endpoint?: string;
  webhookId?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
}

export interface ReplayCheckInput {
  nonce?: string | null;
  /** Epoch milliseconds (number or numeric string), usually from `t=`/`X-Stellar-Alerts-Timestamp`. */
  timestamp?: string | number | null;
  context?: ReplayCheckContext;
}

export type ReplayCheckResult =
  | { ok: true; nonce: string; timestamp: number; driftMs: number }
  | {
      ok: false;
      reason: ReplayRejectionReason;
      message: string;
      statusCode: 401;
      driftMs?: number;
    };

export interface ReplayDefenseOptions {
  /** Maximum allowed |now - timestamp| in ms. Defaults to 30s. */
  driftToleranceMs?: number;
  /** Redis TTL for consumed nonces in seconds. Defaults to 300s (5 min). */
  nonceTtlSeconds?: number;
  redisClient?: Redis;
}

function parseTimestamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.NaN;
  }
  return Math.floor(parsed);
}

function reject(
  reason: ReplayRejectionReason,
  message: string,
  driftMs?: number,
): Extract<ReplayCheckResult, { ok: false }> {
  return driftMs === undefined
    ? { ok: false, reason, message, statusCode: 401 }
    : { ok: false, reason, message, statusCode: 401, driftMs };
}

export class ReplayDefense {
  private readonly driftToleranceMs: number;
  private readonly nonceTtlSeconds: number;
  private readonly redisClient: Redis;

  constructor(options: ReplayDefenseOptions = {}) {
    this.driftToleranceMs =
      options.driftToleranceMs ??
      env.WEBHOOK_REPLAY_DRIFT_TOLERANCE_MS ??
      REPLAY_DRIFT_TOLERANCE_MS;
    this.nonceTtlSeconds =
      options.nonceTtlSeconds ??
      env.WEBHOOK_REPLAY_NONCE_TTL_SECONDS ??
      REPLAY_NONCE_TTL_SECONDS;
    this.redisClient = options.redisClient ?? redis;
  }

  /**
   * Validates timestamp drift and enforces one-time nonce consumption.
   * Never throws — callers decide how to surface a rejection.
   */
  async check(input: ReplayCheckInput): Promise<ReplayCheckResult> {
    const nonce = typeof input.nonce === 'string' ? input.nonce.trim() : '';
    if (!nonce) {
      return reject('MISSING_NONCE', 'Missing replay-protection nonce');
    }
    if (nonce.length > 128) {
      return reject('INVALID_NONCE', 'Nonce exceeds the maximum allowed length');
    }

    const timestamp = parseTimestamp(input.timestamp);
    if (timestamp === null) {
      return reject('MISSING_TIMESTAMP', 'Missing request timestamp');
    }
    if (Number.isNaN(timestamp)) {
      return reject('INVALID_TIMESTAMP', 'Request timestamp is not a valid epoch millisecond value');
    }

    const driftMs = Date.now() - timestamp;
    if (Math.abs(driftMs) > this.driftToleranceMs) {
      const direction = driftMs > 0 ? 'older' : 'further in the future than';
      return reject(
        'TIMESTAMP_DRIFT_EXCEEDED',
        `Request timestamp is ${direction} the allowed ${this.driftToleranceMs}ms drift window`,
        driftMs,
      );
    }

    // Atomically consume the nonce. TTL covers the drift window with margin so
    // a request at the edge of the window cannot be replayed after expiry.
    const isFresh = await checkAndStoreNonce(nonce, this.nonceTtlSeconds, this.redisClient);
    if (!isFresh) {
      return reject(
        'NONCE_ALREADY_CONSUMED',
        'Nonce has already been consumed; replayed request rejected',
        driftMs,
      );
    }

    return { ok: true, nonce, timestamp, driftMs };
  }

  /**
   * Same as `check`, but throws a 401 `AuthenticationError` (and writes a
   * security audit log entry) on rejection. Intended for request handlers.
   */
  async assertFresh(input: ReplayCheckInput): Promise<Extract<ReplayCheckResult, { ok: true }>> {
    const result = await this.check(input);
    if (result.ok) {
      return result;
    }

    await this.auditRejection(result, input);
    throw new AuthenticationError(result.message, `WEBHOOK_REPLAY_${result.reason}`);
  }

  private async auditRejection(
    result: Extract<ReplayCheckResult, { ok: false }>,
    input: ReplayCheckInput,
  ): Promise<void> {
    const auditPayload = {
      eventType: 'WEBHOOK_REPLAY_ATTEMPT',
      topic: input.context?.endpoint ?? 'webhook',
      severity: 'HIGH',
      details: {
        reason: result.reason,
        message: result.message,
        nonce: typeof input.nonce === 'string' ? input.nonce : null,
        presentedTimestamp: input.timestamp ?? null,
        driftMs: result.driftMs ?? null,
        webhookId: input.context?.webhookId ?? null,
        userId: input.context?.userId ?? null,
        ip: input.context?.ip ?? null,
        userAgent: input.context?.userAgent ?? null,
        timestamp: new Date().toISOString(),
      },
    };

    // Audit logging must never fail the request — mirror of the pattern in
    // utils/nonce-audit.ts and modules/simulation writeAuditLog.
    try {
      await prisma.securityAuditLog.create({ data: auditPayload as never });
    } catch (error) {
      console.error(
        `[ReplayDefense] Failed to record security audit entry: ${(error as Error).message}`,
      );
    }
  }
}

export const replayDefense = new ReplayDefense();

/**
 * Extracts the nonce and timestamp a signed request presented, preferring the
 * dedicated headers and falling back to the `t=` / `n=` fields embedded in the
 * `X-Stellar-Signature` header (format: `t=<ms>,n=<nonce>,v1=<hex>`).
 */
export function extractReplayHeaders(headers: Record<string, unknown>): {
  nonce: string | null;
  timestamp: string | null;
} {
  const header = (name: string): string | null => {
    const raw = headers[name];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
    return null;
  };

  let nonce = header(REPLAY_NONCE_HEADER);
  let timestamp = header(REPLAY_TIMESTAMP_HEADER);

  const signatureHeader = header(REPLAY_SIGNATURE_HEADER);
  if (signatureHeader && signatureHeader.length <= 8192) {
    const fields = new Map<string, string>();
    for (const segment of signatureHeader.split(',')) {
      const eq = segment.indexOf('=');
      if (eq <= 0) continue;
      const key = segment.slice(0, eq).trim();
      const value = segment.slice(eq + 1).trim();
      if (!fields.has(key)) fields.set(key, value);
    }
    nonce = nonce ?? fields.get('n') ?? null;
    timestamp = timestamp ?? fields.get('t') ?? null;
  }

  return { nonce, timestamp };
}

/**
 * Fastify preHandler that enforces replay defense on any route receiving
 * signed webhook traffic. Register on inbound signed endpoints:
 *
 *   app.addHook('preHandler', createReplayDefenseHook());
 */
export function createReplayDefenseHook(options?: ReplayDefenseOptions) {
  const defense = options ? new ReplayDefense(options) : replayDefense;

  return async function replayDefenseHook(request: FastifyRequest, _reply: FastifyReply) {
    const { nonce, timestamp } = extractReplayHeaders(
      (request.headers ?? {}) as Record<string, unknown>,
    );

    await defense.assertFresh({
      nonce,
      timestamp,
      context: {
        endpoint: `${request.method} ${request.url}`,
        ip: request.ip,
        userAgent: typeof request.headers?.['user-agent'] === 'string'
          ? request.headers['user-agent']
          : undefined,
      },
    });
  };
}
