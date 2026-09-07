import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'web-owner-real.spec.mjs', timeout: 360_000,
  expect: { timeout: 120_000 }, workers: 1, retries: 0,
  outputDir: '../../.cache/web-owner-real-e2e', reporter: 'list',
  use: { browserName: 'chromium', locale: 'en-US', actionTimeout: 30_000, navigationTimeout: 30_000, trace: 'off', video: 'off', screenshot: 'off', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
})
