/**
 * S-10 — `/agent`. Spec §9, WP-17b (minimal), D-060 for the account.
 *
 * A server component so the page can carry metadata, read the demo flag and decide what to say before any
 * client JavaScript loads. The three answers, in order:
 *
 *  1. **Not a buyer.** Redirect to `/buyer-login` (anonymous) or a 403 (a merchant or judge session). A
 *     mandate is signed against a buyer's row, so the page needs to know whose — and it must not guess.
 *  2. **The demo is off.** An explanation, not a button that 403s: the page provisions a real mandate
 *     through vi-service and signs it with a P-256 key, so it needs `COUNTERSIGN_AGENT_DEMO=1`, a database
 *     and a running vi-service.
 *  3. **Both.** The chat, with the buyer's own display name in the header so the session is visible rather
 *     than assumed.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { forbidden, redirect } from 'next/navigation'

import { agentDemoAllowed } from '@/lib/agent-session'
import { BUYER_PERSONA, currentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/next-path'

import { AgentChat } from './agent-chat'
import { SignOutButton } from '../disputes/logout-button'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Agent chat',
  description:
    'Ask the shopping agent to buy something and watch the merchant-side Gate hold your signed limits.',
}

export default async function AgentPage() {
  // Whose mandate this would be. Read before the demo flag, because "sign in" is the more useful answer to
  // an anonymous visitor than "this deployment has no vi-service" — and because the demo flag is a property
  // of the deployment, not of the person.
  const user = await currentUser()
  if (!user.ok) {
    // A misconfigured signing secret is a deployment fault, not a login problem; sending the buyer to a form
    // they cannot succeed at would be the wrong answer.
    throw new Error(`the session could not be read: ${user.error.code} ${user.error.message}`)
  }
  if (user.value === undefined)
    redirect(`/buyer-login?next=${encodeURIComponent(safeNextPath('/agent', '/agent'))}`)
  if (user.value.persona !== BUYER_PERSONA) forbidden()

  const buyer = user.value

  if (!agentDemoAllowed()) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-xs uppercase tracking-widest text-ink-faint">
            {buyer.displayName} · {buyer.email}
          </p>
          <SignOutButton to="/buyer-login" />
        </div>
        <p className="mt-6 font-mono text-xs uppercase tracking-widest text-signed">
          S-10 · Agent chat
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          The live agent demo is off here
        </h1>
        <p className="mt-4 text-ink-soft">
          This page provisions a real mandate, asks vi-service to sign it and lets an agent shop
          through the merchant MCP, so it needs a database and a running vi-service. It is enabled
          by
          <code className="mx-1 rounded bg-paper-raised px-1 py-0.5 font-mono text-sm">
            COUNTERSIGN_AGENT_DEMO=1
          </code>
          outside production.
        </p>
        <p className="mt-4 text-ink-soft">
          Your account works either way: your mandates, limits and orders belong to you, and this
          deployment simply has no signing service to create one against.
        </p>
        <p className="mt-4 text-ink-soft">
          The agent&rsquo;s own behaviour is not environment-dependent: the injection corpus and the
          refusal rate it produces are reproducible from a terminal —{' '}
          <Link className="underline underline-offset-4" href="/judge">
            see the demo guide
          </Link>
          .
        </p>
      </div>
    )
  }

  return <AgentChat displayName={buyer.displayName} email={buyer.email} />
}
