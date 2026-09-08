import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'repo-autonomy-real.spec.mjs', timeout: 600_000,
  expect: { timeout: 30_000 }, workers: 1, retries: 0,
  outputDir: `../../.cache/repo-autonomy-real-${(process.env.DSH_WEB_REAL_PROVIDER || 'codex-subscription').replace(/[^a-zA-Z0-9_-]/g, '_')}-e2e`, reporter: 'list',
  use: {
    browserName: 'chromium', locale: 'en-US', actionTimeout: 30_000, navigationTimeout: 30_000,
    trace: 'off', video: 'off', screenshot: 'off',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
})
