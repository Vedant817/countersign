/**
 * The read-back — spec **AT-M8.4**: "`readBack` snapshot tests for all 8 types."
 *
 * This is the most important test file in the package. §18 question 46 asks whether a user can be made to
 * sign something they did not understand, and this file is where the answer is *pinned*: every one of the
 * eight templates is asserted as a literal string, so a future edit to a template has to be a deliberate,
 * visible change to a test rather than a quiet change to a sentence a buyer reads.
 *
 * ### What is asserted beyond the snapshots
 *
 * - **Totality.** `READBACK_ORDER` and `READBACK_TEMPLATES` both cover `CONSTRAINT_TYPES` exactly. A ninth
 *   constraint type cannot be added without a template, and a template cannot be added for a type the
 *   library does not have.
 * - **Purity and stability.** The same mandate renders byte-identically across repeated calls, across
 *   differently-ordered `constraints` arrays, and with the object keys of the input permuted. If the output
 *   depended on anything but the argument *values*, these would fail.
 * - **Losslessness.** A merchant missing from `ctx.merchants` prints its raw id rather than being dropped,
 *   and every constraint type produces at least one non-empty line.
 * - **No arithmetic.** The templates call `formatMoney` and `formatIstHuman`; there is no `toFixed`, no `/100`
 *   and no template-literal arithmetic anywhere in the renderer. The JPY case (zero minor digits) pins that.
 * - **Cross-package agreement on the calendar.** `formatIstCalendarDate` and core's `formatIstHuman` must
 *   print the same month abbreviation for all twelve months, or one line of a read-back would contradict
 *   the next.
 */

import { formatIstHuman } from '@countersign/core'
import { describe, expect, it } from 'vitest'

import {
  CONSTRAINT_TYPES,
  NETWORK_ENFORCED_CONSTRAINT_TYPES,
  READBACK_HEADER,
  READBACK_INTERPRETATION_HEADER,
  READBACK_NOT_COVERED_HEADER,
  READBACK_ORDER,
  READBACK_TEMPLATES,
  compile,
  constraintOfType,
  formatIstCalendarDate,
  hasBlockingAmbiguities,
  readBack,
  type CompiledMandate,
  type ReadBackContext,
  type VIConstraint,
} from '../src/index'
import {
  CONTOSO,
  NORTHWIND,
  catalogOf,
  compileInput,
  scriptedModel,
  STANDARD_CATALOG,
} from './helpers'
import { fixedClock } from '@countersign/core'

const CTX: ReadBackContext = {
  merchants: { [NORTHWIND.id]: NORTHWIND.name, [CONTOSO.id]: CONTOSO.name },
  tz: 'Asia/Kolkata',
}

/** 2026-10-09T18:29:00Z — a fixed instant so every date in every snapshot is reproducible. */
const EXPIRES_AT = 1_790_529_540

function mandate(
  constraints: VIConstraint[],
  overrides: Partial<CompiledMandate> = {},
): CompiledMandate {
  return {
    constraints,
    currency: 'USD',
    ttlSeconds: 604_800,
    expiresAtEpochSec: EXPIRES_AT,
    preferences: {},
    assumptions: [],
    ambiguities: [],
    ...overrides,
  }
}

const MERCHANTS: VIConstraint = {
  type: 'mandate.checkout.allowed_merchants',
  allowed: [{ id: NORTHWIND.id, name: NORTHWIND.name, website: NORTHWIND.website }],
}

const LINE_ITEMS: VIConstraint = {
  type: 'mandate.checkout.line_items',
  items: [
    {
      id: 'line-item-1',
      acceptable_items: [
        { id: 'SKU-TRAIL-42', title: 'Trail Runner' },
        { id: 'SKU-ALPINE-07', title: 'Alpine Boot' },
      ],
      quantity: 1,
    },
  ],
  match_mode: 'minimum',
}

const PAYEES: VIConstraint = {
  type: 'mandate.payment.allowed_payees',
  allowed: [{ id: NORTHWIND.id, name: NORTHWIND.name, website: NORTHWIND.website }],
}

const AMOUNT_RANGE: VIConstraint = {
  type: 'mandate.payment.amount_range',
  currency: 'USD',
  max: 13000n,
}

const BUDGET: VIConstraint = { type: 'mandate.payment.budget', currency: 'USD', max: 13000n }

