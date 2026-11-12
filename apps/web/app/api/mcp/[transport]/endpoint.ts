/**
 * Where the merchant MCP is mounted — **one definition, two readers** (`docs/PROD_AUDIT.md` §8.7).
 *
 * ## Why this file exists
 *
 * The path is declared by this route's directory (`app/api/mcp/[transport]/route.ts` answers
 * `/api/mcp/{transport}`) and used by a second route, `app/api/agent/run/route.ts`, which opens an MCP
 * **client** against it: the demo's agent runs in this process and talks to our own merchant tools. The
 * path was written as a literal in both places, so the coupling that makes the demo work — `[transport]`
 * happening to be `http` — was invisible until someone renamed the segment and the agent started failing at
 * runtime with a 404 that looks like an auth problem.
 *
 * Co-locating the constant with the route means a rename moves it with the thing it names. It is
 * deliberately *not* derived from the filesystem: a runtime module cannot know its own URL path, and
 * pretending otherwise (a regex over `__dirname`) is the same class of accident as the duplicated literal.
 *
 * ## What is still a self-call, and why that is honest
 *
 * The agent's MCP client still makes an HTTP request to this app. That is a real coupling, not an
 * oversight: `packages/agent` consumes an MCP *client* and the merchant tools are served by this app, so
 * either the agent calls over HTTP or the tool runtime is duplicated in-process. A deployment that splits
 * the two would need a configurable base URL; this one does not, and inventing an env var nothing reads
 * would be the half-feature the audit is trying to remove.
 *
 * ## Why there is no transport whitelist here
 *
 * `[transport]` is a pass-through to `mcp-handler`, which serves the Streamable HTTP mount at `/http` and
 * the legacy SSE mount at `/sse`. A list of allowed values in this file would be configuration nothing
 * reads — the route does not check it — and that is the failure mode this audit keeps removing. The agent
 * uses {@link MERCHANT_MCP_PATH}; everything else about the segment stays the handler's business.
 */
export const MERCHANT_MCP_PATH = '/api/mcp/http'

/**
 * The absolute URL of the merchant MCP, from the request's own origin.
 *
 * `origin` is `request.url` — the public origin the client used, which behind a proxy is the one that
 * answers. Building it here rather than from `headers().host` keeps the two routes in agreement about what
 * "here" means.
 */
export function merchantMcpUrl(origin: string): string {
  return new URL(MERCHANT_MCP_PATH, origin).toString()
}
