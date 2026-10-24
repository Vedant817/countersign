import type { Metadata, Viewport } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Countersign — provable intent for agent payments on PayPal',
    template: '%s · Countersign',
  },
  description:
    'A signed Verifiable Intent mandate, a deterministic merchant-side Gate, and a Dispute Defender ' +
    'that either cites its evidence or tells the merchant to refund honestly.',
  applicationName: 'Countersign',
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#faf9f7',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-paper-raised focus:px-4 focus:py-2 focus:shadow"
        >
          Skip to content
        </a>
        <header className="border-b border-rule bg-paper-raised">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4">
            <Link href="/" className="brand-link text-lg font-semibold tracking-tight">
              <span aria-hidden="true" className="brand-mark">
                C/
              </span>{' '}
              Countersign
            </Link>
            <nav aria-label="Main navigation" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <Link href="/shop">Storefront</Link>
              <Link href="/lab/device-sign">Signing lab</Link>
              <Link href="/judge">Demo guide</Link>
              <Link href="/regions">Coverage</Link>
              <Link href="/status">Service status</Link>
            </nav>
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="border-t border-rule px-4 py-6 text-sm text-ink-soft">
          <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-3">
            <p>Payment sandbox. No live money moves in these demonstrations.</p>
            <Link href="/regions" className="underline underline-offset-4">
              Currencies and regional limits
            </Link>
          </div>
        </footer>
      </body>
    </html>
  )
}
