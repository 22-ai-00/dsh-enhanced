import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalScope } from '@dsh-enhanced/assistant-goals'
import type { FailureCaptureProvenance, HostFailureEvidenceSummary, VerifiedWorkflowSource } from './definition.js'
import { fileObservationSteps, instantiate, validateFailureCaptureProvenance, validateHostFailureEvidenceSummary, type SkillDefinition, type SkillRunExpansion } from './definition.js'
import type { SkillRun, SkillRunStep, SkillStore, StoredSkillDefinition } from './store.js'

type SourceStep = { id: string; toolName: string; arguments: unknown }
type SourceSegment = { runId: string; steps: readonly SourceStep[] }
const resultDetail = /^result:[a-f0-9]{64}$/u
const maximumInputsBytes = 256 * 1024

function fail(message: string): never { throw new Error(`assistant-skills: ${message}`) }
function text(value: unknown, maximum = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\p{Cc}]/u.test(value) }
function json(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length !== 0 || Reflect.ownKeys(value).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor) || !json(descriptor.value)) return false
    }
    return true
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Object.entries(descriptors).every(([key, descriptor]) => key !== '__proto__' && key !== 'prototype' && key !== 'constructor' && descriptor.enumerable && 'value' in descriptor && json(descriptor.value))
}
function clone<T>(value: T): T { if (!json(value)) fail('invalid skill-run expansion value'); return JSON.parse(JSON.stringify(value)) as T }
function record(value: unknown): value is Record<string, unknown> { return json(value) && value !== null && typeof value === 'object' && !Array.isArray(value) }

function sourceSegments(source: VerifiedWorkflowSource): readonly SourceSegment[] {
  if (source.segments === undefined) return [{ runId: source.runId, steps: source.steps }]
  if (!Array.isArray(source.segments)) fail('invalid source expansion segments')
  return source.segments.map(segment => ({ runId: segment.runId, steps: segment.steps }))
}

function skillRunInput(value: unknown): { goalId: string; name: string; version: number; inputs: Record<string, unknown>; invocationId: string } | undefined {
  if (!record(value)) return undefined
  const keys = Object.keys(value)
  if (keys.some(key => !['goal_id', 'name', 'version', 'inputs_json', 'invocation_id'].includes(key))
    || !text(value.goal_id, 256) || !text(value.name, 64) || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || (value.version as number) > 1_000_000_000 || !text(value.invocation_id, 256)) return undefined
  const raw = value.inputs_json === undefined ? '{}' : value.inputs_json
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maximumInputsBytes) return undefined
  let inputs: unknown
  try { inputs = JSON.parse(raw) } catch { return undefined }
  if (!record(inputs)) return undefined
  return { goalId: value.goal_id, name: value.name, version: value.version as number, inputs, invocationId: value.invocation_id }
}

function durableRunId(scope: GoalScope, sessionId: string, invocationId: string): string {
  return `skill-run-${acceptanceDigest([scope, sessionId, invocationId])}`
}

function exactDefinition(store: SkillStore, scope: GoalScope, input: { name: string; version: number }): StoredSkillDefinition | undefined {
  const exact = store.get(scope, input.name, input.version)
  const active = store.get(scope, input.name)
  if (!exact || exact.retired || !active || active.retired || active.version !== input.version || acceptanceDigest(active) !== acceptanceDigest(exact)) return undefined
  return exact
}

function expectedRunSteps(definition: SkillDefinition): readonly { id: string; observation?: { allowAbsent: boolean; toolName: string } }[] {
  const observations = fileObservationSteps(definition)
  const output: Array<{ id: string; observation?: { allowAbsent: boolean; toolName: string } }> = []
  for (const step of definition.steps) {
    for (const observation of observations) if (observation.beforeStepId === step.id) output.push({ id: observation.id, observation: { allowAbsent: observation.allowAbsent, toolName: step.toolName } })
    output.push({ id: step.id })
  }
  return output
}

