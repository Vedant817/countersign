import { describe, expect, it } from 'vitest'

import type { WalletRow } from '@countersign/db'

import { pickActiveWallet } from './active-wallet'

function makeWallet(overrides: Partial<WalletRow> = {}): WalletRow {
  return {
    id: 'wal_1' as WalletRow['id'],
    user_id: 'usr_1',
    payment_token_id: 'VAULT-TOKEN-1',
    payer_id: 'PAYER-1',
    payer_email: 'buyer@example.test',
    status: 'ACTIVE',
    customer_id: null,
    raw: null,
    fetched_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('pickActiveWallet', () => {
  it('returns undefined for an empty array', () => {
    expect(pickActiveWallet([])).toBeUndefined()
  })

  it('returns undefined when only a DEMO-NOT-A-VAULT-TOKEN-x wallet is present', () => {
    const demoWallet = makeWallet({
      payment_token_id: 'DEMO-NOT-A-VAULT-TOKEN-12345678',
    })
    expect(pickActiveWallet([demoWallet])).toBeUndefined()
  })

  it('ignores DELETED status wallet and returns undefined', () => {
    const deletedWallet = makeWallet({
      status: 'DELETED',
    })
    expect(pickActiveWallet([deletedWallet])).toBeUndefined()
  })

  it('returns the newer one by created_at when given two ACTIVE real wallets, even when it is second in the input', () => {
    const olderWallet = makeWallet({
      id: 'wal_older' as WalletRow['id'],
      payment_token_id: 'VAULT-TOKEN-OLDER',
      created_at: new Date('2026-01-01T10:00:00Z'),
    })
    const newerWallet = makeWallet({
      id: 'wal_newer' as WalletRow['id'],
      payment_token_id: 'VAULT-TOKEN-NEWER',
      created_at: new Date('2026-01-02T10:00:00Z'),
    })

    const result = pickActiveWallet([olderWallet, newerWallet])
    expect(result).toBe(newerWallet)
    expect(result?.id).toBe('wal_newer')
  })

  it('returns the real one when a DEMO wallet is newer than a real ACTIVE wallet', () => {
    const realWallet = makeWallet({
      id: 'wal_real' as WalletRow['id'],
      payment_token_id: 'VAULT-TOKEN-REAL',
      created_at: new Date('2026-01-01T10:00:00Z'),
    })
    const newerDemoWallet = makeWallet({
      id: 'wal_demo' as WalletRow['id'],
      payment_token_id: 'DEMO-NOT-A-VAULT-TOKEN-99999999',
      created_at: new Date('2026-01-02T10:00:00Z'),
    })

    const result = pickActiveWallet([newerDemoWallet, realWallet])
    expect(result).toBe(realWallet)
    expect(result?.id).toBe('wal_real')
  })
})
