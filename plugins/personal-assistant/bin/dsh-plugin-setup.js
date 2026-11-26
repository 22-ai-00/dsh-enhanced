#!/usr/bin/env node

import { runPluginSetup } from '@dsh-ray/assistant-policy/plugin-setup'

void runPluginSetup().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
