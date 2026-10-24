# Countersign — Judge-Panel Verdict (25 Oct 2026, IST)

Repo: github.com/Vedant817/countersign @ b0edec6 (100+ commits, 4 Oct–24 Oct 2026).
Method: the repo is **private**, so `git clone` failed (`could not read Username`). I read it through the GitHub MCP: README, docs/PROGRESS.md, FINAL_REPORT.md, CI-FAILURES.md, HUMAN_TODO.md, LLM-ENDPOINT.md and the commit list. I checked these against the blueprint and brief, the demo notes and the parent's video review. **I did not install, build or run the code locally.** The pass/fail figures below are the repo's own reports and are labelled that way.

## Verdict in one paragraph

Right now this is a well-engineered payments-security library with no product on top of it, and **it would be rejected or ranked low as it stands**. The core promise is "an agent buys with PayPal, a dispute arrives, the signed proof wins it". None of that has run even once. The repo's own README says _"There are zero real sandbox captures so far"_ and _"no end-to-end PayPal purchase has been demonstrated yet"_. FINAL_REPORT says _"No successful purchase, no live PayPal transaction, no hosted deployment, no CI acceptance"_. The shopping agent (WP-13), Judge Mode (WP-20), wallet onboarding (WP-07), the agent chat, merchant and disputes UIs, and the edge-case sweep are all `todo` or `blocked`. The video is over the 3:00 limit, shows no PayPal and has no narration. The repo is private. Separately, the engineering honesty is genuinely rare, and so are the depth of Gate, VI and defender modules (2,665 TS tests plus 207 Python tests, self-reported). The foundation is good enough to win if the product layer and a real PayPal flow ship in the 18 days left.

## Evidence: spec vs reality (from docs/PROGRESS.md at b0edec6)

| P0 item                       | Status                                       | Evidence                                                                                                                |
| ----------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 Wallet onboarding / Vault   | **missing (blocked)**                        | WP-07 `blocked`; WP-17a `todo`; README "needs the buyer onboarding flow"                                                |
| 2 Intent compiler + read-back | done, but **non-deterministic**              | WP-08 done; README 56/60 = 93.3% (< 95% target); demo notes 3/5 signable on the same sentence; "fifty dollars" → no cap |
| 3 Storefront + MCP            | partial                                      | WP-09 done, WP-14 `review`; D-048: MCP `submit_checkout` refuses with `CS_INTERNAL`                                     |
| 4 Shopping agent              | **missing**                                  | WP-13 `todo`; README "`packages/agent` is not built yet"                                                                |
| 5 Gate                        | done (library)                               | WP-10 done; "Injection attack-success at the Gate 0/50", but no real checkout passes through it                         |
| 6 Order orchestrator          | partial                                      | WP-11 `wip`; "No ALLOW can create a PayPal order: order lookup has no persisted order source"                           |
| 7 Webhooks + reconciler       | code done, **never received a real webhook** | WP-12 done; webhook id missing (README)                                                                                 |
| 8 Dispute Defender            | partial                                      | WP-15a–d done, 15e/16 `wip`; dispute scopes are not granted (HUMAN_TODO H-09)                                           |
| 9 Public verifier             | done                                         | WP-18 done; but CI shows `qa4-checkout-parity` with 4 failures (verify.py exit -1)                                      |
| 10 Revoke                     | not evidenced                                | no WP marked done for the revoke UI                                                                                     |
| 11 Judge Mode                 | **missing**                                  | WP-20 `todo`                                                                                                            |
| 12 Personas + README creds    | partial                                      | seed exists; README has no sandbox creds for judges                                                                     |

WP tally: 33 packages = 18 done, 1 review, 5 wip, 2 blocked, 7 todo. Edge cases: _"87/109 referenced"_, _"19 of the 109 … have no referencing test"_, `pnpm test:ec` red (FINAL_REPORT). "Referenced by a test" is not the same as "proven against PayPal": every PayPal behaviour runs against `fetch` substitutions (`packages/paypal/test/fixtures/README.md`, cited in the README).
PayPal actually called: **only `POST /v1/oauth2/token` → 200** (README). Orders, Vault, captures, refunds, disputes and webhooks have never hit the sandbox.
CI: red for its whole life. Two causes are fixed; 3 are still open: verify.py parity, 5 Linux-only defender source-scan failures, and the edge-case ledger (docs/CI-FAILURES.md).

