/**
 * The disputes-half live probe — audit order-of-work item 8, provide-evidence half.
 *
 * What this can honestly prove with the credentials we have (sandbox client id/secret, no capture, no
 * dispute): every disputes endpoint the Defender's filing path calls, against the **real sandbox API**,
 * through our **real `PayPalClient`** — so the auth, the multipart encoding, the endpoint paths and the
 * client's error mapping all run for real. PayPal's answers are recorded verbatim; nothing is simulated.
 *
 * What it cannot prove, and does not pretend to: a *successful* provide-evidence upload. PayPal returns
 * 404 RESOURCE_NOT_FOUND for a dispute id that does not exist — which is itself the proof that the
 * request was authenticated, routed and well-formed. A real 200 needs a captured payment (HUMAN_TODO 1a)
 * and the Disputes product / dispute simulator (HUMAN_TODO 2); the client calls are already tested
 * against captured-fixture-shaped responses in packages/paypal/test/client.disputes.test.ts.
 *
 * Run: pnpm exec tsx scripts/paypal-dispute-probe.mts
 * Credentials come from .env.local (names only are printed; values never are).
 */
import { readFileSync } from 'node:fs'

import { PayPalClient } from '../packages/paypal/src/index.ts'
import { systemClock } from '../packages/core/src/index.ts'

function envLocal(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    env[t.slice(0, eq).trim()] = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return { ...process.env, ...env } as Record<string, string>
}

const env = envLocal()
const clientId = env['PAYPAL_CLIENT_ID'] ?? ''
const clientSecret = env['PAYPAL_CLIENT_SECRET'] ?? ''
const baseUrl = env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com'

if (clientId === '' || clientSecret === '') {
  console.error('probe refused: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are empty in .env.local')
  process.exit(2)
}

const client = new PayPalClient({ baseUrl, clientId, clientSecret, clock: systemClock })

/** A dispute id shape PayPal accepts in the path; no such dispute exists in the sandbox. */
const ABSENT_DISPUTE = '5W000000000000000001'

function show(label: string, r: { ok: boolean; error?: { code: string; message: string } }): void {
  if (r.ok) {
    console.log(`${label}: ok`)
    return
  }
  const e = r.error
  if (e === undefined) {
    console.log(`${label}: err (no error body)`)
    return
  }
  console.log(`${label}: err ${e.code} — ${e.message}`)
}

console.log(`probe against ${baseUrl}`)
console.log(`client id present: ${clientId !== ''}, secret present: ${clientSecret !== ''}`)

// 1. The router's first call (§8.12 step 2 / ingestAndDefend): getDispute on an absent id.
//    Expected: PayPal 404 RESOURCE_NOT_FOUND → our PP_NOT_FOUND. Proves auth + routing + mapping.
show('getDispute', await client.getDispute(ABSENT_DISPUTE))

// 2. The sweep's call: listDisputes with no filter. Expected: 200, items [].
const listed = await client.listDisputes({})
if (!listed.ok) {
  show('listDisputes', listed)
} else {
  const items = (listed.value as { items?: unknown[] }).items ?? []
  console.log(`listDisputes: ok, items=${items.length}`)
}

// 3. The filer's upload call (multipart): provideEvidence on the absent id. Expected: PayPal 404 →
//    PP_NOT_FOUND — the multipart form was built and sent, so the endpoint, auth and encoding are real.
show(
  'provideEvidence',
  await client.provideEvidence(
    ABSENT_DISPUTE,
    {
      evidences: [
        {
          evidence_type: 'PROOF_OF_FULFILLMENT',
          evidence_info: {
            tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z-PROBE-0000' }],
          },
          notes: 'countersign live probe: this dispute does not exist',
        },
      ],
    },
    [],
    { requestId: `probe-dispute-${Date.now()}` },
  ),
)
