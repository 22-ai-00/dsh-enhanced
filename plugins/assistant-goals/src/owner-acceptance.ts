import { acceptanceDigest, acceptanceProtocolForTask, createTaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import type { AcceptanceCriterion, AcceptanceTaskIdentity } from '@dsh-enhanced/task-acceptance-contract'
import type { AcceptanceHandle, TaskAcceptanceRegistration } from '@dsh-enhanced/assistant-verifier'
import type { GoalDefinition } from './types.js'

const HEX = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const PREPARER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u

export interface OwnerPreparedBounds { readonly maxDurationMs: number; readonly maxEvidenceBytes: number }
/** Host-prepared criteria for one owner goal; never a model tool payload. */
export interface OwnerPreparedAcceptanceInput {
  readonly criteria: readonly AcceptanceCriterion[]
  /** Optional step criteria; defaults to the outcome criteria. */
  readonly stepCriteria?: readonly AcceptanceCriterion[]
  readonly bounds: OwnerPreparedBounds
  readonly validityMs: number
  readonly preparer: Readonly<{ id: string; digest: string }>
}

/** Durable, immutable owner acceptance seal for one business goal. */
export interface GoalOwnerAcceptanceSeal {
  readonly goalId: string
  readonly definition: GoalDefinition
  readonly objective: string
  readonly criteria: readonly AcceptanceCriterion[]
  readonly stepCriteria: readonly AcceptanceCriterion[]
  readonly bounds: OwnerPreparedBounds
  readonly validityMs: number
  readonly preparer: Readonly<{ id: string; digest: string }>
  readonly outcome: AcceptanceHandle
  /** Verifier-derived prepared profile digest; informational, never recomputed here. */
  readonly preparedProfileDigest: string
  readonly outcomeExpiresAt: number
  readonly at: number
}

/** Exact Host-only input the verifier seals for one prepared task. */
export interface OwnerPreparedContractInput {
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly owner: Readonly<{ principalRecordId: string; principalVersion: number }>
  readonly task: AcceptanceTaskIdentity
  readonly objective: string
  readonly criteria: readonly AcceptanceCriterion[]
  readonly bounds: OwnerPreparedBounds
  readonly validityMs: number
  readonly preparer: Readonly<{ id: string; digest: string }>
}

/** Newer verifier registrations expose the Host-prepared seal capability. */
export interface OwnerPreparedRegistration {
  prepareOwnerContract(input: OwnerPreparedContractInput): AcceptanceHandle
}

/**
 * The published assistant-verifier build may predate the prepared-contract API,
 * so Goals recognizes it structurally instead of requiring a rebuilt .d.ts.
 * A registration without the method is a fail-closed older peer.
 */
export function preparedRegistration(registration: TaskAcceptanceRegistration): OwnerPreparedRegistration | undefined {
  const candidate = registration as TaskAcceptanceRegistration & Partial<OwnerPreparedRegistration>
  return typeof candidate.prepareOwnerContract === 'function' ? candidate as OwnerPreparedRegistration : undefined
}

function fail(message: string): never { throw new Error(`assistant-goals: ${message}`) }
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const frozen = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) frozen(child); Object.freeze(value) }
  return value
}

function bounds(value: unknown): OwnerPreparedBounds {
  if (!plain(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'maxDurationMs') || !Object.hasOwn(value, 'maxEvidenceBytes')
    || !integer(value.maxDurationMs, 1, 300_000) || !integer(value.maxEvidenceBytes, 1, 1_048_576)) {
    fail('owner acceptance bounds are invalid')
  }
  return frozen({ maxDurationMs: value.maxDurationMs, maxEvidenceBytes: value.maxEvidenceBytes })
}

function preparer(value: unknown): Readonly<{ id: string; digest: string }> {
  if (!plain(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'digest')
    || typeof value.id !== 'string' || !PREPARER.test(value.id) || typeof value.digest !== 'string' || !HEX.test(value.digest)) {
    fail('owner acceptance preparer is invalid')
  }
  return frozen({ id: value.id, digest: value.digest })
}

function criteria(value: unknown, label: string): readonly AcceptanceCriterion[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    fail(`owner acceptance ${label} are invalid`)
  }
  return frozen(value as readonly AcceptanceCriterion[])
}

/** Reuse the shared wire validator so prepared criteria obey the same bounds as real contracts. */
function assertCriteria(criteriaValue: readonly AcceptanceCriterion[], taskKind: 'goal-step' | 'goal-outcome',
  boundsValue: OwnerPreparedBounds, objective: string): void {
  const definitionDigest = '0'.repeat(64)
  const task: AcceptanceTaskIdentity = taskKind === 'goal-outcome'
    ? { kind: 'goal-outcome', ref: 'owner-acceptance-validation', goal: { id: 'owner-acceptance', definitionVersion: 1,
      definitionDigest, assessmentId: 'owner-acceptance-validation', sessionId: 'owner-acceptance', nativeGoalId: 'owner-acceptance' } }
    : { kind: 'goal-step', ref: 'owner-acceptance-validation', goal: { id: 'owner-acceptance', definitionVersion: 1,
      definitionDigest, stepId: 'owner-acceptance', runId: 'owner-acceptance-validation', sessionId: 'owner-acceptance',
      nativeGoalId: 'owner-acceptance', nativeRevision: 1 } }
  try {
    createTaskAcceptanceContract({ protocol: acceptanceProtocolForTask(task, criteriaValue),
      id: 'acceptance-owner-acceptance-validation', scope: { workspace: '/owner-acceptance', preset: 'primary' },
      owner: { principalRecordId: 'owner-acceptance', principalVersion: 1 }, task,
      objective: objective.length > 0 ? objective : 'owner acceptance',
      profile: { id: 'owner-prepared', version: 1, digest: '0'.repeat(64) }, issuedAt: 0,
      expiresAt: Math.max(1_000, boundsValue.maxDurationMs + 1), criteria: criteriaValue, bounds: boundsValue })
  } catch (error) {
    fail(`owner acceptance criteria are invalid: ${error instanceof Error ? error.message : 'invalid criteria'}`)
  }
}

