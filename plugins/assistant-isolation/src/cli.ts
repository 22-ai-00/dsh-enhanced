#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { reconcileUnknownJob } from './reconcile.js'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IsolationLedger } from './ledger.js'
import { removeIsolatedContainer } from './runner.js'

function privateLedger(stateRoot: string, dockerPath: string): string {
  if (!isAbsolute(stateRoot) || realpathSync(stateRoot) !== stateRoot) throw new Error('canonical state root required')
  const root = lstatSync(stateRoot)
  const file = join(stateRoot, 'ledger.sqlite')
  const database = lstatSync(file)
  if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0
    || !database.isFile() || database.isSymbolicLink() || database.uid !== root.uid || database.nlink !== 1 || (database.mode & 0o077) !== 0) throw new Error('private owned ledger required')
  if (!isAbsolute(dockerPath)) throw new Error('absolute Docker path required')
  return file
}

/** Operator entry point, separate from the model's tool registry. */
export async function revokeIsolationGrant(stateRoot: string, grantId: string, revision: number, dockerPath = '/usr/bin/docker'): Promise<{ revoked: true; containersRemoved: boolean }> {
  const file = privateLedger(stateRoot, dockerPath)
  const ledger = new IsolationLedger(file)
  try {
    ledger.revoke(grantId, revision, 'external-operator-revoke')
    let containersRemoved = true
    let cursor = ''
    for (;;) {
      const page = ledger.recoverable(cursor)
      if (page.length === 0) break
      cursor = page.at(-1)!.id
      for (const job of page) if (job.grantId === grantId && !await removeIsolatedContainer(dockerPath, job.containerName)) containersRemoved = false
    }
    // Revocation is durable. A running controller also polls it and prevents any
    // pending create from starting; late daemon responses may remain unknown.
    return { revoked: true, containersRemoved }
  } finally { ledger.close() }
}

/** Reconcile only settled requests; a live Host owns its own background sweep. */
export async function reconcileIsolation(stateRoot: string, dockerPath = '/usr/bin/docker', signal: AbortSignal = new AbortController().signal): Promise<{ checked: number; released: number; retained: number }> {
  const ledger = new IsolationLedger(privateLedger(stateRoot, dockerPath))
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let authority: ReturnType<IsolationLedger['claimController']> | undefined
  try {
    authority = ledger.claimController(randomUUID(), 30_000)
    const controller = authority
    timer = setInterval(() => { try { if (!ledger.renewController(controller, 30_000)) abort.abort() } catch { abort.abort() } }, 5000)
    timer.unref()
    const counts = { checked: 0, released: 0, retained: 0 }
    let cursor = ''
    for (;;) {
      const page = ledger.recoverable(cursor)
      if (page.length === 0) break
      cursor = page.at(-1)!.id
      for (const job of page) {
        signal.throwIfAborted(); abort.signal.throwIfAborted()
        counts.checked++
        const combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(30_000)])
        if (await reconcileUnknownJob(ledger, controller, job, dockerPath, combined)) counts.released++
        else counts.retained++
      }
    }
    return counts
  } finally {
    if (timer) clearInterval(timer)
    try { if (authority) ledger.releaseController(authority) } finally { ledger.close() }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, stateRoot, grantId, revision, dockerPath, ...extra] = process.argv.slice(2)
  try {
    if (command === 'reconcile') {
      if (stateRoot === undefined || revision !== undefined) throw new Error('usage: dsh-isolation reconcile /absolute/private/state-root [/absolute/docker]')
      const abort = new AbortController()
      const cancel = (): void => abort.abort()
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
      try { process.stdout.write(`${JSON.stringify(await reconcileIsolation(stateRoot, grantId, abort.signal))}\n`) }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
    } else {
    if (command !== 'revoke' || stateRoot === undefined || grantId === undefined || revision === undefined || extra.length > 0 || !/^[1-9][0-9]*$/.test(revision)) throw new Error('usage: dsh-isolation revoke /absolute/private/state-root grant-id revision [/absolute/docker]')
    const result = await revokeIsolationGrant(stateRoot, grantId, Number(revision), dockerPath)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.containersRemoved) process.exitCode = 2
    }
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'isolation revoke failed'}\n`); process.exitCode = 1 }
}
