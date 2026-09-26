#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
try {
  const wrapper = realpathSync(process.argv[1])
  const { runSystemdHostAuthority } = await import(pathToFileURL(join(dirname(wrapper), '../lib/systemd-host-authority.js')).href)
  await runSystemdHostAuthority()
} catch {
  process.stderr.write('systemd Host authority refused the request\n')
  process.exitCode = 1
}
