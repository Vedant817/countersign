/** Throwaway: find which field PayPal's sandbox rejects on POST /v2/checkout/orders. */
import { readFileSync } from 'node:fs'

function envLocal(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    env[t.slice(0, eq).trim()] = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return { ...process.env, ...env } as Record<string, string>
}

const env = envLocal()
const base = env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com'
const basic = Buffer.from(`${env['PAYPAL_CLIENT_ID']}:${env['PAYPAL_CLIENT_SECRET']}`).toString(
  'base64',
)

const tokenResponse = await fetch(`${base}/v1/oauth2/token`, {
  method: 'POST',
  headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
})
const token = ((await tokenResponse.json()) as { access_token?: string }).access_token
console.log('token', token === undefined ? 'FAILED' : 'ok')

const variants: Record<string, unknown>[] = [
  {
    intent: 'AUTHORIZE',
    purchase_units: [{ amount: { currency_code: 'USD', value: '133.00' } }],
  },
  {
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        reference_id: 'default',
        description: 'Northwind Outfitters — Countersign acceptance',
        amount: { currency_code: 'USD', value: '133.00' },
        custom_id: 'cs1:gdc_01M5QWDKGZ53QGC81RCD6ES9GV',
        invoice_id: `acc_${Date.now()}`,
      },
    ],
  },
  {
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        amount: { currency_code: 'USD', value: '133.00' },
        payee: { merchant_id: env['PAYPAL_MERCHANT_ID'] },
      },
    ],
  },
]

for (const [index, body] of variants.entries()) {
  const response = await fetch(`${base}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'PayPal-Request-Id': `probe-${Date.now()}-${index}`,
    },
    body: JSON.stringify(body),
  })
  const json = (await response.json()) as {
    id?: string
    status?: string
    name?: string
    details?: unknown
  }
  console.log(
    `variant ${index}: ${response.status}`,
    json.id ?? json.name,
    JSON.stringify(json.details ?? '').slice(0, 220),
  )
}
