import { lstat, opendir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { IsolationControllerAuthority, IsolationLedger } from './ledger.js'
import { validateStoragePolicy } from './storage-policy.js'
import type { IsolationStorageObservation, IsolationStoragePolicy } from './types.js'

/** A bounded observation, not an atomic snapshot or a filesystem quota. */
export async function observeStorage(root: string): Promise<IsolationStorageObservation | undefined> {
  const started = Date.now()
  let bytes = 0; let entries = 0
  try {
    const owner = await lstat(root)
    if (await realpath(root) !== root || !owner.isDirectory() || owner.uid !== process.getuid?.() || (owner.mode & 0o077) !== 0) return undefined
    const visit = async (path: string): Promise<void> => {
      if (++entries > 50_000 || Date.now() - started > 2000) throw new Error('storage observation limit')
      let stat
      try { stat = await lstat(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path !== root) return
        throw error
      }
      if (stat.uid !== owner.uid || stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('untrusted storage entry')
      bytes += Math.max(stat.size, stat.blocks * 512)
      if (!Number.isSafeInteger(bytes)) throw new Error('storage observation overflow')
      if (stat.isDirectory()) for await (const entry of await opendir(path)) await visit(join(path, entry.name))
    }
    await visit(root)
    // The observation age includes the traversal, so a slow walk cannot look fresh.
    return { bytes, observedAt: started }
  } catch { return undefined }
}

/** Delete only an exact known, stopped job's Host staging directory. */
async function cleanStaging(root: string, id: string, fenced: () => boolean): Promise<boolean> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) || !fenced()) return false
  const parent = join(root, 'workspaces'); const target = join(parent, id)
  try {
    for (const path of [root, parent, target]) {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || await realpath(path) !== path) return false
    }
    if (!fenced()) return false
    // Host-owned parents; worker processes never mount or write this tree.
    await rm(target, { recursive: true, force: true })
    return fenced()
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' && fenced() }
}

export interface IsolationStorageMaintenance {
  checked: number
  pruned: number
  logicalBytesRemoved: number
  stagingCleaned: number
  retained: number
  cursor: string
  checkpoint: 'complete' | 'busy'
  reclaimMode: 'incremental' | 'page-reuse'
  observation?: IsolationStorageObservation
}

/** One bounded controller page. Zero retention age never prunes result bodies. */
export async function maintainIsolationStorage(ledger: IsolationLedger, authority: IsolationControllerAuthority,
  root: string, input: IsolationStoragePolicy, afterId = ''): Promise<IsolationStorageMaintenance> {
  const policy = validateStoragePolicy(input)
  const now = Date.now()
  const cutoff = Math.max(0, now - policy.resultRetentionMs)
  const fenced = (): boolean => ledger.hasController(authority)
  if (!fenced()) throw new Error('assistant-isolation: controller unavailable')
  const page = ledger.retentionCandidates(cutoff, afterId, 16)
  const counts = { checked: 0, pruned: 0, logicalBytesRemoved: 0, stagingCleaned: 0, retained: 0 }
  for (const candidate of page) {
    if (!fenced()) throw new Error('assistant-isolation: controller unavailable')
    const eligible = (): boolean => {
      const job = ledger.get(candidate.id)
      return fenced() && job?.version === candidate.version && job.updatedAt <= cutoff
        && ['succeeded', 'failed', 'cancelled', 'timed-out'].includes(job.status) && job.result?.quiescent === true
    }
    counts.checked++
    if (!eligible() || !await cleanStaging(root, candidate.id, eligible)) { counts.retained++; continue }
    counts.stagingCleaned++
    if (policy.resultRetentionMs > 0) {
      const result = ledger.compactResult(candidate.id, candidate.version, cutoff, authority)
      if (result.changed) { counts.pruned++; counts.logicalBytesRemoved += result.removedBytes }
    }
  }
  const maintenance = ledger.maintainStorage(authority)
  const observation = await observeStorage(root)
  if (!fenced()) throw new Error('assistant-isolation: controller unavailable')
  return { ...counts, cursor: page.at(-1)?.id ?? '', ...maintenance, ...(observation ? { observation } : {}) }
}
