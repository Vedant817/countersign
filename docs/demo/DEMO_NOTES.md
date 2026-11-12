# Demo notes

- **Branch:** `demo/video-2026-11-12`
- **Video:** `docs/demo/countersign-demo.mp4` — **one continuous Playwright recording** of the live
  `localhost:3210` app, cut to the narration rather than padded to fit it.
  - **Duration:** 107.23s (narration 106.44s)
  - **Size:** 41.4 MB (43,426,671 bytes)
  - **SHA-256:** `229f2c6d0ebdb4827daefbc56fd188a68aa196fb7a3825d2d04c706a7b96e67a`
  - **Picture:** 1920x1080 H.264 @30fps + AAC. Captured at 1280x720 CSS px with
    `deviceScaleFactor: 1.5`, so the app is at 150% zoom and every page scrolls.
  - **QC:** `ffmpeg -vf freezedetect=n=0.003:d=4` reports **no freeze longer than 4s**.
- **Capture script:** `scripts/record-demo.mjs` — Playwright (bundled Chromium, `recordVideo`,
  `slowMo: 150`) drives the app with visible typing and clicking; raw take kept at
  `docs/demo/record/take.webm` (VP8, 107.24s).
- **Beat timings:** `scripts/demo-beats.py` parses `docs/demo/narration.vtt` and writes
  `docs/demo/record/beats.json` (+ `cues.json`), which the recorder reads. Each beat starts on the
  wall-clock offset where its narration line begins.

## Why the first cut was replaced

The earlier `dc3afc5` take was 89s of recording stretched over 106.5s of narration with an 18s clone
of its last frame, so the screen froze while the narration kept talking. `freezedetect` at
`n=-60dB:d=3` missed it because the clone was bit-identical rather than near-identical. This take is
recorded to the narration's length: nothing is padded, and the hold beats scroll the page under a
narration-caption strip instead of sitting on a still frame.

## REAL vs SIMULATED

- **REAL (sandbox, shown in the product):** Gate **ALLOW** in `/agent` created a real PayPal sandbox
  **AUTHORIZE** order (no payment source) via Orders v2 — **PayPal order id `6R484087XG716750A`**,
  status **CREATED/unpaid**, shown in the order panel with its `custom_id` and re-read from PayPal
  (`GET /v2/checkout/orders/{id}`) by clicking **Re-read from PayPal**. No capture/authorize is
  possible (no vaulted buyer) — nothing is marked **captured** or **paid**.
- **Gate BLOCK:** the injected/out-of-scope listing is refused by the Gate (limits held) in `/agent`.
- **SIMULATED:** `/disputes` shows two **fixture disputes** (PayPal dispute/capture ids are fixtures;
  a real dispute requires a captured payment and this demo never captures). **Everything downstream
  of the dispute is the production pipeline:** deterministic router (`R-UNAUTH-1` CONTEST,
  `R-SNAD-AGENT` REFUND), evidence planning, drafter with citation checking (deterministic template
  fallback when the model is rate-limited/unavailable — logged), and packet PDF rendering.
- **Verifier `/v/pkt_F1RSTCASE10000000000000000`:** demo branch runs the **real offline verifier** over
  fixture rows with **no JWKS** and **no live "Verify now"**. Bundle digest/custom_id integrity checks
  are recomputed; signature/chain checks are **SKIPPED** with the reason. Banner labels the packet
  **SIMULATED**; fixture-only inapplicable checks are omitted rather than shown as failures. No
  hand-forged chain artefacts; no weakened checks.

## On-screen / known honest labels

- Disputes/fixtures labelled **SIMULATED** (pages + verifier banner).
- Order shown as **CREATED/unpaid** with real PayPal order id `6R484087XG716750A`, re-read from PayPal
  (never captured/paid).
- No `countersign.vercel.app` anywhere in the recording (localhost:3210 only).
- Holds carry a caption strip with the narration line being spoken, plus the page scrolling; both are
  real screen content, not overlays added in post.

## Vedant's remaining to-dos

- YouTube upload (Public) and Devpost submission (closes Fri 13 Nov 1:30 AM IST).
- Optional: burned captions / SRT if wanted; the video relies on narration plus the hold captions.
- If re-recording, capture a fresh real PayPal sandbox order id and update this file.
- Keep `apps/web/.env.local` (local sandbox credentials) out of git — it is gitignored.
- Final video file due **Thu 12 Nov 11:00 PM IST**.
