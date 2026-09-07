import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: ['autonomy-wake.spec.mjs'], timeout: 300000,
  expect: { timeout: 20000 }, workers: 1, retries: 0,
  outputDir: '../../.cache/autonomy-wake-e2e', reporter: 'list',
  use: { browserName: 'chromium', locale: 'en-US', actionTimeout: 20000, navigationTimeout: 20000,
    trace: 'off', video: 'off', screenshot: 'off',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
})
