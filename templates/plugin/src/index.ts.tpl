import type { Context } from '@deepseek-ai/cordis'

export const name = '{{PLUGIN_ID}}'

export function apply(ctx: Context): void {
  ctx.logger.info('{{PLUGIN_TITLE}} plugin loaded')
}
