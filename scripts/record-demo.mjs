/**
 * Rough-but-real screen recording of the Countersign demo beats on localhost:3210.
 * Drives: /agent (mandate -> ALLOW + real PayPal sandbox order + re-read, then injected BLOCK),
 * /disputes (two SIMULATED cases), /v (demo verifier). Records 1920x1080 webm.
 *
 * Run from repo root: node scripts/record-demo.mjs
 * Requires: stack up on http://localhost:3210 (and VI on 8010), Playwright installed in pnpm store.
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

const browser = await chromium.launch({
  headless: true,
  channel: 'msedge',
})
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  colorScheme: 'light',
})
const page = await context.newPage()
page.setDefaultTimeout(120_000)

const shots = []
let n = 0
const snap = async (name, ms = 1200) => {
  await page.waitForTimeout(ms)
  const file = path.join(OUT_DIR, `${String(++n).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  shots.push(file)
  console.log(JSON.stringify({ shot: file }))
  return file
}

let paypalOrderId = null

try {
  // --- Beat: /agent intro + mandate ---
  await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await snap('agent-intro')

  const intentInput = page.locator('input[maxlength="200"]').first()
  await intentInput.fill('Buy the cheapest trail shoes you can find, under $150')
  await page.locator('select').first().selectOption('15000')
  await page.getByRole('button', { name: 'Create mandate' }).click()
  await page.locator('[data-testid="mandate-chip"]').waitFor({ state: 'visible', timeout: 120_000 })
  await snap('mandate-signed', 3000)

  // --- Beat: ALLOW + real sandbox order (CREATED, unpaid) ---
  const msg = page.getByLabel('Message the agent')
  await msg.fill('Buy the cheapest trail shoes you can find, under $150')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.locator('[data-testid="paypal-order-panel"]').waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(3000)
  paypalOrderId = (await page.locator('[data-testid="paypal-order-id"]').textContent())?.trim() ?? null
  await page.locator('[data-testid="paypal-order-panel"]').scrollIntoViewIfNeeded().catch(() => null)
  await snap('allow-order', 1500)

  const reread = page.getByRole('button', { name: 'Re-read from PayPal' })
  if (await reread.isVisible().catch(() => false)) {
    await reread.click()
    await page.waitForTimeout(5000)
  }
  await page.locator('[data-testid="paypal-order-panel"]').scrollIntoViewIfNeeded().catch(() => null)
  await snap('order-reread', 1500)

  // --- Beat: BLOCK (injected/out-of-scope listing) ---
  await page.getByRole('button', { name: /Try the injected listing/i }).click()
  await page.locator('[data-testid="limits-held"]').waitFor({ state: 'visible', timeout: 120_000 })
  await page.locator('[data-testid="limits-held"]').scrollIntoViewIfNeeded().catch(() => null)
  await snap('block', 2500)

  // --- Beat: /disputes (SIMULATED) ---
  await page.goto(`${BASE}/disputes`, { waitUntil: 'domcontentloaded' })
  await page.getByText('R-UNAUTH-1').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.waitForTimeout(2000)
  await snap('disputes-top', 1000)
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }))
  await snap('disputes-mid', 1500)
  await page.evaluate(() => window.scrollTo({ top: 2000, behavior: 'instant' }))
  await snap('disputes-bottom', 1500)

  // --- Beat: /v demo verifier ---
  await page.goto(`${BASE}/v/pkt_F1RSTCASE10000000000000000`, { waitUntil: 'domcontentloaded' })
  await page.getByText('SIMULATED DISPUTE').waitFor({ state: 'visible', timeout: 120_000 })
  await snap('verifier-top', 2000)
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }))
  await snap('verifier-checks', 2000)

  console.log(JSON.stringify({ ok: true, paypalOrderId, shots }))
} catch (err) {
  console.error('record-demo failed:', err?.stack || err)
  console.log(JSON.stringify({ ok: false, paypalOrderId, shots, error: String(err?.message || err) }))
  process.exitCode = 1
} finally {
  await context.close().catch(() => null)
  await browser.close().catch(() => null)
}
