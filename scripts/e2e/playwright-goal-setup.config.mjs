import { defineConfig } from '@playwright/test'
import autonomy from './playwright-autonomy.config.mjs'

process.env.DSH_AUTONOMY_GOAL_SETUP_TEST = '1'
export default defineConfig({ ...autonomy, testMatch: ['autonomy-goal-setup.spec.mjs'], outputDir: '../../.cache/autonomy-goal-setup-e2e' })
