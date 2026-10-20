import { publicJwkSchema } from '@countersign/vi-client'
import { z } from 'zod'

import {
  AGENT_AUDIENCE,
  AGENT_ID,
  DEVICE_ID,
  ITEM,
  MERCHANT,
  MISSING_CONFIG,
  USER_ID,
  WALLET,
  agentIssuer,
  createViClient,
  failure,
  failureResponse,
  readJson,
  readServiceConfig,
} from '../vi'

const requestSchema = z.strictObject({
  deviceKid: z.string().min(1).max(256),
  devicePublicJwk: publicJwkSchema,
})

export async function POST(request: Request): Promise<Response> {
  const config = readServiceConfig()
  if (config === null) {
    return failure(500, 'CS_INTERNAL', MISSING_CONFIG)
  }

  const body = await readJson(request)
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return failure(400, 'CS_VALIDATION', 'The device key payload was not valid JSON.')
  }

  const client = createViClient(config)

  const minted = await client.mintAgentKey({ agent_id: AGENT_ID })
  if (!minted.ok) {
    return failureResponse(minted.error.code, minted.error.message)
  }

  const agentKey = publicJwkSchema.safeParse(minted.value.public_jwk)
  if (!agentKey.success) {
    return failure(500, 'CS_INTERNAL', 'The vi-service returned an unusable agent key.')
  }

  const issued = await client.issueL1({
    user_id: USER_ID,
    wallet: WALLET,
    device_public_jwk: parsed.data.devicePublicJwk,
    device_kid: parsed.data.deviceKid,
  })
  if (!issued.ok) {
    return failureResponse(issued.error.code, issued.error.message)
  }

  const prepared = await client.prepareL2({
    l1: issued.value.l1,
    device_kid: parsed.data.deviceKid,
    agent_public_jwk: agentKey.data,
    agent_kid: minted.value.kid,
    checkout_constraints: [
      { type: 'mandate.checkout.allowed_merchants', allowed: [MERCHANT] },
      {
        type: 'mandate.checkout.line_items',
        items: [{ id: ITEM.id, acceptable_items: [ITEM], quantity: 1 }],
        match_mode: 'minimum',
      },
    ],
    payment_constraints: [
      { type: 'mandate.payment.amount_range', currency: 'USD', min: 0, max: 20_000 },
      { type: 'mandate.payment.budget', currency: 'USD', max: 20_000 },
    ],
    merchants: [MERCHANT],
    acceptable_items: [ITEM],
    payment_instrument: {
      type: 'paypal_vault',
      id: issued.value.card_id,
      description: 'PayPal ···· 0000',
    },
    nonce: crypto.randomUUID(),
    aud: AGENT_AUDIENCE,
    iss: agentIssuer(),
    device_id: DEVICE_ID,
    prompt_summary:
      'Buy one pair of Trail Runner shoes from Northwind Outfitters for up to USD 200.00.',
  })
  if (!prepared.ok) {
    return failureResponse(prepared.error.code, prepared.error.message)
  }

  return Response.json({
    prepareId: prepared.value.prepare_id,
    signingInput: prepared.value.signing_input,
    payload: prepared.value.payload,
    expiresAt: prepared.value.expires_at,
  })
}
