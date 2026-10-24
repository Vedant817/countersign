import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const viRoot = resolve(webRoot, '..', 'vi')
const viPython = resolve(
  viRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
)
const viServiceToken = 'test-service-token-do-not-use-in-prod'

/**
 * The same port overrides `scripts/dev-local.mjs` honours, so an E2E run can follow the lab onto a
 * free port instead of fighting whatever else is on 3000/8000. Defaults are unchanged.
 */
const webPort = Number(process.env['COUNTERSIGN_WEB_PORT'] ?? 3000)
const viPort = Number(process.env['COUNTERSIGN_VI_PORT'] ?? 8000)

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `"${viPython}" -m uvicorn vi_service.main:app --app-dir src --host 127.0.0.1 --port ${viPort}`,
      cwd: viRoot,
      url: `http://127.0.0.1:${viPort}/v1/status`,
      timeout: 120_000,
      reuseExistingServer: !process.env['CI'],
      env: {
        VI_SERVICE_TOKEN: viServiceToken,
        VI_KEK: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
        VI_ISSUER_URL: 'https://issuer.countersign.test',
        VI_AGENT_ISS: 'https://agent.countersign.test',
        VI_ISSUER_KID: 'issuer-key-1',
        VI_MERCHANT_KID: 'merchant-key-1',
        VI_CLOCK_SKEW_SECONDS: '300',
      },
    },
    {
      command: `pnpm exec next dev -p ${webPort}`,
      cwd: webRoot,
      url: `http://localhost:${webPort}`,
      timeout: 120_000,
      reuseExistingServer: !process.env['CI'],
      env: {
        VI_SERVICE_URL: `http://127.0.0.1:${viPort}`,
        SIGNING_LAB_ENABLED: 'true',
        VI_SERVICE_TOKEN: viServiceToken,
        VI_AGENT_ISS: 'https://agent.countersign.test',
      },
    },
  ],
})
