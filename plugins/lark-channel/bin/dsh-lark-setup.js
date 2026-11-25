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

let formatError
try {
  const { formatLarkSetupError, runLarkSetup } = await import('../lib/setup.js')
  formatError = formatLarkSetupError
  await runLarkSetup()
} catch (error) {
  const message = formatError ? formatError(error) : (error instanceof Error ? error.message : String(error))
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
