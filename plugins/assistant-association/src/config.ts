import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import {
  DEFAULT_HOLDOUT_RATE_BPS,
  MAX_HOLDOUT_RATE_BPS,
  MIN_HOLDOUT_RATE_BPS,
} from './holdout.js'
import { DEFAULT_SOURCE_WEIGHTS, type NodeKind } from './types.js'

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
  'dreaming',
  'intakeSignal',
  'webLearning',
])

const boundedPath = Schema.string().min(1).max(4_096)

const featureToggleSchema = Schema.object({
  enabled: Schema.boolean().default(false),
}).default({ enabled: false })

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
  dreaming: featureToggleSchema,
  intakeSignal: featureToggleSchema,
  webLearning: featureToggleSchema,
}).default({})

export const Config: Schema<AssociationConfig> = new Proxy(rawSchema, {
  apply(target, thisArg, argumentsList: [unknown]) {
    const value = argumentsList[0]
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('assistant-association: config must be an object')
    }
    if (value !== undefined) {
      for (const key of Object.keys(value as object)) {
        if (!KNOWN_FIELDS.has(key)) {
          throw new Error(`assistant-association: unknown config field: ${key}`)
        }
      }
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
  if (parsed.enabled !== false && parsed.databasePath === undefined) {
    // Allow service apply() to fail closed or resolve default if omitted, unless explicitly checked in normalizeConfig
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
    dreaming: Object.freeze({ enabled: parsed.dreaming?.enabled ?? false }),
    intakeSignal: Object.freeze({ enabled: parsed.intakeSignal?.enabled ?? false }),
    webLearning: Object.freeze({ enabled: parsed.webLearning?.enabled ?? false }),
  })
}
