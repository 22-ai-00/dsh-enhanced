#!/usr/bin/env node
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ActionLedger } from './ledger.js'

export function revokeActionGrant(root: string, grantId: string, revision: number): void {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw new Error('private canonical root required')
  const dir = lstatSync(root); const path = join(root, 'ledger.sqlite'); const file = lstatSync(path)
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0 || !file.isFile() || file.isSymbolicLink()
    || file.nlink !== 1 || file.uid !== dir.uid || (file.mode & 0o077) !== 0) throw new Error('private owned ledger required')
  const ledger = new ActionLedger(path)
  try { ledger.revoke(grantId, revision) } finally { ledger.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, root, grant, revision, ...extra] = process.argv.slice(2)
  try {
    if (command !== 'revoke' || !root || !grant || !revision || !/^[1-9][0-9]*$/.test(revision) || extra.length) throw new Error('usage: dsh-actions revoke /private/state grant-id revision')
    revokeActionGrant(root, grant, Number(revision))
    process.stdout.write('{"revoked":true,"inFlightOutcome":"requires-readback"}\n')
  } catch { process.stderr.write('assistant-actions: revocation failed or invalid arguments\n'); process.exitCode = 1 }
}
