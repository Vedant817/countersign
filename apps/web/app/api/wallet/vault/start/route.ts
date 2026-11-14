import { NextResponse } from 'next/server'

import { requireBuyer } from '@/lib/auth'
import { paypalClient } from '@/lib/paypal-client'
import { startVault } from '@/lib/wallet-vault'

export async function POST(request: Request) {
  const buyer = await requireBuyer()
  if (!buyer.ok) {
    return NextResponse.json(
      {
        error: {
          code: buyer.error.code,
          message: buyer.error.userMessage ?? buyer.error.message,
        },
      },
      { status: buyer.error.code === 'CS_UNAUTHENTICATED' ? 401 : 403 },
    )
  }

  const client = paypalClient()
  if (!client.ok) {
    return NextResponse.json(
      {
        error: {
          code: client.error.code,
          message: client.error.userMessage ?? client.error.message,
        },
      },
      { status: 503 },
    )
  }

  const base = new URL(request.url).origin
  const r = await startVault(
    {
      userId: buyer.value.id,
      returnUrl: `${base}/api/wallet/vault/return`,
      cancelUrl: `${base}/api/wallet/vault/cancel`,
    },
    {
      createSetupToken: (b) => client.value.createSetupToken(b),
    },
  )

  if (!r.ok) {
    return NextResponse.json(
      {
        error: {
          code: r.error.code,
          message: r.error.userMessage ?? r.error.message,
        },
      },
      { status: r.error.retryable ? 503 : 502 },
    )
  }

  const response = NextResponse.redirect(r.value.approveUrl, 303)
  response.cookies.set('cs_vault_setup', r.value.setupTokenId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/wallet/vault',
    maxAge: 1800,
  })
  return response
}
