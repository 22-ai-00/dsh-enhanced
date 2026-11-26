import type { GoalScope, VerifiedWorkflowSource } from '@dsh-ray/assistant-goals'
import { acceptanceDigest } from '@dsh-ray/task-acceptance-contract'
export type { VerifiedWorkflowSource } from '@dsh-ray/assistant-goals'

export type SkillScalar = string | number | boolean
export type SkillInputType = 'string' | 'number' | 'boolean'

export interface SkillBinding { name: string; stepId: string; path: string }
export interface SkillInput extends SkillBinding { type: SkillInputType; default: SkillScalar }
export interface SkillStep { id: string; toolName: string; arguments: unknown; dependsOn: readonly string[] }
export interface SkillFileObservations { protocol: 'assistant-skills/file-observations/v1'; beforeSteps: readonly string[] }
export interface SkillRunExpansion {
  protocol: 'assistant-skills/run-expansion/v1'
  callId: string
  runId: string
  runDigest: string
  definitionDigest: string
  inputsDigest: string
  steps: readonly { id: string; toolName: string; arguments: unknown }[]
}
export const WORKFLOW_FAMILY_IDS = [
  'repo-ci-fix',
  'calendar-meeting-prep',
  'email-inbox-triage',
  'wiki-knowledge-synthesis',
  'dependency-config-audit',
] as const

export type WorkflowFamilyId = (typeof WORKFLOW_FAMILY_IDS)[number]

/**
 * Closed, fail-closed precondition families a captured skill may require at
 * dispatch. Every family retains current owner policy-scope matching and a
 * Goal distinct from the captured source Goal.
 */
export const SUPPORTED_SKILL_PRECONDITIONS = [
  'current-owner-policy-and-fresh-goal',
  'clean-git-worktree-and-policy-grant',
  'calendar-window-and-route-binding',
  'authenticated-inbox-and-idempotency-key',
  'wiki-vault-revision-and-owner-scope',
  'workspace-manifest-and-isolation-grant',
] as const

export type SkillPreconditionKind = (typeof SUPPORTED_SKILL_PRECONDITIONS)[number]

export type SkillPreconditionCheckKind =
  | 'path-exists'
  | 'path-absent'
  | 'path-regular-file'
  | 'tool-available'
  | 'input-nonempty'
  | 'time-window'
  | 'workflow-family'

export interface SkillPreconditionCheck {
  readonly id: string
  readonly kind: SkillPreconditionCheckKind
  readonly path?: string
  readonly toolName?: string
  readonly inputName?: string
  readonly notBefore?: number
  readonly notAfter?: number
  readonly workflowFamily?: WorkflowFamilyId
}

export interface SkillPreconditionPlan {
  readonly protocol: 'assistant-skills/precondition-plan/v1'
  readonly kind: SkillPreconditionKind
  readonly workflowFamily?: WorkflowFamilyId
  readonly checks: readonly SkillPreconditionCheck[]
}

/**
 * Discriminated compensation families governing a run after a step failure.
 */
export type SkillCompensationKind =
  | 'stop-and-report'
  | 'compensate-via-registry'
  | 'compensating-action'
  | 'rollback-state'

export interface SkillCompensationStepSpec {
  stepId: string
  compensatorKey?: string
  toolName?: string
  arguments?: unknown
  capturePreimage?: boolean
}

export interface SkillCompensationPlan {
  protocol: 'assistant-skills/compensation-plan/v1'
  kind: Exclude<SkillCompensationKind, 'stop-and-report'>
  entries: readonly SkillCompensationStepSpec[]
}

export interface SkillDefinition {
  protocol: 'assistant-skills/definition/v1'
  name: string
  description: string
  source: VerifiedWorkflowSource
  inputs: readonly SkillInput[]
  steps: readonly SkillStep[]
  fileObservations?: SkillFileObservations
  runExpansions?: readonly SkillRunExpansion[]
  preconditions: SkillPreconditionKind
  preconditionPlan?: SkillPreconditionPlan
  workflowFamily?: WorkflowFamilyId
  compensation: SkillCompensationKind
  compensationPlan?: SkillCompensationPlan
}

export type FailureCaptureCategory = 'objective-not-achieved' | 'repeated-not-achieved'
export interface FailureCaptureGoalIdentity {
  id: string
  definition: { version: number; digest: string; objective: string }
  sessionId: string
  nativeGoalId: string
}
export interface HostFailureEvidenceObservation {
  goal: FailureCaptureGoalIdentity
  runId: string
  execution: { status: 'succeeded'; quiescent: true }
  outcome: 'not-achieved'
  acceptance: { contractId: string; contractDigest: string; receiptDigest: string; verifiedAt: number; validUntil: number }
  traceDigest: string
}
export interface HostFailureEvidenceSummary {
  protocol: 'assistant-skills/host-failure-evidence/v1'
  scope: GoalScope
  taskFamily: { id: string; definitionDigest: string; objective: string }
  failureCategory: FailureCaptureCategory
  triggerCondition: { kind: 'not-achieved-count'; minimumOccurrences: number; windowStartedAt: number; windowEndedAt: number }
  failures: readonly HostFailureEvidenceObservation[]
  repairGoal: FailureCaptureGoalIdentity
  attestedAt: number
  evidence: { producer: 'assistant-goals'; generation: string; digest: string }
}
export interface FailureCaptureProvenance {
  protocol: 'assistant-skills/failure-capture-provenance/v1'
  trigger: HostFailureEvidenceSummary
  repair: { goal: FailureCaptureGoalIdentity; runId: string; sourceDigest: string; acceptanceDigest: string }
  parent: { name: string; version: number; digest: string }
  candidate: { name: string; definitionDigest: string }
  /** Diagnostic structural delta only. It is not an admission or authorization decision. */
  permissionDelta: { parent: readonly string[]; candidate: readonly string[]; added: readonly string[]; removed: readonly string[]; expandsAuthority: boolean }
  rollbackTarget: { name: string; version: number; digest: string }
}

