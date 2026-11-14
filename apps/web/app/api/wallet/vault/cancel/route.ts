import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const base = new URL(request.url).origin
  const response = NextResponse.redirect(`${base}/?wallet=cancelled`, 303)
  response.cookies.set('cs_vault_setup', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/wallet/vault',
    maxAge: 0,
  })
  return response
}
