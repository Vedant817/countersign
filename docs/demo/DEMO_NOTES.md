# Demo notes

- **Branch:** `demo/video-2026-11-12`
- **HEAD (at time of this cut):** see git log (script/video/notes committed on this branch).
- **Video:** `docs/demo/countersign-demo.mp4` — real screen-capture take assembled from Playwright-driven screenshots of the live `localhost:3210` app, ~119s, 1920x1080, H.264 + AAC, muxed with narration (`edge-tts en-US-AndrewNeural` from `docs/demo/narration.txt`). `ffmpeg -vf freezedetect=n=-60dB:d=3` reported no freezes.
- **Capture script:** `scripts/record-demo.mjs` (Playwright + system Edge, drives the app and saves beat screenshots to `docs/demo/record/`).
- **Previous demo assets preserved:** `docs/demo/countersign-demo-full-replay.mp4`, `docs/demo/README.md`.

## REAL vs SIMULATED

- **REAL (sandbox, shown in the product):** Gate **ALLOW** in `/agent` created a real PayPal sandbox **AUTHORIZE** order (no payment source) via Orders v2 — **PayPal order id `0RA35080R1542652Y`**, status **CREATED/unpaid**, shown in the order panel with `custom_id` and re-read from PayPal (`GET /v2/checkout/orders/{id}`). No capture/authorize possible (no vaulted buyer creds) — nothing is marked **captured** or **paid**.
- **Gate BLOCK:** injected/out-of-scope listing attempt blocked by the Gate (limits held) in `/agent`.
- **SIMULATED:** `/disputes` shows two **fixture disputes** (PayPal dispute/capture ids are fixtures; a real dispute requires a captured payment and this demo never captures). **Downstream is the production pipeline:** deterministic router (`R-UNAUTH-1` CONTEST, `R-SNAD-AGENT` REFUND), evidence planning, drafter with citation checking (template fallback when the model is rate-limited/unavailable — logged honestly), and packet PDF rendering.
- **Verifier `/v/pkt_F1RSTCASE10000000000000000`:** Demo branch runs the **real offline verifier** over fixture rows with **no JWKS** and **no live “Verify now”**. Bundle digest/custom_id integrity checks are recomputed; signature/chain checks are **SKIPPED** honestly. Banner labels the packet as **SIMULATED**; fixture-only inapplicable checks are omitted rather than shown as failures. No hand-forged chain artefacts; checks not weakened.

## On-screen/known honest labels
- Disputes/fixtures labeled **SIMULATED** (pages + verifier banner).
- Order shown as **CREATED/unpaid** with real PayPal order id `0RA35080R1542652Y` and re-read from PayPal (never captured/paid).
- No `countersign.vercel.app` shown (localhost:3210).
- Drafter may show deterministic template fallback if the LLM endpoint is rate-limited (429).

## Vedant’s remaining to-dos
- Optional polish: tighter narration-to-action sync or a continuous interaction recording (this cut is screenshot-timed to narration) and burned captions/SRT if desired.
- If re-recording, capture a fresh real PayPal sandbox order id on screen and update these notes.
- **Repo public, YouTube Public upload, Devpost submission** (closes Fri 13 Nov 1:30 AM IST) — Vedant only.
- Run `pnpm secret-scan` before push; `.env*` must remain uncommitted (an `apps/web/.env.local` helper may exist locally with sandbox creds — do not commit it).
- Push branch / merge per project rules when ready. Final video file due **Thu 12 Nov 11:00 PM IST**.
