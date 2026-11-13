import { describe, expect, it } from 'vitest'

import { requestOrigin, requireSameOrigin } from './same-origin'

const URL = 'http://localhost:3000/api/disputes/dsp_1/decision'

function request(input: { url?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(input.url ?? URL, { method: 'POST', headers: input.headers })
}

describe('requireSameOrigin', () => {
  it('allows a request with no Origin header, because a browser always sends one and curl never does', () => {
    expect(requireSameOrigin(request())).toBeNull()
  })

  it('allows a same-origin request', () => {
    expect(requireSameOrigin(request({ headers: { origin: 'http://localhost:3000' } }))).toBeNull()
  })

  it('refuses a cross-origin request and names both origins', () => {
    const refusal = requireSameOrigin(request({ headers: { origin: 'https://attacker.test' } }))
    expect(refusal?.code).toBe('CS_FORBIDDEN')
    expect(refusal?.message).toContain('https://attacker.test')
    expect(refusal?.message).toContain('http://localhost:3000')
  })

  it('refuses an opaque Origin, which is what a sandboxed frame sends', () => {
    expect(requireSameOrigin(request({ headers: { origin: 'null' } }))?.code).toBe('CS_FORBIDDEN')
  })

  it('refuses a different port, because a sibling service on another port is not this deployment', () => {
    expect(requireSameOrigin(request({ headers: { origin: 'http://localhost:4000' } }))?.code).toBe(
      'CS_FORBIDDEN',
    )
  })
})

describe('requestOrigin', () => {
  it('prefers the proxy headers the rest of the app uses', () => {
    const r = request({
      url: 'http://internal:8080/api/x',
      headers: {
        host: 'internal:8080',
        'x-forwarded-host': 'public.example',
        'x-forwarded-proto': 'https',
      },
    })
    expect(requestOrigin(r)).toBe('https://public.example')
  })

  it('falls back to the request URL, with http on loopback and https otherwise', () => {
    expect(requestOrigin(request())).toBe('http://localhost:3000')
    expect(requestOrigin(request({ url: 'https://public.example/api/x' }))).toBe(
      'https://public.example',
    )
  })

  it('uses the first protocol when a proxy forwards a list', () => {
    const r = request({ headers: { 'x-forwarded-proto': 'https, http' } })
    expect(requestOrigin(r)).toBe('https://localhost:3000')
  })
})
