import { afterEach, describe, expect, it, vi } from 'vitest'
import { signingLabAllowed } from './vi'

afterEach(() => vi.unstubAllEnvs())

describe('sample signing isolation', () => {
  it('refuses an unconfigured lab, including on loopback', () => {
    vi.stubEnv('SIGNING_LAB_ENABLED', undefined)
    expect(signingLabAllowed(new Request('http://localhost:3000/lab/device-sign/prepare'))).toBe(
      false,
    )
  })

  it('refuses production even when explicitly enabled', () => {
    vi.stubEnv('SIGNING_LAB_ENABLED', 'true')
    vi.stubEnv('NODE_ENV', 'production')
    expect(signingLabAllowed(new Request('http://localhost:3000/lab/device-sign/prepare'))).toBe(
      false,
    )
  })

  it('permits an enabled local lab but refuses external hosts and cross-origin calls', () => {
    vi.stubEnv('SIGNING_LAB_ENABLED', 'true')
    vi.stubEnv('NODE_ENV', 'test')
    const url = 'http://localhost:3000/lab/device-sign/prepare'
    expect(
      signingLabAllowed(new Request(url, { headers: { origin: 'http://localhost:3000' } })),
    ).toBe(true)
    expect(
      signingLabAllowed(new Request(url, { headers: { origin: 'https://attacker.test' } })),
    ).toBe(false)
    expect(signingLabAllowed(new Request('https://public.example/lab/device-sign/prepare'))).toBe(
      false,
    )
  })
})
