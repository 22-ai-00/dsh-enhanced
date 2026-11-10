import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { RootTestSequencer } from './root-test-sequencer.ts'

// Root test suite configuration. It lives inside tests/ so `vitest run` in a
// workspace package directory cannot discover it by walking upward. The root
// suite loads it explicitly through --config. The setup file normalizes
// vitest's injected relative PATH entry before installer suites read
// process.env.PATH; the setup path is absolute to avoid cwd-dependent
// resolution.
const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    setupFiles: [resolve(here, 'vitest.setup.ts')],
    sequence: { sequencer: RootTestSequencer },
  },
})
