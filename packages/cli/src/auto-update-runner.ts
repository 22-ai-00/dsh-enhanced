#!/usr/bin/env node
// Detached/out-of-cgroup background worker entrypoint for `launchUnattendedAutoUpgrade`.
import { parseAutoUpdateWorkerArgs, runAutoUpdateWorker } from './auto-update.ts'

const sqliteWarningFiltered = Symbol.for('dsh-ray.sqlite-warning-filtered')
if (!Reflect.get(process.emitWarning, sqliteWarningFiltered)) {
  const originalEmitWarning = process.emitWarning
  const filteredEmitWarning = function emitWarning(
    this: unknown,
    warning: unknown,
    ...rest: unknown[]
  ) {
    const first = rest[0] as { type?: unknown } | string | undefined
    const warningType = typeof warning === 'object' && warning !== null && typeof (warning as { name?: unknown }).name === 'string'
      ? (warning as { name: string }).name
      : typeof first === 'string'
        ? first
        : first !== null && typeof first === 'object' && typeof first.type === 'string'
          ? first.type
          : undefined
    const warningMessage = typeof warning === 'object' && warning !== null && typeof (warning as { message?: unknown }).message === 'string'
      ? (warning as { message: string }).message
      : String(warning ?? '')
    if (warningType === 'ExperimentalWarning' && warningMessage.includes('SQLite is an experimental feature')) {
      return
    }
    return Reflect.apply(originalEmitWarning, this ?? process, [warning, ...rest])
  }
  Reflect.set(filteredEmitWarning, sqliteWarningFiltered, true)
  process.emitWarning = filteredEmitWarning as typeof process.emitWarning
}

try {
  const opts = parseAutoUpdateWorkerArgs(process.argv.slice(2), process.env)
  process.exitCode = await runAutoUpdateWorker(opts)
} catch (error) {
  process.stderr.write(`dsh-ray auto-update worker error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
}
