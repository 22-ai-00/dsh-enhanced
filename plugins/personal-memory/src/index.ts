import type { Context } from '@deepseek-ai/cordis'
import { PersonalMemoryService } from './service.js'
import type { Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-personal-memory'
export { PersonalMemoryService, version }
export type { Config }
export * from './types.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new PersonalMemoryService(ctx, config)
}

export default PersonalMemoryService
