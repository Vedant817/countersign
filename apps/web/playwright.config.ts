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

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
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
      command: `"${viPython}" -m uvicorn vi_service.main:app --app-dir src --host 127.0.0.1 --port 8000`,
      cwd: viRoot,
      url: 'http://127.0.0.1:8000/v1/status',
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
      command: 'pnpm exec next dev -p 3000',
      cwd: webRoot,
      url: 'http://localhost:3000',
      timeout: 120_000,
      reuseExistingServer: !process.env['CI'],
      env: {
        VI_SERVICE_URL: 'http://127.0.0.1:8000',
        VI_SERVICE_TOKEN: viServiceToken,
        VI_AGENT_ISS: 'https://agent.countersign.test',
      },
    },
  ],
})