export interface CreateDefinitionOptions {
  name: string
  description: string
  bindings?: readonly SkillBinding[]
  preconditions?: SkillPreconditionKind
  preconditionPlan?: Omit<SkillPreconditionPlan, 'protocol'>
  workflowFamily?: WorkflowFamilyId
  compensation?: SkillCompensationKind
  compensationPlan?: Omit<SkillCompensationPlan, 'protocol'>
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const maximumArgumentsBytes = 256 * 1024
const digestPattern = /^[a-f0-9]{64}$/u

function fail(message = 'assistant-skills: invalid definition'): never { throw new Error(message) }
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\p{Cc}]/u.test(value)
}
function scalar(value: unknown): value is SkillScalar {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
}
function clone<T>(value: T): T {
  if (!json(value)) fail()
  return JSON.parse(JSON.stringify(value)) as T
}
function json(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor) || !json(descriptor.value)) return false
    }
    return true
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false
  return Object.keys(value).every(key => {
    if (forbidden.has(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor && json(descriptor.value)
  })
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return json(value) && value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function boundedArray(value: unknown, maximum: number): value is readonly unknown[] {
  return Array.isArray(value) && value.length <= maximum && Object.getOwnPropertySymbols(value).length === 0
    && Reflect.ownKeys(value).length === value.length + 1
}
function integer(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum }
function digestValue(value: unknown): value is string { return typeof value === 'string' && digestPattern.test(value) }
function goalScope(value: unknown): value is GoalScope {
  return exact(value, ['principalId', 'principalRecordId', 'principalVersion', 'workspace', 'preset'])
    && text(value.principalId, 256) && text(value.principalRecordId, 256) && integer(value.principalVersion, 1)
    && typeof value.workspace === 'string' && value.workspace.startsWith('/') && value.workspace.length <= 4096 && text(value.preset, 256)
}
function failureGoal(value: unknown): value is FailureCaptureGoalIdentity {
  if (!exact(value, ['id', 'definition', 'sessionId', 'nativeGoalId']) || !text(value.id, 256) || !text(value.sessionId, 256) || !text(value.nativeGoalId, 256)
    || !exact(value.definition, ['version', 'digest', 'objective']) || !integer(value.definition.version, 1) || !digestValue(value.definition.digest) || !text(value.definition.objective, 16_384)) return false
  return value.definition.digest === acceptanceDigest({ objective: value.definition.objective })
}
function failureAcceptance(value: unknown): value is HostFailureEvidenceObservation['acceptance'] {
  return exact(value, ['contractId', 'contractDigest', 'receiptDigest', 'verifiedAt', 'validUntil']) && text(value.contractId, 256)
    && digestValue(value.contractDigest) && digestValue(value.receiptDigest) && integer(value.verifiedAt, 0) && integer(value.validUntil, 1)
    && value.validUntil > value.verifiedAt
}

/**
 * Canonical integrity digest for a failure summary. This public SHA-256 does
 * not authenticate its producer; trust exists only while the value is obtained
 * directly from the current AssistantGoalsService capability.
 */
export function failureSummaryEvidenceDigest(value: Omit<HostFailureEvidenceSummary, 'evidence'>, generation: string): string {
  if (!text(generation, 256) || !json(value)) fail('assistant-skills: invalid failure evidence')
  return acceptanceDigest({ ...clone(value), evidence: { producer: 'assistant-goals', generation } })
}

/**
 * Validate the structure and integrity linkage of Host failure evidence. This
 * never establishes provenance: callers must receive the value directly from
 * the current AssistantGoalsService capability, not from model or stored input.
 */
export function validateHostFailureEvidenceSummary(value: unknown): Readonly<HostFailureEvidenceSummary> {
  if (!exact(value, ['protocol', 'scope', 'taskFamily', 'failureCategory', 'triggerCondition', 'failures', 'repairGoal', 'attestedAt', 'evidence'])
    || value.protocol !== 'assistant-skills/host-failure-evidence/v1' || !goalScope(value.scope)
    || !exact(value.taskFamily, ['id', 'definitionDigest', 'objective']) || !/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(String(value.taskFamily.id))
    || !digestValue(value.taskFamily.definitionDigest) || !text(value.taskFamily.objective, 16_384)
    || value.taskFamily.definitionDigest !== acceptanceDigest({ objective: value.taskFamily.objective })
    || value.failureCategory !== 'objective-not-achieved' && value.failureCategory !== 'repeated-not-achieved'
    || !exact(value.triggerCondition, ['kind', 'minimumOccurrences', 'windowStartedAt', 'windowEndedAt']) || value.triggerCondition.kind !== 'not-achieved-count'
    || !integer(value.triggerCondition.minimumOccurrences, 1) || value.triggerCondition.minimumOccurrences > 32
    || !integer(value.triggerCondition.windowStartedAt, 0) || !integer(value.triggerCondition.windowEndedAt, 0) || value.triggerCondition.windowEndedAt < value.triggerCondition.windowStartedAt
    || !boundedArray(value.failures, 32) || value.failures.length < value.triggerCondition.minimumOccurrences || !failureGoal(value.repairGoal)
    || !integer(value.attestedAt, 0) || !exact(value.evidence, ['producer', 'generation', 'digest']) || value.evidence.producer !== 'assistant-goals'
    || !text(value.evidence.generation, 256) || !digestValue(value.evidence.digest)) fail('assistant-skills: invalid Host failure summary')
  const input = value as unknown as HostFailureEvidenceSummary
  if (input.failureCategory === 'objective-not-achieved' && (input.triggerCondition.minimumOccurrences !== 1 || input.failures.length !== 1)
    || input.failureCategory === 'repeated-not-achieved' && input.triggerCondition.minimumOccurrences < 2) fail('assistant-skills: invalid failure trigger condition')
  const ids = new Set<string>(); const sessions = new Set<string>(); const runs = new Set<string>(); const nativeGoals = new Set<string>()
  for (const failure of input.failures) {
    if (!exact(failure, ['goal', 'runId', 'execution', 'outcome', 'acceptance', 'traceDigest']) || !failureGoal(failure.goal) || !text(failure.runId, 256)
      || !exact(failure.execution, ['status', 'quiescent']) || failure.execution.status !== 'succeeded' || failure.execution.quiescent !== true
      || failure.outcome !== 'not-achieved' || !failureAcceptance(failure.acceptance) || !digestValue(failure.traceDigest)
      || failure.goal.definition.digest !== input.taskFamily.definitionDigest || failure.goal.definition.objective !== input.taskFamily.objective
      || failure.acceptance.verifiedAt < input.triggerCondition.windowStartedAt || failure.acceptance.verifiedAt > input.triggerCondition.windowEndedAt
      || failure.acceptance.verifiedAt > input.attestedAt || failure.acceptance.validUntil <= input.attestedAt
      || ids.has(failure.goal.id) || sessions.has(failure.goal.sessionId) || runs.has(failure.runId) || nativeGoals.has(failure.goal.nativeGoalId)) {
      fail('assistant-skills: invalid Host failure observation')
    }
    ids.add(failure.goal.id); sessions.add(failure.goal.sessionId); runs.add(failure.runId); nativeGoals.add(failure.goal.nativeGoalId)
  }
  if (input.repairGoal.definition.digest !== input.taskFamily.definitionDigest || input.repairGoal.definition.objective !== input.taskFamily.objective
    || ids.has(input.repairGoal.id) || sessions.has(input.repairGoal.sessionId) || nativeGoals.has(input.repairGoal.nativeGoalId)) fail('assistant-skills: failure repair Goal is not independent')
  const { evidence, ...summary } = input
  if (evidence.digest !== failureSummaryEvidenceDigest(summary as Omit<HostFailureEvidenceSummary, 'evidence'>, evidence.generation)) fail('assistant-skills: failure evidence digest changed')
  return freeze(input)
}

/** Validate a self-contained candidate provenance envelope before persistence or comparison. */
export function validateFailureCaptureProvenance(value: unknown): Readonly<FailureCaptureProvenance> {
  if (!exact(value, ['protocol', 'trigger', 'repair', 'parent', 'candidate', 'permissionDelta', 'rollbackTarget'])
    || value.protocol !== 'assistant-skills/failure-capture-provenance/v1') fail('assistant-skills: invalid failure capture provenance')
  const input = value as unknown as FailureCaptureProvenance
  validateHostFailureEvidenceSummary(input.trigger)
  if (!exact(input.repair, ['goal', 'runId', 'sourceDigest', 'acceptanceDigest']) || !failureGoal(input.repair.goal) || !text(input.repair.runId, 256)
    || !digestValue(input.repair.sourceDigest) || !digestValue(input.repair.acceptanceDigest)
    || acceptanceDigest(input.repair.goal) !== acceptanceDigest(input.trigger.repairGoal)
    || input.trigger.failures.some(failure => failure.runId === input.repair.runId)) fail('assistant-skills: invalid achieved repair provenance')
  const versioned = (item: unknown): item is { name: string; version: number; digest: string } => exact(item, ['name', 'version', 'digest'])
    && /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(String(item.name)) && integer(item.version, 1) && digestValue(item.digest)
  if (!versioned(input.parent) || !exact(input.candidate, ['name', 'definitionDigest']) || input.candidate.name !== input.parent.name || !digestValue(input.candidate.definitionDigest)
    || !versioned(input.rollbackTarget) || acceptanceDigest(input.rollbackTarget) !== acceptanceDigest(input.parent)) fail('assistant-skills: invalid parent or rollback provenance')
  // This proves only that the reported tool-name delta matches the two
  // definitions. Policy must independently authorize every future execution.
  if (!exact(input.permissionDelta, ['parent', 'candidate', 'added', 'removed', 'expandsAuthority'])) fail('assistant-skills: invalid permission delta')
  const lists = ['parent', 'candidate', 'added', 'removed'] as const
  for (const key of lists) if (!boundedArray(input.permissionDelta[key], 256) || input.permissionDelta[key].some(item => !text(item, 256))
    || new Set(input.permissionDelta[key]).size !== input.permissionDelta[key].length
    || [...input.permissionDelta[key]].sort().some((item, index) => item !== input.permissionDelta[key][index])) fail('assistant-skills: invalid permission delta')
  const parent = new Set(input.permissionDelta.parent), candidate = new Set(input.permissionDelta.candidate)
  if (acceptanceDigest(input.permissionDelta.added) !== acceptanceDigest([...candidate].filter(item => !parent.has(item)).sort())
    || acceptanceDigest(input.permissionDelta.removed) !== acceptanceDigest([...parent].filter(item => !candidate.has(item)).sort())
    || input.permissionDelta.expandsAuthority !== (input.permissionDelta.added.length > 0)) fail('assistant-skills: permission delta changed')
  return freeze(input)
}
function freeze<T>(value: T): Readonly<T> { return Object.freeze(clone(value)) }
function pointer(path: string): string[] {
  if (path === '' || !path.startsWith('/')) fail('assistant-skills: binding path is invalid')
  return path.slice(1).split('/').map(part => {
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (decoded === '' || forbidden.has(decoded)) fail('assistant-skills: binding path is invalid')
    return decoded
  })
}
function at(root: unknown, path: string): SkillScalar {
  let current: unknown = root
  for (const part of pointer(path)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(part) || Number(part) >= current.length) fail('assistant-skills: binding path is missing')
      current = current[Number(part)]
    } else if (current && typeof current === 'object' && Object.getPrototypeOf(current) === Object.prototype && Object.hasOwn(current, part)) {
      current = (current as Record<string, unknown>)[part]
    } else fail('assistant-skills: binding path is missing')
  }
  if (!scalar(current)) fail('assistant-skills: binding value must be scalar')
  return current
}
function replace(root: unknown, path: string, value: SkillScalar): void {
  const parts = pointer(path); let current: unknown = root
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(current)) current = current[Number(part)]
    else current = (current as Record<string, unknown>)[part]
  }
  const final = parts.at(-1)!
  if (Array.isArray(current)) current[Number(final)] = value
  else (current as Record<string, unknown>)[final] = value
}
function inputType(value: SkillScalar): SkillInputType {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  return 'boolean'
}
function controlTool(name: string, arguments_: unknown): boolean {
  const normalized = name.toLowerCase()
  // Native get_goal is a parameterless read of the current Goal. It is only
  // reusable when the Host explicitly allowlists it; all other goal controls
  // remain excluded from captured tool compositions.
  if (normalized === 'get_goal') return !arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)
    || Object.getPrototypeOf(arguments_) !== Object.prototype || Object.getOwnPropertySymbols(arguments_).length !== 0 || Object.keys(arguments_).length !== 0
  return normalized.startsWith('goal_') || normalized.startsWith('skill') || normalized.includes('workflow') || normalized.includes('subagent')
    || ['create_goal', 'update_goal', 'run_code', 'javascript'].includes(normalized)
}
function failedProbe(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  const observation = value as { id?: unknown; toolName?: unknown; arguments?: unknown; outcome?: unknown }
  if (!text(observation.id, 256) || !text(observation.toolName, 256) || observation.outcome !== 'failed' || !json(observation.arguments)) return false
  if (observation.toolName === 'read' || observation.toolName === 'glob' || observation.toolName === 'grep') return true
  return observation.toolName === 'get_goal' && !controlTool('get_goal', observation.arguments)
}

