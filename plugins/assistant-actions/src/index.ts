import type { Context } from '@deepseek-ai/cordis'
import { AssistantActionsService, Config } from './service.js'
import { version } from './version.js'
export const name = 'dsh-enhanced-assistant-actions'
export const inject = ['assistantPolicy', 'credentialsKeychain', 'assistantDelivery']
export { AssistantActionsService, Config, version }
export type * from './types.js'
export function apply(ctx: Context, config: Config = {}): void { new AssistantActionsService(ctx, config) }
export default AssistantActionsService
