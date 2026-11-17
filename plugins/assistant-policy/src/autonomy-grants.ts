import { compilePolicy } from './evaluator.js'
import { AssistantPolicyService, type PolicyBudgetConfig } from './service.js'
import type { PolicyRule } from './types.js'

/** Fixed 24-hour budget period used by daily autonomy automation budgets. */
export const AUTONOMY_DAILY_PERIOD_MS = 86_400_000

/** Conservative upper bound enforced on daily autonomy run budgets. */
export const MAX_AUTONOMY_DAILY_BUDGET = 10_000_000

/** Deterministic rule id prefix shared by Web-owner RSI autonomy grants. */
export const WEB_OWNER_POLICY_ID_PREFIX = 'dsh-enhanced-web-'

/** Supported preset budget tiers for Web-owner RSI autonomy setup. */
export type AutonomyBudgetTier = 'conservative' | 'balanced'

export interface AutonomyBudgetTierDefaults {
  readonly memoryMaxExtractions: number
  readonly dreamingDailyBudget: number
  readonly growthDailyBudget: number
  readonly scanDailyBudget: number
}

/** Deterministic daily run caps per preset tier. */
export const AUTONOMY_BUDGET_TIERS: Readonly<Record<AutonomyBudgetTier, AutonomyBudgetTierDefaults>> = Object.freeze({
  conservative: Object.freeze({
    memoryMaxExtractions: 10,
    dreamingDailyBudget: 2,
    growthDailyBudget: 5,
    scanDailyBudget: 1_440,
  }),
  balanced: Object.freeze({
    memoryMaxExtractions: 25,
    dreamingDailyBudget: 6,
    growthDailyBudget: 15,
    scanDailyBudget: 1_440,
  }),
})

export interface WebOwnerPolicyScope {
  readonly profile: string
  readonly workspace: string
  readonly principalId: string
  readonly ownerRouteId: string
}

export interface PolicyGrantBundle {
  readonly rules: readonly PolicyRule[]
  readonly budgets: readonly PolicyBudgetConfig[]
  readonly managedRuleIds: readonly string[]
  readonly managedBudgetIds: readonly string[]
}

export interface WebOwnerMemoryPolicyGrantInput extends WebOwnerPolicyScope {
  readonly learningAuthorityId: string
  readonly reviewAuthorityId: string
  readonly adoptionAuthorityId: string
  readonly learningBudgetId: string
  readonly scanBudgetId: string
  readonly dailyExtractionBudget: number
  readonly dailyScanBudget?: number
}

export interface WebOwnerDreamingPolicyGrantInput extends WebOwnerPolicyScope {
  readonly dreamingBudgetId: string
  readonly dailyDreamBudget: number
}

export interface WebOwnerGrowthPolicyGrantInput extends WebOwnerPolicyScope {
  readonly growthBudgetId: string
  readonly dailyGrowthBudget: number
  readonly usageLearning?: boolean
  readonly scanBudgetId?: string
  readonly dailyScanBudget?: number
}

export interface MergeAssistantPolicyGrantsInput {
  readonly rules?: readonly PolicyRule[]
  readonly budgets?: readonly PolicyBudgetConfig[]
  readonly removeRuleIds?: readonly string[]
  readonly removeBudgetIds?: readonly string[]
}

export type MergedAssistantPolicyGrants = {
  readonly rules: PolicyRule[]
  readonly budgets: PolicyBudgetConfig[]
}

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const CONTROL_CHAR_RE = /[\p{Cc}]/u

function assertIdentifier(label: string, value: unknown, maxLength = 256): string {
  if (typeof value !== 'string') {
    throw new Error(`assistant-policy: ${label} must be a non-empty string`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed !== value || trimmed.length > maxLength
    || trimmed.normalize('NFC') !== trimmed || CONTROL_CHAR_RE.test(trimmed)) {
    throw new Error(`assistant-policy: ${label} contains empty, unnormalized, or control characters`)
  }
  return trimmed
}

function assertPositiveInt(label: string, value: unknown, max = MAX_AUTONOMY_DAILY_BUDGET): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`assistant-policy: ${label} must be an integer between 1 and ${max}`)
  }
  return value
}

