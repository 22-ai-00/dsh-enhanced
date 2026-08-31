import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { discover, parseCatalog, type CatalogEntry, type LoadedCapabilityCatalog } from './catalog.js'
import { openControlPlaneDatabase } from './sqlite.js'
import type {
  ApprovalAuthority,
  ApprovalReceipt,
  CapabilityGapInput,
  HostAttestationAuthority,
  HostAttestationOperation,
  HostAttestationPhase,
  HostAttestationReceipt,
  HostAttestationRequest,
  HostAttestationRequirements,
  OperationReceipt,
  PlanStatus,
  PluginActivationPlan,
  PluginControlPlaneHealth,
  PluginSourcePlan,
  SourceReleaseAdapterIdentity,
  SourceReleasePhase,
  SourcePlanStatus,
  StoredCapabilityGap,
} from './types.js'

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

export class ControlPlaneStoreError extends Error {
  constructor(readonly code: 'conflict' | 'expired' | 'invalid-input' | 'invalid-state' | 'not-found', message: string) {
    super(message)
    this.name = 'ControlPlaneStoreError'
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function controlPlaneDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function bounded(value: string, field: string, maximum = 1_000): string {
  if (typeof value !== 'string') throw new ControlPlaneStoreError('invalid-input', `${field} must be text`)
  const result = value.normalize('NFC').trim()
  const control = [...result].some(character => {
    const point = character.codePointAt(0)!
    return point <= 0x1f || point === 0x7f
  })
  if (result === '' || Buffer.byteLength(result) > maximum || control) throw new ControlPlaneStoreError('invalid-input', `${field} must be bounded printable text`)
  return result
}

function finite(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new ControlPlaneStoreError('invalid-input', `${field} is outside its accepted range`)
  return value
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new ControlPlaneStoreError('invalid-input', `${field} must be a positive safe integer`)
  return value
}

interface GapRow extends Record<string, unknown> {
  id: string; idempotency_key: string; input_digest: string; capability: string; context: string
  expected_value: number; frequency: number; estimated_cost: number; risk: number; roi: number
  status: StoredCapabilityGap['status']; candidate_id: string | null; revision: number; created_at: number; updated_at: number
}

interface ActivationRow {
  id: string; plan_digest: string; gap_id: string; gap_snapshot_json: string; profile: string
  candidate_json: string; dossier_json: string; installation_id: string; dsh_home: string; target_path: string
  ledger_id: string; ledger_path: string; executor_id: string; executor_version: string; executor_path: string
  executor_digest: string; status: PlanStatus; revision: number; created_at: number; expires_at: number
  approval_json: string | null; activation_id: string | null; activation_fence: number
  activation_lease_until: number | null; activation_target_existed: number | null; failure_code: string | null; updated_at: number
}

interface SourceRow {
  id: string; plan_digest: string; gap_id: string; gap_snapshot_json: string; repository: string; worktree: string
  base_commit: string; plugin_name: string; generator_digest: string; scope_json: string; status: SourcePlanStatus
  revision: number; created_at: number; expires_at: number; approval_json: string | null
  release_id: string | null; release_fence: number; release_failure_phase: SourceReleasePhase | null
  release_failure_code: string | null; updated_at: number
}

interface HostAttestationOperationRow {
  plan_id: string; phase: HostAttestationPhase; operation_id: string; binding_digest: string; request_digest: string
  request_json: string; status: HostAttestationOperation['status']; receipt_digest: string | null; receipt_json: string | null
  created_at: number; completed_at: number | null; applied_at: number | null
}

function gapFromRow(row: GapRow): StoredCapabilityGap {
  if (!DIGEST.test(row.input_digest) || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new ControlPlaneStoreError('invalid-state', 'stored capability gap is corrupt')
  return {
    id: row.id, idempotencyKey: row.idempotency_key, inputDigest: row.input_digest,
    capability: row.capability, context: row.context, expectedValue: row.expected_value,
    frequency: row.frequency, estimatedCost: row.estimated_cost, risk: row.risk, roi: row.roi,
    status: row.status, revision: row.revision, ...(row.candidate_id === null ? {} : { candidateId: row.candidate_id }),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function activationFromRow(row: ActivationRow): PluginActivationPlan {
  const candidate = parseCatalog({ schemaVersion: 1, entries: [JSON.parse(row.candidate_json) as unknown] }).entries[0]
  const gapSnapshot = JSON.parse(row.gap_snapshot_json) as PluginActivationPlan['gapSnapshot']
  const dossier = JSON.parse(row.dossier_json) as PluginActivationPlan['dossier']
  if (candidate === undefined || !DIGEST.test(row.plan_digest) || !UUID.test(row.installation_id)
    || !DIGEST.test(gapSnapshot.inputDigest) || !DIGEST.test(dossier.catalogDigest)) throw new ControlPlaneStoreError('invalid-state', 'stored activation plan is corrupt')
  const immutable = {
    schemaVersion: 4, kind: 'activation', id: row.id, gapId: row.gap_id, gapSnapshot,
    profile: row.profile, candidate, dossier, installationId: row.installation_id,
    ledger: { id: row.ledger_id, path: row.ledger_path },
    target: { dshHome: row.dsh_home, profile: row.profile, profilePath: row.target_path },
    executor: { id: row.executor_id, version: row.executor_version, path: row.executor_path, sha256: row.executor_digest },
    createdAt: row.created_at, expiresAt: row.expires_at,
  } as const
  if (controlPlaneDigest(immutable) !== row.plan_digest) throw new ControlPlaneStoreError('invalid-state', 'stored activation plan digest does not match its immutable dossier')
  const approval = row.approval_json === null ? undefined : JSON.parse(row.approval_json) as NonNullable<PluginActivationPlan['approval']>
  return {
    ...immutable, digest: row.plan_digest, status: row.status, revision: row.revision,
    ...(approval === undefined ? {} : { approval }),
    ...(row.activation_id === null ? {} : { activation: { id: row.activation_id, fence: row.activation_fence,
      ...(row.activation_target_existed === null ? {} : { targetOriginallyExisted: row.activation_target_existed === 1 }),
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code }), updatedAt: row.updated_at } }),
  }
}

function sourceFromRow(row: SourceRow): PluginSourcePlan {
  const gapSnapshot = JSON.parse(row.gap_snapshot_json) as PluginSourcePlan['gapSnapshot']
  const scope = JSON.parse(row.scope_json) as readonly string[]
  const immutable = { schemaVersion: 1, kind: 'source', id: row.id, gapId: row.gap_id, gapSnapshot,
    repository: row.repository, worktree: row.worktree, baseCommit: row.base_commit, name: row.plugin_name,
    generatorDigest: row.generator_digest, scope, createdAt: row.created_at, expiresAt: row.expires_at } as const
  if (!COMMIT.test(row.base_commit) || !DIGEST.test(row.generator_digest) || !DIGEST.test(gapSnapshot.inputDigest)
    || controlPlaneDigest(immutable) !== row.plan_digest) throw new ControlPlaneStoreError('invalid-state', 'stored source plan is corrupt or digest-mismatched')
  const approval = row.approval_json === null ? undefined : JSON.parse(row.approval_json) as NonNullable<PluginSourcePlan['approval']>
  return { ...immutable, digest: row.plan_digest, status: row.status, revision: row.revision, ...(approval === undefined ? {} : { approval }),
    ...(row.release_id === null ? {} : { release: { id: row.release_id, fence: row.release_fence,
      ...(row.release_failure_phase === null ? {} : { failurePhase: row.release_failure_phase }),
      ...(row.release_failure_code === null ? {} : { failureCode: row.release_failure_code }), updatedAt: row.updated_at } }) }
}

export interface ControlPlaneStoreOptions { path: string; now?: () => number }

export interface CreateActivationPlanInput {
  candidate: CatalogEntry
  catalog: Pick<LoadedCapabilityCatalog, 'digest' | 'provenance'>
  matchedCapabilities: readonly string[]
  profile: string
  target: PluginActivationPlan['target']
  installationId: string
  ledger: PluginActivationPlan['ledger']
  executor: PluginActivationPlan['executor']
  ttlMs: number
  gapId: string
  idempotencyKey: string
}

export interface CreateSourcePlanInput {
  gapId: string; repository: string; worktree: string; baseCommit: string; name: string
  generatorDigest: string; scope: readonly string[]; ttlMs: number; idempotencyKey: string
}

export interface PrepareSourceReleaseOperationInput {
  planId: string
  expectedRevision: number
  expectedFence: number
  installationId: string
  ledger: { id: string; path: string }
  registry: { id: string; locator: string }
  catalog: { id: string; path: string }
  adapter: SourceReleaseAdapterIdentity
  receiptTtlMs: number
}

const expectedAttestation: Readonly<Record<string, { phase: HostAttestationPhase; next: PlanStatus }>> = Object.freeze({
  'awaiting-reload': { phase: 'reload', next: 'awaiting-readiness' },
  'awaiting-readiness': { phase: 'readiness', next: 'awaiting-effect-blocked-replay' },
  'awaiting-effect-blocked-replay': { phase: 'effect-blocked-replay', next: 'awaiting-shadow' },
  'awaiting-shadow': { phase: 'shadow', next: 'awaiting-canary' },
  'awaiting-canary': { phase: 'canary', next: 'awaiting-soak' },
  'awaiting-soak': { phase: 'soak', next: 'awaiting-health' },
  'awaiting-health': { phase: 'health', next: 'commit-pending' },
})

export function expectedHostAttestation(status: PlanStatus): { phase: HostAttestationPhase; next: PlanStatus } | undefined {
  return expectedAttestation[status]
}

function requestBinding(request: HostAttestationRequest): Omit<HostAttestationRequest, 'operationId' | 'requestedAt'> {
  const { operationId: _operationId, requestedAt: _requestedAt, ...binding } = request
  return binding
}

function hostOperationFromRow(row: HostAttestationOperationRow): HostAttestationOperation {
  const request = JSON.parse(row.request_json) as HostAttestationRequest
  if (request.operationId !== row.operation_id || request.plan.id !== row.plan_id || request.phase !== row.phase
    || controlPlaneDigest(request) !== row.request_digest || controlPlaneDigest(requestBinding(request)) !== row.binding_digest
    || (row.status === 'pending') !== (row.receipt_json === null)) {
    throw new ControlPlaneStoreError('invalid-state', 'stored Host attestation operation is corrupt')
  }
  const receipt = row.receipt_json === null ? undefined : JSON.parse(row.receipt_json) as HostAttestationReceipt
  if (receipt !== undefined && (receipt.operationId !== row.operation_id || controlPlaneDigest(receipt) !== row.receipt_digest)) {
    throw new ControlPlaneStoreError('invalid-state', 'stored Host attestation receipt is corrupt')
  }
  return { planId: row.plan_id, phase: row.phase, operationId: row.operation_id, bindingDigest: row.binding_digest,
    requestDigest: row.request_digest, request, status: row.status, ...(receipt === undefined ? {} : { receipt }),
    createdAt: row.created_at, ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }) }
}

const expectedRelease: Readonly<Record<string, { phase: SourceReleasePhase; next: SourcePlanStatus }>> = Object.freeze({
  'awaiting-pr': { phase: 'pr', next: 'awaiting-review' },
  'awaiting-review': { phase: 'review', next: 'awaiting-merge' },
  'awaiting-merge': { phase: 'merge', next: 'awaiting-build' },
  'awaiting-build': { phase: 'build', next: 'awaiting-sign' },
  'awaiting-sign': { phase: 'sign', next: 'awaiting-publish' },
  'awaiting-publish': { phase: 'publish', next: 'awaiting-registry-verify' },
  'awaiting-registry-verify': { phase: 'registry-verify', next: 'awaiting-catalog-admission' },
  'awaiting-catalog-admission': { phase: 'catalog-admission', next: 'release-complete' },
})

export function expectedSourceRelease(status: SourcePlanStatus): { phase: SourceReleasePhase; next: SourcePlanStatus } | undefined {
  return expectedRelease[status]
}

export class ControlPlaneStore {
  readonly #database: DatabaseSync
  readonly #now: () => number

