import type { Context } from '@deepseek-ai/cordis'
import { AssistantHeartbeatService, Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-heartbeat'
export { AssistantHeartbeatService, Config, version }
export * from './config.js'
export * from './service.js'

export function apply(ctx: Context, config: import('./config.js').Config): void {
  new AssistantHeartbeatService(ctx, config)
}

export default AssistantHeartbeatService
