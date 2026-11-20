import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import {
  DEFAULT_CLUSTERING_CONFIG,
  normalizeClusteringConfig,
  type ClusteringConfig,
  type NormalizedClusteringConfig,
} from './clustering.js'
import {
  DEFAULT_ASSOCIATION_DREAMING_CONFIG,
  normalizeAssociationDreamingConfig,
  type AssociationDreamingConfig,
  type AssociationDreamingNormalizedConfig,
} from './dreaming.js'
import {
  DEFAULT_HOLDOUT_RATE_BPS,
  MAX_HOLDOUT_RATE_BPS,
  MIN_HOLDOUT_RATE_BPS,
} from './holdout.js'
import {
  DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG,
  normalizeAssociationIntakeSignalConfig,
  type AssociationIntakeSignalConfig,
  type AssociationIntakeSignalNormalizedConfig,
} from './intake-signal.js'
import {
  DEFAULT_HEBBIAN_CONFIG,
  DEFAULT_PARAM_TUNING_CONFIG,
  DEFAULT_SOURCE_WEIGHTS,
  type HebbianConfig,
  type NodeKind,
  type NormalizedHebbianConfig,
  type NormalizedParamTuningConfig,
  type ParamTuningConfig,
} from './types.js'

export interface AssociationFeatureToggleConfig {
  enabled?: boolean
}

export interface AssociationConfig {
  enabled?: boolean
  localOnly?: boolean
  databasePath?: string
  holdoutSeedPath?: string
  holdoutSeed?: string
  holdoutRateBps?: number
  hotPathBudgetMs?: number
  maxItems?: number
  minItems?: number
  maxContextTokens?: number
  maxHops?: number
  hopTopN?: number
  maxFanoutPerNode?: number
  hysteresisDelta?: number
  decayHalfLifeMs?: number
  syncIntervalMs?: number
  allowHeadlessScope?: boolean
  allowLowTrust?: boolean
  allowSensitive?: boolean
  hebbian?: HebbianConfig
  paramTuning?: ParamTuningConfig
  dreaming?: AssociationDreamingConfig
  intakeSignal?: AssociationIntakeSignalConfig
  clustering?: ClusteringConfig
  webLearning?: AssociationFeatureToggleConfig
}

export interface NormalizedAssociationConfig {
  readonly enabled: boolean
  readonly localOnly: boolean
  readonly databasePath: string | null
  readonly holdoutSeedPath: string | null
  readonly holdoutSeed: string | null
  readonly holdoutRateBps: number
  readonly hotPathBudgetMs: number
  readonly maxItems: number
  readonly minItems: number
  readonly maxContextTokens: number
  readonly maxHops: number
  readonly hopTopN: number
  readonly maxFanoutPerNode: number
  readonly hysteresisDelta: number
  readonly decayHalfLifeMs: number
  readonly syncIntervalMs: number
  readonly allowHeadlessScope: boolean
  readonly allowLowTrust: boolean
  readonly allowSensitive: boolean
  readonly sourceWeights: Readonly<Record<NodeKind, number>>
  readonly hebbian: NormalizedHebbianConfig
  readonly paramTuning: NormalizedParamTuningConfig
  readonly dreaming: AssociationDreamingNormalizedConfig
  readonly intakeSignal: AssociationIntakeSignalNormalizedConfig
  readonly clustering: NormalizedClusteringConfig
  readonly webLearning: Readonly<{ readonly enabled: boolean }>
}

const DEFAULT_DECAY_HALF_LIFE_MS = 14 * 86_400_000
const INTAKE_SOURCE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/u

const KNOWN_FIELDS = new Set<string>([
  'enabled',
  'localOnly',
  'databasePath',
  'holdoutSeedPath',
  'holdoutSeed',
  'holdoutRateBps',
  'hotPathBudgetMs',
  'maxItems',
  'minItems',
  'maxContextTokens',
  'maxHops',
  'hopTopN',
  'maxFanoutPerNode',
  'hysteresisDelta',
  'decayHalfLifeMs',
  'syncIntervalMs',
  'allowHeadlessScope',
  'allowLowTrust',
  'allowSensitive',
  'hebbian',
  'paramTuning',
  'dreaming',
  'intakeSignal',
  'clustering',
  'webLearning',
])

const KNOWN_HEBBIAN_FIELDS = new Set<string>([
  'enabled',
  'alpha',
  'weakRatio',
  'beta',
  'weightMin',
  'weightMax',
  'initialHebbianWeight',
  'decayHalfLifeMs',
  'nonUseGraceMs',
  'decayIntervalMs',
  'correctionLookbackMs',
])

