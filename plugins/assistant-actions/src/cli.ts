#!/usr/bin/env node
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

export async function revokeActionGrant(root: string, grantId: string, revision: number): Promise<void> {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw new Error('private canonical root required')
  const dir = lstatSync(root); const path = join(root, 'ledger.sqlite'); const file = lstatSync(path)
  if (process.platform === 'win32') {
    if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('private owned ledger required')
  } else {
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0 || !file.isFile() || file.isSymbolicLink()
      || file.nlink !== 1 || file.uid !== dir.uid || (file.mode & 0o077) !== 0) throw new Error('private owned ledger required')
  }
  const { ActionLedger } = await import('./ledger.js')
  const ledger = new ActionLedger(path)
  try { ledger.revoke(grantId, revision) } finally { ledger.close() }
}
let isMain = false
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch { /* Importing modules need not have a filesystem entry point. */ }
if (isMain) {
  installSqliteWarningFilter()
  const [command, root, grant, revision, ...extra] = process.argv.slice(2)
  try {
    if (command !== 'revoke' || !root || !grant || !revision || !/^[1-9][0-9]*$/.test(revision) || extra.length) throw new Error('usage: dsh-actions revoke /private/state grant-id revision')
    await revokeActionGrant(root, grant, Number(revision))
    process.stdout.write('{"revoked":true,"inFlightOutcome":"requires-readback"}\n')
  } catch { process.stderr.write('assistant-actions: revocation failed or invalid arguments\n'); process.exitCode = 1 }
}
