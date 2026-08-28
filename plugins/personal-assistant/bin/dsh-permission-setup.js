#!/usr/bin/env node

import { runPermissionSetup } from '@dsh-enhanced/assistant-policy/permission-setup'

void runPermissionSetup().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
