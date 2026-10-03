import type { Metadata, Viewport } from 'next'
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
    <html lang="en-IN">
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-[--color-paper-raised] focus:px-4 focus:py-2 focus:shadow"
        >
          Skip to content
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  )
}