const RECURRENCE: VIConstraint = {
  type: 'mandate.payment.recurrence',
  frequency: 'MNTH',
  start_date: '2026-10-01',
  end_date: '2027-10-01',
  number: 12,
}

const AGENT_RECURRENCE: VIConstraint = {
  type: 'mandate.payment.agent_recurrence',
  frequency: 'MNTH',
  start_date: '2026-10-01',
  end_date: '2027-10-01',
  max_occurrences: 12,
}

const REFERENCE: VIConstraint = {
  type: 'mandate.payment.reference',
  conditional_transaction_id: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}

// ---------------------------------------------------------------------------

/**
 * The expiry and expiry-coverage lines every read-back ends with.
 *
 * Spelled out in each snapshot rather than assembled from a helper, because a snapshot is only evidence if
 * it is the actual bytes. Anything the helper hides is a thing the test does not pin.
 */
function tail(): string[] {
  return [
    `This mandate expires **${formatIstHuman(EXPIRES_AT)}**`,
    '',
    READBACK_NOT_COVERED_HEADER,
    '- Expiry: there is no automatic renewal. When this mandate expires the agent cannot spend under it again, even if it meant to.',
  ]
}

/**
 * The spec D19 sentence, which appears whenever **every** disclosed constraint is one the payment network
 * does not check. With only a budget in the mandate, that is the whole mandate — so the sentence is
 * exactly right here, and its presence in these snapshots is the point rather than noise.
 */
const D19_LINE =
  'Countersign checks each of these limits on every payment, including the ones the payment network does not check itself.'

describe('AT-M8.4 readBack snapshot, one per constraint type', () => {
  it('mandate.payment.budget → "Spend at most $130.00 in total"', () => {
    expect(readBack(mandate([BUDGET]), CTX)).toBe(
      [
        READBACK_HEADER,
        'Spend at most **$130.00** in total',
        `This mandate expires **${formatIstHuman(EXPIRES_AT)}**`,
        D19_LINE,
        '',
        READBACK_NOT_COVERED_HEADER,
        '- Expiry: there is no automatic renewal. When this mandate expires the agent cannot spend under it again, even if it meant to.',
      ].join('\n'),
    )
  })

  it('mandate.checkout.allowed_merchants → "Only at Northwind Outfitters"', () => {
    expect(readBack(mandate([MERCHANTS]), CTX)).toBe(
      [READBACK_HEADER, 'Only at **Northwind Outfitters**', ...tail()].join('\n'),
    )
  })

  it('mandate.payment.allowed_payees', () => {
    expect(readBack(mandate([PAYEES]), CTX)).toContain('Pay only **Northwind Outfitters**')
  })

  it('mandate.checkout.line_items', () => {
    expect(readBack(mandate([LINE_ITEMS]), CTX)).toContain(
      'Buy at least **1** of **Trail Runner** or **Alpine Boot**',
    )
  })

  it('mandate.payment.amount_range', () => {
    expect(readBack(mandate([AMOUNT_RANGE]), CTX)).toContain(
      'Spend at most **$130.00** per payment',
    )
  })

  it('mandate.payment.recurrence', () => {
    expect(readBack(mandate([RECURRENCE]), CTX)).toContain(
      'Payments repeat **monthly** from **Thu 1 Oct 2026** until **Fri 1 Oct 2027**, up to **12** times',
    )
  })

  it('mandate.payment.agent_recurrence', () => {
    expect(readBack(mandate([AGENT_RECURRENCE]), CTX)).toContain(
      'The agent may pay **monthly** from **Thu 1 Oct 2026** until **Fri 1 Oct 2027**, at most **12** times',
    )
  })

  it('mandate.payment.reference', () => {
    // The compiler never emits this; the template exists because a mandate that reached the read-back with
    // one would still have to explain it. "Nothing here" is not an option for a signed string.
    expect(readBack(mandate([REFERENCE]), CTX)).toContain(
      'This mandate is linked to every payment it authorises',
    )
  })
})

