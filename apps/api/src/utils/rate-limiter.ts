export const DEFAULT_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

export type HeaderReader = Pick<Headers, "get"> | Record<string, string | number | null | undefined>;

export function readHeader(headers: HeaderReader | undefined, name: string): string | null {
  if (!headers) return null;

  if (typeof (headers as Pick<Headers, "get">).get === "function") {
    return (headers as Pick<Headers, "get">).get(name);
  }

  const record = headers as Record<string, string | number | null | undefined>;
  const lowerName = name.toLowerCase();

  for (const [key, val] of Object.entries(record)) {
    if (key.toLowerCase() === lowerName && val !== null && val !== undefined) {
      return String(val);
    }
  }

  return null;
}

export function clampDelay(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_BACKOFF_MS;
  return Math.min(Math.ceil(ms), MAX_BACKOFF_MS);
}

export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return clampDelay(seconds * 1000);
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return null;
  return clampDelay(retryAt - nowMs);
}

export function parseRateLimitResetMs(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;

  const reset = Number(value);
  if (!Number.isFinite(reset)) return null;

  const resetMs = reset > 10_000_000_000 ? reset : reset * 1000;
  return clampDelay(resetMs - nowMs);
}

export function getAdaptiveBackoffMs(headers: HeaderReader | undefined, nowMs = Date.now()): number {
  const retryAfterMs = parseRetryAfterMs(readHeader(headers, "retry-after"), nowMs);
  if (retryAfterMs !== null) return retryAfterMs;

  const resetAfterMs = parseRetryAfterMs(readHeader(headers, "x-ratelimit-reset-after"), nowMs);
  if (resetAfterMs !== null) return resetAfterMs;

  const resetMs = parseRateLimitResetMs(readHeader(headers, "x-ratelimit-reset"), nowMs);
  const remaining = readHeader(headers, "x-ratelimit-remaining");
  if (resetMs !== null && (remaining === "0" || remaining === null)) return resetMs;

  return DEFAULT_BACKOFF_MS;
}

export function getRateLimitDomain(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }

  /**
   * Parse a 429 response's headers to determine how long to back off.
   * Checks `Retry-After` first, then `X-RateLimit-Reset`.
   * Falls back to a 60-second default if neither header is present.
   */
  handleRateLimitResponse(domain: string, headers: Headers): void {
    const now = Date.now();
    let unblockAt: number | undefined;

    // --- Retry-After ---
    const retryAfter = headers.get('Retry-After');
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds) && isFinite(seconds)) {
        // Integer seconds value
        unblockAt = now + seconds * 1000;
      } else {
        // HTTP-date value (e.g. "Wed, 26 Aug 2026 10:00:00 GMT")
        const parsed = Date.parse(retryAfter);
        if (!isNaN(parsed)) {
          unblockAt = parsed;
        }
      }
    }

    // --- X-RateLimit-Reset (Unix timestamp in seconds) ---
    if (unblockAt === undefined) {
      const rlReset = headers.get('X-RateLimit-Reset');
      if (rlReset !== null) {
        const ts = Number(rlReset);
        if (!isNaN(ts) && isFinite(ts)) {
          unblockAt = ts * 1000; // convert seconds -> ms
        }
      }
    }

    // --- Default fallback: 60 seconds ---
    if (unblockAt === undefined) {
      unblockAt = now + 60_000;
    }

    this.blockedUntil.set(domain, unblockAt);
  }

  /**
   * Returns the number of milliseconds remaining until the block expires.
   * Returns 0 if the domain is not blocked.
   */
  getRemainingMs(domain: string): number {
    const until = this.blockedUntil.get(domain);
    if (until === undefined) return 0;
    const remaining = until - Date.now();
    return remaining > 0 ? remaining : 0;
  }
}

export const adaptiveRateLimiter = new AdaptiveRateLimiter();