/** The session-owned todo list is planning provenance, never a reusable action. */
function todoWrite(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false
  if (!Object.hasOwn(value, 'todos') || Object.keys(value).length !== 1 || !Array.isArray((value as { todos?: unknown }).todos)) return false
  const contents = new Set<string>()
  for (const todo of (value as { todos: unknown[] }).todos) {
    if (!todo || typeof todo !== 'object' || Array.isArray(todo) || Object.getPrototypeOf(todo) !== Object.prototype || Object.getOwnPropertySymbols(todo).length !== 0
      || Object.keys(todo).length !== 2 || !Object.hasOwn(todo, 'content') || !Object.hasOwn(todo, 'status') || typeof (todo as { content?: unknown }).content !== 'string'
      || !['pending', 'in_progress', 'completed'].includes((todo as { status?: unknown }).status as string)) return false
    const content = (todo as { content: string }).content.trim()
    if (!content || contents.has(content)) return false
    contents.add(content)
  }
  return true
}

type TraceStep = { id: string; toolName: string; arguments: unknown }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function validExpansion(value: unknown): value is SkillRunExpansion {
  if (!json(value) || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 7) return false
  const expansion = value as Partial<SkillRunExpansion>
  if (expansion.protocol !== 'assistant-skills/run-expansion/v1' || !text(expansion.callId, 256) || !text(expansion.runId, 256)
    || !digest(expansion.runDigest) || !digest(expansion.definitionDigest) || !digest(expansion.inputsDigest) || !Array.isArray(expansion.steps) || expansion.steps.length === 0 || expansion.steps.length > 32) return false
  const ids = new Set<string>()
  return expansion.steps.every(step => json(step) && step && typeof step === 'object' && !Array.isArray(step) && Object.keys(step).length === 3
    && text((step as TraceStep).id, 256) && text((step as TraceStep).toolName, 256) && json((step as TraceStep).arguments) && !ids.has((step as TraceStep).id) && (ids.add((step as TraceStep).id), true))
}
function expandSkillRuns(sourceSteps: readonly TraceStep[], observations: readonly unknown[], expansions: readonly SkillRunExpansion[]): readonly TraceStep[] {
  if (!Array.isArray(expansions) || expansions.length > 32 || expansions.some(value => !validExpansion(value))) fail('assistant-skills: invalid run expansion')
  const calls = new Map<string, SkillRunExpansion>(); const runs = new Set<string>()
  for (const expansion of expansions) {
    if (calls.has(expansion.callId) || runs.has(expansion.runId)) fail('assistant-skills: invalid run expansion')
    calls.set(expansion.callId, expansion)
    // Stored step IDs belong to a definition and repeat across distinct runs.
    // An idempotent response for the same run is not another execution.
    runs.add(expansion.runId)
  }
  const sourceCalls = new Set(sourceSteps.filter(step => step?.toolName === 'skill_run' && typeof step.id === 'string').map(step => step.id))
  if ([...calls.keys()].some(callId => !sourceCalls.has(callId))) fail('assistant-skills: invalid run expansion')
  const proofBytes = expansions.length === 0 ? [] : [expansions]
  if (Buffer.byteLength(JSON.stringify([...sourceSteps.map(step => step.arguments), ...observations.map(value => (value as { arguments?: unknown }).arguments), ...proofBytes]), 'utf8') > maximumArgumentsBytes) fail('assistant-skills: bounded run expansion is required')
  return sourceSteps.flatMap(step => {
    const expansion = step.toolName === 'skill_run' ? calls.get(step.id) : undefined
    return expansion === undefined ? [step] : expansion.steps.map(expanded => ({ id: `expanded:${acceptanceDigest([expansion.callId, expanded.id])}`, toolName: expanded.toolName, arguments: expanded.arguments }))
  })
}

