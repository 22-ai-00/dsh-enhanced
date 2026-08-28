#!/usr/bin/env node

import { runPluginControl } from '../lib/cli.js'

void runPluginControl().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
