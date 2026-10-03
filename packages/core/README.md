# `@countersign/core`

IDs, money, errors, clock, env and boundary schemas — spec **§8.1 (M1)**, work package **WP-01**.

This package is the bottom of the dependency graph. Nothing else in the monorepo may define its own
version of "what a `MandateId` is" or "how an amount is represented". Per AGENTS.md engineering rule
2, its public exports are **append-only**.

It imports nothing from the repository, nothing from the network, and nothing from an LLM.

---

## Money

> Money is always **integer minor units plus an ISO-4217 currency code**. Floats are never used.
> — spec §0

```ts
import { add, allocate, formatMoney, fromPayPalValue, money, toPayPalValue } from '@countersign/core'

toPayPalValue({ minor: 12345n, currency: 'USD' })  // "123.45"
toPayPalValue({ minor: 500n, currency: 'JPY' })    // "500"   (zero-decimal currency)
fromPayPalValue('123.45', 'USD')                   // { minor: 12345n, currency: 'USD' }
fromPayPalValue('1.005', 'USD')                    // throws CS_ROUNDING — never rounds
add({ minor: 10n, currency: 'USD' }, { minor: 20n, currency: 'INR' }) // throws CS_CURRENCY_MISMATCH
allocate({ minor: 1000n, currency: 'USD' }, [1n, 1n, 1n])             // [334n, 333n, 333n]
formatMoney({ minor: 13000n, currency: 'USD' })                       // "$130.00"
```

Four properties are enforced, not merely intended:

| Property | How | Test |
|---|---|---|
| No float ever represents money | `Money.minor` is `bigint`; boundary schemas reject JS numbers | `AT-M1.1`, `EC-FX-5` |
| Sub-minor precision is refused, never rounded | `fromPayPalValue` throws `CS_ROUNDING` | `AT-M1.2` |
| Currencies are never mixed or converted | `add`/`sub`/`compare`/`sum`/`withinRange` throw `CS_CURRENCY_MISMATCH` | `AT-M1.4`, `EC-FX-1` |
| A split loses no minor unit | `allocate` uses largest remainder; `sum(parts) === total` exactly | `AT-M1.3`, `EC-FX-4` |

`allocateWithRemainderLast` is the variant that pins *every* leftover cent on the final part, for
rows where a human has to be able to check the last number.

**Enforcement beyond tests.** `pnpm lint` runs `scripts/check-money-discipline.mjs`, which greps the
money-bearing packages for the float idioms that actually cause incidents (`parseFloat`,
`Math.round` on an amount, `.toFixed()` on an amount, `Number(x.minor)`). That script has its own
self-test (`test/money-discipline.test.ts`) which plants every bad idiom in a temp tree and asserts
the checker catches it — a guard that has never been observed to fire is not a guard.

## Identifiers

Prefixed, ULID-bodied, sortable by creation time. The prefix lives in the type, so a `MandateId`
cannot be passed where an `OrderId` belongs.

```ts
const id = newId('mdt')   // "mdt_01J9Z…"; typed as Id<'mdt'>
asId('ord', id)          // null — the prefix does not match
idCreatedAtMs(id)        // 1_760_000_000_000
```

## Errors

Every failure crossing a module boundary is a `Result<T, CsError>`; nothing throws across a boundary.
`code` comes from the closed registry and every code has hand-written buyer-facing copy, because the
Gate's reasons are read by users.

```ts
import { attempt, csError, toBody, unwrap } from '@countersign/core'

const r = await attempt(() => paypal.getOrder(id), 'PP_UNAVAILABLE')
if (!r.ok) return NextResponse.json(toBody(r.error), { status: 502 })
```

`csError(code, message, details?, options?)` takes the details bag as a **separate third parameter**
rather than merging it into an options object. That is deliberate: with one merged object it is
trivially easy to write `{ value: '1.005' }` against a signature expecting `{ details: {…} }` and
lose the details silently — a bug this package's own test suite caught.

`toBody` strips anything credential-shaped from `details` before serialising, because that object
crosses a trust boundary to a browser.

## Clock

The only time source. No module calls `Date.now()` for business logic.

```ts
const clock = fixedClock(1_760_000_000)   // tests: pin expiry, price locks, deadlines
clock.advance(3600)
withinValidity(at, { iat, exp }, skewSeconds)   // 300 s default, matching the VI library
formatIstHuman(1_760_000_000)              // "Fri 9 Oct, 11:59 PM IST"
```

IST conversion uses a fixed +05:30 offset, which is exact rather than approximate: Asia/Kolkata has
had no daylight saving since 1945, and this project needs no timezone database.

## Env

Validated at boot by zod. **The process refuses to start if a required variable is missing**, and
`PAYPAL_ENV=live` is rejected as an invalid value (**EC-ENV-1**) — a demo that accidentally takes
real money is the worst available failure.

```ts
const env = env()          // throws a CsError listing *every* missing key at once
assertSandbox({ PAYPAL_ENV, PAYPAL_API_BASE })   // also enforced at call time
parsePartialEnv()          // for scripts that only need a few variables
```

## Logging

`createLogger()` emits JSON lines through three filters, because each catches a different mistake:

1. **key name** — credential-looking keys → `[redacted]`; PII keys (`display_name`, `payer_email`,
   `address`, …) → `[pii]` while the key is kept, so a log still proves a wallet field was present.
2. **known value** — every secret in the environment scrubbed from free text, plus compact-JWS and
   `Bearer …` shapes.
3. **shape** — emails, card numbers and phone numbers, by value.

**Honest limit:** no regex can find a person's *name* inside a free-text message. The rule for
callers is "put names in a named field, never in the message string", and filter 1 enforces the
second half of it. Claiming otherwise would be a false assurance.

## Scripts

```bash
pnpm --filter @countersign/core test          # 86 tests: AT-M1, EC-ENV-1, EC-FX-*, EC-PRIV-3
pnpm --filter @countersign/core typecheck
pnpm --filter @countersign/core lint
node scripts/check-money-discipline.mjs       # standalone money guard
```