/**
 * The buyer session — "one browser is one buyer" (audit §4).
 *
 * Before this, `/api/agent/session` minted a fresh `usr_…` on every request: two turns were two strangers, a
 * reload was a stranger, and nothing in `apps/web` could tell one browser from another. These tests pin the
 * replacement, and the third one is the reason the change exists:
 *
 *  1. Two mandates in one browser are the **same buyer** — and still two mandates.
 *  2. Two browsers are two buyers.
 *  3. A run in browser B that names browser A's buyer is refused **before** any mandate is read.
 *
 * They drive the real routes through the browser's own cookie jar (`page.request`), so a cookie that is set
 * but not sent — or sent but not read — fails here rather than in production.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'

interface SessionResponse {
  user_id: string
  mandate_id: string
  agent_id: string
}

async function createMandate(
  request: APIRequestContext,
  capMinor: number,
  intent = 'Buy the cheapest trail shoes you can find, under 150',
): Promise<SessionResponse> {
  const response = await request.post('/api/agent/session', {
    data: { intent, cap_minor: String(capMinor) },
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as SessionResponse
}

test.describe('the buyer session', () => {
  test('one browser keeps one buyer across two mandates', async ({ page }) => {
    const first = await createMandate(page.request, 5000)
    const second = await createMandate(page.request, 15000)

    expect(second.user_id).toBe(first.user_id)
    // Reusing the buyer must not mean reusing the mandate: a second run gets its own cap and its own budget.
    expect(second.mandate_id).not.toBe(first.mandate_id)
    expect(second.agent_id).not.toBe(first.agent_id)
  })

  test('a second browser is a different buyer', async ({ browser }) => {
    const one = await browser.newContext()
    const two = await browser.newContext()
    try {
      const first = await createMandate(one.request, 5000)
      const second = await createMandate(two.request, 5000)
      expect(second.user_id).not.toBe(first.user_id)
    } finally {
      await one.close()
      await two.close()
    }
  })

  test('a run cannot claim another browser’s buyer', async ({ browser }) => {
    const mine = await browser.newContext()
    const theirs = await browser.newContext()
    try {
      const victim = await createMandate(mine.request, 15000)

      // The attacker's own session, then a run naming the victim's user id. The mandate id is invented: the
      // refusal has to happen before any mandate is read, or the guard is a filter and not a boundary.
      const attacker = await createMandate(theirs.request, 5000)
      expect(attacker.user_id).not.toBe(victim.user_id)

      const response = await theirs.request.post('/api/agent/run', {
        data: {
          user_id: victim.user_id,
          mandate_id: victim.mandate_id,
          agent_id: attacker.agent_id,
          message: 'buy the cheapest trail shoes you can find, under 150',
          mode: 'scripted',
        },
      })
      expect(response.status()).toBe(403)
      expect(await response.text()).toContain('does not belong to this browser')
    } finally {
      await mine.close()
      await theirs.close()
    }
  })
})
