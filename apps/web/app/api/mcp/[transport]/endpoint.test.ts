/**
 * The merchant MCP path has one definition (`docs/PROD_AUDIT.md` §8.7).
 *
 * The route and the agent's MCP client used to each carry the literal `'/api/mcp/http'`, so the coupling
 * that made the demo work was invisible. These three assertions are the regression guard for that: the
 * helper resolves against an origin, the path names the transport this route serves, and no caller
 * re-introduces the literal.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { MERCHANT_MCP_PATH, merchantMcpUrl } from './endpoint'

describe('merchant MCP path', () => {
  it('resolves against the request origin, not the request path', () => {
    // A bug here would be invisible in production (origin only) and obvious in a subdirectory deploy:
    // resolving against the path would give /api/agent/api/mcp/http.
    expect(merchantMcpUrl('https://shop.example.com')).toBe('https://shop.example.com/api/mcp/http')
    expect(merchantMcpUrl('http://localhost:3210')).toBe('http://localhost:3210/api/mcp/http')
  })

  it('names the transport segment the route is mounted on', () => {
    // The directory is `[transport]`; `mcp-handler` serves Streamable HTTP at `/http`. If the handler's
    // mount name changes, this is the assertion that fails instead of the agent run.
    expect(MERCHANT_MCP_PATH).toBe('/api/mcp/http')
  })

  it('is not repeated as a literal by the agent run route', () => {
    const route = readFileSync(
      fileURLToPath(new URL('../../agent/run/route.ts', import.meta.url)),
      'utf8',
    )
    expect(route).toContain('merchantMcpUrl(request.url)')
    expect(route).not.toContain(`'/api/mcp/http'`)
  })
})
