"""Read docs/demo/narration.vtt and print JSON beat timings.

The recorder cannot parse the VTT from Node (no dependency to add), so this
script is the single source of truth for *when* each beat has to start, and it
is committed next to the narration it reads.

Usage: python scripts/demo-beats.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

VTT = Path(__file__).resolve().parent.parent / "docs" / "demo" / "narration.vtt"

TIMESTAMP = re.compile(
    r"(?P<start>\d{2}:\d{2}:\d{2},\d{3}) --> (?P<end>\d{2}:\d{2}:\d{2},\d{3})\s*\n(?P<body>.*?)(?=\n\n|\Z)",
    re.S,
)


def seconds(stamp: str) -> float:
    hours, minutes, rest = stamp.split(":")
    whole, millis = rest.split(",")
    return int(hours) * 3600 + int(minutes) * 60 + int(whole) + int(millis) / 1000


def cues() -> list[tuple[float, float, str]]:
    text = VTT.read_text(encoding="utf-8-sig")
    found: list[tuple[float, float, str]] = []
    for match in TIMESTAMP.finditer(text):
        body = " ".join(match.group("body").split())
        found.append((seconds(match.group("start")), seconds(match.group("end")), body))
    return found


def beat_start(fragment: str, search_from: float = 0.0) -> float:
    """Wall-clock offset at which the cue containing `fragment` begins."""
    lowered = fragment.lower()
    for start, _end, body in cues():
        if start < search_from:
            continue
        if lowered in body.lower():
            return start
    raise SystemExit(f"narration.vtt has no cue containing: {fragment!r}")


def main() -> None:
    beats = {
        # The buyer types on the mandate form.
        "mandate_intent": beat_start("the buyer states intent"),
        # The mandate is signed and the chip is on screen.
        "mandate_signed": beat_start("signed constraints the buyer can review"),
        # The turn is sent and the Gate is evaluating.
        "checkout": beat_start("the Gate evaluates the purchase"),
        # ALLOW + the real PayPal order panel.
        "allow": beat_start("the Gate returns ALLOW"),
        # The order id / status / re-read.
        "re_read": beat_start("we can re-read it directly"),
        # The injected listing is blocked.
        "block": beat_start("the Gate blocks it"),
        # "cannot spend outside the signed mandate"
        "hold": beat_start("cannot spend outside"),
        # The rule table.
        "defender": beat_start("the Dispute Defender runs a deterministic rule table"),
        # The two fixture cases.
        "disputes": beat_start("two simulated dispute cases"),
        # The packet PDF / QR.
        "packet": beat_start("evidence packet PDF with a QR code"),
        # The public verifier.
        "verifier": beat_start("scanning it opens the public verifier"),
        # The closing line.
        "close": beat_start("makes agent payments provable"),
    }
    all_cues = cues()
    out_dir = VTT.parent / "record"
    out_dir.mkdir(parents=True, exist_ok=True)

    # The cue strip, for the holds: the recorder types the current line in as it is spoken.
    spoken = [
        {"start": round(start, 3), "end": round(end, 3), "text": " ".join(body.split())}
        for start, end, body in all_cues
        if body.strip() and not body.strip().startswith("#")
    ]
    (out_dir / "cues.json").write_text(json.dumps(spoken, indent=2) + "\n", encoding="utf-8")
    (out_dir / "beats.json").write_text(json.dumps(beats, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({"duration": all_cues[-1][1], "beats": beats}, indent=2))


if __name__ == "__main__":
    main()