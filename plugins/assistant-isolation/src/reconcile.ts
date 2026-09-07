import { realpath } from 'node:fs/promises'
import { cleanupIsolationResources } from './cleanup-receipt.js'
import type { IsolationControllerAuthority, IsolationLedger } from './ledger.js'
import { captureDaemonWitness, processExited, sameDaemonWitness } from './runtime-witness.js'
import type { IsolationJob } from './types.js'

/** Host-only reconciliation. Lost mutation receipts never acquire release authority. */
export async function reconcileUnknownJob(ledger: IsolationLedger, authority: IsolationControllerAuthority,
  job: IsolationJob, dockerPath: string, signal: AbortSignal): Promise<boolean> {
  const original = job.creationWitness
  if (signal.aborted || job.status !== 'unknown' || job.result?.quiescent !== false
    || original?.requestsSettled !== true || !processExited(original.supervisor)) return false
  try {
    if (!ledger.hasController(authority) || await realpath(dockerPath) !== original.daemon.dockerPath) return false
    const before = await captureDaemonWitness(original.daemon)
    if (!before || !sameDaemonWitness(original.daemon, before) || signal.aborted) return false
    const cleanup = await cleanupIsolationResources(before.dockerPath, job.containerName, { socketPath: before.socketPath, signal })
    if (!cleanup || signal.aborted) return false
    const current = await captureDaemonWitness(before)
    if (!current || !sameDaemonWitness(before, current) || signal.aborted) return false
    ledger.settleReconciledUnknown(job.id, job.version, { original, current, checkedAt: Date.now(), cleanup }, authority)
    return true
  } catch { return false }
}
