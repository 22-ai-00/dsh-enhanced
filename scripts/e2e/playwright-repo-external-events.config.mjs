import { defineConfig } from '@playwright/test'
import repository from './playwright-repo-real.config.mjs'

if (process.env.DSH_WEB_REAL_PROVIDER && process.env.DSH_WEB_REAL_PROVIDER !== 'traex-agent') throw new Error('external repository event E2E requires traex-agent')
process.env.DSH_WEB_REAL_PROVIDER = 'traex-agent'
process.env.DSH_WEB_REAL_MODEL ??= 'gpt-5.6-terra'
process.env.DSH_REPO_VERIFIED_DELIVERY = 'fixture'
process.env.DSH_REPO_EXTERNAL_BROKER = 'fixture'
process.env.DSH_REPO_EVENT_SOURCE = 'fixture'

export default defineConfig({
  ...repository,
  timeout: 900_000,
  outputDir: '../../.cache/repo-autonomy-external-events-e2e',
})
