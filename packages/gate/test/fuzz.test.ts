/**
 * **AT-M10.6** — 1,000 random fuzzed L3 mutations (byte flips) → **0 ALLOWs**. Spec §8.10, §3.1 **I-1**,
 * §14, §12 **EC-AGT-1**.
 *
 * ## What this test is actually claiming
 *
 * Not "the Gate is robust". Something narrower and more useful: **mutating the L3 can never produce an
 * ALLOW.** A mutation is one bit flipped somewhere in the token, which is exactly what an attacker
 * replaying, truncating, splicing or bit-rotting a captured L3 does. Every such token must end in BLOCK or
 * REVIEW. If one ends in ALLOW, that is a **critical finding**, not a test to be widened: an ALLOW is the
 * only thing in this system that authorises money movement, and an ALLOW produced by corrupting a signature
 * means a signature is not being verified.
 *
 * ## The trap this file had to be built around
 *
 * The first run of this test **failed**, and the failure was in the test rather than in the Gate. A JWS
 * *header* carries `alg`, `kid` and `typ` — none of which the Gate cross-checks against a server-side row —
 * so flipping a bit in the header changed nothing any check reads, and the `/v1/verify` double answered
 * `chain_valid: true` regardless. Eleven of a thousand mutations produced an ALLOW.
 *
 * The honest reading is "the double is not verifying signatures", not "the Gate has a hole": in production
 * check 4 asks **vi-service** to run `verify_chain`, which is where the L3 signature is actually verified.
 * So the fix was to make the double verify for real — the world signs L3a/L3b with a real Ed25519 agent key
 * and `/v1/verify` really verifies them (`TestKeys.verifyAgentSignature`), with a caller-supplied
 * `chain_valid: false` applied **only after** verification passes. A forged chain now fails whatever the
 * test seed says, which is what makes "0 ALLOWs" a statement about the Gate rather than about the harness.
 *
 * ## Why bits rather than random bytes
 *
 * A random byte often produces a non-ASCII character, making the JWS unparseable for reasons that have
 * nothing to do with the Gate, which would inflate the block count with trivial cases. A bit flip keeps the
 * token structurally plausible far more often, so the survivors are the interesting ones.
 *
 * ## The one thing this fuzz found, and it is not a bypass
 *
 * Roughly one mutation in a thousand produced an ALLOW, and it is worth being precise about why. A 64-byte
 * Ed25519 signature is 86 base64url characters; the last character encodes only **two** significant bits and
 * four padding bits that a decoder discards. Flipping a padding bit yields a **different string** whose
 * **decoded bytes are identical**, so it is the same signed message with the same signature and the Gate is
 * right to allow it. Nothing about what the token authorises changed — two spellings of one authority.
 *
 * The fuzz asserts that claim exactly rather than excluding those mutations by index: an ALLOW is accepted
 * **only** when the mutated token is byte-identical after decoding to the signed one
 * ({@link sameSignedContent}). An ALLOW of a semantically different token is still a critical finding, and
 * the failure message distinguishes the two cases.
 */
import { describe, expect, it } from 'vitest'

import { evaluate } from '../src/evaluate'
import type { GateDecision } from '../src/types'
import type { GateInput } from '../src/types'
import { CART_MINOR, input, makeWorld, signL3a, signL3b } from './fixtures'

/** §8.10's figure. */
const MUTATIONS = 1_000

type World = Awaited<ReturnType<typeof makeWorld>>

/**
 * A seeded xorshift PRNG.
 *
 * `Math.random` would make a failure unreproducible, and a fuzz that reports "it failed once last month" is
 * a fuzz that gets disabled. Seeded, the same test fails the same way on every machine.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

/** Flip one bit of one byte. See the module header for why a bit and not a byte. */
function flipBit(token: string, random: () => number): string {
  const bytes = Buffer.from(token, 'utf8')
  const index = Math.floor(random() * bytes.length)
  bytes[index] = bytes[index]! ^ (1 << Math.floor(random() * 8))
  return bytes.toString('utf8')
}

/**
 * A signed `GateInput` for iteration `i`: distinct attempt id, distinct `jti`, real agent signature.
 *
 * Each of the three matters for a specific reason:
 *
 * - **Signed for real** — see the module header. Without it a header flip is invisible to every check.
 * - **Distinct attempt id** — so a BLOCK is never merely "that jti was already used".
 * - **Distinct `jti`** — without it check 7 refuses with `GATE_REPLAY`, a legitimate BLOCK that hides exactly
 *   the finding this file exists to surface.
 */
