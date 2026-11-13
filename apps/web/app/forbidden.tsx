/**
 * The 403 boundary for `forbidden()` — `lib/auth.ts`.
 *
 * Next renders this with a real 403 status when a signed-in non-merchant reaches `/disputes`. The default
 * page would be unbranded English; this one says the same thing in the app's own terms, and — the part that
 * matters — does not offer a sign-in link that would let a buyer retry their way into the queue.
 */
import Link from 'next/link'

export default function Forbidden(): React.ReactElement {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <p className="font-mono text-xs uppercase tracking-widest text-blocked">403</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        This page is the merchant&rsquo;s
      </h1>
      <p className="mt-4 text-ink-soft">
        The dispute queue and the approval click belong to the merchant account. The account you are
        signed in with is not that account, so nothing on this page was shown.
      </p>
      <Link className="mt-6 inline-block text-sm underline" href="/">
        Back to the storefront
      </Link>
    </main>
  )
}
