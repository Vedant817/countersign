import { expect, test } from '@playwright/test'

/**
 * `/disputes` in the branch the e2e environment can reach.
 *
 * `playwright.config.ts` sets `COUNTERSIGN_AGENT_DEMO=1` and runs `next dev`, so this suite exercises the
 * **demo** branch: the fixtures, labelled. The other branch - the one `next start` always serves, because
 * `NODE_ENV=production` turns the demo off regardless of the flag - is covered by
 * `apps/web/lib/dispute-queue.test.ts`, which asserts the decision and reads real rows from Postgres.
 *
 * What this test guards is the seam between them: the page must not drop the SIMULATED label while the
 * fixtures are on screen, and the queue page must not appear at the same time.
 */
test('the disputes page labels its fixtures when the demo branch is on', async ({ page }) => {
  await page.goto('/disputes')

  await expect(page.getByRole('heading', { name: 'The Dispute Defender' })).toBeVisible()
  await expect(page.getByText('SIMULATED DISPUTES')).toBeVisible()
  await expect(page.getByText('SIMULATED:')).toBeVisible()
  // The real branch's copy must not be on the page at the same time, or a reader cannot tell which
  // they are looking at.
  await expect(page.getByRole('heading', { name: 'Disputes', exact: true })).toHaveCount(0)
})
