/**
 * "Verify now" — spec §8.18, acceptance **AT-M18.2**, WP-18.
 *
 * A `GET` route handler, deliberately, and not a client-side `fetch`. Three reasons, each of which matters
 * more here than it would on an ordinary page:
 *
 * 1. **It works with JavaScript disabled.** A reader testing our claims may well disable it, and a verifier
 *    that needs JS to answer is a weaker verifier.
 * 2. **It cannot be confused with a client-side assertion.** Nothing runs in the reader's browser, so there is
 *    no "it says valid" that never asked anyone.
 * 3. **It gives the rate limiter somewhere to sit.** §8.3's 30/min/IP is enforced here as well as in
 *    `apps/vi`, because a limit behind the thing it protects can be bypassed by the thing in front of it.
 *
 * ## Why this renders HTML rather than redirecting
 *
 * Because the answer *is the page*. §8.18 asks for the per-check result and a reader who cannot see which
 * check failed cannot judge whether the failure matters, so the response body carries the whole table, in
 * accessible markup, with no redirect and no client JS.
 *
 * ## The honest parts, which are the hard parts
 *
 * - **`at_time_not_honoured` is a banner at the top**, not a footnote. A verifier that quietly drops a known
 *   limitation lends false confidence to exactly the reader it exists to reassure.
 * - **`constraints.skipped` gets its own section** (D19): "nobody checked this", not "nothing to worry about".
 * - **A vi-service outage is a 503 with a sentence**, not a failed chain. `chain_valid: false` would be a lie
 *   about the evidence, and the reader would draw the wrong conclusion from it.
 */
import { eq } from 'drizzle-orm'

import { csError, formatIstHuman, logger, systemClock, type PacketId } from '@countersign/core'
import {
  db,
  disputes,
  evidencePackets,
  jwksKeys,
  repo,
  type DisputeRow,
  type EvidencePacketRow,
  type JwksKeyRow,
} from '@countersign/db'
import { ViClient } from '@countersign/vi-client'
import {
  buildVerifierReport,
  clientIdFromHeaders,
  createPublicRateLimiter,
  defineVerifierDeps,
  loadVerifierPacket,
  rateLimitError,
  requestLiveVerify,
  type PublicRateLimiter,
  type VerifierDeps,
  type VerifierStore,
} from '@countersign/verifier'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Wiring — the same three reads and the same two env reads as the page and the download route.
//
// Duplicated rather than shared because this work package owns three files under `/v/[packetId]/` and nothing
// else (AGENTS.md rule 8), so a shared `lib/` module is not mine to create. Every route calls
// `loadVerifierPacket`, so the three copies cannot disagree about *which* packet a `packetId` names.
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw csError(
      'CS_INTERNAL',
      `${name} is not set; /v/{packetId}/verify-now cannot be served without it`,
      { env: name },
      { userMessage: 'This page is temporarily unavailable. Please tell the operator.' },
    )
  }
  return value.trim()
}

function store(): VerifierStore {
  return {
    packets: {
      findById: (id) =>
        repo(
          async () => {
            const rows = await db()
              .select()
              .from(evidencePackets)
              .where(eq(evidencePackets.id, id))
              .limit(1)
            return rows[0] as EvidencePacketRow | undefined
          },
          { table: 'evidence_packets', id },
        ),
    },
    disputes: {
      findById: (id) =>
        repo(
          async () => {
            const rows = await db().select().from(disputes).where(eq(disputes.id, id)).limit(1)
            return rows[0] as DisputeRow | undefined
          },
          { table: 'disputes', id },
        ),
    },
    jwks: {
      listAll: () =>
        repo(
          async () => {
            const rows = await db().select().from(jwksKeys)
            return rows as JwksKeyRow[]
          },
          { table: 'jwks_keys' },
        ),
    },
  }
}

function verifierDeps(): VerifierDeps {
  return defineVerifierDeps({
    clock: systemClock,
    store: store(),
    vi: {
      publicVerify: (req) =>
        new ViClient({
          baseUrl: requiredEnv('VI_SERVICE_URL'),
          token: requiredEnv('VI_SERVICE_TOKEN'),
          clock: systemClock,
          logger: logger.child({ module: 'verifier' }),
        }).publicVerify(req),
    },
    publicBaseUrl: requiredEnv('PUBLIC_BASE_URL'),
    logger: logger.child({ module: 'verifier' }),
  })
}

/**
 * The process-wide limiter.
 *
 * Module scope rather than per-request, because a per-request limiter is not a limiter: it would reset on every
 * invocation and cap nothing. On a single Node process this is the whole budget; behind multiple instances it
 * becomes per-instance, which is weaker but not wrong — the same trade-off `apps/vi`'s `ratelimit.py` makes
 * and documents.
 *
 * Sized from the injected clock rather than `Date.now()`, so the tests can drive it without sleeping.
 */
const limiter: PublicRateLimiter = createPublicRateLimiter({
  nowMs: () => Date.now(),
})

