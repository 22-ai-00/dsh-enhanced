import type { DatabaseSync } from 'node:sqlite'
import {
  canonicalGrowthJson,
  exactGrowthDigest,
  growthObjectDigest,
  validateWorkflowScope,
  validateWorkflowTraceEvidence,
  validateWorkflowTraceSourceAttestation,
  workflowCandidateSignature as sharedWorkflowCandidateSignature,
  workflowScopeKey,
  workflowTraceRevisionDigest as sharedWorkflowTraceRevisionDigest,
} from '@dsh-enhanced/assistant-growth-contract'
import { openGrowthExperimentsDatabase } from './sqlite.js'
import type {
  GrowthExperiment,
  GrowthExperimentHealth,
  GrowthOperationKind,
  GrowthExperimentState,
  WorkflowAutomationTemplate,
  WorkflowCandidate,
  WorkflowCandidateState,
  WorkflowCandidateSnapshot,
  WorkflowScope,
  WorkflowStepFingerprint,
  WorkflowTraceEvidence,
  WorkflowTraceProjectionReceipt,
  WorkflowTraceRevision,
  WorkflowTraceSourceAttestation,
} from './types.js'

export type GrowthExperimentsStoreErrorCode =
  | 'disposed'
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'not-found'
  | 'version-conflict'

export class GrowthExperimentsStoreError extends Error {
  constructor(readonly code: GrowthExperimentsStoreErrorCode, message: string) {
    super(message)
    this.name = 'GrowthExperimentsStoreError'
  }
}

interface TraceRevisionRow {
  scope_key: string
  source_id: 'assistantDelivery'
  source_generation: number
  source_authority_digest: string
  workspace: string
  preset: string
  subject_ref: string
  version: number
  digest: string
  disposition: WorkflowTraceRevision['disposition']
  signature: string | null
  evidence_json: string | null
  received_at: number
}

interface CurrentTraceRow {
  scope_key: string
  source_id: 'assistantDelivery'
  source_generation: number
  source_authority_digest: string
  workspace: string
  preset: string
  subject_ref: string
  version: number
  digest: string
  signature: string
  evidence_json: string
}

interface CandidateRow {
  id: string
  scope_key: string
  workspace: string
  preset: string
  owner_binding_id: string
  signature: string
  revision: number
  evidence_digest: string
  evidence_count: number
  owner_explicit_count: number
  verified_success_count: number
  template_json: string
  steps_json: string
  state: WorkflowCandidateState
  created_at: number
  updated_at: number
}

interface ExperimentRow {
  id: string
  candidate_id: string
  candidate_revision: number
  candidate_digest: string
  candidate_json: string
  state: GrowthExperimentState
  version: number
  operation_id: string
  operation_kind: GrowthOperationKind | null
  deadline_at: number
  canary_exposure_count: number
  attempt_count: number
  next_attempt_at: number
  proposal_id: string | null
  artifact_id: string | null
  artifact_version: number | null
  artifact_digest: string | null
  terminal_code: string | null
  created_at: number
  updated_at: number
}

const canonicalJson = canonicalGrowthJson
const digestObject = growthObjectDigest

const workflowCandidateSignature = sharedWorkflowCandidateSignature
const workflowTraceRevisionDigest = sharedWorkflowTraceRevisionDigest

function exactDigest(value: unknown, label: string): string {
  return exactGrowthDigest(value, label)
}

function canonicalSource(input: Readonly<WorkflowTraceSourceAttestation>): Readonly<WorkflowTraceSourceAttestation> {
  return validateWorkflowTraceSourceAttestation(input)
}

function text(value: unknown, label: string, maxBytes: number, options: { multiline?: boolean } = {}): string {
  if (typeof value !== 'string') {
    throw new GrowthExperimentsStoreError('invalid-input', `${label} must be a string`)
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new GrowthExperimentsStoreError('invalid-input', `${label} is invalid`)
  }
  for (const character of normalized) {
    const code = character.codePointAt(0)!
    if (code === 0 || code === 0x7f || (!options.multiline && code <= 0x1f)) {
      throw new GrowthExperimentsStoreError('invalid-input', `${label} contains a control character`)
    }
  }
  return normalized
}

function canonicalScope(input: Readonly<WorkflowScope>): Readonly<WorkflowScope> & { scopeKey: string } {
  const scope = validateWorkflowScope(input)
  return Object.freeze({ ...scope, scopeKey: workflowScopeKey(scope) })
}

