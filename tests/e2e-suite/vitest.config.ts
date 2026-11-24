import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

// Scoped E2E suite config. Uses no custom resolve.alias so `pnpm run test:root`
// (`--config ./tests/vitest.config.ts --dir tests`) discovers and runs all
// tests/e2e-suite/tier*.spec.ts files identically.
export default defineConfig({
  test: {
    dir: here,
    include: ['tier*.spec.ts'],
    setupFiles: [resolve(here, '../vitest.setup.ts')],
    testTimeout: 15_000,
  },
})