/**
 * The route's context.
 *
 * **Deliberately not called `RouteContext`.** Next 16 generates a *global* `RouteContext<…>` type from
 * `.next/types`, and a local declaration of the same name shadows it — which produced "Property 'packetId'
 * does not exist on type 'RouteContext'". Naming it `PacketRouteContext` keeps both available.
 */
interface PacketRouteContext {
  readonly params: Promise<{ packetId: string }>
}

export async function GET(request: Request, context: PacketRouteContext): Promise<Response> {
  // `context.params` is a Promise in Next 15+; `await context` compiles but reads `undefined`.
  const { packetId } = await context.params
  const deps = verifierDeps()

  // --- AT-M18.2, before anything expensive -------------------------------------------------------
  // Checked first so an over-budget caller never reaches the store or vi-service. The order matters: a
  // limiter applied after the work has already been done is a limiter applied too late.
  const clientId = clientIdFromHeaders(request.headers)
  const budget = limiter.check(clientId)
  if (!budget.allowed) {
    const error = rateLimitError(budget, `GET /v/${packetId}/verify-now`)
    return new Response(error.userMessage, {
      status: 429,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        // A `Retry-After` is what makes a 429 usable by a client rather than merely correct.
        'retry-after': String(budget.retryAfterSec),
        'x-ratelimit-limit': String(budget.limit),
        'x-ratelimit-remaining': String(budget.remaining),
        'x-ratelimit-reset': String(budget.resetAtSec),
      },
    })
  }

  const loaded = await loadVerifierPacket(deps, packetId as PacketId)
  if (!loaded.ok) {
    deps.logger?.error(`verify-now: loading ${packetId} failed: ${loaded.error.message}`)
    return text(
      500,
      `We could not read that packet just now (${loaded.error.code}). Please try again.`,
    )
  }
  if (loaded.value === undefined) {
    // EC-DSP-9: a 404 that says so. This URL is on a PDF a stranger will scan, so a mistyped or withdrawn
    // packet must produce a sentence and not a stack trace.
    return text(
      404,
      `No evidence packet with the id ${packetId}. It may have been withdrawn, or the link may ` +
        'be wrong. Nothing about the payment can be concluded from a 404.',
    )
  }

  const packet = loaded.value
  const result = await requestLiveVerify(deps, packet)

  if (!result.ok) {
    // **Not** a failed chain. A transport or service fault says nothing about the evidence, and rendering it
    // as `chain_valid: false` would be the worst possible lie on this page: the reader would conclude the
    // buyer's mandate was invalid when in fact we could not reach our own service.
    deps.logger?.warn(`verify-now: vi-service call for ${packetId} failed: ${result.error.message}`)
    const offline = await buildVerifierReport(packet, deps)
    return render({
      packetId,
      report: offline,
      reported: null,
      failure: result.error.userMessage,
      rateLimit: budget,
    })
  }

  const report = await buildVerifierReport(packet, deps, result.value)
  return render({ packetId, report, reported: result.value, failure: null, rateLimit: budget })
}

/**
 * The response.
 *
 * **`200` even when a check failed**, and that is the correct answer rather than a convenience. Spec §8.3 is
 * explicit that an invalid chain is a `200` with `chain_valid: false` and reasons, because a verifier that
 * 400s on bad evidence is a verifier you cannot point a judge's tool at. A 429 (over budget), a 404 (no such
 * packet) and a 503-shaped 500 (we could not ask) are the only non-`200` outcomes here, and each means
 * something different from "the evidence is bad".
 */
