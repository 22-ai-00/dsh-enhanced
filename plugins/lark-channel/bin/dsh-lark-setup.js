#!/usr/bin/env node

import { formatLarkSetupError, runLarkSetup } from '../lib/setup.js'

void runLarkSetup().catch(error => {
  process.stderr.write(`${formatLarkSetupError(error)}\n`)
  process.exitCode = 1
})
