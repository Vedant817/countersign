"""
Countersign's model endpoint — vLLM on Modal, OpenAI-compatible.

Deploy:
    modal deploy infra/modal/llm.py

Then in `.env.local`:

    OPENAI_API_KEY=modal          # vLLM ignores the value; the OpenAI client requires one
    OPENAI_BASE_URL=https://vedantmahajan271--countersign-llm-serve.modal.run/v1
    LLM_MAIN_MODEL=Qwen/Qwen2.5-7B-Instruct
    LLM_CHEAP_MODEL=Qwen/Qwen2.5-7B-Instruct

## Why this model

The app asks a model for three things, in descending order of difficulty:

1. **Compile a plain-English intent into constraints** — `packages/compiler`. Needs exact JSON in a
   fixed schema, and a wrong field is caught by zod rather than acted on (`§8.0` rule 4).
2. **Drive the shopping agent** — `packages/agent`. Needs OpenAI-style **tool calling**, which is the
   discriminating feature: a model that cannot emit `tool_calls` makes the agent a prompt-parser.
3. **Draft a dispute note with citations** — `packages/defender`. Needs prose, but the citation
   checker is deterministic, so quality shows up as a rejected draft, not as a wrong filing.

`Qwen/Qwen2.5-7B-Instruct` is the pick because it is the smallest model that does all three well:

- **Not gated.** No Hugging Face token, no licence click-through — `meta-llama/*` needs both, which
  would make a judge's reproduction of this deployment fail at the first step.
- **Real tool calling.** Qwen2.5's chat template emits tool calls natively and vLLM parses them via
  `--enable-auto-tool-choice --tool-call-parser hermes`, so the agent path works rather than
  degrading to regex.
- **Fits one L4 (24 GB) in bf16** — ~15 GB of weights plus KV cache. An A10G or A100 would work and
  cost 2-6x more for a demo that answers a handful of questions.
- **Strong JSON adherence** for its size, which is what the compiler actually needs.

Swapping is one variable: set `MODEL_NAME` below to `Qwen/Qwen2.5-14B-Instruct` (fits A10G/L40S) or
`Qwen/Qwen3-8B` for a newer architecture. Everything else stays.

## Cost

Modal bills **GPU-seconds**, not tokens — the "per token" figure in a dashboard is derived. An L4 is
about $0.80/hour, and this app's usage is a few thousand tokens per interaction, so the honest number
is "cents per demo run". Two settings matter more than the model:

- `SCALEDOWN_WINDOW_SEC` keeps the container warm between requests. At 0 every page load pays a
  ~60-90 s cold start while 15 GB of weights load from the volume; at 600 a judge's session stays
  responsive and idle time costs nothing after ten minutes.
- `MIN_CONTAINERS` is 0 by default so nothing bills while you sleep. Set it to 1 for the judging
  window (15 Nov – 15 Dec) if a cold start on first click is unacceptable, and set it back after.

## What this is not

Not a production model host. One replica, no autoscaling policy, no request queue beyond vLLM's own,
and no auth — anyone with the URL can call it. That is acceptable for a sandbox demo whose data is
already public test data; it would not be for real buyer intents, which is why
`docs/SECRETS-SETUP.md` §3 keeps the deployed environment's secrets out of this file.
"""

import modal

APP_NAME = "countersign-llm"
MODEL_NAME = "Qwen/Qwen2.5-7B-Instruct"
VLLM_VERSION = "0.6.6"

# 10 minutes: long enough that a judge clicking between screens never waits, short enough that an
# idle demo stops costing anything. See the cost note above.
SCALEDOWN_WINDOW_SEC = 600

# 0 = nothing bills while unused. Set to 1 for the judging window if you want zero cold starts.
MIN_CONTAINERS = 0

app = modal.App(APP_NAME)

