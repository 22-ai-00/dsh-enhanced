import { defineConfig } from '@playwright/test'

// This dedicated entry makes the task family explicit without changing the
// default two-round template repair command.
process.env.DSH_REAL_REPAIR_FAMILY = 'topology'

export default defineConfig({
  testDir: '.', testMatch: 'web-owner-real-repair.spec.mjs', timeout: 900000,
  expect: { timeout: 30000 }, workers: 1, retries: 0,
  outputDir: '../../.cache/web-owner-real-repair-topology-e2e', reporter: 'list',
  use: { browserName: 'chromium', locale: 'en-US', actionTimeout: 30000, navigationTimeout: 30000,
    trace: 'retain-on-failure', video: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
})
