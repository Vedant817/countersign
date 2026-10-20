import { z } from 'zod'

import {
  MISSING_CONFIG,
  createViClient,
  failure,
  failureResponse,
  readJson,
  readServiceConfig,
} from '../vi'

const requestSchema = z.strictObject({
  prepareId: z.string().min(1).max(128),
  signatureB64Url: z.string().min(1).max(512),
})

export async function POST(request: Request): Promise<Response> {
  const config = readServiceConfig()
  if (config === null) {
    return failure(500, 'CS_INTERNAL', MISSING_CONFIG)
  }

  const body = await readJson(request)
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return failure(400, 'CS_VALIDATION', 'The signature payload was not valid JSON.')
  }

  const client = createViClient(config)
  const finalized = await client.finalizeL2({
    prepare_id: parsed.data.prepareId,
    signature_b64url: parsed.data.signatureB64Url,
  })
  if (!finalized.ok) {
    return failureResponse(finalized.error.code, finalized.error.message)
  }

  return Response.json({
    l2: finalized.value.l2,
    iat: finalized.value.iat,
    exp: finalized.value.exp ?? null,
    agentKid: finalized.value.agent_kid,
  })
}
