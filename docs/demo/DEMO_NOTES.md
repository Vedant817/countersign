# Demo notes (rough cut)

- **Commit:** `08e59ab` (demo work committed before this cut); this file/video committed from branch `demo/video-2026-11-12`, HEAD at commit time recorded in git log.
- **Branch:** `demo/video-2026-11-12`
- **Video:** `docs/demo/countersign-demo.mp4` — rough narration-first cut, ~108s, 1920x1080, H.264 + AAC (edge-tts `en-US-AndrewNeural` from `docs/demo/narration.txt`). Slide-based placeholder visual; intended to be replaced/iterated with a full interactive screen recording of the beats.
- **Previous demo assets preserved:** `docs/demo/countersign-demo-full-replay.mp4`, `docs/demo/README.md`.

## REAL vs SIMULATED

- **REAL (sandbox, when exercised in the demo flow):** On Gate ALLOW the agent demo path creates a real PayPal sandbox **AUTHORIZE** order (no payment source) via Orders v2 — status **CREATED/unpaid**, with `custom_id`/`invoice_id` and a re-read from PayPal (`GET /v2/checkout/orders/{id}`). No capture/authorize possible (no vaulted buyer creds) — nothing is ever marked **captured** or **paid**. (A specific order id must be captured from a live run and stated on screen if shown; this rough cut does not display a captured id.)
- **SIMULATED:** `/disputes` shows two **fixture disputes** (PayPal dispute/capture ids are fixtures; a real dispute requires a captured payment and this demo never captures). **Downstream is the production pipeline:** deterministic router (`R-UNAUTH-1` CONTEST, `R-SNAD-AGENT` REFUND), evidence planning, drafter with citation checking (template fallback when the model is rate-limited/unavailable — logged honestly), and packet PDF rendering.
- **Verifier `/v/<fixture packetId>`:** Demo branch runs the **real offline verifier** over fixture rows with **no JWKS** and **no live “Verify now”**. Bundle digest/custom_id integrity checks are recomputed; signature/chain checks are **SKIPPED** honestly. Banner labels the packet as **SIMULATED**; fixture-only inapplicable checks are omitted rather than shown as failures. No hand-forged chain artefacts; checks not weakened.

## On-screen/known honest labels
- Disputes/fixtures labeled **SIMULATED**.
- Order panel (when shown in interactive recording) must state **CREATED/unpaid**, never captured/paid without a re-readable PayPal id.
- Drafter may show deterministic template fallback if the LLM endpoint is rate-limited (429) — acceptable if stated.

## Vedant’s remaining to-dos
- Record/iterate the **full interactive take** per `FIX_PROMPT.md` §6 beats: `/agent` (mandate → Gate ALLOW → real sandbox order panel + Re-read from PayPal, and an injected/out-of-scope listing BLOCK), `/disputes` (both cases), packet PDF/QR, `/v` verifier — with on-screen SIMULATED labels and no `countersign.vercel.app` URLs.
- Capture and include a **real, re-readable PayPal sandbox order id** on screen if claiming an order was created.
- Run `ffmpeg -vf freezedetect` QC; ensure duration **< 2:55**, 1080p30, burned/readable captions or slides; keep narration in sync.
- Replace this rough cut with the final `docs/demo/countersign-demo.mp4` (+ `.srt` if used) and update these notes with final duration, exact PayPal ids shown, and final commit hash.
- Commit final assets before **Thu 12 Nov 11:00 PM IST**.
- **Repo public, YouTube Public upload, Devpost submission** (closes Fri 13 Nov 1:30 AM IST) — Vedant only.
- Blur any tokens/secrets if ever visible (none should be). `.env*` must remain uncommitted.
- Push branch / merge per project rules when ready (`pnpm secret-scan` before push).
