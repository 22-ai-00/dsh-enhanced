import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import {
  AssistantEvaluationService,
  EvaluationStore,
  canonicalEvaluationHostScope,
} from '@dsh-enhanced/assistant-evaluation'
import { AssistantAutomationsService } from '../src/service.ts'
import { GrowthAutomationStore } from '../src/growth.ts'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()) })
const hash = createHash('sha256').update(JSON.stringify({})).digest('hex')
const scope = { workspace: '/work/alpha', preset: 'primary' }
const request = { contractVersion: 1 as const, operationId: 'promote', experimentId: 'experiment',
  candidateId: 'candidate', candidateRevision: 1, candidateDigest: hash,
  artifactId: 'artifact', artifactVersion: 1, artifactDigest: hash }
const inspect = { ...request, operationId: 'inspect', exposureOperationId: 'expose' }

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'canary-proof-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'automations.sqlite')
  const growthStore = new GrowthAutomationStore(path)
  cleanup.push(() => growthStore.close())
  const db = new DatabaseSync(path)
  cleanup.push(() => db.close())
  db.exec(`PRAGMA foreign_keys = OFF;
    INSERT INTO automation_growth_artifacts(artifact_id, experiment_id, candidate_id, candidate_revision,
      candidate_digest, workspace, preset, owner_binding_id, principal_id, template_ref, template_digest,
      privacy_attestation_json, evidence_digest, evidence_count, steps_json, automation_id, definition_hash,
      definition_version, approval_diff_hash, deadline_at, state, canary_task_id, canary_run_id, created_at, updated_at)
    VALUES ('artifact', 'experiment', 'candidate', 1, '${hash}', '/work/alpha', 'primary', 'binding', 'principal',
      'template', '${hash}', '{}', '${hash}', 1, '[{"catalogId":"assistant.agent-turn","argumentSchemaDigest":"${hash}"}]', 'automation', '${hash}', 1, '${hash}', 999999,
      'canary-pending', 'task', 'run-canary', 1, 1)`)
  const evalPath = join(root, 'evaluation.sqlite')
  const evaluationStore = new EvaluationStore({ path: evalPath })
  cleanup.push(() => evaluationStore.close())
  const evaluation: AssistantEvaluationService = Object.assign(Object.create(AssistantEvaluationService.prototype) as AssistantEvaluationService,
    { active: true, store: evaluationStore })
  const definition = { id: 'automation', owner: 'assistant-growth-experiments', status: 'paused', version: 1, definition: {} }
  const activate = vi.fn(() => ({ ...definition, status: 'active', version: 2 }))
  const service: AssistantAutomationsService = Object.assign(Object.create(AssistantAutomationsService.prototype) as AssistantAutomationsService, {
    active: true, growthStore, evaluation,
    store: { getRun: () => ({ id: 'run-canary', taskId: 'task', executionMode: 'production', status: 'succeeded' }),
      getDefinitionHash: () => hash },
    requireLiveGrowthArtifact: () => definition,
    reconcileSystem: activate,
  })
  let sequence = 0
  const append = (objectiveStatus: 'achieved' | 'not-achieved', owner = false,
    target: Readonly<{ runId: string; situation: string }> = { runId: 'run-canary', situation: 'automation:automation' }) => {
    const row = evaluationStore.append({ scope, situation: target.situation,
      executionStatus: 'succeeded', objectiveStatus, deliveryStatus: 'not-required',
      source: owner ? { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' }
        : { kind: 'automation', id: 'assistant-automations' }, trust: 'trusted',
      evidence: [{ kind: 'automation-run', ref: target.runId },
        ...(owner ? [{ kind: 'delivery-outbox', ref: 'owner-delivery' }] : [])], metrics: {}, occurredAt: ++sequence,
      idempotencyKey: `row-${sequence}`, evaluator: owner ? { id: 'assistant-delivery-owner-feedback', version: '2' }
        : { id: 'assistant-automations', version: 'terminal-v1' } })
    evaluationStore.completeProjection({ evaluationId: row.id, now: Date.now() })
    return row
  }
  return { service, growthStore, evaluationStore, evaluation, append, activate, evalPath, db, path }
}

test('conflicting canonical owner judgements cannot reuse raw achieved evidence', () => {
  const h = harness()
  h.append('achieved', true); h.append('not-achieved', true)
  expect(h.service.inspectWorkflowCanary(inspect).outcome).toBe('pending')
  expect(() => h.service.promoteWorkflowAutomation(request)).toThrow()
  expect(h.activate).not.toHaveBeenCalled()
})

test('changed evidence after inspection cannot activate', () => {
  const h = harness(); h.append('achieved')
  expect(h.service.inspectWorkflowCanary(inspect).outcome).toBe('passed')
  h.append('not-achieved', true)
  expect(() => h.service.promoteWorkflowAutomation(request)).toThrow(/evidence/i)
  expect(h.activate).not.toHaveBeenCalled()
})

test('restart replay revalidates saved inspection success', () => {
  const h = harness(); h.append('achieved')
  h.service.inspectWorkflowCanary(inspect)
  h.append('not-achieved', true)
  const reopened = new GrowthAutomationStore(h.path)
  cleanup.push(() => reopened.close())
  Object.assign(h.service, { growthStore: reopened })
  expect(() => h.service.inspectWorkflowCanary(inspect)).toThrow(/evidence/i)
})

