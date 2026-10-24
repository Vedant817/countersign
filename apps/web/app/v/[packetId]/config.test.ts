/**
 * The verifier page's configuration check — spec §6, EC-DSP-9.
 *
 * This is a regression test for a defect an independent review found in the running app: with
 * `PUBLIC_BASE_URL` unset, **every** `/v/<packetId>` request returned HTTP 500 with Next's generic
 * "a server error occurred", including `/v/not-a-packet`, which the spec says must be a 404
 * (EC-DSP-9). The cause was ordering — `verifierDeps()` threw from `requiredEnv` before the packet id
 * was validated — so the cases below pin the ordering and the state, not just the string.
 */
import { describe, expect, it } from 'vitest'

import { REQUIRED_VERIFIER_ENV, missingVerifierEnv, verifierUnavailableDetail } from './config'

const COMPLETE: Record<string, string> = {
  DATABASE_URL: 'postgres://u:p@db:5432/countersign',
  VI_SERVICE_URL: 'http://vi:8000',
  VI_SERVICE_TOKEN: 'a-token',
  PUBLIC_BASE_URL: 'https://countersign.example',
}

describe('the verifier page configuration check', () => {
  it('reports nothing missing for a complete environment', () => {
    expect(missingVerifierEnv(COMPLETE)).toEqual([])
    expect(verifierUnavailableDetail([])).toBe('')
  })

  it('names every absent variable, in declaration order', () => {
    const env = { ...COMPLETE }
    delete env['PUBLIC_BASE_URL']
    expect(missingVerifierEnv(env)).toEqual(['PUBLIC_BASE_URL'])

    expect(missingVerifierEnv({})).toEqual([...REQUIRED_VERIFIER_ENV])
  })

  it('treats a blank value as missing, because `FOO=` is how a variable looks set without being set', () => {
    expect(missingVerifierEnv({ ...COMPLETE, PUBLIC_BASE_URL: '   ' })).toEqual(['PUBLIC_BASE_URL'])
  })

  it('names variables only, never their values', () => {
    // A configuration page is a classic secret leak: `postgres://user:password@host` in a hint.
    const detail = verifierUnavailableDetail(missingVerifierEnv({}))
    expect(detail).toContain('DATABASE_URL')
    expect(detail).not.toContain('postgres://')
  })

  it('phrases one missing variable and several differently', () => {
    expect(verifierUnavailableDetail(['PUBLIC_BASE_URL'])).toContain('is unset')
    expect(verifierUnavailableDetail(['PUBLIC_BASE_URL', 'DATABASE_URL'])).toContain('are unset')
  })
})
