import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import {
  canonicalGrowthJson,
  growthObjectDigest,
  growthPortPayloadDigest,
  validateWorkflowSteps,
  type GrowthAutomationArtifactRequest,
  type GrowthAutomationProposalRequest,
  type ResolvedWorkflowAutomationTemplate,
} from '@dsh-enhanced/assistant-growth-contract'
import { openAutomationDatabase } from './sqlite.js'
import { AutomationStoreError, stableOccurrenceId } from './store.js'
import type { AutomationRecord, AutomationRun } from './types.js'

export const GROWTH_AUTOMATION_OWNER = 'assistant-growth-experiments'

export type GrowthOperationKind =
  | 'approval-proposal'
  | 'approval-settlement'
  | 'replay'
  | 'shadow'
  | 'canary'
  | 'canary-inspection'
  | 'promotion'
  | 'rollback'

interface OperationRow {
  operation_id: string
  operation_kind: GrowthOperationKind
  payload_digest: string
  status: 'pending' | 'completed'
  receipt_json: string | null
}

interface ArtifactRow {
  artifact_id: string
  experiment_id: string
  candidate_id: string
  candidate_revision: number
  candidate_digest: string
  workspace: string
  preset: string
  owner_binding_id: string
  principal_id: string
  template_ref: string
  template_digest: string
  privacy_attestation_json: string
  evidence_digest: string
  evidence_count: number
  steps_json: string
  automation_id: string
  definition_hash: string
  definition_version: number
  proposal_id: string | null
  approval_diff_hash: string
  deadline_at: number
  state: 'approval-pending' | 'paused' | 'canary-pending' | 'promoted' | 'rejected' | 'rolled-back'
  shadow_task_id: string | null
  canary_task_id: string | null
  canary_run_id: string | null
  canary_evaluation_id: string | null
  canary_evaluation_digest: string | null
  created_at: number
  updated_at: number
}

export interface GrowthArtifactRecord {
  artifactId: string
  experimentId: string
  candidateId: string
  candidateRevision: number
  candidateDigest: string
  workspace: string
  preset: string
  ownerBindingId: string
  principalId: string
  templateRef: string
  templateDigest: string
  privacyAttestation: GrowthAutomationProposalRequest['template']['privacyAttestation']
  evidenceDigest: string
  evidenceCount: number
  steps: ReturnType<typeof validateWorkflowSteps>
  automationId: string
  definitionHash: string
  definitionVersion: number
  proposalId?: string
  approvalDiffHash: string
  deadlineAt: number
  state: ArtifactRow['state']
  shadowTaskId?: string
  canaryTaskId?: string
  canaryRunId?: string
  canaryEvaluationId?: string
  canaryEvaluationDigest?: string
  createdAt: number
  updatedAt: number
}