function assertProfile(profile: string): string {
  const checked = assertIdentifier('profile', profile, 64)
  if (!PROFILE_RE.test(checked)) {
    throw new Error(`assistant-policy: invalid profile name: ${profile}`)
  }
  return checked
}

function assertScope(input: WebOwnerPolicyScope): WebOwnerPolicyScope {
  return {
    profile: assertProfile(input.profile),
    workspace: assertIdentifier('workspace', input.workspace, 4_096),
    principalId: assertIdentifier('principalId', input.principalId, 256),
    ownerRouteId: assertIdentifier('ownerRouteId', input.ownerRouteId, 256),
  }
}

export function webOwnerPolicyPrefix(profile: string): string {
  return `${WEB_OWNER_POLICY_ID_PREFIX}${assertProfile(profile)}-`
}

export function webOwnerMemoryRuleIds(profile: string): readonly string[] {
  const prefix = webOwnerPolicyPrefix(profile)
  return Object.freeze([
    `${prefix}memory-scan-reconcile`,
    `${prefix}memory-scan-execute`,
    `${prefix}memory-job-reconcile`,
    `${prefix}memory-job-execute`,
    `${prefix}memory-extract`,
    `${prefix}memory-review`,
    `${prefix}memory-adopt`,
  ])
}

export function webOwnerDreamingRuleIds(profile: string): readonly string[] {
  const prefix = webOwnerPolicyPrefix(profile)
  return Object.freeze([
    `${prefix}dreaming-reconcile`,
    `${prefix}dreaming-execute`,
    `${prefix}dream-acknowledge`,
    `${prefix}dream-validate`,
    `${prefix}dream-reject`,
    `${prefix}dream-retire`,
  ])
}

export function webOwnerGrowthRuleIds(profile: string): readonly string[] {
  const prefix = webOwnerPolicyPrefix(profile)
  return Object.freeze([
    `${prefix}growth-usage-scan-reconcile`,
    `${prefix}growth-usage-scan-execute`,
    `${prefix}growth-job-reconcile`,
    `${prefix}growth-job-execute`,
  ])
}

export function webOwnerBudgetIds(profile: string): {
  readonly memoryLearning: string
  readonly memoryScan: string
  readonly dreaming: string
  readonly growthReviews: string
  readonly growthScan: string
} {
  const checked = assertProfile(profile)
  return Object.freeze({
    memoryLearning: `web-memory-learning-${checked}`,
    memoryScan: `web-memory-scan-${checked}`,
    dreaming: `web-dreaming-${checked}`,
    growthReviews: `web-growth-reviews-${checked}`,
    growthScan: `web-growth-scan-${checked}`,
  })
}

function freezeBundle(rules: PolicyRule[], budgets: PolicyBudgetConfig[]): PolicyGrantBundle {
  return Object.freeze({
    rules: Object.freeze(rules.map(rule => Object.freeze(structuredClone(rule)))),
    budgets: Object.freeze(budgets.map(budget => Object.freeze({ ...budget }))),
    managedRuleIds: Object.freeze(rules.map(rule => rule.id)),
    managedBudgetIds: Object.freeze(budgets.map(budget => budget.id)),
  })
}

/**
 * Compile bounded assistantPolicy rules and budgets for Web-owner memory learning
 * (extraction, independent verifier review, and personal memory adoption).
 */
