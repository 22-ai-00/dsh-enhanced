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
  /** Remote entry: guided `lark-cli` setup, or a directly supplied app id. */
  readonly feishuMode: 'lark-cli' | 'app'
  /** Feishu app id for the direct mode; the secret stays in the keychain. */
  readonly feishuAppId: string
  /** Enable the local TraeX ACP route card. */
  readonly enableTraex: boolean
}

export const Config: Schema<OwnerConsoleConfig> = Schema.object({
  feishuMode: Schema.union(['lark-cli', 'app']).default('lark-cli')
    .description('飞书接入方式：向导式 lark-cli，或直接填写 appId。'),
  feishuAppId: Schema.string().default('')
    .description('直接模式下可选的飞书 appId；appSecret 不进入配置。'),
  enableTraex: Schema.boolean().default(false)
    .description('在控制台展示本机 TraeX 路由入口。'),
})

export function apply(ctx: Context, input: OwnerConsoleConfig): void {
  const config = Config(input)
  new OwnerConsoleService(ctx, config)
  ctx.typert.register(TYPERT)
}