type StandardFileMutator = { id: string; toolName: 'write' | 'edit'; arguments: Record<string, unknown> }
function standardFileMutators(steps: readonly SkillStep[]): StandardFileMutator[] {
  const output: StandardFileMutator[] = []
  for (const step of steps) {
    if (step.toolName !== 'write' && step.toolName !== 'edit' || !step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments)
      || Object.getPrototypeOf(step.arguments) !== Object.prototype || Object.getOwnPropertySymbols(step.arguments).length !== 0) continue
    const args = step.arguments as Record<string, unknown>
    const allowed = step.toolName === 'write' ? ['file_path', 'content'] : ['file_path', 'old_string', 'new_string', 'replace_all']
    if (Object.keys(args).some(key => !allowed.includes(key)) || !text(args.file_path, 4096)
      || step.toolName === 'write' && typeof args.content !== 'string'
      || step.toolName === 'edit' && (typeof args.old_string !== 'string' || typeof args.new_string !== 'string' || args.replace_all !== undefined && typeof args.replace_all !== 'boolean')) continue
    output.push({ id: step.id, toolName: step.toolName, arguments: args })
  }
  return output
}
function fileObservations(definition: SkillDefinition): readonly StandardFileMutator[] {
  const value = definition.fileObservations
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0
    || Object.keys(value).length !== 2 || value.protocol !== 'assistant-skills/file-observations/v1' || !Array.isArray(value.beforeSteps)
    || value.beforeSteps.some(id => !text(id, 256))) fail('assistant-skills: invalid file observations')
  const mutators = standardFileMutators(definition.steps)
  if (definition.steps.length + value.beforeSteps.length > 32 || value.beforeSteps.length !== mutators.length
    || value.beforeSteps.some((id, index) => id !== mutators[index]?.id) || new Set(value.beforeSteps).size !== value.beforeSteps.length) fail('assistant-skills: invalid file observations')
  if (Buffer.byteLength(JSON.stringify([...definition.steps.map(step => step.arguments), ...mutators.map(step => ({ file_path: step.arguments.file_path, limit: 1 }))]), 'utf8') > maximumArgumentsBytes) fail('assistant-skills: file observations exceed argument limit')
  const observationIds = mutators.map((_step, index) => `file-observation:${index + 1}`)
  if (new Set(definition.steps.map(step => step.id)).size !== definition.steps.length || observationIds.some(id => definition.steps.some(step => step.id === id))) fail('assistant-skills: invalid file observations')
  return mutators
}

/** Derive the native reads which establish file-observation policy state for an instantiated definition. */
export function fileObservationSteps(definition: SkillDefinition): readonly { id: string; beforeStepId: string; filePath: string; allowAbsent: boolean }[] {
  return Object.freeze(fileObservations(definition).map((step, index) => Object.freeze({ id: `file-observation:${index + 1}`, beforeStepId: step.id,
    filePath: step.arguments.file_path as string, allowAbsent: step.toolName === 'write' })))
}

/** Successful source-Goal planning notes are provenance, never reusable authority. */
function sourceCheckpoint(value: unknown, goalId: string): boolean {
  if (!json(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const args = value as Record<string, unknown>
  const keys = ['goal_id', 'expected_version', 'next_step', 'blockers', 'assumptions', 'evidence_refs', 'dependencies']
  const strings = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === 'string')
  return Object.keys(args).length === keys.length && Object.keys(args).every(key => keys.includes(key))
    && args.goal_id === goalId && Number.isSafeInteger(args.expected_version) && (args.expected_version as number) > 0
    && typeof args.next_step === 'string' && strings(args.blockers) && strings(args.evidence_refs) && strings(args.dependencies)
    && Array.isArray(args.assumptions) && args.assumptions.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).length === 2 && Object.keys(item).every(key => ['statement', 'expires_at'].includes(key))
      && typeof item.statement === 'string' && Number.isSafeInteger(item.expires_at) && item.expires_at > 0)
}

