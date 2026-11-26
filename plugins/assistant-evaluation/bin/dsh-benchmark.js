#!/usr/bin/env node
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

const controller = new AbortController()
const abort = () => controller.abort()
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
try {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19) || major === 23) throw new Error('unsupported-node-version')
  const { benchmarkCli } = await import('../lib/benchmark/cli.js')
  process.exitCode = await benchmarkCli(process.argv.slice(2), { stdout: text => process.stdout.write(text) }, controller.signal)
} catch (error) {
  // Host adapter exceptions can contain API keys, request bodies or credential paths.
  // Do not print third-party error messages or stacks through the operator CLI.
  const { BenchmarkError } = await import('../lib/benchmark/schema.js').catch(() => ({ BenchmarkError: class {} }))
  const safe = error instanceof BenchmarkError ? error.message : 'benchmark command failed; Node.js ^22.19 or >=24 is required; check runtime dependencies, file paths and trusted adapter configuration'
  process.stderr.write(`dsh-benchmark: ${safe}\n`)
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', abort)
  process.removeListener('SIGTERM', abort)
}