async function signedInput(
  world: World,
  i: number,
  overrides: Partial<GateInput> = {},
): Promise<GateInput> {
  const base = input()
  return {
    attemptId: `att_${String(i).padStart(26, '0')}` as GateInput['attemptId'],
    mandateId: base.mandateId,
    checkoutId: base.checkoutId,
    agentId: base.agentId,
    l3a: await signL3a(world.keys.agent.key, {
      jti: `fuzz-${i}`,
      amount_minor: Number(CART_MINOR),
    }),
    l3b: await signL3b(world.keys.agent.key, 'hash-1', { jti: `fuzz-${i}` }),
    ...overrides,
  }
}

/** What an ALLOW would report, so a failure is diagnosable rather than just red. */
function describeAllow(seed: number, decision: GateDecision) {
  return {
    seed,
    decision: decision.decision,
    reasons: decision.reasons.map((r) => r.code),
    failedChecks: decision.checks
      .filter((c) => !c.passed && !c.notApplicable)
      .map((c) => `#${c.n} ${c.code}`),
  }
}

/**
 * Do two JWS strings encode the **same** header, payload and signature *bytes*?
 *
 * ### Why this exists — and it is the one interesting thing this fuzz found
 *
 * Base64url carries six bits per character, and a 64-byte Ed25519 signature is 86 characters: the last
 * character encodes only **two** significant bits, with four padding bits that a decoder ignores. So a bit
 * flip in that final character produces a *different string* that decodes to *identical signature bytes*.
 *
 * `jose` verifies such a token — correctly, because it really is the same signed message with the same
 * signature — and the Gate therefore ALLOWs it. That is **not** a bypass and there is nothing to exploit:
 * the header, the claims and the signature are all bit-for-bit what they were, so the token authorises
 * precisely what the original authorised. Two spellings of the same authority.
 *
 * ### What that means for the assertion
 *
 * Excluding these by index or by "mutations that ALLOW" would defeat the point. So the fuzz asserts the
 * **precise** claim instead: an ALLOW is only acceptable if the mutated token is *byte-identical after
 * decoding* to the one that was signed. Any ALLOW of a semantically different token is still a critical
 * finding, and the failure message says which of the two it was.
 */
function sameSignedContent(a: string, b: string): boolean {
  const left = a.split('.')
  const right = b.split('.')
  if (left.length !== 3 || right.length !== 3) return false
  for (let i = 0; i < 3; i++) {
    if (Buffer.from(left[i]!, 'base64url').equals(Buffer.from(right[i]!, 'base64url'))) continue
    return false
  }
  return true
}

/**
 * A world with **real** signature verification.
 *
 * `signWithRealChain` is not optional here: see the module header. With the accepting default, a bit flip in
 * a JWS *header* — which carries `alg`/`kid`/`typ` and no claim the Gate cross-checks — would leave every
 * check passing, and the fuzz would report an ALLOW that is an artefact of the harness rather than a
 * property of the Gate.
 */
async function fuzzWorld(): Promise<World> {
  return makeWorld({ capMinor: 1_000_000n, signWithRealChain: true })
}

