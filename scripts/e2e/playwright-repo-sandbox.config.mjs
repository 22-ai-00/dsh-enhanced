import { defineConfig } from '@playwright/test'
import repository from './playwright-repo-real.config.mjs'

process.env.DSH_REPO_VERIFIED_DELIVERY = 'fixture'
process.env.DSH_REPO_EXTERNAL_BROKER = 'fixture'
process.env.DSH_REPO_EVENT_SOURCE = 'fixture'
process.env.DSH_REPO_SANDBOX_GIT ??= '1'
if (!process.env.DSH_WEB_REAL_PROVIDER) {
  process.env.DSH_REPO_SANDBOX_LLM ??= 'local'
}

export default defineConfig({
  ...repository,
  timeout: 1_200_000,
  outputDir: '../../.cache/repo-autonomy-sandbox-e2e',
})
