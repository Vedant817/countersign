/**
 * `GET /api/disputes/demo/pdf?case=…` — the demo evidence packet download.
 *
 * Serves the same bytes the `/disputes` page described: `demoCasePdf` shares the per-process cache
 * with the page, so the packet a judge downloads is the packet the page hashed. `Content-Type` and
 * `Content-Disposition` make it a file; `Content-Length` comes from the bytes themselves.
 *
 * Guarded by the demo gate (`agentDemoAllowed`) — a deployed application does not serve fixture
 * evidence packets to strangers.
 */
import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

import { agentDemoAllowed } from '@/lib/agent-session'
import { demoCasePdf, type DefenderCaseId } from '@/lib/defender-demo'

const CASE_IDS: readonly DefenderCaseId[] = ['unauthorised', 'agent-fault']

function isCaseId(value: string): value is DefenderCaseId {
  return (CASE_IDS as readonly string[]).includes(value)
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!agentDemoAllowed()) {
    return NextResponse.json(
      { error: 'The Defender demo is off here: it needs COUNTERSIGN_AGENT_DEMO=1 and non-production.' },
      { status: 403 },
    )
  }
  const caseParam = new URL(request.url).searchParams.get('case') ?? ''
  if (!isCaseId(caseParam)) {
    return NextResponse.json(
      { error: `Unknown case "${caseParam}". Known cases: ${CASE_IDS.join(', ')}.` },
      { status: 400 },
    )
  }

  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const base =
    host !== null && host !== ''
      ? `${h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')}://${host}`
      : (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000')

  const pdf = await demoCasePdf(caseParam, base)
  if (pdf === null) {
    return NextResponse.json(
      { error: 'This case files nothing, so it has no packet. Only the unauthorised case renders one.' },
      { status: 404 },
    )
  }
  const body = pdf as Uint8Array
  return new NextResponse(body as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="countersign-packet-${caseParam}.pdf"`,
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    },
  })
}

export const dynamic = 'force-dynamic'
