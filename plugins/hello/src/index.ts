import type { Context } from '@deepseek-ai/cordis'
import { version } from './version.js'

export const name = 'dsh-enhanced-hello'
export const helloMessage = 'dsh-enhanced hello plugin loaded'
export { version }

export function apply(ctx: Context): void {
  ctx.logger.info(helloMessage)
}
