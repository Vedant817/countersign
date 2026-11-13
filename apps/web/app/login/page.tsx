/**
 * `/login` — the merchant sign-in page, D-059.
 *
 * ## Why a page and not a modal
 *
 * The session cookie is `httpOnly` and the guard is server-side, so the sign-in has to be a navigation
 * rather than an overlay: a merchant who arrives at `/disputes/{id}` from a bookmark must be able to sign
 * in and land back on the case they asked for. `?next=` carries that path, and `safeNextPath` refuses
 * anything that is not a path on this deployment.
 *
 * ## What the page does not show
 *
 * It does not list accounts, does not say whether an email exists, and does not offer a "demo login"
 * button. A deployment with no `MERCHANT_PASSWORD` has no password login at all (the seed leaves
 * `password_hash` null), and the honest response to that is the same generic refusal the route gives —
 * not a page that names the seeded merchant and invites a guess.
 */
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { currentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/next-path'

import { LoginForm } from './login-form'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to the merchant dispute console.',
}

interface LoginPageProps {
  readonly searchParams: Promise<{ next?: string | string[] }>
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await currentUser()
  // Already signed in as the merchant: the queue is the page they were trying to reach.
  if (user.ok && user.value?.persona === 'MERCHANT') redirect('/disputes')

  const params = await searchParams
  const next = safeNextPath(typeof params.next === 'string' ? params.next : undefined)

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Merchant sign in</h1>
      <p className="mt-3 text-sm text-ink-soft">
        The dispute queue is the merchant&rsquo;s. Sign in with the Northwind account to read and
        decide cases.
      </p>
      <LoginForm next={next} />
    </main>
  )
}
