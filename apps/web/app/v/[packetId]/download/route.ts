/**
 * The raw bundle download — spec §8.18 ("raw tokens downloadable"), **EC-PRIV-3**, WP-18.
 *
 * ## This route is the *other half* of the two-document design, and it is deliberately boring
 *
 * `packages/verifier/src/redact.ts` builds the page's document; this route serves
 * `packages/verifier/src/bundle.ts`'s `buildRawBundleDocument`. No shared code, no shared object, no shared
 * field: the page has `artefacts[].sha256` where this file carries the token strings themselves. That
 * separation is the whole of EC-PRIV-3's design, and it is what stops "redacted" from meaning "hidden behind
 * styling" — because there is no token in the page's JSON to find with view-source.
 *
 * `packages/verifier/test/redact.test.ts` asserts the separation in both directions: nothing raw in the page,
 * nothing redacted-and-lossy in the download.
 *
 * ## What this file legitimately exposes, and why
 *
 * EC-PRIV-3 accepts the raw tokens *because* SD-JWT selectively discloses: an L1 discloses the buyer's email
 * (the vendor asked for it) and an L2 discloses only the mandate claims the merchant and the network each
 * need. So the download is bounded by the **token format** rather than by a filter we wrote — a stronger
 * guarantee, because `verify_chain` enforces it rather than us.
 *
 * It also carries the **public** keys the offline script needs, because `verify_chain` takes the issuer key as
 * an argument and there is nowhere else to get one without asking us. §7.2's `jwks_keys.public_jwk` holds
 * public halves; there is no private key in this system outside a browser's non-extractable keystore or vi's
 * in-memory registry, and nothing here could publish one if there were.
 *
 * ## What it does not do
 *
 * - **No rate limit.** The route is a static read of one jsonb column and costs no crypto; the 30/min/IP budget
 *   is on `POST /v1/public/verify` (§8.3), and metering this would only punish a reader downloading the file
 *   they need in order to check us.
 * - **No PII of its own.** Every buyer field here came out of the token or out of `bundle.buyer`, both of which
 *   are the merchant's own filed packet. This route adds nothing.
 * - **No merchant narrative.** `evidence_packets.notes` is a claim *to* PayPal, not evidence for one, and
 *   mixing it into a file whose purpose is "check this independently" would blur exactly the line this page
 *   exists to keep clear.
 */
import { eq } from 'drizzle-orm'

import { csError, logger, systemClock, type PacketId } from '@countersign/core'
import {
  db,
  disputes,
  evidencePackets,
  jwksKeys,
  repo,
  type DisputeRow,
  type EvidencePacketRow,
  type JwksKeyRow,
} from '@countersign/db'
import { ViClient } from '@countersign/vi-client'
import {
  BUNDLE_VERSION,
  buildRawBundleDocument,
  defineVerifierDeps,
  loadVerifierPacket,
  renderVerifyPy,
  type VerifierDeps,
  type VerifierStore,
  type VerifyPyKey,
} from '@countersign/verifier'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Wiring — the same three reads as the page and the verify-now route.
//
// Duplicated rather than shared because this work package owns three files under `/v/[packetId]/` and nothing
// else (AGENTS.md rule 8). This route also reads `jwks_keys` directly, which is why it has a `503` of its own
// when that read fails: without the public keys the offline script could not verify a single signature, so a
// download without them would look complete and check nothing.
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw csError(
      'CS_INTERNAL',
      `${name} is not set; /v/{packetId}/download cannot be served without it`,
      { env: name },
      { userMessage: 'This download is temporarily unavailable. Please tell the operator.' },
    )
  }
  return value.trim()
}

function store(): VerifierStore {
  return {
    packets: {
      findById: (id) =>
        repo(
          async () => {
            const rows = await db()
              .select()
              .from(evidencePackets)
              .where(eq(evidencePackets.id, id))
              .limit(1)
            return rows[0] as EvidencePacketRow | undefined
          },
          { table: 'evidence_packets', id },
        ),
    },
    disputes: {
      findById: (id) =>
        repo(
          async () => {
            const rows = await db().select().from(disputes).where(eq(disputes.id, id)).limit(1)
            return rows[0] as DisputeRow | undefined
          },
          { table: 'disputes', id },
        ),
    },
    jwks: {
      listAll: () =>
        repo(
          async () => {
            const rows = await db().select().from(jwksKeys)
            return rows as JwksKeyRow[]
          },
          { table: 'jwks_keys' },
        ),
    },
  }
}

