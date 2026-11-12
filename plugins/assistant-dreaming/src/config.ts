import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/**
 * The dreaming plugin is opt-in and fail-closed: when disabled it registers no
 * automation, opens no database and performs no work. Every bound below is an
 * owner configuration value; model output can never supply paths, budgets or
 * targets.
 */

export interface DreamingScopeConfig {
  workspace: string
  preset: string
  principalId: string
  ownerRouteId: string
}

export interface DreamingActiveHours {
  timezone: string
  /** Minutes since local midnight; same-day window only, no midnight crossing. */
  startMinute: number
  endMinute: number
}

export interface DreamingConfig {
  enabled?: boolean
  /**
   * Owner pause switch: load in the paused state (reconcile the system
   * automation to paused, register no executor) while keeping full config.
   * Removing the flag on the next load resumes with a fresh reconcile nonce.
   */
  retired?: boolean
  scope?: DreamingScopeConfig
  databasePath?: string

  // Trigger
  baseIntervalMs?: number
  runProbabilityPpm?: number
  idleMinMs?: number
  activeHours?: DreamingActiveHours
  /** Optional owner-supplied HMAC seed; randomness stays deterministic. */
  randomSeed?: string
  /** Half-width of the recall lottery's circular window around the draw. */
  lotteryWindow?: number

  // Per-wake / per-day bounds
  maxDreamsPerDay?: number
  maxIdeasPerWake?: number
  maxModelCalls?: number
  maxToolCalls?: number
  maxOutputTokens?: number
  maxDurationMs?: number
  maxInputBytes?: number
  maxEvidenceRefs?: number

  // Notification (L1; S1 keeps it silently off)
  notifyOwner?: boolean
  maxNotificationsPerDay?: number
  notifyMinIntervalMs?: number

  // Budget and model; vendor-neutral generic fields only
  budgetId?: string
  budgetAmount?: number
  provider?: string
  model?: string
  reasoningEffort?: string

  retentionDays?: number
}

export interface NormalizedDreamingConfig {
  readonly enabled: boolean
  readonly retired: boolean
  readonly scope: DreamingScopeConfig | null
  readonly databasePath: string | null
  readonly baseIntervalMs: number
  readonly runProbabilityPpm: number
  readonly idleMinMs: number
  readonly lotteryWindow: number
  readonly activeHours: DreamingActiveHours | null
  readonly seedDigest: string | null
  readonly maxDreamsPerDay: number
  readonly maxIdeasPerWake: number
  readonly maxModelCalls: number
  readonly maxToolCalls: number
  readonly maxOutputTokens: number
  readonly maxDurationMs: number
  readonly maxInputBytes: number
  readonly maxEvidenceRefs: number
  readonly notifyOwner: boolean
  readonly maxNotificationsPerDay: number
  readonly notifyMinIntervalMs: number
  readonly budgetId: string | null
  readonly budgetAmount: number | null
  readonly provider: string | null
  readonly model: string | null
  readonly reasoningEffort: string | null
  readonly retentionDays: number
}

const fields = new Set([
  'enabled', 'retired', 'scope', 'databasePath', 'baseIntervalMs', 'runProbabilityPpm', 'idleMinMs', 'lotteryWindow',
  'activeHours', 'randomSeed', 'maxDreamsPerDay', 'maxIdeasPerWake', 'maxModelCalls', 'maxToolCalls',
  'maxOutputTokens', 'maxDurationMs', 'maxInputBytes', 'maxEvidenceRefs', 'notifyOwner',
  'maxNotificationsPerDay', 'notifyMinIntervalMs', 'budgetId', 'budgetAmount', 'provider', 'model',
  'reasoningEffort', 'retentionDays',
])

const boundedText = (max: number) => Schema.string().min(1).max(max)

const scopeSchema = Schema.object({
  workspace: boundedText(4_096).required(),
  preset: boundedText(256).required(),
  principalId: boundedText(256).required(),
  ownerRouteId: boundedText(256).required(),
}).default(undefined as unknown as DreamingScopeConfig) as Schema<DreamingScopeConfig | undefined>

const activeHoursSchema = Schema.object({
  timezone: boundedText(128).required(),
  startMinute: Schema.natural().min(0).max(1_439).required(),
  endMinute: Schema.natural().min(1).max(1_440).required(),
}).default(undefined as unknown as DreamingActiveHours) as Schema<DreamingActiveHours | undefined>

const schema = Schema.object({
  enabled: Schema.boolean().default(false),
  retired: Schema.boolean().default(false),
  scope: scopeSchema,
  databasePath: boundedText(4_096),

  baseIntervalMs: Schema.natural().min(900_000).max(86_400_000).default(3_600_000),
  runProbabilityPpm: Schema.natural().min(0).max(1_000_000).default(250_000),
  idleMinMs: Schema.natural().min(300_000).max(86_400_000).default(1_800_000),
  lotteryWindow: Schema.natural().min(0).max(500_000).default(5_000),
  activeHours: activeHoursSchema,
  randomSeed: Schema.string().min(16).max(256),

  maxDreamsPerDay: Schema.natural().min(1).max(24).default(3),
  maxIdeasPerWake: Schema.natural().min(1).max(5).default(3),
  maxModelCalls: Schema.natural().min(1).max(8).default(2),
  maxToolCalls: Schema.natural().min(0).max(8).default(1),
  maxOutputTokens: Schema.natural().min(1).max(4_096).default(2_048),
  maxDurationMs: Schema.natural().min(1_000).max(300_000).default(90_000),
  maxInputBytes: Schema.natural().min(1_024).max(65_536).default(16_384),
  maxEvidenceRefs: Schema.natural().min(1).max(16).default(8),

  notifyOwner: Schema.boolean().default(false),
  maxNotificationsPerDay: Schema.natural().min(0).max(3).default(1),
  notifyMinIntervalMs: Schema.natural().min(60_000).max(604_800_000).default(86_400_000),

  budgetId: boundedText(128),
  // Automations bounds the per-run budget amount to 10,000,000; reject larger
  // values here instead of failing later while reconciling the definition.
  budgetAmount: Schema.natural().min(1).max(10_000_000),
  provider: boundedText(256),
  model: boundedText(256),
  reasoningEffort: boundedText(128),

  retentionDays: Schema.natural().min(1).max(365).default(90),
}).default(undefined as never)

