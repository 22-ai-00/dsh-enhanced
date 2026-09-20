#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
try {
  const wrapper = realpathSync(process.argv[1])
  const { runSourceReleaseAuthority } = await import(pathToFileURL(join(dirname(wrapper), '../lib/source-release-authority.js')).href)
  await runSourceReleaseAuthority()
} catch {
  process.stderr.write('source release authority refused the request\n')
  process.exitCode = 1
}
