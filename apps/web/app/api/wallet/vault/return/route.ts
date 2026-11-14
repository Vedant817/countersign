import { NextResponse } from 'next/server'

import { newId, type WalletId } from '@countersign/core'
import { upsertWalletByToken } from '@countersign/db'

import { requireBuyer } from '@/lib/auth'
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

export async function GET(request: Request) {
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

  const url = new URL(request.url)
  const setupTokenId = url.searchParams.get('approval_token_id')
  if (!setupTokenId) {
    return clearVaultCookie(
      NextResponse.json(
        {
          error: {
            code: 'CS_VALIDATION',
            message: 'Missing approval_token_id',
          },
        },
        { status: 400 },
      ),
    )
  }

  const expected = getCookie(request, 'cs_vault_setup')

  const client = paypalClient()
  if (!client.ok) {
    return clearVaultCookie(
      NextResponse.json(
        {
          error: {
            code: client.error.code,
            message: client.error.userMessage ?? client.error.message,
          },
        },
        { status: 503 },
      ),
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
    const status = r.error.code === 'CS_VALIDATION' ? 400 : 502
    return clearVaultCookie(
      NextResponse.json(
        {
          error: {
            code: r.error.code,
            message: r.error.userMessage ?? r.error.message,
          },
        },
        { status },
      ),
    )
  }

  const base = url.origin
  return clearVaultCookie(NextResponse.redirect(`${base}/?wallet=saved`, 303))
}
