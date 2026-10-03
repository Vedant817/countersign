import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Never leak the DB password or the PayPal secret into a client bundle.
  serverExternalPackages: ['postgres', 'pg-boss', '@react-pdf/renderer'],
  experimental: {
    // The Dispute Defender streams agent progress; the UI polls /api/judge runs.
    proxyTimeout: 30_000,
  },
  eslint: {
    // Lint is a separate CI gate (AGENTS.md rule 5); keep `next build` focused on types.
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          {
            key: 'Permissions-Policy',
            // The wallet needs WebAuthn (publickey-credentials-get) and nothing else.
            value: 'publickey-credentials-get=(self), geolocation=(), microphone=(), camera=()',
          },
        ],
      },
    ]
  },
}

export default nextConfig