import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const localDatabase = new URL('postgres://127.0.0.1:5432/countersign')
localDatabase.username = 'countersign'
localDatabase.password = 'countersign'
// Public local Compose configuration, bound to loopback. Never read or print real credentials.
const environment = {
  ...process.env,
  APP_ENV: 'local',
  DATABASE_URL: localDatabase.href,
  VI_SERVICE_URL: 'http://127.0.0.1:8000',
  VI_SERVICE_TOKEN: randomBytes(32).toString('hex'),
  VI_KEK: randomBytes(32).toString('base64'),
  VI_ISSUER_URL: 'https://issuer.countersign.test',
  VI_AGENT_ISS: 'https://agent.countersign.test',
  VI_ISSUER_KID: 'local-issuer',
  VI_MERCHANT_KID: 'local-merchant',
  SESSION_SECRET: randomBytes(32).toString('hex'),
  SIGNING_LAB_ENABLED: 'true',
  PAYPAL_CLIENT_ID: '',
  PAYPAL_CLIENT_SECRET: '',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
}
const children = []
let stopping = false

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

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () =>
      reject(
        new Error(
          `Port ${port} is in use. Stop the existing local server before running dev:local.`,
        ),
      ),
    )
    probe.listen(port, '127.0.0.1', () => probe.close(resolve))
  })
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--seed'))
    throw new Error('Usage: pnpm dev:local [--seed]')
  await Promise.all([requireFreePort(3000), requireFreePort(8000)])
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
    '8000',
  ])
  children.push(vi)
  const viExit = completion(vi)
  void viExit.catch(() => {})
  let ready = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (vi.exitCode !== null)
      throw new Error('VI failed to start. Check its configuration and Python dependencies.')
    try {
      ready = (
        await fetch('http://127.0.0.1:8000/v1/status', { signal: AbortSignal.timeout(1000) })
      ).ok
    } catch {
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
    '3000',
  ])
  children.push(web)
  console.info(
    'Open http://localhost:3000. Ctrl+C stops web and VI; PostgreSQL data remains in Docker.',
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
