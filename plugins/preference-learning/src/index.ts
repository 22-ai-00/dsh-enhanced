import type { Context } from '@deepseek-ai/cordis'
import { Config, PreferenceLearningService } from './service.js'
import type { Config as ConfigType } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-preference-learning'
export const inject = ['assistantPolicy', 'systemPrompt']
export { Config, PreferenceLearningService, version }
export type { ConfigType as PreferenceLearningConfig }
export { PreferenceLearningError } from './service.js'
export * from './catalog.js'
export * from './types.js'

export function apply(ctx: Context, config: ConfigType): void {
  new PreferenceLearningService(ctx, config)
}

export default PreferenceLearningService
