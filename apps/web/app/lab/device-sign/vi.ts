/**
 * The signing lab's own identities and its gate.
 *
 * The vi client and its configuration live in `apps/web/lib/vi-client.ts`; this file is what is left when
 * the transport is removed — the sample identities, the sample item and wallet, and the one check that
 * keeps them out of a deployed application. `lib/agent-session.ts` no longer imports from here.
 */
export const USER_ID = 'usr_demo_user'
export const AGENT_ID = 'agt_lab_device_sign'
export const DEVICE_ID = 'dev_lab_device_sign'

// The merchant identity moved to `apps/web/lib/merchant.ts`. It used to live here, next to the sample
// wallet, and the production checkout route imported it from this file — a demo harness as the source of
// truth for the merchant named inside a merchant-signed JWT. The lab now reads the same
// configuration the shop does, so a mandate minted here allows the store that actually exists.
export const ITEM = { id: 'SKU-TRAIL-42', title: 'Trail Runner' } as const

export const WALLET = {
  payer_id: 'PAYER-LAB-1',
  payer_email: 'buyer@example.test',
  payment_token_id: 'PAYTOKEN-LAB-1',
} as const

/** Sample identities must never be issued by a publicly deployed application. */
export function signingLabAllowed(request: Request): boolean {
  if (process.env.SIGNING_LAB_ENABLED !== 'true' || process.env.NODE_ENV === 'production')
    return false
  const url = new URL(request.url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false
  const origin = request.headers.get('origin')
  return origin === null || origin === url.origin
}

const CLIENT_STATUS: Record<string, number> = {
  CS_VALIDATION: 400,
  CS_NOT_FOUND: 404,
  VI_SIGNATURE_MISMATCH: 400,
  VI_EXPIRED: 400,
  VI_NOT_YET_VALID: 400,
}

export function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

export function failureResponse(code: string, message: string): Response {
  return failure(CLIENT_STATUS[code] ?? 502, code, message)
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}
