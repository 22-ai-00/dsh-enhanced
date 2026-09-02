#!/usr/bin/env node

import { runModelSetup } from '../lib/model-setup.js'

void runModelSetup().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
