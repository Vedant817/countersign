/**
 * `/buyer-login` — the buyer sign-in page, D-060.
 *
 * The mirror of `/login`: a page, because the cookie is `httpOnly` and the guard is server-side; a
 * `?next=` so a buyer who arrived at `/agent` from a bookmark lands back there; and no account list, no
 * "demo login" button, and no hint about which addresses exist.
 *
 * A merchant who signs in here gets a merchant session (the credential check is the same for everyone) and
 * the buyer surfaces refuse it with 403 — so this page is a convenience for buyers, not a boundary. The
 * boundary is `requireBuyer` on each surface.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { currentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/next-path'

import { BuyerLoginForm } from './buyer-login-form'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Buyer sign in',
  description: 'Sign in to sign mandates and shop with your agent.',
}

interface BuyerLoginPageProps {
  readonly searchParams: Promise<{ next?: string | string[] }>
}

export default async function BuyerLoginPage({ searchParams }: BuyerLoginPageProps) {
  const user = await currentUser()
  if (user.ok && user.value !== undefined) {
    redirect(user.value.persona === 'MERCHANT' ? '/disputes' : '/agent')
  }

  const params = await searchParams
  const next = safeNextPath(typeof params.next === 'string' ? params.next : undefined, '/agent')

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Buyer sign in</h1>
      <p className="mt-3 text-sm text-ink-soft">
        Sign in to sign mandates and let your agent shop inside the limits you set.
      </p>
      <BuyerLoginForm next={next} />
      <p className="mt-6 text-sm text-ink-soft">
        No account yet?{' '}
        <Link
          className="underline underline-offset-4"
          href={`/signup?next=${encodeURIComponent(next)}`}
        >
          Create one
        </Link>
        . Disputes are the merchant&rsquo;s:{' '}
        <Link className="underline underline-offset-4" href="/login">
          merchant sign in
        </Link>
        .
      </p>
    </main>
  )
}
