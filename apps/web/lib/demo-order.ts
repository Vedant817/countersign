import 'server-only'

/**
 * The demo money path — a **real PayPal sandbox order** created from a Gate `ALLOW`, without a vault.
 *
 * ## Why this exists, and why it is not the production order path
 *
 * The production path (`packages/orders.createOrderFromDecision`) sends
 * `payment_source.paypal.vault_id` — a vaulted buyer — which this deployment does not have yet
 * (HUMAN_TODO item 1a: buyer credentials + Vault on the sandbox app). Orders v2 has a second
 * documented shape: an order with **no payment source at all**, which PayPal accepts and leaves
 * in `CREATED` for the buyer to approve. The P0-6 acceptance run proved it against the sandbox
 * (order `6KW70371X5666381D`, re-read by `GET /v2/checkout/orders/{id}`).
 *
 * This module composes exactly that shape for the agent demo, and is honest about what it is:
 *
 *  - **What is real:** the PayPal order. It exists in PayPal's sandbox, it re-reads by id, and it
 *    carries the Gate's decision id in `custom_id` (`cs1:<gdc id>`), so a third party can pull the
 *    order from PayPal and find the approval stamped inside it.
 *  - **What is not:** there is no capture. An order with no payment source cannot be authorized
 *    server-side; capture would need the vaulted buyer. Every message this module produces names
 *    `CREATED`, never "captured" or "paid".
 *
 * ## Guard
 *
 * `agentDemoAllowed()` — `COUNTERSIGN_AGENT_DEMO=1` and non-production — the same gate the demo
 * session and the signing lab use. A deployed application must not create sample PayPal orders
 * from its chat page. `PAYPAL_ENV` is additionally checked to be the literal `sandbox`
 * (§10.2, EC-ENV-1), so a future `live` deployment cannot inherit this path by accident.
 *
 * ## Idempotency (§8.6)
 *
 * `createOrder` carries a `PayPal-Request-Id` derived from our own `attempt_id`
 * (`cs:<attemptId>`), so a retried submission collapses onto the same sandbox order instead of
 * creating a second one — the same property the acceptance script relies on, moved into the app.
 * `invoice_id` is `cs:<attemptId>` for the same reason: PayPal rejects a duplicate invoice per
 * merchant, which is exactly the duplicate-order guard we want for free.
 */
import { systemClock } from '@countersign/core'
import { PayPalClient } from '@countersign/paypal'

import { agentDemoAllowed } from './agent-session'

/** The fields the order panel and the re-read route show. Deliberately small and display-shaped. */
export interface DemoOrder {
  readonly id: string
  readonly status: string
  readonly intent: string
  readonly customId: string | null
  readonly amountValue: string | null
  readonly currency: string | null
  readonly createTime: string | null
}

import fs from 'node:fs'
import path from 'node:path'

/** Fallback: read PayPal creds from root .env.local if the server process didn't inherit them.
 *
 * Same file the dev launcher reads (`scripts/dev-local.mjs`), used only to fill a gap the demo money
 * path would otherwise fail on. Values are never logged, and the normal path is `process.env`. */
function paypalCreds(): { id: string; secret: string; base: string } {
  let id = process.env['PAYPAL_CLIENT_ID'] ?? ''
  let secret = process.env['PAYPAL_CLIENT_SECRET'] ?? ''
  let base = process.env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com'
  if (id === '' || secret === '') {
    try {
      const candidates = [
        path.resolve(process.cwd(), '.env.local'),
        path.resolve(process.cwd(), '../../.env.local'),
        path.resolve(process.cwd(), '../../../.env.local'),
      ]
      for (const p of candidates) {
        if (!fs.existsSync(p)) continue
        const text = fs.readFileSync(p, 'utf8')
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
          if (m === null) continue
          const key = m[1] ?? ''
          const value = (m[2] ?? '').trim()
          if (key === 'PAYPAL_CLIENT_ID' && id === '') id = value
          if (key === 'PAYPAL_CLIENT_SECRET' && secret === '') secret = value
          if (key === 'PAYPAL_API_BASE' && base === 'https://api-m.sandbox.paypal.com') {
            base = value === '' ? base : value
          }
        }
        if (id !== '' && secret !== '') break
      }
    } catch {
      // ignore
    }
  }
  return { id, secret, base }
}

