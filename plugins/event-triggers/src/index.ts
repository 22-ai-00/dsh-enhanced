import type { Context } from '@deepseek-ai/cordis'
import { EventTriggersService, Config } from './service.js'
import { normalizeEventTriggersConfig } from './config.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-event-triggers'
export { Config, EventTriggersService, version }
export * from './config.js'
export * from './service.js'
export * from './source.js'
export * from './observer.js'
export * from './lark-calendar-sensor.js'

export function apply(ctx: Context, config: import('./config.js').Config): void {
  const normalized = normalizeEventTriggersConfig(config)
  const dependencies: string[] = []
  if (normalized.triggers.some(trigger => trigger.kind === 'webhook' || trigger.kind === 'github-repository')) dependencies.push('credentialsKeychain')
  if (normalized.triggers.some(trigger => trigger.kind === 'lark-calendar')) dependencies.push('larkChannel')
  if (normalized.triggers.some(trigger => trigger.observer !== undefined)) dependencies.push('assistantDelivery')
  if (dependencies.length) {
    ctx.inject(dependencies as never, (credentialsCtx) => {
      new EventTriggersService(credentialsCtx, config)
    })
    return
  }
  new EventTriggersService(ctx, config)
}

// DSH unwraps default exports. Keep the consumer identity and conditional
// credential/owner-route injection on the object actually mounted by it.
export default { name, Config, apply }
