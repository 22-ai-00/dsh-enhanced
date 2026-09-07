import type { Context } from '@deepseek-ai/cordis'
import { version } from './version.js'
import { AssistantIsolationService, Config } from './service.js'

export const name = 'dsh-enhanced-assistant-isolation'
export { version, AssistantIsolationService, Config }
export { isolationPrincipalDigest } from './service.js'
export type * from './types.js'

export function apply(ctx: Context, config: Config = {}): void { new AssistantIsolationService(ctx, config) }
export default AssistantIsolationService
