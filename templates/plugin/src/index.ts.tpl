import type { Context } from '@deepseek-ai/cordis'
import { version } from './version.js'

export const name = '{{PLUGIN_ID}}'
export { version }

export function apply(ctx: Context): void {
  ctx.logger.info('{{PLUGIN_TITLE}} plugin loaded')
}
