#!/usr/bin/env node
import { runAutonomyDoctor } from '../lib/doctor.js'

void runAutonomyDoctor().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