function verifierDeps(): VerifierDeps {
  return defineVerifierDeps({
    clock: systemClock,
    store: store(),
    // Never called from this route — it only reads the store — but the port is closed, so the member exists.
    // Constructed with the same config as the other two routes so a future edit cannot make this file the odd
    // one out.
    vi: {
      publicVerify: (req) =>
        new ViClient({
          baseUrl: requiredEnv('VI_SERVICE_URL'),
          token: requiredEnv('VI_SERVICE_TOKEN'),
          clock: systemClock,
          logger: logger.child({ module: 'verifier' }),
        }).publicVerify(req),
    },
    publicBaseUrl: requiredEnv('PUBLIC_BASE_URL'),
    logger: logger.child({ module: 'verifier' }),
  })
}

/**
 * The route's context.
 *
 * **Deliberately not called `RouteContext`.** Next 16 generates a *global* `RouteContext<…>` type from
 * `.next/types`, and a local declaration of the same name shadows it — so the file stopped compiling with
 * "Property 'packetId' does not exist on type 'RouteContext'". Naming it `PacketRouteContext` keeps both
 * available, and naming the one member we need is clearer than inheriting a generic we do not use.
 */
interface PacketRouteContext {
  readonly params: Promise<{ packetId: string }>
}

/**
 * The filename a reader's browser will save.
 *
 * `attachment` plus a `.json` name, because a reader who opens this in a browser must not be tempted to read it
 * as a page: it is data, and the *page* is the place to read it. The name carries the packet id so a
 * chargeback analyst with twelve downloads in their folder can tell them apart.
 */
const FILENAME = /^[A-Za-z0-9_-]{1,64}$/