function validCheckpoint(run: SkillRun, definition: SkillDefinition): boolean {
  const expected = expectedRunSteps(definition)
  if (run.steps.length !== expected.length) return false
  return run.steps.every((actual: SkillRunStep, index) => {
    const wanted = expected[index]
    if (!wanted || actual.id !== wanted.id || actual.state !== 'succeeded') return false
    if (wanted.observation?.allowAbsent === true && wanted.observation.toolName === 'write' && actual.detail === 'absence:FS_NOT_FOUND') return true
    return typeof actual.detail === 'string' && resultDetail.test(actual.detail)
  })
}

/**
 * Bind current-Goals-capability not-achieved evidence to a later, independently
 * achieved repair.  This freezes comparison metadata only; it neither stages
 * nor activates a candidate and grants no authority. The public evidence
 * digest is an integrity link, not producer authentication.
 */
export function captureFailureCandidateProvenance(
  trigger: HostFailureEvidenceSummary,
  repair: VerifiedWorkflowSource,
  scope: GoalScope,
  parent: StoredSkillDefinition,
  candidate: SkillDefinition,
): Readonly<FailureCaptureProvenance> {
  const observed = validateHostFailureEvidenceSummary(trigger)
  if (!record(repair) || Object.keys(repair).some(key => !['protocol', 'scope', 'goal', 'runId', 'turn', 'acceptance', 'steps', 'failedObservations', 'segments'].includes(key))
    || repair.protocol !== 'assistant-goals/verified-workflow-source/v1' || acceptanceDigest(repair.scope) !== acceptanceDigest(scope)
    || acceptanceDigest(observed.scope) !== acceptanceDigest(scope) || !record(repair.goal) || !record(repair.goal.definition)
    || !text(repair.goal.id, 256) || !text(repair.goal.sessionId, 256) || !text(repair.goal.nativeGoalId, 256) || !text(repair.runId, 256)
    || !Number.isSafeInteger(repair.goal.definition.version) || repair.goal.definition.version < 1 || !resultDetail.test(`result:${repair.goal.definition.digest}`)
    || !text(repair.goal.definition.objective, 16_384) || repair.goal.definition.digest !== acceptanceDigest({ objective: repair.goal.definition.objective })
    || !record(repair.acceptance) || Object.keys(repair.acceptance).some(key => !['contractId', 'contractDigest', 'receiptDigest', 'verifiedAt', 'validUntil'].includes(key))
    || !text(repair.acceptance.contractId, 256) || !resultDetail.test(`result:${repair.acceptance.contractDigest}`)
    || !resultDetail.test(`result:${repair.acceptance.receiptDigest}`) || !Number.isSafeInteger(repair.acceptance.verifiedAt) || repair.acceptance.verifiedAt < 0
    || !Number.isSafeInteger(repair.acceptance.validUntil) || repair.acceptance.validUntil <= repair.acceptance.verifiedAt
    || !Array.isArray(repair.steps) || repair.steps.length === 0 || repair.steps.length > 32) fail('achieved repair source is invalid')
  if (acceptanceDigest(repair.goal) !== acceptanceDigest(observed.repairGoal)
    || repair.goal.definition.digest !== observed.taskFamily.definitionDigest || repair.goal.definition.objective !== observed.taskFamily.objective
    || observed.failures.some(failure => failure.goal.id === repair.goal.id || failure.goal.sessionId === repair.goal.sessionId
      || failure.goal.nativeGoalId === repair.goal.nativeGoalId || failure.runId === repair.runId || failure.acceptance.verifiedAt >= repair.acceptance.verifiedAt)
    || repair.acceptance.verifiedAt > observed.attestedAt || repair.acceptance.validUntil <= observed.attestedAt) {
    fail('achieved repair source is not independent or later')
  }
  if (!parent || parent.protocol !== 'assistant-skills/definition/v1' || parent.retired || !Number.isSafeInteger(parent.version) || parent.version < 1
    || parent.name !== candidate.name || !candidate || candidate.protocol !== 'assistant-skills/definition/v1'
    || acceptanceDigest(candidate.source) !== acceptanceDigest(repair)) fail('failure candidate binding is invalid')
  const permissions = (definition: SkillDefinition): readonly string[] => Object.freeze([...new Set(definition.steps.map(step => step.toolName))].sort())
  const parentPermissions = permissions(parent), candidatePermissions = permissions(candidate)
  const before = new Set(parentPermissions), after = new Set(candidatePermissions)
  const output: FailureCaptureProvenance = {
    protocol: 'assistant-skills/failure-capture-provenance/v1',
    trigger: clone(observed),
    repair: { goal: clone(repair.goal), runId: repair.runId, sourceDigest: acceptanceDigest(repair), acceptanceDigest: acceptanceDigest(repair.acceptance) },
    parent: { name: parent.name, version: parent.version, digest: acceptanceDigest(parent) },
    candidate: { name: candidate.name, definitionDigest: acceptanceDigest(candidate) },
    // Diagnostic only: ToolRuntime/Policy must authorize the actual run.
    permissionDelta: { parent: parentPermissions, candidate: candidatePermissions, added: candidatePermissions.filter(tool => !before.has(tool)),
      removed: parentPermissions.filter(tool => !after.has(tool)), expandsAuthority: candidatePermissions.some(tool => !before.has(tool)) },
    rollbackTarget: { name: parent.name, version: parent.version, digest: acceptanceDigest(parent) },
  }
  return validateFailureCaptureProvenance(output)
}

