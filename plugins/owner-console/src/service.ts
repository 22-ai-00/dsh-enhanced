import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OwnerConsoleStatus } from './typert.js'
import type { OwnerConsoleConfig } from './index.js'

/** Required companions: the console reports readiness instead of crashing. */
const DEPENDENCIES = ['assistantPolicy', 'assistantDelivery', 'assistantSkills', 'larkChannel'] as const

/** Read-only owner console façade. It never mutates another plugin. */
export class OwnerConsoleService extends TypertRemoteService {
  private readonly host: Context

  constructor(ctx: Context, private readonly config: OwnerConsoleConfig) {
    super(ctx, 'ownerConsole')
    this.host = ctx
  }

  status(): OwnerConsoleStatus {
    return Object.freeze({
      feishu: Object.freeze({
        mode: this.config.feishuMode,
        connected: this.host.get('larkChannel' as never, false) !== undefined,
        appIdConfigured: this.config.feishuAppId !== '',
      }),
      traex: Object.freeze({ enabled: this.config.enableTraex }),
      dependencies: Object.freeze(DEPENDENCIES.map(name => Object.freeze({
        name,
        available: this.host.get(name as never, false) !== undefined,
      }))),
    })
  }
}
