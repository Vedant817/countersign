/**
 * Continuous screen recording of the Countersign demo beats on localhost:3210.
 *
 * Records one continuous Playwright video (1920x1080, 30fps WebM) while driving the real app with
 * visible typing and clicking (slowMo), paced against docs/demo/narration.vtt.
 *
 * ```sh
 * node scripts/record-demo.mjs            # records docs/demo/record/take.webm
 * ```
 *
 * Beats: /agent mandate -> Gate ALLOW -> real PayPal sandbox order panel + "Re-read from PayPal" ->
 * injected listing BLOCK -> /disputes two SIMULATED cases -> /v demo verifier. Nothing here fakes a
 * result: every beat is the running app (localhost:3210, VI on 8010).
 *
 * Playwright's own ffmpeg + Chromium are required:
 *   pnpm --filter @countersign/web exec playwright install chromium ffmpeg
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PW = 'C:/Users/vedan/Documents/Resources/Code/countersign/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs'
const { chromium } = await import(pathToFileURL(PW).href)

const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3210'
const OUT_DIR = path.resolve('docs/demo/record')
fs.mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true, slowMo: 150 })
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
  colorScheme: 'light',
})
const page = await context.newPage()
page.setDefaultTimeout(180_000)

let paypalOrderId = null
let paypalOrderStatus = null

try {
  // --- 0-6s: the agent chat, mandate form -------------------------------------------------------
  await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4500)

  // --- 6-18s: buyer types intent, picks the signed cap, creates the mandate ----------------------
  const intentInput = page.locator('input[maxlength="200"]').first()
  await intentInput.click()
  await intentInput.type('Buy the cheapest trail shoes you can find, under $150', { delay: 45 })
  await page.waitForTimeout(1200)
  await page.locator('select').first().selectOption('15000')
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: 'Create mandate' }).click()
  await page.locator('[data-testid="mandate-chip"]').waitFor({ state: 'visible' })
  await page.waitForTimeout(5000)

  // --- 18-30s: the agent turn; Gate ALLOW creates the real PayPal sandbox order ------------------
  const msg = page.getByLabel('Message the agent')
  await msg.click()
  await msg.type('Buy the cheapest trail shoes you can find, under $150', { delay: 35 })
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  await page.locator('[data-testid="paypal-order-panel"]').waitFor({ state: 'visible' })
  await page.waitForTimeout(3000)
  paypalOrderId = (await page.locator('[data-testid="paypal-order-id"]').textContent())?.trim() ?? null
  paypalOrderStatus =
    (await page.locator('[data-testid="paypal-order-status"]').textContent())?.trim() ?? null
  await page.locator('[data-testid="paypal-order-panel"]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(4000)

  // --- re-read from PayPal ----------------------------------------------------------------------
  const reread = page.getByRole('button', { name: 'Re-read from PayPal' })
  if (await reread.isVisible().catch(() => false)) {
    await reread.click()
    await page.waitForTimeout(5000)
  }

  // --- BLOCK: the injected listing ---------------------------------------------------------------
  await page.getByRole('button', { name: /Try the injected listing/i }).click()
  await page.locator('[data-testid="limits-held"]').waitFor({ state: 'visible' })
  await page.locator('[data-testid="limits-held"]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(6000)

  // --- /disputes: two SIMULATED cases through the production pipeline -----------------------------
  await page.goto(`${BASE}/disputes`, { waitUntil: 'domcontentloaded' })
  await page.getByText('R-UNAUTH-1').first().waitFor({ state: 'visible' })
  await page.waitForTimeout(4000)
  await page.evaluate(() => window.scrollTo({ top: 800, behavior: 'smooth' }))
  await page.waitForTimeout(4000)
  await page.evaluate(() => window.scrollTo({ top: 1800, behavior: 'smooth' }))
  await page.waitForTimeout(4000)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await page.waitForTimeout(2500)

  // --- /v: the demo verifier --------------------------------------------------------------------
  await page.goto(`${BASE}/v/pkt_F1RSTCASE10000000000000000`, { waitUntil: 'domcontentloaded' })
  await page.getByText('SIMULATED DISPUTE').first().waitFor({ state: 'visible' })
  await page.waitForTimeout(4000)
  await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'smooth' }))
  await page.waitForTimeout(5000)
  await page.evaluate(() => window.scrollTo({ top: 1400, behavior: 'smooth' }))
  await page.waitForTimeout(4000)

  console.log(JSON.stringify({ ok: true, paypalOrderId, paypalOrderStatus }))
} catch (err) {
  console.error('record-demo failed:', err?.stack || err)
  console.log(JSON.stringify({ ok: false, paypalOrderId, paypalOrderStatus, error: String(err?.message || err) }))
  process.exitCode = 1
} finally {
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