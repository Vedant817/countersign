/**
 * Brutal-user sweep: fetch every page and look for a stack trace, an empty body, or a 5xx.
 *
 * Written because a `500` with a **zero-byte body** hid inside `POST /api/intent/compile` for several
 * sessions — the surface looked healthy while every successful compile returned nothing at all. A page
 * that renders a stack trace is obvious; a page that renders a *plausible* error banner is not, and
 * neither is a route that answers 500 with nothing to read.
 *
 * ```sh
 * node scripts/sweep-pages.mjs
 * ```
 *
 * ## What counts as a failure
 *
 * A `5xx` always does. A `4xx` does not: `/v/<packetId>` on an unknown id *should* be a 404, and a
 * sweep that flags correct refusals trains you to ignore it. What it does flag is a `4xx`/`5xx` whose
 * body contains a stack trace, a `digest`, or a framework error name — a page that leaks internals is
 * a failure at any status code.
 */
const BASE = process.env['COUNTERSIGN_WEB_URL'] ?? 'http://127.0.0.1:3000'

/** Static routes, plus a real dynamic id where one is needed to exercise the page at all. */
const PAGES = ['/', '/intent', '/judge', '/shop', '/regions', '/lab/device-sign', '/status']

/**
 * Fragments that mean a framework error page rather than a rendered product page.
 *
 * **Only unambiguous strings.** The first version looked for `next/dist` and `at Object.`, which appear
 * in every healthy dev page — Next inlines its runtime and its dev tooling into the HTML — so the sweep
 * reported all seven pages as failures. A check that always fires is worse than no check, because it
 * teaches you to skim past the one time it is right.
 *
 * These four cannot appear in a page that rendered successfully.
 */
const ERROR_MARKERS = [
  'Application error: a server-side exception',
  'Unhandled Runtime Error',
  'Internal Server Error',
  'This error happened while generating the page',
]

let failures = 0

for (const path of PAGES) {
  const started = Date.now()
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { connection: 'close' },
      signal: AbortSignal.timeout(60_000),
    })
    const body = await res.text()
    const ms = Date.now() - started

    const markers = ERROR_MARKERS.filter((marker) => body.includes(marker))
    const empty = body.trim() === ''
    const serverError = res.status >= 500

    const bad = serverError || markers.length > 0 || empty
    if (bad) failures += 1

    const notes = [empty ? 'EMPTY BODY' : '', ...markers.map((m) => `marker=${m}`)].filter(
      (n) => n !== '',
    )
    const suffix = notes.length > 0 ? `  ${notes.join(' ')}` : ''
    const label = bad ? 'FAIL' : 'ok  '
    console.log(
      `${label}  ${String(res.status).padEnd(4)} ${String(ms).padEnd(6)}ms ${String(body.length).padEnd(8)}B ${path}${suffix}`,
    )
  } catch (error) {
    failures += 1
    console.log(
      `FAIL  ---  ${Date.now() - started}ms  0B ${path}  THREW ${error.name}: ${error.message}`,
    )
  }
}

console.log(`\n${failures === 0 ? 'every page rendered' : `${failures} page(s) need attention`}`)
process.exitCode = failures === 0 ? 0 : 1