/** A source-Goal read is provenance only; it can never become a reusable step. */
function sourceGoalContext(value: unknown, goalId: string): boolean {
  if (!json(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const args = value as Record<string, unknown>, keys = Object.keys(args)
  return keys.every(key => key === 'goal_id' || key === 'focus')
    && (keys.length === 0 || args.goal_id === goalId && (keys.length === 1 || args.focus === false))
}

/** Multi-round provenance is explicit; the v1 top-level still names the final accepted run. */
function sourceProjection(source: VerifiedWorkflowSource) {
  if (source.segments === undefined) return { steps: source.steps, observations: source.failedObservations ?? [] }
  const segments = source.segments
  if (!Array.isArray(segments) || segments.length < 2 || segments.length > 32) fail('assistant-skills: invalid source segments')
  const runs = new Set<string>()
  for (const [index, segment] of segments.entries()) {
    if (!segment || !text(segment.runId, 256) || runs.has(segment.runId) || segment.round !== index + 1
      || !Number.isSafeInteger(segment.turn) || segment.turn < 1 || index > 0 && segment.turn <= segments[index - 1]!.turn
      || !Number.isSafeInteger(segment.nativeRevision) || segment.nativeRevision < 0 || !Array.isArray(segment.steps)
      || segment.failedObservations !== undefined && !Array.isArray(segment.failedObservations)) fail('assistant-skills: invalid source segment')
    runs.add(segment.runId)
  }
  const final = segments.at(-1)!
  if (final.runId !== source.runId || final.turn !== source.turn || acceptanceDigest(final.steps) !== acceptanceDigest(source.steps)
    || acceptanceDigest(final.failedObservations ?? []) !== acceptanceDigest(source.failedObservations ?? [])) fail('assistant-skills: final source segment mismatch')
  return { steps: segments.flatMap(segment => segment.steps), observations: segments.flatMap(segment => segment.failedObservations ?? []) }
}

/**
 * Validate the dependency DAG of a captured step list.
 *
 * Edges are general (a step may declare multiple dependencies) but the stored
 * array is required to be in topological order: every dependency must reference
 * an earlier step. That single rule simultaneously enforces reference
 * validity, no self-loop, and acyclicity (the index differences around a cycle
 * cannot all be negative), and it preserves the positional invariants the
 * sequential executor and the index-aligned file observations rely on.
 */
export function validateStepGraph(steps: readonly Pick<SkillStep, 'id' | 'dependsOn'>[]): void {
  if (!Array.isArray(steps) || steps.length > 32) fail('assistant-skills: invalid dependency graph')
  const position = new Map<string, number>()
  steps.forEach((step, index) => {
    if (!step || typeof step.id !== 'string' || position.has(step.id)) fail('assistant-skills: invalid dependency graph')
    position.set(step.id, index)
  })
  steps.forEach((step, index) => {
    if (!Array.isArray(step.dependsOn)) fail('assistant-skills: invalid dependency graph')
    const seen = new Set<string>()
    for (const dependency of step.dependsOn) {
      const at = typeof dependency === 'string' ? position.get(dependency) : undefined
      if (at === undefined || seen.has(dependency)) fail('assistant-skills: invalid dependency graph')
      // A dependency on the current or a later step is a self-loop, a cycle, or
      // non-topological storage; all three would break ordered replay.
      if (at >= index) fail('assistant-skills: dependency graph must be topologically ordered')
      seen.add(dependency)
    }
  })
}

/** Supported closed precondition families; unknown values always fail closed. */
const preconditionKinds = new Set<SkillPreconditionKind>(SUPPORTED_SKILL_PRECONDITIONS)
const workflowFamilyIds = new Set<WorkflowFamilyId>(WORKFLOW_FAMILY_IDS)
const preconditionCheckKinds = new Set<SkillPreconditionCheckKind>([
  'path-exists',
  'path-absent',
  'path-regular-file',
  'tool-available',
  'input-nonempty',
  'time-window',
  'workflow-family',
])
const preconditionPlanAllowedKeys = new Set(['protocol', 'kind', 'workflowFamily', 'checks'])
const preconditionCheckAllowedKeys = new Set(['id', 'kind', 'path', 'toolName', 'inputName', 'notBefore', 'notAfter', 'workflowFamily'])

function validatePreconditionPlanShape(
  plan: unknown,
  declaredKind: SkillPreconditionKind,
  declaredFamily?: WorkflowFamilyId,
): asserts plan is SkillPreconditionPlan {
  if (!json(plan) || !plan || typeof plan !== 'object' || Array.isArray(plan)
    || Object.getPrototypeOf(plan) !== Object.prototype || Object.getOwnPropertySymbols(plan).length !== 0) {
    fail('assistant-skills: invalid precondition plan')
  }
  const keys = Object.keys(plan)
  if (keys.some(key => !preconditionPlanAllowedKeys.has(key))
    || !Object.hasOwn(plan, 'protocol')
    || !Object.hasOwn(plan, 'kind')
    || !Object.hasOwn(plan, 'checks')) {
    fail('assistant-skills: invalid precondition plan')
  }
  const candidate = plan as Record<string, unknown>
  if (candidate.protocol !== 'assistant-skills/precondition-plan/v1'
    || candidate.kind !== declaredKind
    || !boundedArray(candidate.checks, 32)) {
    fail('assistant-skills: invalid precondition plan')
  }
  if (candidate.workflowFamily !== undefined) {
    if (typeof candidate.workflowFamily !== 'string' || !workflowFamilyIds.has(candidate.workflowFamily as WorkflowFamilyId)) {
      fail('assistant-skills: unsupported workflow family in precondition plan')
    }
    if (declaredFamily !== undefined && candidate.workflowFamily !== declaredFamily) {
      fail('assistant-skills: precondition plan workflowFamily mismatch')
    }
  }
  const seenIds = new Set<string>()
  for (const rawCheck of candidate.checks) {
    if (!json(rawCheck) || !rawCheck || typeof rawCheck !== 'object' || Array.isArray(rawCheck)
      || Object.getPrototypeOf(rawCheck) !== Object.prototype || Object.getOwnPropertySymbols(rawCheck).length !== 0) {
      fail('assistant-skills: invalid precondition check')
    }
    const checkKeys = Object.keys(rawCheck)
    if (checkKeys.some(key => !preconditionCheckAllowedKeys.has(key)) || !Object.hasOwn(rawCheck, 'id') || !Object.hasOwn(rawCheck, 'kind')) {
      fail('assistant-skills: invalid precondition check')
    }
    const check = rawCheck as Record<string, unknown>
    if (!text(check.id, 256) || seenIds.has(check.id)) {
      fail('assistant-skills: invalid precondition check id')
    }
    seenIds.add(check.id)
    if (typeof check.kind !== 'string' || !preconditionCheckKinds.has(check.kind as SkillPreconditionCheckKind)) {
      fail('assistant-skills: unsupported precondition check kind')
    }
    const checkKind = check.kind as SkillPreconditionCheckKind
    if (checkKind === 'path-exists' || checkKind === 'path-absent' || checkKind === 'path-regular-file') {
      const hasPath = check.path !== undefined
      const hasInput = check.inputName !== undefined
      if ((!hasPath && !hasInput)
        || (hasPath && (!text(check.path, 4096) || String(check.path).includes('\\')))
        || (hasInput && !/^[a-z][a-z0-9_]{0,63}$/u.test(String(check.inputName)))
        || check.toolName !== undefined || check.notBefore !== undefined || check.notAfter !== undefined || check.workflowFamily !== undefined) {
        fail('assistant-skills: invalid path precondition check')
      }
    } else if (checkKind === 'tool-available') {
      if (!text(check.toolName, 256) || controlTool(check.toolName, {})
        || check.path !== undefined || check.inputName !== undefined || check.notBefore !== undefined || check.notAfter !== undefined || check.workflowFamily !== undefined) {
        fail('assistant-skills: invalid tool-available precondition check')
      }
    } else if (checkKind === 'input-nonempty') {
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(String(check.inputName))
        || check.path !== undefined || check.toolName !== undefined || check.notBefore !== undefined || check.notAfter !== undefined || check.workflowFamily !== undefined) {
        fail('assistant-skills: invalid input-nonempty precondition check')
      }
    } else if (checkKind === 'time-window') {
      const hasBefore = check.notBefore !== undefined
      const hasAfter = check.notAfter !== undefined
      if ((!hasBefore && !hasAfter)
        || (hasBefore && !integer(check.notBefore, 0))
        || (hasAfter && !integer(check.notAfter, 0))
        || (hasBefore && hasAfter && (check.notAfter as number) < (check.notBefore as number))
        || check.path !== undefined || check.toolName !== undefined || check.inputName !== undefined || check.workflowFamily !== undefined) {
        fail('assistant-skills: invalid time-window precondition check')
      }
    } else if (checkKind === 'workflow-family') {
      if (typeof check.workflowFamily !== 'string' || !workflowFamilyIds.has(check.workflowFamily as WorkflowFamilyId)
        || check.path !== undefined || check.toolName !== undefined || check.inputName !== undefined || check.notBefore !== undefined || check.notAfter !== undefined) {
        fail('assistant-skills: invalid workflow-family precondition check')
      }
    }
  }
}
/** Supported compensation families; unknown values always fail closed. */
const compensationKinds = new Set<SkillCompensationKind>([
  'stop-and-report',
  'compensate-via-registry',
  'compensating-action',
  'rollback-state',
])

const compensatorKeyPattern = /^[a-z][a-z0-9.:_-]{0,127}$/u
const compensationEntryKeys = new Set(['stepId', 'compensatorKey', 'toolName', 'arguments', 'capturePreimage'])

function validateCompensationPlanShape(
  plan: unknown,
  declaredKind: SkillCompensationKind,
): asserts plan is SkillCompensationPlan {
  if (!exact(plan, ['protocol', 'kind', 'entries'])
    || plan.protocol !== 'assistant-skills/compensation-plan/v1'
    || plan.kind !== declaredKind
    || declaredKind === 'stop-and-report'
    || !boundedArray(plan.entries, 32)) {
    fail('assistant-skills: invalid compensation plan')
  }
  if (declaredKind === 'compensating-action' && plan.entries.length === 0) {
    fail('assistant-skills: compensating-action requires at least one compensation entry')
  }
  const seenSteps = new Set<string>()
  for (const rawEntry of plan.entries) {
    if (!json(rawEntry) || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)
      || Object.getPrototypeOf(rawEntry) !== Object.prototype || Object.getOwnPropertySymbols(rawEntry).length !== 0) {
      fail('assistant-skills: invalid compensation plan entry')
    }
    const keys = Object.keys(rawEntry)
    if (keys.some(key => !compensationEntryKeys.has(key)) || !Object.hasOwn(rawEntry, 'stepId')) {
      fail('assistant-skills: invalid compensation plan entry')
    }
    const entry = rawEntry as Record<string, unknown>
    if (!text(entry.stepId, 256) || seenSteps.has(entry.stepId)) {
      fail('assistant-skills: invalid compensation plan stepId')
    }
    seenSteps.add(entry.stepId)
    if (entry.compensatorKey !== undefined && (typeof entry.compensatorKey !== 'string' || !compensatorKeyPattern.test(entry.compensatorKey))) {
      fail('assistant-skills: invalid compensatorKey in compensation plan')
    }
    if (entry.toolName !== undefined && (!text(entry.toolName, 256) || controlTool(entry.toolName, entry.arguments ?? {}))) {
      fail('assistant-skills: invalid toolName in compensation plan')
    }
    if (entry.arguments !== undefined && (!json(entry.arguments) || Buffer.byteLength(JSON.stringify(entry.arguments), 'utf8') > maximumArgumentsBytes)) {
      fail('assistant-skills: invalid arguments in compensation plan')
    }
    if (entry.capturePreimage !== undefined && typeof entry.capturePreimage !== 'boolean') {
      fail('assistant-skills: invalid capturePreimage in compensation plan')
    }
    if (declaredKind === 'compensating-action' && (entry.toolName === undefined || !Object.hasOwn(entry, 'arguments'))) {
      fail('assistant-skills: compensating-action entry requires toolName and arguments')
    }
  }
}

function validateCompensationPlanSteps(definition: Pick<SkillDefinition, 'steps' | 'compensation' | 'compensationPlan'>): void {
  const plan = definition.compensationPlan
  if (plan === undefined) return
  const stepIds = new Set(definition.steps.map(step => step.id))
  for (const entry of plan.entries) {
    if (!stepIds.has(entry.stepId)) {
      fail('assistant-skills: compensation plan references unknown stepId')
    }
  }
  const totalBytes = Buffer.byteLength(
    JSON.stringify([...definition.steps.map(step => step.arguments), ...plan.entries.map(entry => entry.arguments ?? null)]),
    'utf8',
  )
  if (totalBytes > maximumArgumentsBytes) {
    fail('assistant-skills: compensation plan arguments exceed bound')
  }
}

