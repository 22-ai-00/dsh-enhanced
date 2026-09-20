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
export type { ForegroundTaskIdentity, ForegroundTaskObservationRegistration } from './foreground-observation.js'
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
  ActiveLarkOwnerBindingsSnapshotError, activeLarkOwnerBindingsSnapshotProtocol,
  inspectActiveLarkOwnerBindingsLocally, inspectActiveWebOwnerBindingLocally,
  listActiveIdleWebOwnerBindingsLocally,
} from './operator-snapshot.js'
export type {
  ActiveIdleWebOwnerBindingsInspection, ActiveLarkOwnerBinding, ActiveLarkOwnerBindingsQuery,
  ActiveLarkOwnerBindingsSnapshot, ActiveLarkOwnerBindingsSnapshotErrorCode,
  ActiveWebOwnerBindingInspection, ActiveWebOwnerBindingQuery, ActiveWebOwnerBindingSnapshot,
  DeliveryOperatorFileIdentity,
} from './operator-snapshot.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantDeliveryService(ctx, config)
}

export default AssistantDeliveryService

export type { NativeWebOwnerAccess, NativeWebOwnerConfig } from './native-web-owner.js'
