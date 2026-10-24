import 'server-only'

import { ok, type CsError, type Currency, type Result, type UserId } from '@countersign/core'
import { compile, type CatalogReader, type CompiledMandate } from '@countersign/compiler'

import { languageModel } from './llm'
import { merchantIdentity } from './merchant'
import { shopCatalog } from '../app/shop/catalog'

/**
 * The compiler's call site — the first place a buyer's own words reach a model.
 *
 * ## What this file is, and is not
 *
 * `packages/compiler` owns every rule: the prompts, the structured-output schema, the one repair
 * retry, the deterministic localisation into VI constraints, the ambiguity when an intent answers no
 * amount cap. None of that is re-implemented here. This file supplies the three things `compile` asks
 * for and nothing else:
 *
 *  - **`llm`** — resolved from configuration by `./llm`, so the model in use is a deployment fact
 *    rather than a constant. Absent credentials are a refusal, and EC-LLM-1's fallback (the manual
 *    constraint form) is the registry copy the buyer already reads.
 *  - **`catalog`** — the compiler's only view of the world, projected from the store it actually sells
 *    from. A separate catalog would let the compiler constrain a buyer to a merchant or a price the
 *    shop does not have.
 *  - **`clock`** — injected so a mandate's expiry is a value in a test rather than a race.
 *
 * ## Why the merchant comes from configuration
 *
 * The projection names the merchant this deployment sells as, read from the same `MERCHANT_*`
 * variables the checkout signs with. A hardcoded name here would be a second source of truth for the
 * merchant inside a signed mandate — and if the two disagreed, the mandate would authorise a store the
 * checkout refuses. That is the D-040 shape, so it is read once from one place.
 */
export interface CompileIntentInput {
  readonly userId: UserId
  readonly text: string
  readonly locale?: 'en-IN' | 'en-US'
  readonly currency?: Currency
}

/** The store, projected into the compiler's vocabulary. One merchant, because that is who we sell as. */
export function shopCatalogReader(): CatalogReader {
  return {
    async read() {
      const products = await shopCatalog.listProducts()
      if (!products.ok) return products

      const merchant = merchantIdentity()
      if (!merchant.ok) return merchant

      return ok({
        merchants: [
          {
            id: merchant.value.id,
            name: merchant.value.name,
            website: merchant.value.website,
          },
        ],
        skus: products.value.map((product) => ({
          id: product.sku,
          title: product.title,
          merchantId: merchant.value.id,
          // `price` is core's `Money` (integer minor units plus its own currency). Reading `.minor`
          // rather than a currency-less number is the whole reason money is a type here.
          priceMinor: product.price.minor,
          currency: product.currency,
          // `stock > 0` rather than a status column: the shop's own answer to "can I buy this" is the
          // stock number, and a second interpretation of it would drift.
          inStock: product.stock > 0,
        })),
      })
    },
  }
}

/**
 * Compile a buyer's request into a proposed mandate.
 *
 * Returns `Result` throughout: an unreachable model is `LLM_UNAVAILABLE`, an unusable answer is
 * `LLM_SCHEMA`, and neither is ever a throw (AGENTS.md rule 3). The UI's job is to render whichever
 * sentence comes back, and EC-LLM-1 already says what the buyer should do about the first.
 *
 * ## The model is optional, and that is the point (P0-7)
 *
 * `packages/compiler` reads money, currency, cadence, merchants and dates from the buyer's own sentence
 * with deterministic code, and consults a model only for the one gap a reader cannot fill: a sentence
 * that states a limit but names no product (`"something warm for the trip, under $100"`). So a missing
 * provider is **not** a missing compiler — a deployment with no `OPENAI_API_KEY` still compiles
 * "Spend at most $50 on shoes", byte-identically, every time. Passing no `llm` is how this call site says
 * that; requiring one would turn "no key" into "503", which is the failure mode the judge panel found
 * (`docs/review/VERDICT.md`, the AI/agents engineer's note).
 */
export async function compileIntent(
  input: CompileIntentInput,
): Promise<Result<CompiledMandate, CsError>> {
  if (input.text.trim() === '') {
    return {
      ok: false,
      error: {
        code: 'CS_VALIDATION',
        message: 'An intent is required.',
        userMessage: 'Tell us what you would like to buy.',
        retryable: false,
      },
    }
  }

  const model = languageModel()

  // One read, narrowed once: calling `merchantIdentity()` twice would let the two results disagree if
  // the environment changed between them, and this value ends up inside a signed mandate.
  const merchant = merchantIdentity()

  return compile(
    {
      userId: input.userId,
      text: input.text,
      locale: input.locale ?? 'en-IN',
      defaults: {
        // The store prices in USD; a currency the buyer named in words still wins (`resolveCurrency`).
        currency: input.currency ?? 'USD',
        merchantIds: merchant.ok ? [merchant.value.id] : [],
      },
    },
    {
      // Absent credentials mean no second reader, not no answer. See the note above.
      ...(model.ok ? { llm: model.value } : {}),
      catalog: shopCatalogReader(),
      clock: { nowSec: () => Math.floor(Date.now() / 1000) },
    },
  )
}
