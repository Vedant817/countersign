/**
 * `/signup` — create a buyer account, D-060.
 *
 * ## Why a page and not a modal
 *
 * The same reason `/login` is a page: the session cookie is `httpOnly` and the guard is server-side, so the
 * sign-up has to be a navigation. `?next=` carries the path the buyer was trying to reach (`/agent` by
 * default) and `safeNextPath` refuses anything that is not on this deployment.
 *
 * ## What this page deliberately does not say
 *
 * It does not promise a verification email, because no mail is sent (HUMAN_TODO). It does not offer to
 * "continue with PayPal" — that is a credential this deployment's sandbox app is not configured for, and a
 * button that leads to a 501 is worse than no button.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { currentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/next-path'

import { SignupForm } from './signup-form'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Create a buyer account',
  description: 'Create a buyer account to sign mandates and shop with an agent.',
}

interface SignupPageProps {
  readonly searchParams: Promise<{ next?: string | string[] }>
}

export default async function SignupPage({ searchParams }: SignupPageProps) {
  // Already signed in: a second account for the same person is a second set of mandates, which is a
  // support call. Send them to the surface they can already use.
  const user = await currentUser()
  if (user.ok && user.value !== undefined) {
    redirect(user.value.persona === 'MERCHANT' ? '/disputes' : '/agent')
  }

  const params = await searchParams
  const next = safeNextPath(typeof params.next === 'string' ? params.next : undefined, '/agent')

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Create a buyer account</h1>
      <p className="mt-3 text-sm text-ink-soft">
        Your account is what a mandate is signed against: the agent can only spend what you sign
        for, and only you can sign.
      </p>
      <SignupForm next={next} />
      <p className="mt-6 text-sm text-ink-soft">
        Already have an account?{' '}
        <Link
          className="underline underline-offset-4"
          href={`/buyer-login?next=${encodeURIComponent(next)}`}
        >
          Sign in
        </Link>
        .
      </p>
    </main>
  )
}
