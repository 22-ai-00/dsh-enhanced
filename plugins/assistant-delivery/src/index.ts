import type { Context } from '@deepseek-ai/cordis'
import { AssistantDeliveryService, Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-delivery'
export { AssistantDeliveryService, Config, version }
export type { DeliveryInboundRuntime } from './service.js'
export * from './types.js'
export * from './operator.js'
export { externalPrincipalId } from './canonical.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantDeliveryService(ctx, config)
}

export default AssistantDeliveryService
