import type { Context } from '@deepseek-ai/cordis'
import { CodingSubscriptionAdapter, enabledRoutes, redactDiagnostic } from './adapter.js'
import { Config, normalizeConfig, type CodingSubscriptionProviderConfig } from './config.js'

export const name = 'dsh-enhanced-coding-subscription-provider'
export const version = '0.1.0'
export const inject = ['llm']

export { CodingSubscriptionAdapter, Config }
export type { CodingSubscriptionProviderConfig }

export function apply(ctx: Context, input?: CodingSubscriptionProviderConfig): void {
  const config = normalizeConfig(input)
  const routes = enabledRoutes(config)
  if (routes.length === 0) {
    ctx.logger.warn('dsh-enhanced-coding-subscription-provider: every provider is disabled')
    return
  }

  const adapter = new CodingSubscriptionAdapter(config, {
    onDiagnostic(route, diagnostic) {
      if (config.logDiagnostics) {
        ctx.logger.warn(`${route} CLI diagnostic: ${redactDiagnostic(diagnostic)}`)
      } else {
        ctx.logger.warn(`${route} CLI wrote to stderr; content withheld (set logDiagnostics to inspect a redacted tail)`)
      }
    },
    onSettled(context) {
      // Credential-free lifecycle facts only; useful for diagnosing which phase a route settled in.
      const detail = `phase=${context.phase} submission=${context.promptSubmissionState}`
        + ` textForwarded=${context.assistantTextForwarded} teardown=${context.teardownState}`
        + (context.exitCode !== undefined ? ` exit=${context.exitCode ?? 'null'}` : '')
        + (context.signal != null ? ` signal=${context.signal}` : '')
        + (context.metrics !== undefined ? ` metrics=${JSON.stringify(context.metrics)}` : '')
      if (context.outcome === 'ok') ctx.logger.debug(`${context.route} settled ok (${detail})`)
      else ctx.logger.info(`${context.route} settled ${context.outcome} (${detail})`)
    },
  })
  ctx.llm.registerAdapter(routes, adapter)
  ctx.effect(() => () => adapter.shutdown(), 'dsh-enhanced-coding-subscription-provider.processes')
  ctx.logger.info(`Coding subscription providers registered: ${routes.join(', ')}`)
}
