import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelSummary, LlmRuntimeService } from './settings.js'
import type {
  ModelCatalogItem, ModelCatalogProvider, ModelReasoningEffortOption, OwnerConsoleModelCatalog, OwnerConsoleStatus,
} from './typert.js'

const DEFAULT_PROVIDER_TIMEOUT_MS = 6_000
const DEFAULT_ACP_PROVIDER_TIMEOUT_MS = 18_000
const DEFAULT_CACHE_TTL_MS = 30_000
const DEGRADED_CACHE_TTL_MS = 5_000
const MAX_PROVIDERS = 64
const MAX_MODELS = 200
const MAX_EFFORTS = 16
const MAX_DIAGNOSTIC_CHARS = 400
const MODEL_RESOLVE_BATCH_SIZE = 16

function clipText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= maxLen) return normalized
  return `${normalized.slice(0, Math.max(0, maxLen - 1))}…`
}

function isAcpProviderId(id: string): boolean {
  return id === 'traex-agent' || id === 'agy-agent'
}

function acpLabel(id: string): string {
  return id === 'agy-agent' ? 'Antigravity' : 'TraeX'
}

function freezeEffort(raw: { readonly id?: unknown; readonly name?: unknown; readonly description?: unknown }): ModelReasoningEffortOption | undefined {
  const id = clipText(raw.id, 128)
  if (id === '') return undefined
  const name = clipText(raw.name, 160) || id
  const description = clipText(raw.description, 300)
  return Object.freeze({
    id,
    name,
    ...(description === '' ? {} : { description }),
  })
}

function fallbackDefaultModelItem(providerId: string): ModelCatalogItem {
  const isAcp = isAcpProviderId(providerId)
  const label = isAcp ? `${acpLabel(providerId)} 默认当前模型 (default)` : 'default'
  return Object.freeze({
    id: 'default',
    name: label,
    efforts: Object.freeze([]),
  })
}

function fallbackCustomModelItem(modelId: string): ModelCatalogItem {
  const clipped = clipText(modelId, 256) || 'default'
  return Object.freeze({
    id: clipped,
    name: clipped,
    efforts: Object.freeze([]),
  })
}

function basicModelItem(model: LlmModelSummary): ModelCatalogItem | undefined {
  const id = clipText(model?.id, 256)
  if (id === '') return undefined
  const name = clipText(model?.name, 256) || id
  const description = clipText(model?.description, 400)
  return Object.freeze({
    id,
    name,
    ...(description === '' ? {} : { description }),
    efforts: Object.freeze([]),
  })
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`model catalog lookup timed out after ${timeoutMs}ms`)
      controller.abort(err)
      reject(err)
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function resolveSingleModelItem(
  llm: LlmRuntimeService,
  providerId: string,
  model: LlmModelSummary,
  deadline: number,
  now: () => number,
): Promise<ModelCatalogItem | undefined> {
  const id = clipText(model?.id, 256)
  if (id === '') return undefined
  const name = clipText(model?.name, 256) || id
  const description = clipText(model?.description, 400)
  let efforts: readonly ModelReasoningEffortOption[] = Object.freeze([])
  let defaultEffort = ''

  const remainingMs = deadline - now()
  if (typeof llm.resolveModelInfo === 'function' && remainingMs > 0) {
    try {
      const resolved = await withTimeout(
        signal => llm.resolveModelInfo!(providerId, id, signal),
        Math.min(remainingMs, 2_500),
      )
      const seenEfforts = new Set<string>()
      const collected: ModelReasoningEffortOption[] = []
      for (const rawEffort of resolved?.reasoning?.efforts ?? []) {
        const frozen = freezeEffort(rawEffort)
        if (frozen === undefined || seenEfforts.has(frozen.id)) continue
        seenEfforts.add(frozen.id)
        collected.push(frozen)
        if (collected.length >= MAX_EFFORTS) break
      }
      efforts = Object.freeze(collected)
      defaultEffort = clipText(resolved?.reasoning?.defaultEffort, 128)
    } catch {
      // Leave efforts empty when resolveModelInfo rejects or times out; model remains selectable.
    }
  }

  return Object.freeze({
    id,
    name,
    ...(description === '' ? {} : { description }),
    efforts,
    ...(defaultEffort === '' ? {} : { defaultEffort }),
  })
}

