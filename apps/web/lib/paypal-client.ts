import 'server-only'

import { csError, err, ok, systemClock, type CsError, type Result } from '@countersign/core'
import { PayPalClient } from '@countersign/paypal'

import { resolvePaypalBase } from './paypal-base'

function paypalCreds(): { id: string; secret: string; base: string } {
  return {
    id: process.env['PAYPAL_CLIENT_ID']?.trim() ?? '',
    secret: process.env['PAYPAL_CLIENT_SECRET']?.trim() ?? '',
    base: resolvePaypalBase(),
  }
}

/**
 * Return a PayPalClient configured from the environment, without the agent demo gate.
 * Returns PP_UNAVAILABLE if credentials are not configured.
 */
export function paypalClient(): Result<PayPalClient, CsError> {
  const creds = paypalCreds()
  if (creds.id === '' || creds.secret === '') {
    return err(
      csError(
        'PP_UNAVAILABLE',
        'PayPal is not configured on this server.',
        {},
        {
          retryable: true,
          userMessage: 'PayPal is not configured on this server.',
        },
      ),
    )
  }

  return ok(
    new PayPalClient({
      baseUrl: creds.base,
      clientId: creds.id,
      clientSecret: creds.secret,
      clock: systemClock,
    }),
  )
}
