import type { Context } from '@deepseek-ai/cordis'
import { redactDiagnostic, TRAEX_PROVIDER_ROUTE, TraexAcpAdapter } from './adapter.js'
import { Config, normalizeConfig, type TraexAcpProviderConfig } from './config.js'

export const name = 'dsh-enhanced-traex-acp-provider'
export const version = '0.1.0'
export const inject = ['llm']

export { Config, TRAEX_PROVIDER_ROUTE, TraexAcpAdapter }
export type { TraexAcpProviderConfig }

export function apply(ctx: Context, input?: TraexAcpProviderConfig): void {
  const config = normalizeConfig(input)
  if (!config.enabled) {
    ctx.logger.warn('dsh-enhanced-traex-acp-provider: disabled until config.enabled is true')
    return
  }
  const adapter = new TraexAcpAdapter(config, {
    onDiagnostic(diagnostic) {
      if (config.logDiagnostics) {
        ctx.logger.warn(`${TRAEX_PROVIDER_ROUTE} diagnostic: ${redactDiagnostic(diagnostic)}`)
      } else {
        ctx.logger.warn(`${TRAEX_PROVIDER_ROUTE} wrote to stderr; content withheld (set logDiagnostics to inspect a redacted tail)`)
      }
    },
  })
  ctx.llm.registerAdapter([TRAEX_PROVIDER_ROUTE], adapter)
  ctx.effect(() => () => adapter.shutdown(), 'dsh-enhanced-traex-acp-provider.processes')
  ctx.logger.info(`TraeX ACP provider registered: ${TRAEX_PROVIDER_ROUTE}`)
}