export async function GET(request: Request, context: PacketRouteContext): Promise<Response> {
  // `context.params` is a Promise in Next 15+: the route is not blocked on it at the type level, so awaiting
  // it here is what makes the id available. `await context` (rather than `await context.params`) is the shape
  // that compiles and then reads `undefined`.
  const { packetId } = await context.params
  const deps = verifierDeps()

  const loaded = await loadVerifierPacket(deps, packetId as PacketId)
  if (!loaded.ok) {
    deps.logger?.error(`download: loading ${packetId} failed: ${loaded.error.message}`)
    return new Response('We could not read that packet just now. Please try again.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  if (loaded.value === undefined) {
    // EC-DSP-9's path: a 404 with a sentence. The `packetId` is echoed **only after** the filename check
    // below, and even then it is a `pkt_` ULID the caller already supplied — reflecting input back is not a
    // disclosure, and refusing to echo it would make the error less useful for no gain.
    return new Response(
      `No evidence packet with the id ${safeId(packetId)}. Nothing can be downloaded for it.`,
      {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      },
    )
  }

  const packet = loaded.value
  const keys = await deps.store.jwks.listAll()
  if (!keys.ok) {
    // Without the public keys the offline script cannot verify a single signature, so a download without them
    // would be worse than none: it would look complete and check nothing. Failing loudly is the honest answer.
    deps.logger?.error(`download: jwks read for ${packetId} failed: ${keys.error.message}`)
    return new Response(
      'We could not publish the public keys this bundle needs. The offline script would be unable to verify ' +
        'any signature without them, so nothing was served.',
      {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      },
    )
  }

  /**
   * Which keys travel in the file.
   *
   * **ISSUER, MERCHANT and GATE, and nothing else.** AGENT keys are excluded on purpose even though they are
   * public: an agent's public key is inside the user-signed L2 already, so publishing it here adds nothing a
   * reader can check and widens the file for no reason. `COMPROMISED` keys are **kept** rather than filtered —
   * `verifyDecisionRecord` fails closed on an unknown `kid`, so an extra entry can never make a bad record
   * verify, while dropping a compromised key would turn "signed with a key we have since revoked" into a
   * silent "no key available". Those are very different sentences to a chargeback analyst.
   */
  const publicKeys: VerifyPyKey[] = keys.value
    .filter((k) => k.role !== 'AGENT')
    .map((k) => ({
      kid: k.kid,
      role: k.role as VerifyPyKey['role'],
      public_jwk: k.public_jwk as Record<string, unknown>,
    }))

  const doc = buildRawBundleDocument({
    packetId: packet.packetId,
    disputeId: packet.disputeId,
    version: packet.version,
    bundleHash: packet.storedBundleHash,
    bundle: packet.bundle,
    filedAtSec: packet.filedAtSec,
    viLibCommit: asString(packet.bundle['vi_lib_commit']) ?? 'unknown',
    publicKeys,
    gateKid:
      asString(packet.bundle['gate_decision']) === null
        ? null
        : kidOf(asString(packet.bundle['gate_decision']) as string),
  })

  /**
   * `?as=verify.py` serves the generated offline script instead of the bundle.
   *
   * **One route rather than two, deliberately.** The script embeds the digests of the bundle it will be run
   * against, so the two artifacts are useless apart: serving one without the other hands a reader something
   * they cannot use. A query parameter makes the pairing structural.
   *
   * The script is generated from the **same** `packet.bundle` in the same request, so the constants it embeds
   * are the digests of the file the reader downloads. That is not a convenience — it is what makes the run
   * falsifiable, and a mismatch between the two would be a silent, total failure of the page's purpose.
   */
  if (wantsScript(request)) {
    const script = renderVerifyPy({
      packetId: packet.packetId,
      bundle: packet.bundle,
      bundleHashHex: packet.storedBundleHash,
      keys: publicKeys,
      gateKid: doc.gate_kid,
    })
    return new Response(script, {
      status: 200,
      headers: {
        // `text/x-python` rather than `text/plain`: some browsers would otherwise render it as a page, and a
        // rendered "code block" is exactly what §8.18's file is *not* — the reader must be able to save and
        // run it.
        'content-type': 'text/x-python; charset=utf-8',
        'content-disposition': 'attachment; filename="verify.py"',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  const filename = `${FILENAME.test(packet.packetId) ? packet.packetId : 'packet'}-bundle.json`
  return new Response(`${JSON.stringify(doc, null, 2)}\n`, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // The digest is in the body, so a proxy cache would only add a stale copy of a filed artifact. A packet
      // row is immutable once filed, but `no-store` is still the right default for a public document.
      'cache-control': 'no-store',
      // Belt and braces beside the redaction guard: a browser must never sniff this into an HTML context,
      // where a `<script>` inside a token string would execute on our origin.
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      // The bundle version, so a future reader can tell which rule produced these digests.
      'x-countersign-bundle-version': BUNDLE_VERSION,
    },
  })
}

/** A non-empty string, or `null`. §7.3's bundle is a jsonb mirror, so nothing here is shape-checked upstream. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Did the reader ask for the offline script?
 *
 * **Case-insensitive and whitespace-tolerant**, because this string appears in a hand-written link on the
 * page and in a `curl` a reader types. A strict `=== 'verify.py'` would fall through to serving the bundle for
 * `?as=Verify.py`, which looks like a broken download rather than a typo.
 */
function wantsScript(request: Request): boolean {
  const as = new URL(request.url).searchParams.get('as')
  return typeof as === 'string' && as.trim().toLowerCase() === 'verify.py'
}

/** The `kid` a JWS header names, or `null`. Read locally so this route needs no extra import. */
function kidOf(token: string): string | null {
  try {
    const header: unknown = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    )
    if (typeof header !== 'object' || header === null) return null
    const kid = (header as { kid?: unknown }).kid
    return typeof kid === 'string' ? kid : null
  } catch {
    return null
  }
}

/** Echo an id back only if it is the shape we minted, so the 404 cannot reflect arbitrary input. */
function safeId(value: string): string {
  return FILENAME.test(value) ? value : 'that id'
}