export function buildWebOwnerMemoryPolicyGrants(input: WebOwnerMemoryPolicyGrantInput): PolicyGrantBundle {
  const scope = assertScope(input)
  const learningAuthorityId = assertIdentifier('learningAuthorityId', input.learningAuthorityId)
  const reviewAuthorityId = assertIdentifier('reviewAuthorityId', input.reviewAuthorityId)
  const adoptionAuthorityId = assertIdentifier('adoptionAuthorityId', input.adoptionAuthorityId)
  if (new Set([scope.ownerRouteId, learningAuthorityId, reviewAuthorityId, adoptionAuthorityId]).size !== 4) {
    throw new Error('assistant-policy: owner route, learning, review, and adoption authorityIds must be distinct')
  }
  const learningBudgetId = assertIdentifier('learningBudgetId', input.learningBudgetId)
  const scanBudgetId = assertIdentifier('scanBudgetId', input.scanBudgetId)
  if (learningBudgetId === scanBudgetId) {
    throw new Error('assistant-policy: learningBudgetId and scanBudgetId must be distinct')
  }
  const dailyExtractionBudget = assertPositiveInt('dailyExtractionBudget', input.dailyExtractionBudget)
  const dailyScanBudget = assertPositiveInt('dailyScanBudget', input.dailyScanBudget ?? AUTONOMY_BUDGET_TIERS.conservative.scanDailyBudget)
  const ruleIds = webOwnerMemoryRuleIds(scope.profile)
  const background = (id: string) => ({ kind: 'background' as const, id, workspace: scope.workspace, principal: scope.principalId })
  const bgContext = { initiators: ['background' as const] }

  const rules: PolicyRule[] = [
    { id: ruleIds[0]!, effect: 'allow', subject: background('assistant-memory-learning'), actions: ['reconcile'], resource: { kind: 'automation', id: 'memory-scan-*' }, context: bgContext },
    { id: ruleIds[1]!, effect: 'allow', subject: background('memory-scan-*'), actions: ['execute'], resource: { kind: 'automation', id: 'memory-scan-*' }, context: bgContext },
    { id: ruleIds[2]!, effect: 'allow', subject: background('assistant-memory-learning'), actions: ['reconcile'], resource: { kind: 'automation', id: 'memory-learning:*' }, context: bgContext },
    { id: ruleIds[3]!, effect: 'allow', subject: background('memory-learning:*'), actions: ['execute'], resource: { kind: 'automation', id: 'memory-learning:*' }, context: bgContext },
    { id: ruleIds[4]!, effect: 'allow', subject: background('assistant-memory-learning'), actions: ['extract'], resource: { kind: 'memory', id: `learning:${learningAuthorityId}` }, context: bgContext },
    { id: ruleIds[5]!, effect: 'allow', subject: background('assistant-memory-learning'), actions: ['review'], resource: { kind: 'memory', id: `learning:${reviewAuthorityId}` }, context: bgContext },
    { id: ruleIds[6]!, effect: 'allow', subject: background('assistant-memory-learning'), actions: ['adopt'], resource: { kind: 'memory', id: `learning:${adoptionAuthorityId}` }, context: bgContext },
  ]
  const budgets: PolicyBudgetConfig[] = [
    { id: learningBudgetId, metric: 'automation-runs', limit: dailyExtractionBudget, periodMs: AUTONOMY_DAILY_PERIOD_MS, scope: 'workspace' },
    { id: scanBudgetId, metric: 'automation-runs', limit: dailyScanBudget, periodMs: AUTONOMY_DAILY_PERIOD_MS, scope: 'subject' },
  ]
  return freezeBundle(rules, budgets)
}

/**
 * Compile bounded assistantPolicy rules and budgets for Web-owner assistant-dreaming:
 * owner-scoped background automation plus foreground owner idea lifecycle actions.
 */