/** Fail closed on the typed protocol-family declarations of any definition. */
export function assertDefinitionProtocolFamilies(
  definition: Pick<SkillDefinition, 'preconditions' | 'compensation'> & {
    preconditionPlan?: SkillPreconditionPlan
    workflowFamily?: WorkflowFamilyId
    compensationPlan?: SkillCompensationPlan
  },
): void {
  if (!preconditionKinds.has(definition.preconditions as SkillPreconditionKind)) fail('assistant-skills: unsupported skill preconditions')
  if (definition.workflowFamily !== undefined && !workflowFamilyIds.has(definition.workflowFamily)) {
    fail('assistant-skills: unsupported workflow family')
  }
  if (definition.preconditionPlan !== undefined) {
    validatePreconditionPlanShape(definition.preconditionPlan, definition.preconditions, definition.workflowFamily)
  }
  if (!compensationKinds.has(definition.compensation as SkillCompensationKind)) fail('assistant-skills: unsupported skill compensation')
  if (definition.compensation === 'stop-and-report') {
    if ('compensationPlan' in definition && definition.compensationPlan !== undefined) {
      fail('assistant-skills: stop-and-report cannot declare a compensationPlan')
    }
  } else if (definition.compensationPlan !== undefined) {
    validateCompensationPlanShape(definition.compensationPlan, definition.compensation)
  } else if (definition.compensation === 'compensating-action') {
    fail('assistant-skills: compensating-action requires a compensationPlan')
  }
}

/** Validate the typed protocol fields and dependency graph of any definition. */
export function assertDefinitionProtocol(
  definition: Pick<SkillDefinition, 'preconditions' | 'compensation' | 'steps'> & {
    preconditionPlan?: SkillPreconditionPlan
    workflowFamily?: WorkflowFamilyId
    compensationPlan?: SkillCompensationPlan
  },
): void {
  assertDefinitionProtocolFamilies(definition)
  validateStepGraph(definition.steps)
  validateCompensationPlanSteps(definition)
}

/** Whether steps already carry the v1 edge shape; absent edges are an untrusted-input defect. */
function stepsCarryGraphShape(steps: readonly SkillStep[]): boolean {
  return Array.isArray(steps) && steps.every(step => step !== null && typeof step === 'object' && Array.isArray(step.dependsOn))
}

export interface PreconditionPathProbeResult {
  readonly contained: boolean
  readonly isSymlink: boolean
  readonly exists: boolean
  readonly isRegularFile: boolean
}

export type PreconditionPathProbe = (path: string) => PreconditionPathProbeResult

export interface SkillPreconditionDirective {
  readonly kind: SkillPreconditionKind
  readonly requiredChecks: readonly string[]
  readonly requiresFreshGoal: true
  readonly requiresOwnerScope: true
  readonly requiresPolicyGrant: boolean
  readonly requiresCleanGitWorktree: boolean
  readonly requiresOwnerRoute: boolean
  readonly requiresCalendarWindow: boolean
  readonly requiresAuthenticatedSource: boolean
  readonly requiresIdempotencyKey: boolean
  readonly requiresVaultRevision: boolean
  readonly requiresWorkspaceManifest: boolean
  readonly requiresIsolationGrant: boolean
}

/** Resolve the declared precondition family metadata; unknown families fail closed. */
export function preconditionDirective(preconditions: SkillPreconditionKind): SkillPreconditionDirective {
  if (!preconditionKinds.has(preconditions)) fail('assistant-skills: unsupported skill preconditions')
  switch (preconditions) {
    case 'current-owner-policy-and-fresh-goal':
      return Object.freeze({
        kind: preconditions,
        requiredChecks: Object.freeze(['owner-scope-match', 'fresh-goal']),
        requiresFreshGoal: true,
        requiresOwnerScope: true,
        requiresPolicyGrant: false,
        requiresCleanGitWorktree: false,
        requiresOwnerRoute: false,
        requiresCalendarWindow: false,
        requiresAuthenticatedSource: false,
        requiresIdempotencyKey: false,
        requiresVaultRevision: false,
        requiresWorkspaceManifest: false,
        requiresIsolationGrant: false,
      })
    case 'clean-git-worktree-and-policy-grant':
      return Object.freeze({
        kind: preconditions,
        requiredChecks: Object.freeze(['owner-scope-match', 'fresh-goal', 'clean-git-worktree', 'policy-grant']),
        requiresFreshGoal: true,
        requiresOwnerScope: true,
        requiresPolicyGrant: true,
        requiresCleanGitWorktree: true,
        requiresOwnerRoute: false,
        requiresCalendarWindow: false,
        requiresAuthenticatedSource: false,
        requiresIdempotencyKey: false,
        requiresVaultRevision: false,
        requiresWorkspaceManifest: false,
        requiresIsolationGrant: false,
      })
    case 'calendar-window-and-route-binding':
      return Object.freeze({
        kind: preconditions,
        requiredChecks: Object.freeze(['owner-scope-match', 'fresh-goal', 'calendar-window', 'owner-route-binding']),
        requiresFreshGoal: true,
        requiresOwnerScope: true,
        requiresPolicyGrant: false,
        requiresCleanGitWorktree: false,
        requiresOwnerRoute: true,
        requiresCalendarWindow: true,
        requiresAuthenticatedSource: false,
        requiresIdempotencyKey: false,
        requiresVaultRevision: false,
        requiresWorkspaceManifest: false,
        requiresIsolationGrant: false,
      })
    case 'authenticated-inbox-and-idempotency-key':
      return Object.freeze({
        kind: preconditions,
        requiredChecks: Object.freeze(['owner-scope-match', 'fresh-goal', 'authenticated-source', 'idempotency-key']),
        requiresFreshGoal: true,
        requiresOwnerScope: true,
        requiresPolicyGrant: false,
        requiresCleanGitWorktree: false,
        requiresOwnerRoute: false,
        requiresCalendarWindow: false,
        requiresAuthenticatedSource: true,
        requiresIdempotencyKey: true,
        requiresVaultRevision: false,
        requiresWorkspaceManifest: false,
        requiresIsolationGrant: false,
      })
    case 'wiki-vault-revision-and-owner-scope':
      return Object.freeze({
        kind: preconditions,
        requiredChecks: Object.freeze(['owner-scope-match', 'fresh-goal', 'vault-revision']),
        requiresFreshGoal: true,
        requiresOwnerScope: true,
        requiresPolicyGrant: false,
        requiresCleanGitWorktree: false,
        requiresOwnerRoute: false,
        requiresCalendarWindow: false,
        requiresAuthenticatedSource: false,
        requiresIdempotencyKey: false,
        requiresVaultRevision: true,
        requiresWorkspaceManifest: false,
        requiresIsolationGrant: false,
      })
    case 'workspace-manifest-and-isolation-grant':
      return Object.freeze({
        kind: preconditions,
        requiredChecks: Object.freeze(['owner-scope-match', 'fresh-goal', 'workspace-manifest', 'isolation-grant']),
        requiresFreshGoal: true,
        requiresOwnerScope: true,
        requiresPolicyGrant: false,
        requiresCleanGitWorktree: false,
        requiresOwnerRoute: false,
        requiresCalendarWindow: false,
        requiresAuthenticatedSource: false,
        requiresIdempotencyKey: false,
        requiresVaultRevision: false,
        requiresWorkspaceManifest: true,
        requiresIsolationGrant: true,
      })
  }
  const exhaustive: never = preconditions
  fail(`assistant-skills: unsupported skill preconditions ${String(exhaustive)}`)
}

/** Digests and live host assertions the executor resolved; the pure gate stays free of Host scope types. */
export interface SkillPreconditionDecision {
  /** Policy-scope digest the executor resolved for the current action. */
  ownerScopeDigest: string
  /** Policy-scope digest the live Goal run context attests. */
  currentScopeDigest: string
  goalId: string
  /** Goal whose historical trace was captured into the definition. */
  sourceGoalId: string
  cleanGitWorktree?: boolean
  policyGrantValid?: boolean
  calendarWindowValid?: boolean
  ownerRouteBound?: boolean
  authenticatedSource?: boolean
  idempotencyKeyPresent?: boolean
  vaultRevisionCurrent?: boolean
  workspaceCleanOrScoped?: boolean
  isolationGrantValid?: boolean
  preconditionPlan?: SkillPreconditionPlan
  workflowFamily?: WorkflowFamilyId
  allowedTools?: readonly string[]
  inputs?: Readonly<Record<string, unknown>>
  now?: number
  pathProbe?: PreconditionPathProbe
}

