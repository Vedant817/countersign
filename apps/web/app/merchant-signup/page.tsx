/**
 * `/merchant-signup` — create a merchant account.
 *
 * ## Why a page and not a modal
 *
 * The session cookie is `httpOnly` and the guard is server-side, so the sign-up has to be a
 * navigation. `?next=` carries the path the merchant was trying to reach (`/disputes` by default)
 * and `safeNextPath` refuses anything that is not on this deployment.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { currentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/next-path'

import { MerchantSignupForm } from './merchant-signup-form'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Create a merchant account',
  description: 'Create a merchant account to manage disputes and orders.',
}

interface MerchantSignupPageProps {
  readonly searchParams: Promise<{ next?: string | string[] }>
}

export default async function MerchantSignupPage({ searchParams }: MerchantSignupPageProps) {
  const user = await currentUser()
  if (user.ok && user.value !== undefined) {
    redirect(user.value.persona === 'MERCHANT' ? '/disputes' : '/agent')
  }

  const params = await searchParams
  const next = safeNextPath(typeof params.next === 'string' ? params.next : undefined, '/disputes')

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Create a merchant account</h1>
      <p className="mt-3 text-sm text-ink-soft">
        Manage disputes, decide case outcomes, and track orders across your business.
      </p>
      <MerchantSignupForm next={next} />
      <p className="mt-6 text-sm text-ink-soft">
        <Link className="underline underline-offset-4" href="/login">
          Already a merchant? Sign in
        </Link>
      </p>
    </main>
  )
}
