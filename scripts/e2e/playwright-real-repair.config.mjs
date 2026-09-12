import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'web-owner-real-repair.spec.mjs', timeout: 900000,
  expect: { timeout: 30000 }, workers: 1, retries: 0,
  outputDir: '../../.cache/web-owner-real-repair-e2e', reporter: 'list',
  use: { browserName: 'chromium', locale: 'en-US', actionTimeout: 30000, navigationTimeout: 30000,
    trace: 'retain-on-failure', video: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
})