## Demo video findings (parent's video review plus docs/demo notes)

V1. Cut length 3:13, over the "less than three minutes" rule; judges may stop watching at 3:00. The raw replay is 9:12, with a 5-minute frozen stretch.
V2. ZERO PayPal on screen: no button, order, capture, dispute or API response.
V3. No narration or audio.
V4. No agent attempts a purchase, and the Gate never blocks or approves a real checkout.
V5. The caption counter is broken ("05 / 04", "06 / 04").
V6. Erratic jump back to home at 0:18–0:31, then dead air at 0:32–1:19.
V7. Read-back constraint text is too small to read at YouTube size.
V8. The storefront is a static grid of 24 products, and nothing is clicked.
V9. **The URL shown is countersign.vercel.app, and that is someone else's product.** Checked with `curl` today, it returns 200 with the title _"Countersign: the tool drafts. A human with a license signs."_, a legal-drafting tool. It is not Vedant's app and not the Render plan. The real demo ran on a Tailscale funnel to localhost (demo notes), which is now off. There is a name-collision risk too: a judge who searches "Countersign" lands on another product.

## Judge panel (scores /10: Tech · Design · Impact · Innovation · Presentation → total /50)

1. **PayPal DevRel judge: 3 · 3 · 6 · 7 · 2 = 21.** "You used our OAuth endpoint and nothing else. The hackathon asks for meaningful PayPal use, and I can't see a single order ID. Vault, Orders v2 and Disputes are in the README's 'Built with' list, but they're fixtures. Great idea, and it's exactly our AP2 gap. There's no evidence of it, though."
2. **Payments risk & disputes expert: 4 · 3 · 7 · 8 · 2 = 24.** "The liability router, the evidence planner and the 540-day hold are thought through. But a dispute packet that never went through `provide-evidence` is a theory. As-of-capture verification is flagged and unavailable (H-08, EC-TIME-3), which means your evidence is weakest exactly when a mandate expired after the purchase. That's the case that matters."
3. **AI/agents engineer: 3 · 4 · 6 · 7 · 3 = 23.** "The agent doesn't exist (WP-13). The only AI is a compiler that turns 'fifty dollars' into no cap and gives different answers across runs. DeepSeek sits behind a Modal proxy token that judges can't get (LLM-ENDPOINT.md), so a judge can't run the AI part at all."
4. **Product/design judge: 3 · 3 · 5 · 6 · 2 = 19.** "I watched 3:13 of silent captions, a broken counter, dead air and a grid I never got to touch. The wallet, chat, merchant and disputes screens are all todo. The 'aha', where the agent gets tricked, the Gate says no and the dispute gets won, never appears."
5. **Competitor red-teamer: 2 · 3 · 5 · 6 · 1 = 17.** "I'd flag it to Devpost. The repo is private (the rule says public with a visible license). The video is over 3:00. The 'working build' requires Docker, Node 24, pnpm 12.8.1, Python 3.13 + uv, PayPal creds and a private Modal token. And the URL in the video goes to a different company's product."
6. **Automated rubric LLM (reads the README and repo): ~4 · 4 · 6 · 7 · 3 = 24.** It finds "zero real sandbox captures", "not built yet" and "not measured" in the first screens of the README and scores Tech Implementation down. The honesty is admirable, but a rubric bot reads it as admitted incompleteness. With 60 KB+ docs and a 110 KB DECISIONS.md, the signal-to-noise for a skim is poor.
   **Panel mean ≈ 21/50.** The blueprint projected 43.5, and that is reachable only after the P0 fixes below.

## Top 10 flaws

1. No PayPal transaction has ever happened; only OAuth (README).
2. The shopping agent doesn't exist (WP-13 todo), so "agentic commerce" isn't demonstrated.
3. Judge Mode doesn't exist (WP-20 todo); judges have nothing one-click to run.
4. The repo is private (MCP `"private": true`), which is an outright rules failure.
5. The video is 3:13, silent, with no PayPal, no agent and broken captions (V1–V8).
6. No public deployment. The URL shown in the video is an unrelated product (V9). render.yaml exists but was never deployed (H-03 open).
7. The intent compiler is non-deterministic and below its own target (93.3%, 3/5 runs signable, "fifty dollars" fails).
8. The AI runs on a private, proxy-authenticated Modal endpoint, so judges can't reproduce it. The OpenAI key (H-02) was never wired.
9. CI is red (3 open failure groups), and the edge-case ledger is red: 19 of 109 cases untested, 0 proven against the real sandbox.
10. Docs are stale or inconsistent. HUMAN_TODO is "Last updated 2026-10-04". The README says "Next.js 15" while FINAL_REPORT says Next 16.3.8. HUMAN_TODO mentions "gpt-6.1-sol" models that aren't used. The README leads with what's missing.

