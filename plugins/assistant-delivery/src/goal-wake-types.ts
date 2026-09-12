import type { Agent } from '@deepseek-ai/dsh-agent'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { DeliveryPreferencePrincipalAttestation } from './types.js'

/** Exact durable locator for owner feedback about one terminal whole-goal assessment. */
export interface OwnerGoalOutcomeFeedbackLocator {
  readonly protocol: 'assistant-goals/owner-goal-outcome-locator/v1'
  readonly ownerRouteId: string
  readonly principalId: string
  readonly principalRecordId: string
  readonly principalVersion: number
  readonly workspace: string
  readonly preset: string
  readonly bindingId: string
  readonly bindingVersion: number
  readonly bindingGeneration: number
  readonly sessionId: string
  readonly goalId: string
  readonly assessmentId: string
}

/** Rebuilt Host proof for owner feedback about one exact whole-goal outcome. */
export interface OwnerGoalOutcomeFeedbackProof {
  readonly protocol: 'assistant-goals/owner-goal-outcome-feedback/v1'
  readonly locator: Readonly<OwnerGoalOutcomeFeedbackLocator>
  readonly goal: Readonly<{
    definitionVersion: number
    definitionDigest: string
    nativeGoalId: string
    phase: 'complete' | 'blocked'
  }>
  readonly runId: string
  readonly profile: Readonly<{ id: string; version: number; digest: string }>
  readonly contract: Readonly<{ id: string; digest: string }>
  readonly receipt: Readonly<{
    id: string
    digest: string
    objectiveStatus: 'achieved' | 'not-achieved'
    completedAt: number
    validUntil: number
  }>
  readonly proofDigest: string
}

export interface OwnerGoalOutcomeFeedbackTarget {
  readonly locator: Readonly<OwnerGoalOutcomeFeedbackLocator>
  readonly capability: unknown
  readonly proof: Readonly<OwnerGoalOutcomeFeedbackProof>
}

const digestPattern = /^[a-f0-9]{64}$/u
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key)
}
const text = (value: unknown, pattern: RegExp = identifierPattern): value is string =>
  typeof value === 'string' && pattern.test(value)
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1

/** Strict parser shared by Delivery persistence and the live Goals capability boundary. */
export function validateOwnerGoalOutcomeFeedbackLocator(
  value: unknown,
): Readonly<OwnerGoalOutcomeFeedbackLocator> {
  if (!isRecord(value) || !exactKeys(value, [
    'protocol', 'ownerRouteId', 'principalId', 'principalRecordId', 'principalVersion',
    'workspace', 'preset', 'bindingId', 'bindingVersion', 'bindingGeneration',
    'sessionId', 'goalId', 'assessmentId',
  ]) || value.protocol !== 'assistant-goals/owner-goal-outcome-locator/v1'
    || !text(value.ownerRouteId, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u)
    || !text(value.principalId) || !text(value.principalRecordId)
    || !positive(value.principalVersion) || typeof value.workspace !== 'string'
    || value.workspace.length === 0 || value.workspace.length > 4_096
    || !text(value.preset) || !text(value.bindingId) || !positive(value.bindingVersion)
    || !positive(value.bindingGeneration) || !text(value.sessionId)
    || !text(value.goalId) || !text(value.assessmentId)) {
    throw new Error('assistant-delivery: invalid goal outcome feedback locator')
  }
  return Object.freeze({ ...value }) as unknown as Readonly<OwnerGoalOutcomeFeedbackLocator>
}

