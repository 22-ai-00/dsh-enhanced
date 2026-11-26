import type { Context } from '@deepseek-ai/cordis'
import { AssistantRecoveryService, Config } from './service.js'
import type { Config as ConfigType } from './config.js'
import { version } from './version.js'

export const name = 'dsh-ray-assistant-recovery'
export const inject = [
  'assistantAutomations',
  'assistantDelivery',
  'assistantEvaluation',
  'assistantEvolution',
  'assistantGoals',
  'assistantPreferenceLearning',
  'assistantHealth',
]
export { AssistantRecoveryService, Config, version }
export type { ConfigType as AssistantRecoveryConfig }
export * from './attestation.js'
export * from './automation-executor.js'
export * from './catalog.js'
export * from './compensation-executor.js'
export * from './compensation-ledger.js'
export * from './compensation-registry.js'
export * from './compensation-service.js'
export * from './compensation-types.js'
export {
  ConfigSchema,
  normalizeRecoveryConfig,
} from './config.js'
export type {
  NormalizedConfig,
  NormalizedRecoveryJob,
  RecoveryActivationState,
  RecoveryJobConfig,
} from './config.js'
export * from './executor.js'
export * from './operator.js'
export * from './port.js'
export {
  AssistantRecoveryError,
  recoveryActivationPlanDigest,
  recoveryAutomationDefinition,
  recoveryAutomationId,
} from './service.js'
export * from './store.js'
export * from './types.js'

export function apply(ctx: Context, config: ConfigType): void {
  new AssistantRecoveryService(ctx, config)
}

export default AssistantRecoveryService