test('valid proof persists canonical revision and promotion holds the Evaluation writer fence', () => {
  const h = harness(); const row = h.append('achieved')
  h.service.inspectWorkflowCanary(inspect)
  const canonical = h.evaluationStore.getTaskLearningProjection(scope, row.id)!
  expect(h.growthStore.requireArtifact(request)).toMatchObject({ canaryEvaluationProof: {
    scopeWatermark: canonical.scopeWatermark, projection: canonical.projection,
  } })
  const competing = new DatabaseSync(h.evalPath)
  cleanup.push(() => competing.close())
  competing.exec('PRAGMA busy_timeout = 1')
  h.activate.mockImplementation(() => {
    expect(() => competing.exec('BEGIN IMMEDIATE')).toThrow(/locked/)
    return { id: 'automation', owner: 'assistant-growth-experiments', status: 'active', version: 2, definition: {} }
  })
  expect(h.service.promoteWorkflowAutomation(request).outcome).toBe('promoted')
  expect(h.service.promoteWorkflowAutomation(request).outcome).toBe('promoted')
  expect(h.activate).toHaveBeenCalledTimes(1)
})

test('a correction committed immediately before the writer fence wins over promotion', () => {
  const h = harness(); h.append('achieved')
  h.service.inspectWorkflowCanary(inspect)
  const fence = h.evaluation.withTrustedCanonicalLearningWriterFence.bind(h.evaluation)
  vi.spyOn(h.evaluation, 'withTrustedCanonicalLearningWriterFence').mockImplementation((input, callback) => {
    h.append('not-achieved', true)
    return fence(input, callback)
  })
  expect(() => h.service.promoteWorkflowAutomation(request)).toThrow(/evidence fence/)
  expect(h.activate).not.toHaveBeenCalled()
})

test('v10 saved proofs migrate without granting legacy success activation authority', () => {
  const h = harness(); h.append('achieved')
  h.service.inspectWorkflowCanary(inspect)
  h.db.exec('ALTER TABLE automation_growth_artifacts DROP COLUMN canary_evaluation_proof_json; PRAGMA user_version = 10')
  const reopened = new GrowthAutomationStore(h.path)
  cleanup.push(() => reopened.close())
  Object.assign(h.service, { growthStore: reopened })
  expect(h.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 })
  expect(() => h.service.inspectWorkflowCanary(inspect)).toThrow(/evidence/)
  expect(() => h.service.promoteWorkflowAutomation(request)).toThrow(/evidence/)
  expect(h.activate).not.toHaveBeenCalled()
})

test('unchanged inspection proof replays after reopening its durable ledger', () => {
  const h = harness(); h.append('achieved')
  const receipt = h.service.inspectWorkflowCanary(inspect)
  const reopened = new GrowthAutomationStore(h.path)
  cleanup.push(() => reopened.close())
  Object.assign(h.service, { growthStore: reopened })
  expect(h.service.inspectWorkflowCanary(inspect)).toEqual(receipt)
})

test('inspection replay survives a real promotion version transition but still detects correction', () => {
  const h = harness(); h.append('achieved')
  const inspection = h.service.inspectWorkflowCanary(inspect)
  expect(h.service.promoteWorkflowAutomation(request).outcome).toBe('promoted')
  expect(h.growthStore.byExperiment('experiment')).toMatchObject({
    state: 'promoted', definitionVersion: 2,
  })
  expect(h.service.inspectWorkflowCanary(inspect)).toEqual(inspection)
  h.append('not-achieved', true)
  expect(() => h.service.inspectWorkflowCanary(inspect)).toThrow(/evidence/i)
})

test('unrelated canonical progress refreshes the scope fence without changing saved canary identity', () => {
  const h = harness(); h.append('achieved')
  const receipt = h.service.inspectWorkflowCanary(inspect)
  const saved = h.growthStore.requireArtifact(request).canaryEvaluationProof!
  h.append('achieved', false, { runId: 'run-unrelated', situation: 'automation:unrelated' })
  const current = h.evaluation.getTrustedAutomationRunLearningProjection({
    scope: canonicalEvaluationHostScope(scope), runId: 'run-canary',
  })!
  expect(current.scopeWatermark).toBeGreaterThan(saved.scopeWatermark)
  expect(current.projection).toEqual(saved.projection)
  expect(h.service.inspectWorkflowCanary(inspect)).toEqual(receipt)
  expect(h.service.promoteWorkflowAutomation(request).outcome).toBe('promoted')
})

test('a proof from a different run or scope never passes inspection', () => {
  const h = harness(); const row = h.append('achieved')
  const proof = h.evaluationStore.getTaskLearningProjection(scope, row.id)!
  vi.spyOn(h.evaluation, 'getTrustedAutomationRunLearningProjection').mockReturnValue({
    ...proof, scope: { ...scope, workspace: '/work/other' },
  })
  expect(h.service.inspectWorkflowCanary(inspect).outcome).toBe('pending')
  expect(h.activate).not.toHaveBeenCalled()
})

test('pending Evolution delivery does not block a canonical Evaluation fence', () => {
  const h = harness(); h.append('achieved')
  h.service.inspectWorkflowCanary(inspect)
  const db = new DatabaseSync(h.evalPath)
  cleanup.push(() => db.close())
  db.exec("UPDATE evaluation_projection_outbox SET status = 'pending'")
  expect(h.service.promoteWorkflowAutomation(request).outcome).toBe('promoted')
  expect(h.activate).toHaveBeenCalledTimes(1)
  expect(db.prepare("SELECT status FROM evaluation_projection_outbox").get()).toEqual({ status: 'pending' })
})