export function buildWebOwnerDreamingPolicyGrants(input: WebOwnerDreamingPolicyGrantInput): PolicyGrantBundle {
  const scope = assertScope(input)
  const dreamingBudgetId = assertIdentifier('dreamingBudgetId', input.dreamingBudgetId)
  const dailyDreamBudget = assertPositiveInt('dailyDreamBudget', input.dailyDreamBudget)
  const ruleIds = webOwnerDreamingRuleIds(scope.profile)
  const automationId = `dsh-enhanced-assistant-dreaming:${scope.principalId}:${scope.ownerRouteId}`
  const bgContext = { initiators: ['background' as const] }
  const fgContext = { initiators: ['foreground' as const] }
  const ownerSubject = { kind: 'external' as const, id: scope.principalId, workspace: scope.workspace, principal: scope.principalId }
  const ideaResource = { kind: 'evolution' as const, id: 'assistant-dreaming:idea:*' }

  const rules: PolicyRule[] = [
    { id: ruleIds[0]!, effect: 'allow', subject: { kind: 'background', id: 'assistant-dreaming', workspace: scope.workspace, principal: scope.principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: automationId }, context: bgContext },
    { id: ruleIds[1]!, effect: 'allow', subject: { kind: 'background', id: automationId, workspace: scope.workspace, principal: scope.principalId }, actions: ['execute'], resource: { kind: 'automation', id: automationId }, context: bgContext },
    { id: ruleIds[2]!, effect: 'allow', subject: ownerSubject, actions: ['dream.acknowledge'], resource: ideaResource, context: fgContext },
    { id: ruleIds[3]!, effect: 'allow', subject: ownerSubject, actions: ['dream.validate'], resource: ideaResource, context: fgContext },
    { id: ruleIds[4]!, effect: 'allow', subject: ownerSubject, actions: ['dream.reject'], resource: ideaResource, context: fgContext },
    { id: ruleIds[5]!, effect: 'allow', subject: ownerSubject, actions: ['dream.retire'], resource: ideaResource, context: fgContext },
  ]
  const budgets: PolicyBudgetConfig[] = [
    { id: dreamingBudgetId, metric: 'automation-runs', limit: dailyDreamBudget, periodMs: AUTONOMY_DAILY_PERIOD_MS, scope: 'subject' },
  ]
  return freezeBundle(rules, budgets)
}

/**
 * Compile bounded assistantPolicy budgets (and optional usage-scan rules) for
 * Web-owner assistant-growth-driver intake.
 */
export function buildWebOwnerGrowthPolicyGrants(input: WebOwnerGrowthPolicyGrantInput): PolicyGrantBundle {
  const scope = assertScope(input)
  const growthBudgetId = assertIdentifier('growthBudgetId', input.growthBudgetId)
  const dailyGrowthBudget = assertPositiveInt('dailyGrowthBudget', input.dailyGrowthBudget)
  const usageLearning = input.usageLearning === true

  const rules: PolicyRule[] = []
  const budgets: PolicyBudgetConfig[] = [
    { id: growthBudgetId, metric: 'automation-runs', limit: dailyGrowthBudget, periodMs: AUTONOMY_DAILY_PERIOD_MS, scope: 'workspace' },
  ]

  if (usageLearning) {
    const scanBudgetId = assertIdentifier('scanBudgetId', input.scanBudgetId)
    if (scanBudgetId === growthBudgetId) {
      throw new Error('assistant-policy: growthBudgetId and scanBudgetId must be distinct')
    }
    const dailyScanBudget = assertPositiveInt('dailyScanBudget', input.dailyScanBudget ?? AUTONOMY_BUDGET_TIERS.conservative.scanDailyBudget)
    const ruleIds = webOwnerGrowthRuleIds(scope.profile)
    const background = (id: string) => ({ kind: 'background' as const, id, workspace: scope.workspace, principal: scope.principalId })
    const bgContext = { initiators: ['background' as const] }
    rules.push(
      { id: ruleIds[0]!, effect: 'allow', subject: background('assistant-growth-driver'), actions: ['reconcile'], resource: { kind: 'automation', id: 'usage-scan-*' }, context: bgContext },
      { id: ruleIds[1]!, effect: 'allow', subject: background('usage-scan-*'), actions: ['execute'], resource: { kind: 'automation', id: 'usage-scan-*' }, context: bgContext },
      { id: ruleIds[2]!, effect: 'allow', subject: background('assistant-growth-driver'), actions: ['reconcile'], resource: { kind: 'automation', id: 'source-growth:*' }, context: bgContext },
      { id: ruleIds[3]!, effect: 'allow', subject: background('source-growth:*'), actions: ['execute'], resource: { kind: 'automation', id: 'source-growth:*' }, context: bgContext },
    )
    budgets.push({ id: scanBudgetId, metric: 'automation-runs', limit: dailyScanBudget, periodMs: AUTONOMY_DAILY_PERIOD_MS, scope: 'subject' })
  }

  return freezeBundle(rules, budgets)
}

function asConfigArray(value: unknown, field: 'rules' | 'budgets'): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`assistant-policy: existing ${field} must be an array`)
  }
  return structuredClone(value) as unknown[]
}

