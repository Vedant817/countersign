import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const localDatabase = new URL('postgres://127.0.0.1:5432/countersign')
localDatabase.username = 'countersign'
localDatabase.password = 'countersign'

/**
 * Ports, overridable so a clash on this machine is a configuration change and not a decision about
 * whose process to kill.
 *
 * The defaults stay 3000/8000 so nothing else has to move. `COUNTERSIGN_VI_PORT` exists because 8000
 * is the busiest port on a developer's machine and, during the review that found this, it was held by
 * an unrelated project answering 404 — which the app then reported to a buyer as "we could not find
 * that, it may have been removed". Refusing to start (rather than terminating the other process) is
 * the right default; being unable to move is not.
 */
function portFromEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a port between 1 and 65535, got "${raw}".`)
  }
  return value
}

const webPort = portFromEnv('COUNTERSIGN_WEB_PORT', 3000)
const viPort = portFromEnv('COUNTERSIGN_VI_PORT', 8000)

// Public local Compose configuration, bound to loopback. Never read or print real credentials.
const environment = {
  ...process.env,
  APP_ENV: 'local',
  DATABASE_URL: localDatabase.href,
  // The verifier page requires this (D-053). Without it `/v/<packetId>` renders "temporarily
  // unavailable" for every well-formed id — including unknown ones, which then answer 200 instead of
  // the 404 EC-DSP-9 asks for. A launcher that starts a page it knows cannot serve is worse than one
  // that refuses.
  PUBLIC_BASE_URL: `http://localhost:${webPort}`,
  // The merchant the local lab sells as, signed into every checkout JWT. Required with no default
  // (`apps/web/lib/merchant.ts`): a defaulted merchant name is a fabricated value inside a signature.
  MERCHANT_ID: 'mrc_northwind',
  MERCHANT_NAME: 'Northwind Outfitters',
  MERCHANT_WEBSITE: 'https://northwind.countersign.test',
  VI_SERVICE_URL: `http://127.0.0.1:${viPort}`,
  VI_SERVICE_TOKEN: randomBytes(32).toString('hex'),
  VI_KEK: randomBytes(32).toString('base64'),
  VI_ISSUER_URL: 'https://issuer.countersign.test',
  VI_AGENT_ISS: 'https://agent.countersign.test',
  VI_ISSUER_KID: 'local-issuer',
  VI_MERCHANT_KID: 'local-merchant',
  SESSION_SECRET: randomBytes(32).toString('hex'),
  SIGNING_LAB_ENABLED: 'true',
  // Filled in `main()` once per run; declared here so the key list stays in one place.
  GATE_SIGNING_KEY: process.env['GATE_SIGNING_KEY'] ?? generateGateSigningKey(),
  GATE_KID: process.env['GATE_KID'] ?? 'local-gate',
  PAYPAL_CLIENT_ID: '',
  PAYPAL_CLIENT_SECRET: '',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
}
const children = []
let stopping = false

/**
 * The Gate's decision-signing key, generated per run.
 *
 * **Ed25519**, matching `signDecisionRecord`'s `alg: 'EdDSA'`. An ES256 key imports cleanly and then
 * fails at the first signature, so the algorithm is part of the contract rather than an implementation
 * detail — `apps/web/lib/gate-runtime.ts` checks `kty`/`crv` before importing for exactly that reason.
 *
 * Ephemeral for the same reason VI's issuer key is: this is a local lab, and a checked-in private key
 * would be a real one the day someone copies the file. `GATE_SIGNING_KEY` is required by the runtime
 * rather than defaulted, so without this the Gate refuses — which is the behaviour under test.
 */
function generateGateSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519')
  return JSON.stringify(privateKey.export({ format: 'jwk' }))
}

function launch(command, args) {
  // Windows package-manager shims require a shell. All commands and arguments below are constants.
  return spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  })
}

function completion(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Local service exited with code ${code}.`)),
    )
  })
}

function stop() {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else child.kill('SIGTERM')
  }
}

async function requireFreePort(port, variable) {
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () =>
      reject(
        new Error(
          `Port ${port} is in use. Stop the existing local server, or set ${variable} to a free port ` +
            `(the launcher never terminates a process it did not start).`,
        ),
      ),
    )
    probe.listen(port, '127.0.0.1', () => probe.close(resolve))
  })
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--seed'))
    throw new Error('Usage: pnpm dev:local [--seed]')
  await Promise.all([
    requireFreePort(webPort, 'COUNTERSIGN_WEB_PORT'),
    requireFreePort(viPort, 'COUNTERSIGN_VI_PORT'),
  ])
  console.info('Starting the local authorization lab. PayPal payments are disabled.')
  await completion(launch('docker', ['compose', 'up', '-d', '--wait', 'db']))
  await completion(launch('pnpm', ['db:migrate']))
  if (process.argv.includes('--seed')) await completion(launch('pnpm', ['db:seed']))

  const vi = launch('uv', [
    'run',
    '--project',
    'apps/vi',
    'uvicorn',
    'vi_service.main:app',
    '--app-dir',
    'apps/vi/src',
    '--host',
    '127.0.0.1',
    '--port',
    String(viPort),
  ])
  children.push(vi)
  const viExit = completion(vi)
  void viExit.catch(() => {})
  let ready = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (vi.exitCode !== null)
      throw new Error('VI failed to start. Check its configuration and Python dependencies.')
    try {
      const probe = await fetch(`http://127.0.0.1:${viPort}/v1/status`, {
        signal: AbortSignal.timeout(1000),
      })
      // A 404 here means something else is on the port and the free-port check raced with it. Checking
      // the status, not just that *something* answered, is what turns that into a clear failure instead
      // of "the vi service is ready" followed by every later call failing.
      ready = probe.ok
      if (!probe.ok && probe.status === 404) {
        throw new Error(
          `Port ${viPort} answered 404 for /v1/status — something else is listening there. ` +
            `Set COUNTERSIGN_VI_PORT to a free port.`,
        )
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('something else is listening'))
        throw cause
      /* Still starting. */
    }
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error('The local VI service did not become ready.')
  const web = launch('pnpm', [
    '--filter',
    '@countersign/web',
    'exec',
    'next',
    'dev',
    '--hostname',
    '127.0.0.1',
    '-p',
    String(webPort),
  ])
  children.push(web)
  console.info(
    `Open http://localhost:${webPort}. Ctrl+C stops web and VI; PostgreSQL data remains in Docker.`,
  )
  console.info(
    'Signing keys are local and ephemeral. Restarting VI invalidates its earlier sample signatures.',
  )
  await Promise.race([viExit, completion(web)])
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
main()
  .catch((cause) => {
    if (!stopping) {
      console.error(cause instanceof Error ? cause.message : 'Local startup failed.')
      process.exitCode = 1
    }
  })
  .finally(stop)