/** True when this deployment is allowed and able to create demo orders at all. */
export function demoOrderPossible(): boolean {
  const creds = paypalCreds()
  return (
    agentDemoAllowed() &&
    process.env['PAYPAL_ENV'] === 'sandbox' &&
    creds.id !== '' &&
    creds.secret !== ''
  )
}

function client(): PayPalClient {
  const creds = paypalCreds()
  return new PayPalClient({
    baseUrl: creds.base,
    clientId: creds.id,
    clientSecret: creds.secret,
    clock: systemClock,
  })
}

/** `12345` → `"123.45"`; PayPal's `value` is a string decimal, never a float (§0 rule 9). */
function toPayPalValue(minor: bigint): string {
  return `${(minor / 100n).toString()}.${(minor % 100n).toString().padStart(2, '0')}`
}

/** PayPal order ids are 17 characters, `[A-Z0-9]` — observed on every sandbox order this repo has made. */
const PAYPAL_ORDER_ID_RE = /^[A-Z0-9]{17}$/

export function isPlausiblePayPalOrderId(id: string): boolean {
  return PAYPAL_ORDER_ID_RE.test(id)
}

export interface CreateDemoOrderInput {
  readonly decisionId: string
  readonly attemptId: string
  readonly amountMinor: bigint
  readonly currency: string
  readonly payeeName: string
}

export type DemoOrderResult =
  | { readonly ok: true; readonly value: DemoOrder }
  | { readonly ok: false; readonly reason: string }

/**
 * Create the sandbox order for one Gate `ALLOW`.
 *
 * Never throws. The demo's money path is an enhancement to the Gate answer, not a precondition of
 * it: if PayPal is unreachable or refuses, the submission still returns the ALLOW with
 * `order_pending: true` and the failure as a sentence — an order that could not be created is not
 * a reason to pretend the Gate did not allow.
 */
export async function createDemoOrder(input: CreateDemoOrderInput): Promise<DemoOrderResult> {
  if (!demoOrderPossible()) {
    return { ok: false, reason: 'the demo order path is off here (no sandbox credentials)' }
  }
  const created = await client().createOrder(
    {
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: 'default',
          description: `${input.payeeName} — Countersign agent order`,
          amount: {
            currency_code: input.currency,
            value: toPayPalValue(input.amountMinor),
          },
          custom_id: `cs1:${input.decisionId}`,
          invoice_id: `cs:${input.attemptId}`,
        },
      ],
    },
    // Deterministic per attempt (§8.6): a retry of the same submission re-uses the same id, so
    // PayPal collapses it onto the same order rather than charging twice.
    { requestId: `cs:order:${input.attemptId}` },
  )
  if (!created.ok) {
    return {
      ok: false,
      reason: `PayPal refused the order: ${created.error.code} — ${created.error.message.slice(0, 160)}`,
    }
  }
  return { ok: true, value: toDemoOrder(created.value) }
}

/** `GET /v2/checkout/orders/{id}` — the "Re-read from PayPal" affordance, against PayPal itself. */
export async function rereadDemoOrder(id: string): Promise<DemoOrderResult> {
  if (!demoOrderPossible()) {
    return { ok: false, reason: 'the demo order path is off here (no sandbox credentials)' }
  }
  const read = await client().getOrder(id)
  if (!read.ok) {
    return {
      ok: false,
      reason: `PayPal refused the read: ${read.error.code} — ${read.error.message.slice(0, 160)}`,
    }
  }
  return { ok: true, value: toDemoOrder(read.value) }
}

function toDemoOrder(raw: unknown): DemoOrder {
  const r = raw as {
    id?: string
    status?: string
    intent?: string
    create_time?: string
    custom_id?: string
    purchase_units?: { amount?: { value?: string; currency_code?: string } }[]
  }
  const unit = r.purchase_units?.[0]
  return {
    id: r.id ?? '',
    status: r.status ?? 'UNKNOWN',
    intent: r.intent ?? 'AUTHORIZE',
    customId:
      typeof r.custom_id === 'string'
        ? r.custom_id
        : ((unit as { custom_id?: string } | undefined)?.custom_id ?? null),
    amountValue: unit?.amount?.value ?? null,
    currency: unit?.amount?.currency_code ?? null,
    createTime: r.create_time ?? null,
  }
}
