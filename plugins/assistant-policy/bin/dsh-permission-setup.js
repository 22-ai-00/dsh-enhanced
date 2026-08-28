#!/usr/bin/env node

import { runPermissionSetup } from '../lib/permission-setup.js'

void runPermissionSetup().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
