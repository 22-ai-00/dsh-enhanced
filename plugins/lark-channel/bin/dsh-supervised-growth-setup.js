#!/usr/bin/env node

import { runSupervisedGrowthSetup } from '../lib/supervised-growth-setup.js'

void runSupervisedGrowthSetup().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