/** Validate every proof field and its canonical digest; no caller prose is accepted. */
export function validateOwnerGoalOutcomeFeedbackProof(
  value: unknown,
): Readonly<OwnerGoalOutcomeFeedbackProof> {
  if (!isRecord(value) || !exactKeys(value, [
    'protocol', 'locator', 'goal', 'runId', 'profile', 'contract', 'receipt', 'proofDigest',
  ]) || value.protocol !== 'assistant-goals/owner-goal-outcome-feedback/v1'
    || !text(value.runId) || !text(value.proofDigest, digestPattern)) {
    throw new Error('assistant-delivery: invalid goal outcome feedback proof')
  }
  const locator = validateOwnerGoalOutcomeFeedbackLocator(value.locator)
  const goal = value.goal
  const profile = value.profile
  const contract = value.contract
  const receipt = value.receipt
  if (!isRecord(goal) || !exactKeys(goal, ['definitionVersion', 'definitionDigest', 'nativeGoalId', 'phase'])
    || !positive(goal.definitionVersion) || !text(goal.definitionDigest, digestPattern)
    || !text(goal.nativeGoalId) || !['complete', 'blocked'].includes(String(goal.phase))
    || !isRecord(profile) || !exactKeys(profile, ['id', 'version', 'digest'])
    || !text(profile.id) || !positive(profile.version) || !text(profile.digest, digestPattern)
    || !isRecord(contract) || !exactKeys(contract, ['id', 'digest'])
    || !text(contract.id) || !text(contract.digest, digestPattern)
    || !isRecord(receipt) || !exactKeys(receipt, [
      'id', 'digest', 'objectiveStatus', 'completedAt', 'validUntil',
    ]) || !text(receipt.id) || !text(receipt.digest, digestPattern)
    || !['achieved', 'not-achieved'].includes(String(receipt.objectiveStatus))
    || !Number.isSafeInteger(receipt.completedAt) || (receipt.completedAt as number) < 0
    || !Number.isSafeInteger(receipt.validUntil) || (receipt.validUntil as number) <= (receipt.completedAt as number)) {
    throw new Error('assistant-delivery: invalid goal outcome feedback proof')
  }
  const payload = {
    protocol: value.protocol, locator, goal, runId: value.runId, profile, contract, receipt,
  }
  if (acceptanceDigest(payload) !== value.proofDigest) {
    throw new Error('assistant-delivery: goal outcome feedback proof digest mismatch')
  }
  return Object.freeze(JSON.parse(JSON.stringify(value)) as OwnerGoalOutcomeFeedbackProof)
}

/**
 * Content-free, exact identity fence for one durable Goal wake.
 *
 * Delivery does not accept a message or a human-turn proof here. The host
 * validates this attestation before entering the runtime; the runtime still
 * validates its temporal and structural boundaries before it resumes an Agent.
 */
export interface DeliveryGoalWakeInput {
  readonly attestation: Readonly<DeliveryPreferencePrincipalAttestation>
  readonly native: Readonly<{ goalId: string; revision: number }>
  readonly deadlineAt: number
  readonly signal: AbortSignal
  /** Request the final visible output for the caller's separately authorized result delivery. */
  readonly includeOutput?: boolean
  /** Re-read the host-owned goal/owner fence at each execution boundary. */
  assertCurrent(agent: Agent, phase: 'before-resume' | 'running' | 'terminal'): void
  /** Persist the caller's exact wake-dispatch CAS immediately before native resume. */
  beforeResume(agent: Agent): void
  /** Finish this Agent's admitted step/goal verification before disposal. */
  settle(agent: Agent, signal: AbortSignal): Promise<void>
  /** Resolve a fresh, process-local Goals capability after the exact outcome has settled. */
  resolveOutcomeFeedbackTarget(): Readonly<OwnerGoalOutcomeFeedbackTarget>
}

/** Wake execution reached a bounded terminal state; it says nothing about business completion. */
export interface DeliveryGoalWakeResult {
  readonly outcome: 'succeeded' | 'busy' | 'unknown' | 'denied'
  readonly dispatched: boolean
  readonly quiescent: boolean
  /** Final visible text from this resumed goal's completed turn, only after settlement and teardown. */
  readonly output?: string
}

/** Validate the allowed absolute deadline window. */
export function isDeliveryGoalWakeDeadline(deadlineAt: number, now: number): boolean {
  return Number.isSafeInteger(deadlineAt) && Number.isSafeInteger(now)
    && deadlineAt > now && deadlineAt - now <= 300_000
}
