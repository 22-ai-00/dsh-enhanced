import { defineConfig } from '@playwright/test'
import autonomy from './playwright-autonomy.config.mjs'

process.env.DSH_AUTONOMY_DEEPSEEK_TEST = '1'
export default defineConfig({ ...autonomy, testMatch: ['autonomy-goal.spec.mjs'], outputDir: '../../.cache/autonomy-deepseek-e2e' })
