/**
 * WP20 built-in opt-in `inferred` intake evaluation rule presets.
 *
 * These presets provide bounded `{ ruleId, ceiling }` templates for
 * `assistant-proactive`'s model evaluation producer without activating anything
 * on their own. Default policy/intake behavior remains 100% unchanged unless
 * an owner or host setup explicitly opts into a preset tier or explicit rules.
 */

/** Ordered weakest -> strongest; mirrors `assistant-proactive` and `assistant-work-items`. */
export const INTAKE_EVALUATION_LEVELS = ['ignore', 'digest', 'notify', 'accept'] as const
export type IntakeEvaluationLevel = typeof INTAKE_EVALUATION_LEVELS[number]

/** Supported built-in opt-in preset tiers for inferred intake evaluation rules. */
export const INTAKE_RULE_PRESET_TIERS = ['conservative', 'balanced'] as const
export type IntakeRulePresetTier = typeof INTAKE_RULE_PRESET_TIERS[number]

/** Deterministic rule identifiers in canonical lexicographical order. */
export const INTAKE_PRESET_RULE_IDS = [
  'dsh-intake-calendar-imminent',
  'dsh-intake-file-watch-change',
  'dsh-intake-github-mention-or-review',
  'dsh-intake-webhook-priority',
] as const
export type IntakePresetRuleId = typeof INTAKE_PRESET_RULE_IDS[number]

export type IntakePresetSourceKind = 'calendar' | 'file-watch' | 'github' | 'webhook'

/** Protocol ceiling on rule count in `assistant-proactive` / `assistant-work-items`. */
export const MAX_INTAKE_EVALUATION_RULES = 16

/** Exact `{ ruleId, ceiling }` rule shape accepted by `assistant-proactive` and `plugin-setup`. */
export interface IntakeEvaluationRuleSpec {
  readonly ruleId: string
  readonly ceiling: IntakeEvaluationLevel
}

export interface IntakeRulePresetEntry {
  readonly ruleId: IntakePresetRuleId
  readonly sourceKind: IntakePresetSourceKind
  readonly summary: string
  readonly ceilings: Readonly<Record<IntakeRulePresetTier, IntakeEvaluationLevel>>
}

export interface IntakeEvaluationPresetResolutionInput {
  readonly preset?: IntakeRulePresetTier | string | null
  readonly rules?: readonly unknown[] | null
}

