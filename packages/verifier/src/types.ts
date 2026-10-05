/**
 * The public verifier's contracts — spec **§8.18 (M18)**, screen **S-20**, work package **WP-18**.
 *
 * ## The one property this package is built to protect
 *
 * > **A reader who does not trust us must still get a true answer.**
 *
 * Every decision below follows from that sentence, and three of them are worth stating up front because
 * they are the ones a reviewer will look for:
 *
 * 1. **The redaction is applied to what is *served*, not to what is *displayed*.** The redacted view and
 *    the raw download are two different documents, built by two different functions in two different
 *    modules, and `assertRedactionHolds` re-checks the served redacted document against the raw one on
 *    every render. If the raw L1/L2/L3 ever ended up in the same JSON the page renders, view-source
 *    would reveal the buyer's email — which is EC-PRIV-3's exact failure.
 * 2. **A check's failure is a value, never an exception.** `/v1/verify` "never 4xxes on an invalid chain"
 *    (§8.3) and neither does this page: a tampered bundle produces a page full of `FAIL` rows, because a
 *    reader who cannot see *which* check failed cannot judge whether the failure matters.
 * 3. **Known limitations are shown, not omitted.** `at_time_not_honoured` (D-009) and every
 *    `constraints.skipped` entry (D19) are rendered prominently. A verifier that quietly drops a known
 *    limitation lends false confidence to exactly the reader it exists to reassure.
 *
 * ## Ports, not globals
 *
 * `VerifierDeps` is closed and has four members: a {@link Clock}, a {@link VerifierStore}, a
 * {@link VerifierVi} and the public base URL. That is what lets every test in this package run with no
 * database, no vi-service and no network — the `ViClient` already takes a `fetchImpl`, and the store is a
 * plain interface. There is no LLM member, and there is no `process.env` read anywhere in `src/`: §6
 * validates the environment once, at boot.
 */

import type { Clock, CsError, DisputeId, Logger, PacketId, Result } from '@countersign/core'
import type { DisputeRow, EvidencePacketRow, JwksKeyRow } from '@countersign/db'
import type { PublicVerifyRequest, PublicVerifyResponse } from '@countersign/vi-client'

// ---------------------------------------------------------------------------
// The store port
// ---------------------------------------------------------------------------

/**
 * The three tables the public verifier reads.
 *
 * Deliberately three, and deliberately read-only. The page is public and unauthenticated, so every member
 * here is a `SELECT` behind a narrow predicate: `packets.findById` takes a primary key, `disputes.findById`
 * exists only to label the page, and `jwks.listAll()` returns **public** keys.
 *
 * ### `jwks.listAll()` and why the whole table is acceptable here
 *
 * §7.2's `jwks_keys` holds `public_jwk` — public halves, by definition — and `GET /v1/jwks` already
 * publishes the same set. `COMPROMISED` keys are **kept** rather than filtered: a verifier that silently
 * dropped a compromised key would let a packet signed by it report "no key available" instead of "signed
 * with a key we have since revoked", and those are very different sentences to a chargeback analyst.
 * `verifyDecisionRecord` fails closed on an unknown `kid`, so an extra entry can never make a bad record
 * verify.
 *
 * ### Why there is no `evidence.corpus`-style member
 *
 * `packages/defender`'s port has two members no repository can produce, and it documents that gap rather
 * than inventing an answer (`ingest.ts`, file header). This port has no such member because nothing on
 * S-20 needs one: the page answers "is this chain what you say it is", not "do we have the documents".
 */
export interface VerifierStore {
  packets: {
    /** `repos/disputes.ts::findEvidencePacketById` — the one row `/v/{packetId}` is about. */
    findById(id: PacketId): Promise<Result<EvidencePacketRow | undefined, CsError>>
  }
  disputes: {
    /** `repos/disputes.ts::findDisputeById`. Used only to label the page; a missing row is not fatal. */
    findById(id: DisputeId): Promise<Result<DisputeRow | undefined, CsError>>
  }
  jwks: {
    /**
     * Every row in `jwks_keys`, newest `kid` order.
     *
     * Names a repository that exists in production terms but is **not yet written** — see the
     * `docs/contract-issues.md` entry in `README.md`. Until it lands, an adapter may satisfy this member
     * from `GET /v1/jwks`; that is a legitimate implementation because the data is the same public data.
     */
    listAll(): Promise<Result<JwksKeyRow[], CsError>>
  }
}

/**
 * The one vi-service call the public page makes: `POST /v1/public/verify`.
 *
 * A **`Pick` of the real `ViClient`**, not a re-declaration, for the reason `packages/orders` documents:
 * the real client satisfies this structurally, so a test injects `fetchImpl` and drives the real request
 * building, retry policy and zod validation. AGENTS.md rule 5 forbids faking upstream behaviour, and this
 * is the seam that makes that possible without a mock.
 *
 * Note what is *absent*: no `Authorization` header, no secret, and no request body member a reader could
 * not already see in the downloaded bundle. The route is public by design (§8.3) and this page is the
 * only thing behind it.
 */
export interface VerifierVi {
  publicVerify(req: PublicVerifyRequest): Promise<Result<PublicVerifyResponse, CsError>>
}

