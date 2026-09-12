import { defineConfig } from '@playwright/test'
import repair from './playwright-real-repair.config.mjs'

process.env.DSH_REAL_REPAIR_FAMILY = 'template'
process.env.DSH_REAL_REPAIR_RESTART = 'repair-achieved'

export default defineConfig({
  ...repair,
  outputDir: '../../.cache/web-owner-real-repair-restart-e2e',
  // Browser traces retain the private login URL before its token is consumed.
  // Keep structured, sanitized evidence instead of raw browser recordings.
  use: { ...repair.use, trace: 'off', video: 'off', screenshot: 'off' },
})