export const Config = new Proxy(schema, {
  apply(target, thisArg, argumentsList: [unknown]) {
    const value = argumentsList[0]
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('assistant-dreaming: config must be an object')
    }
    if (value !== undefined) {
      for (const key of Object.keys(value as object)) {
        if (!fields.has(key)) throw new Error(`assistant-dreaming: unknown config field: ${key}`)
      }
    }
    return Reflect.apply(target, thisArg, argumentsList) as DreamingConfig
  },
}) as Schema<DreamingConfig>

export function normalizeConfig(input?: DreamingConfig): Readonly<NormalizedDreamingConfig> {
  const config = (Config(input) ?? {}) as DreamingConfig
  const normalized: NormalizedDreamingConfig = Object.freeze({
    enabled: config.enabled ?? false,
    retired: config.retired ?? false,
    scope: config.scope ? Object.freeze({ ...config.scope }) : null,
    databasePath: config.databasePath ?? null,
    baseIntervalMs: config.baseIntervalMs ?? 3_600_000,
    runProbabilityPpm: config.runProbabilityPpm ?? 250_000,
    idleMinMs: config.idleMinMs ?? 1_800_000,
    lotteryWindow: config.lotteryWindow ?? 5_000,
    activeHours: config.activeHours ? Object.freeze({ ...config.activeHours }) : null,
    seedDigest: config.randomSeed === undefined
      ? null : createHash('sha256').update(config.randomSeed).digest('hex'),
    maxDreamsPerDay: config.maxDreamsPerDay ?? 3,
    maxIdeasPerWake: config.maxIdeasPerWake ?? 3,
    maxModelCalls: config.maxModelCalls ?? 2,
    maxToolCalls: config.maxToolCalls ?? 1,
    maxOutputTokens: config.maxOutputTokens ?? 2_048,
    maxDurationMs: config.maxDurationMs ?? 90_000,
    maxInputBytes: config.maxInputBytes ?? 16_384,
    maxEvidenceRefs: config.maxEvidenceRefs ?? 8,
    notifyOwner: config.notifyOwner ?? false,
    maxNotificationsPerDay: config.maxNotificationsPerDay ?? 1,
    notifyMinIntervalMs: config.notifyMinIntervalMs ?? 86_400_000,
    budgetId: config.budgetId ?? null,
    budgetAmount: config.budgetAmount ?? null,
    provider: config.provider ?? null,
    model: config.model ?? null,
    reasoningEffort: config.reasoningEffort ?? null,
    retentionDays: config.retentionDays ?? 90,
  })
  if (normalized.enabled) {
    if (!normalized.scope) throw new Error('assistant-dreaming: enabled requires an explicit owner scope')
    // The frozen workspace becomes an Automations definition field, so it must
    // already be the canonical absolute path that definition normalization
    // accepts; reject it at load time instead of failing reconciliation later.
    if (!isAbsolute(normalized.scope.workspace) || resolve(normalized.scope.workspace) !== normalized.scope.workspace) {
      throw new Error('assistant-dreaming: enabled requires a canonical absolute scope.workspace')
    }
    if (normalized.databasePath === null || !isAbsolute(normalized.databasePath)
      || resolve(normalized.databasePath) !== normalized.databasePath) {
      throw new Error('assistant-dreaming: enabled requires a canonical absolute databasePath')
    }
    if (normalized.provider === null || normalized.model === null) {
      throw new Error('assistant-dreaming: enabled requires an explicit provider and model')
    }
    if (normalized.budgetId === null || normalized.budgetAmount === null) {
      throw new Error('assistant-dreaming: enabled requires a budgetId and budgetAmount pair')
    }
  }
  if ((normalized.provider === null) !== (normalized.model === null)) {
    throw new Error('assistant-dreaming: provider and model must be configured together')
  }
  if (normalized.reasoningEffort !== null && normalized.provider === null) {
    throw new Error('assistant-dreaming: reasoningEffort requires an explicit provider and model')
  }
  if ((normalized.budgetId === null) !== (normalized.budgetAmount === null)) {
    throw new Error('assistant-dreaming: budgetId and budgetAmount must be configured together')
  }
  if (normalized.activeHours && normalized.activeHours.startMinute >= normalized.activeHours.endMinute) {
    throw new Error('assistant-dreaming: activeHours must be a same-day window with startMinute < endMinute')
  }
  if (normalized.maxNotificationsPerDay > normalized.maxDreamsPerDay) {
    throw new Error('assistant-dreaming: maxNotificationsPerDay cannot exceed maxDreamsPerDay')
  }
  // `retired` only pauses through the enabled loading path (it reconciles the
  // existing system automation to paused). A disabled row returns before that
  // point and cannot pause anything, so accepting the combination would
  // silently leave a previously active automation running. Fail closed instead.
  if (normalized.retired && !normalized.enabled) {
    throw new Error('assistant-dreaming: retired requires enabled: true; pause the enabled row first, then remove retired before disabling')
  }
  return normalized
}
