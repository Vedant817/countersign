/**
 * Provider and cross-border disclosure — EC-PRIV-4 and EC-PRIV-6, spec §12.13.
 *
 * Both rows are about telling the truth in prose rather than about a mechanism, which is exactly why
 * they need to live in code. A privacy statement maintained in a CMS drifts from what the system
 * actually sends, and the drift is always in the flattering direction: the page keeps saying "we never
 * send personal data to the model" long after someone added a customer name to a prompt.
 *
 * So the statement is derived from the same facts the code enforces:
 *
 *  - {@link LLM_PROMPT_ALLOWED_FIELDS} is the list the compiler and the agent may put in a prompt,
 *    and {@link assertPromptIsClean} is what makes a violation a test failure rather than a policy
 *    nobody reads.
 *  - {@link CROSS_BORDER} names the region the deployment actually runs in, and
 *    {@link renderPrivacyStatement} interpolates it, so moving the deployment without editing the
 *    page is impossible.
 */
import { csError, type CsError } from '@countersign/core'

/** Where the demo deployment runs, and therefore where personal data is processed. */
export const DEPLOYMENT_REGION = 'Singapore' as const

/**
 * EC-PRIV-4: the fields a prompt may contain.
 *
 * Deliberately a list of *product and instruction* fields only. A buyer's name, email, address or
 * payer id is not on it, so the compiler can describe what to buy without describing who is buying —
 * and the intent text the user typed is carried separately, because it is their own instruction and
 * they are told it is sent.
 */
export const LLM_PROMPT_ALLOWED_FIELDS = [
  'intent_text',
  'product_title',
  'product_sku',
  'product_price_minor',
  'product_currency',
  'merchant_name',
  'constraint_type',
] as const

export type LlmPromptField = (typeof LLM_PROMPT_ALLOWED_FIELDS)[number]

/** What the privacy page says about the model providers. Rendered, not stored in a CMS. */
export const LLM_DATA_STATEMENT = [
  'We send the instruction you typed, plus product and price details, to our model provider.',
  'We do not send your name, email, address, phone number, payer id or payment token.',
  'Provider API data is not used to train third-party models under the API terms we use, and we',
  'retain prompts and outputs for 30 days for debugging, then only their hashes.',
].join(' ')

export interface CrossBorderDisclosure {
  readonly region: string
  readonly statement: string
}

/**
 * EC-PRIV-6: an India user on US-region hosting is a cross-border transfer under DPDP, so the notice
 * has to say where the data goes and on what basis.
 */
export const CROSS_BORDER: CrossBorderDisclosure = {
  region: DEPLOYMENT_REGION,
  statement:
    `Your data is processed and stored in ${DEPLOYMENT_REGION}. If you are in India, this is a ` +
    'cross-border transfer: it happens under your consent to this notice, and we keep the transfer ' +
    'record so you can ask what moved and when.',
}

/** PII shapes that must never appear in a prompt, regardless of who built the string. */
const FORBIDDEN_IN_PROMPT: { readonly name: string; readonly re: RegExp }[] = [
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: 'card', re: /\b\d(?:[ -]?\d){12,18}\b/ },
  { name: 'phone', re: /\+?\d(?:[ -]?\d){8,14}\b/ },
  { name: 'paypal_payer_id', re: /\b[A-Z0-9]{13}\b/ },
  { name: 'vault_token', re: /\b(?:PAYTOKEN|PAYID|BA)-[A-Za-z0-9-]{6,}\b/ },
]

export interface PromptViolation {
  readonly field: string
  readonly reason: string
}

/**
 * Check a fully-built prompt before it is sent.
 *
 * Two independent failures are possible and both are reported: a **field name** that is not on the
 * allow-list (a caller added `payer_email` to a template), and a **value** that looks like PII inside
 * an allowed field (a merchant name that is an email address). The second is the one that survives
 * code review, because the template looks right.
 *
 * At most **one** value reason is reported per field, taken from the narrowest pattern that matches.
 * A card number also matches the phone shape, and listing both would train a reader to skim the
 * output — the same reason a validation error names one problem per field and not every rule it broke.
 */
export function assertPromptIsClean(prompt: Record<string, unknown>): readonly PromptViolation[] {
  const violations: PromptViolation[] = []

  for (const [key, value] of Object.entries(prompt)) {
    if (!(LLM_PROMPT_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      violations.push({ field: key, reason: `"${key}" is not an allowed prompt field (EC-PRIV-4)` })
      continue
    }
    if (typeof value !== 'string') continue
    for (const pattern of FORBIDDEN_IN_PROMPT) {
      if (pattern.re.test(value)) {
        violations.push({
          field: key,
          reason: `"${key}" looks like a ${pattern.name}; prompts carry products, not people (EC-PRIV-4)`,
        })
        break
      }
    }
  }

  return violations
}

/** The `CsError` for a prompt that must not be sent. */
export function promptRejectedError(violations: readonly PromptViolation[]): CsError {
  return csError(
    'CS_VALIDATION',
    `Refusing to send a prompt with ${violations.length} personal-data problem(s) (EC-PRIV-4)`,
    { violations: violations.map((v) => ({ field: v.field, reason: v.reason })) },
  )
}

/** The whole statement, as the privacy page renders it. Kept in one function so the page is one call. */
export function renderPrivacyStatement(): { readonly paragraphs: readonly string[] } {
  return {
    paragraphs: [
      LLM_DATA_STATEMENT,
      CROSS_BORDER.statement,
      'Operational logs are kept for 365 days under DPDP Rule 8(3) and are PII-redacted at write time.',
      'Mandates, gate decisions and evidence packets are kept for 540 days after your last purchase, ' +
        'because a dispute can be raised that late.',
      'You can export everything we hold and ask us to erase it; this package is what decides when ' +
        'that is allowed and what we tell you.',
    ],
  }
}
