import { NextResponse } from 'next/server'

import { createCheckout } from '@countersign/gate'
import { csError } from '@countersign/core'
import { DELIVERY_COUNTRIES } from '@/lib/delivery'

import { MERCHANT } from '../../lab/device-sign/vi'
import { shopCatalog } from '../catalog'
import { shopCheckout } from '../checkout-store'

const MAX_QTY = 1000

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

function productPath(sku: string, message: string, qty: string, country: string): string {
  const query = new URLSearchParams({ error: message, qty, country })
  return `/shop/${encodeURIComponent(sku)}?${query}`
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)(;|$)/i.test(contentType)) {
    return Response.json(
      { error: csError('CS_VALIDATION', 'A checkout form is required.') },
      { status: 415 },
    )
  }
  if (Number(request.headers.get('content-length')) > 65_536) {
    return Response.json(
      { error: csError('CS_VALIDATION', 'The checkout form is too large.') },
      { status: 413 },
    )
  }
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return Response.json(
      { error: csError('CS_VALIDATION', 'The checkout form could not be read.') },
      { status: 400 },
    )
  }
  const sku = field(form, 'sku').trim()

  if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(sku)) {
    return NextResponse.redirect(new URL('/shop', request.url), 303)
  }

  const rawQty = field(form, 'qty').trim()
  const requestedCountry = field(form, 'shipToCountry').trim().toUpperCase()
  const qty = Number(rawQty)
  if (!/^\d{1,4}$/.test(rawQty) || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    return NextResponse.redirect(
      new URL(
        productPath(
          sku,
          `Pick a quantity between 1 and ${MAX_QTY}.`,
          rawQty.slice(0, 4),
          requestedCountry.slice(0, 2),
        ),
        request.url,
      ),
      303,
    )
  }

  const found = await shopCatalog.findProductBySku(sku)
  if (!found.ok || found.value === undefined) {
    return Response.json(
      { error: csError('CS_NOT_FOUND', 'This product is unavailable.') },
      { status: 404 },
    )
  }
  const shipToCountry = found.value.digital ? 'ZZ' : requestedCountry
  if (!found.value.digital && !DELIVERY_COUNTRIES.includes(shipToCountry)) {
    return NextResponse.redirect(
      new URL(productPath(sku, 'Choose a supported delivery country.', rawQty, ''), request.url),
      303,
    )
  }
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
      new URL(productPath(sku, result.error.userMessage, rawQty, shipToCountry), request.url),
      303,
    )
  }

  return NextResponse.redirect(
    new URL(
      `/shop/checkout/${encodeURIComponent(result.value.checkoutId)}?country=${encodeURIComponent(shipToCountry)}`,
      request.url,
    ),
    303,
  )
}
