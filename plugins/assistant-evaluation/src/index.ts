import type { Context } from '@deepseek-ai/cordis'
import {
  ASSISTANT_EVALUATION_SKILL,
  AssistantEvaluationService,
  Config,
  canonicalEvaluationHostScope,
} from './service.js'
import type { Config as ConfigType } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-evaluation'
export {
  ASSISTANT_EVALUATION_SKILL,
  AssistantEvaluationService,
  Config,
  canonicalEvaluationHostScope,
  version,
}
export type { ConfigType as AssistantEvaluationConfig }
export type {
  EvaluationHostScope,
  TrustedAutomationEvaluationProducer,
  TrustedDeliveryEvaluationProducer,
} from './service.js'
export { AssistantEvaluationError } from './service.js'
export {
  EvaluationStore,
  EvaluationStoreError,
  canonicalEvaluationScope,
  evaluationLearningProjectionDigest,
} from './store.js'
export { EvaluationDatabaseError, evaluationSchemaVersion } from './sqlite.js'
export {
  NotificationOutcomeLedger,
  classifyNotificationOutcome,
  normalizeNotificationOutcomeFact,
  notificationOutcomeDigest,
} from './notification-outcomes.js'
export {
  ATTENTION_TUNING_PROTOCOL,
  AttentionTuningLedger,
  attentionRegressed,
  attentionTuningBounds,
  attentionTuningOrder,
  clampAttentionTuning,
  defaultAttentionTuningParameters,
  isAttentionLoosening,
  normalizeAttentionCohort,
  normalizeAttentionTuningParameters,
  proposeAttentionTuning,
  withinAttentionTuningBounds,
} from './attention-tuning.js'
export type {
  AttentionCohort,
  AttentionCohortStats,
  AttentionTuningChange,
  AttentionTuningCurrent,
  AttentionTuningEvent,
  AttentionTuningParameter,
  AttentionTuningParameters,
  AttentionTuningPolicy,
  AttentionTuningProposal,
  AttentionTuningRequestRejection,
  AttentionTuningRequestResult,
  AttentionTuningStatus,
  AttentionTuningTickAction,
  AttentionTuningVersion,
} from './attention-tuning.js'
export * from './types.js'

export function apply(ctx: Context, config: ConfigType): void {
  new AssistantEvaluationService(ctx, config)
}

export default AssistantEvaluationService
