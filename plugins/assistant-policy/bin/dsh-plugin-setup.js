#!/usr/bin/env node
import { runPluginSetup } from '../lib/plugin-setup.js'

void runPluginSetup().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