const KNOWN_PARAM_TUNING_FIELDS = new Set<string>([
  'enabled',
  'minSample',
  'minStepSample',
  'minHoldoutSamples',
  'minSourceSample',
  'maxTimeoutRatePpm',
  'lowUsageRatePpm',
  'healthyUsageRatePpm',
  'highCorrectionRatePpm',
  'noisySourceRatePpm',
  'regressionMarginPpm',
  'timeoutMarginPpm',
  'maxTimeoutMarginPpm',
  'usageDropMarginPpm',
  'observationMs',
  'evaluationWindowMs',
  'relaxationReplayWindowMs',
  'relaxationReplayEnabled',
  'rollbackCooldownMs',
])

const KNOWN_DREAMING_FIELDS = new Set<string>([
  'enabled',
  'intervalMs',
  'idleMinMs',
  'maxPairsPerRun',
  'maxAbstractionsPerRun',
  'maxSynonymsPerRun',
  'nodeTtlMs',
  'allowModelSynthesis',
  'budgetId',
  'budgetAmount',
])

const KNOWN_INTAKE_SIGNAL_FIELDS = new Set<string>([
  'enabled',
  'minScore',
  'maxSignalsPerHour',
  'cooldownMs',
  'maxSummaryBytes',
  'sourceId',
  'budgetId',
  'budgetAmount',
])

const KNOWN_CLUSTERING_FIELDS = new Set<string>([
  'entityWeight',
  'toolWeight',
  'minSimilarity',
  'minClusterSize',
  'reAskWindowMs',
  'reAskMinEntityJaccard',
])

const KNOWN_WEB_LEARNING_FIELDS = new Set<string>(['enabled'])

const boundedPath = Schema.string().min(1).max(4_096)

const featureToggleSchema = Schema.object({
  enabled: Schema.boolean().default(false),
}).default({ enabled: false })

const dreamingSchema = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_ASSOCIATION_DREAMING_CONFIG.enabled),
  intervalMs: Schema.natural()
    .min(0)
    .max(365 * 86_400_000)
    .default(DEFAULT_ASSOCIATION_DREAMING_CONFIG.intervalMs),
  idleMinMs: Schema.natural()
    .min(0)
    .max(365 * 86_400_000)
    .default(DEFAULT_ASSOCIATION_DREAMING_CONFIG.idleMinMs),
  maxPairsPerRun: Schema.natural()
    .min(0)
    .max(1_000)
    .default(DEFAULT_ASSOCIATION_DREAMING_CONFIG.maxPairsPerRun),
  maxAbstractionsPerRun: Schema.natural()
    .min(0)
    .max(1_000)
    .default(DEFAULT_ASSOCIATION_DREAMING_CONFIG.maxAbstractionsPerRun),
  maxSynonymsPerRun: Schema.natural()
    .min(0)
    .max(1_000)
    .default(DEFAULT_ASSOCIATION_DREAMING_CONFIG.maxSynonymsPerRun),
  nodeTtlMs: Schema.natural()
    .min(0)
    .max(3_650 * 86_400_000)
    .default(DEFAULT_ASSOCIATION_DREAMING_CONFIG.nodeTtlMs),
  allowModelSynthesis: Schema.boolean().default(
    DEFAULT_ASSOCIATION_DREAMING_CONFIG.allowModelSynthesis,
  ),
  budgetId: Schema.string().min(1).max(256),
  budgetAmount: Schema.number().min(0).max(1_000_000),
}).default({ ...DEFAULT_ASSOCIATION_DREAMING_CONFIG })

const intakeSignalSchema = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.enabled),
  minScore: Schema.number()
    .min(0)
    .max(100)
    .default(DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.minScore),
  maxSignalsPerHour: Schema.natural()
    .min(0)
    .max(10_000)
    .default(DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.maxSignalsPerHour),
  cooldownMs: Schema.natural()
    .min(0)
    .max(365 * 86_400_000)
    .default(DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.cooldownMs),
  maxSummaryBytes: Schema.natural()
    .min(64)
    .max(65_536)
    .default(DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.maxSummaryBytes),
  sourceId: Schema.string()
    .min(1)
    .max(64)
    .default(DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.sourceId),
  budgetId: Schema.string().min(1).max(256),
  budgetAmount: Schema.number().min(0).max(1_000_000),
}).default({ ...DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG })

const clusteringSchema = Schema.object({
  entityWeight: Schema.number().min(0).max(10).default(DEFAULT_CLUSTERING_CONFIG.entityWeight),
  toolWeight: Schema.number().min(0).max(10).default(DEFAULT_CLUSTERING_CONFIG.toolWeight),
  minSimilarity: Schema.number().min(0).max(1).default(DEFAULT_CLUSTERING_CONFIG.minSimilarity),
  minClusterSize: Schema.natural()
    .min(2)
    .max(100)
    .default(DEFAULT_CLUSTERING_CONFIG.minClusterSize),
  reAskWindowMs: Schema.natural()
    .min(0)
    .max(365 * 86_400_000)
    .default(DEFAULT_CLUSTERING_CONFIG.reAskWindowMs),
  reAskMinEntityJaccard: Schema.number()
    .min(0)
    .max(1)
    .default(DEFAULT_CLUSTERING_CONFIG.reAskMinEntityJaccard),
}).default({ ...DEFAULT_CLUSTERING_CONFIG })

const hebbianSchema = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_HEBBIAN_CONFIG.enabled),
  alpha: Schema.number().min(0).max(5).default(DEFAULT_HEBBIAN_CONFIG.alpha),
  weakRatio: Schema.number().min(0).max(1).default(DEFAULT_HEBBIAN_CONFIG.weakRatio),
  beta: Schema.number().min(0).max(5).default(DEFAULT_HEBBIAN_CONFIG.beta),
  weightMin: Schema.number().min(0).max(10).default(DEFAULT_HEBBIAN_CONFIG.weightMin),
  weightMax: Schema.number().min(0).max(10).default(DEFAULT_HEBBIAN_CONFIG.weightMax),
  initialHebbianWeight: Schema.number()
    .min(0)
    .max(10)
    .default(DEFAULT_HEBBIAN_CONFIG.initialHebbianWeight),
  decayHalfLifeMs: Schema.number()
    .min(1)
    .max(3_650 * 86_400_000)
    .default(DEFAULT_HEBBIAN_CONFIG.decayHalfLifeMs),
  nonUseGraceMs: Schema.number()
    .min(0)
    .max(3_650 * 86_400_000)
    .default(DEFAULT_HEBBIAN_CONFIG.nonUseGraceMs),
  decayIntervalMs: Schema.natural()
    .min(1_000)
    .max(7 * 86_400_000)
    .default(DEFAULT_HEBBIAN_CONFIG.decayIntervalMs),
  correctionLookbackMs: Schema.number()
    .min(0)
    .max(365 * 86_400_000)
    .default(DEFAULT_HEBBIAN_CONFIG.correctionLookbackMs),
}).default({ ...DEFAULT_HEBBIAN_CONFIG })

const paramTuningSchema = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_PARAM_TUNING_CONFIG.enabled),
  minSample: Schema.natural().min(1).max(100_000).default(DEFAULT_PARAM_TUNING_CONFIG.minSample),
  minStepSample: Schema.natural()
    .min(1)
    .max(100_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.minStepSample),
  minHoldoutSamples: Schema.natural()
    .min(1)
    .max(100_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.minHoldoutSamples),
  minSourceSample: Schema.natural()
    .min(1)
    .max(100_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.minSourceSample),
  maxTimeoutRatePpm: Schema.natural()
    .min(0)
    .max(1_000_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.maxTimeoutRatePpm),
  lowUsageRatePpm: Schema.natural()
    .min(0)
    .max(1_000_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.lowUsageRatePpm),
  healthyUsageRatePpm: Schema.natural()
    .min(0)
    .max(1_000_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.healthyUsageRatePpm),
  highCorrectionRatePpm: Schema.natural()
    .min(0)
    .max(1_000_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.highCorrectionRatePpm),
  noisySourceRatePpm: Schema.natural()
    .min(0)
    .max(1_000_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.noisySourceRatePpm),
  regressionMarginPpm: Schema.natural()
    .min(0)
    .max(1_000_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.regressionMarginPpm),
  timeoutMarginPpm: Schema.natural()
    .min(0)
    .max(1_000_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.timeoutMarginPpm),
  maxTimeoutMarginPpm: Schema.natural()
    .min(0)
    .max(1_000_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.maxTimeoutMarginPpm),
  usageDropMarginPpm: Schema.natural()
    .min(0)
    .max(1_000_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.usageDropMarginPpm),
  observationMs: Schema.natural()
    .min(1)
    .max(365 * 86_400_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.observationMs),
  evaluationWindowMs: Schema.natural()
    .min(1)
    .max(365 * 86_400_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.evaluationWindowMs),
  relaxationReplayWindowMs: Schema.natural()
    .min(1)
    .max(365 * 86_400_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.relaxationReplayWindowMs),
  relaxationReplayEnabled: Schema.boolean().default(
    DEFAULT_PARAM_TUNING_CONFIG.relaxationReplayEnabled,
  ),
  rollbackCooldownMs: Schema.natural()
    .min(0)
    .max(365 * 86_400_000)
    .default(DEFAULT_PARAM_TUNING_CONFIG.rollbackCooldownMs),
}).default({ ...DEFAULT_PARAM_TUNING_CONFIG })

const rawSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  localOnly: Schema.boolean().default(true),
  databasePath: boundedPath,
  holdoutSeedPath: boundedPath,
  holdoutSeed: Schema.string().min(16).max(512),
  holdoutRateBps: Schema.natural()
    .min(MIN_HOLDOUT_RATE_BPS)
    .max(MAX_HOLDOUT_RATE_BPS)
    .default(DEFAULT_HOLDOUT_RATE_BPS),
  hotPathBudgetMs: Schema.number().min(0).max(50).default(4.5),
  maxItems: Schema.natural().min(5).max(8).default(8),
  minItems: Schema.natural().min(1).max(8).default(5),
  maxContextTokens: Schema.natural().min(64).max(1_000).default(400),
  maxHops: Schema.natural().min(1).max(2).default(2),
  hopTopN: Schema.natural().min(4).max(128).default(32),
  maxFanoutPerNode: Schema.natural().min(8).max(512).default(128),
  hysteresisDelta: Schema.number().min(0).max(2).default(0.15),
  decayHalfLifeMs: Schema.natural()
    .min(60_000)
    .max(365 * 86_400_000)
    .default(DEFAULT_DECAY_HALF_LIFE_MS),
  syncIntervalMs: Schema.natural().min(1_000).max(3_600_000).default(15_000),
  allowHeadlessScope: Schema.boolean().default(false),
  allowLowTrust: Schema.boolean().default(true),
  allowSensitive: Schema.boolean().default(false),
  hebbian: hebbianSchema,
  paramTuning: paramTuningSchema,
  dreaming: dreamingSchema,
  intakeSignal: intakeSignalSchema,
  clustering: clusteringSchema,
  webLearning: featureToggleSchema,
}).default({})

function checkKnownNestedFields(
  obj: unknown,
  known: ReadonlySet<string>,
  prefix: string,
): void {
  if (obj === undefined) return
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`assistant-association: ${prefix} must be an object`)
  }
  for (const key of Object.keys(obj as object)) {
    if (!known.has(key)) {
      throw new Error(`assistant-association: unknown config field: ${prefix}.${key}`)
    }
  }
}

export const Config: Schema<AssociationConfig> = new Proxy(rawSchema, {
  apply(target, thisArg, argumentsList: [unknown]) {
    const value = argumentsList[0]
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('assistant-association: config must be an object')
    }
    if (value !== undefined) {
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        if (!KNOWN_FIELDS.has(key)) {
          throw new Error(`assistant-association: unknown config field: ${key}`)
        }
      }
      checkKnownNestedFields(record.hebbian, KNOWN_HEBBIAN_FIELDS, 'hebbian')
      checkKnownNestedFields(record.paramTuning, KNOWN_PARAM_TUNING_FIELDS, 'paramTuning')
      checkKnownNestedFields(record.dreaming, KNOWN_DREAMING_FIELDS, 'dreaming')
      checkKnownNestedFields(record.intakeSignal, KNOWN_INTAKE_SIGNAL_FIELDS, 'intakeSignal')
      checkKnownNestedFields(record.clustering, KNOWN_CLUSTERING_FIELDS, 'clustering')
      checkKnownNestedFields(record.webLearning, KNOWN_WEB_LEARNING_FIELDS, 'webLearning')
    }
    const parsed = Reflect.apply(target, thisArg, argumentsList) as AssociationConfig
    validateCrossFieldConstraints(parsed)
    return parsed
  },
}) as Schema<AssociationConfig>

function isCanonicalPathOrMemory(pathValue: string): boolean {
  if (pathValue === ':memory:') return true
  return isAbsolute(pathValue) && resolve(pathValue) === pathValue
}

function assertFiniteRange(
  value: number,
  label: string,
  check: (n: number) => boolean,
  message: string,
): void {
  if (!Number.isFinite(value) || !check(value)) {
    throw new Error(`assistant-association: ${label} ${message}`)
  }
}

