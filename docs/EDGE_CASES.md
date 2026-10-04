# EDGE_CASES — the §12 catalogue, mapped to code and tests

<!-- GENERATED FILE — do not edit by hand. -->
<!-- Source of truth: docs/edge-cases.json (extracted from the spec by
     scripts/gen-edge-cases.mjs). Test references come from a live scan of the test
     tree by scripts/ec-coverage.mjs. Edit `status`, `blockedReason` and `notes` in
     docs/edge-cases.json, then run `pnpm test:ec`. -->

_Generated 2026-10-04 07:23Z._

| Metric | Value |
|---|---|
| Edge cases in spec §12 | **109** |
| Cases with at least one referencing test | **24** |
| Cases fully `done` (test present + status done) | **12** |
| Cases `blocked` (needs live sandbox / human step) | **1** |
| Total test references | **221** |

A test claims a case by naming it in the test title or in a comment on the line above,
e.g. `it('EC-CAP-1 …')` or `// EC-WH-4 forged webhook`.


## §12.1 Captures, refunds and partial refunds

Owning work package(s): `WP-11` · module: `M11 orders` · spec line 1069

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-CAP-1** | Partial capture (one of two shipments) | captureAuthorization with an allocated amount, final_capture=false; the remainder stays authorized | S | `packages/core/test/core.test.ts:196` — splitting a shipment order sums to the authorized amount (spec EC-CAP-1/2)<br>`packages/core/test/core.test.ts:197`<br>`packages/core/test/core.test.ts:198` | todo — 3 tests |
| **EC-CAP-2** | Final partial capture leaves money uncaptured | Capture with final_capture=true; PayPal releases the rest [B12]; ledger RELEASEs the remainder | S | — | todo — no test |
| **EC-CAP-3** | Capture exceeds the authorized amount | Rejected locally (CS_VALIDATION) before calling PayPal; a higher amount needs a new mandate-checked attempt | U | — | todo — no test |
| **EC-CAP-4** | Capture PENDING (eCheck / review) | State PENDING; ship nothing until PAYMENT.CAPTURE.COMPLETED (or the reconciler) | I | — | todo — no test |
| **EC-CAP-5** | Capture DECLINED | Budget RELEASE; order PAYMENT_FAILED; notify the user; no automatic retry with another instrument (the mandate binds one instrument) | I | — | todo — no test |
| **EC-REF-1** | Partial refund | refundCapture({amount}), PayPal-Request-Id = cs:{cap}:ref:{refId} | S | — | todo — no test |
| **EC-REF-2** | Multiple partial refunds summing above the capture | Rejected locally; PayPal would also reject | U | `packages/db/test/schema.test.ts:452` — captures: refunded_minor can never exceed amount_minor (EC-REF-2 backstop)<br>`packages/db/test/schema.test.ts:453`<br>`packages/db/test/schema.test.ts:454` | todo — 3 tests |
| **EC-REF-3** | Refund PENDING / FAILED | Retry once after 1 h with a new refund ID if FAILED (never reuse a failed refund's request ID with a different body); otherwise escalate to manual | I | — | todo — no test |
| **EC-REF-4** | Refund requested after a dispute is open | Block direct refunds; route through accept-claim/make-offer so PayPal records the resolution in the case | U | — | todo — no test |
| **EC-REF-5** | Refund of a multi-currency or rounding remainder | allocate() largest-remainder; the last refund takes the exact remainder | P | — | todo — no test |

## §12.2 Duplicates, retries and idempotency

Owning work package(s): `WP-06, WP-10, WP-11` · module: `M6/M10/M11` · spec line 1084

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-IDEM-1** | Agent submits the same checkout twice (LLM retry) | Unique l3_jti → second gets GATE_REPLAY; the same checkout with a new L3 returns the existing attempt/order if one is in flight | PU | `packages/db/test/schema.test.ts:2`<br>`packages/db/test/schema.test.ts:3`<br>`packages/db/test/schema.test.ts:4`<br>`packages/db/test/schema.test.ts:308`<br>`packages/db/test/schema.test.ts:309`<br>`packages/db/test/schema.test.ts:310`<br>`packages/db/test/schema.test.ts:312` — EC-IDEM-1: checkout_attempts has UNIQUE (l3_jti) and UNIQUE (idempotency_key)<br>`packages/db/test/schema.test.ts:313`<br>`packages/db/test/schema.test.ts:314` | done |
| | _note:_ packages/db (WP-02). packages/db/src/schema.ts checkout_attempts UNIQUE (l3_jti) -> checkout_attempts_l3_jti_key and UNIQUE (idempotency_key); packages/db/src/repos/index.ts toRepoError maps 23505 on that constraint to GATE_REPLAY and on idempotency_key to CS_CONFLICT (AT-M2.4); packages/db/src/repos/attempts.ts findAttemptByL3Jti / findAttemptByCheckoutAndMandate; packages/db/test/schema.test.ts 'EC-IDEM-1: checkout_attempts has UNIQUE (l3_jti) and UNIQUE (idempotency_key)' plus 'AT-M2.4'. STILL OPEN: the live replay race needs a database and belongs to WP-10. | | | | |
| **EC-IDEM-2** | Our server times out after PayPal created the order | Retry with the same PayPal-Request-Id [B14]; PayPal returns the earlier result | I | — | todo — no test |
| **EC-IDEM-3** | Endpoint without idempotency support times out | Re-read state (GET order/capture) before deciding to retry | I | — | todo — no test |
| **EC-IDEM-4** | Two worker instances process the same job | The second gets CS_CONFLICT and no-ops | I | — | todo — no test |
| **EC-IDEM-5** | Human double-clicks "Refund" | One refund | E | — | todo — no test |
| **EC-IDEM-6** | Buyer genuinely wants two identical items on two occasions | Allowed if the budget permits; line_items quantity caps apply per checkout | U | — | todo — no test |

## §12.3 Webhooks: loss, duplication, out-of-order

Owning work package(s): `WP-12` · module: `M12 webhooks` · spec line 1095

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-WH-1** | Webhook never arrives | Upsert from GET; metric reconciler_fixes_total | I | — | todo — no test |
| **EC-WH-2** | Same event delivered several times (PayPal retries up to 25× over 3 days [V14]) | ON CONFLICT DO NOTHING; return 200 | U | `packages/db/test/schema.test.ts:308`<br>`packages/db/test/schema.test.ts:309`<br>`packages/db/test/schema.test.ts:310`<br>`packages/db/test/schema.test.ts:318` — EC-WH-2: webhook_events has UNIQUE (paypal_event_id)<br>`packages/db/test/schema.test.ts:319`<br>`packages/db/test/schema.test.ts:320` | todo — 6 tests |
| **EC-WH-3** | Out-of-order (REFUNDED before COMPLETED; dispute UPDATED before CREATED) | Always re-fetch the resource; never downgrade the rank | U | — | todo — no test |
| **EC-WH-4** | Forged webhook | 400, audit log, alert after 10/h | U | — | todo — no test |
| **EC-WH-5** | Our endpoint down for hours | Idempotent processing | S | — | todo — no test |
| **EC-WH-6** | Webhook for an unknown resource (simulator, other app) | Store, mark ignored, no crash | U | — | todo — no test |
| **EC-WH-7** | Verify-signature API itself down | Store the event unverified, don't act; retry verification with backoff; the reconciler still progresses state from GETs (safe because GETs are authenticated) | I | — | todo — no test |

## §12.4 Mandates: expiry, revocation, suspension

Owning work package(s): `WP-10, WP-11` · module: `M10/M11` · spec line 1107

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-MDT-1** | Mandate expires between checkout creation and Gate | BLOCK VI_EXPIRED | U | `packages/core/test/core.test.ts:526` — EC-MDT-1 a token issued in the future is NOT_YET_VALID past the skew<br>`packages/core/test/core.test.ts:527`<br>`packages/core/test/core.test.ts:528` | todo — 3 tests |
| **EC-MDT-2** | Revoked after Gate ALLOW, before order create | Abort; RELEASE the reservation | U | — | todo — no test |
| **EC-MDT-3** | Revoked after authorization, before capture | voidAuthorization for each; RELEASE; the order is CANCELLED | S | — | todo — no test |
| **EC-MDT-4** | Revoked after capture | The purchase stands (it was authorised when made); the user can request a refund via a merchant message | U | — | todo — no test |
| **EC-MDT-5** | Expired before a split shipment's second capture | Captures against an existing authorization remain valid: the authorization was created under a valid mandate and the amount is already bounded. Documented rule. No new authorizations | U | — | todo — no test |
| **EC-MDT-6** | Vault token deleted at PayPal (user removed it in PayPal settings) | Wallet → DELETED; all mandates → SUSPENDED; the Gate blocks | I | — | todo — no test |
| **EC-MDT-7** | User edits the intent after signing | Mandates are immutable; editing creates a new mandate and offers to revoke the old one | E | — | todo — no test |

## §12.5 Time and clock skew

Owning work package(s): `WP-03, WP-10` · module: `M3/M10` · spec line 1119

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-TIME-1** | Browser clock wrong by hours | Not affected | E | `apps/vi/tests/test_verify.py:384`<br>`apps/vi/tests/test_verify.py:385`<br>`apps/vi/tests/test_verify.py:386` | todo — 3 tests |
| **EC-TIME-2** | Server clocks drift between web and vi | Library skew of 300 s tolerates it [B2]; Render hosts are NTP-synced [U] | U | `apps/vi/tests/test_verify.py:306`<br>`apps/vi/tests/test_verify.py:307`<br>`apps/vi/tests/test_verify.py:308`<br>`apps/vi/tests/test_verify.py:319`<br>`apps/vi/tests/test_verify.py:320`<br>`apps/vi/tests/test_verify.py:321`<br>`apps/vi/tests/test_verify.py:400`<br>`apps/vi/tests/test_verify.py:401`<br>`apps/vi/tests/test_verify.py:402`<br>`packages/core/test/core.test.ts:516` — EC-TIME-2 a token is valid up to the skew past exp and invalid beyond it<br>`packages/core/test/core.test.ts:517`<br>`packages/core/test/core.test.ts:518` | done |
| | _note:_ packages/core/src/clock.ts withinValidity applies VI_CLOCK_SKEW_SECONDS (default 300, the library default), and apps/vi threads clock_skew_seconds into verify_chain. Tests: packages/core/test/core.test.ts, apps/vi/tests/test_verify.py. | | | | |
| **EC-TIME-3** | Dispute arrives after the mandate expired | Defender verifies with at_time = capture time and now; the evidence states both | U | `apps/vi/tests/test_verify.py:341`<br>`apps/vi/tests/test_verify.py:342`<br>`apps/vi/tests/test_verify.py:343`<br>`apps/vi/tests/test_verify.py:349`<br>`apps/vi/tests/test_verify.py:350`<br>`apps/vi/tests/test_verify.py:351` | blocked (tested) |
| | _note:_ apps/vi/tests/test_verify.py::test_EC_TIME_3_at_time_is_flagged_as_not_honoured and ::test_EC_TIME_3_at_time_within_the_window_is_reported_as_such. PARTIAL: the pinned verify_chain (commit 356c296) reads time.time() internally and takes no clock override, so /v1/verify CANNOT produce a real as-of verdict. It returns the verification it did perform at now, plus at_time_not_honoured=true, the reason, and an advisory within_validity_at window check computed by vi-service. A real as-of verification needs a now parameter in the library (docs/HUMAN_TODO.md). Defender-side EC-TIME-3 (verify twice, at capture time and now, and state both in the packet) is WP-15. | | | | |
| | _blocked:_ verify_chain at the pinned VI commit has no clock override (chain.py:166 hardcodes now = int(time.time())), so as-of-capture-time verification is impossible, not merely unimplemented. apps/vi returns the real verdict at now plus at_time_not_honoured:true. Upstream request raised as HUMAN_TODO H-08; see DECISIONS D-009. | | | | |
| **EC-TIME-4** | Price-lock boundary race (lock expires mid-Gate) | Deterministic | U | — | todo — no test |
| **EC-TIME-5** | Authorization expiry (29 days; honor period 3 days [V15]) | Day 3: reauthorize if unshipped and within mandate validity; day 28: alert; on expiry: state AUTH_EXPIRED, RELEASE | IU | — | todo — no test |
| **EC-TIME-6** | Dispute deadline in a different TZ | Stored UTC; displayed IST with label; the Bryntum timeline uses UTC internally | U | `packages/core/test/core.test.ts:535` — EC-TIME-6 renders IST explicitly, with no timezone database needed<br>`packages/core/test/core.test.ts:536`<br>`packages/core/test/core.test.ts:537` | done |
| | _note:_ packages/core/src/clock.ts formatIst/formatIstHuman render IST explicitly with a fixed +05:30 offset (no tz database needed, and exact since 1945). Test: packages/core/test/core.test.ts. | | | | |

## §12.6 Currency, FX and rounding

Owning work package(s): `WP-01, WP-09, WP-11` · module: `M1/M9/M11` · spec line 1130

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-FX-1** | Mandate in INR, store in USD | BLOCK CS_CURRENCY_MISMATCH. We never convert inside the Gate: FX rates are not signed by the user | U | `packages/core/test/core.test.ts:239` — EC-FX-1 every arithmetic helper refuses a mixed pair<br>`packages/core/test/core.test.ts:240`<br>`packages/core/test/core.test.ts:241`<br>`packages/core/test/core.test.ts:248` — EC-FX-1 withinRange reports CURRENCY instead of converting<br>`packages/core/test/core.test.ts:249`<br>`packages/core/test/core.test.ts:250`<br>`packages/core/test/core.test.ts:255` — EC-FX-1 exceedsCap names the code rather than converting<br>`packages/core/test/core.test.ts:256`<br>`packages/core/test/core.test.ts:257`<br>`packages/db/test/seed.test.ts:398` — refuses a currency mismatch rather than converting (EC-FX-1)<br>`packages/db/test/seed.test.ts:399`<br>`packages/db/test/seed.test.ts:400`<br>`packages/db/test/seed.test.ts:680` — refuses a wallet cap in a different currency rather than converting (EC-FX-1)<br>`packages/db/test/seed.test.ts:681`<br>`packages/db/test/seed.test.ts:682` | done |
| | _note:_ Handled in packages/core (WP-01): currency mismatch throws instead of converting | | | | |
| **EC-FX-2** | Buyer's PayPal funds in another currency (PayPal converts) | Out of our control. The mandate binds the merchant charge currency and amount; the receipt notes that PayPal may convert | I | — | todo — no test |
| **EC-FX-3** | Zero-decimal currency (JPY) | toPayPalValue emits no decimals | P | `packages/core/test/core.test.ts:5`<br>`packages/core/test/core.test.ts:6`<br>`packages/core/test/core.test.ts:7`<br>`packages/core/test/core.test.ts:555` — EC-FX-3 formats zero-decimal JPY without a decimal point<br>`packages/core/test/core.test.ts:556`<br>`packages/core/test/core.test.ts:557`<br>`packages/core/test/env.test.ts:295` — EC-FX-3 ppAmountSchema checks decimal places against the currency, not a constant<br>`packages/core/test/env.test.ts:296`<br>`packages/core/test/env.test.ts:297`<br>`packages/db/test/seed.test.ts:2`<br>`packages/db/test/seed.test.ts:3`<br>`packages/db/test/seed.test.ts:4`<br>`packages/db/test/seed.test.ts:106` — seeds at least one JPY item (EC-FX-3, zero-decimal currency)<br>`packages/db/test/seed.test.ts:107`<br>`packages/db/test/seed.test.ts:108`<br>`packages/db/test/seed.test.ts:145`<br>`packages/db/test/seed.test.ts:146`<br>`packages/db/test/seed.test.ts:147` | done |
| | _note:_ Handled in packages/core (WP-01): MINOR_DIGITS drives toPayPalValue/formatMoney/ppAmountSchema | | | | |
| **EC-FX-4** | Rounding in shipping/tax allocation across split captures | Largest-remainder; Σ captures == total exactly; property test | P | `packages/core/test/core.test.ts:5`<br>`packages/core/test/core.test.ts:6`<br>`packages/core/test/core.test.ts:7`<br>`packages/core/test/core.test.ts:157` — EC-FX-4 property: the parts always sum exactly to the total<br>`packages/core/test/core.test.ts:158`<br>`packages/core/test/core.test.ts:159`<br>`packages/core/test/core.test.ts:176` — EC-FX-4 property: every part is within one minor unit of the exact share<br>`packages/core/test/core.test.ts:177`<br>`packages/core/test/core.test.ts:178` | done |
| | _note:_ Handled in packages/core (WP-01): allocate() largest-remainder, property-tested to sum exactly | | | | |
| **EC-FX-5** | Float creeping in from the LLM ("129.99") | Reject floats at boundaries | U | `packages/core/test/core.test.ts:5`<br>`packages/core/test/core.test.ts:6`<br>`packages/core/test/core.test.ts:7`<br>`packages/core/test/core.test.ts:105` — EC-FX-5 fromPayPalValue("1.005","USD") -> CS_ROUNDING<br>`packages/core/test/core.test.ts:106`<br>`packages/core/test/core.test.ts:107`<br>`packages/core/test/core.test.ts:567` — EC-FX-5 a model that emits sub-cent precision is refused, not rounded<br>`packages/core/test/core.test.ts:568`<br>`packages/core/test/core.test.ts:569`<br>`packages/core/test/core.test.ts:574` — EC-FX-5 the float round-trip that motivates all of this<br>`packages/core/test/core.test.ts:575`<br>`packages/core/test/core.test.ts:576`<br>`packages/core/test/env.test.ts:250` — EC-FX-5 minorSchema rejects a JS float outright<br>`packages/core/test/env.test.ts:251`<br>`packages/core/test/env.test.ts:252`<br>`packages/core/test/env.test.ts:259` — EC-FX-5 the schema itself accepts bigint, integer string and safe integer — nothing else<br>`packages/core/test/env.test.ts:260`<br>`packages/core/test/env.test.ts:261`<br>`packages/core/test/env.test.ts:270` — EC-FX-5 minorSchema rejects a decimal string and a negative<br>`packages/core/test/env.test.ts:271`<br>`packages/core/test/env.test.ts:272` | done |
| | _note:_ Handled in packages/core (WP-01): fromPayPalValue refuses sub-minor precision; boundary schemas refuse JS numbers | | | | |
| **EC-FX-6** | VI example helper uses float dollars | Our checkout JWT uses integer minor units (§8.3) | U | `apps/vi/tests/test_checkout_jwt.py:1`<br>`apps/vi/tests/test_checkout_jwt.py:2`<br>`apps/vi/tests/test_checkout_jwt.py:3`<br>`apps/vi/tests/test_checkout_jwt.py:57`<br>`apps/vi/tests/test_checkout_jwt.py:58`<br>`apps/vi/tests/test_checkout_jwt.py:59`<br>`apps/vi/tests/test_constraints_fixture.py:144`<br>`apps/vi/tests/test_constraints_fixture.py:145`<br>`apps/vi/tests/test_constraints_fixture.py:146`<br>`packages/core/test/core.test.ts:5`<br>`packages/core/test/core.test.ts:6`<br>`packages/core/test/core.test.ts:7` | todo — 12 tests |

## §12.7 Price, stock and fulfilment

Owning work package(s): `WP-09, WP-10, WP-11` · module: `M9/M10/M11` · spec line 1141

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-PRICE-1** | Price rises between cart and Gate | The locked price holds until price_lock_exp; after that a new checkout is needed, the agent re-quotes, and the Gate re-checks the mandate | U | — | todo — no test |
| **EC-PRICE-2** | Merchant tries to capture more than the checkout total | PayPal rejects; we reject first (EC-CAP-3) | U | `apps/vi/tests/test_l3.py:143`<br>`apps/vi/tests/test_l3.py:144`<br>`apps/vi/tests/test_l3.py:145` | todo — 3 tests |
| **EC-PRICE-3** | Price drops after purchase | No automatic action (out of scope); a merchant may refund the difference (partial refund) | — | — | todo — no test |
| **EC-STOCK-1** | Out of stock after authorization | Partial capture of the available lines + void the remainder (final_capture=true on the last capture) | S | — | todo — no test |
| **EC-STOCK-2** | Out of stock with the CAPTURE intent (digital, or the C2 fallback) | Partial refund of the OOS lines | S | — | todo — no test |
| **EC-STOCK-3** | Last-unit race between two agents | One wins; the other gets BLOCK GATE_OUT_OF_STOCK and the reservation is released | P | `packages/db/test/schema.test.ts:440` — EC-STOCK-3: products.stock may never go negative<br>`packages/db/test/schema.test.ts:441`<br>`packages/db/test/schema.test.ts:442`<br>`packages/db/test/seed.test.ts:2`<br>`packages/db/test/seed.test.ts:3`<br>`packages/db/test/seed.test.ts:4`<br>`packages/db/test/seed.test.ts:98` — seeds exactly 2 products with stock = 1 (EC-STOCK-3, last-unit race)<br>`packages/db/test/seed.test.ts:99`<br>`packages/db/test/seed.test.ts:100` | todo — 9 tests |
| **EC-SPLIT-1** | Split shipment | One capture + one tracker per shipment; evidence lists both | S | — | todo — no test |
| **EC-SPLIT-2** | Split shipment under the CAPTURE intent | Track twice against the same capture; OOS → partial refund | S | — | todo — no test |
| **EC-SPLIT-3** | Dispute on only one shipment's items | The router evaluates only the disputed capture/lines | U | — | todo — no test |

## §12.8 Buyer remorse vs. true fraud vs. friendly fraud

Owning work package(s): `WP-15` · module: `M15 defender` · spec line 1155

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-BUY-1** | Buyer remorse: the purchase was in-mandate but the user changed their mind | Router R-SNAD-OK → CONTEST. The UI suggests that the merchant offer a return (make-offer with REFUND_WITH_RETURN) instead of fighting, since that's cheaper than the $82 handling cost [V13] | SU | — | todo — no test |
| **EC-BUY-2** | True fraud: someone stole the PayPal account but has no device key | ACCEPT/manual. Countersign proves nothing it didn't sign | U | — | todo — no test |
| **EC-BUY-3** | True fraud via a compromised device (malware drove the browser and signed a mandate) | If webauthn UV was absent → R-UNAUTH weak → the router recommends ACCEPT above $50 (merchant setting). If UV was present → CONTEST, but notify the user to secure their device | U | — | todo — no test |
| **EC-BUY-4** | Friendly fraud: the user claims "unauthorised" for a purchase they signed | R-UNAUTH-1 → CONTEST with the mandate packet + tracking + read-back text the user saw | S | — | todo — no test |
| **EC-BUY-5** | Agent-fault "fraud" claim: the user says "I never asked for this", but the agent bought within limits and against preferences | R-SNAD-AGENT → honest refund. The user did authorise the limits, but the agent clearly missed the stated preference; fighting it would be bad faith | SU | — | todo — no test |
| **EC-BUY-6** | Serial disputer (≥3 disputes in 90 days) | Flag on S-17; no automatic action (avoids unfair profiling); merchant decides | U | — | todo — no test |

## §12.9 Agents, keys and people

Owning work package(s): `WP-05, WP-10, WP-13` · module: `M5/M10/M13` · spec line 1166

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-AGT-1** | Prompt injection in a product listing | Listings are wrapped as untrusted; the Gate blocks out-of-mandate L3s; velocity guard → SUSPEND after 3 consecutive BLOCKs | E | `packages/db/test/seed.test.ts:2`<br>`packages/db/test/seed.test.ts:3`<br>`packages/db/test/seed.test.ts:4`<br>`packages/db/test/seed.test.ts:78` — seeds exactly 3 products carrying an injection payload (EC-AGT-1, §8.13 AT-M13.2)<br>`packages/db/test/seed.test.ts:79`<br>`packages/db/test/seed.test.ts:80` | todo — 6 tests |
| **EC-AGT-2** | Compromised agent (attacker controls the LLM loop or its server) | It can only sign L3s within L2 limits (the agent key is bound by the L2). Worst case = the full budget at allowed merchants. The user can revoke the agent (all of its mandates are suspended) | P | — | todo — no test |
| **EC-AGT-3** | Agent private key leaked | jwks_keys.status=COMPROMISED; all mandates bound to it → REVOKED; the Gate refuses its L3s; past L3s are flagged "signed before compromise at T" in evidence | U | — | todo — no test |
| **EC-AGT-4** | Agent key rotation (scheduled) | New key → user re-signs new L2s (the L2 binds the agent key); old mandates keep the old key until expiry | E | — | todo — no test |
| **EC-KEY-1** | User device key lost (browser data cleared, new laptop) | Device → LOST; enrol a new device (PayPal re-auth via a new setup token or a session check) → new L1; old mandates keep working until expiry (the agent key, not the device key, signs purchases) unless the user chooses "revoke all" | E | — | todo — no test |
| **EC-KEY-2** | Issuer key rotation | New kid in JWKS; old kept as RETIRED (verify-only) until the retention end; on compromise: mark COMPROMISED, re-issue all L1s, mandates need re-signing | U | `apps/vi/tests/test_keys.py:1`<br>`apps/vi/tests/test_keys.py:2`<br>`apps/vi/tests/test_keys.py:3`<br>`apps/vi/tests/test_keys.py:63`<br>`apps/vi/tests/test_keys.py:64`<br>`apps/vi/tests/test_keys.py:65`<br>`apps/vi/tests/test_keys.py:101`<br>`apps/vi/tests/test_keys.py:102`<br>`apps/vi/tests/test_keys.py:103`<br>`apps/vi/tests/test_keys.py:107`<br>`apps/vi/tests/test_keys.py:108`<br>`apps/vi/tests/test_keys.py:109`<br>`apps/vi/tests/test_keys.py:378`<br>`apps/vi/tests/test_keys.py:379`<br>`apps/vi/tests/test_keys.py:380` | done |
| | _note:_ apps/vi/src/vi_service/keys.py: POST /v1/keys/rotate retires the current key and GET /v1/jwks returns retired public keys with a status field, so evidence signed by an old kid still verifies. Test: apps/vi/tests/test_keys.py (AT-M3.9). | | | | |
| **EC-KEY-3** | Merchant checkout key rotation | The Gate accepts checkout JWTs from ACTIVE or RETIRED (within not_after) kids | U | `apps/vi/tests/test_keys.py:1`<br>`apps/vi/tests/test_keys.py:2`<br>`apps/vi/tests/test_keys.py:3`<br>`apps/vi/tests/test_keys.py:181`<br>`apps/vi/tests/test_keys.py:182`<br>`apps/vi/tests/test_keys.py:183`<br>`apps/vi/tests/test_keys.py:187`<br>`apps/vi/tests/test_keys.py:188`<br>`apps/vi/tests/test_keys.py:189` | done |
| | _note:_ apps/vi/src/vi_service/verify.py accepts a checkout JWT from an ACTIVE or RETIRED-but-not-after merchant kid, per Gate check 5 in spec 8.10. Test: apps/vi/tests/test_checkout_jwt.py. | | | | |
| **EC-KEY-4** | KEK (VI_KEK) lost | Agent keys are re-created → users re-sign L2s. Issuer/merchant keys are re-created → JWKS keeps the public halves, so historical evidence stays verifiable. Doc: back the KEK up in Render env + 1Password | — | `apps/vi/tests/test_keys.py:1`<br>`apps/vi/tests/test_keys.py:2`<br>`apps/vi/tests/test_keys.py:3`<br>`apps/vi/tests/test_keys.py:228`<br>`apps/vi/tests/test_keys.py:229`<br>`apps/vi/tests/test_keys.py:230`<br>`apps/vi/tests/test_keys.py:285`<br>`apps/vi/tests/test_keys.py:286`<br>`apps/vi/tests/test_keys.py:287` | todo — 9 tests |
| **EC-FAM-1** | Family member uses the agent chat on the user's logged-in laptop | The agent can still only spend within existing mandates. New mandates need the device key plus a WebAuthn UV (passkey biometric/PIN; D4) | E | — | todo — no test |
| **EC-FAM-2** | Family member knows the device PIN and signs a mandate | Legally/operationally it's the account holder's authorisation. The evidence shows a UV-backed signature. The dispute is resolved as friendly fraud / household use | — | — | todo — no test |
| **EC-FAM-3** | Household wallet with explicit sub-users (P2) | P2: per-member agents with lower caps under one wallet cap | — | — | todo — no test |
| **EC-MA-1** | Multiple agents on one wallet spending concurrently | Each mandate has its own budget; the wallet cap is serialised via FOR UPDATE on wallet_caps | P | `packages/db/test/schema.test.ts:2`<br>`packages/db/test/schema.test.ts:3`<br>`packages/db/test/schema.test.ts:4`<br>`packages/db/test/seed.test.ts:15`<br>`packages/db/test/seed.test.ts:16`<br>`packages/db/test/seed.test.ts:17`<br>`packages/db/test/seed.test.ts:18`<br>`packages/db/test/seed.test.ts:19`<br>`packages/db/test/seed.test.ts:197`<br>`packages/db/test/seed.test.ts:198`<br>`packages/db/test/seed.test.ts:199`<br>`packages/db/test/seed.test.ts:577`<br>`packages/db/test/seed.test.ts:578`<br>`packages/db/test/seed.test.ts:579`<br>`packages/db/test/seed.test.ts:580` — EC-MA-1: multiple agents on one wallet<br>`packages/db/test/seed.test.ts:581`<br>`packages/db/test/seed.test.ts:582`<br>`packages/db/test/seed.test.ts:593`<br>`packages/db/test/seed.test.ts:594`<br>`packages/db/test/seed.test.ts:595`<br>`packages/db/test/seed.test.ts:614`<br>`packages/db/test/seed.test.ts:615`<br>`packages/db/test/seed.test.ts:616` | done |
| | _note:_ packages/db (WP-02). packages/db/src/schema.ts wallet_caps (wallet_id PK, cap_minor, currency, period DAY\|MONTH); packages/db/src/repos/budget.ts walletCapCheckIn/lockWalletCap (SELECT ... FROM wallet_caps WHERE wallet_id = $1 FOR UPDATE) and sumWalletSpend (SUM RESERVE - SUM RELEASE across every mandate on the wallet); packages/db/test/seed.test.ts 'EC-MA-1: multiple agents on one wallet' asserts the lock target is the wallet row and that spend is summed across two mandates. STILL OPEN: the 20-way concurrent race needs Postgres and belongs to WP-10 AT-M10.2. | | | | |
| **EC-MA-2** | Agent A tries to use agent B's mandate | verify_chain fails (L3 must be signed by the L2-bound key) | U | — | todo — no test |
| **EC-MA-3** | One agent, many mandates (different merchants) | The agent picks the mandate per checkout; the Gate verifies the one presented | U | — | todo — no test |

## §12.10 Merchant-side abuse and evidence gaming

Owning work package(s): `WP-15, WP-18` · module: `M15/M18` · spec line 1185

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-MER-1** | Merchant fabricates a mandate for a customer | Verification fails publicly | P | — | todo — no test |
| **EC-MER-2** | Merchant reuses a valid L3 for a second charge | Gate replay block; for disputes, the router flags duplicate captures (R-AMT-2) | U | — | todo — no test |
| **EC-MER-3** | Merchant ships something different from the signed checkout | R-SNAD-MERCH → REFUND. Our packet would *hurt* the merchant, so the Defender never files it as a contest | U | — | todo — no test |
| **EC-MER-4** | Merchant fakes tracking | The packet labels tracking "merchant-asserted via PayPal /track" and makes no carrier-verification claim | U | — | todo — no test |
| **EC-MER-5** | Merchant edits the LLM notes to add unsupported claims | Uncited claims → filing blocked; the merchant can only file with checker-clean notes or template notes | U | — | todo — no test |
| **EC-MER-6** | Merchant selectively omits the read-back or preferences that hurt them | The PDF renderer fails without them; the public verifier recomputes the L2 hash, so omissions are visible | U | — | todo — no test |
| **EC-MER-7** | Merchant overrides an AGENT_FAULT recommendation and contests anyway | Allowed (it's their account) but the packet shows the router's result + rule ID; it can't be hidden | U | — | todo — no test |

## §12.11 Disputes: stages, deadlines, chargeback after refund

Owning work package(s): `WP-15, WP-16` · module: `M15/M16` · spec line 1197

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-DSP-1** | Chargeback after refund (buyer refunded, then the bank charges back) | R-REF-1 → provide-evidence with PROOF_OF_REFUND [B16] + refund ID/date; budget ledger REVERSE entry for the audit | S | — | todo — no test |
| **EC-DSP-2** | Partial refund, then a dispute for the full amount | Evidence: proof of partial refund + contest the remainder per its own rule | U | — | todo — no test |
| **EC-DSP-3** | Inquiry stage (INQUIRY) | Prefer send-message/make-offer; no filing needed unless status = WAITING_FOR_SELLER_RESPONSE | S | — | todo — no test |
| **EC-DSP-4** | Escalated to claim/chargeback | Re-run the router; new packet version; deadline recalculated from the API | S | — | todo — no test |
| **EC-DSP-5** | Pre-arbitration / arbitration | provide-supporting-info with the original packet + new facts; never re-file contradictory notes (packet versions are diffed) | U | — | todo — no test |
| **EC-DSP-6** | Appeal after a loss | Strategist proposes an appeal only if new evidence exists (e.g. a late tracking update) | S | — | todo — no test |
| **EC-DSP-7** | Deadline about to pass | Alert; at < 1 h auto-file is disabled (risk of a partial upload) and the merchant is told to file manually in the PayPal UI | U | — | todo — no test |
| **EC-DSP-8** | Deadline missed | DEF_DEADLINE_PASSED; state → likely loss; post-mortem note | U | — | todo — no test |
| **EC-DSP-9** | Dispute can't be mapped to an order (no custom_id, foreign transaction) | R-NOCHAIN-1 | U | — | todo — no test |
| **EC-DSP-10** | Two disputes on one capture (inquiry + chargeback) | Link both; one packet per dispute; consistent facts | U | — | todo — no test |
| **EC-DSP-11** | Buyer cancels the dispute | Close CLOSED_WON (cancelled) | S | — | todo — no test |
| **EC-DSP-12** | Evidence upload partially fails (file too big / type) | Validate locally first (jpg/png/gif/pdf, < 10 MB, ≤ 50 MB total [V8]); compress the PDF; retry | U | — | todo — no test |

## §12.12 PayPal outages, rate limits, sandbox vs. live

Owning work package(s): `WP-06` · module: `M6 paypal` · spec line 1214

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-PP-1** | PayPal API down (5xx / timeouts) | Fail fast; the Gate still runs; order creation is queued (pg-boss, retried with the same request ID) for up to 15 min while the reservation holds; after that, RELEASE and tell the agent | I | — | todo — no test |
| **EC-PP-2** | Rate limited (429 RATE_LIMIT_REACHED; the policy is unpublished [B15]) | Backoff with jitter; honour Retry-After; the reconciler throttles itself to 2 rps; Judge Mode serialises runs | I | — | todo — no test |
| **EC-PP-3** | OAuth token expired mid-flight | Refresh once (single-flight), then retry | U | — | todo — no test |
| **EC-PP-4** | PayPal MCP server down | The Defender switches to direct REST for the same operations (getDispute, listDisputes); the agent tooling degrades gracefully | I | — | todo — no test |
| **EC-PP-5** | Webhook verify endpoint slow | Respond 200 after storing; verify async (EC-WH-7) | U | — | todo — no test |
| **EC-ENV-1** | Accidental live credentials | Boot refuses | U | `packages/core/test/env.test.ts:5`<br>`packages/core/test/env.test.ts:6`<br>`packages/core/test/env.test.ts:7`<br>`packages/core/test/env.test.ts:49` — EC-ENV-1 the process refuses to boot against live PayPal<br>`packages/core/test/env.test.ts:50` — parseEnv throws a CsError listing live as invalid<br>`packages/core/test/env.test.ts:51`<br>`packages/core/test/env.test.ts:61`<br>`packages/core/test/env.test.ts:62`<br>`packages/core/test/env.test.ts:63` | done |
| | _note:_ Handled in packages/core (WP-01): envSchema rejects PAYPAL_ENV=live; assertSandbox enforces it at call time | | | | |
| **EC-ENV-2** | Sandbox vs. live differences | The code paths that call sandbox-only APIs live in paypal.sandbox.* and are compiled out when PAYPAL_ENV=live (not supported anyway) | U | — | todo — no test |
| **EC-ENV-3** | Sandbox data reset or account changes during judging | Alert Vedant; scripts/sandbox-bootstrap.ts recreates the personas | S | — | todo — no test |

## §12.13 Privacy and data retention

Owning work package(s): `WP-19` · module: `M19 privacy` · spec line 1244

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-PRIV-1** | Erasure request with an open dispute | PRIVACY_LEGAL_HOLD; scheduled for after resolution + window; the user is told the date | U | `apps/vi/tests/test_l1.py:78`<br>`apps/vi/tests/test_l1.py:79`<br>`apps/vi/tests/test_l1.py:80` | todo — 3 tests |
| **EC-PRIV-2** | Export request | JSON zip of all rows + tokens + PDFs within 24 h (immediate in the demo) | E | — | todo — no test |
| **EC-PRIV-3** | Public verifier leaks PII | Redaction: email masked (a*@…), no street address; raw-token download includes selectively disclosed fields only (SD-JWT) | U | `packages/core/test/env.test.ts:160` — EC-PRIV-3 redaction<br>`packages/core/test/env.test.ts:161` — redacts secret-looking keys at any depth<br>`packages/core/test/env.test.ts:162`<br>`packages/core/test/env.test.ts:180` — EC-PRIV-3 scrubPii removes emails, card numbers and phone numbers<br>`packages/core/test/env.test.ts:181`<br>`packages/core/test/env.test.ts:182`<br>`packages/core/test/env.test.ts:186` — EC-PRIV-3 a log line keeps operational context but drops PII values<br>`packages/core/test/env.test.ts:187`<br>`packages/core/test/env.test.ts:188`<br>`packages/core/test/env.test.ts:211` — EC-PRIV-3 AT-M19.2 regex test: no logged field value contains an email<br>`packages/core/test/env.test.ts:212`<br>`packages/core/test/env.test.ts:213` | done |
| | _note:_ Handled in packages/core (WP-01): three-filter logger redaction + redacted public verifier payload (S-18) | | | | |
| **EC-PRIV-4** | LLM provider data | OpenAI API data-usage settings documented; no PII sent to the compiler beyond the intent text; product data only to the agent | U | — | todo — no test |
| **EC-PRIV-5** | Pre-erasure notice | 48 h email (stub) before the retention purge, per DPDP Rule 8(2) good practice [B17] | U | — | todo — no test |
| **EC-PRIV-6** | Cross-border transfer (India user, US hosting) | Disclosed in the notice; Render region chosen = Singapore [U: confirm Render region list in WP-00] | — | — | todo — no test |

## §12.14 LLM failures

Owning work package(s): `WP-08, WP-13, WP-15` · module: `M8/M13/M15` · spec line 1255

| ID | Scenario | Handling | Declared | Test(s) | Status |
|---|---|---|---|---|---|
| **EC-LLM-1** | OpenAI down / timeout | Compiler → manual constraint form; agent → "try later"; Defender → template notes (deterministic) | I | — | todo — no test |
| **EC-LLM-2** | Output fails the zod schema | One repair retry (repairToolCall / re-ask), then fallback | U | — | todo — no test |
| | _note:_ Handled in packages/core (WP-01): parseOr/parseEnv: one invalid value is reported, never guessed | | | | |
| **EC-LLM-3** | Hallucinated fact in the notes | Citation checker blocks it | U | — | todo — no test |
| **EC-LLM-4** | Cost runaway (agent loop) | isStepCount(12); per-user daily token budget; Judge Mode capped | U | — | todo — no test |
| **EC-LLM-5** | Model deprecation | LLM_MAIN_MODEL env; the eval suite runs on a model switch | — | — | todo — no test |

---

## How to close a case

1. Write the test, naming the EC id in the title or in a comment directly above it.
2. Put the handling code in the module the `wp` column names.
3. Set `status` to `done` in `docs/edge-cases.json` (or `blocked` with a `blockedReason`).
4. Run `pnpm test:ec`. It regenerates this file and fails if anything is unclaimed.
