import os from 'node:os'
import path from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { eq } from 'drizzle-orm'

import { BUYER, closeDb, db, findUserByEmail, paypalWallets } from '@countersign/db'

const baseUrl = process.env['BASE_URL'] ?? 'http://localhost:3000'
const buyerEmail = process.env['BUYER_EMAIL'] ?? BUYER.email
const buyerPassword = process.env['BUYER_PASSWORD']
const paypalBuyerEmail = process.env['PAYPAL_BUYER_EMAIL']
const paypalBuyerPassword = process.env['PAYPAL_BUYER_PASSWORD']
const headed = process.env['HEADED'] === '1' || process.env['HEADED'] === 'true'

async function saveFailureAndExit(
  page: Page | null,
  step: string,
  errorText: string,
): Promise<never> {
  const screenshotPath = path.join(os.tmpdir(), `cs-vault-${step}.png`)
  let hostPath = 'unknown'
  if (page) {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true })
    } catch {
      // Ignore screenshot error
    }
    try {
      const u = new URL(page.url())
      hostPath = `${u.protocol}//${u.host}${u.pathname}`
    } catch {
      hostPath = page.url()
    }
  }
  console.error(`FAILED STEP: ${step}`)
  console.error(`URL: ${hostPath}`)
  console.error(`ERROR: ${errorText}`)
  console.error(`SCREENSHOT: ${screenshotPath}`)
  try {
    await closeDb()
  } catch {
    // Ignore close error
  }
  process.exit(1)
}

