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
import { describe, expect, it } from 'vitest'

import { demoCases } from './defender-demo'

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