function canonicalEvidence(input: Readonly<WorkflowTraceEvidence>): Readonly<WorkflowTraceEvidence> {
  return validateWorkflowTraceEvidence(input)
}

function candidate(row: CandidateRow): WorkflowCandidate {
  return Object.freeze({
    id: row.id,
    scope: Object.freeze({ workspace: row.workspace, preset: row.preset }),
    ownerBindingId: row.owner_binding_id,
    signature: row.signature,
    revision: row.revision,
    evidenceDigest: row.evidence_digest,
    evidenceCount: row.evidence_count,
    ownerExplicitCount: row.owner_explicit_count,
    verifiedSuccessCount: row.verified_success_count,
    template: JSON.parse(row.template_json) as WorkflowAutomationTemplate,
    steps: JSON.parse(row.steps_json) as readonly WorkflowStepFingerprint[],
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function experiment(row: ExperimentRow): GrowthExperiment {
  return Object.freeze({
    id: row.id,
    candidateId: row.candidate_id,
    candidateRevision: row.candidate_revision,
    candidateDigest: row.candidate_digest,
    candidateSnapshot: JSON.parse(row.candidate_json) as WorkflowCandidateSnapshot,
    state: row.state,
    version: row.version,
    operationId: row.operation_id,
    ...(row.operation_kind === null ? {} : { operationKind: row.operation_kind }),
    deadlineAt: row.deadline_at,
    canaryExposureCount: row.canary_exposure_count,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    ...(row.proposal_id === null ? {} : { proposalId: row.proposal_id }),
    ...(row.artifact_id === null ? {} : {
      artifactId: row.artifact_id,
      artifactVersion: row.artifact_version!,
      artifactDigest: row.artifact_digest!,
    }),
    ...(row.terminal_code === null ? {} : { terminalCode: row.terminal_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

const terminalExperimentStates = new Set<GrowthExperimentState>([
  'conflicted', 'expired', 'promoted', 'rejected', 'rolled-back',
])

export interface GrowthExperimentsStoreOptions {
  path: string
  minRepeatedSuccesses: number
  now?: () => number
}

export class GrowthExperimentsStore {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private readonly minRepeatedSuccesses: number
  private closed = false

  constructor(options: GrowthExperimentsStoreOptions) {
    if (!Number.isSafeInteger(options.minRepeatedSuccesses)
      || options.minRepeatedSuccesses < 2 || options.minRepeatedSuccesses > 100) {
      throw new GrowthExperimentsStoreError('invalid-input', 'minRepeatedSuccesses must be between 2 and 100')
    }
    this.database = openGrowthExperimentsDatabase(options.path)
    this.minRepeatedSuccesses = options.minRepeatedSuccesses
    this.now = options.now ?? Date.now
  }

  projectWorkflowTraceRevision(input: Readonly<WorkflowTraceRevision>): WorkflowTraceProjectionReceipt {
    this.assertOpen()
    const scope = canonicalScope(input.scope)
    const source = canonicalSource(input.source)
    const subjectRef = exactDigest(input.subjectRef, 'subjectRef')
    if (!Number.isSafeInteger(input.version) || input.version < 1
      || !['upsert', 'retract'].includes(input.disposition)
      || (input.disposition === 'upsert') !== (input.evidence !== undefined)) {
      throw new GrowthExperimentsStoreError('invalid-input', 'workflow trace revision is invalid')
    }
    const evidence = input.evidence === undefined ? undefined : canonicalEvidence(input.evidence)
    const expectedDigest = workflowTraceRevisionDigest({
      scope: { workspace: scope.workspace, preset: scope.preset },
      source,
      subjectRef,
      version: input.version,
      disposition: input.disposition,
      ...(evidence === undefined ? {} : { evidence }),
    })
    if (exactDigest(input.digest, 'digest') !== expectedDigest) {
      throw new GrowthExperimentsStoreError('idempotency-conflict', 'workflow trace digest does not match its payload')
    }
    const signature = evidence === undefined
      ? undefined
      : workflowCandidateSignature({
          scope: { workspace: scope.workspace, preset: scope.preset },
          evidence,
        })
    const candidateIds: string[] = []
    let outcome: WorkflowTraceProjectionReceipt['outcome'] = 'applied'
    this.transaction(() => {
      const exact = this.database.prepare(`
        SELECT * FROM workflow_trace_revisions
        WHERE scope_key = ? AND subject_ref = ? AND version = ?
      `).get(scope.scopeKey, subjectRef, input.version) as unknown as TraceRevisionRow | undefined
      if (exact !== undefined) {
        if (exact.digest !== expectedDigest || exact.disposition !== input.disposition) {
          throw new GrowthExperimentsStoreError(
            'idempotency-conflict',
            'workflow trace version already exists with different content',
          )
        }
        const previous = this.database.prepare(`
          SELECT signature FROM workflow_trace_revisions
          WHERE scope_key = ? AND subject_ref = ? AND version < ?
          ORDER BY version DESC LIMIT 1
        `).get(scope.scopeKey, subjectRef, input.version) as { signature: string | null } | undefined
        const signatures = new Set<string>()
        if (previous?.signature !== null && previous?.signature !== undefined) signatures.add(previous.signature)
        if (exact.signature !== null) signatures.add(exact.signature)
        for (const replaySignature of signatures) {
          candidateIds.push(this.candidateId(scope.scopeKey, replaySignature))
        }
        outcome = 'replayed'
        return
      }
      const latest = this.database.prepare(`
        SELECT version FROM workflow_trace_revisions
        WHERE scope_key = ? AND subject_ref = ? ORDER BY version DESC LIMIT 1
      `).get(scope.scopeKey, subjectRef) as { version: number } | undefined
      if (latest !== undefined && input.version < latest.version) {
        throw new GrowthExperimentsStoreError(
          'version-conflict',
          'workflow trace source version moved backwards',
        )
      }
      const current = this.database.prepare(`
        SELECT * FROM workflow_trace_current WHERE scope_key = ? AND subject_ref = ?
      `).get(scope.scopeKey, subjectRef) as unknown as CurrentTraceRow | undefined
      this.database.prepare(`
        INSERT INTO workflow_trace_revisions(
          scope_key, source_id, source_generation, source_authority_digest,
          workspace, preset, subject_ref, version, digest, disposition,
          signature, evidence_json, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scope.scopeKey, source.sourceId, source.generation, source.authorityDigest,
        scope.workspace, scope.preset, subjectRef, input.version,
        expectedDigest, input.disposition, signature ?? null,
        evidence === undefined ? null : canonicalJson(evidence), this.now(),
      )
      if (evidence === undefined || signature === undefined) {
        this.database.prepare(`
          DELETE FROM workflow_trace_current WHERE scope_key = ? AND subject_ref = ?
        `).run(scope.scopeKey, subjectRef)
      } else {
        this.database.prepare(`
          INSERT INTO workflow_trace_current(
            scope_key, source_id, source_generation, source_authority_digest,
            workspace, preset, subject_ref, version, digest, signature, evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope_key, subject_ref) DO UPDATE SET
            source_id = excluded.source_id, source_generation = excluded.source_generation,
            source_authority_digest = excluded.source_authority_digest,
            workspace = excluded.workspace, preset = excluded.preset, version = excluded.version,
            digest = excluded.digest, signature = excluded.signature, evidence_json = excluded.evidence_json
        `).run(
          scope.scopeKey, source.sourceId, source.generation, source.authorityDigest,
          scope.workspace, scope.preset, subjectRef, input.version,
          expectedDigest, signature, canonicalJson(evidence),
        )
      }
      const changed = new Set<string>()
      if (current !== undefined) changed.add(current.signature)
      if (signature !== undefined) changed.add(signature)
      for (const changedSignature of [...changed].sort()) {
        candidateIds.push(this.recomputeCandidate(scope, changedSignature))
      }
    })
    return Object.freeze({
      contractVersion: 1,
      scope: Object.freeze({ workspace: scope.workspace, preset: scope.preset }),
      subjectRef,
      version: input.version,
      disposition: input.disposition,
      digest: expectedDigest,
      source,
      outcome,
      candidateIds: Object.freeze(candidateIds.sort()),
    })
  }

  getCandidate(id: string): WorkflowCandidate | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT * FROM workflow_candidates WHERE id = ?')
      .get(id) as unknown as CandidateRow | undefined
    return row === undefined ? undefined : candidate(row)
  }

  listCandidates(input: { state?: WorkflowCandidateState; limit?: number } = {}): WorkflowCandidate[] {
    this.assertOpen()
    const limit = input.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new GrowthExperimentsStoreError('invalid-input', 'candidate limit is invalid')
    }
    const rows = input.state === undefined
      ? this.database.prepare('SELECT * FROM workflow_candidates ORDER BY updated_at, id LIMIT ?').all(limit)
      : this.database.prepare(`
          SELECT * FROM workflow_candidates WHERE state = ? ORDER BY updated_at, id LIMIT ?
        `).all(input.state, limit)
    return (rows as unknown as CandidateRow[]).map(candidate)
  }

  beginReadyExperiment(input: { candidateId: string; maxDurationMs: number }): GrowthExperiment {
    this.assertOpen()
    if (!Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1_000
      || input.maxDurationMs > 31_536_000_000) {
      throw new GrowthExperimentsStoreError('invalid-input', 'experiment duration is invalid')
    }
    let output: GrowthExperiment | undefined
    this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM workflow_candidates WHERE id = ?')
        .get(input.candidateId) as unknown as CandidateRow | undefined
      if (row === undefined) throw new GrowthExperimentsStoreError('not-found', 'workflow candidate was not found')
      const candidateValue = candidate(row)
      const id = `growth_${digestObject([
        'assistant-growth-experiment/v1', candidateValue.id, candidateValue.revision, candidateValue.evidenceDigest,
      ])}`
      const existing = this.database.prepare('SELECT * FROM growth_experiments WHERE id = ?')
        .get(id) as unknown as ExperimentRow | undefined
      if (existing !== undefined) {
        output = experiment(existing)
        return
      }
      if (candidateValue.state !== 'ready') {
        throw new GrowthExperimentsStoreError('version-conflict', 'workflow candidate is not ready')
      }
      const active = this.database.prepare(`
        SELECT id FROM growth_experiments WHERE candidate_id = ? AND state NOT IN (
          'conflicted', 'expired', 'promoted', 'rejected', 'rolled-back'
        ) LIMIT 1
      `).get(candidateValue.id) as { id: string } | undefined
      if (active !== undefined) {
        throw new GrowthExperimentsStoreError('version-conflict', 'workflow candidate already has an active experiment')
      }
      const now = this.now()
      const operationId = `${id}:approval-request`
      this.database.prepare(`
        INSERT INTO growth_experiments(
          id, candidate_id, candidate_revision, candidate_digest, candidate_json, state, version, operation_id,
          operation_kind, deadline_at, canary_exposure_count, attempt_count, next_attempt_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'approval-requesting', 1, ?, 'approval-proposal', ?, 0, 0, ?, ?, ?)
      `).run(
        id, candidateValue.id, candidateValue.revision, candidateValue.evidenceDigest,
        canonicalJson({
          id: candidateValue.id,
          scope: candidateValue.scope,
          ownerBindingId: candidateValue.ownerBindingId,
          signature: candidateValue.signature,
          revision: candidateValue.revision,
          evidenceDigest: candidateValue.evidenceDigest,
          evidenceCount: candidateValue.evidenceCount,
          ownerExplicitCount: candidateValue.ownerExplicitCount,
          verifiedSuccessCount: candidateValue.verifiedSuccessCount,
          template: candidateValue.template,
          steps: candidateValue.steps,
        }), operationId, now + input.maxDurationMs, now, now, now,
      )
      this.database.prepare(`
        UPDATE workflow_candidates SET state = 'running', updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'ready'
      `).run(now, candidateValue.id, candidateValue.revision)
      output = experiment(this.database.prepare('SELECT * FROM growth_experiments WHERE id = ?')
        .get(id) as unknown as ExperimentRow)
    })
    return output!
  }

  getExperiment(id: string): GrowthExperiment | undefined {
    this.assertOpen()
    const row = this.database.prepare('SELECT * FROM growth_experiments WHERE id = ?')
      .get(id) as unknown as ExperimentRow | undefined
    return row === undefined ? undefined : experiment(row)
  }

  listActiveExperiments(limit = 100): GrowthExperiment[] {
    this.assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new GrowthExperimentsStoreError('invalid-input', 'experiment limit is invalid')
    }
    const rows = this.database.prepare(`
      SELECT * FROM growth_experiments WHERE state NOT IN (
        'conflicted', 'expired', 'promoted', 'rejected', 'rolled-back'
      ) ORDER BY updated_at, id LIMIT ?
    `).all(limit) as unknown as ExperimentRow[]
    return rows.map(experiment)
  }

  listRunnableExperiments(now: number, limit = 100): GrowthExperiment[] {
    this.assertOpen()
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new GrowthExperimentsStoreError('invalid-input', 'runnable experiment query is invalid')
    }
    const rows = this.database.prepare(`
      SELECT * FROM growth_experiments WHERE state NOT IN (
        'conflicted', 'expired', 'promoted', 'rejected', 'rolled-back'
      ) AND next_attempt_at <= ? ORDER BY next_attempt_at, updated_at, id LIMIT ?
    `).all(now, limit) as unknown as ExperimentRow[]
    return rows.map(experiment)
  }

  transitionExperiment(input: {
    experimentId: string
    expectedVersion: number
    expectedState: GrowthExperimentState
    state: GrowthExperimentState
    operationKind?: GrowthOperationKind
    operationId?: string
    proposalId?: string
    artifact?: { id: string; version: number; digest: string }
    canaryExposureCount?: number
    terminalCode?: string
    nextAttemptAt?: number
    preserveAttempts?: boolean
  }): GrowthExperiment {
    this.assertOpen()
    const id = text(input.experimentId, 'experimentId', 200)
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new GrowthExperimentsStoreError('invalid-input', 'experiment version is invalid')
    }
    let output: GrowthExperiment | undefined
    this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM growth_experiments WHERE id = ?')
        .get(id) as unknown as ExperimentRow | undefined
      if (row === undefined) throw new GrowthExperimentsStoreError('not-found', 'growth experiment was not found')
      if (row.version !== input.expectedVersion || row.state !== input.expectedState) {
        throw new GrowthExperimentsStoreError('version-conflict', 'growth experiment state changed')
      }
      const allowedTransitions: Readonly<Record<GrowthExperimentState, readonly GrowthExperimentState[]>> = {
        'approval-requesting': ['approval-requesting', 'approval-pending', 'conflicted', 'expired', 'rejected',
          'replay-pending', 'rollback-pending'],
        'approval-pending': ['approval-requesting', 'conflicted', 'expired'],
        'replay-pending': ['conflicted', 'shadow-pending', 'rollback-pending'],
        'shadow-pending': ['conflicted', 'canary-pending', 'rollback-pending'],
        'canary-pending': ['conflicted', 'canary-pending', 'promotion-pending', 'rollback-pending'],
        'promotion-pending': ['conflicted', 'promoted', 'rollback-pending'],
        'rollback-pending': ['rolled-back'],
        conflicted: [], expired: [], promoted: [], rejected: [], 'rolled-back': [],
      }
      if (!allowedTransitions[row.state].includes(input.state)) {
        throw new GrowthExperimentsStoreError('version-conflict', 'growth experiment transition is forbidden')
      }
      const proposalId = input.proposalId === undefined
        ? row.proposal_id
        : text(input.proposalId, 'proposalId', 200)
      const artifactId = input.artifact === undefined
        ? row.artifact_id
        : text(input.artifact.id, 'artifactId', 200)
      const artifactVersion = input.artifact === undefined ? row.artifact_version : input.artifact.version
      const artifactDigest = input.artifact === undefined
        ? row.artifact_digest
        : exactDigest(input.artifact.digest, 'artifactDigest')
      if (artifactVersion !== null
        && (!Number.isSafeInteger(artifactVersion) || artifactVersion < 1)) {
        throw new GrowthExperimentsStoreError('invalid-input', 'artifact version is invalid')
      }
      const exposure = input.canaryExposureCount ?? row.canary_exposure_count
      if (!Number.isSafeInteger(exposure) || exposure < row.canary_exposure_count || exposure > 1) {
        throw new GrowthExperimentsStoreError('version-conflict', 'canary exposure count is invalid')
      }
      const terminalCode = input.terminalCode === undefined
        ? row.terminal_code
        : text(input.terminalCode, 'terminalCode', 200)
      const version = row.version + 1
      const operationKind = input.operationKind ?? null
      const terminal = terminalExperimentStates.has(input.state)
      if ((input.state === 'approval-pending' || terminal) !== (operationKind === null)) {
        throw new GrowthExperimentsStoreError('invalid-input', 'experiment operation intent is invalid')
      }
      const expectedKind: Partial<Record<GrowthExperimentState, GrowthOperationKind>> = {
        'replay-pending': 'replay', 'shadow-pending': 'shadow', 'canary-pending': 'canary',
        'promotion-pending': 'promotion', 'rollback-pending': 'rollback',
      }
      if (input.state === 'approval-requesting') {
        if (operationKind !== 'approval-proposal' && operationKind !== 'approval-settlement') {
          throw new GrowthExperimentsStoreError('invalid-input', 'approval operation intent is invalid')
        }
      } else if (input.state === 'canary-pending') {
        if (operationKind !== 'canary' && operationKind !== 'canary-inspection') {
          throw new GrowthExperimentsStoreError('invalid-input', 'canary operation intent is invalid')
        }
      } else if (expectedKind[input.state] !== undefined && expectedKind[input.state] !== operationKind) {
        throw new GrowthExperimentsStoreError('invalid-input', 'experiment operation intent does not match state')
      }
      const operationId = input.operationId ?? `${row.id}:${operationKind ?? input.state}`
      const now = this.now()
      const nextAttemptAt = input.nextAttemptAt ?? now
      if (!Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0) {
        throw new GrowthExperimentsStoreError('invalid-input', 'next attempt time is invalid')
      }
      const updated = this.database.prepare(`
        UPDATE growth_experiments SET
          state = ?, version = ?, operation_id = ?, operation_kind = ?, proposal_id = ?, artifact_id = ?,
          artifact_version = ?, artifact_digest = ?, canary_exposure_count = ?, terminal_code = ?,
          attempt_count = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND version = ? AND state = ?
      `).run(
        input.state, version, operationId, operationKind, proposalId, artifactId, artifactVersion,
        artifactDigest, exposure, terminalCode, input.preserveAttempts === true ? row.attempt_count : 0,
        nextAttemptAt, now, row.id, row.version, row.state,
      )
      if (updated.changes !== 1) {
        throw new GrowthExperimentsStoreError('version-conflict', 'growth experiment transition lost its fence')
      }
      if (terminalExperimentStates.has(input.state)) {
        const candidateState: WorkflowCandidateState = input.state === 'promoted'
          ? 'promoted'
          : input.state === 'rejected' || input.state === 'expired'
            ? 'rejected'
            : input.state === 'rolled-back'
              ? 'rolled-back'
              : 'conflicted'
        this.database.prepare(`
          UPDATE workflow_candidates SET state = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND evidence_digest = ? AND state = 'running'
        `).run(candidateState, now, row.candidate_id, row.candidate_revision, row.candidate_digest)
      }
      output = experiment(this.database.prepare('SELECT * FROM growth_experiments WHERE id = ?')
        .get(row.id) as unknown as ExperimentRow)
    })
    return output!
  }

  markCanaryIssued(input: { experimentId: string; expectedVersion: number }): GrowthExperiment {
    const current = this.getExperiment(input.experimentId)
    if (current === undefined) throw new GrowthExperimentsStoreError('not-found', 'growth experiment was not found')
    if (current.version !== input.expectedVersion || current.state !== 'canary-pending'
      || (current.operationKind !== 'canary' && current.operationKind !== 'canary-inspection')) {
      throw new GrowthExperimentsStoreError('version-conflict', 'canary intent changed')
    }
    if (current.canaryExposureCount === 1) return current
    return this.transitionExperiment({
      experimentId: current.id, expectedVersion: current.version, expectedState: current.state,
      state: 'canary-pending', operationKind: 'canary', operationId: current.operationId,
      canaryExposureCount: 1, preserveAttempts: true,
    })
  }

  recordOperationFailure(input: {
    experimentId: string
    expectedVersion: number
    code: string
    nextAttemptAt: number
  }): GrowthExperiment {
    this.assertOpen()
    const code = text(input.code, 'operation failure code', 200)
    if (!Number.isSafeInteger(input.nextAttemptAt) || input.nextAttemptAt < 0) {
      throw new GrowthExperimentsStoreError('invalid-input', 'next attempt time is invalid')
    }
    const row = this.database.prepare('SELECT * FROM growth_experiments WHERE id = ?')
      .get(input.experimentId) as unknown as ExperimentRow | undefined
    if (row === undefined) throw new GrowthExperimentsStoreError('not-found', 'growth experiment was not found')
    if (row.version !== input.expectedVersion || terminalExperimentStates.has(row.state)) {
      throw new GrowthExperimentsStoreError('version-conflict', 'growth experiment state changed')
    }
    const now = this.now()
    const updated = this.database.prepare(`
      UPDATE growth_experiments SET version = version + 1, attempt_count = attempt_count + 1,
        next_attempt_at = ?, terminal_code = ?, updated_at = ? WHERE id = ? AND version = ?
    `).run(input.nextAttemptAt, code, now, row.id, row.version)
    if (updated.changes !== 1) throw new GrowthExperimentsStoreError('version-conflict', 'operation failure lost its fence')
    return experiment(this.database.prepare('SELECT * FROM growth_experiments WHERE id = ?')
      .get(row.id) as unknown as ExperimentRow)
  }

  requestRollback(input: { experimentId: string; expectedVersion: number; code: string }): GrowthExperiment {
    const current = this.getExperiment(input.experimentId)
    if (current === undefined) throw new GrowthExperimentsStoreError('not-found', 'growth experiment was not found')
    if (current.version !== input.expectedVersion) {
      throw new GrowthExperimentsStoreError('version-conflict', 'growth experiment state changed')
    }
    if (terminalExperimentStates.has(current.state) || current.state === 'rollback-pending') return current
    if (current.artifactId === undefined && current.state === 'approval-requesting') {
      return this.transitionExperiment({
        experimentId: current.id, expectedVersion: current.version, expectedState: current.state,
        state: current.state, operationKind: current.operationKind!, operationId: current.operationId,
        terminalCode: input.code, preserveAttempts: true,
      })
    }
    return this.transitionExperiment({
      experimentId: current.id,
      expectedVersion: current.version,
      expectedState: current.state,
      state: current.artifactId === undefined ? 'conflicted' : 'rollback-pending',
      ...(current.artifactId === undefined ? {} : {
        operationKind: 'rollback' as const,
        operationId: `${current.id}:rollback`,
      }),
      terminalCode: input.code,
    })
  }

  recordError(code: string | undefined): void {
    this.assertOpen()
    this.database.prepare(`
      UPDATE growth_runtime_state SET last_error_code = ?, updated_at = ? WHERE singleton = 1
    `).run(code === undefined ? null : text(code, 'error code', 200), this.now())
  }

  health(): GrowthExperimentHealth {
    this.assertOpen()
    const scalar = (sql: string): number => (this.database.prepare(sql).get() as { count: number }).count
    const runtime = this.database.prepare('SELECT last_error_code FROM growth_runtime_state WHERE singleton = 1')
      .get() as { last_error_code: string | null }
    return Object.freeze({
      candidates: scalar('SELECT COUNT(*) AS count FROM workflow_candidates'),
      readyCandidates: scalar("SELECT COUNT(*) AS count FROM workflow_candidates WHERE state = 'ready'"),
      activeExperiments: scalar(`SELECT COUNT(*) AS count FROM growth_experiments WHERE state NOT IN (
        'conflicted', 'expired', 'promoted', 'rejected', 'rolled-back')`),
      rollbackPending: scalar("SELECT COUNT(*) AS count FROM growth_experiments WHERE state = 'rollback-pending'"),
      promoted: scalar("SELECT COUNT(*) AS count FROM growth_experiments WHERE state = 'promoted'"),
      traceRevisions: scalar('SELECT COUNT(*) AS count FROM workflow_trace_revisions'),
      currentTraces: scalar('SELECT COUNT(*) AS count FROM workflow_trace_current'),
      exhaustedRollbacks: scalar(`SELECT COUNT(*) AS count FROM growth_experiments
        WHERE state = 'rollback-pending' AND terminal_code = 'rollback-retry-budget-exhausted'`),
      ...(runtime.last_error_code === null ? {} : { lastErrorCode: runtime.last_error_code }),
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private recomputeCandidate(
    scope: Readonly<WorkflowScope> & { scopeKey: string },
    signature: string,
  ): string {
    const rows = this.database.prepare(`
      SELECT * FROM workflow_trace_current
      WHERE scope_key = ? AND signature = ? ORDER BY subject_ref
    `).all(scope.scopeKey, signature) as unknown as CurrentTraceRow[]
    const id = this.candidateId(scope.scopeKey, signature)
    const existing = this.database.prepare('SELECT * FROM workflow_candidates WHERE id = ?')
      .get(id) as unknown as CandidateRow | undefined
    const now = this.now()
    if (rows.length === 0) {
      if (existing !== undefined && existing.state !== 'retracted') {
        this.invalidateCandidateExperiments(existing, now)
        this.database.prepare(`
          UPDATE workflow_candidates SET revision = revision + 1, evidence_digest = ?,
            evidence_count = 0, owner_explicit_count = 0, verified_success_count = 0,
            state = 'retracted', updated_at = ? WHERE id = ?
        `).run(digestObject(['workflow-evidence/v1', []]), now, id)
      }
      return id
    }
    const parsed = rows.map(row => ({ row, evidence: canonicalEvidence(JSON.parse(row.evidence_json) as WorkflowTraceEvidence) }))
    const evidenceDigest = digestObject({
      contract: 'assistant-growth-evidence-window/v1',
      rows: parsed.map(({ row }) => ({
        subjectRef: row.subject_ref,
        version: row.version,
        digest: row.digest,
      })),
    })
    if (existing?.evidence_digest === evidenceDigest) return id
    const first = parsed[0]!.evidence
    for (const entry of parsed) {
      if (canonicalJson(entry.evidence.template) !== canonicalJson(first.template)
        || canonicalJson(entry.evidence.steps) !== canonicalJson(first.steps)
        || entry.evidence.ownerBindingId !== first.ownerBindingId) {
        throw new GrowthExperimentsStoreError(
          'idempotency-conflict',
          'workflow signature collision contains different canonical traces',
        )
      }
    }
    const ownerExplicitCount = parsed.filter(entry => entry.evidence.signal === 'owner-explicit').length
    const trustedTaskEvidence = new Map<string, string>()
    for (const entry of parsed) {
      if (entry.evidence.signal !== 'verified-repetition' || entry.evidence.objectiveStatus !== 'achieved') continue
      const taskEvidenceDigest = entry.evidence.taskEvidenceDigest!
      const previous = trustedTaskEvidence.get(entry.evidence.taskRef)
      if (previous !== undefined && previous !== taskEvidenceDigest) {
        throw new GrowthExperimentsStoreError(
          'idempotency-conflict',
          'one trusted task reference has conflicting evaluation evidence',
        )
      }
      trustedTaskEvidence.set(entry.evidence.taskRef, taskEvidenceDigest)
    }
    const verifiedSuccessCount = trustedTaskEvidence.size
    const ready = ownerExplicitCount > 0 || verifiedSuccessCount >= this.minRepeatedSuccesses
    const state: WorkflowCandidateState = ready ? 'ready' : 'observing'
    if (existing === undefined) {
      this.database.prepare(`
        INSERT INTO workflow_candidates(
          id, scope_key, workspace, preset, owner_binding_id, signature, revision, evidence_digest, evidence_count,
          owner_explicit_count, verified_success_count, template_json, steps_json, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, scope.scopeKey, scope.workspace, scope.preset, first.ownerBindingId, signature, evidenceDigest, parsed.length,
        ownerExplicitCount, verifiedSuccessCount, canonicalJson(first.template), canonicalJson(first.steps),
        state, now, now,
      )
      return id
    }
    this.invalidateCandidateExperiments(existing, now)
    this.database.prepare(`
      UPDATE workflow_candidates SET
        revision = revision + 1, evidence_digest = ?, evidence_count = ?, owner_explicit_count = ?,
        verified_success_count = ?, owner_binding_id = ?, template_json = ?, steps_json = ?, state = ?, updated_at = ?
      WHERE id = ?
    `).run(
      evidenceDigest, parsed.length, ownerExplicitCount, verifiedSuccessCount, first.ownerBindingId,
      canonicalJson(first.template), canonicalJson(first.steps), state, now, id,
    )
    return id
  }

  private candidateId(scopeKey: string, signature: string): string {
    return `workflow_${digestObject(['workflow-candidate/v1', scopeKey, signature])}`
  }

  private invalidateCandidateExperiments(candidateRow: CandidateRow, now: number): void {
    const rows = this.database.prepare(`
      SELECT * FROM growth_experiments
      WHERE candidate_id = ? AND candidate_revision = ? AND candidate_digest = ?
        AND state NOT IN ('conflicted', 'expired', 'rejected', 'rolled-back')
    `).all(
      candidateRow.id, candidateRow.revision, candidateRow.evidence_digest,
    ) as unknown as ExperimentRow[]
    for (const row of rows) {
      const recoverApprovalSideEffect = row.artifact_id === null && row.state === 'approval-requesting'
      const state: GrowthExperimentState = row.artifact_id !== null
        ? 'rollback-pending'
        : recoverApprovalSideEffect ? 'approval-requesting' : 'conflicted'
      const operationKind = row.artifact_id !== null ? 'rollback' : recoverApprovalSideEffect
        ? row.operation_kind : null
      const operationId = row.artifact_id !== null ? `${row.id}:rollback` : recoverApprovalSideEffect
        ? row.operation_id : `${row.id}:conflicted`
      this.database.prepare(`
        UPDATE growth_experiments SET state = ?, version = version + 1, operation_id = ?,
          operation_kind = ?, attempt_count = 0, next_attempt_at = ?,
          terminal_code = 'evidence-superseded', updated_at = ? WHERE id = ? AND version = ?
      `).run(state, operationId, operationKind, now, now, row.id, row.version)
    }
  }

  private transaction<T>(callback: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const output = callback()
      this.database.exec('COMMIT')
      return output
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new GrowthExperimentsStoreError('disposed', 'growth experiments store is closed')
  }
}
