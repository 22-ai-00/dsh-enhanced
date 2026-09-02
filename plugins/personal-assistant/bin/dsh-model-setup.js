#!/usr/bin/env node

import { runModelSetup } from '@dsh-enhanced/assistant-policy/model-setup'

void runModelSetup().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
