#!/usr/bin/env node
// dsh-rsi 全局命令入口：实现位于 lib/index.js（TypeScript 源码在 src/index.ts）。
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
  const { main } = await import('../lib/index.js')
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`dsh-rsi 致命错误：${error?.stack ?? error}\n`)
  process.exitCode = 1
}
