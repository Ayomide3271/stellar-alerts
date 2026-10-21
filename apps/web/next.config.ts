import type { NextConfig } from "next";

/**
 * Security headers applied at the Next.js config layer to every response
 * (HTML pages, API routes, static assets).  The per-request CSP with a
 * per-request nonce is handled separately in proxy.ts; the headers below
 * are static and safe to set at build-time / globally.
 *
 * NOTE: Content-Security-Policy itself is NOT set here — it is generated
 * dynamically per request in proxy.ts so it can include a fresh nonce.
 */
const securityHeaders = [
  // Deny framing (clickjacking protection).
  { key: 'X-Frame-Options', value: 'DENY' },
  // Prevent MIME-type sniffing.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Leak only the origin (no path) when navigating cross-origin.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // HSTS: 1 year with subdomains + preload.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains; preload',
  },
  // Disable browser features the app does not use.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];

const nextConfig: NextConfig = {
  compress: true,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        source: "/manifest.json",
        headers: [
          {
            key: "Content-Type",
            value: "application/manifest+json",
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
          {
            key: "Service-Worker-Allowed",
            value: "/",
          },
        ],
      },
      {
        source: "/:path((?!api).*)*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, stale-while-revalidate=86400",
          },
        ],
      },
      {
        source: "/offline.html",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
        ],
      },
    ];
  },

  async rewrites() {
    return {
      afterFiles: [
        {
          source: "/offline",
          destination: "/offline.html",
        },
      ],
    };
  },

  reactStrictMode: true,
};

export default nextConfig;
