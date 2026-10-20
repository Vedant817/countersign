import { NextResponse } from 'next/server'

import { createCheckout } from '@countersign/gate'

import { MERCHANT } from '../../lab/device-sign/vi'
import { shopCatalog } from '../catalog'
import { shopCheckout } from '../checkout-store'

const MAX_QTY = 1000

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

function productPath(sku: string, message: string): string {
  return `/shop/${encodeURIComponent(sku)}?error=${encodeURIComponent(message)}`
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData()
  const sku = field(form, 'sku').trim()

  if (sku === '') {
    return NextResponse.redirect(new URL('/shop', request.url), 303)
  }

  const qty = Number(field(form, 'qty') || '1')
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    return NextResponse.redirect(
      new URL(productPath(sku, `Pick a quantity between 1 and ${MAX_QTY}.`), request.url),
      303,
    )
  }

  const shipToCountry = field(form, 'shipToCountry').trim().toUpperCase() || 'US'
  const result = await createCheckout(
    { catalog: shopCatalog, checkout: shopCheckout },
    {
      merchantId: MERCHANT.id,
      merchantName: MERCHANT.name,
      merchantWebsite: MERCHANT.website,
      lines: [{ sku, qty }],
      shipToCountry,
      nowSec: Math.floor(Date.now() / 1000),
    },
  )

  if (!result.ok) {
    return NextResponse.redirect(
      new URL(productPath(sku, result.error.userMessage), request.url),
      303,
    )
  }

  return NextResponse.redirect(
    new URL(`/shop/checkout/${encodeURIComponent(result.value.checkoutId)}`, request.url),
    303,
  )
}
