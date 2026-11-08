// Vitest 4 prepends a relative ./node_modules/.bin to process.env.PATH. The
// local-source installers correctly refuse non-absolute PATH entries, so the
// root suite normalizes PATH to absolute entries once per test file, before
// any lifecycle module reads it. Production guards stay unchanged.
import { delimiter, isAbsolute } from 'node:path'

process.env.PATH = (process.env.PATH ?? '')
  .split(delimiter)
  .filter(entry => entry.length > 0 && isAbsolute(entry))
  .join(delimiter)
