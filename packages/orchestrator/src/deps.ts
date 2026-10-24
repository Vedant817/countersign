/**
 * The production composition root: the repository adapters and injected ports the orchestrator runs on.
 *
 * Rename-and-forward, like `gateDepsFromRepos` and `orderStoreFromRepos` (§8.0, AGENTS.md rule 8). This
 * file chooses **which** implementations the sequence receives; it adds no policy, no arithmetic and no
 * HTTP. Anything the repository cannot yet supply from the database is either injected through
 * {@link OrchestratorFromReposInput} or recorded in `docs/contract-issues.md` rather than invented here:
 *
 * - gap #1 — there is no `DefenderStore` adapter, so the defender seam is built only when a caller
 *   supplies {@link OrchestratorDefenderParts};
 * - gap #2 — there is no production `Notifier`, so {@link OrchestratorFromReposInput.notifier} defaults
 *   to `nullNotifier`; EC-CAP-5 requires the web app to pass a real one;
 * - gap #3 — `OrderRepoHandles` still names four repo-less members, so `orderStoreFromRepos` needs a
 *   handle set the repository cannot yet build in full;
 * - gap #4 — there is no `MerchantCatalogStore`, so `OrdersDeps.stock` stays undefined and stock is not
 *   checked.
 *
 * Time is one {@link Clock} for every package (§8.0 rule 10): it defaults to `gate.clock`, because the
 * Gate already requires one and two clocks in one decision is a bug waiting to happen.
 */

import type { CatalogReader, CompileDeps } from '@countersign/compiler'
import type { Clock, Logger } from '@countersign/core'
import { fileDispute, ingestDisputeToDefender } from '@countersign/defender'
import { gateDepsFromRepos, type GateRepoHandles } from '@countersign/gate'
import type { BudgetStore } from '@countersign/ledger'
import {
  budgetHooksFromStore,
  defenderRefundsFromOrders,
  defineOrderDeps,
  nullNotifier,
  orderStoreFromRepos,
  type OrderRepoHandles,
  type OrdersDeps,
} from '@countersign/orders'

import { orchestratorStoreFromRepos } from './store'
import { compilerFrom, type DefenderSeam, type FileDeps, type OrchestratorDeps } from './types'

/* ============================================================================================ */
/* 1. The Defender aliases the defender barrel does not export                                   */
/* ============================================================================================ */

/**
 * `@countersign/defender`'s `DefenderDeps`, recovered because the package does not re-export it.
 *
 * Same precedent as {@link FileDeps} in `./types.ts`: `Parameters<typeof …>` cannot drift from the
 * function's real signature, and if WP-15e adds the re-export these aliases become redundant rather
 * than wrong.
 */
export type DefenderDeps = Parameters<typeof ingestDisputeToDefender>[1]

/** `DefenderDeps['store']` — the dispute rows and joins the ingest and the filer read. */
export type DefenderStore = DefenderDeps['store']

/** `DefenderDeps['paypal']` — §8.12's dispute calls. A subset of {@link OrchestratorPayPal}. */
export type DefenderPayPal = DefenderDeps['paypal']

/** `DefenderDeps['refunds']` — the refund adapter §8.12's `REFUND` posture needs. */
export type DefenderRefunds = DefenderDeps['refunds']

/** `DefenderDeps['artefacts']`, without the `undefined` that the optional member carries. */
export type PacketArtefacts = NonNullable<DefenderDeps['artefacts']>

/* ============================================================================================ */
/* 2. The runtime shape                                                                           */
/* ============================================================================================ */

/**
 * The one PayPal client the orchestrator holds: §10.2's order calls plus §8.12's dispute calls.
 *
 * Both halves already exist as `Pick<PayPalClient, …>`, so the intersection is what the real client
 * satisfies structurally — no second declaration of any method's shape (AGENTS.md rule 5).
 */
export type OrchestratorPayPal = OrdersDeps['paypal'] & DefenderPayPal

/**
 * The defender seam **with** the deps it needs, built only when {@link OrchestratorDefenderParts} is
 * supplied.
 *
 * `OrchestratorDeps.defender` is a `DefenderSeam`, because that is all the sequence itself reads.
 * `ingestAndDefend` additionally needs the seam's `deps` (and a `paypal` with `getDispute`), so a caller
 * narrows to this type first; when the binder had no store to build it, the member is `undefined`.
 */
export type OrchestratorDefender = DefenderSeam & {
  readonly deps: FileDeps
}

/**
 * What a caller must inject for the binder to construct the defender seam.
 *
 * `store` and `publicBaseUrl` are the two things the repository cannot produce yet (gap #1); `llm` and
 * `renderPdf` are optional exactly as `FileDeps` makes them, and leaving `llm` out keeps the filer on
 * `templateNote()` (no model key is required to file).
 */