export function evaluatePreconditionPlan(
  plan: SkillPreconditionPlan,
  context: {
    readonly preconditions: SkillPreconditionKind
    readonly workflowFamily?: WorkflowFamilyId
    readonly allowedTools?: readonly string[]
    readonly inputs?: Readonly<Record<string, unknown>>
    readonly now?: number
    readonly pathProbe?: PreconditionPathProbe
  },
): void {
  validatePreconditionPlanShape(plan, context.preconditions, context.workflowFamily)
  const now = context.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0) fail('assistant-skills: invalid precondition clock')
  for (const check of plan.checks) {
    if (check.kind === 'path-exists' || check.kind === 'path-absent' || check.kind === 'path-regular-file') {
      const hasInput = check.inputName !== undefined && context.inputs !== undefined && Object.hasOwn(context.inputs, check.inputName)
      const resolvedPath = hasInput ? context.inputs![check.inputName!] : check.path
      if (typeof resolvedPath !== 'string' || resolvedPath.trim().length === 0) {
        fail(`assistant-skills: precondition check ${check.id} invalid path`)
      }
      if (!context.pathProbe) {
        fail(`assistant-skills: precondition check ${check.id} path probe unavailable`)
      }
      const probe = context.pathProbe(resolvedPath)
      if (!probe || !probe.contained || probe.isSymlink) {
        fail(`assistant-skills: precondition check ${check.id} path unsafe or outside workspace`)
      }
      if (check.kind === 'path-exists' && !probe.exists) {
        fail(`assistant-skills: precondition check ${check.id} required path missing`)
      }
      if (check.kind === 'path-absent' && probe.exists) {
        fail(`assistant-skills: precondition check ${check.id} expected path absent`)
      }
      if (check.kind === 'path-regular-file' && (!probe.exists || !probe.isRegularFile)) {
        fail(`assistant-skills: precondition check ${check.id} required regular file missing`)
      }
    } else if (check.kind === 'tool-available') {
      if (!Array.isArray(context.allowedTools) || !context.allowedTools.includes(check.toolName!)) {
        fail(`assistant-skills: precondition check ${check.id} required tool ${check.toolName} unavailable`)
      }
    } else if (check.kind === 'input-nonempty') {
      const value = context.inputs !== undefined && Object.hasOwn(context.inputs, check.inputName!) ? context.inputs[check.inputName!] : undefined
      const valid = typeof value === 'string' ? value.trim().length > 0 : typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean'
      if (!valid) {
        fail(`assistant-skills: precondition check ${check.id} required input ${check.inputName} empty`)
      }
    } else if (check.kind === 'time-window') {
      if ((check.notBefore !== undefined && now < check.notBefore) || (check.notAfter !== undefined && now > check.notAfter)) {
        fail(`assistant-skills: precondition check ${check.id} outside allowed time window`)
      }
    } else if (check.kind === 'workflow-family') {
      if (context.workflowFamily !== check.workflowFamily) {
        fail(`assistant-skills: precondition check ${check.id} workflow family mismatch`)
      }
    }
  }
}

/**
 * Admit a run only when the declared precondition family is satisfied.
 * Every family requires the current owner's policy scope to match and a Goal
 * distinct from the captured source Goal, plus strict family-specific checks.
 * Unknown families and unmet/missing assertions always fail closed.
 */
export function evaluatePreconditions(preconditions: SkillPreconditionKind, decision: SkillPreconditionDecision): void {
  if (!preconditionKinds.has(preconditions)) fail('assistant-skills: unsupported skill preconditions')
  if (decision.ownerScopeDigest !== decision.currentScopeDigest || decision.goalId === decision.sourceGoalId) {
    fail('assistant-skills: fresh owner Goal required')
  }
  switch (preconditions) {
    case 'current-owner-policy-and-fresh-goal':
      break
    case 'clean-git-worktree-and-policy-grant':
      if (decision.cleanGitWorktree !== true) fail('assistant-skills: clean git worktree precondition unmet')
      if (decision.policyGrantValid !== true) fail('assistant-skills: policy grant precondition unmet')
      break
    case 'calendar-window-and-route-binding':
      if (decision.calendarWindowValid !== true) fail('assistant-skills: calendar window precondition unmet')
      if (decision.ownerRouteBound !== true) fail('assistant-skills: owner route binding precondition unmet')
      break
    case 'authenticated-inbox-and-idempotency-key':
      if (decision.authenticatedSource !== true) fail('assistant-skills: authenticated inbox source precondition unmet')
      if (decision.idempotencyKeyPresent !== true) fail('assistant-skills: idempotency key precondition unmet')
      break
    case 'wiki-vault-revision-and-owner-scope':
      if (decision.vaultRevisionCurrent !== true) fail('assistant-skills: wiki vault revision precondition unmet')
      break
    case 'workspace-manifest-and-isolation-grant':
      if (decision.workspaceCleanOrScoped !== true) fail('assistant-skills: workspace manifest precondition unmet')
      if (decision.isolationGrantValid !== true) fail('assistant-skills: isolation grant precondition unmet')
      break
  }
  if (decision.preconditionPlan !== undefined) {
    evaluatePreconditionPlan(decision.preconditionPlan, {
      preconditions,
      ...(decision.workflowFamily === undefined ? {} : { workflowFamily: decision.workflowFamily }),
      ...(decision.allowedTools === undefined ? {} : { allowedTools: decision.allowedTools }),
      ...(decision.inputs === undefined ? {} : { inputs: decision.inputs }),
      ...(decision.now === undefined ? {} : { now: decision.now }),
      ...(decision.pathProbe === undefined ? {} : { pathProbe: decision.pathProbe }),
    })
  }
}

/** Directive the executor follows once a step has failed. */
export interface SkillCompensationDirective {
  kind: SkillCompensationKind
  stopRemainingSteps: boolean
  reportForOwnerRepair: boolean
  executeCompensation: boolean
  capturePreimage: boolean
  target: 'none' | 'registry' | 'action' | 'rollback'
}

/** Resolve the declared compensation family; unknown families fail closed. */
export function compensationDirective(compensation: SkillCompensationKind): SkillCompensationDirective {
  if (!compensationKinds.has(compensation)) fail('assistant-skills: unsupported skill compensation')
  switch (compensation) {
    case 'stop-and-report':
      return {
        kind: 'stop-and-report',
        stopRemainingSteps: true,
        reportForOwnerRepair: true,
        executeCompensation: false,
        capturePreimage: false,
        target: 'none',
      }
    case 'compensate-via-registry':
      return {
        kind: 'compensate-via-registry',
        stopRemainingSteps: true,
        reportForOwnerRepair: true,
        executeCompensation: true,
        capturePreimage: true,
        target: 'registry',
      }
    case 'compensating-action':
      return {
        kind: 'compensating-action',
        stopRemainingSteps: true,
        reportForOwnerRepair: true,
        executeCompensation: true,
        capturePreimage: false,
        target: 'action',
      }
    case 'rollback-state':
      return {
        kind: 'rollback-state',
        stopRemainingSteps: true,
        reportForOwnerRepair: true,
        executeCompensation: true,
        capturePreimage: true,
        target: 'rollback',
      }
  }
  const exhaustive: never = compensation
  fail(`assistant-skills: unsupported skill compensation ${String(exhaustive)}`)
}

