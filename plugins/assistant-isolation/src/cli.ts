#!/usr/bin/env node
import { probeLinuxIsolationRuntime } from './probe.js'
import { randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalAbsolutePath, isPrivateDirectoryStats, isPrivateFileStats, matchesOwnerUid, hasPrivateMode, noFollowFlag } from './fs-ownership.js'
import type { IsolationLedger } from './ledger.js'
import { defaultStoragePolicy, validateStoragePolicy } from './storage-policy.js'
import { maintainIsolationStorage, type IsolationStorageMaintenance } from './storage.js'

function installSqliteWarningFilter(): void {
  const sqliteWarningFiltered = Symbol.for('dsh-enhanced.sqlite-warning-filtered')
  if (Reflect.get(process.emitWarning, sqliteWarningFiltered)) return
  const originalEmitWarning = process.emitWarning
  const filteredEmitWarning = function emitWarning(this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const first = rest[0]
    let warningType: string | undefined
    if (typeof warning === 'object' && warning !== null && typeof warning.name === 'string') {
      warningType = warning.name
    } else if (typeof first === 'string') {
      warningType = first
    } else if (first !== null && typeof first === 'object' && typeof (first as { type?: unknown }).type === 'string') {
      warningType = (first as { type: string }).type
    }
    const warningMessage = typeof warning === 'object' && warning !== null && typeof warning.message === 'string'
      ? warning.message
      : String(warning ?? '')
    if (warningType === 'ExperimentalWarning' && warningMessage.includes('SQLite is an experimental feature')) {
      return
    }
    Reflect.apply(originalEmitWarning, this ?? process, [warning, ...rest])
  }
  Reflect.set(filteredEmitWarning, sqliteWarningFiltered, true)
  process.emitWarning = filteredEmitWarning as typeof process.emitWarning
}

function privateLedger(stateRoot: string): string {
  if (!canonicalAbsolutePath(stateRoot) || realpathSync(stateRoot) !== stateRoot) throw new Error('canonical state root required')
  const root = lstatSync(stateRoot)
  const file = join(stateRoot, 'ledger.sqlite')
  const database = lstatSync(file)
  if (!isPrivateDirectoryStats(root) || !isPrivateFileStats(database, process.platform, root.uid)) {
    throw new Error('private owned ledger required')
  }
  return file
}

export interface IsolationRevocationResult {
  revoked: true
  nativeResourcesQuiescent?: boolean
  nativeRetained?: number
}

/** Operator entry point, separate from the model's tool registry. */
export async function revokeIsolationGrant(stateRoot: string, grantId: string, revision: number): Promise<IsolationRevocationResult> {
  const [{ IsolationLedger, IsolationLedgerError }, { reconcileLinuxJob }, { reconcileNativeReceiptJob }] = await Promise.all([
    import('./ledger.js'),
    import('./linux-job-recovery.js'),
    import('./native-job-recovery.js'),
  ])
  const file = privateLedger(stateRoot)
  const ledger = new IsolationLedger(file)
  let authority: ReturnType<IsolationLedger['claimController']> | undefined
  let timer: NodeJS.Timeout | undefined
  const abort = new AbortController()
  try {
    ledger.revoke(grantId, revision, 'external-operator-revoke')
    let nativeSeen = false
    let cursor = ''
    for (;;) {
      const page = ledger.recoverable(cursor)
      if (page.length === 0) break
      cursor = page.at(-1)!.id
      for (const job of page) {
        if (job.grantId !== grantId || (job.backend !== 'linux-native' && job.backend !== 'macos-seatbelt' && job.backend !== 'windows-job')) continue
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
        if (authority) {
          if (job.backend === 'linux-native') await reconcileLinuxJob(ledger, authority, job, join(stateRoot, 'linux-executions'), abort.signal)
          else await reconcileNativeReceiptJob(ledger, authority, job, stateRoot, { signal: abort.signal })
        }
      }
    }
    if (!nativeSeen) return { revoked: true }
    let nativeRetained = 0
    cursor = ''
    for (;;) {
      const page = ledger.recoverable(cursor)
      if (page.length === 0) break
      cursor = page.at(-1)!.id
      nativeRetained += page.filter(job => (job.backend === 'linux-native' || job.backend === 'macos-seatbelt' || job.backend === 'windows-job') && job.grantId === grantId).length
    }
    return { revoked: true, nativeResourcesQuiescent: nativeRetained === 0, nativeRetained }
  } finally {
    if (timer) clearInterval(timer)
    try { if (authority) ledger.releaseController(authority) } finally { ledger.close() }
  }
}

