import type { NextConfig } from 'next';

/**
 * Masterplan 200: domain security headers. These apply to every tenant host and
 * every custom domain served by this single code base.
 */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  {
    key: 'Content-Security-Policy',
    // Municipal branding is applied through design tokens, never tenant-supplied
    // scripts or stylesheets (masterplan 153).
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self' https://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@tryggsignal/authorization',
    '@tryggsignal/config',
    '@tryggsignal/database',
    '@tryggsignal/domain',
    '@tryggsignal/observability',
    '@tryggsignal/tenancy',
  ],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