# The weights cache is a volume rather than the container filesystem: without it every cold start
# re-downloads ~15 GB, which is both slow and the dominant cost of an idle demo.
hf_cache = modal.Volume.from_name("countersign-hf-cache", create_if_missing=True)

vllm_image = (
    # The official vLLM image, not a pip install. `pip install vllm==0.6.6` resolves to torch 2.5.1
    # plus ~2.5 GB of CUDA wheels and takes a five-minute solve every time the image is rebuilt;
    # this image already contains them.
    #
    # **Deliberately no `add_python=`.**
    #
    # Passing `add_python="3.12"` makes Modal install a *second* interpreter into `/usr/local`, which
    # then shadows the image's own on `PATH`. The image's Python is the one with vLLM in its
    # site-packages, so the server died with `ModuleNotFoundError: No module named 'vllm'` — a
    # failure that reads like a missing dependency and is really a `PATH` collision. Leaving it unset
    # makes Modal use the interpreter the image ships.
    #
    # `.entrypoint([])` clears the image's own CMD so `serve()` starts the server itself.
    modal.Image.from_registry(f"vllm/vllm-openai:v{VLLM_VERSION}")
    .entrypoint([])
    .env(
        {
            # Parallel weight downloads. Has no effect on serving, only on the first start.
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            # vLLM writes logs to stdout; Modal captures them, which is where `list_logs` reads from.
            "VLLM_LOGGING_LEVEL": "INFO",
        }
    )
)


@app.function(
    image=vllm_image,
    gpu="L4",
    # The endpoint is long-lived; the timeout bounds a single request, not the container.
    timeout=60 * 20,
    volumes={"/root/.cache/huggingface": hf_cache},
    scaledown_window=SCALEDOWN_WINDOW_SEC,
    min_containers=MIN_CONTAINERS,
)
@modal.web_server(port=8000, startup_timeout=60 * 20)
def serve() -> None:
    """
    Start vLLM's OpenAI-compatible server.

    `subprocess.Popen` rather than `modal.method()`: the web server has to bind the port while this
    function is still running, so it cannot block. Modal watches the port and forwards traffic; if the
    process dies the container exits and the next request starts a fresh one.
    """
    import subprocess

    subprocess.Popen(
        [
            "python",
            "-m",
            "vllm.entrypoints.openai.api_server",
            "--model",
            MODEL_NAME,
            "--served-model-name",
            MODEL_NAME,
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
            # 8k is enough for the compiler's prompt plus a read-back, and it keeps the KV cache
            # small enough that one L4 serves several concurrent demo requests instead of queueing.
            "--max-model-len",
            "8192",
            # Tool calling, so `packages/agent` gets real `tool_calls` rather than parsing prose.
            "--enable-auto-tool-choice",
            "--tool-call-parser",
            "hermes",
            # The compiler asks for JSON; this makes the server enforce it instead of hoping.
            "--guided-decoding-backend",
            "outlines",
        ]
    )


@app.local_entrypoint()
def check() -> None:
    """
    Smoke-test a deployed endpoint from your machine:

        modal run infra/modal/llm.py::check

    Deliberately a plain HTTP call rather than an SDK: it proves the endpoint is OpenAI-compatible
    from the outside, which is the only property `OPENAI_BASE_URL` depends on.
    """
    import json
    import urllib.request

    url = f"https://vedantmahajan271--{APP_NAME}-serve.modal.run/v1/chat/completions"
    payload = {
        "model": MODEL_NAME,
        "messages": [
            {
                "role": "user",
                "content": "Reply with exactly this JSON and nothing else: {\"ok\":true}",
            }
        ],
        "max_tokens": 64,
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json", "authorization": "Bearer modal"},
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        body = json.load(response)

    print("endpoint:", url)
    print("model:", body.get("model"))
    print("reply:", body["choices"][0]["message"]["content"].strip())
    print("\nIf that printed JSON, set OPENAI_BASE_URL to the /v1 URL above.")
