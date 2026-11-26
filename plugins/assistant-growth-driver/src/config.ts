import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { validateWorkItemGrowthAuthorityPins, validateWorkItemRevisionAuthorityPins,
  type WorkItemGrowthAuthorityPins, type WorkItemRevisionAuthorityPins } from '@dsh-enhanced/assistant-growth-contract'

/**
 * The growth driver is enabled by default with fail-closed standby when
 * host-provisioned prerequisites (such as owner `scope`, `repository`, or
 * `usageLearning` paths/budgets) are omitted; explicit `enabled: false`
 * disables the driver and cascades to omitted sub-tracks. Model selection
 * follows the owner's conversation unless an explicit fixed pair overrides it.
 */

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
  /** Separately opt into new-plugin creation; only Host-owned durable jobs may use it. */
  allowCreation?: boolean
  /** Existing-plugin modification is enabled by default for older profiles. */
  allowModification?: boolean
  /** Separately opt into revising an adopted plugin from a new failed owner task. */
  allowRevision?: boolean
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
  /**
   * How the model sees the frozen growth tool surface. `native` (default) sends
   * every allowlisted schema directly; `ptc` presents only the Host's reserved
   * `run_code` transport plus a generated SDK, so one model turn can orchestrate
   * several nested tool calls whose intermediate results stay out of context.
   * PTC changes presentation only: the allowlist, approvals, budget and output
   * caps are unchanged. It requires a mounted `ctx.ptcRuntime` and fails closed
   * when that runtime is absent.
   */
  toolPresentation?: 'native' | 'ptc'
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
  dreamingIdeas?: DreamingIdeasIntakeConfig
  associationCandidates?: AssociationCandidatesIntakeConfig
  /** One-time opt-in to durable reviews driven by actual trusted foreground results. */
  usageLearning?: {
    enabled?: boolean; databasePath?: string; maxPending?: number; lookbackMs?: number
    workItemFailures?: boolean
    workItemAuthorities?: WorkItemGrowthAuthorityPins
    /** Separately pinned revision corridor for already-adopted capabilities. */
    workItemRevisionAuthorities?: WorkItemRevisionAuthorityPins
    /** Native discovery scans need their own explicit automation-runs allocation. */
    scanBudgetId?: string; scanBudgetAmount?: number
  }
}

export interface NormalizedWorkflowOwnerAnchoredConfig {
  readonly enabled: boolean
  readonly maxCommitsPerWake: number
  readonly lookbackMs: number
}

export interface NormalizedPluginSourceProposalsConfig {
  readonly enabled: boolean
  readonly allowCreation: boolean
  readonly allowModification: boolean
  readonly allowRevision: boolean
  readonly preparationMode: 'inline' | 'durable'
  readonly repository: string | null
  readonly maxPlansPerWake: number
  readonly isolatedBuildTimeoutMs: number
  readonly offline: boolean
  readonly planTtlMs: number
}

export interface DreamingIdeasIntakeConfig {
  enabled?: boolean
  maxIdeasPerWake?: number
}

export interface NormalizedDreamingIdeasIntakeConfig {
  readonly enabled: boolean
  readonly maxIdeasPerWake: number
}

export interface AssociationCandidatesIntakeConfig {
  enabled?: boolean
  maxCandidatesPerWake?: number
}

export interface NormalizedAssociationCandidatesIntakeConfig {
  readonly enabled: boolean
  readonly maxCandidatesPerWake: number
}

