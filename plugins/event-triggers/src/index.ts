import type { Context } from '@deepseek-ai/cordis'
import { EventTriggersService, Config } from './service.js'
import { normalizeEventTriggersConfig } from './config.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-event-triggers'
export { Config, EventTriggersService, version }
export * from './config.js'
export * from './service.js'

export function apply(ctx: Context, config: import('./config.js').Config): void {
  const normalized = normalizeEventTriggersConfig(config)
  if (normalized.triggers.some(trigger => trigger.kind === 'webhook')) {
    ctx.inject(['credentialsKeychain'], (credentialsCtx) => {
      new EventTriggersService(credentialsCtx, config)
    })
    return
  }
  new EventTriggersService(ctx, config)
}

export default EventTriggersService
