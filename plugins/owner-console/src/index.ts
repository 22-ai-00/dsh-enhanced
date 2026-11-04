import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { version } from './version.js'
import { OwnerConsoleService } from './service.js'
import { TYPERT } from './typert.js'

export const name = 'dsh-enhanced-owner-console'
export { version }

/** The console only reads Host state in this slice; no peer service is required. */
export const inject = ['typert']

export interface OwnerConsoleConfig {
  /** Optional default Feishu app id used only as a fallback when the panel cannot
   * discover one from the Host environment; the panel always configures the
   * lark-channel connector entry, never a lark-cli binary. */
  readonly feishuAppId: string
}

export const Config: Schema<OwnerConsoleConfig> = Schema.object({
  feishuAppId: Schema.string().default('')
    .description('可选的默认飞书 appId；仅作为一键探测的回退值。appSecret 不进入配置。'),
})

export function apply(ctx: Context, input: OwnerConsoleConfig): void {
  const config = Config(input)
  new OwnerConsoleService(ctx, config)
  ctx.typert.register(TYPERT)
}