export interface NormalizedGrowthDriverConfig extends Required<Omit<AssistantGrowthDriverConfig, 'provider' | 'model' | 'reasoningEffort' | 'apiKeyEnv' | 'budgetId' | 'budgetAmount' | 'scope' | 'workflowOwnerAnchored' | 'pluginSourceProposals' | 'dreamingIdeas' | 'associationCandidates' | 'usageLearning' | 'toolPresentation'>> {
  readonly toolPresentation: 'native' | 'ptc'
  readonly provider: string | null
  readonly model: string | null
  readonly reasoningEffort: string | null
  readonly apiKeyEnv: string | null
  readonly budgetId: string | null
  readonly budgetAmount: number | null
  readonly scope: GrowthOwnerScopeConfig | null
  readonly workflowOwnerAnchored: NormalizedWorkflowOwnerAnchoredConfig
  readonly pluginSourceProposals: NormalizedPluginSourceProposalsConfig
  readonly dreamingIdeas: NormalizedDreamingIdeasIntakeConfig
  readonly associationCandidates: NormalizedAssociationCandidatesIntakeConfig
  readonly usageLearning: Readonly<{ enabled: boolean; databasePath: string | null; maxPending: number; lookbackMs: number;
    scanBudgetId: string | null; scanBudgetAmount: number | null; workItemFailures?: true;
    workItemAuthorities?: WorkItemGrowthAuthorityPins; workItemRevisionAuthorities?: WorkItemRevisionAuthorityPins }>
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
  'toolPresentation',
  'provider',
  'model',
  'reasoningEffort',
  'budgetId',
  'budgetAmount',
  'apiKeyEnv',
  'scope',
  'workflowOwnerAnchored',
  'pluginSourceProposals',
  'dreamingIdeas',
  'associationCandidates',
  'usageLearning',
])

const ref = Schema.string().pattern(/^[A-Z_][A-Z0-9_]*$/u)
const boundedText = (max: number) => Schema.string().min(1).max(max).pattern(/^[^\s\p{Cc}](?:[^\p{Cc}]*[^\s\p{Cc}])?$/u)

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
  enabled: Schema.boolean().default(true),
  maxCommitsPerWake: Schema.natural().min(1).max(50).default(5),
  lookbackMs: Schema.natural().min(60_000).max(604_800_000).default(86_400_000),
}) as unknown as Schema<WorkflowOwnerAnchoredConfig>
const workflowOwnerAnchoredSchema = workflowOwnerAnchoredObjectSchema
  .default(undefined as unknown as WorkflowOwnerAnchoredConfig) as Schema<WorkflowOwnerAnchoredConfig | undefined>

// Same missing-object default rationale as workflowOwnerAnchoredSchema above.
const pluginSourceProposalsObjectSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  allowCreation: Schema.boolean().default(true),
  allowModification: Schema.boolean().default(true),
  allowRevision: Schema.boolean().default(true),
  preparationMode: Schema.union(['inline', 'durable']).default('durable'),
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

const dreamingIdeasObjectSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  maxIdeasPerWake: Schema.natural().min(1).max(10).default(3),
}) as unknown as Schema<DreamingIdeasIntakeConfig>
const dreamingIdeasSchema = dreamingIdeasObjectSchema
  .default(undefined as unknown as DreamingIdeasIntakeConfig) as Schema<DreamingIdeasIntakeConfig | undefined>

const associationCandidatesObjectSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  maxCandidatesPerWake: Schema.natural().min(1).max(10).default(3),
}) as unknown as Schema<AssociationCandidatesIntakeConfig>
const associationCandidatesSchema = associationCandidatesObjectSchema
  .default(undefined as unknown as AssociationCandidatesIntakeConfig) as Schema<AssociationCandidatesIntakeConfig | undefined>

const schema = Schema.object({
  enabled: Schema.boolean().default(true),
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
  // Presentation only; the frozen allowlist/approval/budget contract below is
  // identical in both modes. Absence of a PTC runtime is a runtime failure, not
  // a config-time fallback.
  toolPresentation: Schema.union(['native', 'ptc']).default('native'),
  provider: boundedText(256),
  model: boundedText(256),
  reasoningEffort: boundedText(128),
  budgetId: boundedText(128),
  budgetAmount: Schema.natural().min(1).max(1_000_000_000),
  apiKeyEnv: ref,
  scope: scopeSchema,
  workflowOwnerAnchored: workflowOwnerAnchoredSchema,
  pluginSourceProposals: pluginSourceProposalsSchema,
  dreamingIdeas: dreamingIdeasSchema,
  associationCandidates: associationCandidatesSchema,
  usageLearning: Schema.object({ workItemFailures: Schema.boolean().default(true), workItemAuthorities: Schema.any(), workItemRevisionAuthorities: Schema.any(),
    enabled: Schema.boolean().default(true), databasePath: boundedText(4096),
    scanBudgetId: boundedText(128),
    scanBudgetAmount: Schema.natural().min(1).max(10_000_000),
    maxPending: Schema.natural().min(1).max(100).default(16),
    lookbackMs: Schema.natural().min(60_000).max(604_800_000).default(86_400_000),
  }).default(undefined as never),
}) as Schema<AssistantGrowthDriverConfig>

