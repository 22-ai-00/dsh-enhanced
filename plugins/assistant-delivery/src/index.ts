import type { Context } from '@deepseek-ai/cordis'
import { DeliveryAdapterRegistryStoppedError } from './coordinator.js'
import { AssistantDeliveryService, Config, isTrustedDeliveryPreferenceProducer } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-delivery'
export { AssistantDeliveryService, Config, DeliveryAdapterRegistryStoppedError, isTrustedDeliveryPreferenceProducer, version }
export type { DeliveryInboundRuntime } from './service.js'
export type { DeliveryGoalWakeInput, DeliveryGoalWakeResult } from './goal-wake-types.js'
export * from './types.js'
export * from './operator.js'
export * from './learning-command.js'
export { externalPrincipalId, ownerRouteAuthorityHash } from './canonical.js'
export { inspectActiveWebOwnerBindingLocally, listActiveIdleWebOwnerBindingsLocally } from './operator-snapshot.js'
export type { ActiveIdleWebOwnerBindingsInspection, ActiveWebOwnerBindingInspection, ActiveWebOwnerBindingQuery, ActiveWebOwnerBindingSnapshot } from './operator-snapshot.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantDeliveryService(ctx, config)
}

export default AssistantDeliveryService

export type { NativeWebOwnerAccess, NativeWebOwnerConfig } from './native-web-owner.js'
