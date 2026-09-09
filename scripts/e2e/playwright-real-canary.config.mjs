import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'web-owner-real-capture.spec.mjs', timeout: 900000,
  expect: { timeout: 30000 }, workers: 1, retries: 0,
  outputDir: '../../.cache/web-owner-real-canary-e2e', reporter: 'list', metadata: { prospectiveCanary: true },
  use: { browserName: 'chromium', locale: 'en-US', actionTimeout: 30000, navigationTimeout: 30000,
    trace: 'off', video: 'off', screenshot: 'off', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
})