const explicitConfigInputs = new WeakMap<object, AssistantGrowthDriverConfig>()

function snapshotExplicitInput(raw: unknown): AssistantGrowthDriverConfig | undefined {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : value
  }
  return out as AssistantGrowthDriverConfig
}

export const Config = new Proxy(schema, {
  apply(target, thisArg, argumentsList: [unknown]) {
    const value = argumentsList[0]
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error('assistant-growth-driver: config must be an object')
    if (value !== undefined) for (const key of Object.keys(value as object)) if (!fields.has(key)) throw new Error(`assistant-growth-driver: unknown config field: ${key}`)
    const explicit = (value !== null && typeof value === 'object' ? explicitConfigInputs.get(value) : undefined)
      ?? snapshotExplicitInput(value)
    const parsed = Reflect.apply(target, thisArg, argumentsList) as AssistantGrowthDriverConfig
    if (parsed !== null && typeof parsed === 'object' && explicit !== undefined) {
      explicitConfigInputs.set(parsed, explicit)
    }
    return parsed
  },
  get(target, prop, receiver) {
    if (prop === '~standard') {
      const std = Reflect.get(target, prop, target) as {
        version: number
        vendor: string
        validate: (value: unknown, options?: unknown) => { value?: unknown; issues?: readonly { message: string }[] }
          | Promise<{ value?: unknown; issues?: readonly { message: string }[] }>
      }
      return {
        ...std,
        validate(value: unknown, options?: unknown) {
          if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
            return { issues: [{ message: 'assistant-growth-driver: config must be an object' }] }
          }
          if (value !== undefined) {
            for (const key of Object.keys(value as object)) {
              if (!fields.has(key)) {
                return { issues: [{ message: `assistant-growth-driver: unknown config field: ${key}` }] }
              }
            }
          }
          const explicit = (value !== null && typeof value === 'object' ? explicitConfigInputs.get(value) : undefined)
            ?? snapshotExplicitInput(value)
          const result = std.validate(value, options)
          const attach = (res: { value?: unknown; issues?: readonly { message: string }[] }) => {
            if (res && typeof res === 'object' && !res.issues && res.value !== null && typeof res.value === 'object'
              && explicit !== undefined) {
              explicitConfigInputs.set(res.value as object, explicit)
            }
            return res
          }
          return result instanceof Promise ? result.then(attach) : attach(result)
        },
      }
    }
    return Reflect.get(target, prop, receiver)
  },
}) as Schema<AssistantGrowthDriverConfig>

