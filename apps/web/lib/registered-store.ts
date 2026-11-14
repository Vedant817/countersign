import { csError, type CsError, type Result } from '@countersign/core'

/**
 * Confirm that a store's configured PayPal merchant ID belongs to a registered merchant row in the database.
 *
 * Failing early here prevents creating a checkout session and running the Gate for a store that cannot
 * be paid later when createOrder verifies payee registration.
 */
export async function requireRegisteredStore(
  paypalMerchantId: string,
  lookup: (id: string) => Promise<Result<{ id: string } | undefined, CsError>>,
): Promise<Result<{ merchantRowId: string }, CsError>> {
  const result = await lookup(paypalMerchantId)
  if (!result.ok) {
    return result
  }
  if (!result.value) {
    return {
      ok: false,
      error: csError(
        'CS_VALIDATION',
        `No registered merchant has linked PayPal merchant ID ${paypalMerchantId}`,
        { paypalMerchantId },
        {
          userMessage:
            'This store has not finished setting up payments, so it cannot take orders yet. Nothing was charged.',
          retryable: false,
        },
      ),
    }
  }
  return {
    ok: true,
    value: { merchantRowId: result.value.id },
  }
}