function artifact(row: ArtifactRow): Readonly<GrowthArtifactRecord> {
  return Object.freeze({
    artifactId: row.artifact_id,
    experimentId: row.experiment_id,
    candidateId: row.candidate_id,
    candidateRevision: row.candidate_revision,
    candidateDigest: row.candidate_digest,
    workspace: row.workspace,
    preset: row.preset,
    ownerBindingId: row.owner_binding_id,
    principalId: row.principal_id,
    templateRef: row.template_ref,
    templateDigest: row.template_digest,
    privacyAttestation: JSON.parse(row.privacy_attestation_json) as
      GrowthAutomationProposalRequest['template']['privacyAttestation'],
    evidenceDigest: row.evidence_digest,
    evidenceCount: row.evidence_count,
    steps: validateWorkflowSteps(JSON.parse(row.steps_json) as unknown),
    automationId: row.automation_id,
    definitionHash: row.definition_hash,
    definitionVersion: row.definition_version,
    ...(row.proposal_id === null ? {} : { proposalId: row.proposal_id }),
    approvalDiffHash: row.approval_diff_hash,
    deadlineAt: row.deadline_at,
    state: row.state,
    ...(row.shadow_task_id === null ? {} : { shadowTaskId: row.shadow_task_id }),
    ...(row.canary_task_id === null ? {} : { canaryTaskId: row.canary_task_id }),
    ...(row.canary_run_id === null ? {} : { canaryRunId: row.canary_run_id }),
    ...(row.canary_evaluation_id === null ? {} : { canaryEvaluationId: row.canary_evaluation_id }),
    ...(row.canary_evaluation_digest === null ? {} : { canaryEvaluationDigest: row.canary_evaluation_digest }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function identityMatches(row: ArtifactRow, input: Readonly<GrowthAutomationArtifactRequest>): boolean {
  return row.artifact_id === input.artifactId
    && row.definition_version === input.artifactVersion
    && row.definition_hash === input.artifactDigest
    && row.experiment_id === input.experimentId
    && row.candidate_id === input.candidateId
    && row.candidate_revision === input.candidateRevision
    && row.candidate_digest === input.candidateDigest
}

function definitionDigest(definition: AutomationRecord['definition']): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex')
}

export class GrowthAutomationStore {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private closed = false

  constructor(path: string, now: () => number = Date.now) {
    this.database = openAutomationDatabase(path)
    this.now = now
  }

  beginOperation(kind: GrowthOperationKind, input: Readonly<{ operationId: string }>): unknown | undefined {
    this.assertOpen()
    const payloadDigest = growthPortPayloadDigest(input)
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT * FROM automation_growth_operations WHERE operation_id = ?
      `).get(input.operationId) as OperationRow | undefined
      if (existing !== undefined) {
        if (existing.operation_kind !== kind || existing.payload_digest !== payloadDigest) {
          throw new AutomationStoreError(
            'idempotency-conflict',
            'growth operationId was reused with another operation or payload',
          )
        }
        return existing.receipt_json === null ? undefined : JSON.parse(existing.receipt_json) as unknown
      }
      const now = this.now()
      this.database.prepare(`
        INSERT INTO automation_growth_operations(
          operation_id, operation_kind, payload_digest, status, receipt_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', NULL, ?, ?)
      `).run(input.operationId, kind, payloadDigest, now, now)
      return undefined
    })
  }

  completeOperation(
    kind: GrowthOperationKind,
    input: Readonly<{ operationId: string }>,
    receipt: Readonly<Record<string, unknown>>,
  ): unknown {
    this.assertOpen()
    const payloadDigest = growthPortPayloadDigest(input)
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT * FROM automation_growth_operations WHERE operation_id = ?
      `).get(input.operationId) as OperationRow | undefined
      if (existing === undefined || existing.operation_kind !== kind || existing.payload_digest !== payloadDigest) {
        throw new AutomationStoreError('idempotency-conflict', 'growth operation intent is missing or changed')
      }
      if (existing.receipt_json !== null) return JSON.parse(existing.receipt_json) as unknown
      const receiptJson = canonicalGrowthJson(receipt)
      const changed = this.database.prepare(`
        UPDATE automation_growth_operations
        SET status = 'completed', receipt_json = ?, updated_at = ?
        WHERE operation_id = ? AND status = 'pending' AND receipt_json IS NULL
      `).run(receiptJson, this.now(), input.operationId)
      if (changed.changes !== 1) {
        throw new AutomationStoreError('version-conflict', 'growth operation changed before receipt commit')
      }
      return JSON.parse(receiptJson) as unknown
    })
  }

  artifactId(input: Readonly<GrowthAutomationProposalRequest>): string {
    return `growth-${growthObjectDigest([
      'assistant-growth-artifact/v1', input.experimentId, input.candidateId,
      input.candidateRevision, input.candidateDigest,
    ])}`
  }

  automationId(input: Readonly<GrowthAutomationProposalRequest>): string {
    return `workflow-growth:${growthObjectDigest([
      'assistant-growth-automation/v1', input.experimentId, input.candidateId,
      input.candidateRevision, input.candidateDigest,
    ])}`
  }

  upsertArtifact(input: Readonly<{
    request: Readonly<GrowthAutomationProposalRequest>
    resolved: Readonly<ResolvedWorkflowAutomationTemplate>
    automation: Readonly<AutomationRecord>
    proposalId: string
    approvalDiffHash: string
    policyStatus: 'approved' | 'pending' | 'rejected' | 'expired'
  }>): Readonly<GrowthArtifactRecord> {
    this.assertOpen()
    const expectedArtifactId = this.artifactId(input.request)
    const expectedAutomationId = this.automationId(input.request)
    const definitionHash = input.request.template.templateDigest === input.resolved.template.templateDigest
      ? definitionDigest(input.automation.definition)
      : ''
    if (input.automation.id !== expectedAutomationId || input.automation.owner !== GROWTH_AUTOMATION_OWNER
      || input.automation.status !== 'paused' || definitionHash === ''
      || input.automation.definition.principal !== input.resolved.principalId
      || input.resolved.ownerBindingId !== input.request.ownerBindingId
      || input.resolved.scope.workspace !== input.request.scope.workspace
      || input.resolved.scope.preset !== input.request.scope.preset) {
      throw new AutomationStoreError('invalid-state', 'resolved growth artifact does not match its trusted request')
    }
    const state: ArtifactRow['state'] = input.policyStatus === 'approved' ? 'paused'
      : input.policyStatus === 'pending' ? 'approval-pending' : 'rejected'
    return this.transaction(() => {
      const existing = this.byId(expectedArtifactId)
      if (existing !== undefined) {
        const exact = existing.experimentId === input.request.experimentId
          && existing.candidateId === input.request.candidateId
          && existing.candidateRevision === input.request.candidateRevision
          && existing.candidateDigest === input.request.candidateDigest
          && existing.workspace === input.request.scope.workspace
          && existing.preset === input.request.scope.preset
          && existing.ownerBindingId === input.request.ownerBindingId
          && existing.principalId === input.resolved.principalId
          && existing.templateRef === input.request.template.templateRef
          && existing.templateDigest === input.request.template.templateDigest
          && canonicalGrowthJson(existing.privacyAttestation)
            === canonicalGrowthJson(input.request.template.privacyAttestation)
          && existing.evidenceDigest === input.request.evidenceDigest
          && existing.evidenceCount === input.request.evidenceCount
          && canonicalGrowthJson(existing.steps) === canonicalGrowthJson(input.request.steps)
          && existing.automationId === expectedAutomationId
          && existing.definitionHash === definitionHash
          && existing.proposalId === input.proposalId
          && existing.approvalDiffHash === input.approvalDiffHash
          && existing.deadlineAt === input.request.deadlineAt
        if (!exact) {
          throw new AutomationStoreError('idempotency-conflict', 'growth artifact identity was reused with other content')
        }
        return existing
      }
      const now = this.now()
      this.database.prepare(`
        INSERT INTO automation_growth_artifacts(
          artifact_id, experiment_id, candidate_id, candidate_revision, candidate_digest,
          workspace, preset, owner_binding_id, principal_id, template_ref, template_digest,
          privacy_attestation_json,
          evidence_digest, evidence_count, steps_json, automation_id, definition_hash,
          definition_version, proposal_id, approval_diff_hash, deadline_at, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        expectedArtifactId, input.request.experimentId, input.request.candidateId,
        input.request.candidateRevision, input.request.candidateDigest,
        input.request.scope.workspace, input.request.scope.preset, input.request.ownerBindingId,
        input.resolved.principalId,
        input.request.template.templateRef, input.request.template.templateDigest,
        canonicalGrowthJson(input.request.template.privacyAttestation),
        input.request.evidenceDigest, input.request.evidenceCount, canonicalGrowthJson(input.request.steps),
        expectedAutomationId, definitionHash, input.automation.version, input.proposalId,
        input.approvalDiffHash, input.request.deadlineAt, state, now, now,
      )
      return this.byId(expectedArtifactId)!
    })
  }

  updateApproval(artifactId: string, proposalId: string, status: 'approved' | 'pending' | 'rejected' | 'expired'):
    Readonly<GrowthArtifactRecord> {
    this.assertOpen()
    return this.transaction(() => {
      const current = this.byId(artifactId)
      if (current === undefined || current.proposalId !== proposalId) {
        throw new AutomationStoreError('not-found', 'growth approval artifact was not found')
      }
      if (current.state !== 'approval-pending' && !(current.state === 'paused' && status === 'approved')
        && !(current.state === 'rejected' && status !== 'approved')) {
        throw new AutomationStoreError('version-conflict', 'growth approval artifact is already terminal')
      }
      const state: ArtifactRow['state'] = status === 'approved' ? 'paused'
        : status === 'pending' ? 'approval-pending' : 'rejected'
      this.database.prepare(`
        UPDATE automation_growth_artifacts SET state = ?, updated_at = ? WHERE artifact_id = ?
      `).run(state, this.now(), artifactId)
      return this.byId(artifactId)!
    })
  }

  requireArtifact(input: Readonly<GrowthAutomationArtifactRequest>): Readonly<GrowthArtifactRecord> {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT * FROM automation_growth_artifacts WHERE artifact_id = ?
    `).get(input.artifactId) as ArtifactRow | undefined
    if (row === undefined || !identityMatches(row, input)) {
      throw new AutomationStoreError('version-conflict', 'growth artifact exact identity is stale or missing')
    }
    return artifact(row)
  }

  byExperiment(experimentId: string): Readonly<GrowthArtifactRecord> | undefined {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT * FROM automation_growth_artifacts WHERE experiment_id = ?
    `).get(experimentId) as ArtifactRow | undefined
    return row === undefined ? undefined : artifact(row)
  }

  createExecutionTask(input: Readonly<{
    artifact: Readonly<GrowthArtifactRecord>
    operationId: string
    kind: 'shadow' | 'canary'
  }>): Readonly<{ occurrenceId: string; taskId: string }> {
    this.assertOpen()
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM automation_growth_artifacts WHERE artifact_id = ?
      `).get(input.artifact.artifactId) as ArtifactRow | undefined
      if (row === undefined || row.definition_version !== input.artifact.definitionVersion
        || row.definition_hash !== input.artifact.definitionHash
        || (input.kind === 'shadow' && row.state !== 'paused')
        || (input.kind === 'canary' && row.state !== 'paused' && row.state !== 'canary-pending')) {
        throw new AutomationStoreError('version-conflict', 'growth execution artifact changed')
      }
      const triggerKey = `growth-${input.kind}:${input.operationId}`
      const occurrenceId = stableOccurrenceId(row.automation_id, 'manual', triggerKey)
      const taskId = `task-${occurrenceId}`
      const selectedTask = input.kind === 'shadow' ? row.shadow_task_id : row.canary_task_id
      if (selectedTask !== null && selectedTask !== taskId) {
        throw new AutomationStoreError(
          'idempotency-conflict',
          input.kind === 'canary'
            ? 'growth artifact already consumed its one production exposure'
            : 'growth artifact already has another shadow execution',
        )
      }
      const definition = this.database.prepare(`
        SELECT system_owner, definition_hash, version, status
        FROM automation_definitions WHERE id = ?
      `).get(row.automation_id) as {
        system_owner: string | null; definition_hash: string; version: number; status: string
      } | undefined
      if (definition?.system_owner !== GROWTH_AUTOMATION_OWNER || definition.status !== 'paused'
        || definition.definition_hash !== row.definition_hash || definition.version !== row.definition_version) {
        throw new AutomationStoreError('version-conflict', 'paused growth automation definition changed')
      }
      const existingOccurrence = this.database.prepare(`
        SELECT trigger_key, dry_run FROM automation_occurrences WHERE id = ?
      `).get(occurrenceId) as { trigger_key: string; dry_run: number } | undefined
      if (existingOccurrence === undefined) {
        const now = this.now()
        this.database.prepare(`
          INSERT INTO automation_occurrences(
            id, automation_id, trigger_kind, trigger_key, scheduled_at, status,
            reason, dry_run, created_at, updated_at
          ) VALUES (?, ?, 'manual', ?, ?, 'pending', NULL, ?, ?, ?)
        `).run(occurrenceId, row.automation_id, triggerKey, now, input.kind === 'shadow' ? 1 : 0, now, now)
        this.database.prepare(`
          INSERT INTO automation_tasks(
            id, occurrence_id, automation_id, status, cancel_requested, claimed_by,
            fencing_token, lease_until, attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, 'scheduled', 0, NULL, NULL, NULL, 0, ?, ?)
        `).run(taskId, occurrenceId, row.automation_id, now, now)
      } else if (existingOccurrence.trigger_key !== triggerKey
        || existingOccurrence.dry_run !== (input.kind === 'shadow' ? 1 : 0)) {
        throw new AutomationStoreError('idempotency-conflict', 'growth execution occurrence identity conflicted')
      }
      if (input.kind === 'shadow') {
        this.database.prepare(`
          UPDATE automation_growth_artifacts SET shadow_task_id = ?, updated_at = ? WHERE artifact_id = ?
        `).run(taskId, this.now(), row.artifact_id)
      } else {
        this.database.prepare(`
          UPDATE automation_growth_artifacts
          SET canary_task_id = ?, state = 'canary-pending', updated_at = ? WHERE artifact_id = ?
        `).run(taskId, this.now(), row.artifact_id)
      }
      return Object.freeze({ occurrenceId, taskId })
    })
  }

  recordCanaryRun(artifactId: string, run: Readonly<AutomationRun>): Readonly<GrowthArtifactRecord> {
    this.assertOpen()
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM automation_growth_artifacts WHERE artifact_id = ?
      `).get(artifactId) as ArtifactRow | undefined
      if (row === undefined || row.canary_task_id !== run.taskId || run.executionMode !== 'production') {
        throw new AutomationStoreError('invalid-state', 'canary run does not match the one-exposure task')
      }
      if (row.canary_run_id !== null && row.canary_run_id !== run.id) {
        throw new AutomationStoreError('idempotency-conflict', 'growth artifact has another canary run')
      }
      this.database.prepare(`
        UPDATE automation_growth_artifacts SET canary_run_id = ?, updated_at = ? WHERE artifact_id = ?
      `).run(run.id, this.now(), artifactId)
      return this.byId(artifactId)!
    })
  }

  recordCanaryEvaluation(input: Readonly<{
    artifactId: string
    runId: string
    evaluationId: string
    evaluationDigest: string
  }>): Readonly<GrowthArtifactRecord> {
    this.assertOpen()
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM automation_growth_artifacts WHERE artifact_id = ?
      `).get(input.artifactId) as ArtifactRow | undefined
      if (row === undefined || row.state !== 'canary-pending' || row.canary_run_id !== input.runId
        || !/^[a-f0-9]{64}$/u.test(input.evaluationDigest)) {
        throw new AutomationStoreError('invalid-state', 'trusted canary Evaluation does not match its run')
      }
      if ((row.canary_evaluation_id !== null && row.canary_evaluation_id !== input.evaluationId)
        || (row.canary_evaluation_digest !== null
          && row.canary_evaluation_digest !== input.evaluationDigest)) {
        throw new AutomationStoreError('idempotency-conflict', 'canary already has another Evaluation proof')
      }
      this.database.prepare(`
        UPDATE automation_growth_artifacts
        SET canary_evaluation_id = ?, canary_evaluation_digest = ?, updated_at = ?
        WHERE artifact_id = ?
      `).run(input.evaluationId, input.evaluationDigest, this.now(), input.artifactId)
      return this.byId(input.artifactId)!
    })
  }

  completePromotion(input: Readonly<{
    request: Readonly<GrowthAutomationArtifactRequest>
    automation: Readonly<AutomationRecord>
  }>): Readonly<GrowthArtifactRecord> {
    this.assertOpen()
    return this.transaction(() => {
      const current = this.requireArtifact(input.request)
      const hash = definitionDigest(input.automation.definition)
      if (current.automationId !== input.automation.id || input.automation.owner !== GROWTH_AUTOMATION_OWNER
        || input.automation.status !== 'active' || input.automation.version !== input.request.artifactVersion + 1
        || hash !== input.request.artifactDigest) {
        throw new AutomationStoreError('version-conflict', 'growth promotion did not commit the exact artifact CAS')
      }
      this.database.prepare(`
        UPDATE automation_growth_artifacts
        SET definition_version = ?, definition_hash = ?, state = 'promoted', updated_at = ?
        WHERE artifact_id = ? AND definition_version = ? AND definition_hash = ?
      `).run(
        input.automation.version, hash, this.now(), current.artifactId,
        input.request.artifactVersion, input.request.artifactDigest,
      )
      return this.byId(current.artifactId)!
    })
  }

  completeRollback(input: Readonly<{
    request: Readonly<GrowthAutomationArtifactRequest>
    automation: Readonly<AutomationRecord>
  }>): Readonly<GrowthArtifactRecord> {
    this.assertOpen()
    return this.transaction(() => {
      const current = this.requireArtifact(input.request)
      const hash = definitionDigest(input.automation.definition)
      if (current.automationId !== input.automation.id || input.automation.owner !== GROWTH_AUTOMATION_OWNER
        || input.automation.status !== 'paused' || hash !== input.request.artifactDigest
        || input.automation.version < input.request.artifactVersion
        || input.automation.version > input.request.artifactVersion + 1) {
        throw new AutomationStoreError('version-conflict', 'growth rollback did not preserve exact artifact identity')
      }
      this.database.prepare(`
        UPDATE automation_growth_artifacts
        SET definition_version = ?, state = 'rolled-back', updated_at = ?
        WHERE artifact_id = ? AND definition_version = ? AND definition_hash = ?
      `).run(
        input.automation.version, this.now(), current.artifactId,
        input.request.artifactVersion, input.request.artifactDigest,
      )
      return this.byId(current.artifactId)!
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private byId(id: string): Readonly<GrowthArtifactRecord> | undefined {
    const row = this.database.prepare(`
      SELECT * FROM automation_growth_artifacts WHERE artifact_id = ?
    `).get(id) as ArtifactRow | undefined
    return row === undefined ? undefined : artifact(row)
  }

  private transaction<T>(callback: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new AutomationStoreError('invalid-state', 'growth automation store is closed')
  }
}