export function normalizeConfig(input?: AssistantGrowthDriverConfig): Readonly<NormalizedGrowthDriverConfig> {
  const rawInput = (input !== undefined && input !== null && typeof input === 'object' && !Array.isArray(input))
    ? (explicitConfigInputs.get(input) ?? input)
    : undefined
  if (rawInput?.usageLearning && Object.hasOwn(rawInput.usageLearning, 'workItemFailures')
    && typeof rawInput.usageLearning.workItemFailures !== 'boolean') throw new Error('assistant-growth-driver: workItemFailures must be a boolean')
  const explicitEnabled = rawInput?.enabled
  const explicitWorkflow = rawInput?.workflowOwnerAnchored?.enabled
  const explicitSource = rawInput?.pluginSourceProposals?.enabled
  const explicitCreation = rawInput?.pluginSourceProposals?.allowCreation
  const explicitRevision = rawInput?.pluginSourceProposals?.allowRevision
  const explicitPrepMode = rawInput?.pluginSourceProposals?.preparationMode
  const explicitDreaming = rawInput?.dreamingIdeas?.enabled
  const explicitAssociation = rawInput?.associationCandidates?.enabled
  const explicitUsage = rawInput?.usageLearning?.enabled
  const explicitWorkItemFailures = rawInput?.usageLearning?.workItemFailures
  const explicitRepositoryProvided = rawInput?.pluginSourceProposals !== undefined
    && Object.hasOwn(rawInput.pluginSourceProposals, 'repository')
    && rawInput.pluginSourceProposals.repository !== undefined
  const explicitUsageFieldsProvided = rawInput?.usageLearning !== undefined
    && (rawInput.usageLearning.databasePath !== undefined
      || rawInput.usageLearning.scanBudgetId !== undefined
      || rawInput.usageLearning.scanBudgetAmount !== undefined)

  const rawProvider = rawInput?.provider
  const rawModel = rawInput?.model
  const rawReasoning = rawInput?.reasoningEffort
  for (const value of [rawProvider, rawModel, rawReasoning]) {
    if (typeof value === 'string' && value.length > 0 && (value.trim() !== value || [...value].some(character => {
      const code = character.codePointAt(0)!
      return code <= 31 || code === 127
    }))) {
      throw new Error('assistant-growth-driver: invalid model route')
    }
  }

  const config = Config(input) as AssistantGrowthDriverConfig
  if (config.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/u.test(config.apiKeyEnv)) throw new Error('assistant-growth-driver: invalid apiKeyEnv')
  const pins = config.usageLearning?.workItemAuthorities
  if (pins !== undefined) validateWorkItemGrowthAuthorityPins(pins)
  if (pins !== undefined && explicitWorkItemFailures === false) throw new Error('assistant-growth-driver: workItemAuthorities require workItemFailures')
  const revisionPins = config.usageLearning?.workItemRevisionAuthorities
  if (revisionPins !== undefined) validateWorkItemRevisionAuthorityPins(revisionPins)
  if (revisionPins !== undefined && explicitWorkItemFailures === false) {
    throw new Error('assistant-growth-driver: workItemRevisionAuthorities require workItemFailures')
  }
  const frozenPins = pins === undefined ? undefined : Object.freeze({ ...pins,
    sourceJobs: Object.freeze({ ...pins.sourceJobs }), creationGrant: Object.freeze({ ...pins.creationGrant }),
    creationAcceptance: Object.freeze({ ...pins.creationAcceptance }), adoption: Object.freeze({ ...pins.adoption }) })
  const frozenRevisionPins = revisionPins === undefined ? undefined : Object.freeze({ ...revisionPins,
    sourceJobs: Object.freeze({ ...revisionPins.sourceJobs }), revisionGrant: Object.freeze({ ...revisionPins.revisionGrant }),
    revisionAcceptance: Object.freeze({ ...revisionPins.revisionAcceptance }),
    ...(revisionPins.revisionRegressionAcceptance === undefined ? {} : { revisionRegressionAcceptance: Object.freeze({ ...revisionPins.revisionRegressionAcceptance }) }),
    ...(revisionPins.revisionAdoption === undefined ? {} : { revisionAdoption: Object.freeze({ ...revisionPins.revisionAdoption }) }) })

  const driverEnabled = explicitEnabled ?? true
  const workflowEnabled = driverEnabled ? (explicitWorkflow ?? true) : false
  const sourceEnabled = driverEnabled ? (explicitSource ?? true) : false
  const prepMode = explicitPrepMode ?? 'durable'
  const allowCreation = sourceEnabled ? (explicitCreation ?? (explicitPrepMode === 'inline' ? false : true)) : false
  const dreamingEnabled = driverEnabled ? (explicitDreaming ?? true) : false
  const associationEnabled = driverEnabled ? (explicitAssociation ?? true) : false
  const usageEnabled = driverEnabled ? (explicitUsage ?? true) : false
  const allowRevision = sourceEnabled && prepMode === 'durable' && usageEnabled ? (explicitRevision ?? true) : false
  const workItemFailuresEnabled = usageEnabled && sourceEnabled && prepMode === 'durable' && allowCreation
    ? (explicitWorkItemFailures ?? true) : false

  const normalized: NormalizedGrowthDriverConfig = Object.freeze({
    enabled: driverEnabled,
    intervalMs: config.intervalMs ?? 0,
    maxReviewsPerWake: config.maxReviewsPerWake ?? 10,
    minRepeatedSuccesses: config.minRepeatedSuccesses ?? 3,
    candidateTtlMs: config.candidateTtlMs ?? 86_400_000,
    maxModelCalls: config.maxModelCalls ?? 8,
    maxToolCalls: config.maxToolCalls ?? 24,
    maxOutputTokens: config.maxOutputTokens ?? 8_192,
    maxDurationMs: config.maxDurationMs ?? 120_000,
    toolPresentation: config.toolPresentation ?? 'native',
    provider: config.provider ?? null,
    model: config.model ?? null,
    reasoningEffort: config.reasoningEffort ?? null,
    budgetId: config.budgetId ?? null,
    budgetAmount: config.budgetAmount ?? null,
    apiKeyEnv: config.apiKeyEnv ?? null,
    scope: config.scope ? Object.freeze({ ...config.scope }) : null,
    workflowOwnerAnchored: Object.freeze({
      enabled: workflowEnabled,
      maxCommitsPerWake: config.workflowOwnerAnchored?.maxCommitsPerWake ?? 5,
      lookbackMs: config.workflowOwnerAnchored?.lookbackMs ?? 86_400_000,
    }),
    pluginSourceProposals: Object.freeze({
      enabled: sourceEnabled,
      allowCreation,
      allowModification: config.pluginSourceProposals?.allowModification ?? true,
      allowRevision,
      preparationMode: prepMode,
      repository: config.pluginSourceProposals?.repository?.normalize('NFC').trim() ?? null,
      maxPlansPerWake: config.pluginSourceProposals?.maxPlansPerWake ?? 1,
      isolatedBuildTimeoutMs: config.pluginSourceProposals?.isolatedBuildTimeoutMs ?? 180_000,
      offline: config.pluginSourceProposals?.offline ?? true,
      planTtlMs: config.pluginSourceProposals?.planTtlMs ?? 86_400_000,
    }),
    dreamingIdeas: Object.freeze({
      enabled: dreamingEnabled,
      maxIdeasPerWake: config.dreamingIdeas?.maxIdeasPerWake ?? 3,
    }),
    associationCandidates: Object.freeze({
      enabled: associationEnabled,
      maxCandidatesPerWake: config.associationCandidates?.maxCandidatesPerWake ?? 3,
    }),
    usageLearning: Object.freeze({ ...(workItemFailuresEnabled ? { workItemFailures: true as const,
        ...(frozenPins === undefined ? {} : { workItemAuthorities: frozenPins }) } : {}),
      ...(frozenRevisionPins === undefined ? {} : { workItemRevisionAuthorities: frozenRevisionPins }),
      enabled: usageEnabled,
      scanBudgetId: config.usageLearning?.scanBudgetId ?? null,
      scanBudgetAmount: config.usageLearning?.scanBudgetAmount ?? null,
      databasePath: config.usageLearning?.databasePath ?? null, maxPending: config.usageLearning?.maxPending ?? 16,
      lookbackMs: config.usageLearning?.lookbackMs ?? 86_400_000 }),
  })
  if (explicitEnabled === true && !normalized.scope) throw new Error('assistant-growth-driver: enabled requires an explicit owner scope')
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
  if (explicitWorkflow === true && !normalized.enabled) {
    throw new Error('assistant-growth-driver: workflowOwnerAnchored.enabled requires the driver itself to be enabled')
  }
  if (explicitWorkflow === true && !normalized.scope) {
    throw new Error('assistant-growth-driver: workflowOwnerAnchored.enabled requires an explicit owner scope')
  }
  if (explicitSource === true && !normalized.enabled) {
    throw new Error('assistant-growth-driver: pluginSourceProposals.enabled requires the driver itself to be enabled')
  }
  if (explicitSource === true && !normalized.scope) {
    throw new Error('assistant-growth-driver: pluginSourceProposals.enabled requires an explicit owner scope')
  }
  if (normalized.pluginSourceProposals.enabled) {
    if (!normalized.pluginSourceProposals.offline) throw new Error('assistant-growth-driver: source preparation requires offline mode')
    const repository = normalized.pluginSourceProposals.repository
    // Canonical TEXT only here (the control-plane service performs the realpath
    // canonicalization against the live filesystem at prepare time): absolute,
    // non-empty and free of '.'/'..' normalization segments.
    if (repository !== null && (!isAbsolute(repository) || resolve(repository) !== repository)) {
      throw new Error('assistant-growth-driver: pluginSourceProposals.repository must be a canonical absolute path when enabled')
    }
    if ((explicitSource === true || explicitRepositoryProvided) && repository === null) {
      throw new Error('assistant-growth-driver: pluginSourceProposals.repository must be a canonical absolute path when enabled')
    }
  }
  if (explicitCreation === true
    && (!normalized.pluginSourceProposals.enabled || normalized.pluginSourceProposals.preparationMode !== 'durable')) {
    throw new Error('assistant-growth-driver: source creation requires enabled durable source proposals')
  }
  if (normalized.pluginSourceProposals.enabled && !normalized.pluginSourceProposals.allowModification
    && !normalized.pluginSourceProposals.allowCreation && !normalized.pluginSourceProposals.allowRevision) {
    throw new Error('assistant-growth-driver: source proposals require at least one allowed mode')
  }
  if (explicitDreaming === true && !normalized.enabled) {
    throw new Error('assistant-growth-driver: dreamingIdeas.enabled requires the driver itself to be enabled')
  }
  if (explicitDreaming === true && !normalized.scope) {
    throw new Error('assistant-growth-driver: dreamingIdeas.enabled requires an explicit owner scope')
  }
  if (explicitAssociation === true && !normalized.enabled) {
    throw new Error('assistant-growth-driver: associationCandidates.enabled requires the driver itself to be enabled')
  }
  if (explicitAssociation === true && !normalized.scope) {
    throw new Error('assistant-growth-driver: associationCandidates.enabled requires an explicit owner scope')
  }
  if (explicitRevision === true
    && (!normalized.pluginSourceProposals.enabled || normalized.pluginSourceProposals.preparationMode !== 'durable'
      || !normalized.usageLearning.enabled)) {
    throw new Error('assistant-growth-driver: source revision requires enabled durable source proposals and usage learning')
  }
  if ((normalized.budgetId === null) !== (normalized.budgetAmount === null)) {
    throw new Error('assistant-growth-driver: budgetId and budgetAmount must be configured together')
  }
  if (explicitWorkItemFailures === true && (!normalized.usageLearning.enabled
    || !normalized.pluginSourceProposals.enabled || normalized.pluginSourceProposals.preparationMode !== 'durable'
    || !normalized.pluginSourceProposals.allowCreation || frozenPins === undefined)) {
    throw new Error('assistant-growth-driver: work item failures require durable creation, usage learning and explicit authorities')
  }
  if (frozenRevisionPins !== undefined && (!normalized.pluginSourceProposals.allowRevision
    || normalized.pluginSourceProposals.preparationMode !== 'durable')) {
    throw new Error('assistant-growth-driver: work item revision authorities require durable revision proposals')
  }
  if (explicitUsage === true || (normalized.usageLearning.enabled && explicitUsageFieldsProvided)) {
    const path = normalized.usageLearning.databasePath
    if (!normalized.enabled || !normalized.scope || !normalized.budgetId || normalized.intervalMs !== 0
      || path === null || !isAbsolute(path) || resolve(path) !== path) {
      throw new Error('assistant-growth-driver: usageLearning requires enabled owner scope, budget, absolute databasePath and intervalMs=0')
    }
    const scanBudget = normalized.usageLearning.scanBudgetId
    if (scanBudget === null || scanBudget.trim() !== scanBudget || scanBudget.length === 0
      || scanBudget.normalize('NFC') !== scanBudget || /[\p{Cc}]/u.test(scanBudget)
      || normalized.usageLearning.scanBudgetAmount === null) {
      throw new Error('assistant-growth-driver: usageLearning requires scanBudgetId and scanBudgetAmount for native discovery')
    }
  } else if (normalized.usageLearning.databasePath !== null) {
    const path = normalized.usageLearning.databasePath
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new Error('assistant-growth-driver: usageLearning requires enabled owner scope, budget, absolute databasePath and intervalMs=0')
    }
  }
  return normalized
}
