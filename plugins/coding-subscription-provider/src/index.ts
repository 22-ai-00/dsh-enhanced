import type { Context } from '@deepseek-ai/cordis'
import { registerLlmRouteCapability } from '@dsh-enhanced/llm-route-capabilities'
import {
  CodingSubscriptionAdapter,
  enabledRoutes,
  redactDiagnostic,
  type AdapterDependencies,
} from './adapter.js'
import { Config, normalizeConfig, type CodingSubscriptionProviderConfig } from './config.js'
import type { LiveSessionLookup } from './session-cwd.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-coding-subscription-provider'
export const inject = ['llm', 'sessions']

export { CodingSubscriptionAdapter, Config, version }
export type { CodingSubscriptionProviderConfig }

export function apply(ctx: Context, input?: CodingSubscriptionProviderConfig): void {
  const config = normalizeConfig(input)
  const routes = enabledRoutes(config)
  if (routes.length === 0) {
    ctx.logger.warn('dsh-enhanced-coding-subscription-provider: every provider is disabled')
    return
  }

  const adapter = new CodingSubscriptionAdapter(config, {
    // A local CLI must only run for a live, loop-owned session.  Do not derive
    // this from model-visible request data or the configured provider cwd.
    liveSessions: ctx.get('sessions') as LiveSessionLookup,
    // Attachments are optional and may load/unload after this plugin. Resolve
    // the service for each operation instead of retaining a stale instance.
    getAttachments: () => ctx.get('attachments') as AdapterDependencies['attachments'],
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
  const capabilityDisposers: Array<() => void> = []
  try {
    for (const provider of routes) {
      capabilityDisposers.push(registerLlmRouteCapability(ctx.llm, {
        provider,
        toolCalls: provider === 'codex-subscription' && config.codex.transport === 'direct-responses'
          ? 'native'
          : 'none',
      }))
    }
    ctx.llm.registerAdapter(routes, adapter)
  } catch (error) {
    for (const dispose of capabilityDisposers.reverse()) dispose()
    adapter.shutdown()
    throw error
  }
  ctx.effect(() => () => {
    for (const dispose of [...capabilityDisposers].reverse()) dispose()
    adapter.shutdown()
  }, 'dsh-enhanced-coding-subscription-provider.processes')
  ctx.logger.info(`Coding subscription providers registered: ${routes.join(', ')}`)
}
