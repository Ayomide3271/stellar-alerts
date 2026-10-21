import { FastifyInstance } from 'fastify';

/**
 * Registers a global `onSend` hook that attaches security response headers to
 * every reply produced by the API.
 *
 * Headers applied:
 *   X-Content-Type-Options   — prevent MIME-sniffing
 *   X-Frame-Options          — deny framing (clickjacking protection)
 *   Referrer-Policy          — restrict referrer leakage
 *   Strict-Transport-Security — enforce HTTPS for 1 year with subdomains
 *   Permissions-Policy       — disable unused browser features
 *   Content-Security-Policy  — tight policy for API JSON responses
 *                              (no scripts/frames/plugins needed)
 *   X-Powered-By removal     — avoid advertising the server technology stack
 *
 * The hook is idempotent: it does not overwrite a header that was already set
 * by a route handler (e.g. a route that sends a PDF with its own content-type).
 */
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  // Remove the default X-Powered-By header Fastify does not add itself, but
  // underlying adapters or CDNs might inject. Belt-and-suspenders.
  app.addHook('onSend', async (_request, reply, payload) => {
    // Only set a header when the route has not already done so.
    const setIfMissing = (name: string, value: string) => {
      if (!reply.hasHeader(name)) {
        reply.header(name, value);
      }
    };

    setIfMissing('X-Content-Type-Options', 'nosniff');
    setIfMissing('X-Frame-Options', 'DENY');
    setIfMissing('Referrer-Policy', 'strict-origin-when-cross-origin');
    setIfMissing(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload',
    );
    setIfMissing(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    // API responses are pure JSON — no scripts, no iframes, no plugins.
    setIfMissing(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none';",
    );

    // Suppress technology-stack advertisement.
    reply.removeHeader('X-Powered-By');
    reply.removeHeader('server');

    return payload;
  });
}
