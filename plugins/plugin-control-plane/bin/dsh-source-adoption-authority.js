#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
try {
  const wrapper = realpathSync(process.argv[1])
  const { runSourceAdoptionAuthority } = await import(pathToFileURL(join(dirname(wrapper), '../lib/source-adoption-authority.js')).href)
  await runSourceAdoptionAuthority()
} catch {
  process.stderr.write('source adoption authority refused the request\n')
  process.exitCode = 1
}
