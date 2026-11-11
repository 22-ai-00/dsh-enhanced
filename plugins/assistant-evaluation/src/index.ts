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
  IntakeAttentionAgreementPersistReason,
  IntakeAttentionAgreementPersistResult,
  OwnerQuestionReplyInput,
  OwnerQuestionReplyOutcome,
  OwnerQuestionReplyRegistration,
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
  INTAKE_ATTENTION_AGREEMENT_HISTORY_PROTOCOL,
  INTAKE_ATTENTION_AGREEMENT_PROTOCOL,
  INTAKE_ATTENTION_AGREEMENT_SCAN_LIMIT,
  INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_PROTOCOL,
  INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_VERSION,
  computeIntakeAttentionAgreement,
  createIntakeAttentionAgreementSnapshot,
  intakeAttentionAgreementSnapshotDigest,
} from './intake-attention-agreement.js'
export type {
  IntakeAttentionAgreement,
  IntakeAttentionAgreementCell,
  IntakeAttentionAgreementHistory,
  IntakeAttentionAgreementSnapshot,
  IntakeAttentionAgreementSnapshotContent,
  IntakeAttentionAgreementSnapshotInput,
} from './intake-attention-agreement.js'
export { IntakeAttentionAgreementLedger } from './intake-attention-agreement-store.js'
export type {
  IntakeAttentionAgreementRecordResult,
  StoredIntakeAttentionAgreementSnapshot,
} from './intake-attention-agreement-store.js'
export {
  ATTENTION_HOLDOUT_PROTOCOL,
  ATTENTION_LOOSENING_GRANT_PROTOCOL,
  ATTENTION_LOOSENING_PROTOCOL,
  ATTENTION_OWNER_QUESTION_PROTOCOL,
  ATTENTION_TUNING_PROTOCOL,
  AttentionTuningLedger,
  attentionGrantExceeded,
  attentionHoldoutMember,
  attentionHoldoutModulus,
  attentionLooseningChange,
  attentionRegressed,
  attentionTighterOrEqual,
  attentionTuningBounds,
  attentionTuningOrder,
  clampAttentionTuning,
  defaultAttentionTuningParameters,
  isAttentionLoosening,
  normalizeAttentionCohort,
  normalizeAttentionLooseningGrant,
  normalizeAttentionTuningParameters,
  proposeAttentionTuning,
  replayAttentionLoosening,
  withinAttentionTuningBounds,
} from './attention-tuning.js'
export type {
  AttentionCohort,
  AttentionCohortStats,
  AttentionGrantExceeded,
  AttentionHoldoutSeal,
  AttentionLooseningChange,
  AttentionLooseningDecision,
  AttentionLooseningGrant,
  AttentionLooseningGrantResult,
  AttentionLooseningOptions,
  AttentionLooseningProposal,
  AttentionLooseningRejection,
  AttentionLooseningStatus,
  AttentionOwnerQuestion,
  AttentionOwnerQuestionApplyResult,
  AttentionOwnerQuestionLedgerPort,
  AttentionReplayFailure,
  AttentionReplayRecord,
  AttentionReplaySummary,
  AttentionReplayTally,
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
export {
  ATTENTION_OWNER_QUESTION_REPLY_PROTOCOL,
  ATTENTION_OWNER_QUESTION_SOURCE_ID,
  AttentionOwnerQuestionLedger,
  attentionOwnerQuestionChoices,
  attentionOwnerQuestionIdempotencyKey,
  attentionOwnerQuestionText,
  parseAttentionOwnerQuestionChoice,
} from './attention-owner-questions.js'
export type {
  AttentionOwnerQuestionChoice,
  AttentionOwnerQuestionDelivery,
  AttentionOwnerQuestionDeliveryStatus,
  AttentionOwnerQuestionReply,
  AttentionOwnerQuestionReplyResult,
  AttentionOwnerQuestionStatus,
  AttentionOwnerQuestionTickAction,
} from './attention-owner-questions.js'
export * from './types.js'

export function apply(ctx: Context, config: ConfigType): void {
  new AssistantEvaluationService(ctx, config)
}

export default AssistantEvaluationService
