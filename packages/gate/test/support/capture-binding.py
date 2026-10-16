"""Capture public responses from the real HTTP vi driver, without any database."""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import urllib.request

here = pathlib.Path(__file__).resolve().parent
child = subprocess.Popen(
    [sys.executable, str(here / "live-vi-chain.py")],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
)
try:
    assert child.stdout is not None
    line = child.stdout.readline()
    if not line.startswith("@@CHAIN@@"):
        raise RuntimeError("vi driver did not emit its HTTP response capture")
    chain = json.loads(line[len("@@CHAIN@@"):])
    with urllib.request.urlopen(chain["base_url"] + "/v1/jwks", timeout=10) as response:
        jwks = json.load(response)
    capture = {
        "provenance": {
            "captured_at_utc": chain["captured_at_utc"],
            "source": "live-vi-chain.py: real apps/vi HTTP signing and verification routes",
            "note": "Public tokens and responses only; no private keys or service credentials. Replay id is the unmodified /v1/l3/create response value.",
        },
        "verify_request": chain["verify_request"],
        "verify_response": chain["verify_response"],
        "l3_create_response": {
            "l3a": chain["l3a"], "l3b": chain["l3b"], "jti": chain["jti"],
            "checkout_hash": chain["checkout_hash"],
        },
        "jwks": jwks,
    }
    target = here.parent / "fixtures" / "vi-binding-replay-capture.json"
    target.write_text(json.dumps(capture, indent=2) + "\n", encoding="utf-8")
    delegates = chain["verify_response"]["disclosed"]["l3b"]["delegate_payload"]
    for index, entry in enumerate(delegates):
        if entry.get("vct") == "mandate.checkout.1":
            print(f'verify.disclosed.l3b.delegate_payload[{index}] = ' + json.dumps(entry))
    print('/v1/l3/create jti = ' + chain["jti"])
    print('capture = ' + str(target))
finally:
    child.terminate()
    child.wait(timeout=10)
