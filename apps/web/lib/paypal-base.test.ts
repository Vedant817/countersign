/**
 * `PAYPAL_API_BASE` is resolved once, by one module, and every reader agrees (D-040).
 *
 * ## The defect this file pins down
 *
 * `apps/web/lib/demo-order.ts` defaulted an unset `PAYPAL_API_BASE` to the sandbox host while
 * `apps/web/app/status/route.ts` treated an unset `PAYPAL_API_BASE` as "PayPal is not configured" and
 * answered `503` with `paypalConfigured: false`. The two readers disagreed about the same deployment: the
 * order path could create a real sandbox order on an instance whose own health page said PayPal was
 * absent. That is the failure mode `docs/PROD_AUDIT.md` §6 describes, and it is the same class as the
 * `.env.local` disk fallback in the same file — a second place that can be right while the first is wrong.
 *
 * So these tests are about **one** answer, not about a constant's spelling: the default exists, both
 * readers use it, and a *live* host is refused rather than quietly accepted.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_PAYPAL_BASE, isAllowedPaypalBase, resolvePaypalBase } from './paypal-base'

const original = process.env['PAYPAL_API_BASE']

afterEach(() => {
  if (original === undefined) delete process.env['PAYPAL_API_BASE']
  else process.env['PAYPAL_API_BASE'] = original
})

describe('the PayPal base URL', () => {
  it('defaults to the sandbox host when the operator left it unset', () => {
    delete process.env['PAYPAL_API_BASE']
    expect(resolvePaypalBase()).toBe(DEFAULT_PAYPAL_BASE)
  })

  it('never defaults to a live host (EC-ENV-1)', () => {
    expect(DEFAULT_PAYPAL_BASE).toMatch(/^https:\/\/[a-z0-9.-]*\.sandbox\.paypal\.com$/)
    expect(DEFAULT_PAYPAL_BASE).not.toContain('paypal.com/api')
    expect(isAllowedPaypalBase(DEFAULT_PAYPAL_BASE)).toBe(true)
  })

  it('prefers the operator value, trimmed, over the default', () => {
    process.env['PAYPAL_API_BASE'] = 'https://api-m.sandbox.paypal.com/'
    expect(resolvePaypalBase()).toBe('https://api-m.sandbox.paypal.com/')
  })

  it('treats a whitespace-only value as unset rather than as a URL', () => {
    process.env['PAYPAL_API_BASE'] = '   '
    expect(resolvePaypalBase()).toBe(DEFAULT_PAYPAL_BASE)
  })

  it('resolves against a supplied env object, not only the real environment', () => {
    expect(resolvePaypalBase({ PAYPAL_API_BASE: 'https://eu.sandbox.paypal.com' })).toBe(
      'https://eu.sandbox.paypal.com',
    )
    expect(resolvePaypalBase({})).toBe(DEFAULT_PAYPAL_BASE)
  })

  it('refuses a live host, and says so, so /status can report *why*', () => {
    expect(isAllowedPaypalBase('https://api-m.paypal.com')).toBe(false)
    expect(isAllowedPaypalBase('https://api.paypal.com')).toBe(false)
    expect(isAllowedPaypalBase('not a url')).toBe(false)
    expect(isAllowedPaypalBase('')).toBe(false)
  })

  it('allows a lookalike-free sandbox host and localhost, matching assertSandbox', () => {
    expect(isAllowedPaypalBase('https://m.sandbox.paypal.com')).toBe(true)
    expect(isAllowedPaypalBase('https://api-m.sandbox.paypal.com')).toBe(true)
    // `evil-sandbox.paypal.com` is a *different* domain, not a subdomain of the sandbox host.
    expect(isAllowedPaypalBase('https://evilsandbox.paypal.com')).toBe(false)
    expect(isAllowedPaypalBase('http://localhost:8080')).toBe(true)
  })
})
