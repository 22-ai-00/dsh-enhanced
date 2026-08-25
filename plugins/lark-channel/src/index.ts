import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import { LarkChannelService } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-lark-channel'
export const inject = ['assistantDelivery']
export { Config, LarkChannelService, version }
export * from './types.js'
export { LarkDeliveryAdapter } from './adapter.js'
export * from './approval.js'
export * from './setup-profile.js'
export * from './supervised-growth-profile.js'
export * from './launchd.js'
export * from './resident.js'
export * from './systemd.js'
export * from './windows-task.js'
export {
  createKeychainWriteRequest,
  createLarkRegistrationOptions,
  createSecretServiceWriteRequest,
  createWindowsDpapiWriteRequest,
  credentialProviderForPlatform,
  isMainEntry,
  matchOwnerHandshake,
  parseLarkSetupArgs,
  runLarkSetup,
} from './setup.js'
export {
  assertSupervisedGrowthAutomationGuard,
  commitSupervisedGrowthPatch,
  parseSupervisedGrowthSetupArgs,
  runSupervisedGrowthSetup,
  selectUniqueOwnerBinding,
} from './supervised-growth-setup.js'

export function apply(ctx: Context, config: import('./config.js').Config): void {
  const normalized = Config(config)
  if (normalized.enabled && normalized.credentialHandle !== undefined) {
    ctx.inject(['credentialsKeychain'], (credentialsCtx) => {
      new LarkChannelService(credentialsCtx, normalized)
    })
    return
  }
  new LarkChannelService(ctx, normalized)
}

const plugin = { name, inject, Config, apply }

export default plugin