async function saveSuccessScreenshot(page: Page, step: string): Promise<void> {
  try {
    const screenshotPath = path.join(os.tmpdir(), `cs-vault-ok-${step}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true })
  } catch {
    // Ignore screenshot error
  }
}

async function main(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    await saveFailureAndExit(null, 'init', 'DATABASE_URL environment variable is missing')
  }
  if (!buyerPassword) {
    await saveFailureAndExit(null, 'init', 'BUYER_PASSWORD environment variable is missing')
  }
  if (!paypalBuyerEmail) {
    await saveFailureAndExit(null, 'init', 'PAYPAL_BUYER_EMAIL environment variable is missing')
  }
  if (!paypalBuyerPassword) {
    await saveFailureAndExit(null, 'init', 'PAYPAL_BUYER_PASSWORD environment variable is missing')
  }

  const browser = await chromium.launch({
    channel: process.env['PW_CHANNEL'] || undefined,
    headless: !headed,
    slowMo: headed ? 150 : undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  page.setDefaultTimeout(60000)
  page.setDefaultNavigationTimeout(60000)

  try {
    // Step 1: Sign in as buyer in Countersign
    try {
      await page.goto(`${baseUrl}/buyer-login?next=/wallet`, { waitUntil: 'domcontentloaded' })
    } catch (e) {
      await saveFailureAndExit(page, 'buyer_login_navigate', `Failed to open buyer-login: ${e}`)
    }

    try {
      await page.getByLabel('Email').fill(buyerEmail)
      await page.getByLabel('Password').fill(buyerPassword)
      await page.getByRole('button', { name: /sign in/i }).click()
      await page.waitForURL((url) => url.pathname.includes('/wallet'), { timeout: 30000 })
      await saveSuccessScreenshot(page, 'buyer-login')
    } catch (e) {
      const bodyText = (await page.textContent('body')) ?? ''
      await saveFailureAndExit(
        page,
        'buyer_login_submit',
        `Buyer sign-in failed: ${e}. Page: ${bodyText.slice(0, 300)}`,
      )
    }

    // Step 2: Start PayPal Vault flow from /wallet
    try {
      const saveBtn = page.getByRole('button', { name: /save a paypal payment method/i })
      await saveBtn.waitFor({ state: 'visible', timeout: 15000 })
      await saveBtn.click()
      await page.waitForURL((url) => url.hostname.includes('paypal.com'), { timeout: 60000 })
      await saveSuccessScreenshot(page, 'vault-start')
    } catch (e) {
      const bodyText = (await page.textContent('body')) ?? ''
      await saveFailureAndExit(
        page,
        'wallet_start_vault',
        `Failed to initiate vault flow: ${e}. Page: ${bodyText.slice(0, 300)}`,
      )
    }

    // Step 3: PayPal Sandbox login
    try {
      await page.waitForLoadState('domcontentloaded')

      // Cookie banner check
      const cookieBtn = page.locator(
        '#acceptAllButton, button:has-text("Accept Cookies"), #bannerAccept',
      )
      if (await cookieBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await cookieBtn.click().catch(() => {})
      }

      // Check for security challenge / captcha / 2FA block
      const pageText = (await page.textContent('body')) ?? ''
      if (
        pageText.includes('unusual activity') ||
        pageText.includes('security challenge') ||
        pageText.includes('Enter the code') ||
        pageText.includes('quick security check')
      ) {
        await saveFailureAndExit(
          page,
          'paypal_security_challenge',
          'PayPal blocked automation with security check/2FA',
        )
      }

      // PayPal login can show email + password on one page, or email first then password
      const emailInput = page
        .locator('#email, input[name="login_email"], input[type="email"]')
        .first()
      const passwordInput = page
        .locator('#password, input[name="login_password"], input[type="password"]')
        .first()
      const nextBtn = page
        .locator('#btnNext')
        .or(page.getByRole('button', { name: 'Next', exact: true }))
        .first()
      const loginBtn = page
        .locator('#btnLogin')
        .or(page.getByRole('button', { name: 'Log In', exact: true }))
        .first()

      // Check if email input is present and visible
      const hasEmail = await emailInput.isVisible({ timeout: 5000 }).catch(() => false)
      if (hasEmail) {
        await emailInput.fill('')
        await emailInput.fill(paypalBuyerEmail)
        const hasNext = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)
        const hasPasswordNow = await passwordInput.isVisible({ timeout: 1000 }).catch(() => false)
        if (hasNext && !hasPasswordNow) {
          await nextBtn.click({ force: true }).catch(async () => {
            await emailInput.press('Enter')
          })
        }
      }

      // Wait for password input to become visible
      await passwordInput.waitFor({ state: 'visible', timeout: 30000 })
      await passwordInput.fill('')
      await passwordInput.fill(paypalBuyerPassword)
      await page.waitForTimeout(500)

      await Promise.all([
        page.waitForNavigation({ timeout: 30000 }).catch(() => null),
        loginBtn.click({ force: true }).catch(async () => {
          await passwordInput.press('Enter')
        }),
      ])
      await saveSuccessScreenshot(page, 'paypal-login')
    } catch (e) {
      const bodyText = (await page.textContent('body')) ?? ''
      await saveFailureAndExit(
        page,
        'paypal_login',
        `PayPal login failed: ${e}. Page: ${bodyText.slice(0, 300)}`,
      )
    }

    // Step 4: Consent / Approval on PayPal
    try {
      await page.waitForLoadState('domcontentloaded')
      const targetHost = new URL(baseUrl).hostname
      const consentBtn = page.locator(
        '#consentButton, button[name="agree"], button:has-text("Agree"), button:has-text("Save and continue"), button:has-text("Continue"), button:has-text("Confirm"), button:has-text("Accept")',
      )

      // Poll until redirected back to targetHost or consent button becomes clickable
      const startTime = Date.now()
      let redirected = false

      while (Date.now() - startTime < 90000) {
        const current = new URL(page.url())
        if (current.hostname === targetHost && current.pathname.includes('/wallet')) {
          redirected = true
          break
        }

        const pageText = (await page.textContent('body').catch(() => '')) ?? ''
        if (
          pageText.includes('unusual activity') ||
          pageText.includes('security challenge') ||
          pageText.includes('Enter the code') ||
          pageText.includes('quick security check')
        ) {
          await saveFailureAndExit(
            page,
            'paypal_consent_challenge',
            'PayPal blocked automation at consent step',
          )
        }

        const canClickConsent = await consentBtn
          .first()
          .isVisible()
          .catch(() => false)
        if (canClickConsent) {
          await consentBtn
            .first()
            .click({ force: true })
            .catch(() => {})
        }

        await page.waitForTimeout(1000)
      }

      if (!redirected) {
        await page.waitForURL(
          (url) => url.hostname === targetHost && url.pathname.includes('/wallet'),
          { timeout: 30000 },
        )
      }
      await saveSuccessScreenshot(page, 'consent')
    } catch (e) {
      const bodyText = (await page.textContent('body')) ?? ''
      await saveFailureAndExit(
        page,
        'paypal_consent',
        `PayPal approval step failed: ${e}. Page: ${bodyText.slice(0, 300)}`,
      )
    }

    // Step 5: Verification on Countersign /wallet
    try {
      await page.waitForLoadState('domcontentloaded')
      const statusElement = page.locator('[role="status"]')
      const statusText = (await statusElement.textContent().catch(() => ''))?.trim() ?? ''

      // Query database for the active wallet
      const userRes = await findUserByEmail(buyerEmail)
      if (!userRes.ok || !userRes.value) {
        await saveFailureAndExit(page, 'verify_db', 'Could not find buyer in database')
      }

      const rows = await db()
        .select()
        .from(paypalWallets)
        .where(eq(paypalWallets.user_id, userRes.value.id))

      const activeWallet = rows.find(
        (r) => r.status === 'ACTIVE' && !r.payment_token_id.includes('PLACEHOLDER'),
      )

      if (!activeWallet) {
        await saveFailureAndExit(
          page,
          'verify_wallet_row',
          'No active real PayPal wallet row found in database',
        )
      }

      const token = activeWallet.payment_token_id
      const tokenPrefix = token.slice(0, 4)
      const tokenLength = token.length

      console.info('vault_saved=true')
      console.info(`status_text=${statusText}`)
      console.info(`payment_token_prefix=${tokenPrefix}`)
      console.info(`payment_token_length=${tokenLength}`)
    } catch (e) {
      await saveFailureAndExit(page, 'verify_final', `Verification failed: ${e}`)
    }
  } finally {
    await browser.close()
    await closeDb()
  }
}

main().catch(async (e) => {
  console.error(`Unhandled error: ${e}`)
  try {
    await closeDb()
  } catch {
    // Ignore close error
  }
  process.exit(1)
})
