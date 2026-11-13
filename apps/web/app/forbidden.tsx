/**
 * The 403 boundary for `forbidden()` — D-059, D-060.
 *
 * Next renders this with a real 403 status when a signed-in user reaches a surface that belongs to another
 * account: a buyer at `/disputes`, a merchant at `/agent`. The default page would be unbranded English; this
 * one says the same thing in the app's own terms, and — the part that matters — does not offer a sign-in
 * link that would let someone retry their way into the wrong door. The message is about the *account*, not
 * the page, because the two doors now use the same boundary and a page-specific sentence would be a lie on
 * one of them.
 */
import Link from 'next/link'

export default function Forbidden(): React.ReactElement {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <p className="font-mono text-xs uppercase tracking-widest text-blocked">403</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        This page belongs to another account
      </h1>
      <p className="mt-4 text-ink-soft">
        What you asked for is scoped to one kind of account — a buyer&rsquo;s mandates, or the
        merchant&rsquo;s dispute queue — and the account you are signed in with is not that account.
        Nothing on the page was shown.
      </p>
      <Link className="mt-6 inline-block text-sm underline" href="/">
        Back to the storefront
      </Link>
    </main>
  )
}
