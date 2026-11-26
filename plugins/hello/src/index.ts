import type { Context } from '@deepseek-ai/cordis'
import { version } from './version.js'

export const name = 'dsh-ray-hello'
export const helloMessage = 'dsh-ray hello plugin loaded'
export { version }

export function apply(ctx: Context): void {
  ctx.logger.info(helloMessage)
}