/** The verifier's entire world. Closed on purpose: there is no language-model member. */
export interface VerifierDeps {
  /** The only time source (AGENTS.md engineering rule 10). */
  readonly clock: Clock
  readonly store: VerifierStore
  readonly vi: VerifierVi
  /** §6's `PUBLIC_BASE_URL`. The only host the page may name. */
  readonly publicBaseUrl: string
  /** Optional. Never for content — every sentence on this page is a composed value. */
  readonly logger?: Logger
}

/** Type-check a complete `VerifierDeps` and refuse to build one with a hole in it. */
export function defineVerifierDeps(deps: VerifierDeps): VerifierDeps {
  return deps
}

// ---------------------------------------------------------------------------
// What the page shows
// ---------------------------------------------------------------------------

/**
 * A single check's verdict, as **text**.
 *
 * §8.18 says the page "shows the per-check result", and the accessibility requirement is that the result
 * is text rather than a colour or an icon: this is a public page read by somebody debugging a payment
 * dispute, frequently on a phone, possibly with a screen reader, and "the card is red" conveys nothing.
 * `status` is what a `<ul>` item's text says; the colour is decoration on top of it.
 */
export type CheckStatus =
  /** The check ran and agreed. */
  | 'PASS'
  /**
   * The check ran and disagreed. **This is the interesting case** and the reason this type is a value and
   * not a boolean: a reader must be able to see *which* check failed and *why*, because "the verifier is
   * red" is not a judgement anyone can act on.
   */
  | 'FAIL'
  /**
   * The check could not be conclusive, and we say why.
   *
   * Two real sources: D-009's `at_time_not_honoured` (the pinned library has no clock override, so an
   * as-of verdict is impossible and vi refuses to fake one), and a signature that falls outside its
   * validity window — an *expired* chain is not a *tampered* chain, and treating it as tampering would
   * make every old packet look like an attack.
   */
  | 'WARN'
  /** The check needs material this packet does not carry. Named, never silent. */
  | 'SKIPPED'

/**
 * What kind of question a check asks.
 *
 * The categories exist so the page can group them, and so a judge's question ("which of these is
 * cryptographic?") has a one-line answer. They are also the per-field categories AT-M18.1 is tested
 * against.
 */
export type CheckCategory =
  /** A digest recomputed from the served document. Detects any edit. */
  | 'integrity'
  /** A required member is present. EC-MER-6's anti-omission half. */
  | 'schema'
  /** Two members must agree with each other. Catches a consistent-looking forgery. */
  | 'binding'
  /** A signature was checked against a public key. */
  | 'signature'
  /** vi-service's own verdict, from `POST /v1/public/verify`. */
  | 'chain'

/** Where a verdict came from, so the page can say "computed here" versus "asked of vi-service". */
export type CheckSource =
  /** Recomputed in this process from the document being served. No network. */
  | 'local'
  /** Returned by `POST /v1/public/verify`. */
  | 'vi-service'

/** One row of the per-check table. */
export interface VerifierCheck {
  /** A stable machine id (`'bundle_hash'`, `'custom_id'`, `'at_time'`…), used by tests and by the page's anchors. */
  readonly id: string
  readonly category: CheckCategory
  /** A short noun phrase naming what is being checked. */
  readonly label: string
  readonly status: CheckStatus
  /** The reason, in a sentence a non-engineer can act on. Never empty. */
  readonly detail: string
  readonly source: CheckSource
  /**
   * `spec §7.3`, `§12 EC-…`, or a decision id — so a reader can find the requirement this check enforces
   * rather than taking our word for why it matters.
   */
  readonly authority?: string
}

/** The page model: everything S-20 renders, and nothing that depends on a browser. */
export interface VerifierReport {
  /** The only identifier on the page. There is no user id, no order id and no internal volume counter. */
  readonly packetId: PacketId
  readonly disputeId: DisputeId
  readonly version: number
  /** `filed_at` in epoch seconds, or `null` for a packet that has not been filed yet. */
  readonly filedAtSec: number | null
  readonly createdAtSec: number
  /** `disputes.amount_minor` + `currency`. Integer minor units end to end (§0). */
  readonly amount: { readonly minor: bigint; readonly currency: string }
  readonly stage: string
  readonly status: string
  readonly checks: readonly VerifierCheck[]
  /** D-009's disclosure. Rendered as a banner; never folded into a passing check. */
  readonly atTimeWarning: string | null
  /** Everything vi-service reported but did **not** evaluate (spec D19). Named on the page. */
  readonly skippedByVerifier: readonly string[]
  /** The canonicalisation rule, spelled out so a third party can reproduce the hash. */
  readonly canonicalisation: {
    readonly spec: string
    readonly algorithm: string
    readonly hashedMembers: readonly string[]
    readonly excludedFromCustomId: readonly string[]
    readonly note: string
  }
}

/**
 * The offline half of the page: what can be established with no server of ours running.
 *
 * `reported` is what vi-service said, if the reader pressed "Verify now". It is a `Result` rather than a
 * field so that "we did not ask" and "we asked and it failed" cannot be confused on the page — the first
 * renders nothing, the second renders an explanation.
 */
export interface VerifierReportResult {
  readonly report: VerifierReport
  readonly reported: Result<PublicVerifyResponse, CsError> | null
}
