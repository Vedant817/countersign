/**
 * `/disputes` — the fixture view must render as text, never as an object.
 *
 * The regression these tests exist for: `citation.artefact` is a `ClaimArtefact` **object**
 * (`{ id, kind, description }`, `packages/defender/src/citation-check.ts`), and the page used to render
 * it directly. React cannot render an object, so `apps/web/lib/defender-demo.ts` flattened it with
 * `String(c.artefact)` → `"[object Object]"`, and a judge (and a PayPal adjudicator) read
 * `“…the purchase was authorised” ← [object Object]` fifteen times on the packet's own page.
 *
 * So the assertion is on the *shape of the view*, not on a snapshot: every cited artefact must carry a
 * usable, non-empty `id` that names the §7.3 bundle member, and serialising the whole view must never
 * contain the string `[object Object]`. The second assertion is the one that would have failed before
 * the fix, whatever object got smuggled into the view next.
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'
import type { LanguageModel as AiLanguageModel } from 'ai'

import { defenderDraftPort, demoCasePdf, demoCases } from './defender-demo'

const PUBLIC_BASE_URL = 'https://merchant.example.test'

describe('the dispute demo view', () => {
  it('renders every citation artefact as an id a reader can act on (no [object Object])', async () => {
    const cases = await demoCases(PUBLIC_BASE_URL)

    // The page a judge reads. Every case, not just the one that happens to be first.
    expect(cases.map((c) => c.id)).toEqual(['unauthorised', 'agent-fault'])

    const contested = cases.find((c) => c.draft !== null)
    expect(contested?.draft).not.toBeNull()

    for (const c of cases) {
      for (const citation of c.draft?.citations ?? []) {
        expect(citation.artefact.kind.length).toBeGreaterThan(0)
        expect(citation.artefact.description.length).toBeGreaterThan(0)
        // §7.3's bundle ids: `l1` | `l2` | `l3` | `gate:<id>` | `tracking:<id>` | `capture:<id>` |
        // `refund:<id>` | `checkout:<id>`. A bare object string would not match any of these.
        expect(citation.artefact.id).toMatch(
          /^(l1|l2|l3|gate:.+|tracking:.+|capture:.+|refund:.+|checkout:.+)$/,
        )
      }
    }

    // The exact failure mode: an object reaching a renderer. Serialised, it is unambiguous.
    expect(JSON.stringify(cases)).not.toContain('[object Object]')
  })

  it('shows the disputed amount once, with the currency symbol (no $$128.00)', async () => {
    const cases = await demoCases(PUBLIC_BASE_URL)

    for (const c of cases) {
      expect(c.dispute.amount).toMatch(/^\$[\d,]+\.\d{2}$/)
      expect(c.dispute.amount.startsWith('$$')).toBe(false)
    }
  })
})

describe('the render cache', () => {
  it('serves one render per case, so the page and the download route cannot disagree', async () => {
    // Two reads, one pipeline. The second call must not recompute: a recompute would produce a *different*
    // PDF (the clock moved), and the digest the page printed would no longer be the digest of the bytes the
    // download route serves — which is exactly what the QR on the packet verifies.
    const [first] = await demoCases(PUBLIC_BASE_URL)
    const [again] = await demoCases(PUBLIC_BASE_URL)
    expect(first).toBeDefined()
    expect(again).toBe(first)

    const pdf = await demoCasePdf('unauthorised', PUBLIC_BASE_URL)
    expect(pdf).not.toBeNull()
    expect(first?.pdf).not.toBeNull()

    // The property stated as a digest, not as object identity: what the page reports is what the route
    // serves, byte for byte.
    const served = createHash('sha256').update(pdf!).digest('hex')
    expect(served).toBe(first?.pdf?.sha256)
  })
})

describe('the drafter model adapter', () => {
  it('aborts a model call that never answers, instead of hanging the page (§8.6)', async () => {
    // The property under test: the port hands the AI SDK a deadline, and the SDK hands the provider's
    // `doGenerate` the signal. A port that omitted `abortSignal` would leave this promise pending forever
    // and the test would fail on vitest's own timeout — which is the same failure a real reader would see
    // as a page that never renders.
    let sawSignal = false
    const hanging = {
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'never-answers',
      supportedUrls: {},
      doGenerate: async (options: { abortSignal?: AbortSignal }) => {
        sawSignal = options.abortSignal !== undefined
        return await new Promise<never>((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () =>
            reject(new Error('aborted by the drafter deadline')),
          )
        })
      },
    } as unknown as AiLanguageModel

    const port = defenderDraftPort(hanging, 25)
    const startedAt = Date.now()
    await expect(port.generateText({ system: 's', prompt: 'p' })).rejects.toThrow(/aborted/)
    const elapsedMs = Date.now() - startedAt

    expect(sawSignal, 'the provider was never given an AbortSignal').toBe(true)
    expect(elapsedMs).toBeGreaterThanOrEqual(20)
    // Not "eventually": a deadline that fires in the next hour is not a deadline for a page request.
    expect(elapsedMs).toBeLessThan(2_000)
  })
})
