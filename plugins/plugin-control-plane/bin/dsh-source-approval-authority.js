#!/usr/bin/env node

// A supervisor may execute this wrapper through /proc/self/fd/N. Resolve the
// actual wrapper first so the adjacent immutable lib path remains correct.
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

try {
  const wrapper = realpathSync(process.argv[1])
  const { runSourceApprovalAuthority } = await import(pathToFileURL(join(dirname(wrapper), '../lib/source-approval-authority.js')).href)
  await runSourceApprovalAuthority()
} catch {
  process.stderr.write('source approval authority refused the request\n')
  process.exitCode = 1
}
