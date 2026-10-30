import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import { LarkChannelService } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-lark-channel'
export const inject = ['assistantDelivery']
export { Config, LarkChannelService, version }
export * from './types.js'
export { LarkDeliveryAdapter } from './adapter.js'
export * from './approval.js'
export * from './setup-profile.js'
export * from './supervised-growth-profile.js'
export * from './launchd.js'
export * from './resident.js'
export * from './systemd.js'
export * from './windows-task.js'
export {
  createKeychainWriteRequest,
  createLarkRegistrationOptions,
  createSecretServiceWriteRequest,
  createWindowsDpapiWriteRequest,
  assertLinuxSecretServiceAvailable,
  assertLinuxProtectedFileAvailable,
  credentialProviderForPlatform,
  formatLarkSetupError,
  isMainEntry,
  matchOwnerHandshake,
  parseLarkSetupArgs,
  preflightLarkCredentialProvider,
  readSecretFromRawTerminal,
  retryDeferredLarkCredentialCleanup,
  selectLarkCredentialProvider,
  runLarkSetup,
} from './setup.js'
export type { LarkSetupRuntime, RawSecretTerminalOptions } from './setup.js'
export {
  SUPERVISED_GROWTH_LIFECYCLE_ATTESTATION_PROTOCOL,
  SUPERVISED_GROWTH_MANAGED_AUTOMATION_PROJECTION_PROTOCOL,
  assertSupervisedGrowthAutomationGuard,
  captureSupervisedGrowthLifecycleAttestation,
  commitSupervisedGrowthPatch,
  expectedSupervisedGrowthManagedAutomationDigest,
  expectedSupervisedGrowthRecoveryBootstrap,
  parseSupervisedGrowthSetupArgs,
  runSupervisedGrowthSetup,
  selectUniqueOwnerBinding,
  supervisedGrowthLifecycleAttestationDigest,
  verifySupervisedGrowthLifecycleSuccessor,
} from './supervised-growth-setup.js'
export type {
  SupervisedGrowthLifecycleAttestation,
  SupervisedGrowthLifecycleAttestationDependencies,
  SupervisedGrowthLifecycleAttestationInput,
  SupervisedGrowthManagedAutomationProjection,
  SupervisedGrowthManagedAutomationProjectionRecord,
} from './supervised-growth-setup.js'

// Installation-only maintenance must not turn optional Automations/Policy peers
// into eager dependencies of the ordinary Lark adapter.
export async function deriveScannerRetirementConfiguration(input: Parameters<typeof import('./rsi-scanner-retirement-config.js').deriveScannerRetirementConfiguration>[0]) {
  return (await import('./rsi-scanner-retirement-config.js')).deriveScannerRetirementConfiguration(input)
}
export async function captureScannerRetirementPlan(input: Parameters<typeof import('./rsi-scanner-retirement-stage.js').captureScannerRetirementPlan>[0]) {
  return (await import('./rsi-scanner-retirement-stage.js')).captureScannerRetirementPlan(input)
}
export async function applyScannerRetirementPlan(input: Parameters<typeof import('./rsi-scanner-retirement-stage.js').applyScannerRetirementPlan>[0]) {
  return (await import('./rsi-scanner-retirement-stage.js')).applyScannerRetirementPlan(input)
}
export async function verifyScannerRetirementPersistence(input: Parameters<typeof import('./rsi-scanner-retirement-stage.js').verifyScannerRetirementPersistence>[0]) {
  return (await import('./rsi-scanner-retirement-stage.js')).verifyScannerRetirementPersistence(input)
}
export type { ScannerRetirementPlan, ScannerRetirementCompletion, ScannerRetirementCapture } from './rsi-scanner-retirement-stage.js'

export function apply(ctx: Context, config: import('./config.js').Config): void {
  const normalized = Config(config)
  if (normalized.enabled && normalized.credentialHandle !== undefined) {
    ctx.inject(['credentialsKeychain'], (credentialsCtx) => {
      new LarkChannelService(credentialsCtx, normalized)
    })
    return
  }
  new LarkChannelService(ctx, normalized)
}

const plugin = { name, inject, Config, apply }

export default plugin
