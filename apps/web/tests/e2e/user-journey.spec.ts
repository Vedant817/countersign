import { expect, test } from '@playwright/test'

test('a new visitor can reach the working flows and read styled actions on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/')
  const shop = page.getByRole('link', { name: 'Explore the storefront', exact: true })
  await expect(shop).toBeVisible()
  const style = await shop.evaluate((element) => {
    const computed = getComputedStyle(element)
    return { background: computed.backgroundColor, radius: computed.borderRadius }
  })
  expect(style.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(style.radius).not.toBe('0px')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await shop.click()
  await expect(
    page.getByRole('heading', { name: 'Northwind Outfitters', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Coverage' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Know the currency. Check the coverage.' }),
  ).toBeVisible()
})

test('unsupported physical currency is disclosed before checkout', async ({ page }) => {
  await page.goto('/shop/NW-021')
  await expect(page.getByText(/this store has no physical shipping rate in JPY/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Lock price' })).toHaveCount(0)
})

test('quote expiry preserves quantity and country without claiming refreshed prices', async ({
  page,
}) => {
  await page.clock.install()
  await page.goto('/shop/NW-001')
  await page.getByLabel('Quantity').fill('3')
  await page.getByLabel('Ship to').selectOption('CA')
  await page.getByRole('button', { name: 'Lock price' }).click()
  await expect(page).toHaveURL(/\/shop\/checkout\/chk_/)
  await expect(page.getByText('No order has been placed. No money has moved.')).toBeVisible()
  await expect(page.getByText(/Charge currency: USD/)).toBeVisible()
  await page.clock.fastForward(3_600_000)
  await expect(page.getByTestId('price-lock-countdown')).toContainText('Quote expired.')
  await expect(page.getByText('Prices refreshed.')).toHaveCount(0)
  await page.getByRole('link', { name: 'Re-quote this item' }).click()
  await expect(page.getByLabel('Quantity')).toHaveValue('3')
  await expect(page.getByLabel('Ship to')).toHaveValue('CA')
})

test('malformed checkout returns a controlled client error', async ({ request }) => {
  const response = await request.post('/shop/checkout', { data: { sku: 'NW-001', qty: 1 } })
  expect(response.status()).toBe(415)
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('CS_VALIDATION')
})