const INTAKE_RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const INTAKE_LEVEL_SET: ReadonlySet<string> = new Set(INTAKE_EVALUATION_LEVELS)

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`assistant-policy: ${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`assistant-policy: ${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

export function isIntakeEvaluationLevel(value: unknown): value is IntakeEvaluationLevel {
  return typeof value === 'string' && INTAKE_LEVEL_SET.has(value)
}

export function isIntakeRulePresetTier(value: unknown): value is IntakeRulePresetTier {
  return value === 'conservative' || value === 'balanced'
}

export function isValidIntakeRuleId(value: unknown): value is string {
  return typeof value === 'string' && INTAKE_RULE_ID_PATTERN.test(value)
}

function assertPresetTier(tier: unknown): IntakeRulePresetTier {
  if (!isIntakeRulePresetTier(tier)) {
    throw new Error('assistant-policy: intake preset tier must be "conservative" or "balanced"')
  }
  return tier
}

function normalizeIntakeRule(raw: unknown, label = 'intakeEvaluation.rules[]'): IntakeEvaluationRuleSpec {
  const record = plainObject(raw, label)
  // Read keys and values once so getters/proxies or extra fields cannot slip past schema checks.
  const keys = Object.keys(record).sort()
  if (keys.length !== 2 || keys[0] !== 'ceiling' || keys[1] !== 'ruleId') {
    throw new Error(`assistant-policy: ${label} must have exactly ruleId and ceiling`)
  }
  const ruleId = record['ruleId']
  const ceiling = record['ceiling']
  if (!isValidIntakeRuleId(ruleId)) {
    throw new Error(`assistant-policy: ${label}.ruleId has an invalid shape`)
  }
  if (!isIntakeEvaluationLevel(ceiling)) {
    throw new Error(
      `assistant-policy: ${label}.ceiling must be one of ${INTAKE_EVALUATION_LEVELS.join(', ')}`,
    )
  }
  return Object.freeze({ ruleId, ceiling })
}

/**
 * Built-in catalog of opt-in inferred intake rules (sorted by `ruleId`).
 * `conservative` bounds every rule at `notify` or lower; `balanced` allows
 * `accept` only for explicit GitHub mentions/review requests.
 */
export const INTAKE_RULE_PRESET_CATALOG: readonly IntakeRulePresetEntry[] = Object.freeze([
  Object.freeze({
    ruleId: 'dsh-intake-calendar-imminent',
    sourceKind: 'calendar',
    summary: 'Imminent calendar or scheduled reminder event',
    ceilings: Object.freeze({ conservative: 'notify', balanced: 'notify' }),
  }),
  Object.freeze({
    ruleId: 'dsh-intake-file-watch-change',
    sourceKind: 'file-watch',
    summary: 'Watched workspace or local file change signal',
    ceilings: Object.freeze({ conservative: 'digest', balanced: 'digest' }),
  }),
  Object.freeze({
    ruleId: 'dsh-intake-github-mention-or-review',
    sourceKind: 'github',
    summary: 'GitHub mention, review request, or repository event',
    ceilings: Object.freeze({ conservative: 'notify', balanced: 'accept' }),
  }),
  Object.freeze({
    ruleId: 'dsh-intake-webhook-priority',
    sourceKind: 'webhook',
    summary: 'High-priority inbound webhook or HTTP trigger event',
    ceilings: Object.freeze({ conservative: 'notify', balanced: 'notify' }),
  }),
])

function compilePresetRules(tier: IntakeRulePresetTier): readonly IntakeEvaluationRuleSpec[] {
  return Object.freeze(
    INTAKE_RULE_PRESET_CATALOG.map(entry =>
      Object.freeze({
        ruleId: entry.ruleId,
        ceiling: entry.ceilings[tier],
      }),
    ),
  )
}

/** Pre-compiled, canonically ordered `{ ruleId, ceiling }` lists per preset tier. */
export const INTAKE_RULE_PRESETS: Readonly<Record<IntakeRulePresetTier, readonly IntakeEvaluationRuleSpec[]>> =
  Object.freeze({
    conservative: compilePresetRules('conservative'),
    balanced: compilePresetRules('balanced'),
  })

/** Build a fresh frozen `{ ruleId, ceiling }[]` preset list for the requested tier. */
export function buildIntakeRulePreset(tier: IntakeRulePresetTier): readonly IntakeEvaluationRuleSpec[] {
  const checked = assertPresetTier(tier)
  return Object.freeze(
    INTAKE_RULE_PRESETS[checked].map(rule => Object.freeze({ ruleId: rule.ruleId, ceiling: rule.ceiling })),
  )
}

/**
 * Expand an opt-in preset and/or explicit `{ ruleId, ceiling }` rules into a
 * canonically sorted rule list.
 *
 * Returns `undefined` when neither `preset` nor non-empty `rules` is provided,
 * keeping default behavior untouched unless explicitly opted in. When both are
 * provided, explicit rules override matching preset `ruleId`s and may append
 * additional rules up to `MAX_INTAKE_EVALUATION_RULES`.
 */
export function resolveIntakeEvaluationPresetRules(
  input?: IntakeEvaluationPresetResolutionInput | null,
): readonly IntakeEvaluationRuleSpec[] | undefined {
  if (input === undefined || input === null) return undefined
  const record = plainObject(input, 'intakeEvaluation')
  const rawPreset = record['preset']
  const rawRules = record['rules']

  const tier = rawPreset === undefined || rawPreset === null ? undefined : assertPresetTier(rawPreset)
  const explicitRules: IntakeEvaluationRuleSpec[] = []
  if (rawRules !== undefined && rawRules !== null) {
    if (!Array.isArray(rawRules)) {
      throw new Error('assistant-policy: intakeEvaluation.rules must be an array')
    }
    if (rawRules.length > MAX_INTAKE_EVALUATION_RULES) {
      throw new Error(
        `assistant-policy: intakeEvaluation.rules must list at most ${MAX_INTAKE_EVALUATION_RULES} rules`,
      )
    }
    const seenExplicit = new Set<string>()
    for (const entry of rawRules) {
      const normalized = normalizeIntakeRule(entry)
      if (seenExplicit.has(normalized.ruleId)) {
        throw new Error(`assistant-policy: intakeEvaluation.rules repeats ruleId ${normalized.ruleId}`)
      }
      seenExplicit.add(normalized.ruleId)
      explicitRules.push(normalized)
    }
  }

  if (tier === undefined && explicitRules.length === 0) return undefined

  const byRuleId = new Map<string, IntakeEvaluationRuleSpec>()
  if (tier !== undefined) {
    for (const rule of INTAKE_RULE_PRESETS[tier]) {
      byRuleId.set(rule.ruleId, Object.freeze({ ruleId: rule.ruleId, ceiling: rule.ceiling }))
    }
  }
  for (const rule of explicitRules) {
    byRuleId.set(rule.ruleId, rule)
  }

  if (byRuleId.size > MAX_INTAKE_EVALUATION_RULES) {
    throw new Error(
      `assistant-policy: resolved intake evaluation rules exceed maximum of ${MAX_INTAKE_EVALUATION_RULES}`,
    )
  }

  const sorted = [...byRuleId.values()].sort((left, right) =>
    left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0,
  )
  return Object.freeze(sorted)
}

export interface IntakeRuleOverrideUpdate {
  readonly ruleId: string
  readonly enabled?: boolean
  readonly mode?: 'observe' | 'auto'
  readonly confidenceThresholdPpm?: number
  readonly minUtility?: number
}

const RULE_OVERRIDE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'ruleId',
  'enabled',
  'mode',
  'confidenceThresholdPpm',
  'minUtility',
])

