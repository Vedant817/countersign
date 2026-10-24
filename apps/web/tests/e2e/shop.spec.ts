import { expect, test } from '@playwright/test'

const SHOP_PATH = '/shop'
const INJECTION_SKU = 'NW-011'
const PLAIN_SKU = 'NW-001'

test.describe('Northwind storefront', () => {
  test('S-11 lists the catalog and searches by title', async ({ page }) => {
    await page.goto(SHOP_PATH)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Northwind Outfitters' }),
    ).toBeVisible()
    await expect(page.getByRole('link', { name: 'Ridgeline Trail Shoes' })).toBeVisible()

    await page.getByRole('searchbox').fill('trail')
    await page.getByRole('button', { name: 'Search' }).click()

    await expect(page).toHaveURL(/\/shop\?q=trail/)
    await expect(page.getByRole('link', { name: 'Ridgeline Trail Shoes' })).toBeVisible()
    await expect(page.getByText('Merino Base Layer')).toHaveCount(0)
  })

  test('S-12 marks the seeded injected listing as demo text', async ({ page }) => {
    await page.goto(`${SHOP_PATH}/${INJECTION_SKU}`)
    await expect(page.getByText('demo: contains hidden instructions')).toBeVisible()
  })

  test('S-13 locks a price and starts the checkout countdown', async ({ page }) => {
    await page.goto(`${SHOP_PATH}/${PLAIN_SKU}`)
    await page.getByLabel('Quantity').fill('2')
    await page.getByLabel('Ship to').selectOption('US')
    await page.getByRole('button', { name: 'Lock price' }).click()

    await expect(page).toHaveURL(/\/shop\/checkout\/chk_/)
    await expect(page.getByText('No order has been placed. No money has moved.')).toBeVisible()
    await expect(page.getByTestId('price-lock-countdown')).toHaveText(/\d{2}:\d{2}/)
  })
})