export interface OrchestratorDefenderParts {
  /** `DefenderDeps['store']` — persists disputes, joins, runs and notes. */
  readonly store: DefenderStore
  /** Absolute origin §8.12 uses when it writes buyer-facing links into the case file. */
  readonly publicBaseUrl: string
  /** Evidence-packet artefacts, when the deployment stores them. */
  readonly artefacts?: PacketArtefacts
  /** The filing model, when one is configured. Leave it out for template-only notes. */
  readonly llm?: FileDeps['llm']
  /** The PDF renderer, when one is configured. */
  readonly renderPdf?: FileDeps['renderPdf']
  /** Defaults to the orchestrator logger. */
  readonly logger?: Logger
}

/**
 * Everything the binder cannot source from a repository itself.
 *
 * `gate` and `orders` are the two handle bundles `gateDepsFromRepos` and `orderStoreFromRepos` take;
 * `budget`, `llm`, `catalog` and `paypal` are ports the caller constructs. `budget` is listed
 * separately even though `gate` carries a `budgetStore`, because the orchestrator's own store and the
 * Gate's hooks must see the same implementation.
 */
export interface OrchestratorFromReposInput {
  /** Repositories and ports `gateDepsFromRepos` binds. Its `clock` is the binder's default clock. */
  readonly gate: GateRepoHandles
  /** Repositories `orderStoreFromRepos` binds (gaps #3 and #7 leave this incomplete). */
  readonly orders: OrderRepoHandles
  /** The ledger store `budgetHooksFromStore` wraps. */
  readonly budget: BudgetStore
  /** The compiler's model port — the only package allowed to reach a model (D-018). */
  readonly llm: CompileDeps['llm']
  /** The merchant catalog the compiler projects (§7). */
  readonly catalog: CatalogReader
  /** The real `PayPalClient`, structurally. */
  readonly paypal: OrchestratorPayPal
  /** Supply these to enable `ingestAndDefend`; omit them and `defender` is `undefined` (gap #1). */
  readonly defender?: OrchestratorDefenderParts
  /** Defaults to `nullNotifier` (gap #2). EC-CAP-5 requires the web app to pass a real one. */
  readonly notifier?: OrdersDeps['notify']
  /** Defaults to `gate.clock`, so every package shares one timeline (§8.0 rule 10). */
  readonly clock?: Clock
  /** Stored on the deps and forwarded to the orders and defender legs. */
  readonly logger?: Logger
}

/**
 * What {@link orchestratorDepsFromRepos} returns: `OrchestratorDeps` plus the client and a defender
 * seam that can actually be called.
 *
 * `paypal` is required here (it always is, structurally) and `defender` is narrowed to
 * {@link OrchestratorDefender}, so `ingestAndDefend` can be reached after one `if (!deps.defender)`
 * check.
 */
export interface OrchestratorRuntimeDeps extends OrchestratorDeps {
  /** The same client the orders and defender legs were bound to. */
  readonly paypal: OrchestratorPayPal
  /** The full seam, or `undefined` when {@link OrchestratorFromReposInput.defender} was omitted. */
  readonly defender?: OrchestratorDefender
}

/* ============================================================================================ */
/* 3. The binder                                                                                  */
/* ============================================================================================ */

/**
 * Bind the orchestrator's closed dependency list (§8.0) to its production implementations.
 *
 * A rename-and-forward over `gateDepsFromRepos`, `orderStoreFromRepos`, `budgetHooksFromStore`,
 * `defenderRefundsFromOrders` and `compilerFrom`. It deliberately does not construct repositories: the
 * caller passes function references, so there is still exactly one data-access layer (AGENTS.md rule 8
 * and `docs/contract-issues.md`).
 *
 * The defender seam is composed only when `input.defender` is present. Its refund adapter is built from
 * the **same** `orders` deps returned below, so a dispute refund goes through the idempotent
 * `refundCapture` path rather than a second write path (gap #1).
 */
export function orchestratorDepsFromRepos(
  input: OrchestratorFromReposInput,
): OrchestratorRuntimeDeps {
  const clock = input.clock ?? input.gate.clock

  const orders = defineOrderDeps({
    clock,
    paypal: input.paypal,
    store: orderStoreFromRepos(input.orders),
    budget: budgetHooksFromStore(input.budget),
    notify: input.notifier ?? nullNotifier,
    logger: input.logger,
  })

  const defender: OrchestratorDefender | undefined = input.defender
    ? {
        ingest: ingestDisputeToDefender,
        file: fileDispute,
        deps: {
          clock,
          store: input.defender.store,
          paypal: input.paypal,
          refunds: defenderRefundsFromOrders(orders, input.paypal),
          publicBaseUrl: input.defender.publicBaseUrl,
          artefacts: input.defender.artefacts,
          llm: input.defender.llm,
          renderPdf: input.defender.renderPdf,
          logger: input.defender.logger ?? input.logger,
        },
      }
    : undefined

  return {
    clock,
    compiler: compilerFrom({
      llm: input.llm,
      catalog: input.catalog,
      clock,
    }),
    gate: gateDepsFromRepos(input.gate),
    orders,
    budget: input.budget,
    store: orchestratorStoreFromRepos(),
    defender,
    logger: input.logger,
    paypal: input.paypal,
  }
}
