import { NextResponse } from 'next/server'

import { newId, type WalletId } from '@countersign/core'
import { upsertWalletByToken } from '@countersign/db'

import { requireBuyer } from '@/lib/auth'
import { safeNextPath } from '@/lib/next-path'
import { paypalClient } from '@/lib/paypal-client'
import { finishVault } from '@/lib/wallet-vault'

function getCookie(request: Request, name: string): string | undefined {
  if (
    'cookies' in request &&
    typeof (request as { cookies?: { get(n: string): { value: string } | undefined } }).cookies
      ?.get === 'function'
  ) {
    const val = (
      request as { cookies: { get(n: string): { value: string } | undefined } }
    ).cookies.get(name)?.value
    if (typeof val === 'string') return val
  }
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) {
      return decodeURIComponent(v.join('='))
    }
  }
  return undefined
}

function clearVaultCookie(response: NextResponse): NextResponse {
  response.cookies.set('cs_vault_setup', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/wallet/vault',
    maxAge: 0,
  })
  return response
}

function toVaultErrorCode(code: string): string {
  switch (code) {
    case 'CS_UNAUTHENTICATED':
      return 'unauthenticated'
    case 'CS_FORBIDDEN':
      return 'forbidden'
    case 'CS_VALIDATION':
      return 'missing_token'
    case 'CS_INTERNAL':
      return 'internal'
    default:
      if (code.startsWith('PP_') || code === 'CS_PAYPAL_UNCONFIGURED') {
        return 'paypal_error'
      }
      return 'internal'
  }
}

export async function GET(request: Request) {
  const base = new URL(request.url).origin

  const buyer = await requireBuyer()
  if (!buyer.ok) {
    if (buyer.error.code === 'CS_UNAUTHENTICATED') {
      const next = encodeURIComponent(safeNextPath('/wallet', '/wallet'))
      return clearVaultCookie(
        NextResponse.redirect(new URL(`/buyer-login?next=${next}`, base), 303),
      )
    }
    const code = toVaultErrorCode(buyer.error.code)
    return clearVaultCookie(
      NextResponse.redirect(new URL(`/wallet?vault_error=${code}`, base), 303),
    )
  }

  const url = new URL(request.url)
  const setupTokenId = url.searchParams.get('approval_token_id')
  if (!setupTokenId) {
    return clearVaultCookie(
      NextResponse.redirect(new URL('/wallet?vault_error=missing_token', base), 303),
    )
  }

  const expected = getCookie(request, 'cs_vault_setup')

  const client = paypalClient()
  if (!client.ok) {
    const code = toVaultErrorCode(client.error.code)
    return clearVaultCookie(
      NextResponse.redirect(new URL(`/wallet?vault_error=${code}`, base), 303),
    )
  }

  const r = await finishVault(
    {
      userId: buyer.value.id,
      setupTokenId,
      expectedSetupTokenId: expected,
    },
    {
      createPaymentToken: (id) => client.value.createPaymentToken(id),
      saveWallet: async (row) => {
        const w = await upsertWalletByToken({
          id: newId('wal') as WalletId,
          ...row,
          status: 'ACTIVE',
        })
        return w.ok ? { ok: true, value: { id: w.value.id } } : w
      },
    },
  )

  if (!r.ok) {
    const code = toVaultErrorCode(r.error.code)
    return clearVaultCookie(
      NextResponse.redirect(new URL(`/wallet?vault_error=${code}`, base), 303),
    )
  }

  return clearVaultCookie(NextResponse.redirect(new URL('/wallet?saved=1', base), 303))
}
