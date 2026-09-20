import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/**
 * The growth driver is opt-in and fail-closed: it never runs until `enabled`
 * is explicitly true and a concrete owner scope is declared. Model selection
 * follows the owner's conversation unless an explicit fixed pair overrides it.
 */

export const DEFAULT_API_KEY_ENV = 'SUPER_RELAY_API_KEY' as const

export interface GrowthOwnerScopeConfig {
  workspace: string
  preset: string
  principalId: string
  ownerRouteId: string
}

/**
 * The owner-anchored workflow bridge is a second, independently switched
 * learning track inside the wake. It is opt-in and fail-closed even when the
 * driver itself is enabled: it never proposes, approves, activates or installs
 * anything, it only asks Delivery to re-verify and record paused candidates.
 */
export interface WorkflowOwnerAnchoredConfig {
  enabled?: boolean
  /** Hard cap on commit attempts in one wake (rate limit); idempotent replays are cheap. */
  maxCommitsPerWake?: number
  /** Only consider owner goals last updated inside this lookback horizon (TTL). */
  lookbackMs?: number
}

/**
 * The plugin source-proposal track is the third, independently switched growth
 * capability. It is opt-in and fail-closed even when the driver itself is
 * enabled: the growth agent may then prepare PENDING modify source plans in
 * isolated worktrees, but it can never approve, sign, release, activate,
 * install or reload anything. Every build-shaping value (repository path,
 * timeouts, TTL, offline flag) is frozen owner configuration — the model can
 * never supply a repository, worktree, base commit or environment.
 */
export interface PluginSourceProposalsConfig {
  enabled?: boolean
  /** Inline builds during the model wake; durable queues Host-owned work. */
  preparationMode?: 'inline' | 'durable'
  /** Canonical absolute path of the dsh-enhanced repository the patches target. Required when enabled. */
  repository?: string
  /** Hard cap on prepared modify plans in one wake (rate limit); idempotent replays are cheap. */
  maxPlansPerWake?: number
  /** Per-command bounded timeout for the frozen install/check/pack gate. */
  isolatedBuildTimeoutMs?: number
  /** Run pnpm install fully offline (the owner must warm the store beforehand). */
  offline?: boolean
  /** Pending-plan TTL: how long the isolated worktree waits for owner action. */
  planTtlMs?: number
}

export interface AssistantGrowthDriverConfig {
  enabled?: boolean
  /** 0 = no periodic wake; the driver only runs when explicitly triggered. */
  intervalMs?: number
  maxReviewsPerWake?: number
  minRepeatedSuccesses?: number
  candidateTtlMs?: number
  maxModelCalls?: number
  maxToolCalls?: number
  maxOutputTokens?: number
  maxDurationMs?: number
  /** Omit both to inherit the owner conversation; specify both for a fixed route. */
  provider?: string
  model?: string
  /** Optional effort for an explicitly configured fixed route. */
  reasoningEffort?: string
  /** Optional policy budget id; when unset no budget reservation is made. */
  budgetId?: string
  /** Reserved amount in the owner-configured budget metric; required when budgetId is set. */
  budgetAmount?: number
  /** Credential reference only; never a literal API key. */
  apiKeyEnv?: string
  scope?: GrowthOwnerScopeConfig
  workflowOwnerAnchored?: WorkflowOwnerAnchoredConfig
  pluginSourceProposals?: PluginSourceProposalsConfig
}

export interface NormalizedWorkflowOwnerAnchoredConfig {
  readonly enabled: boolean
  readonly maxCommitsPerWake: number
  readonly lookbackMs: number
}

export interface NormalizedPluginSourceProposalsConfig {
  readonly enabled: boolean
  readonly preparationMode: 'inline' | 'durable'
  readonly repository: string | null
  readonly maxPlansPerWake: number
  readonly isolatedBuildTimeoutMs: number
  readonly offline: boolean
  readonly planTtlMs: number
}

export interface NormalizedGrowthDriverConfig extends Required<Omit<AssistantGrowthDriverConfig, 'provider' | 'model' | 'reasoningEffort' | 'apiKeyEnv' | 'budgetId' | 'budgetAmount' | 'scope' | 'workflowOwnerAnchored' | 'pluginSourceProposals'>> {
  readonly provider: string | null
  readonly model: string | null
  readonly reasoningEffort: string | null
  readonly apiKeyEnv: string | null
  readonly budgetId: string | null
  readonly budgetAmount: number | null
  readonly scope: GrowthOwnerScopeConfig | null
  readonly workflowOwnerAnchored: NormalizedWorkflowOwnerAnchoredConfig
  readonly pluginSourceProposals: NormalizedPluginSourceProposalsConfig
}

