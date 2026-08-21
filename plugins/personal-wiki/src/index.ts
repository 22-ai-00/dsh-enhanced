import type { Context } from '@deepseek-ai/cordis'
import { PersonalWikiService } from './service.js'
import type { Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-personal-wiki'
export { PersonalWikiService, version }
export type { Config }
export type * from './types.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new PersonalWikiService(ctx, config)
}

export default PersonalWikiService
