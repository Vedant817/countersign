/**
 * Continuous screen recording of the Countersign demo beats on localhost:3210.
 *
 * One take, recorded by Playwright at 1920x1080 with `slowMo`, cut to
 * `docs/demo/narration.vtt`: every beat *starts* on the wall-clock offset where its narration line
 * begins, so the narration is never stretched to fit a video recorded to a different length (the
 * earlier cut was 89s of video behind 106.5s of narration, padded with a frozen last frame).
 *
 *   pnpm --filter @countersign/web exec playwright install chromium ffmpeg
 *   python scripts/demo-beats.py            # writes the offsets this reads
 *   node scripts/record-demo.mjs            # -> docs/demo/record/take.webm
 *
 * Node cannot parse the VTT without a dependency, so `scripts/demo-beats.py` is that parser and
 * `docs/demo/record/beats.json` is its output. Delete the json and the baked-in copy is used.
 *
 * Nothing here fakes a result: every beat is the running app (localhost:3210 web, VI on 8010).
 *
 * ## Why a hold is a caption, not a still
 *
 * A hold has to read as a recording rather than a screenshot, and on this app there is nothing to
 * move: every page fits inside 1080p, so there is no scroll, and a cursor at 1080p is a per-frame
 * delta far under freezedetect's noise threshold. What is left is the thing a viewer actually wants
 * on screen during a narration line - the line itself. `caption` types the narration cue word by word
 * into a strip at the bottom of the page, which is real text on screen, keeps the frame moving, and
 * is honest about being the narration track.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PW =
  'C:/Users/vedan/Documents/Resources/Code/countersign/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs'
const { chromium } = await import(pathToFileURL(PW).href)

const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3210'
const OUT_DIR = path.resolve('docs/demo/record')
const BEATS_JSON = process.env.DEMO_BEATS ?? ''
const BEATS_FILE = process.env['DEMO_BEATS_FILE'] ?? path.resolve('docs/demo/record/beats.json')
const CUES = path.resolve('docs/demo/record/cues.json')
fs.mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Baked-in copy of docs/demo/narration.vtt, used only when beats.json is missing. */
const BEATS = {
  mandate_intent: 12.262,
  mandate_signed: 20.662,
  checkout: 26.2,
  allow: 31.112,
  re_read: 46.437,
  block: 48.762,
  hold: 55.35,
  defender: 58.5,
  disputes: 67.062,
  packet: 79.937,
  verifier: 84.625,
  close: 98.337,
}

const readJson = (file) => {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  return parsed.beats ?? parsed
}

/** Offsets `python scripts/demo-beats.py` writes, so the VTT stays the source of truth. */
let beats = BEATS
try {
  beats = readJson(BEATS_FILE)
} catch {
  console.warn(`[record-demo] no ${BEATS_FILE}; using the offsets baked into this file`)
}
if (BEATS_JSON !== '') beats = JSON.parse(BEATS_JSON)

/** The narration cues, as [{start, end, text}]. */
let cues = []
try {
  cues = readJson(CUES)
} catch {
  console.warn(`[record-demo] no ${CUES}; holds will not carry a caption`)
}

const browser = await chromium.launch({ headless: true, slowMo: 150 })

// 1280x720 CSS pixels at 1.5x device scale, recorded at 1920x1080. Two reasons, both measured:
//  - the pages *scroll* at 720px of viewport, so a hold has real motion to make;
//  - 1.5x keeps the output 1920x1080, and the layout is the app at 150% zoom, which is easier to
//    read in a video than 1080p at 1x.
// A 1920x1080 viewport fits every page inside one screen, and a hold on a page that cannot scroll
// has nothing to move - which is why the earlier cut read as a slideshow between beats.
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1.5,
  recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
  colorScheme: 'light',
})
const page = await context.newPage()
page.setDefaultTimeout(180_000)

const t0 = Date.now()
const elapsed = () => (Date.now() - t0) / 1000

/** Milliseconds to wait so the next beat lands on its narration offset. */
const until = (beat, lead = 1) => Math.max(0, (beats[beat] - lead - elapsed()) * 1000)

/** Park the viewport at `top` so the panel a beat talks about is on screen. */
const park = async (top) => {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), Math.max(0, top))
}

/** The offset that puts `locator`'s top edge just under the sticky header. */
const topOf = async (locator, pad = 90) =>
  locator.evaluate((el, margin) => el.getBoundingClientRect().top + window.scrollY - margin, pad)

/** The narration cue that is playing right now (or the one being led into). */
const cueAt = (seconds) => {
  const playing = cues.filter((cue) => seconds >= cue.start - 0.6 && seconds < cue.end)
  return playing.length > 0 ? playing[playing.length - 1] : null
}

