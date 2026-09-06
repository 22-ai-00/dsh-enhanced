#!/usr/bin/env node
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
