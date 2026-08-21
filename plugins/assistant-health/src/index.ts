import type { Context } from '@deepseek-ai/cordis'
import { AssistantHealthService, Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-health'
export { AssistantHealthService, Config, version }
export * from './service.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantHealthService(ctx, config)
}

export default AssistantHealthService
