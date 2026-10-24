#!/usr/bin/env node
/** Fixed-scope, model-free maintenance worker. The installed config pins its sole unit. */
import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { RestartStore } from '../lib/restart-store.js'
import { runLockedRestartSupervisorTick, validateRestartSupervisorConfig } from '../lib/restart-supervisor.js'

function options(argv) {
  let configPath
  let once = false
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]
    if (item === '--once' && !once) once = true
    else if (item === '--config' && configPath === undefined) configPath = argv[++index]
    else throw new Error('restart-supervisor: expected --config <absolute-path> [--once]')
  }
  if (!configPath || !isAbsolute(configPath) || resolve(configPath) !== configPath) {
    throw new Error('restart-supervisor: config must be an absolute normalized path')
  }
  return { configPath, once }
}

async function privateConfig(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    const named = await lstat(path)
    if (!before.isFile() || !named.isFile() || named.isSymbolicLink()
      || before.nlink !== 1 || before.uid !== process.getuid()
      || before.mode & 0o077 || before.dev !== named.dev || before.ino !== named.ino
      || before.size < 1 || before.size > 1_048_576) throw new Error('restart-supervisor: unsafe config file')
    const contents = await file.readFile()
    const after = await file.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('restart-supervisor: config changed while reading')
    }
    return validateRestartSupervisorConfig(JSON.parse(contents.toString('utf8')))
  } finally { await file.close() }
}

async function main() {
  const args = options(process.argv.slice(2))
  const config = await privateConfig(args.configPath)
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('restart-supervisor: stopping'))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    while (!controller.signal.aborted) {
      try {
        const result = await runLockedRestartSupervisorTick(config,
          () => new RestartStore({ path: config.databasePath }), { signal: controller.signal })
        if (args.once) { process.stdout.write(`${result}\n`); return }
      } catch (error) {
        if (controller.signal.aborted) break
        process.stderr.write(`restart-supervisor: tick failed: ${error instanceof Error ? error.message : String(error)}\n`)
        if (args.once) throw error
      }
      await new Promise(resolve => {
        const abort = () => { clearTimeout(timer); resolve() }
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, 2_000)
        controller.signal.addEventListener('abort', abort, { once: true })
        if (controller.signal.aborted) abort()
      })
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