function entryId(value: unknown, label: string): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`assistant-policy: existing ${label} entry must be an object`)
  }
  return assertIdentifier(`${label}.id`, (value as { id?: unknown }).id)
}

/**
 * Idempotently merge or remove managed rules/budgets while preserving existing
 * user rules and validating the resulting configuration against `configSchema`.
 */
export function mergeAssistantPolicyGrants(
  existingConfig: Readonly<Record<string, unknown>> | undefined,
  grant: MergeAssistantPolicyGrantsInput,
): MergedAssistantPolicyGrants {
  if (existingConfig !== undefined && (existingConfig === null || typeof existingConfig !== 'object' || Array.isArray(existingConfig))) {
    throw new Error('assistant-policy: existingConfig must be a plain object when provided')
  }
  const baseRules = asConfigArray(existingConfig?.rules, 'rules')
  const baseBudgets = asConfigArray(existingConfig?.budgets, 'budgets')

  const grantRules = grant.rules ?? []
  const grantBudgets = grant.budgets ?? []
  const removeRules = new Set((grant.removeRuleIds ?? []).map(id => assertIdentifier('removeRuleIds[]', id)))
  const removeBudgets = new Set((grant.removeBudgetIds ?? []).map(id => assertIdentifier('removeBudgetIds[]', id)))

  const incomingRuleMap = new Map<string, PolicyRule>()
  for (const rule of grantRules) {
    const id = assertIdentifier('rule.id', rule.id)
    if (incomingRuleMap.has(id)) throw new Error(`assistant-policy: duplicate incoming rule id: ${id}`)
    incomingRuleMap.set(id, structuredClone(rule))
  }

  const incomingBudgetMap = new Map<string, PolicyBudgetConfig>()
  for (const budget of grantBudgets) {
    const id = assertIdentifier('budget.id', budget.id)
    if (incomingBudgetMap.has(id)) throw new Error(`assistant-policy: duplicate incoming budget id: ${id}`)
    incomingBudgetMap.set(id, { ...budget })
  }

  const seenExistingRuleIds = new Set<string>()
  const mergedRules: PolicyRule[] = []
  for (const item of baseRules) {
    const id = entryId(item, 'rule')
    if (seenExistingRuleIds.has(id)) throw new Error(`assistant-policy: duplicate existing rule id: ${id}`)
    seenExistingRuleIds.add(id)
    if (removeRules.has(id)) continue
    const replacement = incomingRuleMap.get(id)
    if (replacement) {
      mergedRules.push(replacement)
      incomingRuleMap.delete(id)
    } else {
      mergedRules.push(item as PolicyRule)
    }
  }
  for (const rule of incomingRuleMap.values()) mergedRules.push(rule)

  const seenExistingBudgetIds = new Set<string>()
  const mergedBudgets: PolicyBudgetConfig[] = []
  for (const item of baseBudgets) {
    const id = entryId(item, 'budget')
    if (seenExistingBudgetIds.has(id)) throw new Error(`assistant-policy: duplicate existing budget id: ${id}`)
    seenExistingBudgetIds.add(id)
    if (removeBudgets.has(id)) continue
    const replacement = incomingBudgetMap.get(id)
    if (replacement) {
      mergedBudgets.push(replacement)
      incomingBudgetMap.delete(id)
    } else {
      mergedBudgets.push(item as PolicyBudgetConfig)
    }
  }
  for (const budget of incomingBudgetMap.values()) mergedBudgets.push(budget)

  const existingDbPath = typeof existingConfig?.databasePath === 'string' && existingConfig.databasePath.length > 0
    ? existingConfig.databasePath
    : '/tmp/.dsh-policy-validate.sqlite'
  const validated = AssistantPolicyService.Config({
    ...existingConfig,
    databasePath: existingDbPath,
    rules: mergedRules,
    budgets: mergedBudgets,
  })
  const rules = (validated.rules ?? []) as PolicyRule[]
  const budgets = (validated.budgets ?? []) as PolicyBudgetConfig[]
  compilePolicy(rules)

  return {
    rules: structuredClone(rules),
    budgets: structuredClone(budgets),
  }
}
