#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

try {
  const wrapper = realpathSync(process.argv[1])
  const modulePath = join(dirname(wrapper), '../lib/task-observation-authority.js')
  const { runTaskObservationAuthority } = await import(pathToFileURL(modulePath).href)
  await runTaskObservationAuthority()
} catch {
  process.stderr.write('task observation authority refused the request\n')
  process.exitCode = 1
}