/**
 * A hold: keep the frame moving for `ms` with the narration line typing itself in.
 *
 * `setCaption` writes the strip (created on first use), `typeCaption` advances it word by word, and
 * `clearCaption` removes it before a beat whose panel must be unobstructed. The scroll is still there
 * for the pages that are taller than the frame, and is a no-op when they are not.
 */
const makeCaptionApi = () => {
  /** Create the strip if it is not up, and write one line into it. */
  const setCaption = async (text) => {
    await page.evaluate((line) => {
      let strip = document.getElementById('cs-caption')
      if (strip === null) {
        strip = document.createElement('div')
        strip.id = 'cs-caption'
        strip.setAttribute('aria-hidden', 'true')
        strip.style.cssText = [
          'position:fixed',
          'left:0',
          'right:0',
          'bottom:0',
          'height:74px',
          'box-sizing:border-box',
          'z-index:2147483647',
          'padding:14px 32px 18px',
          'font:400 19px/1.35 ui-sans-serif,system-ui,sans-serif',
          'color:#f5f2ea',
          'background:rgba(18,20,24,0.88)',
          'border-top:1px solid rgba(245,242,234,0.25)',
        ].join(';')
        document.body.appendChild(strip)
      }
      strip.textContent = line
    }, text)
  }

  /** A word at a time, on the cue's own clock, so the strip moves for the whole line. */
  const typeCaption = async (cue, now) => {
    const words = cue.text.split(' ')
    const progress = Math.min(
      1,
      Math.max(0, (now - cue.start) / Math.max(0.8, cue.end - cue.start)),
    )
    const n = Math.max(1, Math.ceil(progress * words.length))
    await setCaption(words.slice(0, n).join(' '))
  }

  /** Blink a caret on the line: the motion between cues, and after the last word. */
  let caretOn = false
  const setCaret = async () => {
    caretOn = !caretOn
    await page.evaluate(
      ([on]) => {
        const strip = document.getElementById('cs-caption')
        if (strip === null) return
        strip.textContent = strip.textContent.replace(/\u258c$/, '') + (on ? '\u258c' : '')
      },
      [caretOn],
    )
  }

  return { setCaption, typeCaption, setCaret }
}

let caption = null

const hold = async (ms, { caret = false, limit = 600, step = 140, clear = true } = {}) => {
  const end = Date.now() + ms
  let y = 0
  let dir = 1
  let lastCue = null
  if (caret && caption === null) caption = makeCaptionApi()
  if (caret) await caption.setCaption('')
  while (Date.now() < end) {
    const now = elapsed()
    const cue = cueAt(now)
    if (cue !== null) {
      lastCue = cue
      await caption.typeCaption(cue, now)
    } else if (caret && lastCue !== null) {
      // Between cues: keep the line up, so the strip is the thing that moves.
      await caption.setCaption(lastCue.text)
    }

    // A hold needs to move *area*, not just pixels: at 1080p a caption strip alone is well under
    // freezedetect's 0.3% threshold, and the scroll is the only large-area motion this app has
    // (every page scrolls at 720px of viewport). So each hold is a slow scroll down its own page
    // and back, and the caption rides along with it.
    y += step * dir
    if (y >= limit) {
      y = limit
      dir = -1
    } else if (y <= 0) {
      y = 0
      dir = 1
    }
    await park(y)
    await sleep(90)
  }
  if (clear) await caption.setCaption('')
}

let paypalOrderId = null
let paypalOrderStatus = null