/** Reconcile only settled requests; a live Host owns its own background sweep. */
export async function reconcileIsolation(stateRoot: string,
  signal: AbortSignal = new AbortController().signal): Promise<{ checked: number; released: number; retained: number }> {
  const [{ IsolationLedger }, { reconcileLinuxJob }, { reconcileNativeReceiptJob }] = await Promise.all([
    import('./ledger.js'),
    import('./linux-job-recovery.js'),
    import('./native-job-recovery.js'),
  ])
  const ledger = new IsolationLedger(privateLedger(stateRoot))
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let authority: ReturnType<IsolationLedger['claimController']> | undefined
  try {
    authority = ledger.claimController(randomUUID(), 30_000)
    const controller = authority
    timer = setInterval(() => { try { if (!ledger.renewController(controller, 30_000)) abort.abort() } catch { abort.abort() } }, 5_000)
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
        const released = job.backend === 'linux-native'
          ? await reconcileLinuxJob(ledger, controller, job, join(stateRoot, 'linux-executions'), combined)
          : (job.backend === 'macos-seatbelt' || job.backend === 'windows-job')
            ? await reconcileNativeReceiptJob(ledger, controller, job, stateRoot, { signal: combined })
            : false
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
  const { IsolationLedger } = await import('./ledger.js')
  const policy = validateStoragePolicy({ ...defaultStoragePolicy, resultRetentionMs })
  const ledger = new IsolationLedger(privateLedger(stateRoot))
  let authority: ReturnType<IsolationLedger['claimController']> | undefined
  let timer: NodeJS.Timeout | undefined
  try {
    authority = ledger.claimController(randomUUID(), 30_000)
    const controller = authority
    timer = setInterval(() => { try { ledger.renewController(controller, 30_000) } catch { /* The maintenance fence fails closed. */ } }, 5_000)
    timer.unref()
    return await maintainIsolationStorage(ledger, controller, stateRoot, policy, afterId)
  } finally {
    if (timer) clearInterval(timer)
    try { if (authority) ledger.releaseController(authority) } finally { ledger.close() }
  }
}

let isMain = false
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch { /* Importing modules need not have a filesystem entry point. */ }
if (isMain) {
  installSqliteWarningFilter()
  const [command, stateRoot, grantId, revision, ...extra] = process.argv.slice(2)
  try {
    if (command === 'probe-native') {
      if (!stateRoot || grantId !== undefined || revision !== undefined || extra.length > 0) throw new Error('usage: dsh-isolation probe-native /absolute/runtime-config.json')
      const file = await open(stateRoot, constants.O_RDONLY | noFollowFlag())
      try {
        const stat = await file.stat()
        if (!stat.isFile() || !matchesOwnerUid(stat.uid) || stat.nlink !== 1 || !hasPrivateMode(stat.mode, 0o022, 0) || stat.size > 65_536) throw new Error('native probe config must be a bounded owned regular file')
        const text = await file.readFile('utf8')
        const after = await file.stat()
        if (Buffer.byteLength(text) !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.mtimeMs) throw new Error('native probe config changed while reading')
        process.stdout.write(`${JSON.stringify(await probeLinuxIsolationRuntime(JSON.parse(text)))}\n`)
      } finally { await file.close() }
    } else if (command === 'maintain') {
      if (stateRoot === undefined || (grantId !== undefined && !/^(0|[1-9][0-9]*)$/.test(grantId))) throw new Error('usage: dsh-isolation maintain /absolute/private/state-root [result-retention-ms [after-job-id]]')
      process.stdout.write(`${JSON.stringify(await maintainIsolation(stateRoot, grantId === undefined ? 0 : Number(grantId), revision))}\n`)
    } else if (command === 'reconcile') {
      if (stateRoot === undefined || extra.length > 0) throw new Error('usage: dsh-isolation reconcile /absolute/private/state-root')
      const abort = new AbortController()
      const cancel = (): void => abort.abort()
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
      try { process.stdout.write(`${JSON.stringify(await reconcileIsolation(stateRoot, abort.signal))}\n`) }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
    } else if (command === 'archive-audit') {
      if (stateRoot === undefined || grantId === undefined || extra.length > 0
        || (revision !== undefined && (!/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision)) || Number(revision) > 1_000))) {
        throw new Error('usage: dsh-isolation archive-audit /absolute/private/state-root /absolute/private/archive-directory [batch-size]')
      }
      const { archiveIsolationAudit } = await import('./audit-archive.js')
      process.stdout.write(`${JSON.stringify(await archiveIsolationAudit({ stateRoot, archiveDirectory: grantId, ...(revision === undefined ? {} : { batchSize: Number(revision) }) }))}\n`)
    } else if (command === 'verify-audit') {
      if (stateRoot === undefined || grantId !== undefined || revision !== undefined || extra.length > 0) {
        throw new Error('usage: dsh-isolation verify-audit /absolute/private/archive-directory')
      }
      const { verifyIsolationAuditArchive } = await import('./audit-archive.js')
      process.stdout.write(`${JSON.stringify(verifyIsolationAuditArchive(stateRoot))}\n`)
    } else if (command === 'revoke') {
      if (command !== 'revoke' || stateRoot === undefined || grantId === undefined || revision === undefined || extra.length > 0 || !/^[1-9][0-9]*$/.test(revision)) throw new Error('usage: dsh-isolation revoke /absolute/private/state-root grant-id revision')
      const result = await revokeIsolationGrant(stateRoot, grantId, Number(revision))
      process.stdout.write(`${JSON.stringify(result)}\n`)
      if (result.nativeResourcesQuiescent === false) process.exitCode = 2
    } else {
      throw new Error('unknown command')
    }
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'isolation operation failed'}\n`); process.exitCode = 1 }
}
