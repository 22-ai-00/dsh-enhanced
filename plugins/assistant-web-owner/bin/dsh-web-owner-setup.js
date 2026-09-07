#!/usr/bin/env node
import { runWebOwnerSetup } from '../lib/setup.js'

void runWebOwnerSetup().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
