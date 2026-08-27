#!/usr/bin/env node

import { runLarkSetup } from '../lib/setup.js'

void runLarkSetup().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
