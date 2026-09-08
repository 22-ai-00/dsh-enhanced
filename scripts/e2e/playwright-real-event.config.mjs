import { defineConfig } from '@playwright/test'
import real from './playwright-real.config.mjs'

export default defineConfig({ ...real, testMatch: 'web-owner-real-event.spec.mjs', timeout: 600_000,
  outputDir: '../../.cache/web-owner-real-event-e2e' })
