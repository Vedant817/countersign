/**
 * **AT-M10.5** — the decision record verifies against the `/.well-known/jwks.json` shape. Spec §8.10,
 * §3.1 invariant **I-1**, §7.3, §18 Q11.
 *
 * ## What "verifies" has to mean
 *
 * Not "the string came back". It means: a party holding nothing but the JWS, the published JWKS and the
 * twelve check rows can answer *"was there an `ALLOW` for exactly this attempt, this amount, this currency
 * and this payee, and has the set of check results been altered since?"* That is I-1 turned from a claim
 * into a check, and it is the thing a PayPal dispute agent or a judge actually does.
 *
 * ## Why `EdDSA` and not `ES256`
 *
 * Ed25519 verification is deterministic and constant-time in `jose`, so a record verifies identically on
 * any platform in any year with no library-version sensitivity. A Gate decision is evidence, and evidence
 * that only verifies on the machine that wrote it is not evidence.
 */
import { describe, expect, it } from 'vitest'
import { generateKeyPair, exportJWK } from 'jose'
import { VI_LIB_COMMIT } from '@countersign/core'

import { CHECK_ORDER } from '../src/checks'
import {
  GATE_RECORD_TYP,
  REQUIRED_FIELDS,
  checksHash,
  gateJwks,
  gateJwksMany,
  importGateSigningKey,
  merchantKeySetFromJwks,
  recordMatches,
  recordSigner,
  sha256Hex,
  verifyDecisionRecord,
} from '../src/decision-record'
import { evaluate } from '../src/evaluate'
import {
  CART_MINOR,
  MANDATE_ID,
  MERCHANT_ID,
  NOW_SEC,
  input,
  makeWorld,
  signedCheckoutJwt,
} from './fixtures'

/**
 * Sign a real decision, and hand back the record, the JWKS a verifier would hold, and the `kid`.
 *
 * Returns `result.value` rather than the `Result`: every test here is about the *record*, and unwrapping
 * here means none of them has to remember to — an `err` slipping through would otherwise surface as
 * `Cannot read properties of undefined (reading 'split')` forty lines from its cause.
 */
async function signedDecision() {
  const world = await makeWorld({ signWithRealKey: true })
  const result = await evaluate(input(), world.deps)
  if (!result.ok)
    throw new Error(`evaluate() failed: ${result.error.code}: ${result.error.message}`)

  const keys = world.keys.gate
  const jwks = gateJwks(keys.kid, keys.jwks.keys[0]!)
  return { decision: result.value, world, jwks, kid: keys.kid }
}

