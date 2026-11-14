import { csError, err, ok, type CsError, type Result } from '@countersign/core'
import {
  paymentTokenPayer,
  type PaymentToken,
  type SetupToken,
  type SetupTokenReq,
} from '@countersign/paypal'

export interface StartVaultInput {
  userId: string
  returnUrl: string
  cancelUrl: string
}

export interface StartVaultDeps {
  createSetupToken: (body: SetupTokenReq) => Promise<Result<SetupToken, CsError>>
}

export async function startVault(
  input: StartVaultInput,
  deps: StartVaultDeps,
): Promise<Result<{ setupTokenId: string; approveUrl: string }, CsError>> {
  // https://developer.paypal.com/docs/api/payment-tokens/v3/#setup-tokens_create
  const body: SetupTokenReq = {
    payment_source: {
      paypal: {
        description:
          'Countersign saves your PayPal account so purchases you pre-approve can be charged later.',
        permit_multiple_payment_tokens: false,
        usage_pattern: 'IMMEDIATE',
        usage_type: 'MERCHANT',
        customer_type: 'CONSUMER',
        experience_context: {
          brand_name: 'Countersign',
          locale: 'en-US',
          shipping_preference: 'NO_SHIPPING',
          payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      },
    },
  }

  const res = await deps.createSetupToken(body)
  if (!res.ok) {
    return res
  }

  const token = res.value
  const links = token.links ?? []
  const approveLink =
    links.find((l) => l.rel === 'approve') ?? links.find((l) => l.rel === 'payer-action')

  if (!approveLink?.href) {
    // PP_UNEXPECTED is not in CS_ERROR_CODES; using PP_UNAVAILABLE as the closest existing retryable PayPal error code.
    return err(
      csError(
        'PP_UNAVAILABLE',
        'PayPal returned no approval link for the setup token',
        { setupTokenId: token.id },
        {
          retryable: true,
          userMessage:
            'PayPal did not return an approval page. Nothing was saved. Please try again.',
        },
      ),
    )
  }

  return ok({
    setupTokenId: token.id,
    approveUrl: approveLink.href,
  })
}

export interface FinishVaultInput {
  userId: string
  setupTokenId: string
  expectedSetupTokenId: string | undefined
}

export interface FinishVaultDeps {
  createPaymentToken: (id: string) => Promise<Result<PaymentToken, CsError>>
  saveWallet: (row: {
    user_id: string
    payment_token_id: string
    payer_id: string
    payer_email: string
    customer_id: string | null
  }) => Promise<Result<{ id: string }, CsError>>
}

export async function finishVault(
  input: FinishVaultInput,
  deps: FinishVaultDeps,
): Promise<Result<{ walletId: string }, CsError>> {
  if (
    input.expectedSetupTokenId === undefined ||
    input.expectedSetupTokenId !== input.setupTokenId
  ) {
    return err(
      csError(
        'CS_VALIDATION',
        'Setup token does not match this session',
        {},
        {
          retryable: false,
          userMessage: 'This PayPal approval does not belong to your session. Nothing was saved.',
        },
      ),
    )
  }

  const tokenRes = await deps.createPaymentToken(input.setupTokenId)
  if (!tokenRes.ok) {
    return tokenRes
  }

  const token = tokenRes.value
  const payer = paymentTokenPayer(token)
  const payerId =
    (typeof payer?.payer_id === 'string' && payer.payer_id.trim() !== ''
      ? payer.payer_id
      : undefined) ??
    (typeof payer?.account_id === 'string' && payer.account_id.trim() !== ''
      ? payer.account_id
      : undefined)
  const payerEmail =
    typeof payer?.email_address === 'string' && payer.email_address.trim() !== ''
      ? payer.email_address
      : undefined

  if (!payerId || !payerEmail) {
    return err(
      csError(
        'CS_VALIDATION',
        'PayPal payment token has no payer id or email',
        {},
        { retryable: false },
      ),
    )
  }

  const saveRes = await deps.saveWallet({
    user_id: input.userId,
    payment_token_id: token.id,
    payer_id: payerId,
    payer_email: payerEmail,
    customer_id: token.customer?.id ?? null,
  })
  if (!saveRes.ok) {
    return saveRes
  }

  return ok({ walletId: saveRes.value.id })
}