/**
 * Turn a verified source's outer `skill_run` calls into immutable native-step
 * proof. The source still carries the raw outer call; definition construction
 * consumes this proof to substitute only the exact already-verified run.
 */
export function captureRunExpansions(source: VerifiedWorkflowSource, scope: GoalScope, store: SkillStore): readonly SkillRunExpansion[] {
  if (acceptanceDigest(source.scope) !== acceptanceDigest(scope) || !text(source.goal.sessionId, 256) || !text(source.goal.nativeGoalId, 256)) fail('source expansion scope mismatch')
  const expanded: SkillRunExpansion[] = []
  const calls = new Set<string>()
  const runs = new Set<string>()
  for (const segment of sourceSegments(source)) {
    if (!text(segment.runId, 256) || !Array.isArray(segment.steps)) fail('invalid source expansion segment')
    for (const step of segment.steps) {
      if (!step || !text(step.id, 256) || !text(step.toolName, 256) || !json(step.arguments)) fail('invalid source expansion step')
      if (step.id.includes(':skill:') || step.id.includes(':skill-observation:')) fail('nested skill call in source is not reusable')
      if (step.toolName !== 'skill_run') continue
      if (calls.has(step.id)) fail('duplicate source skill_run call')
      calls.add(step.id)
      const input = skillRunInput(step.arguments)
      if (!input || input.goalId !== source.goal.id) fail('source skill_run expansion input is invalid')
      const runId = durableRunId(scope, source.goal.sessionId, input.invocationId)
      if (runs.has(runId)) fail('duplicate source skill_run execution')
      runs.add(runId)
      const run = store.getRun(scope, runId)
      const definition = exactDefinition(store, scope, input)
      if (!run || !definition || run.state !== 'succeeded' || run.id !== runId || run.goalId !== source.goal.id || run.sessionId !== source.goal.sessionId
        || run.skillName !== input.name || run.version !== input.version || acceptanceDigest(run.inputs) !== acceptanceDigest(input.inputs)
        || run.goalExecutionRunId !== segment.runId || run.goalDefinitionDigest !== source.goal.definition.digest
        || run.nativeGoalId !== source.goal.nativeGoalId) fail('source skill_run expansion proof is unavailable')
      const materialized = instantiate(definition, input.inputs)
      if (!validCheckpoint(run, materialized)) fail('source skill_run expansion checkpoint is invalid')
      expanded.push(Object.freeze({ protocol: 'assistant-skills/run-expansion/v1' as const, callId: step.id, runId,
        runDigest: acceptanceDigest(run), definitionDigest: acceptanceDigest(definition), inputsDigest: acceptanceDigest(input.inputs),
        steps: Object.freeze(materialized.steps.map(item => Object.freeze({ id: item.id, toolName: item.toolName, arguments: clone(item.arguments) }))),
      }))
    }
  }
  return Object.freeze(expanded)
}