export function normalizeIntakeRuleUpdates(
  raw: unknown,
  maxRules = MAX_INTAKE_EVALUATION_RULES,
): readonly IntakeRuleOverrideUpdate[] {
  if (!Array.isArray(raw) || raw.length > maxRules) {
    throw new Error(`assistant-policy: intakeRuleUpdates must be an array of at most ${maxRules} rules`)
  }
  const seen = new Set<string>()
  const normalized: IntakeRuleOverrideUpdate[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = plainObject(raw[i], `intakeRuleUpdates[${i}]`)
    for (const key of Object.keys(entry)) {
      if (!RULE_OVERRIDE_ALLOWED_KEYS.has(key)) {
        throw new Error(`assistant-policy: intakeRuleUpdates[${i}] contains unknown field ${key}`)
      }
    }
    const ruleId = entry['ruleId']
    if (!isValidIntakeRuleId(ruleId)) {
      throw new Error(`assistant-policy: intakeRuleUpdates[${i}].ruleId has an invalid shape`)
    }
    if (seen.has(ruleId)) {
      throw new Error(`assistant-policy: intakeRuleUpdates repeats ruleId ${ruleId}`)
    }
    seen.add(ruleId)
    const enabled = entry['enabled']
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new Error(`assistant-policy: intakeRuleUpdates[${i}].enabled must be a boolean`)
    }
    const mode = entry['mode']
    if (mode !== undefined && mode !== 'observe' && mode !== 'auto') {
      throw new Error(`assistant-policy: intakeRuleUpdates[${i}].mode must be "observe" or "auto"`)
    }
    const confidenceThresholdPpm = entry['confidenceThresholdPpm']
    if (confidenceThresholdPpm !== undefined && (typeof confidenceThresholdPpm !== 'number'
      || !Number.isSafeInteger(confidenceThresholdPpm) || confidenceThresholdPpm < 0 || confidenceThresholdPpm > 1_000_000)) {
      throw new Error(`assistant-policy: intakeRuleUpdates[${i}].confidenceThresholdPpm must be an integer between 0 and 1000000`)
    }
    const minUtility = entry['minUtility']
    if (minUtility !== undefined && (typeof minUtility !== 'number' || !Number.isFinite(minUtility))) {
      throw new Error(`assistant-policy: intakeRuleUpdates[${i}].minUtility must be a finite number`)
    }
    normalized.push(Object.freeze({
      ruleId,
      ...(enabled === undefined ? {} : { enabled }),
      ...(mode === undefined ? {} : { mode }),
      ...(confidenceThresholdPpm === undefined ? {} : { confidenceThresholdPpm }),
      ...(minUtility === undefined ? {} : { minUtility }),
    }))
  }
  normalized.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0))
  return Object.freeze(normalized)
}

export function mergeIntakeRuleUpdates(
  base: readonly IntakeRuleOverrideUpdate[],
  updates: readonly IntakeRuleOverrideUpdate[],
  maxRules = MAX_INTAKE_EVALUATION_RULES,
): readonly IntakeRuleOverrideUpdate[] {
  const checkedUpdates = normalizeIntakeRuleUpdates(updates, maxRules)
  const byRule = new Map<string, IntakeRuleOverrideUpdate>()
  for (const item of normalizeIntakeRuleUpdates(base, maxRules)) {
    byRule.set(item.ruleId, item)
  }
  for (const next of checkedUpdates) {
    const prior = byRule.get(next.ruleId)
    byRule.set(next.ruleId, Object.freeze({
      ruleId: next.ruleId,
      ...(next.enabled !== undefined ? { enabled: next.enabled } : prior?.enabled !== undefined ? { enabled: prior.enabled } : {}),
      ...(next.mode !== undefined ? { mode: next.mode } : prior?.mode !== undefined ? { mode: prior.mode } : {}),
      ...(next.confidenceThresholdPpm !== undefined
        ? { confidenceThresholdPpm: next.confidenceThresholdPpm }
        : prior?.confidenceThresholdPpm !== undefined ? { confidenceThresholdPpm: prior.confidenceThresholdPpm } : {}),
      ...(next.minUtility !== undefined
        ? { minUtility: next.minUtility }
        : prior?.minUtility !== undefined ? { minUtility: prior.minUtility } : {}),
    }))
  }
  if (byRule.size > maxRules) {
    throw new Error(`assistant-policy: merged intake rule overrides exceed maximum of ${maxRules}`)
  }
  return Object.freeze(
    [...byRule.values()].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)),
  )
}
