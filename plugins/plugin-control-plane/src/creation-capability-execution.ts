import { createRequire } from 'node:module'
import { nativeMacRuntimeDigest } from '@dsh-enhanced/assistant-isolation'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import type { CreationCapabilityConfig } from './creation-capability-types.js'

// Verifier is optional for a plain Control Plane deployment. Only explicit
// Linux adoption loads these synchronous, resource-free validation modules.
// The supported Node baseline can require ESM without top-level await.
const requireVerifier = createRequire(import.meta.url)
const linuxRuntimeModule = () => requireVerifier('@dsh-enhanced/assistant-verifier/linux-behavior-runtime') as
  typeof import('@dsh-enhanced/assistant-verifier/linux-behavior-runtime')

export function validateLinuxCreationCapabilityRunner(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.getOwnPropertyDescriptor(value, 'backend')?.value !== 'linux-native') {
    throw new Error('created capability requires explicit Linux runner configuration')
  }
  const { validateCreationBehaviorDeploymentConfig } = requireVerifier('@dsh-enhanced/assistant-verifier/plugin-behavior-config') as
    typeof import('@dsh-enhanced/assistant-verifier/plugin-behavior-config')
  const checked = validateCreationBehaviorDeploymentConfig(value)
  if (!('backend' in checked) || checked.backend !== 'linux-native') throw new Error('created capability Linux runner changed')
  linuxRuntimeModule().validateLinuxPluginBehaviorRuntime(checked.runtime)
}

/** Exact protocol/backend identity; build provenance is separately read below. */
export function creationCapabilityExecutionMatches(certificate: PluginCreationVerificationCertificate,
  runner: CreationCapabilityConfig['runner']): boolean {
  try {
    if (certificate.protocol === 'assistant-growth/creation-verification/v1') return !('backend' in runner)
    if (certificate.protocol === 'assistant-growth/creation-verification/v2') {
      return 'backend' in runner && runner.backend === 'macos-seatbelt'
        && certificate.execution?.boundary === 'macos-seatbelt-single-process-v1'
        && certificate.execution.runtimeDigest === nativeMacRuntimeDigest(runner.runtime)
    }
    return certificate.protocol === 'assistant-growth/creation-verification/v3'
      && 'backend' in runner && runner.backend === 'linux-native'
      && certificate.execution?.boundary === 'linux-native-process-seccomp-v1'
      && certificate.execution.runtimeDigest === linuxRuntimeModule().linuxPluginBehaviorRuntimeDigest(runner.runtime)
  } catch { return false }
}

/** Read-only proof for adoption, restore and each invocation. It cannot rebuild
 * the original source or acquire/refund any execution or adoption grant. */
export async function verifyCreationCapabilityExecution(certificate: PluginCreationVerificationCertificate,
  runner: CreationCapabilityConfig['runner'], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (!creationCapabilityExecutionMatches(certificate, runner)) throw new Error('created capability verification runtime changed')
  if (!('backend' in runner) || runner.backend !== 'linux-native') return
  // Keep both the complete signed input and deployment authority stable across
  // import/file/hash awaits. Clone without sorting keys: runtime digests retain
  // the descriptor's validated JSON property order.
  const snapshot = canonicalGrowthJson({ certificate, runner })
  const pinnedCertificate = structuredClone(certificate), pinnedRunner = structuredClone(runner)
  if (canonicalGrowthJson({ certificate: pinnedCertificate, runner: pinnedRunner }) !== snapshot)
    throw new Error('created capability Linux inputs changed during snapshot')
  if (pinnedCertificate.execution?.boundary !== 'linux-native-process-seccomp-v1') throw new Error('created capability Linux provenance unavailable')
  const remaining = pinnedRunner.expiresAt - Date.now()
  if (remaining <= 0) throw new Error('created capability Linux runner expired')
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(120_000, remaining)))])
  const { verifyLinuxPluginBehaviorAdoptionRuntime } = await import('@dsh-enhanced/assistant-verifier/linux-behavior-runtime')
  bounded.throwIfAborted()
  await verifyLinuxPluginBehaviorAdoptionRuntime({ runtime: pinnedRunner.runtime,
    buildRuntimeDigest: pinnedCertificate.execution.buildRuntimeDigest,
    preparationDigest: pinnedCertificate.execution.observerPreparationDigest, signal: bounded })
  bounded.throwIfAborted()
  if (Date.now() >= pinnedRunner.expiresAt || canonicalGrowthJson({ certificate, runner }) !== snapshot
    || !creationCapabilityExecutionMatches(certificate, runner)) {
    throw new Error('created capability Linux runtime authority changed')
  }
}
