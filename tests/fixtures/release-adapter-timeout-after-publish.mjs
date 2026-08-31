#!/usr/bin/node

// Fault-injection wrapper for the real local release adapter. The first
// invocation pauses only after immutable registry bytes and metadata have
// been committed. A caller with a short deadline observes a real process
// timeout and can safely retry; a longer deadline receives signed ambiguity
// evidence and can invoke the independent reconciliation contract.
import { constants, closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.env.DSH_RELEASE_FIXTURE_MODULE
const fixtureRoot = process.env.DSH_RELEASE_FIXTURE_ROOT
const hangOperation = process.env.DSH_RELEASE_FIXTURE_HANG_OPERATION
if (typeof modulePath !== 'string' || typeof fixtureRoot !== 'string') process.exit(65)

const { runLocalReleaseAdapter } = await import(pathToFileURL(modulePath).href)
// Preserve the production adapter's self-path binding while this fixture owns
// only the outer process used to inject a timeout after the durable write.
process.argv[1] = modulePath
await runLocalReleaseAdapter(process.argv.slice(2), process.env, {
  afterPublishWrite: async ({ request }) => {
    mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 })
    const marker = join(fixtureRoot, `${request.operationId}.after-write`)
    let descriptor
    try {
      descriptor = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      writeFileSync(descriptor, `${process.pid}\n`)
      fsyncSync(descriptor)
    } catch (error) {
      if (error?.code === 'EEXIST') return
      throw error
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
    const directory = openSync(fixtureRoot, constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(directory) } finally { closeSync(directory) }
    if (request.operationId === hangOperation) {
      await new Promise(resolvePromise => process.stderr.write('DSH_RELEASE_FIXTURE_READY\n', resolvePromise))
      const keepAlive = setInterval(() => undefined, 60_000)
      await new Promise(() => undefined)
      clearInterval(keepAlive)
    }
    return { outcome: 'ambiguous', detail: 'fixture-ambiguous-after-write' }
  },
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'release adapter fixture failed'}\n`)
  process.exitCode = 1
})
