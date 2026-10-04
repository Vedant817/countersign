import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Keep Node-only dependencies out of the client bundle graph.
   * `postgres` opens a TCP socket, `pg-boss` and `@react-pdf/renderer` reach for native/worker code:
   * if any of these were bundled, `next build` would either fail or, worse, ship a bundle that
   * reaches for a connection string in the browser.
   */
  serverExternalPackages: ['postgres', 'pg-boss', '@react-pdf/renderer'],

  experimental: {
    // The Dispute Defender and Judge Mode stream progress over long requests; the default 10 s
    // proxy timeout would cut a 90 s scenario in half (spec §14 SLO).
    proxyTimeout: 120_000,
  },

  /**
   * Next 16 no longer accepts an `eslint` key in NextConfig — lint is not run by `next build` at all.
   * `pnpm lint` is this repository's single lint gate (AGENTS.md rule 5), so there is nothing to
   * disable here and nothing lost. Type errors *do* fail the build, because CI's typecheck job can
   * be skipped by a path filter and a build must not be able to ship broken types.
   */
  typescript: {
    ignoreBuildErrors: false,
  },

  /**
   * Baseline security headers on every response.
   *
   * `Permissions-Policy` matters here for a specific reason, not as boilerplate: the wallet UI needs
   * `publickey-credentials-get` for the WebAuthn step-up at signing (spec D4, EC-FAM-1) and needs
   * nothing else. Granting only that one feature is what stops a future dependency quietly turning
   * on the camera or the microphone on a payments page.
   */
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
            value:
              'publickey-credentials-get=(self), geolocation=(), microphone=(), camera=(), payment=()',
          },
        ],
      },
    ]
  },
}

export default nextConfig