async function resolveProviderCatalog(
  llm: LlmRuntimeService,
  provider: Readonly<{ id: string; name?: string }>,
  status: OwnerConsoleStatus,
  timeoutMs: number,
  now: () => number,
): Promise<ModelCatalogProvider> {
  const id = clipText(provider.id, 200)
  const name = clipText(provider.name, 200) || id
  const kind: 'acp' | 'api' = isAcpProviderId(id) ? 'acp' : 'api'
  const models: ModelCatalogItem[] = []
  const seenModelIds = new Set<string>()
  const deadline = now() + timeoutMs
  let diagnostic = ''

  if (typeof llm.listModels === 'function') {
    try {
      const rawModels = await withTimeout(() => llm.listModels!(id), Math.max(1, deadline - now()))
      const uniqueInputs: LlmModelSummary[] = []
      for (const candidate of Array.isArray(rawModels) ? rawModels : []) {
        const modelId = clipText(candidate?.id, 256)
        if (modelId === '' || seenModelIds.has(modelId)) continue
        seenModelIds.add(modelId)
        uniqueInputs.push(candidate)
        if (uniqueInputs.length >= MAX_MODELS) break
      }

      for (let i = 0; i < uniqueInputs.length; i += MODEL_RESOLVE_BATCH_SIZE) {
        const batch = uniqueInputs.slice(i, i + MODEL_RESOLVE_BATCH_SIZE)
        if (deadline - now() <= 0) {
          for (const candidate of batch) {
            const item = basicModelItem(candidate)
            if (item !== undefined) models.push(item)
          }
          continue
        }
        const settled = await Promise.all(
          batch.map(item => resolveSingleModelItem(llm, id, item, deadline, now)),
        )
        for (const item of settled) {
          if (item !== undefined) models.push(item)
        }
      }
    } catch (error: unknown) {
      diagnostic = clipText(error instanceof Error ? error.message : String(error), MAX_DIAGNOSTIC_CHARS)
    }
  }

  if (kind === 'acp' && !seenModelIds.has('default') && models.length < MAX_MODELS) {
    seenModelIds.add('default')
    models.unshift(fallbackDefaultModelItem(id))
  }
  if (clipText(status.defaultModel.provider, 200) === id && status.defaultModel.model !== '') {
    const defId = clipText(status.defaultModel.model, 256)
    if (defId !== '' && !seenModelIds.has(defId) && models.length < MAX_MODELS) {
      seenModelIds.add(defId)
      models.push(fallbackCustomModelItem(defId))
    }
  }

  return Object.freeze({
    id,
    name,
    kind,
    active: true,
    models: Object.freeze(models),
    ...(diagnostic === '' ? {} : { diagnostic }),
  })
}

export interface ReadModelCatalogOptions {
  readonly now?: () => number
  readonly providerTimeoutMs?: number
}