function validateCrossFieldConstraints(parsed: AssociationConfig): void {
  const maxItems = parsed.maxItems ?? 8
  const minItems = parsed.minItems ?? 5
  if (minItems > maxItems) {
    throw new Error(`assistant-association: minItems (${minItems}) cannot exceed maxItems (${maxItems})`)
  }
  if (parsed.databasePath !== undefined && !isCanonicalPathOrMemory(parsed.databasePath)) {
    throw new Error('assistant-association: databasePath must be :memory: or a canonical absolute path')
  }
  if (
    parsed.holdoutSeedPath !== undefined &&
    (!isAbsolute(parsed.holdoutSeedPath) || resolve(parsed.holdoutSeedPath) !== parsed.holdoutSeedPath)
  ) {
    throw new Error('assistant-association: holdoutSeedPath must be a canonical absolute path')
  }

  const heb = parsed.hebbian ?? DEFAULT_HEBBIAN_CONFIG
  const alpha = heb.alpha ?? DEFAULT_HEBBIAN_CONFIG.alpha
  const weakRatio = heb.weakRatio ?? DEFAULT_HEBBIAN_CONFIG.weakRatio
  const beta = heb.beta ?? DEFAULT_HEBBIAN_CONFIG.beta
  const weightMin = heb.weightMin ?? DEFAULT_HEBBIAN_CONFIG.weightMin
  const weightMax = heb.weightMax ?? DEFAULT_HEBBIAN_CONFIG.weightMax
  const initialHebbianWeight =
    heb.initialHebbianWeight ?? DEFAULT_HEBBIAN_CONFIG.initialHebbianWeight
  const decayHalfLifeMs = heb.decayHalfLifeMs ?? DEFAULT_HEBBIAN_CONFIG.decayHalfLifeMs
  const nonUseGraceMs = heb.nonUseGraceMs ?? DEFAULT_HEBBIAN_CONFIG.nonUseGraceMs
  const decayIntervalMs = heb.decayIntervalMs ?? DEFAULT_HEBBIAN_CONFIG.decayIntervalMs
  const correctionLookbackMs =
    heb.correctionLookbackMs ?? DEFAULT_HEBBIAN_CONFIG.correctionLookbackMs

  assertFiniteRange(alpha, 'hebbian.alpha', (n) => n >= 0, 'must be >= 0')
  assertFiniteRange(weakRatio, 'hebbian.weakRatio', (n) => n >= 0 && n <= 1, 'must be in [0, 1]')
  assertFiniteRange(beta, 'hebbian.beta', (n) => n >= 0, 'must be >= 0')
  assertFiniteRange(weightMin, 'hebbian.weightMin', (n) => n >= 0, 'must be >= 0')
  assertFiniteRange(weightMax, 'hebbian.weightMax', (n) => n >= 0, 'must be >= 0')
  assertFiniteRange(
    initialHebbianWeight,
    'hebbian.initialHebbianWeight',
    (n) => n >= weightMin && n <= weightMax,
    `must satisfy weightMin (${weightMin}) <= initialHebbianWeight <= weightMax (${weightMax})`,
  )
  if (weightMin > weightMax) {
    throw new Error(
      `assistant-association: hebbian.weightMin (${weightMin}) cannot exceed hebbian.weightMax (${weightMax})`,
    )
  }
  assertFiniteRange(decayHalfLifeMs, 'hebbian.decayHalfLifeMs', (n) => n > 0, 'must be > 0')
  assertFiniteRange(nonUseGraceMs, 'hebbian.nonUseGraceMs', (n) => n >= 0, 'must be >= 0')
  assertFiniteRange(decayIntervalMs, 'hebbian.decayIntervalMs', (n) => n >= 1_000, 'must be >= 1000')
  assertFiniteRange(
    correctionLookbackMs,
    'hebbian.correctionLookbackMs',
    (n) => n >= 0,
    'must be >= 0',
  )

  const pt = parsed.paramTuning ?? DEFAULT_PARAM_TUNING_CONFIG
  for (const [key, val] of [
    ['minSample', pt.minSample ?? DEFAULT_PARAM_TUNING_CONFIG.minSample],
    ['minStepSample', pt.minStepSample ?? DEFAULT_PARAM_TUNING_CONFIG.minStepSample],
    ['minHoldoutSamples', pt.minHoldoutSamples ?? DEFAULT_PARAM_TUNING_CONFIG.minHoldoutSamples],
    ['minSourceSample', pt.minSourceSample ?? DEFAULT_PARAM_TUNING_CONFIG.minSourceSample],
    ['observationMs', pt.observationMs ?? DEFAULT_PARAM_TUNING_CONFIG.observationMs],
    ['evaluationWindowMs', pt.evaluationWindowMs ?? DEFAULT_PARAM_TUNING_CONFIG.evaluationWindowMs],
    [
      'relaxationReplayWindowMs',
      pt.relaxationReplayWindowMs ?? DEFAULT_PARAM_TUNING_CONFIG.relaxationReplayWindowMs,
    ],
  ] as const) {
    assertFiniteRange(val, `paramTuning.${key}`, (n) => n >= 1, 'must be >= 1')
  }
  assertFiniteRange(
    pt.rollbackCooldownMs ?? DEFAULT_PARAM_TUNING_CONFIG.rollbackCooldownMs,
    'paramTuning.rollbackCooldownMs',
    (n) => n >= 0,
    'must be >= 0',
  )
  for (const [key, val] of [
    ['maxTimeoutRatePpm', pt.maxTimeoutRatePpm ?? DEFAULT_PARAM_TUNING_CONFIG.maxTimeoutRatePpm],
    ['lowUsageRatePpm', pt.lowUsageRatePpm ?? DEFAULT_PARAM_TUNING_CONFIG.lowUsageRatePpm],
    ['healthyUsageRatePpm', pt.healthyUsageRatePpm ?? DEFAULT_PARAM_TUNING_CONFIG.healthyUsageRatePpm],
    [
      'highCorrectionRatePpm',
      pt.highCorrectionRatePpm ?? DEFAULT_PARAM_TUNING_CONFIG.highCorrectionRatePpm,
    ],
    ['noisySourceRatePpm', pt.noisySourceRatePpm ?? DEFAULT_PARAM_TUNING_CONFIG.noisySourceRatePpm],
    ['regressionMarginPpm', pt.regressionMarginPpm ?? DEFAULT_PARAM_TUNING_CONFIG.regressionMarginPpm],
    ['timeoutMarginPpm', pt.timeoutMarginPpm ?? DEFAULT_PARAM_TUNING_CONFIG.timeoutMarginPpm],
    ['maxTimeoutMarginPpm', pt.maxTimeoutMarginPpm ?? DEFAULT_PARAM_TUNING_CONFIG.maxTimeoutMarginPpm],
    ['usageDropMarginPpm', pt.usageDropMarginPpm ?? DEFAULT_PARAM_TUNING_CONFIG.usageDropMarginPpm],
  ] as const) {
    assertFiniteRange(val, `paramTuning.${key}`, (n) => n >= 0 && n <= 1_000_000, 'must be in [0, 1000000]')
  }

  const dream = parsed.dreaming ?? DEFAULT_ASSOCIATION_DREAMING_CONFIG
  assertFiniteRange(
    dream.intervalMs ?? DEFAULT_ASSOCIATION_DREAMING_CONFIG.intervalMs,
    'dreaming.intervalMs',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    dream.idleMinMs ?? DEFAULT_ASSOCIATION_DREAMING_CONFIG.idleMinMs,
    'dreaming.idleMinMs',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    dream.maxPairsPerRun ?? DEFAULT_ASSOCIATION_DREAMING_CONFIG.maxPairsPerRun,
    'dreaming.maxPairsPerRun',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    dream.maxAbstractionsPerRun ?? DEFAULT_ASSOCIATION_DREAMING_CONFIG.maxAbstractionsPerRun,
    'dreaming.maxAbstractionsPerRun',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    dream.maxSynonymsPerRun ?? DEFAULT_ASSOCIATION_DREAMING_CONFIG.maxSynonymsPerRun,
    'dreaming.maxSynonymsPerRun',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    dream.nodeTtlMs ?? DEFAULT_ASSOCIATION_DREAMING_CONFIG.nodeTtlMs,
    'dreaming.nodeTtlMs',
    (n) => n >= 0,
    'must be >= 0',
  )
  if (dream.budgetAmount !== undefined) {
    assertFiniteRange(dream.budgetAmount, 'dreaming.budgetAmount', (n) => n > 0, 'must be > 0')
  }

  const intake = parsed.intakeSignal ?? DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG
  assertFiniteRange(
    intake.minScore ?? DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.minScore,
    'intakeSignal.minScore',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    intake.maxSignalsPerHour ?? DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.maxSignalsPerHour,
    'intakeSignal.maxSignalsPerHour',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    intake.cooldownMs ?? DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.cooldownMs,
    'intakeSignal.cooldownMs',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    intake.maxSummaryBytes ?? DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.maxSummaryBytes,
    'intakeSignal.maxSummaryBytes',
    (n) => n >= 64 && n <= 65_536,
    'must be in [64, 65536]',
  )
  const sourceId = intake.sourceId ?? DEFAULT_ASSOCIATION_INTAKE_SIGNAL_CONFIG.sourceId
  if (!INTAKE_SOURCE_ID_RE.test(sourceId)) {
    throw new Error('assistant-association: intakeSignal.sourceId must match /^[a-z][a-z0-9-]{0,63}$/u')
  }
  if (intake.budgetAmount !== undefined) {
    assertFiniteRange(intake.budgetAmount, 'intakeSignal.budgetAmount', (n) => n > 0, 'must be > 0')
  }

  const clust = parsed.clustering ?? DEFAULT_CLUSTERING_CONFIG
  assertFiniteRange(
    clust.entityWeight ?? DEFAULT_CLUSTERING_CONFIG.entityWeight,
    'clustering.entityWeight',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    clust.toolWeight ?? DEFAULT_CLUSTERING_CONFIG.toolWeight,
    'clustering.toolWeight',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    clust.minSimilarity ?? DEFAULT_CLUSTERING_CONFIG.minSimilarity,
    'clustering.minSimilarity',
    (n) => n >= 0 && n <= 1,
    'must be in [0, 1]',
  )
  assertFiniteRange(
    clust.minClusterSize ?? DEFAULT_CLUSTERING_CONFIG.minClusterSize,
    'clustering.minClusterSize',
    (n) => Number.isSafeInteger(n) && n >= 2,
    'must be an integer >= 2',
  )
  assertFiniteRange(
    clust.reAskWindowMs ?? DEFAULT_CLUSTERING_CONFIG.reAskWindowMs,
    'clustering.reAskWindowMs',
    (n) => n >= 0,
    'must be >= 0',
  )
  assertFiniteRange(
    clust.reAskMinEntityJaccard ?? DEFAULT_CLUSTERING_CONFIG.reAskMinEntityJaccard,
    'clustering.reAskMinEntityJaccard',
    (n) => n >= 0 && n <= 1,
    'must be in [0, 1]',
  )
}