const fields = new Set([
  'enabled',
  'intervalMs',
  'maxReviewsPerWake',
  'minRepeatedSuccesses',
  'candidateTtlMs',
  'maxModelCalls',
  'maxToolCalls',
  'maxOutputTokens',
  'maxDurationMs',
  'provider',
  'model',
  'reasoningEffort',
  'budgetId',
  'budgetAmount',
  'apiKeyEnv',
  'scope',
  'workflowOwnerAnchored',
  'pluginSourceProposals',
])

const ref = Schema.string().pattern(/^[A-Z_][A-Z0-9_]*$/u)
const boundedText = (max: number) => Schema.string().min(1).max(max)

// schemastery gives every object schema a default of {}, which would otherwise
// deep-validate a missing scope against the required inner fields.  Pin the
// default to undefined so an undeclared scope stays absent (fail-closed config
// validation happens explicitly in normalizeConfig).  The cast bridges the
// library typings, whose default() parameter excludes undefined even though the
// runtime stores and returns it verbatim.
const scopeSchema = Schema.object({
  workspace: boundedText(4_096).required(),
  preset: boundedText(256).required(),
  principalId: boundedText(256).required(),
  ownerRouteId: boundedText(256).required(),
}).default(undefined as unknown as GrowthOwnerScopeConfig) as Schema<GrowthOwnerScopeConfig | undefined>

// Same missing-object default rationale as scopeSchema above. The inner fields
// are optional in WorkflowOwnerAnchoredConfig (they all carry schema defaults),
// so cast the object schema to that optional-input type before pinning its
// missing-object default to undefined.
const workflowOwnerAnchoredObjectSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  maxCommitsPerWake: Schema.natural().min(1).max(50).default(5),
  lookbackMs: Schema.natural().min(60_000).max(604_800_000).default(86_400_000),
}) as unknown as Schema<WorkflowOwnerAnchoredConfig>
const workflowOwnerAnchoredSchema = workflowOwnerAnchoredObjectSchema
  .default(undefined as unknown as WorkflowOwnerAnchoredConfig) as Schema<WorkflowOwnerAnchoredConfig | undefined>

// Same missing-object default rationale as workflowOwnerAnchoredSchema above.
const pluginSourceProposalsObjectSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  preparationMode: Schema.union(['inline', 'durable']).default('inline'),
  repository: boundedText(4_096),
  maxPlansPerWake: Schema.natural().min(1).max(5).default(1),
  // Security root: the isolated build gate must finish well inside the 300000 ms
  // growth authority lifetime; bounds mirror the control-plane service limits.
  isolatedBuildTimeoutMs: Schema.natural().min(60_000).max(240_000).default(180_000),
  offline: Schema.boolean().default(true),
  planTtlMs: Schema.natural().min(900_000).max(86_400_000).default(86_400_000),
}) as unknown as Schema<PluginSourceProposalsConfig>
const pluginSourceProposalsSchema = pluginSourceProposalsObjectSchema
  .default(undefined as unknown as PluginSourceProposalsConfig) as Schema<PluginSourceProposalsConfig | undefined>

const schema = Schema.object({
  enabled: Schema.boolean().default(false),
  intervalMs: Schema.natural().min(0).max(86_400_000).default(0),
  maxReviewsPerWake: Schema.natural().min(1).max(50).default(10),
  minRepeatedSuccesses: Schema.natural().min(1).max(32).default(3),
  // Store-imposed ceiling: candidates expire at most 7 days after staging.
  candidateTtlMs: Schema.natural().min(1_000).max(604_800_000).default(86_400_000),
  maxModelCalls: Schema.natural().min(1).max(64).default(8),
  maxToolCalls: Schema.natural().min(0).max(128).default(24),
  maxOutputTokens: Schema.natural().min(1).max(32_768).default(8_192),
  // Security root: a growth authority may never live longer than 300000 ms.
  maxDurationMs: Schema.natural().min(1_000).max(300_000).default(120_000),
  provider: boundedText(256),
  model: boundedText(256),
  reasoningEffort: boundedText(128),
  budgetId: Schema.string().min(1).max(128),
  budgetAmount: Schema.natural().min(1).max(1_000_000_000),
  apiKeyEnv: ref,
  scope: scopeSchema,
  workflowOwnerAnchored: workflowOwnerAnchoredSchema,
  pluginSourceProposals: pluginSourceProposalsSchema,
}) as Schema<AssistantGrowthDriverConfig>

export const Config = new Proxy(schema, {
  apply(target, thisArg, argumentsList: [unknown]) {
    const value = argumentsList[0]
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error('assistant-growth-driver: config must be an object')
    if (value !== undefined) for (const key of Object.keys(value as object)) if (!fields.has(key)) throw new Error(`assistant-growth-driver: unknown config field: ${key}`)
    return Reflect.apply(target, thisArg, argumentsList) as AssistantGrowthDriverConfig
  },
}) as Schema<AssistantGrowthDriverConfig>

