/**
 * Mint a short-lived merchant-MCP bearer for a local agent run or MCP Inspector.
 *
 * §8.14 says each agent session gets a 15-minute `agt_` JWT. Until the wallet UI (WP-17a) has a signed-in
 * session to mint one from, this CLI is the operator entry point:
 *
 *   SESSION_SECRET=... pnpm mcp:token agt_01J...
 *
 * The token is printed to stdout and is deliberately not logged anywhere by the server.
 */
import { mintAgentToken, MCP_TOKEN_TTL_SECONDS } from '../apps/web/lib/mcp-token'

const agentId = process.argv[2] ?? 'agt_01J00000000000000000000001'

async function main(): Promise<void> {
  const result = await mintAgentToken({ agentId })
  if (!result.ok) {
    console.error(`${result.error.code}: ${result.error.message}`)
    process.exitCode = 1
    return
  }
  const expiresAt = new Date(Date.now() + MCP_TOKEN_TTL_SECONDS * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
  })
  console.info(`agent:   ${agentId}`)
  console.info(`expires: ${expiresAt} IST (${MCP_TOKEN_TTL_SECONDS}s)`)
  console.info('')
  console.info(result.value)
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
})
