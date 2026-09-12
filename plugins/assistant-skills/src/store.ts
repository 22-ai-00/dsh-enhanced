import { closeSync, constants, lstatSync, mkdirSync, openSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { validateFailureCaptureProvenance, type FailureCaptureProvenance, type SkillDefinition } from './definition.js'
import { currentRepairProcess, probeRepairProcess, type RepairProcessWitness } from './repair-process.js'

export type SkillRunState = 'running' | 'succeeded' | 'failed' | 'unknown'
export interface SkillRunStep { id: string; state: 'succeeded' | 'failed' | 'unknown'; detail?: string }
export interface SkillRun {
  id: string
  invocationId: string
  goalId: string
  sessionId: string
  skillName: string
  version: number
  inputs: Readonly<Record<string, unknown>>
  state: SkillRunState
  steps: readonly SkillRunStep[]
  candidateId?: string
  goalExecutionRunId?: string
  goalDefinitionDigest?: string
  nativeGoalId?: string
  createdAt: number
  updatedAt: number
}
export interface SkillRunClaim {
  invocationId: string; goalId: string; sessionId: string; skillName: string; version: number; inputs: Readonly<Record<string, unknown>>
  candidateId?: string; goalExecutionRunId?: string; goalDefinitionDigest?: string; nativeGoalId?: string
}
export interface StoredSkillDefinition extends SkillDefinition { version: number; parentVersion: number | null; retired: boolean; createdAt: number; updatedAt: number; restoredFromVersion?: number }
export interface SkillCandidate {
  id: string
  definition: SkillDefinition
  parentVersion: number
  parentDigest: string | null
  reason: string
  trigger: string
  failureProvenance?: FailureCaptureProvenance
  expiresAt: number
  state: 'pending' | 'activated' | 'rejected'
  createdAt: number
  updatedAt: number
  activatedVersion?: number
  trialRunId?: string
  activationComparisonId?: string
  deploymentId?: string
  acceptanceDigest?: string
  activationWatchDigest?: string
  activationWatchId?: string
}
export interface SkillComparisonIdentity { sessionId: string; candidateId: string; parentDigest: string; profileId: string; profileDigest: string; invocationId: string }
export interface SkillComparison extends SkillComparisonIdentity { id: string; state: 'running' | 'complete' | 'unknown'; result: unknown | null; createdAt: number; updatedAt: number }
export type SkillWatchProofVersion = 'sole-skill-run/v1' | 'canonical-goal-outcome/v2'
export interface SkillWatchTaskFamily { goalDefinitionDigest: string; outcomeProfile: { id: string; version: number; digest: string } }
export interface SkillWatchCanonicalRevision { subjectKind: 'goal-outcome'; subjectRef: string; version: number; digest: string; disposition: 'upsert' | 'retract'; scopeWatermark: number }
export interface SkillWatchObservationBinding { runId: string; subjectRef: string; receiptDigest: string; verifiedAt: number; validUntil: number; executionTraceDigest: string; taskFamilyDigest: string }
export interface SkillWatchObservation { runId: string; receiptDigest: string; objectiveStatus: 'achieved' | 'not-achieved'; verifiedAt: number; validUntil: number; executionTraceDigest: string; taskFamilyDigest?: string; canonical?: SkillWatchCanonicalRevision }
export type SkillWatchObservationResult =
  | Readonly<{ kind: 'current'; observation: SkillWatchObservation & { canonical: SkillWatchCanonicalRevision }; binding?: SkillWatchObservationBinding }>
  | Readonly<{ kind: 'invalidated'; runId: string; canonical: SkillWatchCanonicalRevision; binding?: SkillWatchObservationBinding }>
export interface SkillWatchCanonicalState extends SkillWatchCanonicalRevision { runId: string; binding: SkillWatchObservationBinding }
export interface SkillWatch {
  id: string; scope: object; routeReceipt: unknown; afterRunRowId: number; ownerRouteId: string; skillName: string; version: number; definitionDigest: string; fallbackVersion: number; fallbackDigest: string
  expiresAt: number; maxRuns: number; failureThreshold: number; state: 'watching' | 'rolled-back' | 'expired' | 'revoked' | 'superseded' | 'exhausted'
  runIds: readonly string[]; observations: readonly SkillWatchObservation[]; canonicalRevisions?: readonly SkillWatchCanonicalState[]; createdAt: number; updatedAt: number; rollbackVersion?: number; proofVersion?: SkillWatchProofVersion; taskFamily?: SkillWatchTaskFamily
}
export interface SkillWatchInput { ownerRouteId: string; skillName: string; version: number; fallbackVersion: number; expiresAt: number; maxRuns: number; failureThreshold: number }
export interface SkillDeploymentInput { ownerRouteId: string; expiresAt: number; maxRuns: number; canaryRuns: number }
export interface SkillDeploymentAdmission { protocol: 'assistant-skills/canary-admission/v1'; skillName: string; parentDefinitionDigest: string; candidateDefinitionDigest: string; taskFamily: SkillWatchTaskFamily }
export interface SkillDeployment {
  id: string; scope: object; candidateId: string; comparisonId: string; qualificationDigest: string; admissionDigest: string; candidateDefinitionDigest: string; routeReceipt: unknown; ownerRouteId: string
  skillName: string; version: number; definitionDigest: string; parentVersion: number; watchId: string; taskFamily: SkillWatchTaskFamily
  expiresAt: number; maxRuns: number; canaryRuns: number; runIds: string[]
  state: 'canary' | 'promoted' | 'blocked' | 'expired' | 'revoked' | 'rolled-back' | 'superseded'
  createdAt: number; updatedAt: number; promotedAt?: number
}
export interface SkillCapture {
  id: string; scope: object; routeReceipt: unknown; ownerRouteId: string; goalId: string; sessionId: string
  nativeGoalId: string; name: string; description: string; parentVersion: number; parentDigest: string | null; definitionDigest: string
  expiresAt: number; state: 'pending' | 'captured' | 'revoked' | 'expired' | 'unsupported' | 'unknown'; candidateId?: string; detail?: string; createdAt: number; updatedAt: number
}
export interface SkillCaptureInput { ownerRouteId: string; goalId: string; sessionId: string; nativeGoalId: string; name: string; description: string; parentVersion: number; expiresAt: number }
export interface SkillCandidateOptions { expectedVersion: number; reason: string; trigger: string; expiresAt: number; failureProvenance?: FailureCaptureProvenance }
export type SkillRepairState = 'armed' | 'source-confirmed' | 'creating-repair' | 'repairing' | 'repair-achieved' | 'capturing' | 'candidate-staged' | 'comparing' | 'watching' | 'complete' | 'rejected' | 'revoked' | 'expired' | 'unknown'
export interface SkillRepairAuthorizationInput {
  invocationId: string
  ownerRouteId: string
  source: { goalId: string; sessionId: string; nativeGoalId: string; definitionDigest: string }
  profileId: string
  profileDigest: string
  skillName: string
  parentVersion: number
  parentDigest: string
  maxIterations: number
  expiresAt: number
  profileSequence?: readonly { id: string; digest: string }[]
  feedbackAuthority?: { sessionId: string; expiresAt: number; routeReceipt: unknown }
}
export interface SkillRepairNextIterationInput {
  profileId: string
  source: { goalId: string; sessionId: string; nativeGoalId: string; definitionDigest: string }
  trigger: unknown
  predecessorDeploymentId: string
}
export interface SkillRepairContinuation {
  id: string
  scope: object
  authorization: SkillRepairAuthorizationInput
  authorizationDigest: string
  routeReceipt: unknown
  iteration: number
  revision: number
  state: SkillRepairState
  checkpoint: Readonly<Record<string, unknown>>
  createdAt: number
  updatedAt: number
}
export interface RepairExecutionLease {
  authorizationId: string; authorizationDigest: string; iteration: number; sessionId: string; holderId: string; fence: number; deadlineAt: number
  process: RepairProcessWitness
  state: 'active' | 'released'
  pendingModel: number; pendingTool: number
}

function fail(message = 'assistant-skills: store operation rejected'): never { throw new Error(message) }
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
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor && json(descriptor.value)
  })
}
function clone<T>(value: T): T { if (!json(value)) fail('assistant-skills: invalid JSON value'); return JSON.parse(JSON.stringify(value)) as T }
function scopeKey(scope: unknown): string { if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !json(scope)) fail('assistant-skills: invalid scope'); return acceptanceDigest(scope) }
function name(value: unknown): value is string { return typeof value === 'string' && /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value) }
function version(value: unknown, allowZero = false): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= 1_000_000_000 }
function text(value: unknown, maximum = 512): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\p{Cc}]/u.test(value) }
function runId(scope: unknown, sessionId: string, invocationId: string): string { return `skill-run-${acceptanceDigest([scope, sessionId, invocationId])}` }
function comparisonId(scope: unknown, sessionId: string, invocationId: string): string { return `skill-comparison-${acceptanceDigest([scope, sessionId, invocationId])}` }
function watchId(scope: unknown, input: SkillWatchInput): string { return `skill-watch-${acceptanceDigest([scope, input])}` }
function deploymentId(scope: unknown, candidateId: string, comparisonId: string, qualificationDigest: string, admission: SkillDeploymentAdmission, input: SkillDeploymentInput, routeReceipt: unknown): string { return `skill-deployment-${acceptanceDigest([scope, candidateId, comparisonId, qualificationDigest, admission, input, routeReceipt])}` }
function repairContinuationId(scope: unknown, input: SkillRepairAuthorizationInput): string { return `skill-repair-${acceptanceDigest([scope, input.ownerRouteId, input.invocationId])}` }
function definitionValid(definition: unknown): definition is SkillDefinition { return !!definition && typeof definition === 'object' && (definition as SkillDefinition).protocol === 'assistant-skills/definition/v1' && name((definition as SkillDefinition).name) && json(definition) }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function canonicalRevision(value: unknown): value is SkillWatchCanonicalRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !json(value)) return false
  const revision = value as SkillWatchCanonicalRevision
  return Object.keys(revision).length === 6 && revision.subjectKind === 'goal-outcome' && text(revision.subjectRef, 1_000)
    && version(revision.version) && digest(revision.digest) && ['upsert', 'retract'].includes(revision.disposition)
    && Number.isSafeInteger(revision.scopeWatermark) && revision.scopeWatermark >= revision.version
}
function observationBinding(observation: SkillWatchObservation, subjectRef: string): SkillWatchObservationBinding | undefined {
  if (!text(observation.runId, 128) || !digest(observation.receiptDigest) || !Number.isSafeInteger(observation.verifiedAt)
    || !Number.isSafeInteger(observation.validUntil) || !digest(observation.executionTraceDigest) || !digest(observation.taskFamilyDigest) || !text(subjectRef, 1_000)) return
  return { runId: observation.runId, subjectRef, receiptDigest: observation.receiptDigest, verifiedAt: observation.verifiedAt, validUntil: observation.validUntil,
    executionTraceDigest: observation.executionTraceDigest, taskFamilyDigest: observation.taskFamilyDigest }
}
function validObservationBinding(value: unknown): value is SkillWatchObservationBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !json(value) || Object.keys(value).length !== 7) return false
  const candidate = value as SkillWatchObservationBinding
  return text(candidate.runId, 128) && text(candidate.subjectRef, 1_000) && digest(candidate.receiptDigest)
    && Number.isSafeInteger(candidate.verifiedAt) && Number.isSafeInteger(candidate.validUntil)
    && digest(candidate.executionTraceDigest) && digest(candidate.taskFamilyDigest)
}
function validCanonicalState(value: unknown): value is SkillWatchCanonicalState {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !json(value) || Object.keys(value).length !== 8) return false
  const state = value as SkillWatchCanonicalState
  const { runId: _runId, binding, ...revision } = state
  return text(state.runId, 128) && canonicalRevision(revision) && validObservationBinding(binding)
    && binding.runId === state.runId && binding.subjectRef === state.subjectRef
}
function validRunIds(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(item => text(item, 128))
    && new Set(value).size === value.length
}
function exactCanonicalObservationState(watch: SkillWatch, deployment: SkillDeployment): boolean {
  const admission = { protocol: 'assistant-skills/canary-admission/v1' as const, skillName: deployment.skillName,
    parentDefinitionDigest: watch.fallbackDigest, candidateDefinitionDigest: deployment.candidateDefinitionDigest, taskFamily: deployment.taskFamily }
  if (watch.state !== 'watching' || watch.id !== deployment.watchId || watch.skillName !== deployment.skillName
    || watch.version !== deployment.version || watch.definitionDigest !== deployment.definitionDigest
    || watch.maxRuns !== deployment.maxRuns || watch.failureThreshold !== 1 || !validRunIds(watch.runIds)
    || !validRunIds(deployment.runIds) || !Number.isSafeInteger(deployment.canaryRuns) || deployment.canaryRuns < 1
    || deployment.canaryRuns > deployment.maxRuns || deployment.maxRuns < 1 || deployment.maxRuns > 100
    || watch.runIds.length > watch.maxRuns || deployment.runIds.length > deployment.maxRuns
    || watch.runIds.some(run => !deployment.runIds.includes(run)) || !deploymentAdmission(admission)
    || deployment.admissionDigest !== acceptanceDigest(admission)
    || watch.proofVersion !== 'canonical-goal-outcome/v2' || !watch.taskFamily
    || acceptanceDigest(watch.taskFamily) !== acceptanceDigest(deployment.taskFamily)
    || !Array.isArray(watch.observations) || !Array.isArray(watch.canonicalRevisions)) return false
  const familyDigest = acceptanceDigest(watch.taskFamily), revisions = new Map<string, SkillWatchCanonicalState>()
  for (const revision of watch.canonicalRevisions) {
    if (!validCanonicalState(revision) || revisions.has(revision.runId) || !watch.runIds.includes(revision.runId)
      || !deployment.runIds.includes(revision.runId) || revision.binding.taskFamilyDigest !== familyDigest) return false
    revisions.set(revision.runId, revision)
  }
  const observedRuns = new Set<string>()
  for (const observation of watch.observations) {
    if (observedRuns.has(observation.runId) || !observation.canonical || !canonicalRevision(observation.canonical)
      || !digest(observation.receiptDigest) || !Number.isSafeInteger(observation.verifiedAt) || !Number.isSafeInteger(observation.validUntil)
      || !digest(observation.executionTraceDigest) || !['achieved', 'not-achieved'].includes(observation.objectiveStatus)
      || observation.taskFamilyDigest !== familyDigest) return false
    observedRuns.add(observation.runId)
    const revision = revisions.get(observation.runId)
    if (!revision || revision.disposition !== 'upsert' || acceptanceDigest(observation.canonical) !== acceptanceDigest({
      subjectKind: revision.subjectKind, subjectRef: revision.subjectRef, version: revision.version, digest: revision.digest,
      disposition: revision.disposition, scopeWatermark: revision.scopeWatermark,
    }) || acceptanceDigest(revision.binding) !== acceptanceDigest({
      runId: observation.runId, subjectRef: observation.canonical.subjectRef, receiptDigest: observation.receiptDigest, verifiedAt: observation.verifiedAt,
      validUntil: observation.validUntil, executionTraceDigest: observation.executionTraceDigest, taskFamilyDigest: observation.taskFamilyDigest,
    })) return false
  }
  if (![...revisions.values()].every(revision => revision.disposition === 'upsert' && observedRuns.has(revision.runId))
    || watch.observations.some(observation => observation.objectiveStatus !== 'achieved')) return false
  // A previously promoted deployment keeps its historical first-proof
  // binding after that receipt expires; currentness comes from the canonical
  // Evaluation tuple. Freshness is still required at the canary -> promoted
  // transition below.
  return deployment.state !== 'promoted' || new Set(watch.observations.filter(observation => observation.objectiveStatus === 'achieved')
    .map(observation => observation.runId)).size >= deployment.canaryRuns
}
function recordWithDigest(value: unknown, field: string, expected: string): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.hasOwn(value, field) && (value as Record<string, unknown>)[field] === expected
}
function deploymentAdmission(value: unknown): value is SkillDeploymentAdmission {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !json(value)) return false
  const admission = value as SkillDeploymentAdmission
  return Object.keys(admission).length === 5 && admission.protocol === 'assistant-skills/canary-admission/v1' && name(admission.skillName)
    && digest(admission.parentDefinitionDigest) && digest(admission.candidateDefinitionDigest) && !!admission.taskFamily
    && Object.keys(admission.taskFamily).length === 2 && digest(admission.taskFamily.goalDefinitionDigest) && !!admission.taskFamily.outcomeProfile
    && Object.keys(admission.taskFamily.outcomeProfile).length === 3 && text(admission.taskFamily.outcomeProfile.id, 256)
    && version(admission.taskFamily.outcomeProfile.version) && digest(admission.taskFamily.outcomeProfile.digest)
}
function candidateOptions(value: unknown): value is SkillCandidateOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Object.keys(descriptors)
  return keys.every(key => ['expectedVersion', 'reason', 'trigger', 'expiresAt', 'failureProvenance'].includes(key))
    && ['expectedVersion', 'reason', 'trigger', 'expiresAt'].every(key => keys.includes(key))
    && Object.values(descriptors).every(descriptor => descriptor.enumerable && 'value' in descriptor)
}
function repairAuthorization(value: unknown): value is SkillRepairAuthorizationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !json(value)) return false
  const input = value as SkillRepairAuthorizationInput
  if (!Object.keys(input).every(key => ['invocationId', 'ownerRouteId', 'source', 'profileId', 'profileDigest', 'skillName', 'parentVersion', 'parentDigest', 'maxIterations', 'expiresAt', 'profileSequence', 'feedbackAuthority'].includes(key))
    || !['invocationId', 'ownerRouteId', 'source', 'profileId', 'profileDigest', 'skillName', 'parentVersion', 'parentDigest', 'maxIterations', 'expiresAt'].every(key => Object.hasOwn(input, key))
    || !text(input.invocationId, 256) || !text(input.ownerRouteId, 256) || !text(input.profileId, 256) || !digest(input.profileDigest)
    || !name(input.skillName) || !version(input.parentVersion) || !digest(input.parentDigest) || !Number.isSafeInteger(input.maxIterations) || input.maxIterations < 1 || input.maxIterations > 4
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 7 * 86400000) return false
  if (input.profileSequence !== undefined && (!Array.isArray(input.profileSequence) || input.profileSequence.length !== input.maxIterations
    || input.profileSequence.some(item => !item || typeof item !== 'object' || Object.keys(item).length !== 2 || !text(item.id, 128) || !digest(item.digest))
    || input.profileSequence[0]?.id !== input.profileId || input.profileSequence[0]?.digest !== input.profileDigest)) return false
  if (input.feedbackAuthority !== undefined) {
    const authority = input.feedbackAuthority
    if (!authority || typeof authority !== 'object' || Object.keys(authority).length !== 3 || !text(authority.sessionId, 512)
      || !Number.isSafeInteger(authority.expiresAt) || authority.expiresAt <= Date.now() || authority.expiresAt > input.expiresAt || !json(authority.routeReceipt)) return false
  }
  const source = input.source
  return !!source && typeof source === 'object' && !Array.isArray(source) && json(source) && Object.keys(source).length === 4
    && text(source.goalId, 256) && text(source.sessionId, 512) && text(source.nativeGoalId, 256) && digest(source.definitionDigest)
}
function repairSource(value: unknown): value is SkillRepairAuthorizationInput['source'] {
  return !!value && typeof value === 'object' && !Array.isArray(value) && json(value) && Object.keys(value).length === 4
    && text((value as Record<string, unknown>).goalId, 256) && text((value as Record<string, unknown>).sessionId, 512)
    && text((value as Record<string, unknown>).nativeGoalId, 256) && digest((value as Record<string, unknown>).definitionDigest)
}
function repairNextIteration(value: unknown): value is SkillRepairNextIterationInput {
  return !!value && typeof value === 'object' && !Array.isArray(value) && json(value) && Object.keys(value).length === 4
    && repairSource((value as Record<string, unknown>).source) && Object.hasOwn(value, 'trigger')
    && text((value as Record<string, unknown>).predecessorDeploymentId, 256) && text((value as Record<string, unknown>).profileId, 128)
}
function repairCheckpoint(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !json(value)) return false
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 128 * 1024 } catch { return false }
}
function repairState(value: unknown): value is SkillRepairState {
  return typeof value === 'string' && ['armed', 'source-confirmed', 'creating-repair', 'repairing', 'repair-achieved', 'capturing', 'candidate-staged', 'comparing', 'watching', 'complete', 'rejected', 'revoked', 'expired', 'unknown'].includes(value)
}
function repairTransition(from: SkillRepairState, to: SkillRepairState): boolean {
  if (['complete', 'rejected', 'revoked', 'expired', 'unknown'].includes(from)) return false
  if (['rejected', 'revoked', 'expired', 'unknown'].includes(to)) return true
  return ({ armed: 'source-confirmed', 'source-confirmed': 'creating-repair', 'creating-repair': 'repairing', repairing: 'repair-achieved', 'repair-achieved': 'capturing', capturing: 'candidate-staged', 'candidate-staged': 'comparing', comparing: 'watching', watching: 'complete' } as Partial<Record<SkillRepairState, SkillRepairState>>)[from] === to
}

