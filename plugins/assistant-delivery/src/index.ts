import type { Context } from '@deepseek-ai/cordis'
import { DeliveryAdapterRegistryStoppedError } from './coordinator.js'
import { AssistantDeliveryService, Config, isTrustedDeliveryPreferenceProducer } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-delivery'
export { AssistantDeliveryService, Config, DeliveryAdapterRegistryStoppedError, isTrustedDeliveryPreferenceProducer, version }
export type {
  CommitOwnerAnchoredWorkflowTraceServiceResult,
  DeliveryInboundRuntime,
  OwnerForegroundLearningTask,
} from './service.js'
export type { ForegroundExecution } from './acceptance.js'
export type { ForegroundTerminationObservation } from './foreground-termination.js'
export type { ForegroundTaskIdentity, ForegroundTaskObservationRegistration, ForegroundToolCallAttestation, ForegroundToolInputPage, OwnerForegroundToolInput } from './foreground-observation.js'
export type {
  DeliveryGoalWakeInput, DeliveryGoalWakeResult, OwnerGoalOutcomeFeedbackLocator,
  OwnerGoalOutcomeFeedbackProof, OwnerGoalOutcomeFeedbackTarget,
} from './goal-wake-types.js'
export * from './types.js'
export * from './operator.js'
export { ReplyReplayBlockedError, replyReplayInputDigest, replyReplayBlockContract } from './reply-replay.js'
export type { ReplyReplayBlockConfig, ReplyReplayBlockHandle, ReplyReplayBlockSnapshot, ReplyReplayBlockedAttempt } from './reply-replay.js'
export * from './learning-command.js'
export { externalPrincipalId, ownerRouteAuthorityHash } from './canonical.js'
export { deliverySchemaVersion } from './sqlite.js'
export {
  createInProcessReloadRuntime,
} from './in-process-reload-runtime.js'
export type {
  InProcessReloadRuntime, InProcessReloadRuntimeActivationInput, InProcessReloadRuntimeActivationResult,
  InProcessReloadRuntimeOptions, InProcessReloadRuntimeProbe, InProcessReloadRuntimeRollbackInput,
  InProcessReloadRuntimeRollbackResult, InProcessReloadRuntimeTarget,
} from './in-process-reload-runtime.js'
export {
  ActiveLarkOwnerBindingsSnapshotError, activeLarkOwnerBindingsSnapshotProtocol,
  inspectActiveLarkOwnerBindingsLocally, inspectActiveWebOwnerBindingLocally,
  listActiveIdleWebOwnerBindingsLocally, inspectRevokedOwnerRouteLocally, revokedOwnerRouteSnapshotProtocol,
} from './operator-snapshot.js'
export type {
  ActiveIdleWebOwnerBindingsInspection, ActiveLarkOwnerBinding, ActiveLarkOwnerBindingsQuery,
  ActiveLarkOwnerBindingsSnapshot, ActiveLarkOwnerBindingsSnapshotErrorCode,
  ActiveWebOwnerBindingInspection, ActiveWebOwnerBindingQuery, ActiveWebOwnerBindingSnapshot,
  DeliveryOperatorFileIdentity, RevokedOwnerRouteQuery, RevokedOwnerRouteSnapshot,
} from './operator-snapshot.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantDeliveryService(ctx, config)
}

export default AssistantDeliveryService

export type { NativeWebOwnerAccess, NativeWebOwnerConfig } from './native-web-owner.js'

export type { WorkItemReportTarget, WorkItemReplySource, WorkItemReplyConsumerRegistration, WorkItemReplyReadInput, WorkItemReplyListInput } from './work-item-replies.js'
export { WorkItemReplyCancelledError } from './work-item-replies.js'
export { assessAttention, attentionAuditReasons, attentionWordCaps, countAttentionWords, defaultAttentionPurpose } from './attention.js'
export type { AttentionAssessment, AttentionAuditEntry, AttentionAuditReason, AttentionEnvelope, AttentionLane, AttentionLedgerView, AttentionPurpose, AttentionPurposeSource, AttentionQuestion, AttentionVerdict } from './attention.js'

export type { OwnerWorkItemLearningTask, OwnerLearningSourceExpectation, OwnerLearningSourceSnapshot, OwnerWorkItemLearningSourceExpectation, OwnerWorkItemLearningTaskFenceInput } from './work-item-feedback.js'

export type { EngineeringReportRef, EngineeringNode, EngineeringRootInput, EngineeringContinuationInput, WorkItemEngineeringMaterial, OwnerWorkItemEngineeringManifest, OwnerWorkItemEngineeringContextLocator, OwnerWorkItemEngineeringContextExpectation, OwnerWorkItemEngineeringContextReadInput, OwnerWorkItemEngineeringContextPage, OwnerWorkItemEngineeringContext, OwnerWorkItemEngineeringContextSource } from './work-item-engineering-context.js'
