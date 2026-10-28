#!/usr/bin/env node
import { probeIsolationRuntime, probeLinuxIsolationRuntime } from './probe.js'
import { randomUUID } from 'node:crypto'
import { reconcileUnknownJob } from './reconcile.js'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IsolationLedger, IsolationLedgerError } from './ledger.js'
import { reconcileLinuxJob } from './linux-job-recovery.js'
import { removeIsolatedContainer } from './runner.js'
import { defaultStoragePolicy, validateStoragePolicy } from './storage-policy.js'
import { maintainIsolationStorage, type IsolationStorageMaintenance } from './storage.js'
import { archiveIsolationAudit, verifyIsolationAuditArchive } from './audit-archive.js'
import { configuredDockerSocketPath } from './docker-socket.js'
import { stateSocketBindingMatches } from './state-socket-binding.js'

function privateLedger(stateRoot: string): string {
  if (!isAbsolute(stateRoot) || realpathSync(stateRoot) !== stateRoot) throw new Error('canonical state root required')
  const root = lstatSync(stateRoot)
  const file = join(stateRoot, 'ledger.sqlite')
  const database = lstatSync(file)
  if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0
    || !database.isFile() || database.isSymbolicLink() || database.uid !== root.uid || database.nlink !== 1 || (database.mode & 0o077) !== 0) throw new Error('private owned ledger required')
  return file
}

export interface IsolationRevocationResult {
  revoked: true
  /** Legacy Docker removal acknowledgements, not a general proof of quiescence. */
  containersRemoved: boolean
  nativeResourcesQuiescent?: boolean
  nativeRetained?: number
}

/** Operator entry point, separate from the model's tool registry. */
export async function revokeIsolationGrant(stateRoot: string, grantId: string, revision: number,
  dockerPath = process.platform === 'darwin' ? '/usr/local/bin/docker' : '/usr/bin/docker', socketPath?: string): Promise<IsolationRevocationResult> {
  const file = privateLedger(stateRoot)
  const ledger = new IsolationLedger(file)
  let authority: ReturnType<IsolationLedger['claimController']> | undefined
  let timer: NodeJS.Timeout | undefined
  const abort = new AbortController()
  try {
    ledger.revoke(grantId, revision, 'external-operator-revoke')
    let containersRemoved = true, nativeSeen = false
    let cursor = ''
    for (;;) {
      const page = ledger.recoverable(cursor)
      if (page.length === 0) break
      cursor = page.at(-1)!.id
      for (const job of page) {
        if (job.grantId !== grantId) continue
        if (job.backend === 'linux-native') {
          nativeSeen = true
          // A live service owns cancellation and cleanup. Claiming never steals
          // its lease or rewrites expiry; only an idle ledger permits CLI cleanup.
          if (!authority) {
            try { authority = ledger.claimController(randomUUID(), 30_000) }
            catch (error) { if (!(error instanceof IsolationLedgerError) || error.code !== 'unauthorized') throw error }
            if (authority) {
              const controller = authority
              timer = setInterval(() => { try { if (!ledger.renewController(controller, 30_000)) abort.abort() } catch { abort.abort() } }, 5_000)
              timer.unref()
            }
          }
          if (authority) await reconcileLinuxJob(ledger, authority, job, join(stateRoot, 'linux-executions'), abort.signal)
        } else if (job.backend === 'docker' && job.containerName) {
          if (!isAbsolute(dockerPath)) throw new Error('absolute Docker path required')
          const boundSocket = configuredDockerSocketPath(socketPath)
          if (!stateSocketBindingMatches(stateRoot, boundSocket)
            || !await removeIsolatedContainer(dockerPath, job.containerName, { socketPath: boundSocket })) containersRemoved = false
        }
      }
    }
    // Revocation is durable. A running controller also polls it and prevents any
    // pending create from starting; late daemon responses may remain unknown.
    if (!nativeSeen) return { revoked: true, containersRemoved }
    let nativeRetained = 0
    cursor = ''
    for (;;) {
      const page = ledger.recoverable(cursor)
      if (page.length === 0) break
      cursor = page.at(-1)!.id
      nativeRetained += page.filter(job => job.backend === 'linux-native' && job.grantId === grantId).length
    }
    return { revoked: true, containersRemoved, nativeResourcesQuiescent: nativeRetained === 0, nativeRetained }
  } finally {
    if (timer) clearInterval(timer)
    try { if (authority) ledger.releaseController(authority) } finally { ledger.close() }
  }
}

/** Reconcile only settled requests; a live Host owns its own background sweep. */
export async function reconcileIsolation(stateRoot: string, dockerPath = process.platform === 'darwin' ? '/usr/local/bin/docker' : '/usr/bin/docker',
  signal: AbortSignal = new AbortController().signal, socketPath?: string): Promise<{ checked: number; released: number; retained: number }> {
  const ledger = new IsolationLedger(privateLedger(stateRoot))
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
        let released = false
        if (job.backend === 'linux-native') released = await reconcileLinuxJob(ledger, controller, job, join(stateRoot, 'linux-executions'), combined)
        else if (job.backend === 'docker' && job.containerName) {
          if (!isAbsolute(dockerPath)) throw new Error('absolute Docker path required')
          const boundSocket = configuredDockerSocketPath(socketPath)
          released = stateSocketBindingMatches(stateRoot, boundSocket)
            && await reconcileUnknownJob(ledger, controller, job, dockerPath, combined, boundSocket)
        }
        if (released) counts.released++
        else counts.retained++
      }
    }
    return counts
  } finally {
    if (timer) clearInterval(timer)
    try { if (authority) ledger.releaseController(authority) } finally { ledger.close() }
  }
}