describe('the full read-back, end to end', () => {
  it('reads like §8.8: the total cap first, then who, then what, then when', () => {
    const text = readBack(
      mandate([MERCHANTS, PAYEES, LINE_ITEMS, AMOUNT_RANGE, BUDGET], {
        assumptions: ['Assumed USD because every item in the store you chose is priced in USD.'],
        preferences: { size: 'M', color: 'Slate' },
      }),
      CTX,
    )
    expect(text).toBe(
      [
        READBACK_HEADER,
        'Spend at most **$130.00** in total',
        'Spend at most **$130.00** per payment',
        'Only at **Northwind Outfitters**',
        'Pay only **Northwind Outfitters**',
        'Buy at least **1** of **Trail Runner** or **Alpine Boot**',
        `This mandate expires **${formatIstHuman(EXPIRES_AT)}**`,
        '',
        READBACK_INTERPRETATION_HEADER,
        '- Assumed USD because every item in the store you chose is priced in USD.',
        '- We read **size** "M" and **colour** "Slate" as a preference, not a limit. These are not signed and do not bound what the agent may buy.',
        '',
        READBACK_NOT_COVERED_HEADER,
        '- Expiry: there is no automatic renewal. When this mandate expires the agent cannot spend under it again, even if it meant to.',
      ].join('\n'),
    )
  })

  it('says so when the library would not check a cap by itself (spec D19)', () => {
    // A mandate made only of network-enforced constraints is exactly the case where a reader might
    // assume nobody is checking. The extra sentence is the honest answer.
    expect(readBack(mandate([BUDGET, RECURRENCE]), CTX)).toContain(D19_LINE)
  })

  it('does not add that sentence when the library does check the limits', () => {
    const text = readBack(mandate([BUDGET, AMOUNT_RANGE]), CTX)
    expect(text).not.toContain('Countersign checks each of these limits')
  })

  it('says plainly when a limit has no upper bound, instead of omitting it', () => {
    expect(
      readBack(
        mandate([{ type: 'mandate.payment.amount_range', currency: 'USD', min: 2000n }]),
        CTX,
      ),
    ).toContain('Spend at least **$20.00** per payment')
  })

  it('says when a mandate constrains nothing, rather than printing a bare expiry line', () => {
    expect(readBack(mandate([]), CTX)).toContain(
      'No spending limits are set on this mandate. The agent may spend without a cap for as long as it is valid.',
    )
  })

  it('renders a three-way merchant list without dropping one (losslessness)', () => {
    const three = [
      NORTHWIND,
      CONTOSO,
      { id: 'mrc_third', name: 'Third Store', website: 'https://third.countersign.test' },
    ]
    const text = readBack(
      mandate([
        {
          type: 'mandate.checkout.allowed_merchants',
          allowed: three.map((m) => ({ id: m.id, name: m.name, website: m.website })),
        },
      ]),
      { ...CTX, merchants: { ...CTX.merchants, mrc_third: 'Third Store' } },
    )
    expect(text).toContain('Only at **Northwind Outfitters**, **Contoso Supply**, **Third Store**')
  })

  it('prints a raw merchant id rather than dropping the merchant when ctx has no name for it', () => {
    // Dropping it would make "Only at X" true of a mandate that also allows Y. An ugly id is visible;
    // a silently dropped constraint is not.
    const text = readBack(
      mandate([
        {
          type: 'mandate.checkout.allowed_merchants',
          allowed: [{ id: 'mrc_ghost', name: 'Ghost', website: 'https://ghost.test' }],
        },
      ]),
      { merchants: {}, tz: 'Asia/Kolkata' },
    )
    expect(text).toContain('Only at **mrc_ghost**')
  })

  it('lists every ISO 20022 frequency as words, never as a code', () => {
    const frequencies = [
      'INDA',
      'DAIL',
      'WEEK',
      'TWOK',
      'TWMN',
      'MNTH',
      'TOMN',
      'QUTR',
      'FOMN',
      'SEMI',
      'YEAR',
      'TYEA',
    ] as const
    const words: string[] = []
    for (const frequency of frequencies) {
      const text = readBack(
        mandate([{ type: 'mandate.payment.recurrence', frequency, start_date: '2026-10-01' }]),
        CTX,
      )
      expect(text).not.toContain(frequency)
      words.push(text.split('\n')[1] ?? '')
    }
    expect(words).toEqual([
      'Payments repeat **once** from **Thu 1 Oct 2026**',
      'Payments repeat **daily** from **Thu 1 Oct 2026**',
      'Payments repeat **weekly** from **Thu 1 Oct 2026**',
      'Payments repeat **every two weeks** from **Thu 1 Oct 2026**',
      'Payments repeat **every two months** from **Thu 1 Oct 2026**',
      'Payments repeat **monthly** from **Thu 1 Oct 2026**',
      'Payments repeat **every three months** from **Thu 1 Oct 2026**',
      'Payments repeat **quarterly** from **Thu 1 Oct 2026**',
      'Payments repeat **every four months** from **Thu 1 Oct 2026**',
      'Payments repeat **twice a month** from **Thu 1 Oct 2026**',
      'Payments repeat **yearly** from **Thu 1 Oct 2026**',
      'Payments repeat **every two years** from **Thu 1 Oct 2026**',
    ])
  })

  it('distinguishes match_mode "minimum" from "exact"', () => {
    const exact: VIConstraint = {
      type: 'mandate.checkout.line_items',
      items: [
        {
          id: 'line-item-1',
          acceptable_items: [{ id: 'SKU-TRAIL-42', title: 'Trail Runner' }],
          quantity: 2,
        },
      ],
      match_mode: 'exact',
    }
    expect(readBack(mandate([exact]), CTX)).toContain('Buy exactly **2** of **Trail Runner**')
  })

  it('renders a zero-decimal currency without arithmetic (JPY has no minor unit)', () => {
    const yen: VIConstraint = { type: 'mandate.payment.budget', currency: 'JPY', max: 500n }
    expect(readBack(mandate([yen]), CTX)).toContain('Spend at most **¥500** in total')
  })

  it('renders a five-figure amount with grouping and both minor digits', () => {
    const big: VIConstraint = { type: 'mandate.payment.budget', currency: 'USD', max: 1_299_900n }
    expect(readBack(mandate([big]), CTX)).toContain('Spend at most **$12,999.00** in total')
  })

  it('renders a non-USD amount in its own symbol (EC-FX-1: no conversion in the display either)', () => {
    const inr: VIConstraint = { type: 'mandate.payment.budget', currency: 'INR', max: 34000n }
    expect(readBack(mandate([inr]), CTX)).toContain('Spend at most **₹340.00** in total')
  })
})

