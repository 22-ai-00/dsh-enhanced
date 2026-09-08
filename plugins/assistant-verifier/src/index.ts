import type { Context } from '@deepseek-ai/cordis'
import { AssistantVerifierService, Config } from './service.js'
import type { AcceptanceObjectivesSelection, AcceptanceProfileInspection, AcceptanceProfileSelection } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-verifier'
export { AssistantVerifierService, Config, version }
export type { AcceptanceObjectivesSelection, AcceptanceProfileInspection, AcceptanceProfileSelection }
export * from './drivers.js'
export * from './host.js'
export * from './config.js'

export function apply(ctx: Context, config: Config): void {
  new AssistantVerifierService(ctx, config)
}

export default AssistantVerifierService
