import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../lib/redis';

/**
 * Idempotency key support for mutation endpoints (POST/PUT/PATCH/DELETE).
 *
 * Clients include an `Idempotency-Key` header (UUID or opaque string, max
 * 255 chars) with any mutation request.  When the server has already
 * processed a request with that key it returns the original response from
 * cache without re-executing the handler.
 *
 * Cache entry shape stored in Redis (JSON string):
 *   { statusCode: number; body: string; contentType: string }
 *
 * TTL: 24 hours (configurable via IDEMPOTENCY_TTL_SECONDS env var).
 * Key namespace: `idempotency:<userId>:<key>` — scoped per-user so different
 *   users' idempotency keys cannot collide or leak each other's responses.
 *   Falls back to `idempotency:anon:<key>` for unauthenticated routes.
 *
 * Only POST/PUT/PATCH/DELETE methods are checked; GET/HEAD/OPTIONS are
 * naturally idempotent and skipped.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_KEY_LENGTH = 255;
const SAFE_KEY_RE = /^[\w\-]{1,255}$/;
const DEFAULT_TTL_SECONDS = 86_400; // 24 hours

interface CachedResponse {
  statusCode: number;
  body: string;
  contentType: string;
}

function ttl(): number {
  const raw = process.env.IDEMPOTENCY_TTL_SECONDS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TTL_SECONDS;
}

function buildRedisKey(userId: string | undefined, key: string): string {
  const scope = userId ?? 'anon';
  return `idempotency:${scope}:${key}`;
}

export async function registerIdempotency(app: FastifyInstance): Promise<void> {
  // ── Pre-handler: check whether we have a cached response ────────────────
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!MUTATION_METHODS.has(request.method)) return;

    const raw = request.headers[IDEMPOTENCY_HEADER];
    const keyHeader = Array.isArray(raw) ? raw[0] : raw;
    if (!keyHeader) return;

    if (keyHeader.length > MAX_KEY_LENGTH || !SAFE_KEY_RE.test(keyHeader)) {
      return reply.status(400).send({
        error: 'Invalid Idempotency-Key',
        message: `Idempotency-Key must be 1–${MAX_KEY_LENGTH} alphanumeric/hyphen/underscore characters.`,
        code: 'INVALID_IDEMPOTENCY_KEY',
      });
    }

    const userId = (request as any).user?.id as string | undefined;
    const redisKey = buildRedisKey(userId, keyHeader);

    let cached: CachedResponse | null = null;
    try {
      const raw = await redis.get(redisKey);
      if (raw) cached = JSON.parse(raw) as CachedResponse;
    } catch {
      // Redis unavailable — fail open and let the handler run normally.
      request.log.warn('[Idempotency] Redis unavailable; proceeding without idempotency check');
      return;
    }

    if (cached) {
      request.log.info(
        { idempotencyKey: keyHeader },
        '[Idempotency] Returning cached response',
      );
      return reply
        .status(cached.statusCode)
        .header('Idempotency-Replayed', 'true')
        .header('Content-Type', cached.contentType)
        .send(cached.body);
    }

    // Stash the key on the request so the onSend hook can persist the result.
    (request as any)._idempotencyKey = keyHeader;
    (request as any)._idempotencyRedisKey = redisKey;
  });

  // ── onSend: persist the response so future requests with the same key
  //    get the cached result.
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    const redisKey: string | undefined = (request as any)._idempotencyRedisKey;
    if (!redisKey) return payload;

    // Only cache successful responses (2xx).
    const statusCode = reply.statusCode;
    if (statusCode < 200 || statusCode >= 300) return payload;

    const contentType = reply.getHeader('content-type') as string ?? 'application/json';
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);

    const entry: CachedResponse = { statusCode, body, contentType };

    try {
      await redis.set(redisKey, JSON.stringify(entry), 'EX', ttl());
    } catch {
      request.log.warn('[Idempotency] Redis unavailable; response not cached');
    }

    return payload;
  });
}

/**
 * Per-route idempotency hooks factory.
 *
 * Returns `{ preValidation, onSend, onResponse }` arrays that can be passed
 * directly to individual route option objects instead of registering an
 * app-wide hook via `registerIdempotency`.
 *
 * @example
 * const idempotent = idempotencyHooks();
 * app.post('/resource', {
 *   preValidation: idempotent.preValidation,
 *   onSend: idempotent.onSend,
 *   onResponse: idempotent.onResponse,
 * }, handler);
 */
export function idempotencyHooks() {
  const preValidation = [
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!MUTATION_METHODS.has(request.method)) return;

      const raw = request.headers[IDEMPOTENCY_HEADER];
      const keyHeader = Array.isArray(raw) ? raw[0] : raw;
      if (!keyHeader) return;

      if (keyHeader.length > MAX_KEY_LENGTH || !SAFE_KEY_RE.test(keyHeader)) {
        return reply.status(400).send({
          error: 'Invalid Idempotency-Key',
          message: `Idempotency-Key must be 1–${MAX_KEY_LENGTH} alphanumeric/hyphen/underscore characters.`,
          code: 'INVALID_IDEMPOTENCY_KEY',
        }) as unknown as void;
      }

      const userId = (request as any).user?.id as string | undefined;
      const redisKey = buildRedisKey(userId, keyHeader);

      let cached: CachedResponse | null = null;
      try {
        const stored = await redis.get(redisKey);
        if (stored) cached = JSON.parse(stored) as CachedResponse;
      } catch {
        // Redis unavailable — fail open and let the handler run normally.
        request.log.warn({ reqId: request.id }, '[Idempotency] Redis unavailable; proceeding without idempotency check');
        return;
      }

      if (cached) {
        request.log.info(
          { reqId: request.id, idempotencyKey: keyHeader },
          '[Idempotency] Returning cached response',
        );
        return reply
          .status(cached.statusCode)
          .header('Idempotency-Replayed', 'true')
          .header('Content-Type', cached.contentType)
          .send(cached.body) as unknown as void;
      }

      // Stash for the onSend hook to persist.
      (request as any)._idempotencyKey = keyHeader;
      (request as any)._idempotencyRedisKey = redisKey;
    },
  ];

  const onSend = [
    async (request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
      const redisKey: string | undefined = (request as any)._idempotencyRedisKey;
      if (!redisKey) return payload;

      // Only cache successful responses (2xx).
      const statusCode = reply.statusCode;
      if (statusCode < 200 || statusCode >= 300) return payload;

      const contentType = reply.getHeader('content-type') as string ?? 'application/json';
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);

      const entry: CachedResponse = { statusCode, body, contentType };

      try {
        await redis.set(redisKey, JSON.stringify(entry), 'EX', ttl());
      } catch {
        request.log.warn({ reqId: request.id }, '[Idempotency] Redis unavailable; response not cached');
      }

      return payload;
    },
  ];

  // onResponse is present for symmetry; no work needed here.
  const onResponse: Array<(request: FastifyRequest, reply: FastifyReply) => Promise<void>> = [];

  return { preValidation, onSend, onResponse };
}