function render(input: {
  readonly packetId: string
  readonly report: Awaited<ReturnType<typeof buildVerifierReport>>
  readonly reported: unknown
  readonly failure: string | null
  readonly rateLimit: ReturnType<PublicRateLimiter['check']>
}): Response {
  const { report, failure } = input
  const failures = report.checks.filter((c) => c.status === 'FAIL')
  const caveats = report.checks.filter((c) => c.status === 'WARN' || c.status === 'SKIPPED')

  const banner = (() => {
    if (failure !== null) {
      return `<section class="notice notice-error"><h1>We could not ask our verifier</h1>
<p>${escapeHtml(failure)}</p>
<p>That is a problem at our end and says <em>nothing</em> about this payment. The checks computed on this
server without any service are below, and they are the ones you can also run yourself from the downloaded
bundle.</p></section>`
    }
    if (failures.length > 0) {
      return `<section class="notice notice-error"><h1>${failures.length} check(s) did not pass</h1>
<ul>${failures.map((c) => `<li><strong>[FAIL]</strong> ${escapeHtml(c.label)} — ${escapeHtml(c.detail)}</li>`).join('')}</ul>
<p>A failure is a statement about this document, not about the payment. Read the reason on each row.</p></section>`
    }
    if (caveats.length > 0) {
      return `<section class="notice notice-caution"><h1>No check failed, and ${caveats.length} could not be
conclusive</h1>
<ul>${caveats.map((c) => `<li><strong>[${c.status}]</strong> ${escapeHtml(c.label)} — ${escapeHtml(c.detail)}</li>`).join('')}</ul>
<p>That distinction is the point of this page: a check that could not run is never folded into a pass.</p></section>`
    }
    return `<section class="notice notice-ok"><h1>Every check passed</h1>
<p>vi-service reports the chain valid, every constraint it evaluated was satisfied, and the digest it hashed is
the document on this page.</p></section>`
  })()

  // D-009, rendered above the checks and not as a footnote. The pinned library has no clock override, so an
  // as-of verdict is impossible; vi reports the limitation and we refuse to hide it.
  const atTime =
    report.atTimeWarning === null
      ? ''
      : `<section class="notice notice-caution" id="at-time"><h1>Known limitation: this is not an as-of
verification</h1><p>${escapeHtml(report.atTimeWarning)}</p>
<p>Spec EC-TIME-3 / docs/DECISIONS.md D-009. We would rather show you a limitation than let a clean-looking
verdict imply more than it establishes.</p></section>`

  const skipped =
    report.skippedByVerifier.length === 0
      ? ''
      : `<section><h2>Not evaluated by anyone</h2>
<p>These constraints were disclosed and the library evaluates <em>none</em> of them — its own source calls them
network-enforced. Countersign's Gate enforces them (spec D19), so a satisfied verdict from the library says
nothing either way. Read this as &ldquo;nobody has told you&rdquo;, not &ldquo;nothing to worry about&rdquo;.</p>
<ul>${report.skippedByVerifier.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></section>`

  const rows = report.checks
    .map(
      (c) => `<tr>
<th scope="row">${c.status}</th>
<td><strong>${escapeHtml(c.label)}</strong><br><code>${escapeHtml(c.id)}</code> ·
${c.source === 'local' ? 'computed here' : 'asked of vi-service'}</td>
<td>${escapeHtml(c.detail)}</td>
<td><code>${escapeHtml(c.authority ?? '—')}</code></td>
</tr>`,
    )
    .join('')

  const html = `<!doctype html>
<html lang="en-IN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, follow">
<title>Re-verification · ${escapeHtml(input.packetId)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem 1rem; line-height: 1.55;
         max-width: 60rem; margin-inline: auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
  code { font-family: ui-monospace, monospace; font-size: .85em; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; margin-top: .75rem; }
  th, td { border-bottom: 1px solid #8884; padding: .55rem .5rem; text-align: left; vertical-align: top; }
  thead th { font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; }
  tbody th { font-family: ui-monospace, monospace; white-space: nowrap; }
  .notice { border: 1px solid #8886; border-left-width: 5px; border-radius: .5rem; padding: 1rem 1.1rem;
            margin: 1.25rem 0; }
  .notice-error { border-left-color: #c0392b; }
  .notice-caution { border-left-color: #b8860b; }
  .notice-ok { border-left-color: #1e7a4b; }
  .meta { font-size: .8rem; opacity: .75; }
  a { color: inherit; }
</style>
</head><body>
<p><a href="/v/${escapeHtml(input.packetId)}">&larr; Back to the packet</a></p>
<h1>Live re-verification of ${escapeHtml(input.packetId)}</h1>
<p class="meta">Requested at ${escapeHtml(formatIstHuman(Date.now() / 1000))} (IST). Every row below is text, not
colour, so it is readable by a screen reader and in monochrome.</p>
${banner}
${atTime}
${skipped}
<h2>Per-check results</h2>
<table>
<caption class="meta">Every check, its verdict, and the reason for it</caption>
<thead><tr><th scope="col">Verdict</th><th scope="col">Check</th><th scope="col">What it found</th>
<th scope="col">Requirement</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p class="meta">Rate limit: ${input.rateLimit.limit} requests per 60s per IP ·
${input.rateLimit.remaining} remaining before this response · spec §8.3, AT-M18.2.</p>
<p class="meta">Nothing on this page depends on a model. The digests, the binding and the Gate signature are
computed here; the chain verdict and the constraint evaluation are vi-service's, named as such on each row.</p>
</body></html>`

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-ratelimit-limit': String(input.rateLimit.limit),
      'x-ratelimit-remaining': String(input.rateLimit.remaining),
      'x-ratelimit-reset': String(input.rateLimit.resetAtSec),
    },
  })
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Escape for HTML text **and** attribute context.
 *
 * A real concern here and not a formality: `detail` strings embed attacker-influenced content (a tampered
 * bundle's values, PayPal's own error text), and this response is served from our origin. Without escaping, a
 * bundle with a `<script>` in a read-back would execute on our domain — turning "download this bundle and check
 * it" into an XSS against the very reader we are trying to reassure. `&`, `<`, `>`, `"` and `'` cover both
 * contexts; a reader can verify by feeding `<script>` through any of the cases.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