/** Read available providers, advertised models, and reasoning efforts from Host `ctx.llm`. */
export async function readOwnerConsoleModelCatalog(
  host: Context,
  status: OwnerConsoleStatus,
  options: ReadModelCatalogOptions = {},
): Promise<OwnerConsoleModelCatalog> {
  const now = options.now ?? Date.now
  const explicitTimeoutMs = options.providerTimeoutMs
  const timeoutForProvider = (providerId: string): number =>
    explicitTimeoutMs ?? (isAcpProviderId(providerId) ? DEFAULT_ACP_PROVIDER_TIMEOUT_MS : DEFAULT_PROVIDER_TIMEOUT_MS)
  const llm = host.get('llm' as never) as LlmRuntimeService | undefined

  const activeProviders: Array<{ id: string; name?: string }> = []
  const seenProviders = new Set<string>()
  try {
    for (const row of llm?.listProviders?.() ?? []) {
      const id = clipText(row?.id, 200)
      if (id === '' || seenProviders.has(id)) continue
      seenProviders.add(id)
      activeProviders.push({ id, ...(row.name === undefined ? {} : { name: row.name }) })
      if (activeProviders.length >= MAX_PROVIDERS) break
    }
  } catch {
    // Ignore failing listProviders; fallback entries still build cleanly below.
  }

  const providers: ModelCatalogProvider[] = llm !== undefined
    ? await Promise.all(activeProviders.map(p => resolveProviderCatalog(llm, p, status, timeoutForProvider(p.id), now)))
    : []

  const defaultProvider = clipText(status.defaultModel.provider, 200)
  const defaultModelId = clipText(status.defaultModel.model, 256)
  const presentIds = new Set(providers.map(p => p.id))
  const addDormant = (id: string, name: string, diagnostic?: string) => {
    if (presentIds.has(id) || providers.length >= MAX_PROVIDERS) return
    presentIds.add(id)
    const kind: 'acp' | 'api' = isAcpProviderId(id) ? 'acp' : 'api'
    const fallbackItems: ModelCatalogItem[] = []
    const seenFallbackIds = new Set<string>()
    const pushFallback = (item: ModelCatalogItem) => {
      if (seenFallbackIds.has(item.id)) return
      seenFallbackIds.add(item.id)
      fallbackItems.push(item)
    }
    if (kind === 'acp') {
      pushFallback(fallbackDefaultModelItem(id))
    } else {
      const primaryModel = defaultProvider === id ? defaultModelId : ''
      pushFallback(fallbackCustomModelItem(primaryModel || 'default'))
    }
    if (defaultProvider === id && defaultModelId !== '') {
      pushFallback(fallbackCustomModelItem(defaultModelId))
    }
    const cleanDiag = clipText(diagnostic, MAX_DIAGNOSTIC_CHARS)
    providers.push(Object.freeze({
      id,
      name: clipText(name, 200) || id,
      kind,
      active: false,
      models: Object.freeze(fallbackItems),
      ...(cleanDiag === '' ? {} : { diagnostic: cleanDiag }),
    }))
  }

  let configurable: readonly { provider?: string; displayName?: string }[] = []
  try {
    configurable = llm?.listConfigurableProviders?.() ?? []
  } catch {
    configurable = []
  }

  for (const entry of configurable) {
    const id = clipText(entry?.provider, 200)
    if (id === '' || !isAcpProviderId(id)) continue
    addDormant(
      id,
      clipText(entry?.displayName, 200) || (id === 'traex-agent' ? 'TraeX ACP' : 'Antigravity ACP'),
      '路由当前未启用；设为默认或启用后自动激活',
    )
  }

  if (status.traex.installed) {
    addDormant('traex-agent', 'TraeX ACP', status.traex.enabled ? undefined : 'TraeX ACP 路由未启用；选用时自动启用')
  }
  if (status.agy.installed) {
    addDormant('agy-agent', 'Antigravity ACP', status.agy.enabled ? undefined : 'Antigravity ACP 路由未启用；选用时自动启用')
  }

  if (defaultProvider !== '' && !presentIds.has(defaultProvider)) {
    addDormant(defaultProvider, defaultProvider, '当前默认路由尚未向 Host 注册活动适配器')
  }

  const defaultEffort = clipText(status.defaultModel.reasoningEffort, 128)

  return Object.freeze({
    protocol: 'owner-console/model-catalog/v1',
    fetchedAt: Math.max(0, Math.trunc(now())),
    defaultSelection: Object.freeze({
      provider: defaultProvider,
      model: defaultModelId,
      ...(defaultEffort === '' ? {} : { reasoningEffort: defaultEffort }),
    }),
    providers: Object.freeze(providers),
  })
}

/** Bounded TTL-cached reader for `ownerConsole/modelCatalog` with mutation invalidation. */
export class ModelCatalogReader {
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private readonly providerTimeoutMs: number | undefined
  private generation = 0
  private cached: Readonly<{ expiresAt: number; value: OwnerConsoleModelCatalog }> | undefined
  private inFlight: Promise<OwnerConsoleModelCatalog> | undefined

  constructor(options: { now?: () => number; cacheTtlMs?: number; providerTimeoutMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.providerTimeoutMs = options.providerTimeoutMs
  }

  invalidate(): void {
    this.generation += 1
    this.cached = undefined
    this.inFlight = undefined
  }

  async read(host: Context, status: OwnerConsoleStatus, force = false): Promise<OwnerConsoleModelCatalog> {
    const ts = this.now()
    if (!force && this.cached !== undefined && ts < this.cached.expiresAt) {
      return this.cached.value
    }
    if (!force && this.inFlight !== undefined) {
      return this.inFlight
    }
    if (force) {
      this.generation += 1
      this.cached = undefined
    }
    const generation = this.generation
    const promise = readOwnerConsoleModelCatalog(host, status, {
      now: this.now,
      ...(this.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: this.providerTimeoutMs }),
    }).then(result => {
      if (this.generation === generation) {
        const hasDiagnostic = result.providers.some(provider => provider.diagnostic !== undefined)
        const ttlMs = hasDiagnostic ? Math.min(this.cacheTtlMs, DEGRADED_CACHE_TTL_MS) : this.cacheTtlMs
        this.cached = { expiresAt: this.now() + ttlMs, value: result }
      }
      return result
    })
    this.inFlight = promise
    try {
      return await promise
    } finally {
      if (this.inFlight === promise) this.inFlight = undefined
    }
  }
}
