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
export { LinuxCgroupLease, type LinuxCgroupRoots, type LinuxCgroupLimits, type LinuxCgroupIdentity, type LinuxCgroupSnapshot } from './linux-cgroups.js'
export { LinuxVerifierRunner, type LinuxVerifierRunnerConfig } from './linux-verifier-runner.js'
export { prepareLinuxExecutionIntent, runLinuxExecution, readLinuxExecutionReceipt, readLinuxExecutionPartialCleanupProof,
  reconcileLinuxExecution, linuxExecutionReceiptBinding, type LinuxExecutionReceipt } from './linux-execution.js'
export { linuxExecutionContractDigest, linuxExecutionIntentDigest, linuxExecutionResourcesDigest,
  type LinuxExecutionContract, type LinuxExecutionIntent, type LinuxExecutionResources, type LinuxReceiptBinding,
  type LinuxExecutionPartialCleanupProof } from './linux-execution-contract.js'
export { inspectIsolationGrant, type IsolationGrantDiagnostic, type IsolationGrantDiagnosticReason } from './diagnostics.js'
export { probeIsolationRuntime } from './probe.js'
export * from './audit-archive.js'
export { isolationPrincipalDigest } from './service.js'
export type * from './types.js'

export async function apply(ctx: Context, config: Config = {}): Promise<void> { await new AssistantIsolationService(ctx, config).ready }
// Loader unwraps the default export; preserve the trusted plugin identity there.
export default { name, Config, apply }
