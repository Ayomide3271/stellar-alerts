import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseRetryAfterMs,
  parseRateLimitResetMs,
  getAdaptiveBackoffMs,
  getRateLimitDomain,
  readHeader,
  clampDelay,
  AdaptiveWebhookRateLimiter,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from '../rate-limiter';

describe('Adaptive Webhook Rate Limiter', () => {
  const baseTime = 1700000000000; // Fixed timestamp for deterministic testing

  describe('readHeader', () => {
    it('reads headers case-insensitively from plain record objects', () => {
      expect(readHeader({ 'Retry-After': '45' }, 'retry-after')).toBe('45');
      expect(readHeader({ 'RETRY-AFTER': '60' }, 'retry-after')).toBe('60');
      expect(readHeader({ 'x-ratelimit-reset': '1700000100' }, 'X-RateLimit-Reset')).toBe('1700000100');
    });

    it('reads headers from Headers-like objects with get() method', () => {
      const headers = new Headers();
      headers.set('Retry-After', '25');
      expect(readHeader(headers, 'retry-after')).toBe('25');
    });

    it('returns null when header is absent or headers undefined', () => {
      expect(readHeader(undefined, 'retry-after')).toBeNull();
      expect(readHeader({}, 'retry-after')).toBeNull();
    });
  });

  describe('clampDelay', () => {
    it('returns DEFAULT_BACKOFF_MS for non-positive or invalid ms', () => {
      expect(clampDelay(0)).toBe(DEFAULT_BACKOFF_MS);
      expect(clampDelay(-100)).toBe(DEFAULT_BACKOFF_MS);
      expect(clampDelay(NaN)).toBe(DEFAULT_BACKOFF_MS);
    });

    it('caps delay to MAX_BACKOFF_MS', () => {
      expect(clampDelay(10 * 60_000)).toBe(MAX_BACKOFF_MS);
    });

    it('preserves valid delay within bounds', () => {
      expect(clampDelay(15_000)).toBe(15_000);
    });
  });

  describe('parseRetryAfterMs', () => {
    it('parses numeric delta-seconds', () => {
      expect(parseRetryAfterMs('30', baseTime)).toBe(30_000);
      expect(parseRetryAfterMs('5', baseTime)).toBe(5_000);
    });

    it('parses HTTP-date string format', () => {
      const futureDate = new Date(baseTime + 45_000).toUTCString();
      expect(parseRetryAfterMs(futureDate, baseTime)).toBe(45_000);
    });

    it('returns null on invalid or empty string', () => {
      expect(parseRetryAfterMs(null)).toBeNull();
      expect(parseRetryAfterMs('')).toBeNull();
      expect(parseRetryAfterMs('not-a-valid-date-or-number')).toBeNull();
    });
  });

  describe('parseRateLimitResetMs', () => {
    it('parses Unix timestamp in epoch seconds', () => {
      const resetEpochSec = Math.floor(baseTime / 1000) + 20;
      expect(parseRateLimitResetMs(String(resetEpochSec), baseTime)).toBe(20_000);
    });

    it('parses timestamp in epoch milliseconds', () => {
      const resetEpochMs = baseTime + 25_000;
      expect(parseRateLimitResetMs(String(resetEpochMs), baseTime)).toBe(25_000);
    });

    it('returns null for invalid values', () => {
      expect(parseRateLimitResetMs(null)).toBeNull();
      expect(parseRateLimitResetMs('invalid')).toBeNull();
    });
  });

  describe('getAdaptiveBackoffMs', () => {
    it('prioritizes Retry-After header', () => {
      const headers = {
        'Retry-After': '15',
        'X-RateLimit-Reset': String(Math.floor(baseTime / 1000) + 60),
      };
      expect(getAdaptiveBackoffMs(headers, baseTime)).toBe(15_000);
    });

    it('falls back to X-RateLimit-Reset-After header', () => {
      const headers = {
        'X-RateLimit-Reset-After': '12',
      };
      expect(getAdaptiveBackoffMs(headers, baseTime)).toBe(12_000);
    });

    it('uses X-RateLimit-Reset when retry-after is absent', () => {
      const resetEpochSec = Math.floor(baseTime / 1000) + 18;
      const headers = {
        'x-ratelimit-reset': String(resetEpochSec),
        'x-ratelimit-remaining': '0',
      };
      expect(getAdaptiveBackoffMs(headers, baseTime)).toBe(18_000);
    });

    it('falls back to DEFAULT_BACKOFF_MS when no rate limit headers are present', () => {
      expect(getAdaptiveBackoffMs({}, baseTime)).toBe(DEFAULT_BACKOFF_MS);
    });
  });

  describe('getRateLimitDomain', () => {
    it('extracts host in lowercase from valid URL', () => {
      expect(getRateLimitDomain('https://Api.Partner.com:8443/webhooks/incoming')).toBe('api.partner.com:8443');
      expect(getRateLimitDomain('https://Hook.Receiver.org/events')).toBe('hook.receiver.org');
    });

    it('handles malformed URL gracefully', () => {
      expect(getRateLimitDomain('raw-domain.internal')).toBe('raw-domain.internal');
    });
  });

  describe('AdaptiveWebhookRateLimiter instance', () => {
    let limiter: AdaptiveWebhookRateLimiter;

    beforeEach(() => {
      limiter = new AdaptiveWebhookRateLimiter();
    });

    it('tracks rate limits per domain independently', () => {
      const url1 = 'https://service-a.com/webhook';
      const url2 = 'https://service-b.com/webhook';

      const delayA = limiter.recordRateLimit(url1, { 'Retry-After': '10' }, baseTime);
      expect(delayA).toBe(10_000);

      expect(limiter.getDelayMs(url1, baseTime)).toBe(10_000);
      expect(limiter.getDelayMs(url2, baseTime)).toBe(0);

      // Advance time by 4 seconds
      expect(limiter.getDelayMs(url1, baseTime + 4_000)).toBe(6_000);

      // Advance past delay
      expect(limiter.getDelayMs(url1, baseTime + 11_000)).toBe(0);
    });

    it('clears rate limits explicitly on success', () => {
      const url = 'https://service-c.com/webhook';
      limiter.recordRateLimit(url, { 'Retry-After': '30' }, baseTime);
      expect(limiter.getDelayMs(url, baseTime)).toBe(30_000);

      limiter.clear(url);
      expect(limiter.getDelayMs(url, baseTime)).toBe(0);
    });
  });
});