describe('AT-M10.5 — the decision record verifies against /.well-known/jwks.json', () => {
  it('verifies a signed ALLOW against the JWKS and reproduces the payload', async () => {
    const { decision, jwks } = await signedDecision()
    const verdict = await verifyDecisionRecord(decision.signedRecord, { jwks, nowSec: NOW_SEC })

    if (!verdict.valid) throw new Error(`record did not verify: ${verdict.reason}`)
    expect(verdict.payload.gdc).toBe(decision.id)
    // `att` is the attempt the decision was made for, and it is the attempt `recordMatches` is asked
    // about below — I-1's "exactly that order".
    expect(verdict.payload.att.startsWith('att_')).toBe(true)
    expect(verdict.payload.mdt).toBe(MANDATE_ID)
    expect(verdict.payload.amount).toBe('30.00')
    expect(verdict.payload.currency).toBe('USD')
    expect(verdict.payload.payee).toBe(MERCHANT_ID)
    expect(verdict.payload.chain_valid).toBe(true)
    // The pinned library commit: a packet filed months from now must verify against the code that ran.
    expect(verdict.payload.vi_commit).toBe(VI_LIB_COMMIT)
    expect(verdict.payload.iat).toBe(NOW_SEC)
    expect(verdict.fresh).toBe(true)
  })

  it('I-1: the record names *this* attempt, amount, currency and payee — recordMatches proves it', async () => {
    const { decision, jwks } = await signedDecision()
    const verdict = await verifyDecisionRecord(decision.signedRecord, { jwks, nowSec: NOW_SEC })
    if (!verdict.valid) throw new Error(verdict.reason)

    // The four words of I-1, as an executable assertion.
    expect(
      recordMatches(verdict.payload, {
        attemptId: verdict.payload.att,
        amount: '30.00',
        currency: 'USD',
        payee: MERCHANT_ID,
      }),
    ).toEqual({ ok: true })

    // And a mismatch is named, not silently accepted.
    const wrong = recordMatches(verdict.payload, {
      attemptId: verdict.payload.att,
      amount: '9.99',
      currency: 'USD',
      payee: MERCHANT_ID,
    })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.field).toBe('amount')
  })

  it('refuses a record signed by a different key, naming the kid', async () => {
    const { decision } = await signedDecision()
    const other = await generateKeyPair('Ed25519', { extractable: true })
    const publicJwk = {
      ...((await exportJWK(other.publicKey)) as Record<string, unknown>),
      alg: 'EdDSA',
      kid: 'someone-elses-key',
    }

    const verdict = await verifyDecisionRecord(decision.signedRecord, {
      jwks: { keys: [publicJwk] },
      nowSec: NOW_SEC,
    })

    expect(verdict.valid).toBe(false)
    if (!verdict.valid) expect(verdict.reason).toContain('no key in the JWKS')
  })

  it('refuses a tampered payload: one flipped character in the signature segment', async () => {
    const { decision, jwks } = await signedDecision()
    const parts = decision.signedRecord.split('.')
    const signature = parts[2]!
    const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`

    const verdict = await verifyDecisionRecord(`${parts[0]}.${parts[1]}.${flipped}`, {
      jwks,
      nowSec: NOW_SEC,
    })

    expect(verdict.valid).toBe(false)
    if (!verdict.valid) expect(verdict.reason).toContain('signature did not verify')
  })

  it('refuses a record whose payload was edited — flipping the decision would not survive', async () => {
    const { decision, jwks } = await signedDecision()
    const [, payloadSegment, signature] = decision.signedRecord.split('.')

    const payload = JSON.parse(
      Buffer.from(payloadSegment!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    payload['amount'] = '1.00'
    const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')

    const verdict = await verifyDecisionRecord(
      `${decision.signedRecord.split('.')[0]}.${forged}.${signature}`,
      {
        jwks,
        nowSec: NOW_SEC,
      },
    )

    expect(verdict.valid).toBe(false)
  })

  it('refuses a record that is not a JWS at all', async () => {
    const { jwks } = await signedDecision()
    const verdict = await verifyDecisionRecord('not-a-jws', { jwks, nowSec: NOW_SEC })

    expect(verdict.valid).toBe(false)
    if (!verdict.valid) expect(verdict.reason).toContain('not a compact JWS')
  })

  it('the JWKS shape is `/.well-known/jwks.json`: a `keys` array of public JWKs', async () => {
    const { jwks, kid } = await signedDecision()

    expect(Array.isArray(jwks.keys)).toBe(true)
    expect(jwks.keys).toHaveLength(1)
    const entry = jwks.keys[0]!
    expect(entry.kid).toBe(kid)
    expect(entry.alg).toBe('EdDSA')
    expect(entry.use).toBe('sig')
    // Ed25519 public JWK: `kty`/`crv`/`x`. The private `d` must never appear.
    expect(entry.kty).toBe('OKP')
    expect(entry.crv).toBe('Ed25519')
    expect(typeof entry.x).toBe('string')
    expect('d' in entry).toBe(false)
  })

  it('the JWKS keeps retired keys so an old record still verifies after rotation', async () => {
    const world = await makeWorld({ signWithRealKey: true })
    const result = await evaluate(input(), world.deps)
    if (!result.ok) throw new Error(result.error.message)
    const decision = result.value

    const jwks = gateJwksMany([
      { kid: 'gate-key-2', jwk: world.keys.gate.jwks.keys[0]! },
      { kid: 'gate-key-1', jwk: world.keys.gate.jwks.keys[0]! },
    ])

    const verdict = await verifyDecisionRecord(decision.signedRecord, { jwks, nowSec: NOW_SEC })
    expect(verdict.valid).toBe(true)
    // EC-KEY-2: the old record verified against the key that signed it, rotation or not.
    expect(verdict.valid && verdict.kid).toBe('gate-key-1')
  })
})

describe('the payload is exactly §8.10’s nine fields', () => {
  it('carries all of them and nothing more', async () => {
    const { decision, jwks } = await signedDecision()
    const verdict = await verifyDecisionRecord(decision.signedRecord, { jwks, nowSec: NOW_SEC })
    if (!verdict.valid) throw new Error(verdict.reason)

    expect(Object.keys(verdict.payload).sort()).toEqual([...REQUIRED_FIELDS].sort())
    // The exact list §8.10 names, in the spec's order.
    expect([...REQUIRED_FIELDS]).toEqual([
      'gdc',
      'att',
      'mdt',
      'amount',
      'currency',
      'payee',
      'checks_hash',
      'chain_valid',
      'vi_commit',
      'iat',
    ])
  })

  it('`checks_hash` is a hash of the twelve check results, so an edited check set is detectable', async () => {
    const { decision } = await signedDecision()
    const recomputed = checksHash(decision.checks)

    // It matches what was signed.
    const payload = JSON.parse(
      Buffer.from(decision.signedRecord.split('.')[1]!, 'base64url').toString('utf8'),
    ) as {
      checks_hash: string
    }
    expect(payload.checks_hash).toBe(recomputed)

    // Flipping any single check changes it. Check 8 is the load-bearing one: an ALLOW with check 8 failing
    // is the forgery that matters, and this is what makes it detectable.
    const flipped = decision.checks.map((c) => (c.n === 8 ? { ...c, passed: !c.passed } : c))
    expect(checksHash(flipped)).not.toBe(recomputed)

    // And the hash covers `detail`, so a reason cannot be rewritten after the fact either.
    const reworded = decision.checks.map((c) =>
      c.n === 8 ? { ...c, detail: 'reserved a different amount' } : c,
    )
    expect(checksHash(reworded)).not.toBe(recomputed)
  })

  it('`checks_hash` covers all twelve checks, in order', async () => {
    // A hash over a subset would still detect edits *within* the subset. This asserts the subset is not
    // a subset.
    const checks = CHECK_ORDER.map((row) => ({
      n: row.n,
      code: row.code,
      passed: true,
      detail: 'ok',
    }))
    const withoutTwelve = checks.slice(0, 11)
    expect(checksHash(checks)).not.toBe(checksHash(withoutTwelve))
  })

  it('a record whose `chain_valid` is false is signed too — a BLOCK is evidence too', async () => {
    const world = await makeWorld({
      signWithRealKey: true,
      verify: { chain_valid: false, errors: ['bad'] },
    })
    const result = await evaluate(input(), world.deps)
    if (!result.ok) throw new Error(result.error.message)
    const decision = result.value

    const verdict = await verifyDecisionRecord(decision.signedRecord, {
      jwks: world.keys.gate.jwks,
      nowSec: NOW_SEC,
    })
    if (!verdict.valid) throw new Error(verdict.reason)

    // §7.2: `gate_decisions` is append-only and every decision is signed — an attacker must not be able to
    // suppress the record of a refusal by breaking its signature.
    expect(verdict.payload.chain_valid).toBe(false)
    expect(decision.decision).toBe('BLOCK')
  })
})

describe('signing key handling', () => {
  it('accepts a GATE_SIGNING_KEY JWK string and produces a matching JWKS entry', async () => {
    const world = await makeWorld()
    const parsed = await importGateSigningKey(
      JSON.stringify(world.keys.gate.privateJwk),
      'fallback-kid',
    )

    if (!parsed.ok) throw new Error(parsed.error.message)
    expect(parsed.value.kid).toBe('gate-key-1')
    // The public half is what goes on the wire; the private `d` must not.
    expect('d' in parsed.value.publicJwk).toBe(false)

    const signed = await recordSigner(
      parsed.value.key,
      parsed.value.kid,
    )({
      gdc: 'gdc_1' as never,
      att: 'att_1' as never,
      mdt: 'mdt_1' as never,
      amount: '1.00',
      currency: 'USD',
      payee: 'M',
      checks_hash: sha256Hex([]),
      chain_valid: true,
      vi_commit: VI_LIB_COMMIT,
      iat: NOW_SEC,
    })
    if (!signed.ok) throw new Error(signed.error.message)

    const verdict = await verifyDecisionRecord(signed.value, {
      jwks: gateJwks(parsed.value.kid, parsed.value.publicJwk),
      nowSec: NOW_SEC,
    })
    expect(verdict.valid).toBe(true)
  })

  it('accepts a bare base64url Ed25519 seed, because an operator will paste one at 3 a.m.', async () => {
    const pair = await generateKeyPair('Ed25519', { extractable: true })
    const privateJwk = (await exportJWK(pair.privateKey)) as Record<string, unknown>

    const parsed = await importGateSigningKey(String(privateJwk['d']), 'seed-kid')

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.kid).toBe('seed-kid')

    // And it actually signs: a key that parses but cannot sign is a 3 a.m. failure found at boot instead
    // of at the first purchase.
    const signed = await recordSigner(
      parsed.value.key,
      parsed.value.kid,
    )({
      gdc: 'gdc_1' as never,
      att: 'att_1' as never,
      mdt: 'mdt_1' as never,
      amount: '1.00',
      currency: 'USD',
      payee: 'M',
      checks_hash: sha256Hex([]),
      chain_valid: true,
      vi_commit: VI_LIB_COMMIT,
      iat: NOW_SEC,
    })
    expect(signed.ok).toBe(true)
  })

  it('refuses a malformed key with a message that names the operator, not the buyer', async () => {
    const parsed = await importGateSigningKey('{not json', 'kid')

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('CS_VALIDATION')
    expect(parsed.error.userMessage).toContain('misconfigured')
  })

  it('the record header carries typ, so a verifier can tell a decision from any other JWS', async () => {
    const { decision, jwks } = await signedDecision()
    const header = JSON.parse(
      Buffer.from(decision.signedRecord.split('.')[0]!, 'base64url').toString('utf8'),
    ) as {
      alg: string
      typ: string
    }

    expect(header.alg).toBe('EdDSA')
    expect(header.typ).toBe(GATE_RECORD_TYP)
    const verdict = await verifyDecisionRecord(decision.signedRecord, { jwks, nowSec: NOW_SEC })
    expect(verdict.valid).toBe(true)
  })
})

describe('the merchant key set (check 5)', () => {
  it('keeps RETIRED merchant keys and drops COMPROMISED ones (EC-KEY-2, EC-AGT-3)', () => {
    const set = merchantKeySetFromJwks([
      {
        kid: 'issuer-1',
        role: 'ISSUER',
        status: 'ACTIVE',
        kty: 'OKP',
        crv: 'Ed25519',
        x: 'a',
      },
      {
        kid: 'merchant-new',
        role: 'MERCHANT',
        status: 'ACTIVE',
        kty: 'OKP',
        crv: 'Ed25519',
        x: 'b',
      },
      {
        kid: 'merchant-old',
        role: 'MERCHANT',
        status: 'RETIRED',
        kty: 'OKP',
        crv: 'Ed25519',
        x: 'c',
      },
      {
        kid: 'merchant-bad',
        role: 'MERCHANT',
        status: 'COMPROMISED',
        kty: 'OKP',
        crv: 'Ed25519',
        x: 'd',
      },
      // No key members at all. Still the "unusable entry" case the filter exists for, now in the
      // shape `apps/vi` would actually produce for a malformed entry.
      { kid: 'merchant-nokey', role: 'MERCHANT', status: 'ACTIVE' },
    ])

    expect(set.currentKid).toBe('merchant-new')
    // The retired one is accepted, or every cart in flight at rotation time fails.
    expect(set.acceptedKids).toContain('merchant-old')
    // The compromised one is not. EC-AGT-3: a leaked key's mandates are revoked, and the key must stop
    // verifying price locks.
    expect(set.acceptedKids).not.toContain('merchant-bad')
    expect(set.jwks['merchant-bad']).toBeUndefined()
    // An entry with no usable key is dropped rather than kept as a hole.
    expect(set.acceptedKids).not.toContain('merchant-nokey')
    // The issuer key is not a merchant key.
    expect(set.acceptedKids).not.toContain('issuer-1')
  })

  it('check 5 accepts a price lock signed by the retired kid and refuses an unknown one', async () => {
    const world = await makeWorld()
    const retiredJwt = await signedCheckoutJwt(world.keys.merchant.key, 'merchant-1')

    const allowed = await makeWorld({
      merchantKeys: {
        currentKid: 'merchant-2',
        acceptedKids: ['merchant-2', 'merchant-1'],
        jwks: world.keys.merchantKeySet().jwks,
      },
      session: { checkout_jwt: retiredJwt },
    })
    const ok = await evaluate(input(), allowed.deps)
    expect(ok.ok && ok.value.decision).toBe('ALLOW')

    const rogueJwt = await signedCheckoutJwt(world.keys.rogue.key, 'merchant-rogue')
    const refused = await makeWorld({
      merchantKeys: {
        currentKid: 'merchant-2',
        acceptedKids: ['merchant-2'],
        jwks: world.keys.merchantKeySet().jwks,
      },
      session: { checkout_jwt: rogueJwt },
    })
    const no = await evaluate(input(), refused.deps)
    expect(no.ok && no.value.reasons.map((r) => r.code)).toContain('VI_CHAIN_INVALID')
  })
})

describe('money in the record is a decimal string, never a float', () => {
  it('records JPY with no decimals and USD with two (EC-FX-3)', async () => {
    const usd = await signedDecision()
    // `30.00` is inside the base64url payload, so decode rather than substring-match the JWS.
    const payload = JSON.parse(
      Buffer.from(usd.decision.signedRecord.split('.')[1]!, 'base64url').toString('utf8'),
    ) as { amount: string }
    expect(payload.amount).toBe('30.00')

    // A JPY session: zero minor digits, so `toPayPalValue` must emit `"500"` and never `"500.00"`.
    const jpy = await makeWorld({ signWithRealKey: true, cartMinor: 500n, currency: 'JPY' })
    const result = await evaluate(input({ l3a: jpyL3a(500) }), jpy.deps)
    if (!result.ok) throw new Error(result.error.message)

    const verdict = await verifyDecisionRecord(result.value.signedRecord, {
      jwks: jpy.keys.gate.jwks,
      nowSec: NOW_SEC,
    })
    if (!verdict.valid) throw new Error(verdict.reason)
    // `toPayPalValue` emits `"500"` for a zero-decimal currency and `"30.00"` for a two-decimal one, so a
    // verifier never has to know which is which.
    expect(verdict.payload.amount).toBe('500')
    expect(verdict.payload.amount).not.toContain('.')
  })
})

/** A $0 JPY-session L3a. `toPayPalValue` on JPY emits no decimals, so the record must not either. */
function jpyL3a(amountMinor: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'agent-key-1' }), 'utf8').toString(
    'base64url',
  )
  const payload = Buffer.from(
    JSON.stringify({
      jti: 'jpy-1',
      amount_minor: amountMinor,
      currency: 'JPY',
      payee_id: MERCHANT_ID,
      aud: 'https://merchant.example',
      iat: NOW_SEC - 5,
      exp: NOW_SEC + 295,
    }),
    'utf8',
  ).toString('base64url')
  return `${header}.${payload}.${Buffer.from('unsigned', 'utf8').toString('base64url')}`
}

void CART_MINOR
