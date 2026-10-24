# Prize strategy — what to build for, and what it costs

Verified 24 October 2026 against <https://paypalaihackathon.devpost.com/> and the sponsor detail pages.
This supersedes the summary in `HACKATHON-RESEARCH.md`; that file remains the record of the _first_
pass, this one is the decision document.

## The deadline, and what it means

**12 November 2026, 12:00 PST** (= 13 November, 1:30 AM IST). Judging 2–15 December. From today that
is **19 days**.

The critical consequence: **submissions are judged on what is deployed and demonstrable, not on what is
architected.** A working end-to-end purchase beats three unpublished packages.

## Two submission blockers, right now

| #   | Blocker                                                                                                                                               | Fix                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The GitHub repo is private.** Devpost requires "public and open source, with a license file visible at the top of the repo (in the About section)". | `gh repo edit Vedant817/countersign --visibility public --accept-visibility-change-consequences` — **needs Vedant's decision**, see below |
| 2   | No hosted URL yet. "A design mockup, static prototype, or non-functional demo does not meet" the functional-demo requirement.                         | Render MCP is connected; the blueprint is written; needs the go-ahead                                                                     |

On (1): publishing is effectively irreversible — once public, forks and caches retain it, and the
repository contains the full blueprint, `pm-panel`, and every decision log. That is _fine_ for a
hackathon submission, and required by the rules, but it is a one-way door and should be opened
deliberately rather than as a side effect.

## Judging criteria — equal weight, so budget accordingly

1. **Technological Implementation** — genuine effort, non-trivial, working.
2. **Design** — "a complete, coherent product experience — not just a technical proof of concept".
3. **Potential Impact** — "a credible, specific case for solving a real problem for a real audience".
4. **Innovation/Idea** — how novel, how different from existing concepts.
5. **Presentation** — the video _demonstrates it working end-to-end_.

Criterion 2 is the one this project currently fails hardest: the Gate works, the shop works, the
verifier works — but there is no coherent _product_ wrapping them. That is the argument for the
merchant surfaces below.

## Prize tracks, ranked by (fit × prize × marginal effort)

| Track                                           | Prize                            | Our fit                                                                                                                  | Marginal effort  |
| ----------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| **AG Grid** 1st/2nd/3rd                         | **$5,000 / $2,000 / $1,000** ×3  | **Very strong** — we have gate decisions, orders, disputes, refunds; a merchant dashboard is the missing product surface | Medium           |
| **Render** 1st/2nd/3rd                          | **$1,000 / $750 / $500 credits** | **Already there** — `render.yaml` is written and the MCP is connected                                                    | **Near zero**    |
| **Bryntum**                                     | **$1,000** ×3                    | **Already specified** — S-17 dispute timeline, `FEATURE_BRYNTUM` flag, table fallback                                    | Low              |
| **Channel3**                                    | **$1,500**                       | Good — commerce product search; our catalog is exactly its domain                                                        | Medium           |
| **APIMatic**                                    | **$1,000** ×3 + 6mo subscription | Moderate — SDK generation from our OpenAPI                                                                               | Low              |
| **Best Use of Agentic Commerce**                | **$5,000**                       | **Our whole thesis**                                                                                                     | Already the plan |
| **Best Use of PayPal + AI**                     | **$5,000**                       | Strong                                                                                                                   | Already the plan |
| Postman / Elastic / Zapier / KERNEL / Astropods | —                                | Varies                                                                                                                   | —                |

**Free credits and trials available — take all of them:**

- **AG Studio: free 45-day trial licence**, <https://www.ag-grid.com/studio/license-pricing/>. 45 days
  from today covers the deadline _and_ the judging window. No cost.
- **PayPal boilerplate for AG Studio**: <https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate>
  — PayPal + AG Studio already wired. Worth reading before writing anything.
- **Render**: free tier covers the deploy; the prize is credits on top.
- **Bryntum**: trial licence via HUMAN_TODO H-05.

## The recommendation: AG Studio is the highest-value addition

Two reasons, and the second is the important one.

**The obvious one:** $5,000 for first place, three prizes, and we already have the data. Gate
decisions (twelve checks each), orders, captures, refunds, disputes — this is a dashboard waiting for
a dashboard library. Judge is Sylwia Vargas, AG Grid's Senior Technical Community Manager, so the
track is judged by someone who knows the product.

**The interesting one:** AG Studio ships a **Studio Agent Framework** — "so agents can build, query,
and edit dashboards for you and alongside you". Our project is _about_ agents acting on a human's
behalf under provable limits. A merchant asking _"show me refunds above $50 this month, and why the
Gate allowed them"_ and getting a live widget — built by an agent, constrained by the same mandate
machinery — is not a bolt-on. It is the product thesis applied to its most natural second audience.

It also directly repairs judging criterion 2 (a coherent product experience) and criterion 3 (a real
audience — merchants who currently cannot see _why_ a payment was allowed).

### What that means concretely

- **S-14 merchant dashboard** becomes an AG Studio surface, not a hand-rolled table.
- **S-16 gate-decision log** is a grid: decision, outcome, the twelve checks, reason codes, latency.
  Filterable. Exportable. This is the "provably" half of the pitch made visible.
- The **agent-built widget** is the demo moment: natural language → live chart → click through to the
  signed decision record → verify it in the public verifier.

## What I am not recommending

- **KERNEL / Zapier / Astropods**: Zapier and Astropods have no obvious fit, and each is a new
  integration to learn inside 19 days.

  **KERNEL is different, and calling it "no obvious fit" was wrong.** It is cloud Chromium —
  `kernel browsers create` sessions drivable by Playwright, CDP or a JS REPL, with `--private-host` for
  reaching private hosts on a tunnel the session joins (its own docs use `*.ts.net`, i.e. Tailscale).
  Two things we actually need:
  1. **`kernel browsers replays start|stop|download`** — a real screen recording of a real browser. This
     is the demo video, and it is the thing this repository cannot otherwise produce: the T3 preview pane
     does not composite here (`visible: false`), so a screencast yields one frozen frame and eight seconds
     of black.
  2. **A browser that is not this machine.** Reaching a _deployed_ URL is the only way to check prod, and
     a cloud browser is also more honest than a local one — nothing about the environment can be
     accidentally load-bearing.

  Requires `kernel login` (interactive OAuth). The stored refresh token had expired at the time of
  writing, so nothing here has been run yet.

- **Elastic**: our catalog search is 24 seeded products. Elastic would be architecture for its own sake.
- **Postman**: worth a collection as a _documentation_ artefact for the "Tools" submission field, but it
  is not a prize track.

## The plan, in order

1. **Render deploy** — near-zero marginal effort, unblocks the hosted demo URL, and is itself a prize
   track. Do it first.
2. **AG Studio merchant dashboard** — the main build. Trial licence, then S-14/S-16 on top of the
   `gate_decisions` rows the Gate call site already produces.
3. **Bryntum timeline** (S-17) — already specified, flag already exists.
4. **Persist Gate decisions** — a prerequisite for (2): the route currently evaluates and returns
   without writing the row.
5. **Submission assets** — README run instructions, 3-minute video, tools list, public repo.

## Sources

- <https://paypalaihackathon.devpost.com/> — prizes, requirements, judging criteria
- <https://paypalaihackathon.devpost.com/details/aggrid> — AG Studio, trial licence, boilerplate
- <https://paypalaihackathon.devpost.com/rules> — official rules
