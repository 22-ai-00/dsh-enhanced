import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/e2e/repo-autonomy-sandbox.spec.mjs'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
})
