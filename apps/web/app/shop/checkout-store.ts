import 'server-only'

import { csError, err, ok } from '@countersign/core'
import { findOrderByAttempt } from '@countersign/db'
import type { MerchantCheckoutStore } from '@countersign/gate'

import { MISSING_CONFIG, createViClient, readServiceConfig } from '../lab/device-sign/vi'
import { shopCatalogMode, shopPersistenceError } from './catalog'

type CheckoutJwtRequest = Parameters<MerchantCheckoutStore['createCheckoutJwt']>[0]
type CheckoutJwtResult = ReturnType<MerchantCheckoutStore['createCheckoutJwt']>
type OrderLookup = ReturnType<MerchantCheckoutStore['findOrderByAttempt']>

export const shopCheckout: MerchantCheckoutStore = {
  createCheckoutJwt(request: CheckoutJwtRequest): CheckoutJwtResult {
    if (shopCatalogMode() !== 'database') {
      return Promise.resolve(err(shopPersistenceError()))
    }
    const config = readServiceConfig()
    if (config === null) {
      return Promise.resolve(err(csError('CS_INTERNAL', MISSING_CONFIG)))
    }
    return createViClient(config).createCheckoutJwt({
      merchant: request.merchant,
      lines: request.lines.map((line) => ({ ...line })),
      shipping_minor: request.shipping_minor,
      tax_minor: request.tax_minor,
      currency: request.currency,
      ttl_seconds: request.ttl_seconds,
      checkout_id: request.checkout_id,
    })
  },
  async findOrderByAttempt(attemptId: string): OrderLookup {
    if (shopCatalogMode() !== 'database') return err(shopPersistenceError())
    const found = await findOrderByAttempt(attemptId)
    if (!found.ok) return found
    if (found.value === undefined) return ok(undefined)
    const row = found.value
    return ok({
      id: row.id,
      status: row.status,
      amountMinor: row.amount_minor,
      currency: row.currency,
    })
  },
}
