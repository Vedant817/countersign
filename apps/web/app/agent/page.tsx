/**
 * S-10 — `/agent`. Spec §9, WP-17b (minimal).
 *
 * A server component so the page can carry metadata and read the demo flag, with the interactive part in
 * `agent-chat.tsx`. The split exists so this file can say *when the demo is available* before any client
 * JavaScript loads: a judge on a deployment without `COUNTERSIGN_AGENT_DEMO=1` gets an explanation, not a
 * button that 403s.
 */
import type { Metadata } from 'next'
import Link from 'next/link'

import { agentDemoAllowed } from '@/lib/agent-session'

import { AgentChat } from './agent-chat'

export const metadata: Metadata = {
  title: 'Agent chat',
  description:
    'Ask the shopping agent to buy something and watch the merchant-side Gate hold your signed limits.',
}

export default function AgentPage() {
  if (!agentDemoAllowed()) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <p className="font-mono text-xs uppercase tracking-widest text-signed">S-10 · Agent chat</p>
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

  return <AgentChat />
}