/** Derive a bounded, parameterizable skill only from an independently verified tool trace. */
export function createDefinition(source: VerifiedWorkflowSource, options: CreateDefinitionOptions, allowedTools: readonly string[], expansions: readonly SkillRunExpansion[] = []): Readonly<SkillDefinition> {
  if (!json(source) || !json(options) || !source || source.protocol !== 'assistant-goals/verified-workflow-source/v1' || !Array.isArray(source.steps) || source.steps.length === 0 || source.steps.length > 32
    || !options || !/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(options.name) || !text(options.description, 512)
    || !Array.isArray(allowedTools) || allowedTools.some(tool => !text(tool, 256))) fail()
  const preconditions = options.preconditions ?? 'current-owner-policy-and-fresh-goal'
  if (!preconditionKinds.has(preconditions)) fail('assistant-skills: unsupported skill preconditions')
  if (options.workflowFamily !== undefined && !workflowFamilyIds.has(options.workflowFamily)) {
    fail('assistant-skills: unsupported workflow family')
  }
  let preconditionPlan: SkillPreconditionPlan | undefined
  if (options.preconditionPlan !== undefined) {
    if (!json(options.preconditionPlan) || !options.preconditionPlan || typeof options.preconditionPlan !== 'object' || Array.isArray(options.preconditionPlan)) {
      fail('assistant-skills: invalid precondition plan')
    }
    const candidatePlan: SkillPreconditionPlan = {
      protocol: 'assistant-skills/precondition-plan/v1',
      kind: options.preconditionPlan.kind,
      ...(options.preconditionPlan.workflowFamily === undefined ? {} : { workflowFamily: options.preconditionPlan.workflowFamily }),
      checks: clone(options.preconditionPlan.checks),
    }
    validatePreconditionPlanShape(candidatePlan, preconditions, options.workflowFamily)
    preconditionPlan = candidatePlan
  }
  const compensation = options.compensation ?? 'stop-and-report'
  if (!compensationKinds.has(compensation)) fail('assistant-skills: unsupported skill compensation')
  if (compensation === 'stop-and-report' && options.compensationPlan !== undefined) {
    fail('assistant-skills: stop-and-report cannot declare a compensationPlan')
  }
  const allow = new Set(allowedTools)
  if (allow.size !== allowedTools.length) fail('assistant-skills: duplicate allowed tool')
  const { steps: sourceSteps, observations } = sourceProjection(source)
  if (!Array.isArray(observations) || sourceSteps.length + observations.length > 32 || observations.some(value => !failedProbe(value))) fail('assistant-skills: invalid failed observation')
  const expandedSteps = expandSkillRuns(sourceSteps, observations, expansions)
  const executable = expandedSteps.filter(step => {
    if (!step || !text(step.id, 256) || !text(step.toolName, 256) || !json(step.arguments)) fail('assistant-skills: untrusted tool trace')
    if (step.toolName === 'goal_checkpoint' && sourceCheckpoint(step.arguments, source.goal.id)) return false
    if (step.toolName === 'goal_context' && sourceGoalContext(step.arguments, source.goal.id)) return false
    // The current owner's parameterless catalog inspection informs the source
    // task but is not executable workflow authority. Retain it in provenance.
    if (step.toolName === 'skill_status' && step.arguments !== null && typeof step.arguments === 'object'
      && !Array.isArray(step.arguments) && Object.keys(step.arguments).length === 0) return false
    if (step.toolName === 'todo_write') {
      if (!todoWrite(step.arguments)) fail('assistant-skills: invalid todo provenance')
      return false
    }
    if (!allow.has(step.toolName) || controlTool(step.toolName, step.arguments)) fail('assistant-skills: untrusted tool trace')
    return true
  })
  if (executable.length === 0) fail('assistant-skills: executable tool trace required')
  const steps = executable.map((step, index) => ({ id: step.id, toolName: step.toolName, arguments: clone(step.arguments), dependsOn: index === 0 ? [] : [executable[index - 1]!.id] }))
  if (new Set([...expandedSteps.map(step => step.id), ...observations.map(value => value.id)]).size !== expandedSteps.length + observations.length
    || expandedSteps.length + observations.length > 32) fail('assistant-skills: bounded tool trace is required')
  const bindings = options.bindings ?? []
  if (!Array.isArray(bindings) || bindings.length > 8) fail('assistant-skills: too many bindings')
  const names = new Set<string>(); const locations = new Set<string>()
  const inputs = bindings.map(binding => {
    if (!json(binding) || !binding || !/^[a-z][a-z0-9_]{0,63}$/u.test(binding.name) || !text(binding.stepId, 256) || typeof binding.path !== 'string' || names.has(binding.name) || locations.has(`${binding.stepId}\u0000${binding.path}`)) fail('assistant-skills: invalid binding')
    names.add(binding.name); locations.add(`${binding.stepId}\u0000${binding.path}`)
    const step = steps.find(candidate => candidate.id === binding.stepId)
    if (!step) fail('assistant-skills: binding step is missing')
    const value = at(step.arguments, binding.path)
    return { ...binding, type: inputType(value), default: value }
  })
  const observedMutators = standardFileMutators(steps)
  if (steps.length + observedMutators.length > 32) fail('assistant-skills: bounded tool trace is required')
  let compensationPlan: SkillCompensationPlan | undefined
  if (options.compensationPlan !== undefined) {
    if (!exact(options.compensationPlan, ['kind', 'entries'])) fail('assistant-skills: invalid compensation plan')
    compensationPlan = {
      protocol: 'assistant-skills/compensation-plan/v1',
      kind: options.compensationPlan.kind,
      entries: clone(options.compensationPlan.entries),
    }
    if (compensation === 'compensating-action') {
      for (const entry of compensationPlan.entries) {
        if (typeof entry.toolName !== 'string' || !allow.has(entry.toolName)) {
          fail('assistant-skills: compensating-action tool must be in allowedTools')
        }
      }
    }
  }
  const definition: SkillDefinition = { protocol: 'assistant-skills/definition/v1', name: options.name, description: options.description, source: clone(source), inputs, steps,
    ...(observedMutators.length === 0 ? {} : { fileObservations: { protocol: 'assistant-skills/file-observations/v1' as const, beforeSteps: observedMutators.map(step => step.id) } }),
    ...(expansions.length === 0 ? {} : { runExpansions: clone(expansions) }),
    preconditions,
    ...(preconditionPlan === undefined ? {} : { preconditionPlan }),
    ...(options.workflowFamily === undefined ? {} : { workflowFamily: options.workflowFamily }),
    compensation,
    ...(compensationPlan === undefined ? {} : { compensationPlan }) }
  assertDefinitionProtocol(definition)
  fileObservations(definition)
  return freeze(definition)
}

/** Materialize saved defaults and only declared scalar inputs into an immutable trace projection. */
export function instantiate(definition: SkillDefinition, values: Readonly<Record<string, unknown>> = {}): Readonly<SkillDefinition> {
  if (!definition || definition.protocol !== 'assistant-skills/definition/v1' || !values || typeof values !== 'object' || Array.isArray(values) || Object.getPrototypeOf(values) !== Object.prototype || Object.getOwnPropertySymbols(values).length !== 0 || !json(values)) fail('assistant-skills: invalid invocation inputs')
  const expected = new Map(definition.inputs.map(input => [input.name, input]))
  if (Object.keys(values).some(name => !expected.has(name) || forbidden.has(name))) fail('assistant-skills: unknown invocation input')
  const output = clone(definition) as SkillDefinition
  for (const input of output.inputs) {
    const value = Object.hasOwn(values, input.name) ? values[input.name] : input.default
    if (typeof value !== input.type || !scalar(value)) fail('assistant-skills: invocation input type mismatch')
    const step = output.steps.find(candidate => candidate.id === input.stepId)
    if (!step) fail('assistant-skills: invalid definition')
    replace(step.arguments, input.path, value)
  }
  if (output.runExpansions !== undefined) expandSkillRuns(sourceProjection(output.source).steps, sourceProjection(output.source).observations, output.runExpansions)
  // Protocol-family declarations are always fail-closed. The edge graph is only
  // re-validated when steps still carry the v1 edge shape: a definition whose
  // steps were wholesale replaced (edges missing) is an untrusted-input defect
  // whose precise cause belongs to the execution/replay boundary, which runs
  // strict per-step validation before its own graph gate.
  assertDefinitionProtocolFamilies(output)
  if (stepsCarryGraphShape(output.steps)) {
    validateStepGraph(output.steps)
    validateCompensationPlanSteps(output)
  }
  fileObservations(output)
  if (Buffer.byteLength(JSON.stringify(output.steps.map(step => step.arguments)), 'utf8') > maximumArgumentsBytes) fail('assistant-skills: invocation arguments too large')
  return freeze(output)
}
