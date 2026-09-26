#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

try {
  const wrapper = realpathSync(process.argv[1])
  const modulePath = join(dirname(wrapper), '../lib/live-qualification-authority.js')
  const { runLiveQualificationAuthority } = await import(pathToFileURL(modulePath).href)
  await runLiveQualificationAuthority()
} catch {
  process.stderr.write('live qualification authority refused the request\n')
  process.exitCode = 1
}
