#!/usr/bin/env node

import { runRsiSetup } from '../lib/rsi-setup.js'

void runRsiSetup().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
