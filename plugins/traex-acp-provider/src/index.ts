import type { Context } from '@deepseek-ai/cordis'
import { redactDiagnostic, TRAEX_PROVIDER_ROUTE, TraexAcpAdapter } from './adapter.js'
import { Config, normalizeConfig, type TraexAcpProviderConfig } from './config.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-traex-acp-provider'
export const inject = ['llm']

export { Config, TRAEX_PROVIDER_ROUTE, TraexAcpAdapter, version }
export { CatalogObservationCache, catalogCacheKey } from './catalog-cache.js'
export { ACP_USAGE_DSH_MAPPING_GATE } from './acp-client.js'
export type { CatalogCacheKeyParts, CachedCatalog } from './catalog-cache.js'
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
    onSettled(context) {
      // Credential-free lifecycle facts only; useful for diagnosing which phase a turn settled in.
      const detail = `phase=${context.phase} submission=${context.promptSubmissionState}`
        + ` textForwarded=${context.assistantTextForwarded}`
        + (context.teardownState !== undefined ? ` teardown=${context.teardownState}` : '')
        + (context.terminalReason !== undefined ? ` terminal=${context.terminalReason}` : '')
        + (context.exitCode !== undefined ? ` exitCode=${String(context.exitCode)}` : '')
        + (context.signal !== undefined ? ` signal=${String(context.signal)}` : '')
        + (context.metrics !== undefined ? ` metrics=${JSON.stringify(context.metrics)}` : '')
        + (context.usage !== undefined ? ` usage=${JSON.stringify(context.usage)}` : '')
      if (context.outcome === 'ok') ctx.logger.debug(`${TRAEX_PROVIDER_ROUTE} settled ok (${detail})`)
      else ctx.logger.info(`${TRAEX_PROVIDER_ROUTE} settled ${context.outcome} (${detail})`)
    },
    onCatalogObserved(observation) {
      // Non-authoritative and diagnostic-only. ACP model ids are not length- or
      // control-char-bounded, so only the count is logged; raw ids are never emitted.
      ctx.logger.debug(`${TRAEX_PROVIDER_ROUTE} observed ${observation.modelValues.length} model(s)`)
    },
  })
  ctx.llm.registerAdapter([TRAEX_PROVIDER_ROUTE], adapter)
  ctx.effect(() => () => adapter.shutdown(), 'dsh-enhanced-traex-acp-provider.processes')
  ctx.logger.info(`TraeX ACP provider registered: ${TRAEX_PROVIDER_ROUTE}`)
}