  constructor(options: ControlPlaneStoreOptions) { this.#database = openControlPlaneDatabase(options.path); this.#now = options.now ?? Date.now }
  close(): void { this.#database.close() }

  recordGap(input: CapabilityGapInput): StoredCapabilityGap {
    const normalized = {
      idempotencyKey: bounded(input.idempotencyKey, 'idempotencyKey', 160), capability: bounded(input.capability, 'capability', 300),
      context: bounded(input.context, 'context', 4_000), expectedValue: finite(input.expectedValue, 'expectedValue', 0, 1_000_000_000),
      frequency: finite(input.frequency, 'frequency', 0.000_001, 1_000_000), estimatedCost: finite(input.estimatedCost, 'estimatedCost', 0.000_001, 1_000_000_000),
      risk: finite(input.risk, 'risk', 0, 1),
    }
    if (!KEY.test(normalized.idempotencyKey)) throw new ControlPlaneStoreError('invalid-input', 'idempotencyKey has invalid syntax')
    const inputDigest = controlPlaneDigest(normalized)
    const prior = this.#database.prepare('SELECT * FROM capability_gaps WHERE idempotency_key = ?').get(normalized.idempotencyKey) as unknown as GapRow | undefined
    if (prior !== undefined) {
      if (prior.input_digest !== inputDigest) throw new ControlPlaneStoreError('conflict', 'capability gap idempotency key was reused with different input')
      return gapFromRow(prior)
    }
    const now = this.#now(); const id = `gap-${randomUUID()}`
    const roi = Math.min(1_000_000_000, (normalized.expectedValue * normalized.frequency * (1 - normalized.risk)) / normalized.estimatedCost)
    try {
      this.#database.prepare(`INSERT INTO capability_gaps (id, idempotency_key, input_digest, capability, context,
        expected_value, frequency, estimated_cost, risk, roi, status, candidate_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 1, ?, ?)`).run(id, normalized.idempotencyKey, inputDigest,
        normalized.capability, normalized.context, normalized.expectedValue, normalized.frequency, normalized.estimatedCost, normalized.risk, roi, now, now)
    } catch (error) {
      const raced = this.#database.prepare('SELECT * FROM capability_gaps WHERE idempotency_key = ?').get(normalized.idempotencyKey) as unknown as GapRow | undefined
      if (raced !== undefined && raced.input_digest === inputDigest) return gapFromRow(raced)
      throw error
    }
    return this.getGap(id)
  }

  getGap(id: string): StoredCapabilityGap {
    const row = this.#database.prepare('SELECT * FROM capability_gaps WHERE id = ?').get(id) as unknown as GapRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'capability gap not found')
    return gapFromRow(row)
  }

  listGaps(limit = 20): readonly StoredCapabilityGap[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ControlPlaneStoreError('invalid-input', 'gap limit must be 1..100')
    return (this.#database.prepare(`SELECT * FROM capability_gaps WHERE status = 'open' ORDER BY roi DESC, created_at, id LIMIT ?`).all(limit) as unknown as GapRow[]).map(gapFromRow)
  }

  createPlan(input: CreateActivationPlanInput): OperationReceipt<PluginActivationPlan> {
    const profile = bounded(input.profile, 'profile', 64); const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', 160)
    if (!PROFILE.test(profile) || !KEY.test(idempotencyKey) || !UUID.test(input.installationId) || !UUID.test(input.ledger.id)
      || !DIGEST.test(input.catalog.digest) || !DIGEST.test(input.executor.sha256)
      || !isAbsolute(input.ledger.path) || !isAbsolute(input.executor.path)) throw new ControlPlaneStoreError('invalid-input', 'activation plan binding is invalid')
    positiveInteger(input.ttlMs, 'ttlMs'); if (input.ttlMs < 60_000 || input.ttlMs > 86_400_000) throw new ControlPlaneStoreError('invalid-input', 'ttlMs is invalid')
    const candidate = parseCatalog({ schemaVersion: 1, entries: [input.candidate] }).entries[0]!
    const matchedCapabilities = [...new Set(input.matchedCapabilities.map(value => bounded(value, 'matched capability', 300)))].sort()
    if (matchedCapabilities.length === 0) throw new ControlPlaneStoreError('invalid-input', 'candidate must match the bound capability gap')
    const packages = Object.freeze([{ package: candidate.package, version: candidate.version, integrity: candidate.integrity }, ...candidate.requires])
    const requestBinding = { operation: 'create-activation-plan', gapId: input.gapId, candidate, catalog: input.catalog,
      matchedCapabilities, profile, target: input.target, installationId: input.installationId,
      ledger: input.ledger, executor: input.executor, ttlMs: input.ttlMs }
    const inputDigest = controlPlaneDigest(requestBinding)
    const prior = this.#receipt<PluginActivationPlan>(idempotencyKey, 'create-activation-plan', inputDigest)
    if (prior !== undefined) return prior
    const gap = this.getGap(input.gapId)
    if (gap.status !== 'open') throw new ControlPlaneStoreError('invalid-state', 'only an open gap can create an activation plan')
    if (!discover({ schemaVersion: 1, entries: [candidate] }, gap.capability).some(item => item.id === candidate.id)
      || matchedCapabilities.some(value => !candidate.capabilities.includes(value))) {
      throw new ControlPlaneStoreError('invalid-input', 'candidate dossier does not match the exact gap capability')
    }
    const gapSnapshot = Object.freeze({ revision: gap.revision, inputDigest: gap.inputDigest, roi: gap.roi, capability: gap.capability })
    const dossier = Object.freeze({ catalogDigest: input.catalog.digest, catalogProvenance: input.catalog.provenance,
      matchedCapabilities: Object.freeze(matchedCapabilities), authorities: Object.freeze([...candidate.authorities]), packages })
    const now = this.#now(); const id = `plugin-${randomUUID()}`; const expiresAt = now + input.ttlMs
    const immutable = { schemaVersion: 4 as const, kind: 'activation' as const, id, gapId: gap.id, gapSnapshot,
      profile, candidate, dossier, installationId: input.installationId, ledger: input.ledger,
      target: input.target, executor: input.executor,
      createdAt: now, expiresAt }
    const planDigest = controlPlaneDigest(immutable)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const raced = this.#receipt<PluginActivationPlan>(idempotencyKey, 'create-activation-plan', inputDigest)
      if (raced !== undefined) { this.#database.exec('COMMIT'); return raced }
      const currentGap = this.getGap(gap.id)
      if (currentGap.revision !== gap.revision || currentGap.inputDigest !== gap.inputDigest || currentGap.roi !== gap.roi || currentGap.status !== 'open') throw new ControlPlaneStoreError('conflict', 'capability gap changed before plan creation')
      this.#database.prepare('INSERT INTO gap_plan_claims (gap_id, plan_id, plan_kind, claimed_at) VALUES (?, ?, ?, ?)').run(gap.id, id, 'activation', now)
      this.#database.prepare(`INSERT INTO activation_plans (id, plan_digest, gap_id, gap_snapshot_json, profile, candidate_json,
        dossier_json, installation_id, ledger_id, ledger_path, dsh_home, target_path, executor_id, executor_version,
        executor_path, executor_digest, status, revision, created_at,
        expires_at, approval_json, activation_id, activation_fence, activation_lease_until, activation_target_existed, failure_code, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending-approval', 1, ?, ?, NULL, NULL, 0, NULL, NULL, NULL, ?)`).run(
        id, planDigest, gap.id, JSON.stringify(gapSnapshot), profile, JSON.stringify(candidate), JSON.stringify(dossier), input.installationId,
        input.ledger.id, input.ledger.path, input.target.dshHome, input.target.profilePath, input.executor.id,
        input.executor.version, input.executor.path, input.executor.sha256, now, expiresAt, now)
      this.#database.prepare(`UPDATE capability_gaps SET status = 'matched', candidate_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`).run(candidate.id, now, gap.id, gap.revision)
      const plan = this.getPlan(id)
      const receipt = { idempotencyKey, operation: 'create-activation-plan', inputDigest, result: plan, createdAt: now }
      this.#insertReceipt(receipt); this.#database.exec('COMMIT'); return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getPlan(id: string): PluginActivationPlan {
    const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(id) as unknown as ActivationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
    return activationFromRow(row)
  }

  createSourcePlan(input: CreateSourcePlanInput): OperationReceipt<PluginSourcePlan> {
    const key = bounded(input.idempotencyKey, 'idempotencyKey', 160); const name = bounded(input.name, 'name', 64)
    if (!KEY.test(key) || !PLUGIN_NAME.test(name) || !COMMIT.test(input.baseCommit) || !DIGEST.test(input.generatorDigest)
      || input.scope.length === 0 || input.scope.length > 32) throw new ControlPlaneStoreError('invalid-input', 'source plan binding is invalid')
    positiveInteger(input.ttlMs, 'ttlMs'); if (input.ttlMs < 60_000 || input.ttlMs > 86_400_000) throw new ControlPlaneStoreError('invalid-input', 'ttlMs is invalid')
    const scope = Object.freeze([...new Set(input.scope.map(value => bounded(value, 'scope', 500)))].sort())
    const requestBinding = { operation: 'create-source-plan', gapId: input.gapId, repository: input.repository,
      worktree: input.worktree, baseCommit: input.baseCommit, name, generatorDigest: input.generatorDigest, scope, ttlMs: input.ttlMs }
    const inputDigest = controlPlaneDigest(requestBinding); const prior = this.#receipt<PluginSourcePlan>(key, 'create-source-plan', inputDigest)
    if (prior !== undefined) return prior
    const gap = this.getGap(input.gapId); if (gap.status !== 'open') throw new ControlPlaneStoreError('invalid-state', 'only an open gap can create a source plan')
    const gapSnapshot = Object.freeze({ revision: gap.revision, inputDigest: gap.inputDigest, roi: gap.roi, capability: gap.capability })
    const now = this.#now(); const id = `source-${randomUUID()}`; const expiresAt = now + input.ttlMs
    const immutable = { schemaVersion: 1 as const, kind: 'source' as const, id, gapId: gap.id, gapSnapshot,
      repository: input.repository, worktree: input.worktree, baseCommit: input.baseCommit, name,
      generatorDigest: input.generatorDigest, scope, createdAt: now, expiresAt }
    const digest = controlPlaneDigest(immutable)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database.prepare('INSERT INTO gap_plan_claims (gap_id, plan_id, plan_kind, claimed_at) VALUES (?, ?, ?, ?)').run(gap.id, id, 'source', now)
      this.#database.prepare(`INSERT INTO source_plans (id, plan_digest, gap_id, gap_snapshot_json, repository, worktree,
        base_commit, plugin_name, generator_digest, scope_json, status, revision, created_at, expires_at, approval_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending-approval', 1, ?, ?, NULL, ?)`).run(id, digest, gap.id,
        JSON.stringify(gapSnapshot), input.repository, input.worktree, input.baseCommit, name, input.generatorDigest, JSON.stringify(scope), now, expiresAt, now)
      this.#database.prepare(`UPDATE capability_gaps SET status = 'matched', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`).run(now, gap.id, gap.revision)
      const plan = this.getSourcePlan(id); const receipt = { idempotencyKey: key, operation: 'create-source-plan', inputDigest, result: plan, createdAt: now }
      this.#insertReceipt(receipt); this.#database.exec('COMMIT'); return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getSourcePlan(id: string): PluginSourcePlan {
    const row = this.#database.prepare('SELECT * FROM source_plans WHERE id = ?').get(id) as unknown as SourceRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'source plan not found')
    return sourceFromRow(row)
  }

  async approve(input: { planId: string; expectedRevision: number; receipt: ApprovalReceipt; resolveAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginActivationPlan>> {
    return this.#approvePlan('activation', input) as Promise<OperationReceipt<PluginActivationPlan>>
  }

  async approveSource(input: { planId: string; expectedRevision: number; receipt: ApprovalReceipt; resolveAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginSourcePlan>> {
    return this.#approvePlan('source', input) as Promise<OperationReceipt<PluginSourcePlan>>
  }

  async #approvePlan(kind: 'activation' | 'source', input: { planId: string; expectedRevision: number; receipt: ApprovalReceipt; resolveAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginActivationPlan | PluginSourcePlan>> {
    const inputDigest = controlPlaneDigest({ operation: 'approve-plan', kind, planId: input.planId, expectedRevision: input.expectedRevision, receipt: input.receipt })
    const prior = this.#receipt<PluginActivationPlan | PluginSourcePlan>(input.idempotencyKey, 'approve-plan', inputDigest)
    if (prior !== undefined) return prior
    const plan = kind === 'activation' ? this.getPlan(input.planId) : this.getSourcePlan(input.planId)
    const verified = await input.resolveAuthority(input.receipt).verify(input.receipt, plan)
    if (plan.revision !== input.expectedRevision) throw new ControlPlaneStoreError('conflict', 'plan revision conflict')
    if (plan.status !== 'pending-approval') throw new ControlPlaneStoreError('invalid-state', 'plan is not pending approval')
    if (this.#now() > plan.expiresAt || verified.decision !== 'approved') throw new ControlPlaneStoreError(verified.decision === 'approved' ? 'expired' : 'invalid-state', 'plan approval is not currently applicable')
    const table = kind === 'activation' ? 'activation_plans' : 'source_plans'; const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database.prepare(`UPDATE ${table} SET status = 'approved', revision = revision + 1, approval_json = ?, updated_at = ?
        WHERE id = ? AND status = 'pending-approval' AND revision = ? AND plan_digest = ?`).run(JSON.stringify(verified), now, plan.id, input.expectedRevision, plan.digest)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'plan changed while approval was being applied')
      const output = kind === 'activation' ? this.getPlan(plan.id) : this.getSourcePlan(plan.id)
      const receipt = { idempotencyKey: input.idempotencyKey, operation: 'approve-plan', inputDigest, result: output, createdAt: now }
      this.#insertReceipt(receipt); this.#database.exec('COMMIT'); return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  claimActivation(input: { planId: string; expectedRevision: number; leaseMs: number }): PluginActivationPlan {
    const now = this.#now(); positiveInteger(input.leaseMs, 'leaseMs')
    if (input.leaseMs < 5_000 || input.leaseMs > 300_000) throw new ControlPlaneStoreError('invalid-input', 'leaseMs is invalid')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(input.planId) as unknown as ActivationRow | undefined
      if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
      const plan = activationFromRow(row); if (plan.revision !== input.expectedRevision) throw new ControlPlaneStoreError('conflict', 'activation plan revision conflict')
      const recoverable = plan.status === 'staging' || plan.status === 'rollback-pending' || plan.status === 'commit-pending'
      if (plan.status === 'approved') {
        if (now > plan.expiresAt) throw new ControlPlaneStoreError('expired', 'activation plan expired before its first claim')
        const targetOwner = this.#database.prepare(`SELECT id FROM activation_plans WHERE target_path = ? AND id <> ? AND status IN (
          'staging', 'awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow',
          'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending', 'rollback-pending') LIMIT 1`).get(plan.target.profilePath, plan.id)
        if (targetOwner !== undefined) throw new ControlPlaneStoreError('conflict', 'target profile already has an active activation')
      } else if (!(recoverable && Number(row.activation_lease_until ?? 0) < now)) throw new ControlPlaneStoreError('invalid-state', 'activation plan cannot be claimed')
      const activationId = row.activation_id ?? `activation-${randomUUID()}`; const status = plan.status === 'approved' ? 'staging' : plan.status
      const result = this.#database.prepare(`UPDATE activation_plans SET status = ?, revision = revision + 1, activation_id = ?,
        activation_fence = activation_fence + 1, activation_lease_until = ?, updated_at = ? WHERE id = ? AND revision = ?`).run(
        status, activationId, now + input.leaseMs, now, plan.id, input.expectedRevision)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation plan changed while being claimed')
      const claimed = this.getPlan(plan.id); this.#database.exec('COMMIT'); return claimed
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  heartbeatActivation(input: { planId: string; expectedRevision: number; fence: number; leaseMs: number }): PluginActivationPlan {
    const now = this.#now(); positiveInteger(input.leaseMs, 'leaseMs')
    const result = this.#database.prepare(`UPDATE activation_plans SET activation_lease_until = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND activation_fence = ? AND status IN ('staging', 'rollback-pending', 'commit-pending') AND activation_lease_until >= ?`).run(
      now + input.leaseMs, now, input.planId, input.expectedRevision, input.fence, now)
    if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation heartbeat lost its revision/fence/lease')
    return this.getPlan(input.planId)
  }

  recordActivationTargetBaseline(input: { planId: string; expectedRevision: number; fence: number; existed: boolean }): PluginActivationPlan {
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(input.planId) as unknown as ActivationRow | undefined
      if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
      const plan = activationFromRow(row)
      if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.fence || plan.status !== 'staging'
        || Number(row.activation_lease_until ?? 0) < now) throw new ControlPlaneStoreError('conflict', 'activation lost its claim before recording the target baseline')
      if (row.activation_target_existed !== null && (row.activation_target_existed === 1) !== input.existed) {
        throw new ControlPlaneStoreError('conflict', 'activation target baseline is immutable')
      }
      if (row.activation_target_existed === null) {
        this.#database.prepare(`UPDATE activation_plans SET activation_target_existed = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND activation_fence = ? AND activation_target_existed IS NULL`).run(
          input.existed ? 1 : 0, now, plan.id, plan.revision, input.fence)
      }
      const result = this.getPlan(plan.id)
      this.#database.exec('COMMIT')
      return result
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  /**
   * Hold SQLite's cross-process write lock for the complete command or
   * destructive filesystem operation. A lease timeout is therefore never a
   * licence for another worker to mutate the profile while this callback is
   * still running: its claim must first acquire the same kernel-backed DB lock.
   */
  async withActivationFileSystemGuard<T>(input: { planId: string; expectedRevision: number; fence: number;
    status: PlanStatus; leaseMs: number }, action: () => Promise<T>): Promise<T> {
    positiveInteger(input.leaseMs, 'leaseMs')
    try { this.#database.exec('BEGIN IMMEDIATE') } catch { throw new ControlPlaneStoreError('conflict', 'activation filesystem mutex is held') }
    try {
      const assertOwner = (requireLiveLease: boolean): ActivationRow => {
        const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(input.planId) as unknown as ActivationRow | undefined
        if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
        const plan = activationFromRow(row)
        if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.fence || plan.status !== input.status
          || (requireLiveLease && Number(row.activation_lease_until ?? 0) < this.#now())) throw new ControlPlaneStoreError('conflict', 'activation no longer owns the filesystem fence')
        return row
      }
      assertOwner(true)
      const started = this.#now()
      this.#database.prepare('UPDATE activation_plans SET activation_lease_until = ?, updated_at = ? WHERE id = ?').run(
        started + input.leaseMs, started, input.planId)
      const result = await action()
      assertOwner(false)
      const finished = this.#now()
      this.#database.prepare('UPDATE activation_plans SET activation_lease_until = ?, updated_at = ? WHERE id = ?').run(
        finished + input.leaseMs, finished, input.planId)
      this.#database.exec('COMMIT')
      return result
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  /** Serialize lock-file lifecycle operations even after a plan became terminal. */
  async withExclusiveWrite<T>(action: () => Promise<T>): Promise<T> {
    try { this.#database.exec('BEGIN IMMEDIATE') } catch { throw new ControlPlaneStoreError('conflict', 'control-plane mutex is held') }
    try {
      const result = await action()
      this.#database.exec('COMMIT')
      return result
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  assertActivationFence(input: { planId: string; expectedRevision: number; fence: number; statuses: readonly PlanStatus[] }): PluginActivationPlan {
    const plan = this.getPlan(input.planId)
    if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.fence || !input.statuses.includes(plan.status)) throw new ControlPlaneStoreError('conflict', 'activation no longer owns the exact revision/fence/status')
    return plan
  }

  prepareHostAttestationOperation(input: { planId: string; expectedRevision: number; expectedFence: number;
    issuer: HostAttestationRequest['issuer']; requirements: HostAttestationRequirements; receiptTtlMs: number }): HostAttestationOperation {
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const plan = this.getPlan(input.planId); const expected = expectedAttestation[plan.status]
      if (expected === undefined) throw new ControlPlaneStoreError('invalid-state', 'activation is not awaiting a Host attestation operation')
      if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.expectedFence) {
        throw new ControlPlaneStoreError('conflict', 'Host attestation operation targets a stale activation revision/fence')
      }
      if (input.requirements.kind !== expected.phase) throw new ControlPlaneStoreError('invalid-input', 'Host attestation requirements do not match the awaited phase')
      if (!Number.isSafeInteger(input.receiptTtlMs) || input.receiptTtlMs < 1_000 || input.receiptTtlMs > 300_000) {
        throw new ControlPlaneStoreError('invalid-input', 'Host attestation receipt TTL is invalid')
      }
      if (expected.phase === 'reload') {
        const previous = this.#database.prepare(`SELECT max(attestation.host_generation) AS generation
          FROM host_attestations AS attestation JOIN activation_plans AS activation ON activation.id = attestation.plan_id
          WHERE activation.installation_id = ?`).get(plan.installationId) as { generation: number | null }
        if (input.requirements.kind !== 'reload' || input.requirements.previousHostGeneration !== (previous.generation ?? 0)) {
          throw new ControlPlaneStoreError('conflict', 'reload operation does not bind the durable prior Host generation')
        }
      }
      const operationId = `host-operation-${randomUUID()}`
      const request: HostAttestationRequest = { schemaVersion: 1, kind: 'dsh-host-attestation-request', operationId,
        requestedAt: now, receiptTtlMs: input.receiptTtlMs, installationId: plan.installationId, ledger: plan.ledger, plan: { id: plan.id, digest: plan.digest },
        activation: { id: plan.activation.id, fence: plan.activation.fence }, profile: { name: plan.profile, path: plan.target.profilePath },
        issuer: input.issuer, phase: expected.phase, requirements: input.requirements }
      const bindingDigest = controlPlaneDigest(requestBinding(request))
      const priorRow = this.#database.prepare('SELECT * FROM host_attestation_operations WHERE plan_id = ? AND phase = ?')
        .get(plan.id, expected.phase) as unknown as HostAttestationOperationRow | undefined
      if (priorRow !== undefined) {
        const prior = hostOperationFromRow(priorRow)
        if (prior.bindingDigest !== bindingDigest) throw new ControlPlaneStoreError('conflict', 'durable Host operation payload changed for the same phase')
        this.#database.exec('COMMIT')
        return prior
      }
      this.#database.prepare(`INSERT INTO host_attestation_operations (plan_id, phase, operation_id, binding_digest,
        request_digest, request_json, status, receipt_digest, receipt_json, created_at, completed_at, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)`).run(plan.id, expected.phase, operationId,
        bindingDigest, controlPlaneDigest(request), JSON.stringify(request), now)
      const operation = this.getHostAttestationOperation(operationId)
      this.#database.exec('COMMIT')
      return operation
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getHostAttestationOperation(operationId: string): HostAttestationOperation {
    const row = this.#database.prepare('SELECT * FROM host_attestation_operations WHERE operation_id = ?').get(operationId) as unknown as HostAttestationOperationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'Host attestation operation not found')
    return hostOperationFromRow(row)
  }

  latestHostGeneration(installationId: string): number {
    if (!UUID.test(installationId)) throw new ControlPlaneStoreError('invalid-input', 'installation id is invalid')
    const row = this.#database.prepare(`SELECT max(attestation.host_generation) AS generation
      FROM host_attestations AS attestation JOIN activation_plans AS activation ON activation.id = attestation.plan_id
      WHERE activation.installation_id = ?`).get(installationId) as { generation: number | null }
    return row.generation ?? 0
  }

  /**
   * Keep the SQLite writer mutex for the complete external attestor call. The
   * operation id was committed before this method, so process death retries the
   * same request while concurrent workers cannot cause a second canary call.
   */
  async runHostAttestationOperation(input: { operationId: string; expectedRevision: number; expectedFence: number;
    execute: (request: HostAttestationRequest) => Promise<HostAttestationReceipt>;
    resolveAuthority: (receipt: HostAttestationReceipt) => HostAttestationAuthority }): Promise<HostAttestationReceipt> {
    try { this.#database.exec('BEGIN IMMEDIATE') } catch { throw new ControlPlaneStoreError('conflict', 'Host attestation single-flight is held') }
    try {
      const operation = this.getHostAttestationOperation(input.operationId)
      const plan = this.getPlan(operation.planId); const expected = expectedAttestation[plan.status]
      if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.expectedFence
        || expected?.phase !== operation.phase || operation.requestDigest !== controlPlaneDigest(operation.request)) {
        throw new ControlPlaneStoreError('conflict', 'Host attestation operation lost its plan revision/fence/phase')
      }
      if (operation.receipt !== undefined) { this.#database.exec('COMMIT'); return operation.receipt }
      const receipt = await input.execute(operation.request)
      await input.resolveAuthority(receipt).verify(receipt, plan, operation.request)
      const now = this.#now()
      const result = this.#database.prepare(`UPDATE host_attestation_operations SET status = 'completed', receipt_digest = ?,
        receipt_json = ?, completed_at = ? WHERE operation_id = ? AND status = 'pending' AND request_digest = ?`).run(
        controlPlaneDigest(receipt), JSON.stringify(receipt), now, operation.operationId, operation.requestDigest)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'Host attestation operation completion lost its single-flight')
      this.#database.exec('COMMIT')
      return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  advanceActivation(input: { planId: string; expectedRevision: number; fence: number; from: PlanStatus; to: PlanStatus; failureCode?: string }): PluginActivationPlan {
    const allowed: Record<string, readonly PlanStatus[]> = { staging: ['awaiting-reload', 'rollback-pending'],
      'rollback-pending': ['rolled-back'], 'commit-pending': ['activated', 'rollback-pending'] }
    if (!allowed[input.from]?.includes(input.to)) throw new ControlPlaneStoreError('invalid-input', 'invalid activation transition')
    const now = this.#now(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database.prepare(`UPDATE activation_plans SET status = ?, revision = revision + 1,
        activation_lease_until = NULL, failure_code = COALESCE(?, failure_code), updated_at = ?
        WHERE id = ? AND revision = ? AND activation_fence = ? AND status = ? AND activation_lease_until >= ?`).run(
        input.to, input.failureCode ?? null, now, input.planId, input.expectedRevision, input.fence, input.from, now)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation transition lost its CAS/fencing claim')
      const plan = this.getPlan(input.planId)
      if (input.to === 'rolled-back' || input.to === 'activated') {
        if (input.to === 'activated') this.#database.prepare(`UPDATE capability_gaps SET status = 'closed', revision = revision + 1, updated_at = ? WHERE id = ?`).run(now, plan.gapId)
        this.#finishActivation(plan, input.fence, now)
      }
      this.#database.exec('COMMIT'); return plan
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  async applyHostAttestation(input: { planId: string; expectedRevision: number; expectedFence: number; receipt: HostAttestationReceipt;
    resolveAuthority: (receipt: HostAttestationReceipt) => HostAttestationAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginActivationPlan>> {
    const inputDigest = controlPlaneDigest({ operation: 'host-attestation', planId: input.planId,
      expectedRevision: input.expectedRevision, expectedFence: input.expectedFence, receipt: input.receipt })
    const replay = this.#receipt<PluginActivationPlan>(input.idempotencyKey, 'host-attestation', inputDigest)
    if (replay !== undefined) return replay
    const plan = this.getPlan(input.planId); const expected = expectedAttestation[plan.status]
    if (expected === undefined) throw new ControlPlaneStoreError('invalid-state', 'activation is not awaiting a host attestation')
    if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.expectedFence) throw new ControlPlaneStoreError('conflict', 'host attestation targets a stale activation revision/fence')
    const operation = this.getHostAttestationOperation(input.receipt.operationId)
    if (operation.planId !== plan.id || operation.phase !== expected.phase || operation.status !== 'completed'
      || operation.receipt === undefined || controlPlaneDigest(operation.receipt) !== controlPlaneDigest(input.receipt)) {
      throw new ControlPlaneStoreError('conflict', 'Host attestation was not completed by the durable phase operation')
    }
    const verified = await input.resolveAuthority(input.receipt).verify(input.receipt, plan, operation.request)
    const now = this.#now(); const nextStatus: PlanStatus = verified.outcome === 'passed' ? expected.next : 'rollback-pending'
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const previousGeneration = this.#database.prepare(`SELECT max(attestation.host_generation) AS generation
        FROM host_attestations AS attestation JOIN activation_plans AS activation ON activation.id = attestation.plan_id
        WHERE activation.installation_id = ?`).get(plan.installationId) as { generation: number | null }
      if (previousGeneration.generation !== null && verified.hostGeneration < previousGeneration.generation) throw new ControlPlaneStoreError('conflict', 'host generation regressed')
      this.#database.prepare(`INSERT INTO host_attestations (plan_id, phase, receipt_id, receipt_digest, receipt_json, host_generation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(plan.id, verified.phase, verified.receiptId, controlPlaneDigest(input.receipt), JSON.stringify(verified), verified.hostGeneration, now)
      const result = this.#database.prepare(`UPDATE activation_plans SET status = ?, revision = revision + 1,
        failure_code = CASE WHEN ? = 'rollback-pending' THEN 'host-attestation-failed' ELSE failure_code END, updated_at = ?
        WHERE id = ? AND status = ? AND revision = ? AND activation_fence = ?`).run(nextStatus, nextStatus, now, plan.id, plan.status, plan.revision, input.expectedFence)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'host attestation lost its plan CAS')
      const applied = this.#database.prepare(`UPDATE host_attestation_operations SET status = 'applied', applied_at = ?
        WHERE operation_id = ? AND status = 'completed' AND receipt_digest = ?`).run(now, operation.operationId, controlPlaneDigest(input.receipt))
      if (Number(applied.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'Host attestation operation lost its apply CAS')
      const output = this.getPlan(plan.id)
      const operationReceipt = { idempotencyKey: input.idempotencyKey, operation: 'host-attestation', inputDigest, result: output, createdAt: now }
      this.#insertReceipt(operationReceipt); this.#database.exec('COMMIT'); return operationReceipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  #finishActivation(plan: PluginActivationPlan, fence: number, now: number): void {
    const activationId = plan.activation?.id
    if (activationId === undefined) throw new ControlPlaneStoreError('invalid-state', 'terminal activation has no identity')
    const inputDigest = controlPlaneDigest({ planId: plan.id, planDigest: plan.digest, activationId, fence, status: plan.status, failureCode: plan.activation?.failureCode })
    this.#insertReceipt({ idempotencyKey: `activation:${activationId}`, operation: 'activate-plan', inputDigest, result: plan, createdAt: now })
    if (plan.status === 'rolled-back') {
      this.#database.prepare('DELETE FROM gap_plan_claims WHERE gap_id = ? AND plan_id = ?').run(plan.gapId, plan.id)
      this.#database.prepare(`UPDATE capability_gaps SET status = 'open', candidate_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`).run(now, plan.gapId)
    }
  }

  beginSourceChecks(input: { planId: string; expectedRevision: number }): PluginSourcePlan {
    const now = this.#now()
    const result = this.#database.prepare(`UPDATE source_plans SET status = 'running-local-checks', revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND status = 'approved'`).run(now, input.planId, input.expectedRevision)
    if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source plan changed before local checks')
    return this.getSourcePlan(input.planId)
  }

  finishSourceChecks(input: { planId: string; expectedRevision: number; succeeded: boolean }): PluginSourcePlan {
    const now = this.#now(); const status = input.succeeded ? 'ready-for-human-review' : 'local-checks-failed'
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database.prepare(`UPDATE source_plans SET status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'running-local-checks'`).run(status, now, input.planId, input.expectedRevision)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source plan changed while local checks ran')
      const output = this.getSourcePlan(input.planId)
      if (!input.succeeded) {
        this.#database.prepare('DELETE FROM gap_plan_claims WHERE gap_id = ? AND plan_id = ?').run(output.gapId, output.id)
        this.#database.prepare(`UPDATE capability_gaps SET status = 'open', revision = revision + 1, updated_at = ? WHERE id = ?`).run(now, output.gapId)
      }
      const digest = controlPlaneDigest({ planId: output.id, planDigest: output.digest, status })
      this.#insertReceipt({ idempotencyKey: `source-checks:${output.id}`, operation: 'source-local-checks', inputDigest: digest, result: output, createdAt: now })
      this.#database.exec('COMMIT'); return output
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  health(): PluginControlPlaneHealth {
    const row = this.#database.prepare(`SELECT
      (SELECT count(*) FROM capability_gaps WHERE status = 'open') AS gaps,
      (SELECT count(*) FROM activation_plans WHERE status = 'approved') + (SELECT count(*) FROM source_plans WHERE status = 'approved') AS ready_plans,
      (SELECT count(*) FROM activation_plans WHERE status IN ('staging', 'awaiting-reload', 'awaiting-readiness',
        'awaiting-effect-blocked-replay', 'awaiting-shadow', 'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending')) AS active_activations,
      (SELECT count(*) FROM activation_plans WHERE status = 'rolled-back') + (SELECT count(*) FROM source_plans WHERE status = 'local-checks-failed') AS failed,
      (SELECT count(*) FROM activation_plans WHERE status = 'rollback-pending') AS rollback_pending`).get() as {
        gaps: number; ready_plans: number; active_activations: number; failed: number; rollback_pending: number
      }
    return { gaps: row.gaps, readyPlans: row.ready_plans, activeActivations: row.active_activations, failed: row.failed, rollbackPending: row.rollback_pending }
  }

  #receipt<T>(idempotencyKey: string, operation: string, inputDigest: string): OperationReceipt<T> | undefined {
    const row = this.#database.prepare('SELECT * FROM operation_receipts WHERE idempotency_key = ?').get(idempotencyKey) as { operation: string; input_digest: string; result_json: string; created_at: number } | undefined
    if (row === undefined) return undefined
    if (row.operation !== operation || row.input_digest !== inputDigest) throw new ControlPlaneStoreError('conflict', 'operation idempotency key was reused with different input')
    return { idempotencyKey, operation, inputDigest, result: JSON.parse(row.result_json) as T, createdAt: row.created_at }
  }

  #insertReceipt(receipt: OperationReceipt<unknown>): void {
    this.#database.prepare('INSERT INTO operation_receipts (idempotency_key, operation, input_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(receipt.idempotencyKey, receipt.operation, receipt.inputDigest, JSON.stringify(receipt.result), receipt.createdAt)
  }
}
