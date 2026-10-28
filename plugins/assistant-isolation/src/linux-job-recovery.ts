import { IsolationLedgerError, type IsolationControllerAuthority, type IsolationLedger } from './ledger.js'
import { linuxExecutionReceiptBinding, readLinuxExecutionReceipt, reconcileLinuxExecution } from './linux-execution.js'
import type { IsolationJob, IsolationResult } from './types.js'

/** Reconcile one persisted native job without replay or changing its authority. */
export async function reconcileLinuxJob(ledger: IsolationLedger, authority: IsolationControllerAuthority,
  initial: IsolationJob, executionRoot: string, signal?: AbortSignal): Promise<boolean> {
  const current = (): void => {
    signal?.throwIfAborted()
    if (!ledger.hasController(authority)) throw new IsolationLedgerError('unauthorized', 'Linux recovery controller unavailable')
  }
  current()
  if (initial.backend !== 'linux-native') return false
  let job = ledger.get(initial.id)
  if (!job || job.backend !== 'linux-native') return false
  if (job.result?.quiescent) return true
  const unknown = (quiescent: boolean): IsolationResult => job!.result
    ? { ...job!.result, quiescent }
    : { jobId: job!.id, status: 'unknown', quiescent, stdout: '', stderr: '', artifacts: [], reason: 'linux-recovery-no-replay' }
  if (!job.dispatchAttempted) {
    current()
    return ledger.settle(job.id, job.version, unknown(true), authority).result?.quiescent === true
  }
  if (job.linuxIntent && job.linuxContract) {
    try {
      const ctx = { stateRoot: executionRoot, contract: job.linuxContract, intent: job.linuxIntent }
      const receipt = await readLinuxExecutionReceipt(ctx)
      current()
      const recovered = receipt ? { receipt, resources: receipt.resources } : await reconcileLinuxExecution(ctx)
      current()
      if (!job.linuxResources && recovered.resources && job.status === 'prepared') {
        job = ledger.recordLinuxResources(job.id, job.version, recovered.resources, authority)
      } else if (!job.linuxResources && recovered.resources && job.status === 'unknown') {
        job = ledger.recordLinuxRecoveredResources(job.id, job.version, recovered.resources, authority)
      }
      if ('partialProof' in recovered && recovered.partialProof && !job.linuxResources) {
        return ledger.settleLinuxPrestartCleanup(job.id, job.version, recovered.partialProof, authority).result?.quiescent === true
      }
      if (recovered.receipt && job.linuxResources) {
        const binding = linuxExecutionReceiptBinding(recovered.receipt)
        const settled = job.status === 'unknown'
          ? ledger.settleLinuxReconciledUnknown(job.id, job.version, binding, authority)
          : ledger.settleLinuxReceipt(job.id, job.version, binding, recovered.receipt.result, authority)
        return settled.result?.quiescent === true
      }
    } catch {
      // Unavailable evidence cannot release reservations. Abort and fence loss
      // still propagate rather than becoming an ordinary uncertain outcome.
      current()
    }
  }
  current()
  if (job.status === 'prepared' || job.status === 'running') ledger.settle(job.id, job.version, unknown(false), authority)
  return false
}