/** Validate one Host-only seal request before any verifier or native side effect. */
export function validateOwnerPreparedAcceptanceInput(value: unknown, stepMaxDurationMs: number): OwnerPreparedAcceptanceInput {
  if (!plain(value)) fail('owner acceptance input must be a plain object')
  const keys = Object.keys(value)
  if (keys.some(key => !['criteria', 'stepCriteria', 'bounds', 'validityMs', 'preparer'].includes(key))
    || !Object.hasOwn(value, 'criteria') || !Object.hasOwn(value, 'bounds') || !Object.hasOwn(value, 'validityMs') || !Object.hasOwn(value, 'preparer')) {
    fail('owner acceptance input has an invalid shape')
  }
  const criteriaValue = criteria(value.criteria, 'criteria')
  const stepCriteriaValue = value.stepCriteria === undefined ? criteriaValue : criteria(value.stepCriteria, 'step criteria')
  const boundsValue = bounds(value.bounds)
  if (!integer(value.validityMs, 1_000, 86_400_000)) fail('owner acceptance validity is invalid')
  const preparerValue = preparer(value.preparer)
  const window = stepMaxDurationMs + 2 * boundsValue.maxDurationMs
  if (value.validityMs <= window) fail('owner acceptance validity must cover the configured native round and verification')
  assertCriteria(criteriaValue, 'goal-outcome', boundsValue, 'owner acceptance')
  assertCriteria(stepCriteriaValue, 'goal-step', boundsValue, 'owner acceptance')
  return frozen({ criteria: criteriaValue, stepCriteria: stepCriteriaValue, bounds: boundsValue, validityMs: value.validityMs, preparer: preparerValue })
}

/** Strict exact-key validation of one persisted seal; any drift fails closed. */
export function validateOwnerAcceptanceSeal(value: unknown): GoalOwnerAcceptanceSeal {
  if (!plain(value)) fail('seal is invalid')
  const keys = ['goalId', 'definition', 'objective', 'criteria', 'stepCriteria', 'bounds', 'validityMs', 'preparer', 'outcome', 'preparedProfileDigest', 'outcomeExpiresAt', 'at']
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail('seal has an invalid shape')
  const goalId = value.goalId
  if (typeof goalId !== 'string' || !ID.test(goalId)) fail('seal goal identity is invalid')
  if (!plain(value.definition) || Object.keys(value.definition).length !== 3 || !Object.hasOwn(value.definition, 'version')
    || !Object.hasOwn(value.definition, 'digest') || !Object.hasOwn(value.definition, 'objective')
    || !integer(value.definition.version, 1) || typeof value.definition.digest !== 'string' || !HEX.test(value.definition.digest)
    || typeof value.definition.objective !== 'string' || value.definition.objective.length < 1 || value.definition.objective.length > 16_384
    || value.definition.digest !== acceptanceDigest({ objective: value.definition.objective })) fail('seal definition is invalid')
  if (typeof value.objective !== 'string' || value.objective !== value.definition.objective) fail('seal objective is invalid')
  const criteriaValue = criteria(value.criteria, 'criteria')
  const stepCriteriaValue = criteria(value.stepCriteria, 'step criteria')
  const boundsValue = bounds(value.bounds)
  if (!integer(value.validityMs, 1_000, 86_400_000)) fail('seal validity is invalid')
  const preparerValue = preparer(value.preparer)
  if (!plain(value.outcome) || Object.keys(value.outcome).length !== 2 || !Object.hasOwn(value.outcome, 'contractId')
    || !Object.hasOwn(value.outcome, 'contractDigest') || typeof value.outcome.contractId !== 'string'
    || !ID.test(value.outcome.contractId) || typeof value.outcome.contractDigest !== 'string' || !HEX.test(value.outcome.contractDigest)) {
    fail('seal handle is invalid')
  }
  if (typeof value.preparedProfileDigest !== 'string' || !HEX.test(value.preparedProfileDigest)) fail('seal prepared profile digest is invalid')
  if (!integer(value.outcomeExpiresAt) || !integer(value.at)) fail('seal timestamps are invalid')
  if (value.outcomeExpiresAt <= value.at || value.outcomeExpiresAt - value.at > value.validityMs) fail('seal expiry is invalid')
  assertCriteria(criteriaValue, 'goal-outcome', boundsValue, value.definition.objective)
  assertCriteria(stepCriteriaValue, 'goal-step', boundsValue, value.definition.objective)
  return frozen(JSON.parse(JSON.stringify({
    goalId, definition: value.definition, objective: value.objective, criteria: criteriaValue, stepCriteria: stepCriteriaValue,
    bounds: boundsValue, validityMs: value.validityMs, preparer: preparerValue, outcome: value.outcome,
    preparedProfileDigest: value.preparedProfileDigest, outcomeExpiresAt: value.outcomeExpiresAt, at: value.at,
  })) as GoalOwnerAcceptanceSeal)
}