export function normalizeConfig(input?: AssociationConfig): NormalizedAssociationConfig {
  const parsed = (Config(input ?? {}) ?? {}) as AssociationConfig
  const enabled = parsed.enabled ?? true
  const maxItems = parsed.maxItems ?? 8
  const minItems = parsed.minItems ?? 5
  const databasePath = parsed.databasePath ?? null
  const holdoutSeedPath = parsed.holdoutSeedPath ?? null

  if (enabled && databasePath === null) {
    throw new Error('assistant-association: enabled requires databasePath')
  }

  const heb = parsed.hebbian ?? {}
  const pt = parsed.paramTuning ?? {}

  const hebbian: NormalizedHebbianConfig = Object.freeze({
    enabled: heb.enabled ?? DEFAULT_HEBBIAN_CONFIG.enabled,
    alpha: heb.alpha ?? DEFAULT_HEBBIAN_CONFIG.alpha,
    weakRatio: heb.weakRatio ?? DEFAULT_HEBBIAN_CONFIG.weakRatio,
    beta: heb.beta ?? DEFAULT_HEBBIAN_CONFIG.beta,
    weightMin: heb.weightMin ?? DEFAULT_HEBBIAN_CONFIG.weightMin,
    weightMax: heb.weightMax ?? DEFAULT_HEBBIAN_CONFIG.weightMax,
    initialHebbianWeight:
      heb.initialHebbianWeight ?? DEFAULT_HEBBIAN_CONFIG.initialHebbianWeight,
    decayHalfLifeMs: heb.decayHalfLifeMs ?? DEFAULT_HEBBIAN_CONFIG.decayHalfLifeMs,
    nonUseGraceMs: heb.nonUseGraceMs ?? DEFAULT_HEBBIAN_CONFIG.nonUseGraceMs,
    decayIntervalMs: heb.decayIntervalMs ?? DEFAULT_HEBBIAN_CONFIG.decayIntervalMs,
    correctionLookbackMs:
      heb.correctionLookbackMs ?? DEFAULT_HEBBIAN_CONFIG.correctionLookbackMs,
  })

  const paramTuning: NormalizedParamTuningConfig = Object.freeze({
    enabled: pt.enabled ?? DEFAULT_PARAM_TUNING_CONFIG.enabled,
    minSample: pt.minSample ?? DEFAULT_PARAM_TUNING_CONFIG.minSample,
    minStepSample: pt.minStepSample ?? DEFAULT_PARAM_TUNING_CONFIG.minStepSample,
    minHoldoutSamples: pt.minHoldoutSamples ?? DEFAULT_PARAM_TUNING_CONFIG.minHoldoutSamples,
    minSourceSample: pt.minSourceSample ?? DEFAULT_PARAM_TUNING_CONFIG.minSourceSample,
    maxTimeoutRatePpm: pt.maxTimeoutRatePpm ?? DEFAULT_PARAM_TUNING_CONFIG.maxTimeoutRatePpm,
    lowUsageRatePpm: pt.lowUsageRatePpm ?? DEFAULT_PARAM_TUNING_CONFIG.lowUsageRatePpm,
    healthyUsageRatePpm:
      pt.healthyUsageRatePpm ?? DEFAULT_PARAM_TUNING_CONFIG.healthyUsageRatePpm,
    highCorrectionRatePpm:
      pt.highCorrectionRatePpm ?? DEFAULT_PARAM_TUNING_CONFIG.highCorrectionRatePpm,
    noisySourceRatePpm: pt.noisySourceRatePpm ?? DEFAULT_PARAM_TUNING_CONFIG.noisySourceRatePpm,
    regressionMarginPpm:
      pt.regressionMarginPpm ?? DEFAULT_PARAM_TUNING_CONFIG.regressionMarginPpm,
    timeoutMarginPpm: pt.timeoutMarginPpm ?? DEFAULT_PARAM_TUNING_CONFIG.timeoutMarginPpm,
    maxTimeoutMarginPpm:
      pt.maxTimeoutMarginPpm ?? DEFAULT_PARAM_TUNING_CONFIG.maxTimeoutMarginPpm,
    usageDropMarginPpm: pt.usageDropMarginPpm ?? DEFAULT_PARAM_TUNING_CONFIG.usageDropMarginPpm,
    observationMs: pt.observationMs ?? DEFAULT_PARAM_TUNING_CONFIG.observationMs,
    evaluationWindowMs: pt.evaluationWindowMs ?? DEFAULT_PARAM_TUNING_CONFIG.evaluationWindowMs,
    relaxationReplayWindowMs:
      pt.relaxationReplayWindowMs ?? DEFAULT_PARAM_TUNING_CONFIG.relaxationReplayWindowMs,
    relaxationReplayEnabled:
      pt.relaxationReplayEnabled ?? DEFAULT_PARAM_TUNING_CONFIG.relaxationReplayEnabled,
    rollbackCooldownMs: pt.rollbackCooldownMs ?? DEFAULT_PARAM_TUNING_CONFIG.rollbackCooldownMs,
  })

  return Object.freeze({
    enabled,
    localOnly: parsed.localOnly ?? true,
    databasePath,
    holdoutSeedPath,
    holdoutSeed: parsed.holdoutSeed ?? null,
    holdoutRateBps: parsed.holdoutRateBps ?? DEFAULT_HOLDOUT_RATE_BPS,
    hotPathBudgetMs: parsed.hotPathBudgetMs ?? 4.5,
    maxItems,
    minItems,
    maxContextTokens: parsed.maxContextTokens ?? 400,
    maxHops: parsed.maxHops ?? 2,
    hopTopN: parsed.hopTopN ?? 32,
    maxFanoutPerNode: parsed.maxFanoutPerNode ?? 128,
    hysteresisDelta: parsed.hysteresisDelta ?? 0.15,
    decayHalfLifeMs: parsed.decayHalfLifeMs ?? DEFAULT_DECAY_HALF_LIFE_MS,
    syncIntervalMs: parsed.syncIntervalMs ?? 15_000,
    allowHeadlessScope: parsed.allowHeadlessScope ?? false,
    allowLowTrust: parsed.allowLowTrust ?? true,
    allowSensitive: parsed.allowSensitive ?? false,
    sourceWeights: DEFAULT_SOURCE_WEIGHTS,
    hebbian,
    paramTuning,
    dreaming: normalizeAssociationDreamingConfig(parsed.dreaming),
    intakeSignal: normalizeAssociationIntakeSignalConfig(parsed.intakeSignal),
    clustering: normalizeClusteringConfig(parsed.clustering),
    webLearning: Object.freeze({ enabled: parsed.webLearning?.enabled ?? false }),
  })
}

export const normalizeAssociationConfig = normalizeConfig
