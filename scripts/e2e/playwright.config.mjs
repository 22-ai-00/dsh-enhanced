import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'web-owner.spec.mjs',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  outputDir: '../../.cache/web-owner-e2e',
  reporter: 'list',
  use: {
    browserName: 'chromium',
    locale: 'en-US',
    actionTimeout: 20_000,
    navigationTimeout: 20_000,
    // A launch URL authenticates the browser. Never persist it in traces/HAR.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
})