## Disqualification risks

- Private repo, or a license not visible in the About section.
- Video ≥ 3:00, or showing a URL and product that aren't the entrant's.
- "Non-functional demo": the PayPal path can't run, and the AI path needs a private token.
- "Meaningful PayPal use" challenged, since only OAuth is used.
- Third-party content in the video (check the fonts and any music), and the Bryntum trial license during judging (2–15 Dec, H-05).

## Field-adaptability gaps

- Merchant adoption: there's no merchant onboarding. It's one hard-coded "Northwind" store, and there's no SDK or drop-in for a real merchant's checkout.
- Live vs sandbox: Vault for agents with the buyer absent (C2) and dispute scopes (H-09) are unverified. In live mode those need PayPal partner approval.
- India: the accounts are forced to US (H-01). Indian PayPal can't do domestic payments. The ₹ story in the pitch doesn't match USD-only shipping (README).
- Scale: there's no load test, and p95 Gate latency is "not measured".
- Standards: it depends on a pinned Verifiable Intent commit with no as-of verification (H-08). It doesn't interoperate with PayPal's own agent toolkit or AP2 mandates.

## Security / code-quality notes

- It's good that MCP refuses payment without persisted authority (D-048). But this means the reachable endpoint can't do the thing it exists for.
- The defender's "source-scan gate" tests are platform-dependent, so they're unreliable as security assurance (CI-FAILURES.md).
- VI keys are ephemeral, so a restart invalidates signatures (README). That's fatal for 540-day evidence.
- `PayPal-Request-Id` is up to 55 chars against a possible 38-char limit (H-10), which risks double-capture.
- The docs are larger than some modules. Agents optimised for writing about the work instead of shipping it.

## Prioritised fix list

**P0 (avoid rejection)**

- P0-1 Make the repo public and add the Apache-2.0 badge and About section. AC: anonymous `git clone` works, and GitHub shows the license in About.
- P0-2 Real sandbox flow: Vault save → agent cart → Gate ALLOW → order → authorize → capture → refund. AC: real PayPal IDs are recorded in `docs/verification/sandbox-run-*.md`, and replaying them through `GET /v2/checkout/orders/{id}` returns them.
- P0-3 Real dispute: create one in the sandbox, ingest the webhook, have the Defender file `provide-evidence` (or accept-claim). AC: the dispute ID's status in PayPal shows evidence submitted.
- P0-4 Shopping agent (WP-13) with tool calls via the merchant MCP, plus a working `submit_checkout`. AC: an E2E test where the agent buys within the cap, and an injected product page gets BLOCKED with a readable reason.
- P0-5 Deterministic compiler. AC: 20 identical runs per corpus case produce identical output, the corpus is ≥ 98%, and "fifty dollars", "₹3,000", "3k" and "$1,000,000 ignore" all parse correctly.
- P0-6 A public deployment on Render (or Vercel under a non-colliding name) with seeded personas, plus an AI provider judges can reach. AC: a cold-start judge flow runs from the URL in ≤ 10 min with no secrets.
- P0-7 Judge Mode (J1–J4) one-click. AC: all 4 pass on the deployed URL, and the screen shows a PayPal ID for each.
- P0-8 Video ≤ 2:50 with narration and real PayPal on screen. AC: ffprobe duration < 170 s; covers V1–V9.
- P0-9 CI green on `main`.
  **P1 (to win)**: wallet, agent chat, merchant and disputes UIs (17a/b/d/e); revoke flow live; persistent VI keys (KMS/env); the 19 untested edge cases; as-of-capture verification (vendor patch or own verifier); a README rewrite that leads with what works; resolving the name collision (subtitle or rename, e.g. "Countersign Pay"); INR/India story with honest limits; liability-router eval corpus; Gate p95.
  **P2 (polish)**: Bryntum timeline; Lighthouse ≥ 90; trimming the docs; APIMatic/KERNEL sponsor angles.