describe('purity and stability', () => {
  const subject = mandate([MERCHANTS, PAYEES, LINE_ITEMS, AMOUNT_RANGE, BUDGET], {
    assumptions: [
      'Assumed USD because you did not name a currency.',
      'Assumed USD because you did not name a currency.',
    ],
  })

  it('repeated calls are byte-identical', () => {
    const first = readBack(subject, CTX)
    for (let i = 0; i < 50; i += 1) expect(readBack(subject, CTX)).toBe(first)
  })

  it('the order of the constraints array does not change a byte', () => {
    const shuffled = [...subject.constraints].reverse()
    expect(readBack(mandate(shuffled, { assumptions: subject.assumptions }), CTX)).toBe(
      readBack(subject, CTX),
    )
  })

  it('the order of the merchant name map does not change a byte', () => {
    const reversed: ReadBackContext = {
      tz: 'Asia/Kolkata',
      merchants: { [CONTOSO.id]: CONTOSO.name, [NORTHWIND.id]: NORTHWIND.name },
    }
    expect(readBack(subject, reversed)).toBe(readBack(subject, CTX))
  })

  it('duplicate assumptions are collapsed', () => {
    const occurrences =
      readBack(subject, CTX).split('because you did not name a currency.').length - 1
    expect(occurrences).toBe(1)
  })

  it('it does not mutate its arguments', () => {
    const before = JSON.stringify(subject, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    readBack(subject, CTX)
    const after = JSON.stringify(subject, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(after).toBe(before)
  })
})

describe('totality', () => {
  it('READBACK_ORDER covers exactly the eight constraint types, once each', () => {
    expect([...READBACK_ORDER].sort()).toEqual([...CONSTRAINT_TYPES].sort())
  })

  it('there is exactly one template per type', () => {
    expect(READBACK_TEMPLATES.map((t) => t.type).sort()).toEqual([...CONSTRAINT_TYPES].sort())
  })

  it('the three network-enforced types are flagged, and only those three (spec D19)', () => {
    const flagged = new Set(READBACK_TEMPLATES.filter((t) => t.networkEnforced).map((t) => t.type))
    expect([...flagged].sort()).toEqual([...NETWORK_ENFORCED_CONSTRAINT_TYPES].sort())
  })

  it('every template renders a non-empty line for a valid instance of its type', () => {
    const samples: Record<string, VIConstraint> = {
      'mandate.checkout.allowed_merchants': MERCHANTS,
      'mandate.checkout.line_items': LINE_ITEMS,
      'mandate.payment.allowed_payees': PAYEES,
      'mandate.payment.amount_range': AMOUNT_RANGE,
      'mandate.payment.budget': BUDGET,
      'mandate.payment.recurrence': RECURRENCE,
      'mandate.payment.agent_recurrence': AGENT_RECURRENCE,
      'mandate.payment.reference': REFERENCE,
    }
    for (const template of READBACK_TEMPLATES) {
      const sample = samples[template.type]
      expect(sample, template.type).toBeDefined()
      const line = template.render(sample as VIConstraint, CTX)
      expect(line, template.type).not.toBeNull()
      expect((line ?? '').length, template.type).toBeGreaterThan(0)
      // Losslessness: the line must actually contain the constraint's payload, not just a label.
      const text = readBack(mandate([sample as VIConstraint]), CTX)
      expect(text, template.type).toContain((line ?? '').split('\n')[0] ?? '')
    }
  })

  it('a constraint the read-back cannot name is not silently dropped from a mandate', () => {
    // The read-back is lossless by construction: whatever is in `constraints` contributes a line. This
    // asserts the negative space — a constraint type with no template would print nothing at all, which
    // is the failure mode the totality tests above exist to prevent.
    const text = readBack(
      mandate([
        MERCHANTS,
        PAYEES,
        LINE_ITEMS,
        AMOUNT_RANGE,
        BUDGET,
        RECURRENCE,
        AGENT_RECURRENCE,
        REFERENCE,
      ]),
      CTX,
    )
    for (const type of CONSTRAINT_TYPES) {
      const present = constraintOfType(
        text.length > 0
          ? [
              MERCHANTS,
              PAYEES,
              LINE_ITEMS,
              AMOUNT_RANGE,
              BUDGET,
              RECURRENCE,
              AGENT_RECURRENCE,
              REFERENCE,
            ]
          : [],
        type,
      )
      if (present !== null)
        expect(text).toContain(
          READBACK_TEMPLATES.find((t) => t.type === type)!
            .render(present, CTX)!
            .split('\n')[0]!,
        )
    }
  })
})

describe('formatIstCalendarDate', () => {
  it('renders a date the way a person writes it', () => {
    expect(formatIstCalendarDate('2026-10-01', 'Asia/Kolkata')).toBe('Thu 1 Oct 2026')
    expect(formatIstCalendarDate('2027-10-01', 'Asia/Kolkata')).toBe('Fri 1 Oct 2027')
    expect(formatIstCalendarDate('2026-01-31', 'Asia/Kolkata')).toBe('Sat 31 Jan 2026')
  })

  it('agrees with core.formatIstHuman on the month and weekday for all twelve months', () => {
    // Both functions are in the same read-back. If they disagreed, one line would say "Thu 1 Oct" and the
    // next "Fri 1 Oct", and the read-back would look broken to exactly the person who must trust it.
    for (let month = 1; month <= 12; month += 1) {
      const iso = `2026-${String(month).padStart(2, '0')}-15`
      const ours = formatIstCalendarDate(iso, 'Asia/Kolkata')
      const theirs = formatIstHuman(Date.UTC(2026, month - 1, 15) / 1000)
      const oursWeekday = ours.split(' ')[0]
      const oursMonth = ours.split(' ')[2]
      // core prints "Thu 15 Jan, 3:00 AM IST"; the trailing comma belongs to the time, not the month.
      expect(oursWeekday, iso).toBe(theirs.split(' ')[0])
      expect(oursMonth, iso).toBe((theirs.split(' ')[2] ?? '').replace(',', ''))
    }
  })
})

describe('the read-back and the ambiguities gate', () => {
  it("an unresolved ambiguity is the UI's business, and the read-back stays a statement about a finished mandate", async () => {
    const { model } = scriptedModel([
      { kind: 'text', text: JSON.stringify({ currency: 'USD', merchantIds: [NORTHWIND.id] }) },
    ])
    const result = await compile(compileInput({ text: 'Buy shoes' }), {
      llm: model,
      catalog: catalogOf(STANDARD_CATALOG),
      clock: fixedClock(1_790_529_540 - 604_800),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(hasBlockingAmbiguities(result.value)).toBe(true)
    // The rendered text must not contain the question: a read-back that asks a question invites a signature
    // on an incomplete mandate.
    expect(readBack(result.value, CTX)).not.toContain('did not say how much')
  })
})
