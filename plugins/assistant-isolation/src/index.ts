import type { Context } from '@deepseek-ai/cordis'
import { version } from './version.js'
import { AssistantIsolationService, Config } from './service.js'

export const name = 'dsh-ray-assistant-isolation'
export { version, AssistantIsolationService, Config }
export { type AssistantIsolationServiceOptions } from './service.js'
export { validateConfig, defaultLimits, type ValidatedConfig, type ValidateConfigOptions, type MacosIsolationConfig, type WindowsIsolationConfig } from './config.js'
export { resolveIsolationBackend, isSupportedIsolationBackend, isSupportedIsolationBackendConfig, type IsolationBackend, type IsolationBackendConfig } from './platform.js'
export { IsolatedVerifierRunner, type IsolatedVerifierRunnerConfig, type AutoVerifierRunnerConfig,
  type MacosSeatbeltVerifierRunnerConfig, type WindowsJobVerifierRunnerConfig } from './verifier-runner.js'
export { NativeCommandVerifierRunner, type NativeCommandVerifierRunnerConfig } from './native-command-verifier-runner.js'
export { buildMacosSeatbeltCommandProfile, buildScrubbedMacosEnv, verifyMacosSandboxExec, runMacosSeatbeltCommand,
  DEFAULT_MACOS_SANDBOX_EXEC, type MacosSeatbeltCommandProfileInput, type MacosSeatbeltCommandInput,
  type MacosSeatbeltCommandResult, type MacosSeatbeltAdapter } from './macos-command.js'
export { buildWindowsCommandLine, buildScrubbedWindowsEnv, buildWindowsHostRunnerEnv, buildWindowsJobRunnerInvocation, buildWindowsJobSpec,
  computeWindowsJobLimits, quoteWindowsArg, runWindowsJobProcess, verifyWindowsJobRunner,
  DEFAULT_WINDOWS_POWERSHELL, DEFAULT_WINDOWS_CMD, WINDOWS_JOB_RUNNER_SCRIPT, WINDOWS_JOB_LIMIT_FLAGS, WINDOWS_JOB_UI_RESTRICTIONS_FLAGS,
  type WindowsJobObjectLimits, type WindowsJobSpec, type WindowsJobProcessInput, type WindowsJobProcessResult, type WindowsJobAdapter } from './windows-job.js'
export { buildIsolatedSubprocessPlan, runIsolatedSubprocess, createIsolatedSubprocessRunner, DEFAULT_BWRAP_PATH,
  type IsolatedSubprocessNetworkMode, type IsolatedSubprocessLimits, type IsolatedSubprocessLimitsEnforced, type IsolatedSubprocessRequest,
  type IsolatedSubprocessResult, type IsolatedSubprocessPlan, type IsolatedSubprocessPlanOptions, type IsolatedSubprocessAdapter } from './subprocess.js'
export { runNativeMacProcess, type NativeMacProcessInput, type NativeMacProcessResult, type NativeMacReadRoot } from './native-macos.js'
export { validateNativeMacRuntime, verifyNativeMacRuntime, hashNativeMacRuntimeTree, nativeMacRuntimeDigest, type NativeMacRuntime } from './native-runtime.js'
export { NativeMacVerifierRunner, type NativeMacVerifierRunnerConfig } from './native-verifier-runner.js'
export { hashLinuxRuntimeTree, verifyLinuxRuntime, validateLinuxRuntime, linuxRuntimeDigest, type LinuxRuntime } from './linux-runtime.js'
export { runLinuxNamespace, type LinuxNamespaceInput, type LinuxNamespaceResult, type LinuxCandidateIdentity, type LinuxCandidateExit } from './linux-namespace.js'
export { runLinuxRepositoryNamespace, type LinuxRepositoryNamespaceInput, type LinuxRepositoryNamespaceResult } from './linux-namespace.js'
export { LinuxCgroupLease, type LinuxCgroupRoots, type LinuxCgroupLimits, type LinuxCgroupIdentity, type LinuxCgroupSnapshot } from './linux-cgroups.js'
export { LinuxVerifierRunner, type LinuxVerifierRunnerConfig } from './linux-verifier-runner.js'
export { prepareLinuxRunnerState, inspectLinuxRunnerState, validateLinuxRunnerStateSeal,
  resealLinuxRunnerState, linuxRunnerStateSchemaDigest,
  type LinuxRunnerStateSeal, type Kind, type LinuxRunnerStateResealInput } from './linux-runner-state.js'
export { migrateLinuxVerifierRunnerState, prepareLinuxVerifierHandoverState, prepareLinuxRepositoryHandoverState,
  prepareLinuxVerifierStagingState,
  type LinuxVerifierHandoverInput, type LinuxVerifierHandoverResult, type LinuxRepositoryHandoverInput,
  type LinuxVerifierHandoverPreparation, type LinuxVerifierHandoverPreparationInput,
  type LinuxVerifierStagingPreparation } from './linux-runner-state-migration.js'
export { grantDigest } from './ledger.js'
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
export { probeLinuxIsolationRuntime, type LinuxIsolationProbeConfig } from './probe.js'
export * from './audit-archive.js'
export { isolationPrincipalDigest } from './service.js'
export type * from './types.js'

export async function apply(ctx: Context, config: Config): Promise<void> { await new AssistantIsolationService(ctx, config).ready }
// Loader unwraps the default export; preserve the trusted plugin identity there.
export default { name, Config, apply }

export { validateLinuxCgroupRoots } from './linux-execution-contract.js'
