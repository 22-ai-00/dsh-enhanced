#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sqliteWarningFiltered = Symbol.for('dsh-ray.sqlite-warning-filtered')
if (!Reflect.get(process.emitWarning, sqliteWarningFiltered)) {
  const originalEmitWarning = process.emitWarning
  const filteredEmitWarning = function emitWarning(warning, ...rest) {
    const first = rest[0]
    let warningType
    if (typeof warning === 'object' && warning !== null && typeof warning.name === 'string') {
      warningType = warning.name
    } else if (typeof first === 'string') {
      warningType = first
    } else if (first !== null && typeof first === 'object' && typeof first.type === 'string') {
      warningType = first.type
    }
    const warningMessage = typeof warning === 'object' && warning !== null && typeof warning.message === 'string'
      ? warning.message
      : String(warning ?? '')
    if (warningType === 'ExperimentalWarning' && warningMessage.includes('SQLite is an experimental feature')) {
      return
    }
    return Reflect.apply(originalEmitWarning, this ?? process, [warning, ...rest])
  }
  Reflect.set(filteredEmitWarning, sqliteWarningFiltered, true)
  process.emitWarning = filteredEmitWarning
}

try {
  const wrapper = realpathSync(process.argv[1])
  const modulePath = join(dirname(wrapper), '../lib/live-qualification-authority.js')
  const { runLiveQualificationAuthority } = await import(pathToFileURL(modulePath).href)
  await runLiveQualificationAuthority()
} catch {
  process.stderr.write('live qualification authority refused the request\n')
  process.exitCode = 1
}
