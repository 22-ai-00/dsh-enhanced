import type { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService, Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-automations'
export { AssistantAutomationsService, Config, version }
export type { PendingAutomationProposal, SystemAutomationReconcileInput } from './service.js'
export * from './types.js'
export { listActiveAutomationsLocally } from './operator.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantAutomationsService(ctx, config)
}

export default AssistantAutomationsService