function privatePath(path: string): void {
  if (!isAbsolute(path)) fail('assistant-skills: database path must be absolute')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const directory = lstatSync(dirname(path))
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022) !== 0) fail('assistant-skills: unsafe database directory')
  try { lstatSync(path) } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); chmodSync(path, 0o600)
  }
  for (const item of [path, `${path}-wal`, `${path}-shm`]) {
    try { const stat = lstatSync(item); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail('assistant-skills: unsafe database file') } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
}

/** Owner-scoped immutable definitions and no-replay invocation receipts. */
export class SkillStore {
  readonly #db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') privatePath(path)
    this.#db = new DatabaseSync(path)
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS skill_definitions(scope_key TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, retired INTEGER NOT NULL, definition_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope_key,name,version)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_runs(id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, identity_json TEXT NOT NULL, run_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','unknown'))) STRICT;
      CREATE TABLE IF NOT EXISTS skill_candidates(scope_key TEXT NOT NULL, id TEXT NOT NULL, candidate_json TEXT NOT NULL, PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_comparisons(scope_key TEXT NOT NULL,id TEXT NOT NULL,profile_id TEXT NOT NULL,identity_json TEXT NOT NULL,comparison_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('running','complete','unknown')),PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_watches(scope_key TEXT NOT NULL,id TEXT NOT NULL,watch_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('watching','rolled-back','expired','revoked','superseded','exhausted')),PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_deployments(scope_key TEXT NOT NULL,id TEXT NOT NULL,deployment_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('canary','promoted','blocked','expired','revoked','rolled-back','superseded')),PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_captures(scope_key TEXT NOT NULL,id TEXT NOT NULL,capture_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','captured','revoked','expired','unsupported','unknown')),PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_repair_continuations(scope_key TEXT NOT NULL,id TEXT NOT NULL,authorization_digest TEXT NOT NULL,route_receipt_digest TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('armed','source-confirmed','creating-repair','repairing','repair-achieved','capturing','candidate-staged','comparing','watching','complete','rejected','revoked','expired','unknown')),continuation_json TEXT NOT NULL,PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_repair_usage(scope_key TEXT NOT NULL,id TEXT NOT NULL,authorization_digest TEXT NOT NULL,model_calls INTEGER NOT NULL CHECK(model_calls>=0),tool_calls INTEGER NOT NULL CHECK(tool_calls>=0),PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_repair_execution(scope_key TEXT NOT NULL,id TEXT NOT NULL,iteration INTEGER NOT NULL,lease_json TEXT NOT NULL,fence INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','released')),pending_model INTEGER NOT NULL CHECK(pending_model>=0),pending_tool INTEGER NOT NULL CHECK(pending_tool>=0),PRIMARY KEY(scope_key,id,iteration)) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS skill_definitions_current ON skill_definitions(scope_key,name,version DESC);
      CREATE INDEX IF NOT EXISTS skill_runs_scope ON skill_runs(scope_key,id);
      CREATE INDEX IF NOT EXISTS skill_watches_scope_state ON skill_watches(scope_key,state);
      CREATE INDEX IF NOT EXISTS skill_deployments_scope_state ON skill_deployments(scope_key,state);
      CREATE INDEX IF NOT EXISTS skill_captures_scope_state ON skill_captures(scope_key,state);
      CREATE INDEX IF NOT EXISTS skill_repair_continuations_scope_state ON skill_repair_continuations(scope_key,state);
`)
    this.#db.prepare("UPDATE skill_runs SET state='unknown', run_json=json_set(run_json, '$.state', 'unknown', '$.updatedAt', ?) WHERE state='running'").run(Date.now())
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const migrationTime = Date.now()
      this.#db.prepare("UPDATE skill_watches SET state='revoked', watch_json=json_set(watch_json, '$.state', 'revoked', '$.updatedAt', ?) WHERE state='watching' AND (coalesce(json_extract(watch_json, '$.proofVersion'), '') NOT IN ('sole-skill-run/v1','canonical-goal-outcome/v2') OR EXISTS (SELECT 1 FROM skill_deployments deployment WHERE deployment.scope_key=skill_watches.scope_key AND json_extract(deployment.deployment_json, '$.watchId')=skill_watches.id AND deployment.state IN ('canary','promoted') AND (length(coalesce(json_extract(deployment.deployment_json, '$.admissionDigest'), ''))<>64 OR coalesce(json_extract(deployment.deployment_json, '$.admissionDigest'), '') GLOB '*[^0-9a-f]*' OR length(coalesce(json_extract(deployment.deployment_json, '$.candidateDefinitionDigest'), ''))<>64 OR coalesce(json_extract(deployment.deployment_json, '$.candidateDefinitionDigest'), '') GLOB '*[^0-9a-f]*' OR coalesce(json_type(deployment.deployment_json, '$.taskFamily'), '')<>'object' OR coalesce(json_type(skill_watches.watch_json, '$.taskFamily'), '')<>'object')))").run(migrationTime)
      const active = this.#db.prepare("SELECT scope_key, deployment_json FROM skill_deployments WHERE state IN ('canary','promoted')").all() as { scope_key: string; deployment_json: string }[]
      for (const row of active) {
        const deployment = JSON.parse(row.deployment_json) as SkillDeployment
        const watch = this.#watch(row.scope_key, deployment.watchId)
        const legacyShape = !digest(deployment.admissionDigest) || !digest(deployment.candidateDefinitionDigest) || !deployment.taskFamily
        if (!watch || legacyShape || !exactCanonicalObservationState(watch, deployment)) {
          this.#putDeployment(row.scope_key, { ...deployment, state: 'blocked', updatedAt: migrationTime })
        }
      }
      this.#db.exec('COMMIT')
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
    this.#db.prepare("UPDATE skill_deployments SET state='blocked', deployment_json=json_set(deployment_json, '$.state', 'blocked', '$.updatedAt', ?) WHERE state IN ('canary','promoted') AND EXISTS (SELECT 1 FROM json_each(skill_deployments.deployment_json, '$.runIds') claimed JOIN skill_runs run ON run.id=claimed.value AND run.scope_key=skill_deployments.scope_key WHERE run.state IN ('unknown','failed'))").run(Date.now())
    this.#db.prepare("UPDATE skill_comparisons SET state='unknown', comparison_json=json_set(comparison_json, '$.state', 'unknown', '$.updatedAt', ?) WHERE state='running'").run(Date.now())
    this.#db.exec("CREATE UNIQUE INDEX IF NOT EXISTS skill_runs_one_active ON skill_runs(scope_key,json_extract(identity_json,'$.sessionId'),json_extract(identity_json,'$.goalId')) WHERE state='running'")
    this.#db.exec("CREATE UNIQUE INDEX IF NOT EXISTS skill_comparisons_one_active ON skill_comparisons(scope_key) WHERE state='running'")
  }
  close(): void { this.#db.close() }
  inspectRepairExecution(scope: object, id: string, iteration: number): RepairExecutionLease | undefined {
    const key = scopeKey(scope)
    if (!text(id, 128) || !version(iteration)) fail('assistant-skills: invalid repair execution reference')
    const value = this.#repairExecution(key, id, iteration)
    return value === undefined ? undefined : clone(value)
  }
  claimRepairExecution(scope: object, id: string, iteration: number, sessionId: string, holderId: string, deadlineAt: number, options: { recover: boolean }): RepairExecutionLease {
    const key = scopeKey(scope)
    if (!text(id, 128) || !version(iteration) || !text(sessionId, 512) || !text(holderId, 512)
      || !Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now() || !options || Object.keys(options).length !== 1 || typeof options.recover !== 'boolean') fail('assistant-skills: invalid repair execution claim')
    const process = currentRepairProcess()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const continuation = this.#repairExecutionAuthorization(key, id, iteration, deadlineAt)
      const current = this.#repairExecution(key, id, iteration)
      if (!options.recover) {
        if (current !== undefined || !process) fail('assistant-skills: repair execution recovery required')
        const lease: RepairExecutionLease = { authorizationId: id, authorizationDigest: continuation.authorizationDigest, iteration, sessionId, holderId, fence: 1, deadlineAt,
          process, state: 'active', pendingModel: 0, pendingTool: 0 }
        this.#putRepairExecution(key, lease); this.#db.exec('COMMIT'); return clone(lease)
      }
      if (!current || current.authorizationDigest !== continuation.authorizationDigest || current.sessionId !== sessionId || current.iteration !== iteration || current.deadlineAt !== deadlineAt) fail('assistant-skills: repair execution recovery unavailable')
      if (current.state === 'released' && current.pendingModel === 0 && current.pendingTool === 0 && this.#sameRepairProcess(current.process, process)) {
        const lease = { ...current, holderId, fence: current.fence + 1, process: process ?? current.process, state: 'active' as const }
        this.#updateRepairExecution(key, current, lease); this.#db.exec('COMMIT'); return clone(lease)
      }
      if (!['active', 'released'].includes(current.state) || current.pendingModel !== 0 || current.pendingTool !== 0 || !process || probeRepairProcess(current.process) !== 'gone') fail('assistant-skills: repair execution holder remains authoritative')
      const lease: RepairExecutionLease = { ...current, holderId, fence: current.fence + 1, process, state: 'active' }
      this.#updateRepairExecution(key, current, lease); this.#db.exec('COMMIT'); return clone(lease)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  assertRepairExecution(scope: object, lease: RepairExecutionLease): void {
    const key = scopeKey(scope); this.#assertRepairExecution(key, lease, true)
  }
  beginRepairEffect(scope: object, lease: RepairExecutionLease, kind: 'model' | 'tool'): () => void {
    const key = scopeKey(scope)
    if (kind !== 'model' && kind !== 'tool') fail('assistant-skills: invalid repair effect')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#assertRepairExecution(key, lease, true)
      const field = kind === 'model' ? 'pendingModel' : 'pendingTool'
      const saved = { ...current, [field]: current[field] + 1 }
      this.#updateRepairExecution(key, current, saved); this.#db.exec('COMMIT')
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
    let finished = false
    return () => {
      if (finished) return
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        const current = this.#repairExecution(key, lease.authorizationId, lease.iteration)
        const field = kind === 'model' ? 'pendingModel' : 'pendingTool'
        if (!current || current.fence !== lease.fence || current.authorizationDigest !== lease.authorizationDigest || current.sessionId !== lease.sessionId
          || current.holderId !== lease.holderId || current.deadlineAt !== lease.deadlineAt || !this.#sameRepairProcess(current.process, currentRepairProcess())
          || current.state !== 'active' || current[field] < 1) fail('assistant-skills: repair effect fence conflict')
        this.#updateRepairExecution(key, current, { ...current, [field]: current[field] - 1 }); this.#db.exec('COMMIT'); finished = true
      } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
    }
  }
  releaseRepairExecution(scope: object, lease: RepairExecutionLease): void {
    const key = scopeKey(scope); this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#assertRepairExecution(key, lease, false)
      if (current.pendingModel !== 0 || current.pendingTool !== 0) fail('assistant-skills: repair effects remain pending')
      this.#updateRepairExecution(key, current, { ...current, state: 'released' }); this.#db.exec('COMMIT')
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  createRepairContinuation(scope: object, input: SkillRepairAuthorizationInput, routeReceipt: unknown): SkillRepairContinuation {
    const key = scopeKey(scope)
    if (!repairAuthorization(input) || !json(routeReceipt)) fail('assistant-skills: invalid repair continuation')
    const authorization = clone(input), receipt = clone(routeReceipt), id = repairContinuationId(scope, authorization)
    const authorizationDigest = acceptanceDigest(authorization), routeReceiptDigest = acceptanceDigest(receipt)
    if (authorization.feedbackAuthority !== undefined && acceptanceDigest(authorization.feedbackAuthority.routeReceipt) !== routeReceiptDigest) fail('assistant-skills: repair feedback authority route mismatch')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#repairContinuation(key, id)
      if (existing) {
        if (existing.authorizationDigest !== authorizationDigest || acceptanceDigest(existing.routeReceipt) !== routeReceiptDigest) fail('assistant-skills: repair continuation conflict')
        this.#db.exec('COMMIT'); return clone(existing)
      }
      const now = Date.now(), continuation: SkillRepairContinuation = { id, scope: clone(scope), authorization, authorizationDigest, routeReceipt: receipt, iteration: 1, revision: 1, state: 'armed', checkpoint: {}, createdAt: now, updatedAt: now }
      this.#db.prepare('INSERT INTO skill_repair_continuations VALUES(?,?,?,?,?,?,?)').run(key, id, authorizationDigest, routeReceiptDigest, continuation.revision, continuation.state, JSON.stringify(continuation))
      this.#db.prepare('INSERT INTO skill_repair_usage VALUES(?,?,?,?,?)').run(key, id, authorizationDigest, 0, 0)
      this.#db.exec('COMMIT'); return clone(continuation)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  repairUsage(scope: object, id: string): { modelCalls: number; toolCalls: number } {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid repair usage reference')
    const current = this.#repairContinuation(key, id); if (!current) fail('assistant-skills: repair continuation missing')
    const row = this.#db.prepare('SELECT authorization_digest,model_calls,tool_calls FROM skill_repair_usage WHERE scope_key=? AND id=?').get(key, id) as { authorization_digest: string; model_calls: number; tool_calls: number } | undefined
    if (!row || row.authorization_digest !== current.authorizationDigest) fail('assistant-skills: repair usage unavailable')
    return { modelCalls: row.model_calls, toolCalls: row.tool_calls }
  }
  chargeRepairUsage(scope: object, id: string, kind: 'model' | 'tool', limit: number): { modelCalls: number; toolCalls: number } {
    const key = scopeKey(scope)
    if (!text(id, 128) || !['model', 'tool'].includes(kind) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000_000) fail('assistant-skills: invalid repair usage charge')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#repairContinuation(key, id); if (!current) fail('assistant-skills: repair continuation missing')
      const row = this.#db.prepare('SELECT authorization_digest,model_calls,tool_calls FROM skill_repair_usage WHERE scope_key=? AND id=?').get(key, id) as { authorization_digest: string; model_calls: number; tool_calls: number } | undefined
      if (!row || row.authorization_digest !== current.authorizationDigest || (kind === 'model' ? row.model_calls : row.tool_calls) >= limit) fail('assistant-skills: repair usage exhausted')
      const field = kind === 'model' ? 'model_calls' : 'tool_calls'
      if (this.#db.prepare(`UPDATE skill_repair_usage SET ${field}=${field}+1 WHERE scope_key=? AND id=? AND authorization_digest=? AND ${field}<?`).run(key, id, current.authorizationDigest, limit).changes !== 1) fail('assistant-skills: repair usage exhausted')
      const saved = this.#db.prepare('SELECT model_calls,tool_calls FROM skill_repair_usage WHERE scope_key=? AND id=?').get(key, id) as { model_calls: number; tool_calls: number }
      this.#db.exec('COMMIT'); return { modelCalls: saved.model_calls, toolCalls: saved.tool_calls }
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  getRepairContinuation(scope: object, id: string): SkillRepairContinuation | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid repair continuation reference')
    const continuation = this.#repairContinuation(key, id)
    return continuation === undefined ? undefined : clone(continuation)
  }
  listRepairContinuations(scope?: object): SkillRepairContinuation[] {
    const rows = scope === undefined
      ? this.#db.prepare('SELECT continuation_json FROM skill_repair_continuations ORDER BY id').all()
      : this.#db.prepare('SELECT continuation_json FROM skill_repair_continuations WHERE scope_key=? ORDER BY id').all(scopeKey(scope))
    return (rows as { continuation_json: string }[]).map(row => clone(JSON.parse(row.continuation_json) as SkillRepairContinuation))
  }
  repairSourceRuns(scope: object, skillName: string, skillVersion: number, since: number): readonly SkillRun[] {
    const key = scopeKey(scope)
    if (!name(skillName) || !version(skillVersion) || !Number.isSafeInteger(since) || since < 0) fail('assistant-skills: invalid repair source run query')
    const rows = this.#db.prepare("SELECT run_json FROM skill_runs WHERE scope_key=? AND state='succeeded' AND json_extract(run_json,'$.skillName')=? AND json_extract(run_json,'$.version')=? AND json_extract(run_json,'$.createdAt')>? ORDER BY json_extract(run_json,'$.createdAt') ASC,id ASC LIMIT 50")
      .all(key, skillName, skillVersion, since) as { run_json: string }[]
    return Object.freeze(rows.map(row => clone(JSON.parse(row.run_json) as SkillRun)))
  }
  transitionRepairContinuation(scope: object, id: string, expectedRevision: number, nextState: SkillRepairState, checkpoint: Readonly<Record<string, unknown>>): SkillRepairContinuation {
    const key = scopeKey(scope)
    if (!text(id, 128) || !version(expectedRevision) || !repairState(nextState) || !repairCheckpoint(checkpoint)) fail('assistant-skills: invalid repair continuation transition')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#repairContinuation(key, id)
      if (!current) fail('assistant-skills: repair continuation missing')
      if (current.revision !== expectedRevision || !repairTransition(current.state, nextState)) fail('assistant-skills: repair continuation state conflict')
      const saved: SkillRepairContinuation = { ...current, state: nextState, checkpoint: clone(checkpoint), revision: current.revision + 1, updatedAt: Date.now() }
      if (this.#db.prepare('UPDATE skill_repair_continuations SET revision=?,state=?,continuation_json=? WHERE scope_key=? AND id=? AND revision=? AND state=?')
        .run(saved.revision, saved.state, JSON.stringify(saved), key, id, current.revision, current.state).changes !== 1) fail('assistant-skills: repair continuation state conflict')
      this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  nextRepairIteration(scope: object, id: string, expectedRevision: number, input: SkillRepairNextIterationInput): SkillRepairContinuation {
    const key = scopeKey(scope)
    if (!text(id, 128) || !version(expectedRevision) || !repairNextIteration(input)) fail('assistant-skills: invalid repair continuation iteration')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#repairContinuation(key, id)
      if (!current) fail('assistant-skills: repair continuation missing')
      const deploymentId = current.checkpoint.deploymentId
      const previous = Array.isArray(current.checkpoint.iterationHistory) ? current.checkpoint.iterationHistory : []
      const sourceDigest = acceptanceDigest(input.source), triggerDigest = acceptanceDigest(input.trigger)
      const previousSources = [acceptanceDigest(current.authorization.source), ...previous.map(value => acceptanceDigest((value as Record<string, unknown>).source))]
      const previousTriggers = [current.checkpoint.trigger === undefined ? undefined : acceptanceDigest(current.checkpoint.trigger), ...previous.map(value => (value as Record<string, unknown>).triggerDigest)]
      if (current.revision !== expectedRevision || current.state !== 'watching' || current.iteration >= current.authorization.maxIterations || current.authorization.expiresAt <= Date.now()
        || current.authorization.profileSequence?.[current.iteration]?.id !== input.profileId || deploymentId !== input.predecessorDeploymentId || previousSources.includes(sourceDigest) || previousTriggers.includes(triggerDigest)) fail('assistant-skills: repair continuation unavailable')
      const history = [...previous, { profileId: input.profileId, source: clone(input.source), triggerDigest, predecessorDeploymentId: input.predecessorDeploymentId }]
      const checkpoint = { iterationHistory: history, profileId: input.profileId, source: clone(input.source), trigger: clone(input.trigger), predecessorDeploymentId: input.predecessorDeploymentId }
      const saved: SkillRepairContinuation = { ...current, iteration: current.iteration + 1, revision: current.revision + 1, state: 'armed', checkpoint, updatedAt: Date.now() }
      if (this.#db.prepare("UPDATE skill_repair_continuations SET revision=?,state='armed',continuation_json=? WHERE scope_key=? AND id=? AND revision=? AND state='watching'")
        .run(saved.revision, JSON.stringify(saved), key, id, current.revision).changes !== 1) fail('assistant-skills: repair continuation state conflict')
      this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  save(scope: object, definition: SkillDefinition, expectedVersion = 0): StoredSkillDefinition {
    const key = scopeKey(scope)
    if (!definitionValid(definition) || !version(expectedVersion, true)) fail('assistant-skills: invalid definition')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#latest(key, definition.name)
      if ((current?.version ?? 0) !== expectedVersion) fail('assistant-skills: version conflict')
      const saved = this.#newDefinition(definition, expectedVersion + 1, current?.version ?? null)
      this.#insertDefinition(key, saved)
      this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  list(scope: object): StoredSkillDefinition[] {
    const key = scopeKey(scope)
    return (this.#db.prepare(`SELECT definition_json FROM skill_definitions current WHERE scope_key=? AND retired=0
      AND version=(SELECT MAX(version) FROM skill_definitions versions WHERE versions.scope_key=current.scope_key AND versions.name=current.name) ORDER BY name`).all(key) as { definition_json: string }[])
      .map(row => clone(JSON.parse(row.definition_json) as StoredSkillDefinition))
  }
  get(scope: object, skillName: string, wantedVersion?: number): StoredSkillDefinition | undefined {
    const key = scopeKey(scope); if (!name(skillName) || wantedVersion !== undefined && !version(wantedVersion)) fail('assistant-skills: invalid skill reference')
    if (wantedVersion === undefined) {
      const current = this.#latest(key, skillName)
      return current === undefined || current.retired ? undefined : clone(current)
    }
    const row = this.#db.prepare('SELECT definition_json FROM skill_definitions WHERE scope_key=? AND name=? AND version=?').get(key, skillName, wantedVersion)
    return row === undefined ? undefined : clone(JSON.parse((row as { definition_json: string }).definition_json) as StoredSkillDefinition)
  }
  retire(scope: object, skillName: string, expectedVersion: number): StoredSkillDefinition {
    const key = scopeKey(scope); if (!name(skillName) || !version(expectedVersion)) fail('assistant-skills: invalid skill reference')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#latest(key, skillName)
      if (!current || current.version !== expectedVersion || current.retired) fail('assistant-skills: version conflict')
      const now = Date.now(); const retired = { ...current, retired: true, updatedAt: now }
      if (this.#db.prepare('UPDATE skill_definitions SET retired=1, definition_json=?, updated_at=? WHERE scope_key=? AND name=? AND version=? AND retired=0').run(JSON.stringify(retired), now, key, skillName, expectedVersion).changes !== 1) fail('assistant-skills: version conflict')
      this.#db.exec('COMMIT'); return clone(retired)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  stageCandidate(scope: object, definition: SkillDefinition, options: SkillCandidateOptions): SkillCandidate {
    const key = scopeKey(scope)
    if (!definitionValid(definition) || !candidateOptions(options) || !version(options.expectedVersion, true) || !text(options.reason, 1024) || !text(options.trigger, 1024)
      || !Number.isSafeInteger(options.expiresAt) || options.expiresAt <= Date.now() || options.expiresAt > Date.now() + 7 * 24 * 60 * 60 * 1000) fail('assistant-skills: invalid candidate')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#latest(key, definition.name)
      if (current?.retired || (current?.version ?? 0) !== options.expectedVersion || options.expectedVersion === 0 && current) fail('assistant-skills: version conflict')
      const parentDigest = current ? acceptanceDigest(current) : null
      const failureProvenance = options.failureProvenance === undefined ? undefined : this.#candidateFailureProvenance(scope, definition, options.expectedVersion, parentDigest, current, options.failureProvenance)
      // Keep the legacy identity formula byte-for-byte when provenance is absent.
      const identity = [scope, definition, options.expectedVersion, parentDigest, options.reason, options.trigger]
      const id = `skill-candidate-${acceptanceDigest(failureProvenance === undefined ? identity : [...identity, failureProvenance])}`
      const existing = this.#candidate(key, id)
      if (existing) {
        if (existing.state !== 'pending') fail('assistant-skills: candidate conflict')
        this.#db.exec('COMMIT'); return clone(existing)
      }
      const now = Date.now(); const candidate: SkillCandidate = { id, definition: clone(definition), parentVersion: options.expectedVersion, parentDigest, reason: options.reason, trigger: options.trigger,
        ...(failureProvenance === undefined ? {} : { failureProvenance }), expiresAt: options.expiresAt, state: 'pending', createdAt: now, updatedAt: now }
      this.#putCandidate(key, candidate); this.#db.exec('COMMIT'); return clone(candidate)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  getCandidate(scope: object, id: string): SkillCandidate | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid candidate reference')
    const candidate = this.#candidate(key, id)
    if (candidate !== undefined) this.#assertCandidateFailureProvenance(scope, candidate)
    return candidate === undefined ? undefined : clone(candidate)
  }
  listCandidates(scope: object): SkillCandidate[] {
    const key = scopeKey(scope)
    return (this.#db.prepare('SELECT candidate_json FROM skill_candidates WHERE scope_key=? ORDER BY id').all(key) as { candidate_json: string }[]).map(row => {
      const candidate = JSON.parse(row.candidate_json) as SkillCandidate
      this.#assertCandidateFailureProvenance(scope, candidate)
      return clone(candidate)
    })
  }
  createCapture(scope: object, input: SkillCaptureInput, routeReceipt: unknown, definitionDigest: string): SkillCapture {
    const key = scopeKey(scope)
    if (!input || !text(input.ownerRouteId, 256) || !text(input.goalId, 256) || !text(input.sessionId, 256) || !text(input.nativeGoalId, 256) || !name(input.name) || !text(input.description, 512)
      || !version(input.parentVersion, true) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 7 * 86400000 || !/^[a-f0-9]{64}$/u.test(definitionDigest)) fail('assistant-skills: invalid capture')
    this.#db.exec('BEGIN IMMEDIATE'); try {
      const current = this.#latest(key, input.name), parentDigest = current ? acceptanceDigest(current) : null
      if (current?.retired || (current?.version ?? 0) !== input.parentVersion || (input.parentVersion === 0 && current) || parentDigest !== (input.parentVersion ? parentDigest : null)) fail('assistant-skills: version conflict')
      const id = `skill-capture-${acceptanceDigest([scope, input, parentDigest, definitionDigest])}`, existing = this.#capture(key, id)
      if (existing) { this.#db.exec('COMMIT'); return clone(existing) }
      const now = Date.now(), capture: SkillCapture = { id, scope: clone(scope), routeReceipt: clone(routeReceipt), ownerRouteId: input.ownerRouteId, goalId: input.goalId, sessionId: input.sessionId, nativeGoalId: input.nativeGoalId, name: input.name, description: input.description, parentVersion: input.parentVersion, parentDigest, definitionDigest, expiresAt: input.expiresAt, state: 'pending', createdAt: now, updatedAt: now }
      this.#putCapture(key, capture); this.#db.exec('COMMIT'); return clone(capture)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  listCaptures(scope?: object): SkillCapture[] {
    const rows = scope === undefined ? this.#db.prepare("SELECT capture_json FROM skill_captures WHERE state='pending' ORDER BY id").all() : this.#db.prepare('SELECT capture_json FROM skill_captures WHERE scope_key=? ORDER BY id').all(scopeKey(scope))
    return (rows as { capture_json: string }[]).map(row => clone(JSON.parse(row.capture_json) as SkillCapture))
  }
  finishCapture(scope: object, id: string, state: Exclude<SkillCapture['state'], 'pending' | 'captured'>, detail?: string): SkillCapture {
    const key = scopeKey(scope); this.#db.exec('BEGIN IMMEDIATE'); try { const capture = this.#capture(key, id); if (!capture) fail('assistant-skills: capture missing'); if (capture.state === 'pending') this.#putCapture(key, { ...capture, state, ...(detail ? { detail } : {}), updatedAt: Date.now() }); this.#db.exec('COMMIT'); return clone(this.#capture(key, id)!) } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  captureCandidate(scope: object, id: string, definition: SkillDefinition): SkillCapture {
    const key = scopeKey(scope); if (!definitionValid(definition)) fail('assistant-skills: invalid capture definition')
    this.#db.exec('BEGIN IMMEDIATE'); try {
      const capture = this.#capture(key, id); if (!capture) fail('assistant-skills: capture missing'); if (capture.state === 'captured') { this.#db.exec('COMMIT'); return clone(capture) }
      if (capture.state !== 'pending' || capture.expiresAt <= Date.now()) fail('assistant-skills: capture unavailable')
      const current = this.#latest(key, capture.name)
      if (current?.retired || (current?.version ?? 0) !== capture.parentVersion || (current ? acceptanceDigest(current) : null) !== capture.parentDigest || definition.source.goal.id !== capture.goalId || definition.source.goal.sessionId !== capture.sessionId || definition.source.goal.nativeGoalId !== capture.nativeGoalId || definition.source.goal.definition.digest !== capture.definitionDigest) fail('assistant-skills: capture changed')
      const reason = 'Owner-preauthorized automatic capture.', trigger = `owner-route:${capture.ownerRouteId}`
      const candidateId = `skill-candidate-${acceptanceDigest([scope, definition, capture.parentVersion, capture.parentDigest, reason, trigger])}`
      const candidate = this.#candidate(key, candidateId) ?? { id: candidateId, definition: clone(definition), parentVersion: capture.parentVersion, parentDigest: capture.parentDigest, reason, trigger, expiresAt: capture.expiresAt, state: 'pending' as const, createdAt: Date.now(), updatedAt: Date.now() }
      if (candidate.state !== 'pending') fail('assistant-skills: candidate conflict')
      this.#putCandidate(key, candidate)
      const saved = { ...capture, state: 'captured' as const, candidateId: candidate.id, updatedAt: Date.now() }; this.#putCapture(key, saved); this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  rejectCandidate(scope: object, id: string): SkillCandidate {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid candidate reference')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const candidate = this.#candidate(key, id); if (!candidate) fail('assistant-skills: candidate missing')
      this.#assertCandidateFailureProvenance(scope, candidate)
      if (candidate.state === 'activated') fail('assistant-skills: candidate conflict')
      if (candidate.state === 'pending') { candidate.state = 'rejected'; candidate.updatedAt = Date.now(); this.#putCandidate(key, candidate) }
      this.#db.exec('COMMIT'); return clone(candidate)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  activateCandidate(scope: object, id: string, trialRunId: string, receipt: string, watch?: { input: SkillWatchInput; routeReceipt: unknown }): StoredSkillDefinition {
    const key = scopeKey(scope)
    const watchDigest = watch === undefined ? undefined : acceptanceDigest(clone(watch))
    if (!text(id, 128) || !text(trialRunId, 128) || !text(receipt, 1024)) fail('assistant-skills: invalid candidate activation')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const candidate = this.#candidate(key, id); if (!candidate) fail('assistant-skills: candidate missing')
      this.#assertCandidateFailureProvenance(scope, candidate)
      if (candidate.state === 'activated') {
        if (candidate.trialRunId !== trialRunId || candidate.acceptanceDigest !== receipt || !candidate.activatedVersion
          || candidate.activationWatchDigest !== watchDigest) fail('assistant-skills: candidate conflict')
        const activated = this.get(scope, candidate.definition.name, candidate.activatedVersion)
        if (!activated) fail('assistant-skills: candidate conflict')
        this.#db.exec('COMMIT'); return activated
      }
      if (candidate.state !== 'pending' || candidate.expiresAt <= Date.now()) fail('assistant-skills: candidate unavailable')
      const current = this.#latest(key, candidate.definition.name)
      if (current?.retired || (current?.version ?? 0) !== candidate.parentVersion || (current ? acceptanceDigest(current) : null) !== candidate.parentDigest) fail('assistant-skills: version conflict')
      const run = this.#run(key, trialRunId)
      if (!run || run.state !== 'succeeded' || run.candidateId !== id || !run.goalExecutionRunId) fail('assistant-skills: trial acceptance required')
      const activated = this.#newDefinition(candidate.definition, candidate.parentVersion + 1, candidate.parentVersion || null)
      this.#insertDefinition(key, activated)
      if (watch && (watch.input.skillName !== activated.name || watch.input.version !== activated.version || watch.input.fallbackVersion !== candidate.parentVersion)) fail('assistant-skills: activation watch conflict')
      // The definition, candidate and exact-version watch share this writer
      // transaction. A failed watch cannot leave an unobserved active version.
      const createdWatch = watch && this.#createWatch(scope, watch.input, watch.routeReceipt, 'sole-skill-run/v1')
      const saved: SkillCandidate = { ...candidate, state: 'activated', activatedVersion: activated.version, trialRunId, acceptanceDigest: receipt, updatedAt: Date.now(),
        ...(createdWatch ? { activationWatchDigest: watchDigest!, activationWatchId: createdWatch.id } : {}) }
      this.#putCandidate(key, saved); this.#db.exec('COMMIT'); return clone(activated)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  activateQualifiedCandidate(scope: object, candidateId: string, comparisonId: string, qualificationDigest: string, admission: SkillDeploymentAdmission, input: SkillDeploymentInput, routeReceipt: unknown): { definition: StoredSkillDefinition; deployment: SkillDeployment } {
    const key = scopeKey(scope)
    if (!text(candidateId, 128) || !text(comparisonId, 128) || !/^[a-f0-9]{64}$/u.test(qualificationDigest) || !deploymentAdmission(admission) || !input || !text(input.ownerRouteId, 128)
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 7 * 86400000
      || !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 100 || !Number.isSafeInteger(input.canaryRuns) || input.canaryRuns < 1 || input.canaryRuns > input.maxRuns
      || !routeReceipt || !json(routeReceipt)) fail('assistant-skills: invalid qualified activation')
    const admissionDigest = acceptanceDigest(admission), id = deploymentId(scope, candidateId, comparisonId, qualificationDigest, admission, input, routeReceipt)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#deployment(key, id)
      if (existing) {
        const definition = this.get(scope, existing.skillName, existing.version)
        if (!definition) fail('assistant-skills: deployment conflict')
        this.#db.exec('COMMIT'); return { definition, deployment: clone(existing) }
      }
      const candidate = this.#candidate(key, candidateId)
      const comparison = this.#comparison(key, comparisonId)
      if (candidate) this.#assertCandidateFailureProvenance(scope, candidate)
      if (!candidate || candidate.state !== 'pending' || candidate.expiresAt <= Date.now() || candidate.parentVersion <= 0 || !comparison || comparison.state !== 'complete'
        || comparison.candidateId !== candidateId || !json(comparison.result) || acceptanceDigest(comparison.result) !== qualificationDigest
        || !recordWithDigest(comparison.result, 'admissionDigest', admissionDigest)
        || candidate.definition.name !== admission.skillName || acceptanceDigest(candidate.definition) !== admission.candidateDefinitionDigest
        || candidate.definition.source.goal.definition.digest !== admission.taskFamily.goalDefinitionDigest) fail('assistant-skills: qualification unavailable')
      const current = this.#latest(key, candidate.definition.name)
      if (!current || current.retired || current.version !== candidate.parentVersion || acceptanceDigest(current) !== candidate.parentDigest
        || admission.parentDefinitionDigest !== candidate.parentDigest) fail('assistant-skills: version conflict')
      const definition = this.#newDefinition(candidate.definition, candidate.parentVersion + 1, candidate.parentVersion)
      this.#insertDefinition(key, definition)
      const watch = this.#createWatch(scope, { ownerRouteId: input.ownerRouteId, skillName: definition.name, version: definition.version, fallbackVersion: candidate.parentVersion, expiresAt: input.expiresAt, maxRuns: input.maxRuns, failureThreshold: 1 }, routeReceipt, 'canonical-goal-outcome/v2', admission.taskFamily)
      const now = Date.now()
      const deployment: SkillDeployment = { id, scope: clone(scope), candidateId, comparisonId, qualificationDigest, admissionDigest, candidateDefinitionDigest: admission.candidateDefinitionDigest, taskFamily: clone(admission.taskFamily), routeReceipt: clone(routeReceipt), ownerRouteId: input.ownerRouteId, skillName: definition.name, version: definition.version,
        definitionDigest: acceptanceDigest(definition), parentVersion: candidate.parentVersion, watchId: watch.id, expiresAt: input.expiresAt, maxRuns: input.maxRuns, canaryRuns: input.canaryRuns, runIds: [], state: 'canary', createdAt: now, updatedAt: now }
      this.#putDeployment(key, deployment)
      this.#putCandidate(key, { ...candidate, state: 'activated', activatedVersion: definition.version, activationComparisonId: comparisonId, deploymentId: id, updatedAt: now })
      this.#db.exec('COMMIT'); return { definition: clone(definition), deployment: clone(deployment) }
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  getDeployment(scope: object, id: string): SkillDeployment | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid deployment reference')
    const deployment = this.#deployment(key, id); return deployment === undefined ? undefined : clone(deployment)
  }
  deploymentForVersion(scope: object, skillName: string, wantedVersion: number): SkillDeployment | undefined {
    const key = scopeKey(scope); if (!name(skillName) || !version(wantedVersion)) fail('assistant-skills: invalid deployment reference')
    const rows = this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=?').all(key) as { deployment_json: string }[]
    const deployment = rows.map(row => JSON.parse(row.deployment_json) as SkillDeployment).find(value => value.skillName === skillName && value.version === wantedVersion)
    return deployment === undefined ? undefined : clone(deployment)
  }
  listDeployments(scope?: object): SkillDeployment[] {
    const rows = scope === undefined ? this.#db.prepare('SELECT deployment_json FROM skill_deployments ORDER BY id').all() : this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=? ORDER BY id').all(scopeKey(scope))
    return (rows as { deployment_json: string }[]).map(row => clone(JSON.parse(row.deployment_json) as SkillDeployment))
  }
  reconcileDeployment(scope: object, id: string): SkillDeployment | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid deployment reference')
    this.#db.exec('BEGIN IMMEDIATE'); try { const deployment = this.#deployment(key, id); const saved = deployment && this.#reconcileDeployment(key, deployment, false); this.#db.exec('COMMIT'); return saved && clone(saved) } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  /** Promotion-capable reconciliation; call only while holding Evaluation's exact canonical writer fence. */
  reconcileDeploymentWithCanonicalPromotion(scope: object, id: string): SkillDeployment | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid deployment reference')
    this.#db.exec('BEGIN IMMEDIATE'); try { const deployment = this.#deployment(key, id); const saved = deployment && this.#reconcileDeployment(key, deployment, true); this.#db.exec('COMMIT'); return saved && clone(saved) } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  stopDeployment(scope: object, id: string, state: Extract<SkillDeployment['state'], 'blocked' | 'revoked'>): SkillDeployment | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid deployment reference')
    this.#db.exec('BEGIN IMMEDIATE'); try { const deployment = this.#deployment(key, id); if (!deployment || deployment.state !== 'canary' && deployment.state !== 'promoted') { this.#db.exec('COMMIT'); return deployment && clone(deployment) }; const saved = { ...deployment, state, updatedAt: Date.now() }; this.#putDeployment(key, saved); this.#db.exec('COMMIT'); return clone(saved) } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  assertDeploymentRun(scope: object, id: string): SkillDeployment {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid deployment run')
    const deployment = this.#deploymentsForRun(key, id)[0]
    if (!deployment || deployment.state !== 'canary' && deployment.state !== 'promoted' || deployment.expiresAt <= Date.now()) fail('assistant-skills: deployment unavailable')
    const watch = this.#watch(key, deployment.watchId)
    if (!watch || !exactCanonicalObservationState(watch, deployment)) fail('assistant-skills: deployment unavailable')
    const active = this.#latest(key, deployment.skillName)
    if (!active || active.retired || active.version !== deployment.version || acceptanceDigest(active) !== deployment.definitionDigest) fail('assistant-skills: deployment unavailable')
    return clone(deployment)
  }
  rollback(scope: object, skillName: string, expectedVersion: number, targetVersion: number): StoredSkillDefinition {
    const key = scopeKey(scope); if (!name(skillName) || !version(expectedVersion) || !version(targetVersion)) fail('assistant-skills: invalid skill reference')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#latest(key, skillName)
      const failureCandidate = this.#activatedFailureCandidate(key, skillName, expectedVersion)
      const target = this.get(scope, skillName, targetVersion)
      if (failureCandidate) {
        const provenance = this.#assertCandidateFailureProvenance(scope, failureCandidate)
        if (!provenance || !target || target.retired || provenance.rollbackTarget.name !== skillName || provenance.rollbackTarget.version !== targetVersion
          || provenance.rollbackTarget.digest !== acceptanceDigest(target)) fail('assistant-skills: failure rollback target changed')
      }
      if (current && !current.retired && current.version === expectedVersion + 1 && current.parentVersion === expectedVersion && current.restoredFromVersion === targetVersion) {
        this.#db.exec('COMMIT'); return clone(current)
      }
      if (!current || current.retired || current.version !== expectedVersion || current.parentVersion !== targetVersion) fail('assistant-skills: version conflict')
      if (!target || target.retired) fail('assistant-skills: version conflict')
      const restored = this.#newDefinition(target, expectedVersion + 1, expectedVersion, targetVersion)
      this.#insertDefinition(key, restored); this.#db.exec('COMMIT'); return clone(restored)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  createWatch(scope: object, input: SkillWatchInput, routeReceipt: unknown): SkillWatch {
    this.#db.exec('BEGIN IMMEDIATE')
    try { const watch = this.#createWatch(scope, input, routeReceipt, 'sole-skill-run/v1'); this.#db.exec('COMMIT'); return watch }
    catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  #createWatch(scope: object, input: SkillWatchInput, routeReceipt: unknown, proofVersion: SkillWatchProofVersion, taskFamily?: SkillWatchTaskFamily): SkillWatch {
    const key = scopeKey(scope)
    if (!input || !routeReceipt || !json(routeReceipt) || !text(input.ownerRouteId, 128) || !name(input.skillName) || !version(input.version) || !version(input.fallbackVersion)
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 7 * 24 * 60 * 60 * 1000
      || !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 100 || !Number.isSafeInteger(input.failureThreshold) || input.failureThreshold < 1 || input.failureThreshold > input.maxRuns) fail('assistant-skills: invalid watch')
    const active = this.#latest(key, input.skillName), fallback = this.get(scope, input.skillName, input.fallbackVersion)
    if (!active || active.retired || active.version !== input.version || active.parentVersion !== input.fallbackVersion || !fallback || fallback.retired) fail('assistant-skills: watch version conflict')
    const id = watchId(scope, input), existing = this.#watch(key, id)
    if (taskFamily !== undefined && (!deploymentAdmission({ protocol: 'assistant-skills/canary-admission/v1', skillName: input.skillName, parentDefinitionDigest: acceptanceDigest(fallback), candidateDefinitionDigest: acceptanceDigest(active), taskFamily }))) fail('assistant-skills: invalid watch task family')
    if (existing) { if (existing.proofVersion !== proofVersion || acceptanceDigest(existing.taskFamily ?? null) !== acceptanceDigest(taskFamily ?? null)) fail('assistant-skills: watch proof conflict'); return clone(existing) }
    const now = Date.now(); const afterRunRowId = (this.#db.prepare('SELECT coalesce(max(rowid),0) AS rowId FROM skill_runs').get() as { rowId: number }).rowId
    const watch: SkillWatch = { id, scope: clone(scope), routeReceipt: clone(routeReceipt), afterRunRowId, ownerRouteId: input.ownerRouteId, skillName: input.skillName, version: input.version, definitionDigest: acceptanceDigest(active), fallbackVersion: input.fallbackVersion, fallbackDigest: acceptanceDigest(fallback), expiresAt: input.expiresAt, maxRuns: input.maxRuns, failureThreshold: input.failureThreshold, state: 'watching', runIds: [], observations: [], createdAt: now, updatedAt: now, proofVersion, ...(proofVersion === 'canonical-goal-outcome/v2' ? { canonicalRevisions: [] } : {}), ...(taskFamily === undefined ? {} : { taskFamily: clone(taskFamily) }) }
    this.#putWatch(key, watch); return clone(watch)
  }
  listWatches(scope?: object): SkillWatch[] {
    const rows = scope === undefined ? this.#db.prepare('SELECT watch_json FROM skill_watches WHERE state=\'watching\' ORDER BY id').all() : this.#db.prepare('SELECT watch_json FROM skill_watches WHERE scope_key=? ORDER BY id').all(scopeKey(scope))
    return (rows as { watch_json: string }[]).map(row => clone(JSON.parse(row.watch_json) as SkillWatch))
  }
  #attachWatchRun(scope: object, run: SkillRun): void {
    const key = scopeKey(scope); if (run.state !== 'succeeded' || !run.goalExecutionRunId || run.candidateId !== undefined) return
    for (const watch of this.#watches(key, 'watching')) {
      if (watch.expiresAt <= Date.now()) { this.#putWatch(key, { ...watch, state: 'expired', updatedAt: Date.now() }); continue }
      const rowId = (this.#db.prepare('SELECT rowid AS rowId FROM skill_runs WHERE id=?').get(run.id) as { rowId: number } | undefined)?.rowId
      if (!Number.isSafeInteger(watch.afterRunRowId) || rowId === undefined || rowId <= watch.afterRunRowId || run.createdAt < watch.createdAt || watch.skillName !== run.skillName || watch.version !== run.version || watch.definitionDigest !== acceptanceDigest(this.get(scope, run.skillName, run.version))) continue
      if (watch.runIds.includes(run.id)) continue
      if (watch.runIds.length >= watch.maxRuns) continue
      this.#putWatch(key, { ...watch, runIds: [...watch.runIds, run.id], updatedAt: Date.now() })
    }
  }
  observeWatch(scope: object, id: string, observation: SkillWatchObservation): SkillWatch | undefined {
    const key = scopeKey(scope); if (!text(id, 128) || !text(observation.runId, 128) || !/^[a-f0-9]{64}$/u.test(observation.receiptDigest) || !['achieved', 'not-achieved'].includes(observation.objectiveStatus) || !Number.isSafeInteger(observation.verifiedAt) || !Number.isSafeInteger(observation.validUntil)
      || !/^[a-f0-9]{64}$/u.test(observation.executionTraceDigest) || observation.taskFamilyDigest !== undefined && !/^[a-f0-9]{64}$/u.test(observation.taskFamilyDigest)) fail('assistant-skills: invalid watch observation')
    this.#db.exec('BEGIN IMMEDIATE'); try { const watch = this.#watch(key, id); if (!watch || watch.state !== 'watching') { this.#db.exec('COMMIT'); return watch && clone(watch) }
      const deployment = this.#deploymentForWatch(key, watch.id)
      if (deployment !== undefined && (watch.taskFamily === undefined || observation.taskFamilyDigest !== acceptanceDigest(watch.taskFamily)) || !watch.runIds.includes(observation.runId)
        || watch.observations.some(value => value.receiptDigest === observation.receiptDigest || value.runId === observation.runId
          || observation.executionTraceDigest !== undefined && value.executionTraceDigest === observation.executionTraceDigest)
        || observation.verifiedAt < watch.createdAt || observation.verifiedAt > Date.now() || observation.validUntil <= Date.now()) { this.#db.exec('COMMIT'); return clone(watch) }
      const saved = { ...watch, observations: [...watch.observations, clone(observation)], updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  replaceWatchObservation(scope: object, id: string, result: SkillWatchObservationResult): SkillWatch | undefined {
    return this.#replaceWatchObservation(scope, id, result, false)
  }
  /** Commit the canonical replacement, deployment transition and any required exact-version rollback in one writer transaction. */
  replaceWatchObservationAndRollback(scope: object, id: string, result: SkillWatchObservationResult): SkillWatch | undefined {
    return this.#replaceWatchObservation(scope, id, result, true)
  }
  /** Commit a positive canonical replacement and promotion-only reconciliation under one Evaluation writer fence. */
  replaceWatchObservationAndPromote(scope: object, id: string, deploymentId: string, result: SkillWatchObservationResult): { watch: SkillWatch; deployment: SkillDeployment } {
    const key = scopeKey(scope)
    if (!text(id, 128) || !text(deploymentId, 128) || !result || typeof result !== 'object' || Array.isArray(result)
      || result.kind !== 'current' || result.observation.objectiveStatus !== 'achieved') {
      fail('assistant-skills: invalid canonical promotion')
    }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const deployment = this.#deployment(key, deploymentId)
      if (!deployment || deployment.watchId !== id || !validRunIds(deployment.runIds)) fail('assistant-skills: canonical promotion conflict')
      const watch = this.#replaceWatchObservationInTransaction(scope, key, id, result, false)
      if (!watch || watch.state !== 'watching') fail('assistant-skills: canonical promotion unavailable')
      const reconciled = this.#reconcileDeployment(key, deployment, true)
      this.#db.exec('COMMIT')
      return { watch: clone(watch), deployment: clone(reconciled) }
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  #replaceWatchObservation(scope: object, id: string, result: SkillWatchObservationResult, rollbackOnFailure: boolean): SkillWatch | undefined {
    const key = scopeKey(scope)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const saved = this.#replaceWatchObservationInTransaction(scope, key, id, result, rollbackOnFailure)
      this.#db.exec('COMMIT')
      return saved === undefined ? undefined : clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  #replaceWatchObservationInTransaction(scope: object, key: string, id: string, result: SkillWatchObservationResult, rollbackOnFailure: boolean): SkillWatch | undefined {
    if (!text(id, 128) || !result || typeof result !== 'object' || Array.isArray(result) || !json(result)
      || !['current', 'invalidated'].includes(result.kind)) fail('assistant-skills: invalid watch observation revision')
    const run = result.kind === 'current' ? result.observation.runId : result.runId
    const canonical = result.kind === 'current' ? result.observation.canonical : result.canonical
    if (!text(run, 128) || !canonicalRevision(canonical)
      || result.kind === 'current' && (canonical.disposition !== 'upsert' || !digest(result.observation.receiptDigest)
        || !['achieved', 'not-achieved'].includes(result.observation.objectiveStatus) || !Number.isSafeInteger(result.observation.verifiedAt)
        || !Number.isSafeInteger(result.observation.validUntil) || !digest(result.observation.executionTraceDigest)
        || result.observation.taskFamilyDigest !== undefined && !digest(result.observation.taskFamilyDigest))
      || result.kind === 'invalidated' && canonical.disposition !== 'retract') fail('assistant-skills: invalid watch observation revision')
    const watch = this.#watch(key, id)
    if (!watch || watch.state !== 'watching') return watch
    // v1 qualified observations predate revisioned Evaluation evidence.  Never
    // mutate them into a v2 shape opportunistically; constructor quarantine is
    // irreversible and a fresh qualified deployment is required.
    if (watch.proofVersion !== 'canonical-goal-outcome/v2') return watch
    const deployment = this.#deploymentForWatch(key, watch.id)
    const taskFamilyDigest = watch.taskFamily === undefined ? undefined : acceptanceDigest(watch.taskFamily)
    if (!deployment || taskFamilyDigest === undefined || acceptanceDigest(deployment.taskFamily) !== taskFamilyDigest
      || !watch.runIds.includes(run) || result.kind === 'current' && result.observation.taskFamilyDigest !== taskFamilyDigest) {
      return watch
    }
    const finish = (candidate: SkillWatch): SkillWatch => {
      let final = candidate
      if (rollbackOnFailure) {
        const reconciled = this.#reconcileDeployment(key, deployment, false)
        final = this.#rollbackWatch(scope, key, candidate)
        if (final.state === 'rolled-back') this.#reconcileDeployment(key, reconciled, false)
      }
      return final
    }
    const revisions = watch.canonicalRevisions ?? []
    const previous = revisions.find(value => value.runId === run)
    // Old direct callers did not carry an explicit binding. Permit deriving
    // it once; after that the persisted first proof is authoritative.
    const suppliedBinding = result.binding ?? (previous === undefined && result.kind === 'current'
      ? observationBinding(result.observation, canonical.subjectRef) : undefined)
    const binding = previous?.binding ?? suppliedBinding
    if (!validObservationBinding(binding) || binding.runId !== run || binding.subjectRef !== canonical.subjectRef
      || binding.taskFamilyDigest !== taskFamilyDigest) fail('assistant-skills: invalid watch observation binding')
    if (suppliedBinding !== undefined && acceptanceDigest(suppliedBinding) !== acceptanceDigest(binding)) fail('assistant-skills: canonical binding conflict')
    if (result.kind === 'current' && result.binding !== undefined && (result.observation.runId !== binding.runId || result.observation.receiptDigest !== binding.receiptDigest
      || result.observation.verifiedAt !== binding.verifiedAt || result.observation.validUntil !== binding.validUntil
      || result.observation.executionTraceDigest !== binding.executionTraceDigest || result.observation.taskFamilyDigest !== binding.taskFamilyDigest)) {
      fail('assistant-skills: canonical binding conflict')
    }
    if (previous !== undefined) {
      if (canonical.subjectRef !== previous.subjectRef) fail('assistant-skills: canonical revision conflict')
      if (canonical.version < previous.version) return finish(watch)
      if (canonical.version === previous.version) {
        if (canonical.digest !== previous.digest || canonical.disposition !== previous.disposition) fail('assistant-skills: canonical revision conflict')
        const priorObservation = watch.observations.find(value => value.runId === run)
        const { subjectRef: _subjectRef, ...observationBinding } = binding
        const expectedObservation = result.kind === 'current'
          ? { ...observationBinding, objectiveStatus: result.observation.objectiveStatus, canonical: {
            subjectKind: previous.subjectKind, subjectRef: previous.subjectRef, version: previous.version, digest: previous.digest,
            disposition: previous.disposition, scopeWatermark: previous.scopeWatermark,
          } } : undefined
        if (result.kind === 'current' && (priorObservation === undefined || acceptanceDigest(priorObservation) !== acceptanceDigest(expectedObservation))
          || result.kind === 'invalidated' && priorObservation !== undefined) fail('assistant-skills: canonical revision conflict')
        return finish(watch)
      }
      if (canonical.scopeWatermark <= previous.scopeWatermark) fail('assistant-skills: canonical revision conflict')
    }
    if (previous === undefined && (binding.verifiedAt < watch.createdAt || binding.verifiedAt > Date.now()
      || binding.validUntil <= Date.now())
      || result.kind === 'current' && (
        watch.observations.some(value => value.runId !== run && (value.receiptDigest === result.observation.receiptDigest
        || value.executionTraceDigest === result.observation.executionTraceDigest)))) {
      return watch
    }
    const state: SkillWatchCanonicalState = { runId: run, ...clone(canonical), binding: clone(binding) }
    const observations = watch.observations.filter(value => value.runId !== run)
    const { subjectRef: _subjectRef, ...observationFields } = binding
    const currentObservation = result.kind === 'current' ? { ...observationFields, objectiveStatus: result.observation.objectiveStatus, canonical: clone(canonical) } : undefined
    const saved: SkillWatch = { ...watch, canonicalRevisions: [...revisions.filter(value => value.runId !== run), state],
      observations: currentObservation === undefined ? observations : [...observations, currentObservation], updatedAt: Date.now() }
    this.#putWatch(key, saved)
    return finish(saved)
  }
  stopWatch(scope: object, id: string, state: Extract<SkillWatch['state'], 'expired' | 'revoked' | 'superseded' | 'exhausted'>): SkillWatch | undefined {
    const key = scopeKey(scope); this.#db.exec('BEGIN IMMEDIATE'); try { const watch = this.#watch(key, id); if (!watch || watch.state !== 'watching') { this.#db.exec('COMMIT'); return watch && clone(watch) }; const saved = { ...watch, state, updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved) } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  rollbackWatch(scope: object, id: string): SkillWatch | undefined {
    const key = scopeKey(scope); this.#db.exec('BEGIN IMMEDIATE'); try { const watch = this.#watch(key, id); if (!watch || watch.state !== 'watching') { this.#db.exec('COMMIT'); return watch && clone(watch) }
      const saved = this.#rollbackWatch(scope, key, watch); this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  #rollbackWatch(scope: object, key: string, watch: SkillWatch): SkillWatch {
      if (watch.expiresAt <= Date.now()) { const saved = { ...watch, state: 'expired' as const, updatedAt: Date.now() }; this.#putWatch(key, saved); return saved }
      const deployment = this.#deploymentForWatch(key, watch.id)
      // Public standalone watches have no operator-pinned task family. They
      // retain useful outcome observations, but can never supply mutation
      // authority. Only the exact watch created by a qualified canary
      // deployment may append a rollback version.
      if (!deployment || !watch.taskFamily || !['canary', 'promoted', 'blocked'].includes(deployment.state)
        || deployment.watchId !== watch.id || deployment.skillName !== watch.skillName || deployment.version !== watch.version
        || deployment.definitionDigest !== watch.definitionDigest || acceptanceDigest(deployment.taskFamily) !== acceptanceDigest(watch.taskFamily)) {
        return watch
      }
      const taskFamilyDigest = acceptanceDigest(watch.taskFamily)
      const currentCanonical = (value: SkillWatchObservation) => value.canonical !== undefined
        && watch.canonicalRevisions?.some(revision => revision.runId === value.runId && revision.disposition === 'upsert'
          && revision.subjectRef === value.canonical!.subjectRef && revision.version === value.canonical!.version
          && revision.digest === value.canonical!.digest && revision.scopeWatermark === value.canonical!.scopeWatermark)
      const failures = watch.observations.filter(value => value.objectiveStatus === 'not-achieved' && value.taskFamilyDigest === taskFamilyDigest && currentCanonical(value)).length
        + (watch.canonicalRevisions?.filter(value => value.disposition === 'retract' && watch.runIds.includes(value.runId)).length ?? 0)
      if (failures < watch.failureThreshold) return watch
      const current = this.#latest(key, watch.skillName), target = this.get(scope, watch.skillName, watch.fallbackVersion)
      const failureCandidate = this.#activatedFailureCandidate(key, watch.skillName, watch.version)
      if (failureCandidate) {
        const provenance = this.#assertCandidateFailureProvenance(scope, failureCandidate)
        if (!provenance || !target || provenance.rollbackTarget.name !== watch.skillName || provenance.rollbackTarget.version !== watch.fallbackVersion
          || provenance.rollbackTarget.digest !== acceptanceDigest(target)) {
          const saved = { ...watch, state: 'superseded' as const, updatedAt: Date.now() }; this.#putWatch(key, saved); return saved
        }
      }
      if (!current || current.retired || current.version !== watch.version || acceptanceDigest(current) !== watch.definitionDigest || current.parentVersion !== watch.fallbackVersion || !target || target.retired || acceptanceDigest(target) !== watch.fallbackDigest) { const saved = { ...watch, state: 'superseded' as const, updatedAt: Date.now() }; this.#putWatch(key, saved); return saved }
      const restored = this.#newDefinition(target, current.version + 1, current.version, watch.fallbackVersion)
      this.#insertDefinition(key, restored); const saved = { ...watch, state: 'rolled-back' as const, rollbackVersion: restored.version, updatedAt: Date.now() }; this.#putWatch(key, saved); return saved
  }
  claim(scope: object, input: SkillRunClaim): { claimed: boolean; run: SkillRun } {
    const key = scopeKey(scope); this.#validateClaim(scope, input)
    const id = runId(scope, input.sessionId, input.invocationId)
    const identity = clone({ invocationId: input.invocationId, goalId: input.goalId, sessionId: input.sessionId, skillName: input.skillName, version: input.version, inputs: input.inputs, ...(input.goalExecutionRunId === undefined ? {} : { goalExecutionRunId: input.goalExecutionRunId }),
      ...(input.goalDefinitionDigest === undefined ? {} : { goalDefinitionDigest: input.goalDefinitionDigest }), ...(input.nativeGoalId === undefined ? {} : { nativeGoalId: input.nativeGoalId }), ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }) })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (input.candidateId !== undefined) this.#validateTrialClaim(key, input)
      const existing = this.#db.prepare('SELECT identity_json,run_json FROM skill_runs WHERE id=? AND scope_key=?').get(id, key) as { identity_json: string; run_json: string } | undefined
      if (existing) {
        if (acceptanceDigest(identity) !== acceptanceDigest(JSON.parse(existing.identity_json))) fail('assistant-skills: invocation conflict')
        this.#db.exec('COMMIT'); return { claimed: false, run: clone(JSON.parse(existing.run_json) as SkillRun) }
      }
      if (input.candidateId === undefined) {
        const active = this.#latest(key, input.skillName)
        if (!active || active.retired || active.version !== input.version) fail('assistant-skills: inactive skill version')
        const deployment = this.#deploymentForVersion(key, input.skillName, input.version)
        if (deployment) {
          const reconciled = this.#reconcileDeployment(key, deployment, false)
          if (reconciled.state !== 'canary' && reconciled.state !== 'promoted' || reconciled.expiresAt <= Date.now()) fail('assistant-skills: deployment unavailable')
          if (acceptanceDigest(active) !== reconciled.definitionDigest || reconciled.runIds.length >= reconciled.maxRuns || reconciled.state === 'canary' && reconciled.runIds.length >= reconciled.canaryRuns) fail('assistant-skills: deployment quota exhausted')
          this.#putDeployment(key, { ...reconciled, runIds: [...reconciled.runIds, id], updatedAt: Date.now() })
        }
      }
      const unresolved = this.#db.prepare("SELECT run_json FROM skill_runs WHERE scope_key=? AND json_extract(identity_json,'$.sessionId')=? AND json_extract(identity_json,'$.goalId')=? AND json_extract(identity_json,'$.skillName')=? AND json_extract(identity_json,'$.version')=? AND coalesce(json_extract(identity_json,'$.candidateId'),'')=coalesce(?, '') AND state IN ('running','unknown') LIMIT 1")
        .get(key, input.sessionId, input.goalId, input.skillName, input.version, input.candidateId ?? null) as { run_json: string } | undefined
      if (unresolved) fail('assistant-skills: unresolved invocation for this Goal; inspect skill_status, do not replay')
      const now = Date.now(); const run: SkillRun = { id, ...identity, state: 'running', steps: [], createdAt: now, updatedAt: now }
      this.#db.prepare('INSERT INTO skill_runs VALUES(?,?,?,?,?)').run(id, key, JSON.stringify(identity), JSON.stringify(run), run.state)
      this.#db.exec('COMMIT'); return { claimed: true, run: clone(run) }
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  finish(scope: object, id: string, state: Exclude<SkillRunState, 'running'>, steps: readonly SkillRunStep[]): SkillRun {
    const key = scopeKey(scope)
    if (!text(id, 128) || !['succeeded', 'failed', 'unknown'].includes(state)) fail('assistant-skills: invalid run completion')
    this.#validateSteps(steps)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getRun(scope, id)
      if (!current || current.state !== 'running') fail('assistant-skills: run state conflict')
      const completed: SkillRun = { ...current, state, steps: clone(steps), updatedAt: Date.now() }
      if (this.#db.prepare("UPDATE skill_runs SET state=?,run_json=? WHERE id=? AND scope_key=? AND state='running'").run(state, JSON.stringify(completed), id, key).changes !== 1) fail('assistant-skills: run state conflict')
      this.#attachWatchRun(scope, completed)
      if (state === 'failed' || state === 'unknown') {
        for (const deployment of this.#deploymentsForRun(key, id)) {
          if (deployment.state === 'canary' || deployment.state === 'promoted') this.#putDeployment(key, { ...deployment, state: 'blocked', updatedAt: Date.now() })
        }
      }
      this.#db.exec('COMMIT'); return clone(completed)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }

  checkpoint(scope: object, id: string, steps: readonly SkillRunStep[]): SkillRun {
    const key = scopeKey(scope); this.#validateSteps(steps)
    const current = this.getRun(scope, id)
    if (!current || current.state !== 'running') fail('assistant-skills: run state conflict')
    const updated: SkillRun = { ...current, steps: clone(steps), updatedAt: Date.now() }
    if (this.#db.prepare("UPDATE skill_runs SET run_json=? WHERE id=? AND scope_key=? AND state='running'").run(JSON.stringify(updated), id, key).changes !== 1) fail('assistant-skills: run state conflict')
    return clone(updated)
  }
  getRun(scope: object, id: string): SkillRun | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid run reference')
    const row = this.#db.prepare('SELECT run_json FROM skill_runs WHERE id=? AND scope_key=?').get(id, key) as { run_json: string } | undefined
    return row === undefined ? undefined : clone(JSON.parse(row.run_json) as SkillRun)
  }
  claimComparison(scope: object, identity: SkillComparisonIdentity, maxComparisons: number): { claimed: boolean; comparison: SkillComparison } {
    const key = scopeKey(scope)
    if (!identity || !text(identity.sessionId) || !text(identity.candidateId, 128) || !/^[a-f0-9]{64}$/u.test(identity.parentDigest) || !text(identity.profileId) || !/^[a-f0-9]{64}$/u.test(identity.profileDigest) || !text(identity.invocationId) || !Number.isSafeInteger(maxComparisons) || maxComparisons < 1 || maxComparisons > 100) fail('assistant-skills: invalid comparison')
    const id = comparisonId(scope, identity.sessionId, identity.invocationId); this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#db.prepare('SELECT identity_json,comparison_json FROM skill_comparisons WHERE scope_key=? AND id=?').get(key, id) as { identity_json: string; comparison_json: string } | undefined
      if (existing) { if (acceptanceDigest(JSON.parse(existing.identity_json)) !== acceptanceDigest(identity)) fail('assistant-skills: comparison conflict'); this.#db.exec('COMMIT'); return { claimed: false, comparison: clone(JSON.parse(existing.comparison_json) as SkillComparison) } }
      const candidate = this.#candidate(key, identity.candidateId); const current = candidate && this.#latest(key, candidate.definition.name)
      if (!candidate || candidate.state !== 'pending' || candidate.expiresAt <= Date.now() || candidate.parentVersion <= 0 || candidate.parentDigest !== identity.parentDigest || !current || current.retired || current.version !== candidate.parentVersion || acceptanceDigest(current) !== candidate.parentDigest) fail('assistant-skills: candidate unavailable')
      const used = (this.#db.prepare('SELECT count(*) AS count FROM skill_comparisons WHERE scope_key=? AND profile_id=?').get(key, identity.profileId) as { count: number }).count
      if (used >= maxComparisons) fail('assistant-skills: comparison budget exhausted')
      const now = Date.now(); const comparison: SkillComparison = { id, ...clone(identity), state: 'running', result: null, createdAt: now, updatedAt: now }
      this.#db.prepare('INSERT INTO skill_comparisons VALUES(?,?,?,?,?,?)').run(key,id,identity.profileId,JSON.stringify(identity),JSON.stringify(comparison),'running'); this.#db.exec('COMMIT'); return { claimed: true, comparison: clone(comparison) }
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  getComparison(scope: object, id: string): SkillComparison | undefined { const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid comparison reference'); const row = this.#db.prepare('SELECT comparison_json FROM skill_comparisons WHERE scope_key=? AND id=?').get(key,id) as { comparison_json: string } | undefined; return row ? clone(JSON.parse(row.comparison_json) as SkillComparison) : undefined }
  finishComparison(scope: object, id: string, state: 'complete' | 'unknown', result: unknown): SkillComparison { const key = scopeKey(scope); if (!text(id,128) || !['complete','unknown'].includes(state) || !json(result)) fail('assistant-skills: invalid comparison'); const current = this.getComparison(scope,id); if (!current || current.state !== 'running') fail('assistant-skills: comparison state conflict'); const saved = { ...current, state, result: clone(result), updatedAt: Date.now() }; if (this.#db.prepare("UPDATE skill_comparisons SET state=?,comparison_json=? WHERE scope_key=? AND id=? AND state='running'").run(state,JSON.stringify(saved),key,id).changes !== 1) fail('assistant-skills: comparison state conflict'); return clone(saved) }
  #latest(key: string, skillName: string): StoredSkillDefinition | undefined {
    const row = this.#db.prepare('SELECT definition_json FROM skill_definitions WHERE scope_key=? AND name=? ORDER BY version DESC LIMIT 1').get(key, skillName) as { definition_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.definition_json) as StoredSkillDefinition
  }
  #newDefinition(definition: SkillDefinition, savedVersion: number, parentVersion: number | null, restoredFromVersion?: number): StoredSkillDefinition {
    const now = Date.now()
    const clean: SkillDefinition = { protocol: definition.protocol, name: definition.name, description: definition.description, source: definition.source, inputs: definition.inputs, steps: definition.steps,
      preconditions: definition.preconditions, compensation: definition.compensation,
      ...(definition.fileObservations === undefined ? {} : { fileObservations: definition.fileObservations }),
      ...(definition.runExpansions === undefined ? {} : { runExpansions: definition.runExpansions }) }
    return { ...clone(clean), version: savedVersion, parentVersion, retired: false, createdAt: now, updatedAt: now, ...(restoredFromVersion === undefined ? {} : { restoredFromVersion }) }
  }
  #insertDefinition(key: string, saved: StoredSkillDefinition): void {
    this.#db.prepare('INSERT INTO skill_definitions VALUES(?,?,?,?,?,?,?)').run(key, saved.name, saved.version, 0, JSON.stringify(saved), saved.createdAt, saved.updatedAt)
  }
  #candidate(key: string, id: string): SkillCandidate | undefined {
    const row = this.#db.prepare('SELECT candidate_json FROM skill_candidates WHERE scope_key=? AND id=?').get(key, id) as { candidate_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.candidate_json) as SkillCandidate
  }
  #candidateFailureProvenance(scope: object, definition: SkillDefinition, expectedVersion: number, parentDigest: string | null, parent: StoredSkillDefinition | undefined, value: unknown): FailureCaptureProvenance {
    const provenance = validateFailureCaptureProvenance(value) as FailureCaptureProvenance
    const parentTools = [...new Set(parent?.steps.map(step => step.toolName) ?? [])].sort()
    const candidateTools = [...new Set(definition.steps.map(step => step.toolName))].sort()
    if (!parent || expectedVersion < 1 || parentDigest === null || acceptanceDigest(parent) !== parentDigest || acceptanceDigest(provenance.trigger.scope) !== acceptanceDigest(scope)
      || provenance.parent.name !== definition.name || provenance.parent.version !== expectedVersion || provenance.parent.digest !== parentDigest
      || provenance.rollbackTarget.name !== definition.name || provenance.rollbackTarget.version !== expectedVersion || provenance.rollbackTarget.digest !== parentDigest
      || provenance.candidate.name !== definition.name || provenance.candidate.definitionDigest !== acceptanceDigest(definition)
      || provenance.repair.sourceDigest !== acceptanceDigest(definition.source) || provenance.repair.acceptanceDigest !== acceptanceDigest(definition.source.acceptance)
      || acceptanceDigest(provenance.repair.goal) !== acceptanceDigest(definition.source.goal)
      || acceptanceDigest(provenance.permissionDelta.parent) !== acceptanceDigest(parentTools)
      || acceptanceDigest(provenance.permissionDelta.candidate) !== acceptanceDigest(candidateTools)) fail('assistant-skills: invalid failure candidate provenance')
    return clone(provenance)
  }
  #assertCandidateFailureProvenance(scope: object, candidate: SkillCandidate): FailureCaptureProvenance | undefined {
    if (candidate.failureProvenance === undefined) return undefined
    const parent = this.#latest(scopeKey(scope), candidate.definition.name)
    return this.#candidateFailureProvenance(scope, candidate.definition, candidate.parentVersion, candidate.parentDigest,
      parent?.version === candidate.parentVersion ? parent : this.get(scope, candidate.definition.name, candidate.parentVersion), candidate.failureProvenance)
  }
  #activatedFailureCandidate(key: string, skillName: string, activatedVersion: number): SkillCandidate | undefined {
    const rows = this.#db.prepare('SELECT candidate_json FROM skill_candidates WHERE scope_key=?').all(key) as { candidate_json: string }[]
    const matches = rows.map(row => JSON.parse(row.candidate_json) as SkillCandidate).filter(candidate => candidate.state === 'activated' && candidate.activatedVersion === activatedVersion
      && candidate.definition.name === skillName && candidate.failureProvenance !== undefined)
    if (matches.length > 1) fail('assistant-skills: failure candidate audit conflict')
    return matches[0]
  }
  #capture(key: string, id: string): SkillCapture | undefined { const row = this.#db.prepare('SELECT capture_json FROM skill_captures WHERE scope_key=? AND id=?').get(key, id) as { capture_json: string } | undefined; return row ? JSON.parse(row.capture_json) as SkillCapture : undefined }
  #repairContinuation(key: string, id: string): SkillRepairContinuation | undefined {
    const row = this.#db.prepare('SELECT continuation_json FROM skill_repair_continuations WHERE scope_key=? AND id=?').get(key, id) as { continuation_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.continuation_json) as SkillRepairContinuation
  }
  #repairExecution(key: string, id: string, iteration: number): RepairExecutionLease | undefined {
    const row = this.#db.prepare('SELECT lease_json FROM skill_repair_execution WHERE scope_key=? AND id=? AND iteration=?').get(key, id, iteration) as { lease_json: string } | undefined
    if (!row) return undefined
    try {
      const lease = JSON.parse(row.lease_json) as RepairExecutionLease
      if (!this.#validRepairExecution(lease) || lease.authorizationId !== id || lease.iteration !== iteration) fail('assistant-skills: invalid repair execution record')
      return lease
    } catch (error) { if (error instanceof Error && error.message.startsWith('assistant-skills:')) throw error; fail('assistant-skills: invalid repair execution record') }
  }
  #putRepairExecution(key: string, lease: RepairExecutionLease): void {
    if (!this.#validRepairExecution(lease)) fail('assistant-skills: invalid repair execution record')
    this.#db.prepare('INSERT INTO skill_repair_execution(scope_key,id,iteration,lease_json,fence,state,pending_model,pending_tool) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,id,iteration) DO UPDATE SET lease_json=excluded.lease_json,fence=excluded.fence,state=excluded.state,pending_model=excluded.pending_model,pending_tool=excluded.pending_tool')
      .run(key, lease.authorizationId, lease.iteration, JSON.stringify(lease), lease.fence, lease.state, lease.pendingModel, lease.pendingTool)
  }
  #updateRepairExecution(key: string, expected: RepairExecutionLease, saved: RepairExecutionLease): void {
    if (!this.#validRepairExecution(expected) || !this.#validRepairExecution(saved) || expected.authorizationId !== saved.authorizationId || expected.iteration !== saved.iteration) fail('assistant-skills: invalid repair execution record')
    const result = this.#db.prepare("UPDATE skill_repair_execution SET lease_json=?,fence=?,state=?,pending_model=?,pending_tool=? WHERE scope_key=? AND id=? AND iteration=? AND fence=? AND state=? AND pending_model=? AND pending_tool=? AND json_extract(lease_json, '$.authorizationDigest')=?")
      .run(JSON.stringify(saved), saved.fence, saved.state, saved.pendingModel, saved.pendingTool, key, expected.authorizationId, expected.iteration, expected.fence, expected.state, expected.pendingModel, expected.pendingTool, expected.authorizationDigest)
    if (result.changes !== 1) fail('assistant-skills: repair execution fence conflict')
  }
  #validRepairExecution(value: unknown): value is RepairExecutionLease {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !json(value) || Object.keys(value).length !== 11) return false
    const lease = value as RepairExecutionLease, proc = lease.process
    return text(lease.authorizationId, 128) && digest(lease.authorizationDigest) && version(lease.iteration) && text(lease.sessionId, 512) && text(lease.holderId, 512)
      && version(lease.fence) && Number.isSafeInteger(lease.deadlineAt) && lease.deadlineAt > 0 && ['active', 'released'].includes(lease.state)
      && !!proc && typeof proc === 'object' && Object.keys(proc).length === 4 && typeof proc.bootId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(proc.bootId)
      && Number.isSafeInteger(proc.pid) && proc.pid > 0 && typeof proc.startTicks === 'string' && /^[1-9][0-9]{0,63}$/u.test(proc.startTicks)
      && typeof proc.pidNamespace === 'string' && /^(?:linux:[0-9]{1,32}:[0-9]{1,32}|local:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/u.test(proc.pidNamespace)
      && Number.isSafeInteger(lease.pendingModel) && lease.pendingModel >= 0 && Number.isSafeInteger(lease.pendingTool) && lease.pendingTool >= 0
      && (lease.state !== 'released' || (lease.pendingModel === 0 && lease.pendingTool === 0))
  }
  #sameRepairProcess(expected: RepairProcessWitness, actual: RepairProcessWitness | undefined): boolean {
    return !!actual && expected.bootId === actual.bootId && expected.pidNamespace === actual.pidNamespace && expected.pid === actual.pid && expected.startTicks === actual.startTicks
  }
  #repairExecutionAuthorization(key: string, id: string, iteration: number, deadlineAt: number): SkillRepairContinuation {
    const continuation = this.#repairContinuation(key, id)
    if (!continuation || continuation.iteration !== iteration || continuation.authorizationDigest !== acceptanceDigest(continuation.authorization)
      || deadlineAt <= Date.now() || continuation.authorization.expiresAt <= Date.now() || deadlineAt > continuation.authorization.expiresAt
      || ['complete', 'rejected', 'revoked', 'expired', 'unknown'].includes(continuation.state)) fail('assistant-skills: repair execution authorization unavailable')
    return continuation
  }
  #assertRepairExecution(key: string, lease: RepairExecutionLease, authorization: boolean): RepairExecutionLease {
    if (!this.#validRepairExecution(lease)) fail('assistant-skills: invalid repair execution lease')
    const current = this.#repairExecution(key, lease.authorizationId, lease.iteration)
    if (!current || current.state !== 'active' || current.fence !== lease.fence || current.authorizationDigest !== lease.authorizationDigest
      || current.sessionId !== lease.sessionId || current.holderId !== lease.holderId || current.deadlineAt !== lease.deadlineAt
      || !this.#sameRepairProcess(current.process, currentRepairProcess())) fail('assistant-skills: repair execution fence conflict')
    if (authorization) this.#repairExecutionAuthorization(key, lease.authorizationId, lease.iteration, lease.deadlineAt)
    return current
  }
  #watch(key: string, id: string): SkillWatch | undefined { const row = this.#db.prepare('SELECT watch_json FROM skill_watches WHERE scope_key=? AND id=?').get(key, id) as { watch_json: string } | undefined; return row ? JSON.parse(row.watch_json) as SkillWatch : undefined }
  #watches(key: string, state: SkillWatch['state']): SkillWatch[] { return (this.#db.prepare('SELECT watch_json FROM skill_watches WHERE scope_key=? AND state=?').all(key, state) as { watch_json: string }[]).map(row => JSON.parse(row.watch_json) as SkillWatch) }
  #putWatch(key: string, watch: SkillWatch): void { this.#db.prepare('INSERT INTO skill_watches(scope_key,id,watch_json,state) VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET watch_json=excluded.watch_json,state=excluded.state').run(key, watch.id, JSON.stringify(watch), watch.state) }
  #deployment(key: string, id: string): SkillDeployment | undefined { const row = this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=? AND id=?').get(key, id) as { deployment_json: string } | undefined; return row ? JSON.parse(row.deployment_json) as SkillDeployment : undefined }
  #deploymentForVersion(key: string, skillName: string, wantedVersion: number): SkillDeployment | undefined {
    const rows = this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=?').all(key) as { deployment_json: string }[]
    return rows.map(row => JSON.parse(row.deployment_json) as SkillDeployment).find(value => value.skillName === skillName && value.version === wantedVersion)
  }
  #deploymentForWatch(key: string, id: string): SkillDeployment | undefined {
    const rows = this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=?').all(key) as { deployment_json: string }[]
    return rows.map(row => JSON.parse(row.deployment_json) as SkillDeployment).find(value => value.watchId === id)
  }
  #deploymentsForRun(key: string, run: string): SkillDeployment[] {
    const rows = this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=?').all(key) as { deployment_json: string }[]
    return rows.map(row => JSON.parse(row.deployment_json) as SkillDeployment).filter(value => value.runIds.includes(run))
  }
  #putDeployment(key: string, deployment: SkillDeployment): void { this.#db.prepare('INSERT INTO skill_deployments(scope_key,id,deployment_json,state) VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET deployment_json=excluded.deployment_json,state=excluded.state').run(key, deployment.id, JSON.stringify(deployment), deployment.state) }
  #comparison(key: string, id: string): SkillComparison | undefined { const row = this.#db.prepare('SELECT comparison_json FROM skill_comparisons WHERE scope_key=? AND id=?').get(key, id) as { comparison_json: string } | undefined; return row ? JSON.parse(row.comparison_json) as SkillComparison : undefined }
  #reconcileDeployment(key: string, deployment: SkillDeployment, allowPromotion: boolean): SkillDeployment {
    if (deployment.state !== 'canary' && deployment.state !== 'promoted' && deployment.state !== 'blocked') return deployment
    let state: SkillDeployment['state'] | undefined
    const watch = this.#watch(key, deployment.watchId)
    const active = this.#latest(key, deployment.skillName)
    if (watch?.state === 'rolled-back' && watch.skillName === deployment.skillName && watch.version === deployment.version && watch.definitionDigest === deployment.definitionDigest) state = 'rolled-back'
    else if (deployment.state === 'blocked') return deployment
    else if (deployment.expiresAt <= Date.now()) state = 'expired'
    else if (!active || active.retired || active.version !== deployment.version || acceptanceDigest(active) !== deployment.definitionDigest) state = 'superseded'
    else if (!watch || watch.skillName !== deployment.skillName || watch.version !== deployment.version || watch.definitionDigest !== deployment.definitionDigest || watch.maxRuns !== deployment.maxRuns || watch.failureThreshold !== 1) state = 'superseded'
    else if (!exactCanonicalObservationState(watch, deployment)) state = 'blocked'
    else if (watch.state === 'expired') state = 'expired'
    else if (watch.state === 'revoked') state = 'revoked'
    else if (watch.state === 'superseded') state = 'superseded'
    else if (deployment.runIds.some(id => { const run = this.#run(key, id); return !run || run.state === 'failed' || run.state === 'unknown' })) state = 'blocked'
    else if (watch.canonicalRevisions?.some(value => value.disposition === 'retract' && deployment.runIds.includes(value.runId))
      || watch.observations.some(value => value.objectiveStatus === 'not-achieved' && value.taskFamilyDigest === acceptanceDigest(deployment.taskFamily)
        && value.canonical !== undefined && watch.canonicalRevisions?.some(revision => revision.runId === value.runId && revision.disposition === 'upsert'
          && revision.subjectRef === value.canonical!.subjectRef && revision.version === value.canonical!.version && revision.digest === value.canonical!.digest
          && revision.scopeWatermark === value.canonical!.scopeWatermark))) state = 'blocked'
    else if (allowPromotion && deployment.state === 'canary' && new Set(watch.observations.filter(value => value.objectiveStatus === 'achieved' && value.taskFamilyDigest === acceptanceDigest(deployment.taskFamily)
      && value.validUntil > Date.now() && deployment.runIds.includes(value.runId) && value.canonical !== undefined
      && watch.canonicalRevisions?.some(revision => revision.runId === value.runId && revision.disposition === 'upsert'
        && revision.subjectRef === value.canonical!.subjectRef && revision.version === value.canonical!.version && revision.digest === value.canonical!.digest
        && revision.scopeWatermark === value.canonical!.scopeWatermark)).map(value => value.runId)).size >= deployment.canaryRuns) state = 'promoted'
    if (!state || state === deployment.state) return deployment
    const now = Date.now()
    const saved = { ...deployment, state, updatedAt: now, ...(state === 'promoted' && deployment.promotedAt === undefined ? { promotedAt: now } : {}) }
    this.#putDeployment(key, saved); return saved
  }
  #putCandidate(key: string, candidate: SkillCandidate): void {
    this.#db.prepare('INSERT INTO skill_candidates(scope_key,id,candidate_json) VALUES(?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET candidate_json=excluded.candidate_json').run(key, candidate.id, JSON.stringify(candidate))
  }
  #putCapture(key: string, capture: SkillCapture): void { this.#db.prepare('INSERT INTO skill_captures(scope_key,id,capture_json,state) VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET capture_json=excluded.capture_json,state=excluded.state').run(key, capture.id, JSON.stringify(capture), capture.state) }
  #run(key: string, id: string): SkillRun | undefined {
    const row = this.#db.prepare('SELECT run_json FROM skill_runs WHERE scope_key=? AND id=?').get(key, id) as { run_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.run_json) as SkillRun
  }
  #validateClaim(_scope: object, input: SkillRunClaim): void {
    if (!input || !text(input.invocationId, 256) || !text(input.goalId, 256) || !text(input.sessionId, 512) || !name(input.skillName) || !version(input.version) || !input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs) || !json(input.inputs)
      || input.goalExecutionRunId !== undefined && !text(input.goalExecutionRunId, 256) || input.goalDefinitionDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.goalDefinitionDigest) || input.nativeGoalId !== undefined && !text(input.nativeGoalId, 256) || input.candidateId !== undefined && !text(input.candidateId, 128)
      || input.candidateId !== undefined && input.goalExecutionRunId === undefined) fail('assistant-skills: invalid invocation')
    if (input.candidateId !== undefined) return
  }
  #validateTrialClaim(key: string, input: SkillRunClaim): void {
    const candidate = this.#candidate(key, input.candidateId!)
    if (!candidate || candidate.state !== 'pending' || candidate.expiresAt <= Date.now()) fail('assistant-skills: candidate unavailable')
    const current = this.#latest(key, candidate.definition.name)
    if (current?.retired || (current?.version ?? 0) !== candidate.parentVersion || (current ? acceptanceDigest(current) : null) !== candidate.parentDigest
      || input.skillName !== candidate.definition.name || input.version !== candidate.parentVersion + 1) fail('assistant-skills: candidate conflict')
  }
  #validateSteps(steps: readonly SkillRunStep[]): void {
    if (!Array.isArray(steps) || steps.length > 32 || steps.some(step => !step || !text(step.id, 256) || !['succeeded', 'failed', 'unknown'].includes(step.state) || step.detail !== undefined && !text(step.detail, 4096)) || new Set(steps.map(step => step.id)).size !== steps.length) fail('assistant-skills: invalid run completion')
  }
}
