#!/usr/bin/env node
const sqliteWarningFiltered = Symbol.for('dsh-enhanced.sqlite-warning-filtered')
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
  const { runAutonomyDoctor } = await import('../lib/doctor.js')
  await runAutonomyDoctor()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
