/**
 * Can the live app's real HTML be rendered by a headless preview?
 *
 * The T3 collaborative tab cannot produce a screencast while its renderer is not compositing
 * (`visible: false`), so a real page recording is not available. This checks the one remaining visual
 * path: whether the app's server-rendered HTML references its stylesheet by a URL a headless renderer
 * could fetch, which is what would make a captioned page render faithfully outside the app.
 *
 * Prints facts only — no conclusions. Run with `node scripts/probe-headless-render.mjs`.
 */
const BASE = process.env['COUNTERSIGN_WEB_URL'] ?? 'http://127.0.0.1:3000'
const PATHS = ['/', '/intent', '/shop', '/status']

for (const path of PATHS) {
  const res = await fetch(`${BASE}${path}`, { headers: { connection: 'close' } })
  const html = await res.text()

  const cssHrefs = [...html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"/g)].map((m) => m[1])
  const inlineStyles = (html.match(/<style/g) ?? []).length
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
  const absolute = cssHrefs.filter((h) => h.startsWith('http'))

  console.log(`\n${path}  →  HTTP ${res.status}, ${html.length} bytes`)
  console.log(`  css links:      ${cssHrefs.length} (${absolute.length} absolute)`)
  for (const href of cssHrefs.slice(0, 3)) console.log(`    ${href.slice(0, 110)}`)
  console.log(`  inline <style>: ${inlineStyles}`)
  console.log(`  script srcs:    ${scripts.length}`)

  // Does the stylesheet itself fetch cleanly from outside the page context?
  const first = cssHrefs[0]
  if (first) {
    const url = first.startsWith('http') ? first : `${BASE}${first}`
    const css = await fetch(url, { headers: { connection: 'close' } }).catch((e) => ({
      ok: false,
      status: String(e),
    }))
    const body = css.ok ? await css.text() : ''
    console.log(
      `  stylesheet:     HTTP ${css.status}, ${body.length} bytes${css.ok ? '' : ' (unreachable)'}`,
    )
  }
}