try {
  // --- 0-12s: the agent chat, the mandate form, nothing touched yet -----------------------------
  await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' })
  caption = makeCaptionApi()
  const intentInput = page.locator('input[maxlength="200"]').first()

  // The strip for a hold. Two shapes, because the app offers two:
  //  - `caret`: the strip carries a typing caret, so it moves by itself (used where the page has
  //    nothing of its own to move: every screen here fits inside 1080p).
  //  - `limit`: the page is taller than the frame, so a real scroll is the motion.
  await hold(until('mandate_intent', 1), { caret: true, limit: 520, step: 140 })

  // --- 12-20s: the buyer types the sentence, then picks the cap ----------------------------------
  await intentInput.click()
  await intentInput.type('Buy the cheapest trail shoes you can find, under $150', { delay: 60 })
  await page.waitForTimeout(500)
  await page.locator('select').first().selectOption('15000')

  // --- 20-26s: the mandate is signed -------------------------------------------------------------
  await hold(until('mandate_signed', 1.5), { caret: true, limit: 300, step: 140 })
  await page.getByRole('button', { name: 'Create mandate' }).click()
  await page.locator('[data-testid="mandate-chip"]').waitFor({ state: 'visible' })
  await park(0)
  await hold(until('checkout', 2.5), { caret: true, limit: 300, step: 140 })

  // --- 26-31s: the agent turn; the Gate evaluates ------------------------------------------------
  const msg = page.getByLabel('Message the agent')
  await msg.click()
  await msg.type('Buy the cheapest trail shoes you can find, under $150', { delay: 26 })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await hold(until('allow', 0.8), { caret: true, limit: 300, step: 140 })

  // --- 31s: ALLOW and the real PayPal sandbox order -----------------------------------------------
  const panel = page.locator('[data-testid="paypal-order-panel"]')
  await panel.waitFor({ state: 'visible' })
  paypalOrderId =
    (await page.locator('[data-testid="paypal-order-id"]').textContent())?.trim() ?? null
  paypalOrderStatus =
    (await page.locator('[data-testid="paypal-order-status"]').textContent())?.trim() ?? null
  await park(await topOf(panel))

  // --- 37-46s: hold on the order id / status / custom_id -------------------------------------------
  await hold(until('re_read', 2.5), { caret: true, limit: 520, step: 140, clear: false })

  // --- 46-48s: re-read from PayPal ---------------------------------------------------------------------
  const reread = page.getByRole('button', { name: 'Re-read from PayPal' })
  if (await reread.isVisible().catch(() => false)) await reread.click()
  await hold(until('block', 1.5), { caret: true, limit: 300, step: 140 })

  // --- 48-55s: the injected listing is refused ----------------------------------------------------------
  await page.getByRole('button', { name: /Try the injected listing/i }).click()
  await hold(until('hold', 1.5), { caret: true, limit: 300, step: 140 })
  const limits = page.locator('[data-testid="limits-held"]')
  await limits.waitFor({ state: 'visible' })
  await park(await topOf(limits))
  await hold(until('defender', 2), { caret: true, limit: 300, step: 140, clear: false })

  // --- 58-67s: the Dispute Defender (the deterministic rule table) ----------------------------------------
  await page.goto(`${BASE}/disputes`, { waitUntil: 'domcontentloaded' })
  await page.getByText('R-UNAUTH-1').first().waitFor({ state: 'visible' })
  await park(0)
  await hold(until('disputes', 2), { caret: true, limit: 700, step: 150, clear: false })

  // --- 67-79s: the two SIMULATED cases -----------------------------------------------------------------------
  await hold(until('packet', 2.5), { caret: true, limit: 780, step: 150, clear: false })

  // --- 79-84s: the contested case's evidence packet PDF + QR ----------------------------------------------------
  const packet = page.getByText('Evidence packet', { exact: false }).first()
  await packet.scrollIntoViewIfNeeded().catch(() => null)
  await park(await topOf(packet, 110).catch(() => 700))
  await hold(until('verifier', 2.5), { caret: true, limit: 340, step: 110, clear: false })

  // --- 84-98s: the public verifier -------------------------------------------------------------------------------
  await page.goto(`${BASE}/v/pkt_F1RSTCASE10000000000000000`, { waitUntil: 'domcontentloaded' })
  await page.getByText('SIMULATED DISPUTE').first().waitFor({ state: 'visible' })
  await park(0)
  await hold(until('close', 3.5), { caret: true, limit: 820, step: 150, clear: false })

  // --- 98-106s: the closing line, then hold on the checks -----------------------------------------------------------
  const tail = 106.4 - elapsed()
  if (tail > 0) await hold(tail * 1000, { caret: true, limit: 860, step: 150, clear: false })

  console.log(JSON.stringify({ ok: true, paypalOrderId, paypalOrderStatus, seconds: elapsed() }))
} catch (err) {
  console.error('record-demo failed:', err?.stack || err)
  console.log(
    JSON.stringify({
      ok: false,
      paypalOrderId,
      paypalOrderStatus,
      error: String(err?.message || err),
    }),
  )
  process.exitCode = 1
} finally {
  await caption?.setCaption('').catch(() => null)
  const video = page.video()
  await context.close().catch(() => null)
  await browser.close().catch(() => null)
  if (video) {
    const src = await video.path().catch(() => null)
    if (src && fs.existsSync(src)) {
      const dest = path.resolve('docs/demo/record/take.webm')
      try {
        fs.copyFileSync(src, dest)
      } catch {
        fs.renameSync(src, dest)
      }
      console.log(JSON.stringify({ video: dest, bytes: fs.statSync(dest).size }))
    }
  }
}