describe('AT-M10.6 — 1,000 fuzzed L3 mutations produce 0 ALLOWs', () => {
  /**
   * The two fuzz tests do real cryptographic work: 1,000 Ed25519 verifications each, ~10–13 s for the
   * file.
   *
   * They ran under vitest's shared 5 s `testTimeout`, so they passed when the file ran alone and
   * **timed out whenever the 48-file root suite loaded the CPU** — reporting
   * `Test timed out in 5000ms`, not a failed assertion. A timeout here reads like a broken invariant,
   * sends someone hunting a signature-verification bypass that does not exist, and is the kind of flake
   * that gets "fixed" by deleting the test.
   *
   * So the timeout is explicit, generous, and the reason is written down. A test that takes as long as
   * the work it does — and says so — is a test a future reader can trust.
   */
  const CRYPTO_HEAVY_MS = 120_000

  it(
    'never ALLOWs a mutated L3a, whatever bit was flipped',
    { timeout: CRYPTO_HEAVY_MS },
    async () => {
      const world = await fuzzWorld()
      // "counters", as a 32-bit seed: 0x636f756e = 1668246894. The 64-bit spelling
      // 0x636f_756e_7465_7273 is above Number.MAX_SAFE_INTEGER and loses precision.
      const random = makeRandom(0x636f_756e)
      const allowed: ReturnType<typeof describeAllow>[] = []
      let mutated = 0

      for (let i = 0; i < MUTATIONS; i++) {
        const seedInput = await signedInput(world, i)
        const mutatedL3a = flipBit(seedInput.l3a, random)
        if (mutatedL3a !== seedInput.l3a) mutated++

        const result = await evaluate({ ...seedInput, l3a: mutatedL3a }, world.deps)
        if (!result.ok) continue
        if (result.value.decision !== 'ALLOW') continue
        // An ALLOW is only acceptable if the mutation did not change what was actually signed. See
        // `sameSignedContent` for the base64url trailing-bits case this excludes, and why it is not a bypass.
        if (sameSignedContent(mutatedL3a, seedInput.l3a)) continue
        allowed.push(describeAllow(i, result.value))
      }

      // **The assertion.** Zero mutations that changed the signed content produced an ALLOW.
      expect(
        allowed,
        'a mutation that changed the signed content produced an ALLOW: a signature is not being verified',
      ).toEqual([])
      // The mutations were real. If `mutated` were 0 the loop proved nothing.
      expect(mutated).toBeGreaterThan(MUTATIONS * 0.99)
    },
  )

  it('the one ALLOW a bit-flip can produce is a non-canonical spelling of the same signature', async () => {
    // The finding, pinned so it cannot be forgotten. See `sameSignedContent`: a 64-byte Ed25519 signature
    // is 86 base64url characters, the last of which carries two significant bits and four padding bits a
    // decoder ignores. Flipping a padding bit yields a *different string* with *identical bytes*.
    //
    // Both properties are asserted, because together they are the whole argument that this is not a bypass:
    // the string differs, the bytes do not, and therefore nothing about what the token authorises changed.
    const world = await fuzzWorld()
    const seedInput = await signedInput(world, 0)
    const signature = seedInput.l3a.split('.')[2]!

    // Find the last character that has at least one padding bit free.

    // Find a byte-equivalent respelling by searching the whole base64url alphabet, not a guessed list.
    // 64 bytes is 512 bits; 86 base64url characters carry 516, so the last character's low four bits are
    // padding a decoder discards. Sixteen spellings therefore exist for any signature, and which of them a
    // given signature starts on depends on its own value — so the search asks rather than assumes.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const originalBytes = Buffer.from(signature, 'base64url')
    const respelled = [...ALPHABET]
      .map((c) => `${signature.slice(0, -1)}${c}`)
      .find((cand) => cand !== signature && Buffer.from(cand, 'base64url').equals(originalBytes))

    expect(respelled, 'no byte-equivalent respelling of the signature exists').toBeDefined()
    if (!respelled) return

    // It really is a different string…
    expect(respelled).not.toBe(signature)
    // …with identical bytes.
    expect(Buffer.from(respelled, 'base64url').equals(Buffer.from(signature, 'base64url'))).toBe(
      true,
    )
    // …and the Gate allows it, because it is the same authority.
    const mutated = `${seedInput.l3a.split('.').slice(0, 2).join('.')}.${respelled}`
    const result = await evaluate({ ...seedInput, l3a: mutated }, world.deps)
    expect(result.ok && result.value.decision).toBe('ALLOW')
    expect(sameSignedContent(mutated, seedInput.l3a)).toBe(true)
  })

  it(
    'never ALLOWs a mutated L3b — check 5 binds it and check 4 verifies the pair',
    { timeout: CRYPTO_HEAVY_MS },
    async () => {
      const world = await fuzzWorld()
      const random = makeRandom(0x6c33_6230_6261)
      const allowed: ReturnType<typeof describeAllow>[] = []

      for (let i = 0; i < MUTATIONS; i++) {
        const seedInput = await signedInput(world, i)
        const mutatedL3b = flipBit(seedInput.l3b, random)
        const result = await evaluate({ ...seedInput, l3b: mutatedL3b }, world.deps)
        if (!result.ok) continue
        if (result.value.decision !== 'ALLOW') continue
        if (sameSignedContent(mutatedL3b, seedInput.l3b)) continue
        allowed.push(describeAllow(i, result.value))
      }

      expect(
        allowed,
        'a mutation of the L3b content produced an ALLOW: the binding is not checked',
      ).toEqual([])
    },
  )

  it('the unmutated, genuinely signed token ALLOWs', async () => {
    // The control. Without it, "0 ALLOWs" is equally consistent with "the Gate refuses everything", which
    // would satisfy every assertion above while being completely broken.
    const world = await fuzzWorld()
    const result = await evaluate(await signedInput(world, 0), world.deps)

    expect(result.ok && result.value.decision).toBe('ALLOW')
  })

  it('a one-bit change anywhere in a signed L3a is caught by check 4 specifically', async () => {
    // Proves the fuzz is being caught by *signature verification* and not incidentally. One flip per
    // segment, and each must land on check 4 — which is where `/v1/verify` reports it. The **header** case
    // is the one that fails against an accepting double, which is why it is asserted explicitly.
    const world = await fuzzWorld()
    const seedInput = await signedInput(world, 0)
    const segments = seedInput.l3a.split('.')

    for (const [index, segment] of segments.entries()) {
      const bytes = Buffer.from(segment, 'utf8')
      bytes[2] = bytes[2]! ^ 0x04
      const parts = [...segments]
      parts[index] = bytes.toString('utf8')

      const result = await evaluate({ ...seedInput, l3a: parts.join('.') }, world.deps)
      expect(result.ok, `segment ${index}`).toBe(true)
      if (!result.ok) continue

      expect(result.value.checks.find((c) => c.n === 4)!.passed, `segment ${index}`).toBe(false)
      expect(result.value.reasons.map((r) => r.code)).toContain('VI_CHAIN_INVALID')
    }
  })

  it('truncating the L3a is refused, not treated as "no claims, therefore fine"', async () => {
    // A shortened token is a *different* token. `decodeL3` returns an error rather than an empty claim set,
    // so checks 6 and 7 report `VI_CHAIN_INVALID` instead of quietly proceeding with nothing to compare.
    const world = await makeWorld()
    const result = await evaluate(input({ l3a: 'a.b' }), world.deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.decision).toBe('BLOCK')
    expect(result.value.reasons.map((r) => r.code)).toContain('VI_CHAIN_INVALID')
  })

  it(
    'every mutation still respects the cap, even when it reaches check 8',
    { timeout: CRYPTO_HEAVY_MS },
    async () => {
      // A second, independent claim: fuzzing must not be able to *overspend* even when it gets past check 4.
      // A mutation that flips `amount_minor` is caught by check 6 — the amount must equal the locked total —
      // and neither direction may leave an over-cap reservation behind.
      const world = await makeWorld({ capMinor: CART_MINOR * 2n, signWithRealChain: true })
      const random = makeRandom(0x616d_6f75_6e74)

      for (let i = 0; i < 200; i++) {
        const seedInput = await signedInput(world, i)
        const result = await evaluate(
          { ...seedInput, l3a: flipBit(seedInput.l3a, random) },
          world.deps,
        )
        if (!result.ok) continue
        const snapshot = world.snapshot()
        expect(snapshot.reserved + snapshot.spent).toBeLessThanOrEqual(snapshot.cap)
      }
    },
  )

  it('a caller cannot make a forged chain pass by claiming chain_valid: true', async () => {
    // The double's ordering, stated as a test: `seed.verify.chain_valid` is applied **after** real signature
    // verification. A test can therefore make a *valid* chain fail, but cannot make a *forged* one pass —
    // which is what keeps the fuzz above meaningful.
    const world = await makeWorld({
      capMinor: 1_000_000n,
      signWithRealChain: true,
      verify: { chain_valid: true, errors: [] },
    })
    const seedInput = await signedInput(world, 0)
    const bytes = Buffer.from(seedInput.l3a.split('.')[2]!, 'utf8')
    bytes[5] = bytes[5]! ^ 0x08

    const forged = [
      seedInput.l3a.split('.')[0],
      seedInput.l3a.split('.')[1],
      bytes.toString('utf8'),
    ].join('.')
    const result = await evaluate({ ...seedInput, l3a: forged }, world.deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.decision).toBe('BLOCK')
    expect(result.value.checks.find((c) => c.n === 4)!.passed).toBe(false)
  })
})
