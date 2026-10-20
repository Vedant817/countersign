import { Buffer } from 'node:buffer'
import { expect, test, type Page } from '@playwright/test'

const LAB_PATH = '/lab/device-sign'

async function armVirtualAuthenticator(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page)
  await session.send('WebAuthn.enable')
  await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

async function openLab(page: Page): Promise<void> {
  await armVirtualAuthenticator(page)
  await page.goto(LAB_PATH)
  await expect(page.getByTestId('device-kid')).toBeVisible()
}

async function prepareAndSign(page: Page): Promise<string> {
  await page.getByTestId('prepare-button').click()
  await expect(page.getByTestId('signed-payload')).toBeVisible()
  await expect(page.getByTestId('sign-button')).toBeEnabled({ timeout: 5_000 })
  await page.getByTestId('sign-button').click()
  const token = page.getByTestId('l2-token')
  await expect(token).toBeVisible({ timeout: 30_000 })
  const value = await token.textContent()
  expect(value).not.toBeNull()
  return value ?? ''
}

test.describe('device-signed intent', () => {
  test.beforeEach(async ({ page }) => {
    await openLab(page)
  })

  test('AT-M5.1 stores a non-extractable private key', async ({ page }) => {
    const stored = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('countersign')
        request.onerror = () => {
          reject(request.error ?? new Error('Opening the keystore failed.'))
        }
        request.onsuccess = () => {
          resolve(request.result)
        }
      })

      try {
        const transaction = database.transaction('keys', 'readonly')
        const done = new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => {
            resolve()
          }
          transaction.onerror = () => {
            reject(transaction.error ?? new Error('The keystore transaction failed.'))
          }
          transaction.onabort = () => {
            reject(transaction.error ?? new Error('The keystore transaction aborted.'))
          }
        })
        const request = transaction.objectStore('keys').getAll()
        const values = await new Promise<unknown[]>((resolve, reject) => {
          request.onerror = () => {
            reject(request.error ?? new Error('Reading the keystore failed.'))
          }
          request.onsuccess = () => {
            resolve(request.result as unknown[])
          }
        })
        await done

        const first: unknown = values[0]
        const record =
          typeof first === 'object' && first !== null ? (first as { privateKey?: unknown }) : {}
        const key = record.privateKey
        if (!(key instanceof CryptoKey)) {
          throw new Error('The stored private key was not a CryptoKey.')
        }

        let exportError = 'none'
        try {
          await crypto.subtle.exportKey('jwk', key)
        } catch (cause) {
          exportError = cause instanceof Error ? cause.name : String(cause)
        }

        return { isCryptoKey: true, extractable: key.extractable, exportError }
      } finally {
        database.close()
      }
    })

    expect(stored).toEqual({
      isCryptoKey: true,
      extractable: false,
      exportError: 'InvalidAccessError',
    })
  })

  test('AT-M5.2 returns an L2 with four disclosures', async ({ page }) => {
    const token = await prepareAndSign(page)
    const separator = token.indexOf('~')
    expect(separator).toBeGreaterThan(0)

    const jws = token.slice(0, separator)
    const disclosures = token
      .slice(separator + 1)
      .split('~')
      .filter((part) => part.length > 0)

    expect(token.startsWith('eyJ')).toBe(true)
    expect(jws.split('.')).toHaveLength(3)
    expect(disclosures).toHaveLength(4)
  })

  test('AT-M5.3 reports a lost device key and can enrol again', async ({ page }) => {
    const originalKid = await page.getByTestId('device-kid').textContent()
    expect(originalKid).not.toBeNull()

    await page.getByTestId('prepare-button').click()
    await expect(page.getByTestId('signed-payload')).toBeVisible()
    await expect(page.getByTestId('sign-button')).toBeEnabled({ timeout: 5_000 })

    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('countersign')
        request.onerror = () => {
          reject(request.error ?? new Error('Deleting the keystore failed.'))
        }
        request.onsuccess = () => {
          resolve()
        }
      })
    })

    await page.getByTestId('sign-button').click()
    const lost = page.getByTestId('device-lost')
    await expect(lost).toBeVisible()
    await expect(lost).toContainText('This device is new')

    await page.getByRole('button', { name: 'Enrol this device' }).click()
    const kid = page.getByTestId('device-kid')
    await expect(kid).toBeVisible()
    await expect(kid).not.toHaveText(originalKid ?? '')
  })

  test('AT-M5.4 signs with a raw 64-byte P1363 signature', async ({ page }) => {
    await prepareAndSign(page)
    const signature = await page.getByTestId('signature-b64url').textContent()
    expect(signature).not.toBeNull()
    expect(Buffer.from(signature ?? '', 'base64url')).toHaveLength(64)
  })
})
