/**
 * `/status` — spec **§8.19** (M19, observability), screen **S-22**, `render.yaml`'s `healthCheckPath`.
 *
 * ## Why this route exists as a **route handler** and not a page
 *
 * Because it is a health check. `render.yaml` sets `healthCheckPath: /status` on the web service, so this
 * URL is fetched by Render every few seconds and a non-2xx takes the instance out of rotation. It must
 * therefore:
 *
 * - answer **200** when it is up and **503** when a *required* dependency is down, and
 * - be cheap, be cache-free, and never throw.
 *
 * A server component would also answer, but it would be a *document*, and a health check that renders HTML
 * spends render time on every poll. So this is `GET` → JSON by default, with an HTML rendering when the
 * caller asks for one (`Accept: text/html`), because a judge who types `/status` in a browser should get a
 * page rather than a wall of JSON.
 *
 * ## "Required" means *for serving requests*, and the mapping is stated
 *
 * | Dependency | Required? | Why |
 * |---|---|---|
 * | **Postgres** | **yes** | Nothing works without it. A `REQUIRED` answer here is a 503. |
 * | **vi-service** | **yes** | No order can be verified without it: the Gate's check 4 is `vi /v1/verify`, and a Gate that cannot verify a chain must BLOCK. A running instance that cannot gate is worse than an instance that says so. |
 * | **PayPal OAuth** | **yes** | Every side effect is a `POST /v2/...` behind a bearer token. Without it no order, capture, refund or dispute action can go out. |
 * | OpenAI | **no** | The deterministic paths are the product (§8.0 rule 4: "no LLM output is authoritative"). A missing key degrades the intent compiler and the notes drafter to nothing; it does not stop a purchase. |
 * | MCP | **no** | Only the agent's shopping tools. §11 check C3 may still be running. |
 * | webhook lag | informational | A lost webhook is repaired by the reconciler within five minutes (§8.12); it is a fact to report, not a reason to pull the instance out of rotation. |
 *
 * ## Probe, do not assume
 *
 * Every dependency above is **actually called**, with a short timeout, and the answer is the real one plus
 * the measured latency. A status page that reports "OpenAI: OK" because a key is set is worse than no status
 * page, because it moves a reader's trust rather than informing it — and it would have reported OK for a
 * key that had been revoked. `test/status.test.ts` proves the difference by pointing this at a dependency
 * that is configured and dead.
 *
 * ## Never leak a secret
 *
 * Report **configured / not configured**, never the value. `SECRET_ENV_KEYS` is redacted in errors, but a
 * status body is not an error and would be pasted into a chat. The body is built from `configured` flags and
 * probe results only, and `test/status.test.ts` asserts that no configured secret value appears in it.
 *
 * ## Time in IST, with the raw UTC too (AGENTS.md rule 10)
 *
 * Both, always, in every timestamp this route prints. A reader in Bengaluru needs the IST string; a log
 * pipeline needs the UTC one; and a page that prints only one of them is a page somebody has to convert by
 * hand before they can trust it.
 */
import { formatIst, formatIstHuman, VI_LIB_COMMIT, type CsError } from '@countersign/core'
import { findLatestWebhookEvent, listUnprocessedEvents } from '@countersign/db'
import { webhookHealth } from '@countersign/privacy'

import { readLlmConfig } from '@/lib/llm'

import { probeAll, type StatusReport } from './probe'

/** Never cache a health check, in any layer. */
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Per-probe budget.
 *
 * **2 seconds**, chosen because Render's own health check interval is longer than that and a status page
 * that takes ten seconds to answer has stopped being a health check. Each probe is *also* raced against
 * `Promise.race` with this budget inside {@link probeAll}, so a dependency that accepts a socket and then
 * hangs cannot hold the response open.
 */
const PROBE_TIMEOUT_MS = 2_000

/**
 * `GET /status`
 *
 * @returns 200 when every **required** dependency answered, 503 when one did not, and **always** a body —
 *   a health check that 500s with no explanation is the failure mode this route exists to remove.
 */
export async function GET(request: Request): Promise<Response> {
  const report = await buildReport()

  const html = prefersHtml(request)
  const body = html ? renderHtml(report) : JSON.stringify(report, null, 2)

  return new Response(body, {
    // 200 or 503, never anything else. `report.ok` is the only input.
    status: report.ok ? 200 : 503,
    headers: {
      'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      // So a Render log line and a `curl` can both name the failing dependency without parsing the body.
      'x-countersign-status': report.ok ? 'ok' : 'degraded',
    },
  })
}