/** Operator-only one-page maintenance; positive retention explicitly enables body pruning. */
export async function maintainIsolation(stateRoot: string, resultRetentionMs = 0, afterId = ''): Promise<IsolationStorageMaintenance> {
  const policy = validateStoragePolicy({ ...defaultStoragePolicy, resultRetentionMs })
  const ledger = new IsolationLedger(privateLedger(stateRoot))
  let authority: ReturnType<IsolationLedger['claimController']> | undefined
  let timer: NodeJS.Timeout | undefined
  try {
    authority = ledger.claimController(randomUUID(), 30_000)
    const controller = authority
    timer = setInterval(() => { try { ledger.renewController(controller, 30_000) } catch { /* The maintenance fence fails closed. */ } }, 5000)
    timer.unref()
    return await maintainIsolationStorage(ledger, controller, stateRoot, policy, afterId)
  } finally {
    if (timer) clearInterval(timer)
    try { if (authority) ledger.releaseController(authority) } finally { ledger.close() }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, stateRoot, grantId, revision, dockerPath, ...extra] = process.argv.slice(2)
  try {
    if (command === 'probe-native') {
      if (!stateRoot || !isAbsolute(stateRoot) || grantId !== undefined || revision !== undefined || dockerPath !== undefined || extra.length > 0) throw new Error('usage: dsh-isolation probe-native /absolute/runtime-config.json')
      const file = await open(stateRoot, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o022 || stat.size > 65_536) throw new Error('native probe config must be a bounded owned regular file')
        const text = await file.readFile('utf8')
        const after = await file.stat()
        if (Buffer.byteLength(text) !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('native probe config changed while reading')
        process.stdout.write(`${JSON.stringify(await probeLinuxIsolationRuntime(JSON.parse(text)))}\n`)
      } finally { await file.close() }
    } else if (command === 'probe') {
      if (!stateRoot || dockerPath !== undefined || extra.length > 0) throw new Error('usage: dsh-isolation probe sha256:image-id [/absolute/docker [/absolute/docker.sock]]')
      process.stdout.write(`${JSON.stringify(await probeIsolationRuntime(stateRoot, grantId, revision))}\n`)
    } else if (command === 'maintain') {
      if (stateRoot === undefined || dockerPath !== undefined || (grantId !== undefined && !/^(0|[1-9][0-9]*)$/.test(grantId))) throw new Error('usage: dsh-isolation maintain /absolute/private/state-root [result-retention-ms [after-job-id]]')
      process.stdout.write(`${JSON.stringify(await maintainIsolation(stateRoot, grantId === undefined ? 0 : Number(grantId), revision))}\n`)
    } else if (command === 'reconcile') {
      if (stateRoot === undefined || dockerPath !== undefined || extra.length > 0) throw new Error('usage: dsh-isolation reconcile /absolute/private/state-root [/absolute/docker [/absolute/docker.sock]]')
      const abort = new AbortController()
      const cancel = (): void => abort.abort()
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
      try { process.stdout.write(`${JSON.stringify(await reconcileIsolation(stateRoot, grantId, abort.signal, revision))}\n`) }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
    } else if (command === 'archive-audit') {
      if (stateRoot === undefined || grantId === undefined || dockerPath !== undefined || extra.length > 0
        || (revision !== undefined && (!/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision)) || Number(revision) > 1_000))) {
        throw new Error('usage: dsh-isolation archive-audit /absolute/private/state-root /absolute/private/archive-directory [batch-size]')
      }
      process.stdout.write(`${JSON.stringify(archiveIsolationAudit({ stateRoot, archiveDirectory: grantId, ...(revision === undefined ? {} : { batchSize: Number(revision) }) }))}\n`)
    } else if (command === 'verify-audit') {
      if (stateRoot === undefined || grantId !== undefined || revision !== undefined || dockerPath !== undefined || extra.length > 0) {
        throw new Error('usage: dsh-isolation verify-audit /absolute/private/archive-directory')
      }
      process.stdout.write(`${JSON.stringify(verifyIsolationAuditArchive(stateRoot))}\n`)
    } else {
    if (command !== 'revoke' || stateRoot === undefined || grantId === undefined || revision === undefined || extra.length > 1 || !/^[1-9][0-9]*$/.test(revision)) throw new Error('usage: dsh-isolation revoke /absolute/private/state-root grant-id revision [/absolute/docker [/absolute/docker.sock]]')
    const result = await revokeIsolationGrant(stateRoot, grantId, Number(revision), dockerPath, extra[0])
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.containersRemoved || result.nativeResourcesQuiescent === false) process.exitCode = 2
    }
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'isolation revoke failed'}\n`); process.exitCode = 1 }
}
