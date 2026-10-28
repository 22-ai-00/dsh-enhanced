import type { Context } from '@deepseek-ai/cordis'
import { version } from './version.js'
import { AssistantIsolationService, Config } from './service.js'

export const name = 'dsh-enhanced-assistant-isolation'
export { version, AssistantIsolationService, Config }
export { IsolatedVerifierRunner, type IsolatedVerifierRunnerConfig } from './verifier-runner.js'
export { runNativeMacProcess, type NativeMacProcessInput, type NativeMacProcessResult, type NativeMacReadRoot } from './native-macos.js'
export { validateNativeMacRuntime, verifyNativeMacRuntime, hashNativeMacRuntimeTree, nativeMacRuntimeDigest, type NativeMacRuntime } from './native-runtime.js'
export { NativeMacVerifierRunner, type NativeMacVerifierRunnerConfig } from './native-verifier-runner.js'
export { hashLinuxRuntimeTree, verifyLinuxRuntime, validateLinuxRuntime, linuxRuntimeDigest, type LinuxRuntime } from './linux-runtime.js'
export { runLinuxNamespace, type LinuxNamespaceInput, type LinuxNamespaceResult, type LinuxCandidateIdentity, type LinuxCandidateExit } from './linux-namespace.js'
export { runLinuxRepositoryNamespace, type LinuxRepositoryNamespaceInput, type LinuxRepositoryNamespaceResult } from './linux-namespace.js'
export { LinuxCgroupLease, type LinuxCgroupRoots, type LinuxCgroupLimits, type LinuxCgroupIdentity, type LinuxCgroupSnapshot } from './linux-cgroups.js'
export { LinuxVerifierRunner, type LinuxVerifierRunnerConfig } from './linux-verifier-runner.js'
export { consumeLinuxRepositoryAdmissionRefusal } from './linux-repository-admission.js'
export { LinuxRepositoryRunner, type LinuxRepositoryRunnerConfig, type LinuxRepositoryRunnerRequest, type LinuxRepositoryRunnerResult } from './linux-repository-runner.js'
export { prepareLinuxSystemSnapshot, verifyLinuxSystemSnapshot, verifyLinuxSystemSnapshotRuntimeDependencies, type LinuxSystemSnapshot } from './linux-system-snapshot.js'
export { readLinuxUserNamespaceMapping, verifyLinuxUserNamespaceMapping, validateLinuxUserNamespaceMapping,
  type LinuxUserNamespaceMapping, type LinuxUserNamespaceWitness } from './linux-user-namespace.js'
export { prepareLinuxExecutionIntent, runLinuxExecution, readLinuxExecutionReceipt, readLinuxExecutionPartialCleanupProof,
  reconcileLinuxExecution, linuxExecutionReceiptBinding, type LinuxExecutionReceipt } from './linux-execution.js'
export { prepareLinuxRepositoryIntent, runLinuxRepositoryExecution, readLinuxRepositoryReceipt, reconcileLinuxRepositoryExecution,
  type LinuxRepositoryExecutionContext, type LinuxRepositoryExecutionRequest, type LinuxRepositoryExecutionReceipt, type LinuxRepositoryExecutionOutcome,
  type LinuxRepositoryArtifact, type LinuxRepositoryArtifactSummary } from './linux-execution.js'
export { linuxExecutionContractDigest, linuxExecutionIntentDigest, linuxExecutionResourcesDigest,
  linuxJobResourceReservation, LINUX_REPOSITORY_STORAGE_BYTES,
  type LinuxExecutionContract, type LinuxExecutionContractV1, type LinuxRepositoryExecutionContract,
  type LinuxExecutionIntent, type LinuxExecutionIntentV1, type LinuxRepositoryExecutionIntent,
  type LinuxExecutionResources, type LinuxReceiptBinding,
  type LinuxExecutionPartialCleanupProof } from './linux-execution-contract.js'
export { inspectIsolationGrant, type IsolationGrantDiagnostic, type IsolationGrantDiagnosticReason } from './diagnostics.js'
export { probeIsolationRuntime, probeLinuxIsolationRuntime, type LinuxIsolationProbeConfig } from './probe.js'
export * from './audit-archive.js'
export { isolationPrincipalDigest } from './service.js'
export type * from './types.js'

export async function apply(ctx: Context, config: Config = {}): Promise<void> { await new AssistantIsolationService(ctx, config).ready }
// Loader unwraps the default export; preserve the trusted plugin identity there.
export default { name, Config, apply }