/* ------------------------------------------------------------------------------------------ */
/* The report                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Read the environment **without** `packages/core`'s `env()`.
 *
 * `env()` throws when anything is missing (spec §6), which is the right behaviour for a process boot and
 * **the wrong behaviour for a health check**: a deployment that is missing `OPENAI_API_KEY` should still be
 * able to *say* so. So this route reads `process.env` directly and reports presence per key. It is the one
 * place in the app that does, and it is here for exactly that reason.
 */
function configured(name: string): boolean {
  const value = process.env[name]
  return value !== undefined && value.trim() !== ''
}

/** Every variable this route cares about, so "which one is missing" is answerable in one place. */
const KEYS = {
  database: 'DATABASE_URL',
  viUrl: 'VI_SERVICE_URL',
  viToken: 'VI_SERVICE_TOKEN',
  paypalClientId: 'PAYPAL_CLIENT_ID',
  paypalClientSecret: 'PAYPAL_CLIENT_SECRET',
  paypalBase: 'PAYPAL_API_BASE',
  paypalMcp: 'PAYPAL_MCP_URL',
  openai: 'OPENAI_API_KEY',
} as const

async function buildReport(): Promise<StatusReport> {
  const nowMs = Date.now()
  const nowSec = Math.floor(nowMs / 1000)

  /*
   * Resolved through the app's own adapter rather than re-derived here.
   *
   * `readLlmConfig` is what `apps/web/lib/llm.ts` calls to build the client the intent compiler uses. A
   * status page that answers "is the model reachable" with its own credential logic will eventually
   * disagree with the feature it describes — it already did: this route sent `Authorization: Bearer`
   * to a Modal `.direct` endpoint, which wants `Modal-Key`/`Modal-Secret`, and reported the provider
   * `down` (401) while `/api/intent/compile` was compiling against it successfully.
   */
  const llm = readLlmConfig(process.env)

  const probes = await probeAll({
    databaseConfigured: configured(KEYS.database),
    viConfigured: configured(KEYS.viUrl) && configured(KEYS.viToken),
    paypalConfigured:
      configured(KEYS.paypalClientId) &&
      configured(KEYS.paypalClientSecret) &&
      configured(KEYS.paypalBase),
    mcpConfigured: configured(KEYS.paypalMcp),
    openaiConfigured: llm.ok,
    viBaseUrl: process.env[KEYS.viUrl] ?? '',
    viToken: process.env[KEYS.viToken] ?? '',
    paypalClientId: process.env[KEYS.paypalClientId] ?? '',
    paypalClientSecret: process.env[KEYS.paypalClientSecret] ?? '',
    paypalBaseUrl: process.env[KEYS.paypalBase] ?? '',
    mcpUrl: process.env[KEYS.paypalMcp] ?? '',
    /*
     * The headers the app really sends, from the app's own resolution.
     *
     * Not `process.env[KEYS.openai]` pasted into a Bearer. A Modal `.direct` endpoint authenticates with
     * `Modal-Key`/`Modal-Secret`, so the old probe sent the wrong credential and reported a working
     * provider as `down` — the status page contradicting the feature it was describing. `readLlmConfig`
     * is the same function `apps/web/lib/llm.ts` uses to build the client, so there is one answer to
     * "how do we authenticate" and this page reports it rather than re-deriving it.
     */
    openaiHeaders: llm.ok ? llm.value.headers : {},
    // A deployment on Groq, OpenRouter, Google AI Studio, Together or a local Ollama must be probed
    // where it actually lives, or `/status` reports a working provider as `down`.
    openaiBaseUrl: llm.ok
      ? llm.value.baseUrl
      : (process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'),
    fetchImpl: fetch,
    timeoutMs: PROBE_TIMEOUT_MS,
  })

  const unprocessed = await countUnprocessed()

  const ok = probes.every((p) => !p.required || p.status === 'up')

  return {
    ok,
    // Both clocks, always (AGENTS.md rule 10). A page that prints only one of them is a page somebody has to
    // convert by hand before they can trust it.
    checkedAt: {
      epochSec: nowSec,
      utc: new Date(nowMs).toISOString(),
      ist: formatIst(nowSec),
      istHuman: formatIstHuman(nowSec),
    },
    environment: {
      appEnv: process.env['APP_ENV'] ?? null,
      nodeEnv: process.env['NODE_ENV'] ?? null,
      // EC-ENV-1 restated on a page a judge can read: this project cannot take live money, and boot refuses
      // `live`. Saying it here means the claim is checkable without reading `packages/core`.
      paypalEnv: process.env['PAYPAL_ENV'] ?? null,
      sandboxOnly: process.env['PAYPAL_ENV'] === 'sandbox',
      // EC-ENV-1 refuses a *live* value at boot. Absent is not live; it is unconfigured, and the
      // dependency row above already says so.
      paypalEnvRejected:
        process.env['PAYPAL_ENV'] !== undefined && process.env['PAYPAL_ENV'] !== 'sandbox',
    },
    dependencies: probes,
    webhook: unprocessed,
    viLibCommit: VI_LIB_COMMIT,
    /** Names only. No value from this object ever reaches the response. */
    configured: {
      DATABASE_URL: configured(KEYS.database),
      VI_SERVICE_URL: configured(KEYS.viUrl),
      VI_SERVICE_TOKEN: configured(KEYS.viToken),
      PAYPAL_CLIENT_ID: configured(KEYS.paypalClientId),
      PAYPAL_CLIENT_SECRET: configured(KEYS.paypalClientSecret),
      PAYPAL_API_BASE: configured(KEYS.paypalBase),
      PAYPAL_MCP_URL: configured(KEYS.paypalMcp),
      OPENAI_API_KEY: configured(KEYS.openai),
    },
  }
}

/**
 * §8.19's "last webhook time" and this route's reconciler lag.
 *
 * **Informational, and it cannot make the report `ok: false`.** §8.12's reconciler repairs a lost webhook
 * within five minutes by construction, so lag is a fact about a self-healing system rather than an outage.
 * A health check that fails on lag would pull a healthy instance out of rotation for a condition it fixes
 * on its own — which is how a health check becomes an outage.
 */
async function countUnprocessed(): Promise<StatusReport['webhook']> {
  const latest = await findLatestWebhookEvent()
  const pending = await listUnprocessedEvents(100)

  const nowMs = Date.now()
  const nowSec = Math.floor(nowMs / 1000)
  const latestRow = latest.ok ? latest.value : undefined
  const at = latestRow?.received_at instanceof Date ? latestRow.received_at : null
  const pendingRows = pending.ok ? pending.value : undefined
  const oldestPending =
    pendingRows === undefined || pendingRows.length === 0
      ? null
      : Math.min(...pendingRows.map((r) => r.received_at.getTime()))

  /**
   * The verdict comes from `@countersign/privacy`, not from this file.
   *
   * §14 sets the reconciler target at five minutes and `webhookHealth` owns that threshold, so the
   * page cannot drift from the number the docs quote. It also keeps two states apart that a raw
   * backlog count conflates: `idle` (nothing has ever arrived — a wiring fault) and `ok` (arrived and
   * drained).
   */
  const health = webhookHealth({
    lastReceivedAtSec: at === null ? null : Math.floor(at.getTime() / 1000),
    lastProcessedAtSec: null,
    pendingCount: pendingRows?.length ?? 0,
    oldestPendingReceivedAtSec: oldestPending === null ? null : Math.floor(oldestPending / 1000),
    nowSec,
  })

  return {
    lastReceivedAt:
      at === null ? null : { utc: at.toISOString(), ist: formatIst(at.getTime() / 1000) },
    /** Seconds since the last delivery, or `null` when nothing has ever arrived. */
    secondsSinceLast: at === null ? null : Math.max(0, Math.round((nowMs - at.getTime()) / 1000)),
    /**
     * How long the **oldest** stored-but-unprocessed event has been waiting. That is the number an operator
     * wants, and it is honest about its own limit: it measures the webhook channel, not PayPal's state.
     * PayPal-side divergence is the reconciler's job (§8.12) and is not visible here.
     */
    backlogOldestSeconds: health.reconcilerLagSec ?? 0,
    unprocessed: pendingRows?.length ?? null,
    health,
    note: 'Informational. §8.12 repairs a lost webhook within five minutes; this never fails the check.',
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Rendering                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * Does the caller want HTML?
 *
 * Only when `Accept` names it **and** does not also name JSON, so a browser, `curl -H 'accept: text/html'`
 * and every API client get what they asked for. Default is JSON: this is a health check first.
 */
function prefersHtml(request: Request): boolean {
  const accept = request.headers.get('accept') ?? ''
  if (!accept.includes('text/html')) return false
  return !accept.includes('application/json')
}

/** Escape for HTML text and attribute context. §8.15's rule about user-influenced strings applies here too. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The HTML rendering.
 *
 * **Colour is never the only signal.** Each row carries the status as text (`up`, `down`, `not configured`)
 * and a symbol, so the page is readable in monochrome and by a screen reader — the same rule §18's
 * "judges read our output" argument makes everywhere else.
 */
function renderHtml(report: StatusReport): string {
  const rows = report.dependencies
    .map((d) => {
      const symbol = d.status === 'up' ? '✓' : d.status === 'not_configured' ? '–' : '✗'
      const latency = d.latencyMs === null ? '—' : `${d.latencyMs} ms`
      const required = d.required ? 'required' : 'optional'
      const detail = escapeHtml(d.detail)
      return `<tr>
<th scope="row">${symbol} ${escapeHtml(d.name)}</th>
<td><strong>${escapeHtml(d.status)}</strong> <span class="req">${required}</span></td>
<td class="num">${latency}</td>
<td>${detail}</td>
</tr>`
    })
    .join('')

  const headline = report.ok
    ? '<h1>All required dependencies are up.</h1><p>This instance can gate a purchase and verify a chain. It <strong>cannot</strong> move money: order creation and capture are not wired, and the README forbids this page from implying otherwise.</p>'
    : '<h1>One or more required dependencies are down.</h1><p>Render will take this instance out of rotation. The failing rows are named below.</p>'

  const webhook = report.webhook
  const webhookRow =
    webhook.lastReceivedAt === null
      ? 'No webhook has ever been delivered to this instance.'
      : `Last delivery ${escapeHtml(webhook.lastReceivedAt.utc)} · ${escapeHtml(webhook.lastReceivedAt.ist)} · ${webhook.secondsSinceLast}s ago.`

  return `<!doctype html>
<html lang="en-IN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, follow">
<title>Countersign status</title>
<style>
  * { box-sizing: border-box; }
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem 1rem; line-height: 1.55;
         max-width: 62rem; margin-inline: auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  code { font-family: ui-monospace, monospace; font-size: .85em; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; margin-top: .75rem; }
  th, td { border-bottom: 1px solid #8884; padding: .55rem .5rem; text-align: left; vertical-align: top; }
  thead th { font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; }
  tbody th { font-weight: 600; white-space: nowrap; }
  .num { font-variant-numeric: tabular-nums; }
  .req { font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; opacity: .7; }
  .meta { font-size: .8rem; opacity: .8; }
  nav { display: flex; flex-wrap: wrap; gap: .25rem 1rem; margin-bottom: 1.5rem; }
  nav a { display: inline-flex; align-items: center; min-height: 44px; }
  @media (max-width: 640px) {
    table, caption, tbody, tr, th, td { display: block; width: 100%; }
    thead { display: none; }
    tr { margin-block: 1rem; border: 1px solid #8884; padding: .5rem; border-radius: .5rem; }
    tbody th { white-space: normal; }
    td, th { border: 0; overflow-wrap: anywhere; }
    .num { text-align: left; }
    code { overflow-wrap: anywhere; }
  }
</style>
</head><body>
<nav aria-label="Main navigation"><a href="/">Countersign</a><a href="/shop">Storefront</a><a href="/lab/device-sign">Signing lab</a><a href="/judge">Demo guide</a><a href="/regions">Coverage</a></nav>
${headline}
<table>
<caption class="meta">Every row is an actual call to that dependency, made moments ago.</caption>
<thead><tr><th scope="col">Dependency</th><th scope="col">State</th><th scope="col">Latency</th><th scope="col">What was observed</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<h2>Webhooks</h2>
<p><code>${escapeHtml(webhook.health.state)}</code> ${escapeHtml(webhook.health.detail)}${webhook.health.sloBreached ? ' <strong>Past the §14 target of 300 s.</strong>' : ''}</p>
<p>${webhookRow} ${webhook.unprocessed ?? 0} event(s) stored and not yet processed; the oldest has been waiting ${webhook.backlogOldestSeconds}s. ${escapeHtml(webhook.note)}</p>
<h2>Build</h2>
<p class="meta">Verifiable Intent commit <code>${escapeHtml(report.viLibCommit)}</code> · APP_ENV <code>${escapeHtml(String(report.environment.appEnv))}</code> · PayPal environment <code>${escapeHtml(String(report.environment.paypalEnv))}</code>${report.environment.paypalEnvRejected ? ' — <strong>not sandbox; boot should have refused (§6, EC-ENV-1)</strong>' : report.environment.sandboxOnly ? '' : ' — PayPal is not configured on this deployment'}</p>
<p class="meta">Checked at ${escapeHtml(report.checkedAt.utc)} · ${escapeHtml(report.checkedAt.istHuman)}</p>
<p class="meta">Secrets are reported as configured or not configured, never as values. Nothing on this page is
generated by a model.</p>
</body></html>`
}

/** Named so a reader of the route file knows why the error type is imported. */
export type { CsError }
