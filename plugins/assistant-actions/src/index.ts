import type { Context } from '@deepseek-ai/cordis'
import { AssistantActionsService, Config } from './service.js'
import { validateConfig } from './config.js'
import { version } from './version.js'
export const name = 'dsh-enhanced-assistant-actions'
export const inject = ['assistantPolicy', 'assistantDelivery']
export { AssistantActionsService, Config, version }
export { validateConfig as validateActionConfig } from './config.js'
export type { BrokerConfig, EmbeddedBrokerConfig, ExternalUnixBrokerConfig, ValidatedConfig } from './config.js'
export type { BrokerGrantProjection } from './broker-protocol.js'
export type * from './types.js'
export function apply(ctx: Context, config: Config = {}): void {
  const validated = validateConfig(config)
  if (validated.broker.mode === 'external-unix-v1') {
    new AssistantActionsService(ctx, validated)
    return
  }
  // Keychain is required only by the legacy in-process executor.  Keep the
  // outer plugin pending-capable while the owned child service follows provider
  // appearance, unload and replacement.
  const bindEmbedded = (runtime: Context): void => { new AssistantActionsService(runtime, validated) }
  Object.defineProperty(bindEmbedded, 'name', { value: name })
  ctx.inject(['credentialsKeychain'], bindEmbedded)
}
// Loader unwraps the default export; preserve the trusted plugin identity there.
export default { name, Config, apply, inject }
