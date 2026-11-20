import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import {
  DEFAULT_HOLDOUT_RATE_BPS,
  MAX_HOLDOUT_RATE_BPS,
  MIN_HOLDOUT_RATE_BPS,
} from './holdout.js'
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
  dreaming?: AssociationFeatureToggleConfig
  intakeSignal?: AssociationFeatureToggleConfig
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
  readonly dreaming: Readonly<{ readonly enabled: boolean }>
  readonly intakeSignal: Readonly<{ readonly enabled: boolean }>
  readonly webLearning: Readonly<{ readonly enabled: boolean }>
}

const DEFAULT_DECAY_HALF_LIFE_MS = 14 * 86_400_000

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

const boundedPath = Schema.string().min(1).max(4_096)

const featureToggleSchema = Schema.object({
  enabled: Schema.boolean().default(false),
}).default({ enabled: false })

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
  dreaming: featureToggleSchema,
  intakeSignal: featureToggleSchema,
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
    dreaming: Object.freeze({ enabled: parsed.dreaming?.enabled ?? false }),
    intakeSignal: Object.freeze({ enabled: parsed.intakeSignal?.enabled ?? false }),
    webLearning: Object.freeze({ enabled: parsed.webLearning?.enabled ?? false }),
  })
}

export const normalizeAssociationConfig = normalizeConfig
