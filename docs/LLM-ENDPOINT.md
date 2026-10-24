# The model endpoint — Modal Endpoints (token-billed)

Replaces the self-hosted `infra/modal/llm.py` app, which billed **GPU-seconds** and was stopped on
24 October 2026 for exactly that reason. Two containers sat idle between requests, and a 15 GB cold
start cost ~90 s of L4 time before the first token was produced. The managed endpoint bills **per
token**, so an unused deployment costs nothing and a warm one answers immediately.

## What is live

|                         |                                                                                |
| ----------------------- | ------------------------------------------------------------------------------ |
| Endpoint                | `deepseek-v4-1-flash` · **shared** (token-billed)                              |
| Endpoint ID             | `ep-FTNqR30YRqMaUtWc7TtaTb`                                                    |
| Model                   | `deepseek-ai/DeepSeek-V4.1-Flash`                                              |
| URL                     | `https://vedantmahajan271--ep-deepseek-v4-1-flash-server.us-west.modal.direct` |
| Base for OpenAI clients | `…/v1`                                                                         |
| `requires_proxy_auth`   | **`true`** — see below                                                         |
| Context                 | 1,048,576 tokens                                                               |
| Status                  | live, verified 24 Oct 2026                                                     |

A second endpoint exists if this one is ever rate-limited:
`glm-5-3-flash` (`zai-org/GLM-5.3-Flash`), `ep-9EdarJSkfRXi0TsIEtwlO0`.

## Why this model, and what it unblocks

`GET /v1/models` reports:

```json
"supported_features": ["tools", "json_mode", "structured_outputs", "reasoning"]
```

All three of the app's jobs are covered by a declared capability rather than by prompting and hoping:

| Job                                           | Package             | Needs                                                                               |
| --------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| Compile plain-English intent into constraints | `packages/compiler` | `structured_outputs` — the schema is enforced by the server, not by asking politely |
| Drive the shopping agent                      | `packages/agent`    | `tools` — real `tool_calls`, so the agent is not a prompt parser                    |
| Draft dispute notes with citations            | `packages/defender` | text; the citation checker is deterministic, so a bad draft is rejected, not filed  |

`reasoning` is available with effort levels `none | low | high | xhigh | max`, which is worth setting
explicitly per call site rather than inheriting a default: the compiler wants determinism, the
defender wants prose.

## The one thing blocking it

Modal's `.direct` URLs are private and `requires_proxy_auth: true`. Our client authenticates with
`Authorization: Bearer <key>`, which this endpoint does not accept — it wants Modal's proxy headers:

```
Modal-Key: <proxy token id>
Modal-Secret: <proxy token secret>
```

Proxy tokens are **not** creatable from the CLI (`modal token` only manages API credentials), so this
is a human step:

1. Open <https://modal.com/settings/proxy-auth-tokens>.
2. **Create token**, name it `countersign`.
3. Put the two values in `.env.local`:

```sh
MODAL_PROXY_TOKEN_ID=wk-...
MODAL_PROXY_TOKEN_SECRET=ws-...
```

`OPENAI_BASE_URL` is already pointed at the endpoint in `.env.local`.

Four ways to avoid the token, for the record, and why none of them is right yet:

- **Publish the endpoint.** Possible in the dashboard, but it makes a paid inference endpoint callable
  by anyone who finds the URL. Fine for a demo, not something to switch on by default.
- **Use `modal curl`.** It injects the headers locally, which is how this was verified — but it is a
  CLI wrapper, so the app cannot call through it.
- **Self-host again.** That is what was just stopped, for cost.
- **A different provider.** `OPENAI_BASE_URL` already supports Groq, OpenRouter, Google AI Studio,
  Together, Cerebras and a local Ollama (`docs/SECRETS-SETUP.md` §2), so nothing is blocked on this —
  it is the cheapest good option, not the only one.

## Verified, and how

```sh
modal curl -s https://vedantmahajan271--ep-deepseek-v4-1-flash-server.us-west.modal.direct/v1/models
```

returned the model card above. A `curl` with no proxy headers returns
`404 modal-http: invalid function call`, which is what the app will see until the token is set — worth
recognising so it is not misread as a wrong URL.

## Stopped

`countersign-llm` — `modal app stop countersign-llm --yes`. State is now `stopped`; the app definition
remains in the dashboard and can be restarted, but nothing bills while it is stopped.
`infra/modal/llm.py` is kept as the record of what was tried, not as a deployment to run.