export function normalizeConfig(input?: AssistantGrowthDriverConfig): Readonly<NormalizedGrowthDriverConfig> {
  const config = Config(input) as AssistantGrowthDriverConfig
  if (config.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/u.test(config.apiKeyEnv)) throw new Error('assistant-growth-driver: invalid apiKeyEnv')
  const normalized: NormalizedGrowthDriverConfig = Object.freeze({
    enabled: config.enabled ?? false,
    intervalMs: config.intervalMs ?? 0,
    maxReviewsPerWake: config.maxReviewsPerWake ?? 10,
    minRepeatedSuccesses: config.minRepeatedSuccesses ?? 3,
    candidateTtlMs: config.candidateTtlMs ?? 86_400_000,
    maxModelCalls: config.maxModelCalls ?? 8,
    maxToolCalls: config.maxToolCalls ?? 24,
    maxOutputTokens: config.maxOutputTokens ?? 8_192,
    maxDurationMs: config.maxDurationMs ?? 120_000,
    provider: config.provider ?? null,
    model: config.model ?? null,
    reasoningEffort: config.reasoningEffort ?? null,
    budgetId: config.budgetId ?? null,
    budgetAmount: config.budgetAmount ?? null,
    apiKeyEnv: config.apiKeyEnv ?? null,
    scope: config.scope ? Object.freeze({ ...config.scope }) : null,
    workflowOwnerAnchored: Object.freeze({
      enabled: config.workflowOwnerAnchored?.enabled ?? false,
      maxCommitsPerWake: config.workflowOwnerAnchored?.maxCommitsPerWake ?? 5,
      lookbackMs: config.workflowOwnerAnchored?.lookbackMs ?? 86_400_000,
    }),
    pluginSourceProposals: Object.freeze({
      enabled: config.pluginSourceProposals?.enabled ?? false,
      preparationMode: config.pluginSourceProposals?.preparationMode ?? 'inline',
      repository: config.pluginSourceProposals?.repository?.normalize('NFC').trim() ?? null,
      maxPlansPerWake: config.pluginSourceProposals?.maxPlansPerWake ?? 1,
      isolatedBuildTimeoutMs: config.pluginSourceProposals?.isolatedBuildTimeoutMs ?? 180_000,
      offline: config.pluginSourceProposals?.offline ?? true,
      planTtlMs: config.pluginSourceProposals?.planTtlMs ?? 86_400_000,
    }),
  })
  if (normalized.enabled && !normalized.scope) throw new Error('assistant-growth-driver: enabled requires an explicit owner scope')
  if ((normalized.provider === null) !== (normalized.model === null)) {
    throw new Error('assistant-growth-driver: provider and model must be configured together')
  }
  if (normalized.reasoningEffort !== null && normalized.provider === null) {
    throw new Error('assistant-growth-driver: reasoningEffort requires an explicit provider and model')
  }
  for (const value of [normalized.provider, normalized.model, normalized.reasoningEffort]) {
    if (value !== null && (value.trim() !== value || value.length === 0 || [...value].some(character => {
      const code = character.codePointAt(0)!
      return code <= 31 || code === 127
    }))) {
      throw new Error('assistant-growth-driver: invalid model route')
    }
  }
  if (normalized.workflowOwnerAnchored.enabled && !normalized.enabled) {
    throw new Error('assistant-growth-driver: workflowOwnerAnchored.enabled requires the driver itself to be enabled')
  }
  if (normalized.workflowOwnerAnchored.enabled && !normalized.scope) {
    throw new Error('assistant-growth-driver: workflowOwnerAnchored.enabled requires an explicit owner scope')
  }
  if (normalized.pluginSourceProposals.enabled) {
    if (!normalized.enabled) {
      throw new Error('assistant-growth-driver: pluginSourceProposals.enabled requires the driver itself to be enabled')
    }
    if (!normalized.scope) {
      throw new Error('assistant-growth-driver: pluginSourceProposals.enabled requires an explicit owner scope')
    }
    if (!normalized.pluginSourceProposals.offline) throw new Error('assistant-growth-driver: source preparation requires offline mode')
    const repository = normalized.pluginSourceProposals.repository
    // Canonical TEXT only here (the control-plane service performs the realpath
    // canonicalization against the live filesystem at prepare time): absolute,
    // non-empty and free of '.'/'..' normalization segments.
    if (repository === null || !isAbsolute(repository) || resolve(repository) !== repository) {
      throw new Error('assistant-growth-driver: pluginSourceProposals.repository must be a canonical absolute path when enabled')
    }
  }
  if ((normalized.budgetId === null) !== (normalized.budgetAmount === null)) {
    throw new Error('assistant-growth-driver: budgetId and budgetAmount must be configured together')
  }
  return normalized
}
