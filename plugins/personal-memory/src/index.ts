import type { Context } from '@deepseek-ai/cordis'
import { Config, PersonalMemoryService } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-personal-memory'
export { Config, PersonalMemoryService, version }
export * from './types.js'
export { validateMemoryLearningAdoptionGrant } from './learning-adoptions.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new PersonalMemoryService(ctx, config)
}

export default PersonalMemoryService
