import type { Context } from '@deepseek-ai/cordis'
import type { LlmConfigurableProvider, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createAgentLoopRequestAttestor, registerLlmRouteCapability } from '@dsh-enhanced/llm-route-capabilities'
import {
  ACP_PROVIDER_ROUTES,
  AGY_PROVIDER_ROUTE,
  probeAcpReadiness,
  probeTraexReadiness,
  redactDiagnostic,
  TRAEX_PROVIDER_ROUTE,
  TraexAcpAdapter,
  type AcpProviderRoute,
  type AcpReadinessProbeOptions,
  type TraexReadinessProbeOptions,
} from './adapter.js'
import { buildAgyArgs, SAFE_TRAEX_ARGS, type AcpBackend } from './acp-client.js'
import {
  AGY_MAX_PROMPT_BYTES_CEILING,
  Config,
  DEFAULT_AGY_CONTEXT_WINDOW,
  DEFAULT_AGY_MAX_PROMPT_BYTES,
  normalizeConfig,
  type AcpCwdMode,
  type AgySessionMode,
  type TraexAcpProviderConfig,
} from './config.js'
import type { LiveSessionLookup } from './session-cwd.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-traex-acp-provider'
export const inject = ['llm', 'sessions', 'agents']

export {
  ACP_PROVIDER_ROUTES,
  AGY_MAX_PROMPT_BYTES_CEILING,
  AGY_PROVIDER_ROUTE,
  buildAgyArgs,
  Config,
  DEFAULT_AGY_CONTEXT_WINDOW,
  DEFAULT_AGY_MAX_PROMPT_BYTES,
  normalizeConfig,
  probeAcpReadiness,
  probeTraexReadiness,
  SAFE_TRAEX_ARGS,
  TRAEX_PROVIDER_ROUTE,
  TraexAcpAdapter,
  version,
}
export { CatalogObservationCache, catalogCacheKey } from './catalog-cache.js'
export { ACP_USAGE_DSH_MAPPING_GATE } from './acp-client.js'
export type { CatalogCacheKeyParts, CachedCatalog } from './catalog-cache.js'
export type { AcpBackend, AcpCwdMode, AcpProviderRoute, AcpReadinessProbeOptions, AgySessionMode, TraexReadinessProbeOptions, TraexAcpProviderConfig }

function registerConfigurableRoutes(ctx: Context, llm: LlmRuntime): (() => void) | undefined {
  const register = (llm as { registerConfigurableProviders?: (entries: readonly LlmConfigurableProvider[]) => () => void })
    .registerConfigurableProviders
  if (typeof register !== 'function') return undefined
  try {
    return register.call(llm, [
      {
        provider: TRAEX_PROVIDER_ROUTE,
        displayName: 'TraeX Agent (local ACP)',
        settingsNs: name,
        settingsPath: [],
        declared: false,
        nativeAuth: { env: [], oauth: true },
      },
      {
        provider: AGY_PROVIDER_ROUTE,
        displayName: 'Antigravity Agent (local ACP)',
        settingsNs: name,
        settingsPath: [],
        declared: false,
        nativeAuth: { env: [], oauth: true },
      },
    ])
  } catch (error) {
    // Directory advertisement is advisory for settings surfaces; never block adapter startup.
    ctx.logger.debug(`${name}: skipped configurable provider registration (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}

export function apply(ctx: Context, input?: TraexAcpProviderConfig): void {
  const config = normalizeConfig(input)
  const disposeConfigurable = registerConfigurableRoutes(ctx, ctx.llm)

  const routes: AcpProviderRoute[] = []
  if (config.enabled) routes.push(TRAEX_PROVIDER_ROUTE)
  if (config.agyEnabled) routes.push(AGY_PROVIDER_ROUTE)

  if (routes.length === 0) {
    if (disposeConfigurable !== undefined) {
      ctx.effect(() => () => { disposeConfigurable() }, 'dsh-enhanced-traex-acp-provider.directory')
    }
    ctx.logger.warn('dsh-enhanced-traex-acp-provider: disabled until config.enabled or config.agyEnabled is true')
    return
  }

  const requestAttestor = createAgentLoopRequestAttestor(ctx.agents, routes, reference => ctx.llm.fileRequestText(reference))
  const adapter = new TraexAcpAdapter(config, {
    // A local ACP subprocess must be bound to a live loop session, never a
    // prompt-selected or static workspace path.
    liveSessions: ctx.get('sessions') as LiveSessionLookup,
    requestAttestor,
    onDiagnostic(diagnostic) {
      if (config.logDiagnostics) {
        ctx.logger.warn(`${name} diagnostic: ${redactDiagnostic(diagnostic)}`)
      } else {
        ctx.logger.warn(`${name} wrote to stderr; content withheld (set logDiagnostics to inspect a redacted tail)`)
      }
    },
    onSettled(context) {
      const routeLabel = context.provider ?? TRAEX_PROVIDER_ROUTE
      // Credential-free lifecycle facts only; useful for diagnosing which phase a turn settled in.
      const detail = `phase=${context.phase} submission=${context.promptSubmissionState}`
        + ` textForwarded=${context.assistantTextForwarded}`
        + (context.teardownState !== undefined ? ` teardown=${context.teardownState}` : '')
        + (context.reasoningEffortFallback === true ? ' reasoningFallback=true' : '')
        + (context.terminalReason !== undefined ? ` terminal=${context.terminalReason}` : '')
        + (context.exitCode !== undefined ? ` exitCode=${String(context.exitCode)}` : '')
        + (context.signal !== undefined ? ` signal=${String(context.signal)}` : '')
        + (context.metrics !== undefined ? ` metrics=${JSON.stringify(context.metrics)}` : '')
        + (context.usage !== undefined ? ` usage=${JSON.stringify(context.usage)}` : '')
      if (context.outcome === 'ok') ctx.logger.debug(`${routeLabel} settled ok (${detail})`)
      else ctx.logger.info(`${routeLabel} settled ${context.outcome} (${detail})`)
    },
    onCatalogObserved(observation) {
      // Non-authoritative and diagnostic-only. ACP model ids are not length- or
      // control-char-bounded, so only the count is logged; raw ids are never emitted.
      ctx.logger.debug(`${name} observed ${observation.modelValues.length} model(s)`)
    },
  })

  const capabilityDisposers: Array<() => void> = []
  const disposeAll = (): void => {
    for (const dispose of [...capabilityDisposers].reverse()) dispose()
    disposeConfigurable?.()
    adapter.shutdown()
  }
  try {
    for (const provider of routes) {
      capabilityDisposers.push(registerLlmRouteCapability(ctx.llm, {
        provider,
        toolCalls: 'bridge',
      }))
    }
    ctx.llm.registerAdapter(routes, adapter)
  } catch (error) {
    disposeAll()
    throw error
  }
  ctx.effect(() => disposeAll, 'dsh-enhanced-traex-acp-provider.processes')
  ctx.logger.info(`Local ACP providers registered: ${routes.join(', ')}`)
}
