import { describe, expect, it, vi } from 'vitest'

import { csError, err, ok } from '@countersign/core'
import type { PaymentToken, SetupToken, SetupTokenReq } from '@countersign/paypal'

import { finishVault, startVault } from './wallet-vault'

describe('wallet-vault', () => {
  describe('startVault', () => {
    it('sends usage_type MERCHANT and the given return/cancel URLs and returns the approve href', async () => {
      let capturedBody: SetupTokenReq | undefined
      const createSetupToken = vi.fn(async (body: SetupTokenReq) => {
        capturedBody = body
        const token: SetupToken = {
          id: 'setup-tok-123',
          links: [
            {
              rel: 'self',
              href: 'https://api.sandbox.paypal.com/v3/vault/setup-tokens/setup-tok-123',
            },
            {
              rel: 'approve',
              href: 'https://www.sandbox.paypal.com/checkoutnow?token=setup-tok-123',
            },
          ],
        }
        return ok(token)
      })

      const res = await startVault(
        {
          userId: 'usr_test_1',
          returnUrl: 'https://countersign.test/vault/return',
          cancelUrl: 'https://countersign.test/vault/cancel',
        },
        { createSetupToken },
      )

      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('Expected ok')
      expect(res.value).toEqual({
        setupTokenId: 'setup-tok-123',
        approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=setup-tok-123',
      })
      expect(createSetupToken).toHaveBeenCalledTimes(1)

      const paypal = capturedBody?.payment_source?.paypal as Record<string, unknown> | undefined
      expect(paypal).toBeDefined()
      expect(paypal?.['usage_type']).toBe('MERCHANT')
      expect(paypal?.['usage_pattern']).toBe('IMMEDIATE')

      const expContext = paypal?.['experience_context'] as Record<string, unknown> | undefined
      expect(expContext).toBeDefined()
      expect(expContext?.['return_url']).toBe('https://countersign.test/vault/return')
      expect(expContext?.['cancel_url']).toBe('https://countersign.test/vault/cancel')
      expect(expContext?.['shipping_preference']).toBe('NO_SHIPPING')
      expect(expContext?.['vault_instruction']).toBe('ON_PAYER_APPROVAL')
    })

    it('with only a payer-action link uses it', async () => {
      const createSetupToken = vi.fn(async () => {
        const token: SetupToken = {
          id: 'setup-tok-456',
          links: [
            {
              rel: 'payer-action',
              href: 'https://www.sandbox.paypal.com/payer-action?token=setup-tok-456',
            },
          ],
        }
        return ok(token)
      })

      const res = await startVault(
        {
          userId: 'usr_test_1',
          returnUrl: 'https://countersign.test/vault/return',
          cancelUrl: 'https://countersign.test/vault/cancel',
        },
        { createSetupToken },
      )

      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('Expected ok')
      expect(res.value).toEqual({
        setupTokenId: 'setup-tok-456',
        approveUrl: 'https://www.sandbox.paypal.com/payer-action?token=setup-tok-456',
      })
    })

    it('with no approve link -> ok:false, retryable true', async () => {
      const createSetupToken = vi.fn(async () => {
        const token: SetupToken = {
          id: 'setup-tok-789',
          links: [
            {
              rel: 'self',
              href: 'https://api.sandbox.paypal.com/v3/vault/setup-tokens/setup-tok-789',
            },
          ],
        }
        return ok(token)
      })

      const res = await startVault(
        {
          userId: 'usr_test_1',
          returnUrl: 'https://countersign.test/vault/return',
          cancelUrl: 'https://countersign.test/vault/cancel',
        },
        { createSetupToken },
      )

      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('Expected error')
      expect(res.error.retryable).toBe(true)
      expect(res.error.code).toBe('PP_UNAVAILABLE')
      expect(res.error.details).toEqual({ setupTokenId: 'setup-tok-789' })
      expect(res.error.userMessage).toBe(
        'PayPal did not return an approval page. Nothing was saved. Please try again.',
      )
    })

    it('passes a createSetupToken error through unchanged (same object)', async () => {
      const upstreamError = csError('PP_AUTH', 'OAuth token failed')
      const createSetupToken = vi.fn(async () => err(upstreamError))

      const res = await startVault(
        {
          userId: 'usr_test_1',
          returnUrl: 'https://countersign.test/vault/return',
          cancelUrl: 'https://countersign.test/vault/cancel',
        },
        { createSetupToken },
      )

      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('Expected error')
      expect(res.error).toBe(upstreamError)
    })
  })

  describe('finishVault', () => {
    it('with mismatched expectedSetupTokenId -> CS_VALIDATION and createPaymentToken NOT called', async () => {
      const createPaymentToken = vi.fn()
      const saveWallet = vi.fn()

      const res = await finishVault(
        {
          userId: 'usr_test_1',
          setupTokenId: 'setup-tok-123',
          expectedSetupTokenId: 'setup-tok-mismatch',
        },
        { createPaymentToken, saveWallet },
      )

      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('Expected error')
      expect(res.error.code).toBe('CS_VALIDATION')
      expect(res.error.message).toBe('Setup token does not match this session')
      expect(res.error.retryable).toBe(false)
      expect(res.error.userMessage).toBe(
        'This PayPal approval does not belong to your session. Nothing was saved.',
      )
      expect(createPaymentToken).not.toHaveBeenCalled()
      expect(saveWallet).not.toHaveBeenCalled()
    })

    it('with undefined expectedSetupTokenId -> CS_VALIDATION and createPaymentToken NOT called', async () => {
      const createPaymentToken = vi.fn()
      const saveWallet = vi.fn()

      const res = await finishVault(
        {
          userId: 'usr_test_1',
          setupTokenId: 'setup-tok-123',
          expectedSetupTokenId: undefined,
        },
        { createPaymentToken, saveWallet },
      )

      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('Expected error')
      expect(res.error.code).toBe('CS_VALIDATION')
      expect(res.error.message).toBe('Setup token does not match this session')
      expect(res.error.retryable).toBe(false)
      expect(createPaymentToken).not.toHaveBeenCalled()
      expect(saveWallet).not.toHaveBeenCalled()
    })

    it('happy path -> saveWallet called once with the exact row (payer from payment_source.paypal) and returns walletId', async () => {
      const paymentToken: PaymentToken = {
        id: 'pay-tok-555',
        customer: { id: 'cust-999' },
        payment_source: {
          paypal: {
            payer_id: 'PAYER_ACC_123',
            email_address: 'buyer@example.com',
          },
        },
      }
      const createPaymentToken = vi.fn(async () => ok(paymentToken))
      const saveWallet = vi.fn(async () => ok({ id: 'wal_abc_123' }))

      const res = await finishVault(
        {
          userId: 'usr_test_1',
          setupTokenId: 'setup-tok-123',
          expectedSetupTokenId: 'setup-tok-123',
        },
        { createPaymentToken, saveWallet },
      )

      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('Expected ok')
      expect(res.value).toEqual({ walletId: 'wal_abc_123' })

      expect(createPaymentToken).toHaveBeenCalledTimes(1)
      expect(createPaymentToken).toHaveBeenCalledWith('setup-tok-123')

      expect(saveWallet).toHaveBeenCalledTimes(1)
      expect(saveWallet).toHaveBeenCalledWith({
        user_id: 'usr_test_1',
        payment_token_id: 'pay-tok-555',
        payer_id: 'PAYER_ACC_123',
        payer_email: 'buyer@example.com',
        customer_id: 'cust-999',
      })
    })

    it('when token has no payer email -> ok:false and saveWallet NOT called', async () => {
      const paymentToken: PaymentToken = {
        id: 'pay-tok-555',
        customer: { id: 'cust-999' },
        payment_source: {
          paypal: {
            payer_id: 'PAYER_ACC_123',
            // missing email_address
          },
        },
      }
      const createPaymentToken = vi.fn(async () => ok(paymentToken))
      const saveWallet = vi.fn()

      const res = await finishVault(
        {
          userId: 'usr_test_1',
          setupTokenId: 'setup-tok-123',
          expectedSetupTokenId: 'setup-tok-123',
        },
        { createPaymentToken, saveWallet },
      )

      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('Expected error')
      expect(res.error.code).toBe('CS_VALIDATION')
      expect(res.error.message).toBe('PayPal payment token has no payer id or email')
      expect(res.error.retryable).toBe(false)
      expect(saveWallet).not.toHaveBeenCalled()
    })

    it('passes a createPaymentToken error through unchanged', async () => {
      const upstreamError = csError('PP_UNAVAILABLE', 'PayPal service unavailable')
      const createPaymentToken = vi.fn(async () => err(upstreamError))
      const saveWallet = vi.fn()

      const res = await finishVault(
        {
          userId: 'usr_test_1',
          setupTokenId: 'setup-tok-123',
          expectedSetupTokenId: 'setup-tok-123',
        },
        { createPaymentToken, saveWallet },
      )

      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('Expected error')
      expect(res.error).toBe(upstreamError)
      expect(saveWallet).not.toHaveBeenCalled()
    })
  })
})
