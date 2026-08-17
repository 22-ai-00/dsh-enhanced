import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-enhanced-hello'
export const helloMessage = 'dsh-enhanced hello plugin loaded'

export function apply(ctx: Context): void {
  ctx.logger.info(helloMessage)
}
