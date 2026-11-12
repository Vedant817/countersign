# Demo notes

- **Branch:** `demo/video-2026-11-12`
- **Video:** `docs/demo/countersign-demo.mp4` — **one continuous Playwright recording** of the live `localhost:3210` app (not a slideshow), 1920x1080 H.264 @30fps + AAC, muxed with narration (`edge-tts en-US-AndrewNeural` from `docs/demo/narration.txt`).
  - **Duration:** 107.07s (narration 106.5s; the tail holds the verifier page for the closing lines)
  - **Size:** ~11.0 MB
  - **QC:** `ffmpeg -vf freezedetect=n=-60dB:d=3` reported no freezes
- **Capture script:** `scripts/record-demo.mjs` — Playwright (bundled Chromium, `recordVideo` at 1920x1080, `slowMo: 150`) drives the app with visible typing/clicking; raw take kept at `docs/demo/record/take.webm` (VP8, 89.1s).
- **Previous demo assets preserved:** `docs/demo/countersign-demo-full-replay.mp4`, `docs/demo/README.md`.

## REAL vs SIMULATED

- **REAL (sandbox, shown in the product):** Gate **ALLOW** in `/agent` created a real PayPal sandbox **AUTHORIZE** order (no payment source) via Orders v2 — **PayPal order id `0MR933308Y8745901`**, status **CREATED/unpaid**, shown in the order panel with its `custom_id` and re-read from PayPal (`GET /v2/checkout/orders/{id}`) by clicking **Re-read from PayPal**. No capture/authorize is possible (no vaulted buyer) — nothing is marked **captured** or **paid**.
- **Gate BLOCK:** the injected/out-of-scope listing is refused by the Gate (limits held) in `/agent`.
- **SIMULATED:** `/disputes` shows two **fixture disputes** (PayPal dispute/capture ids are fixtures; a real dispute requires a captured payment and this demo never captures). **Everything downstream of the dispute is the production pipeline:** deterministic router (`R-UNAUTH-1` CONTEST, `R-SNAD-AGENT` REFUND), evidence planning, drafter with citation checking (deterministic template fallback when the model is rate-limited/unavailable — logged), and packet PDF rendering.
- **Verifier `/v/pkt_F1RSTCASE10000000000000000`:** demo branch runs the **real offline verifier** over fixture rows with **no JWKS** and **no live “Verify now”**. Bundle digest/custom_id integrity checks are recomputed; signature/chain checks are **SKIPPED** with the reason. Banner labels the packet **SIMULATED**; fixture-only inapplicable checks are omitted rather than shown as failures. No hand-forged chain artefacts; no weakened checks.

## On-screen/known honest labels
- Disputes/fixtures labelled **SIMULATED** (pages + verifier banner).
- Order shown as **CREATED/unpaid** with real PayPal order id `0MR933308Y8745901`, re-read from PayPal (never captured/paid).
- No `countersign.vercel.app` anywhere in the recording (localhost:3210 only).
- Drafter may show the deterministic template fallback if the LLM endpoint is rate-limited (429).

## Vedant's remaining to-dos
- YouTube upload (Public) and Devpost submission (closes Fri 13 Nov 1:30 AM IST).
- Optional: burned captions / SRT if wanted; the video currently relies on narration.
- If re-recording, capture a fresh real PayPal sandbox order id and update this file.
- Keep `apps/web/.env.local` (local sandbox credentials) out of git — it is gitignored.
- Final video file due **Thu 12 Nov 11:00 PM IST**.