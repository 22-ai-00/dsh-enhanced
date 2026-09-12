import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import { CredentialLeaseAbortError, CredentialsKeychainService } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-credentials-keychain'
export const inject = ['assistantPolicy']
export { supportedCredentialProviders } from './capabilities.js'
export { Config, CredentialLeaseAbortError, CredentialsKeychainService, version }
export type { CredentialLeaseAbortCode } from './service.js'
export * from './types.js'

export function apply(ctx: Context, config: import('./config.js').Config): void {
  new CredentialsKeychainService(ctx, config)
}

// Loader unwraps the module default before Cordis reads plugin metadata. Keep
// the required Policy injection on that exact mounted value so the Keychain
// remains pending, and is unloaded/reloaded, with its provider generation.
export default { name, Config, inject, apply }
