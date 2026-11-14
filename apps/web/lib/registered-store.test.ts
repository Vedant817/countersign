import { describe, expect, it } from 'vitest'

import { csError, type CsError, type Result } from '@countersign/core'

import { requireRegisteredStore } from './registered-store'

describe('requireRegisteredStore', () => {
  it('found row -> ok with merchantRowId', async () => {
    const fakeLookup = async (
      id: string,
    ): Promise<Result<{ id: string } | undefined, CsError>> => ({
      ok: true,
      value: { id: `mrc_row_${id}` },
    })

    const result = await requireRegisteredStore('mrc_northwind', fakeLookup)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ merchantRowId: 'mrc_row_mrc_northwind' })
    }
  })

  it('undefined -> ok:false, code CS_VALIDATION, message contains the id, retryable false', async () => {
    const fakeLookup = async (
      _id: string,
    ): Promise<Result<{ id: string } | undefined, CsError>> => ({
      ok: true,
      value: undefined,
    })

    const result = await requireRegisteredStore('mrc_unlinked', fakeLookup)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CS_VALIDATION')
      expect(result.error.message).toContain('mrc_unlinked')
      expect(result.error.retryable).toBe(false)
    }
  })

  it('lookup error -> the same error object is returned', async () => {
    const lookupError = csError('CS_INTERNAL', 'DB connection error')
    const fakeLookup = async (
      _id: string,
    ): Promise<Result<{ id: string } | undefined, CsError>> => ({
      ok: false,
      error: lookupError,
    })

    const result = await requireRegisteredStore('mrc_northwind', fakeLookup)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe(lookupError)
    }
  })
})
