import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefinition, failureSummaryEvidenceDigest, type HostFailureEvidenceSummary, type VerifiedWorkflowSource } from '../src/definition.ts'
import { captureFailureCandidateProvenance } from '../src/capture-expansion.ts'
import { SkillStore } from '../src/store.ts'
import type { SkillCandidate, SkillDeploymentAdmission } from '../src/store.ts'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const scope = { principalId: 'owner-a', principalRecordId: 'record-a', principalVersion: 1, workspace: '/tmp/workspace', preset: 'primary' }
const otherScope = { ...scope, principalId: 'owner-b', principalRecordId: 'record-b' }
function definition() {
  const source: VerifiedWorkflowSource = { protocol: 'assistant-goals/verified-workflow-source/v1', scope, goal: { id: 'goal', definition: { version: 1, digest: 'a'.repeat(64), objective: 'Read.' }, sessionId: 'session', nativeGoalId: 'native' }, runId: 'run', turn: 1,
    acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: 1, validUntil: 2 }, steps: [{ id: 'read', toolName: 'files_read', arguments: { path: '/tmp/a' } }] }
  return createDefinition(source, { name: 'read-report', description: 'Read a report.', bindings: [{ name: 'path', stepId: 'read', path: '/path' }] }, ['files_read'])
}
function admission(candidate: SkillCandidate): SkillDeploymentAdmission {
  return { protocol: 'assistant-skills/canary-admission/v1', skillName: candidate.definition.name, parentDefinitionDigest: candidate.parentDigest!, candidateDefinitionDigest: acceptanceDigest(candidate.definition),
    taskFamily: { goalDefinitionDigest: candidate.definition.source.goal.definition.digest, outcomeProfile: { id: 'canary-outcome', version: 1, digest: 'e'.repeat(64) } } }
}
function failureCandidate(parent: ReturnType<SkillStore['save']>) {
  const objective = 'Read.', digest = acceptanceDigest({ objective }), now = Date.now()
  const repair: VerifiedWorkflowSource = { protocol: 'assistant-goals/verified-workflow-source/v1', scope, goal: { id: 'repair-goal', definition: { version: 1, digest, objective }, sessionId: 'repair-session', nativeGoalId: 'repair-native' },
    runId: 'repair-run', turn: 2, acceptance: { contractId: 'repair-contract', contractDigest: '4'.repeat(64), receiptDigest: '5'.repeat(64), verifiedAt: now - 1_000, validUntil: now + 60_000 }, steps: [{ id: 'read', toolName: 'files_read', arguments: { path: '/tmp/b' } }] }
  const definition = createDefinition(repair, { name: parent.name, description: 'Repair read.', bindings: [{ name: 'path', stepId: 'read', path: '/path' }] }, ['files_read'])
  const unsigned = { protocol: 'assistant-skills/host-failure-evidence/v1' as const, scope, taskFamily: { id: 'read-report', definitionDigest: digest, objective }, failureCategory: 'objective-not-achieved' as const,
    triggerCondition: { kind: 'not-achieved-count' as const, minimumOccurrences: 1, windowStartedAt: now - 2_000, windowEndedAt: now - 2_000 }, failures: [{ goal: { id: 'failed-goal', definition: { version: 1, digest, objective }, sessionId: 'failed-session', nativeGoalId: 'failed-native' }, runId: 'failed-run', execution: { status: 'succeeded' as const, quiescent: true as const }, outcome: 'not-achieved' as const, acceptance: { contractId: 'failed-contract', contractDigest: '6'.repeat(64), receiptDigest: '7'.repeat(64), verifiedAt: now - 2_000, validUntil: now + 60_000 }, traceDigest: '8'.repeat(64) }], repairGoal: repair.goal, attestedAt: now }
  const generation = 'goals-generation-1', summary: HostFailureEvidenceSummary = { ...unsigned, evidence: { producer: 'assistant-goals', generation, digest: failureSummaryEvidenceDigest(unsigned, generation) } }
  return { definition, provenance: captureFailureCandidateProvenance(summary, repair, scope, parent, definition) }
}
async function database() { const root = await mkdtemp(join(tmpdir(), 'assistant-skills-')); roots.push(root); return join(root, 'skills.sqlite') }
function qualifiedDeployment(store: SkillStore, canaryRuns = 1) {
  store.save(scope, definition())
  const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Improve.', trigger: 'owner', expiresAt: Date.now() + 60_000 })
  const comparison = store.claimComparison(scope, { sessionId: 'session', candidateId: candidate.id, parentDigest: candidate.parentDigest!, profileId: 'profile', profileDigest: 'd'.repeat(64), invocationId: 'revision-qualified' }, 1).comparison
  const admitted = admission(candidate), qualification = { qualified: true, admissionDigest: acceptanceDigest(admitted) }
  store.finishComparison(scope, comparison.id, 'complete', qualification)
  const active = store.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(qualification), admitted,
    { ownerRouteId: 'route', expiresAt: Date.now() + 60_000, maxRuns: 2, canaryRuns }, { route: 'receipt' })
  const claim = store.claim(scope, { invocationId: 'revision-run', goalId: 'revision-goal', sessionId: 'revision-session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'revision-goal-run' })
  store.finish(scope, claim.run.id, 'succeeded', [])
  return { ...active, admitted, run: claim.run, watchId: active.deployment.watchId }
}
function canonical(version: number, disposition: 'upsert' | 'retract', suffix = '') {
  return { subjectKind: 'goal-outcome' as const, subjectRef: 'revision-assessment', version, digest: acceptanceDigest({ version, disposition, suffix }), disposition, scopeWatermark: version }
}
function revisionObservation(runId: string, version: number, status: 'achieved' | 'not-achieved', suffix = '') {
  return { kind: 'current' as const, observation: { runId, receiptDigest: acceptanceDigest({ receipt: runId }), objectiveStatus: status, verifiedAt: Date.now(), validUntil: Date.now() + 60_000,
    executionTraceDigest: acceptanceDigest({ trace: runId }), taskFamilyDigest: acceptanceDigest({ goalDefinitionDigest: 'a'.repeat(64), outcomeProfile: { id: 'unused', version: 1, digest: 'b'.repeat(64) } }), canonical: canonical(version, 'upsert', suffix) } }
}

describe('SkillStore', () => {
  it('atomically deploys only a completed exact qualification and promotes after fresh successful canary evidence', () => {
    const store = new SkillStore(':memory:'); store.save(scope, definition())
    const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Improve.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    const comparison = store.claimComparison(scope, { sessionId: 'session', candidateId: candidate.id, parentDigest: candidate.parentDigest!, profileId: 'profile', profileDigest: 'd'.repeat(64), invocationId: 'qualified' }, 1).comparison
    const admitted = admission(candidate), result = { qualified: true, gates: ['quality'], admissionDigest: acceptanceDigest(admitted) }; store.finishComparison(scope, comparison.id, 'complete', result)
    const input = { ownerRouteId: 'route', expiresAt: Date.now() + 60000, maxRuns: 2, canaryRuns: 1 }, receipt = { route: 'receipt' }
    expect(() => store.activateQualifiedCandidate(scope, candidate.id, comparison.id, 'e'.repeat(64), admitted, input, receipt)).toThrow(/qualification unavailable/)
    expect(() => store.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), { ...admitted, taskFamily: { ...admitted.taskFamily, goalDefinitionDigest: 'f'.repeat(64) } }, input, receipt)).toThrow(/qualification unavailable/)
    const active = store.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), admitted, input, receipt)
    expect(active).toMatchObject({ definition: { version: 2, parentVersion: 1 }, deployment: { state: 'canary', runIds: [] } })
    expect(store.listWatches(scope)).toMatchObject([{ id: active.deployment.watchId, proofVersion: 'canonical-goal-outcome/v2' }])
    expect(store.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), admitted, input, receipt)).toEqual(active)
    const run = store.claim(scope, { invocationId: 'canary', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'goal-run' })
    expect(store.claim(scope, { invocationId: 'canary', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'goal-run' }).claimed).toBe(false)
    store.finish(scope, run.run.id, 'succeeded', [])
    expect(store.reconcileDeployment(scope, active.deployment.id)?.state).toBe('canary')
    store.observeWatch(scope, active.deployment.watchId, { runId: run.run.id, receiptDigest: 'f'.repeat(64), objectiveStatus: 'achieved', verifiedAt: Date.now(), validUntil: Date.now() + 60000, executionTraceDigest: 'c'.repeat(64) })
    expect(store.reconcileDeployment(scope, active.deployment.id)?.state).toBe('canary')
    const firstAchieved = revisionObservation(run.run.id, 1, 'achieved')
    firstAchieved.observation.taskFamilyDigest = acceptanceDigest(admitted.taskFamily)
    store.replaceWatchObservation(scope, active.deployment.watchId, firstAchieved)
    expect(store.reconcileDeployment(scope, active.deployment.id)).toMatchObject({ state: 'canary' })
    expect(store.reconcileDeploymentWithCanonicalPromotion(scope, active.deployment.id)).toMatchObject({ state: 'promoted' })
    expect(store.assertDeploymentRun(scope, run.run.id)).toMatchObject({ id: active.deployment.id, state: 'promoted' })
    const second = store.claim(scope, { invocationId: 'promoted', goalId: 'second-goal', sessionId: 'second-session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'second-goal-run' })
    store.finish(scope, second.run.id, 'succeeded', [])
    expect(() => store.claim(scope, { invocationId: 'over-quota', goalId: 'third-goal', sessionId: 'third-session', skillName: 'read-report', version: 2, inputs: {} })).toThrow(/quota exhausted/)
    store.observeWatch(scope, active.deployment.watchId, { runId: second.run.id, receiptDigest: '9'.repeat(64), objectiveStatus: 'not-achieved', verifiedAt: Date.now(), validUntil: Date.now() + 60000, executionTraceDigest: '8'.repeat(64), taskFamilyDigest: '7'.repeat(64) })
    expect(store.reconcileDeployment(scope, active.deployment.id)?.state).toBe('promoted')
    const secondFailure = revisionObservation(second.run.id, 1, 'not-achieved', 'second')
    secondFailure.observation.taskFamilyDigest = acceptanceDigest(admitted.taskFamily)
    secondFailure.observation.canonical = { ...secondFailure.observation.canonical, subjectRef: 'second-assessment', digest: acceptanceDigest({ run: second.run.id }) }
    store.replaceWatchObservation(scope, active.deployment.watchId, secondFailure)
    expect(store.reconcileDeployment(scope, active.deployment.id)?.state).toBe('blocked')
    expect(store.rollbackWatch(scope, active.deployment.watchId)?.state).toBe('rolled-back')
    expect(store.reconcileDeployment(scope, active.deployment.id)?.state).toBe('rolled-back')
    expect(store.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), admitted, input, receipt).deployment.state).toBe('rolled-back')
    expect(store.get(scope, 'read-report')?.version).toBe(3)
    store.close()
  })

  it('replaces one run observation by canonical revision and rolls back the exact deployed version after correction', () => {
    const store = new SkillStore(':memory:'), state = qualifiedDeployment(store)
    const familyDigest = acceptanceDigest(state.admitted.taskFamily)
    const achieved = revisionObservation(state.run.id, 1, 'achieved')
    achieved.observation.taskFamilyDigest = familyDigest
    expect(store.replaceWatchObservation(scope, state.watchId, achieved)).toMatchObject({ observations: [{ objectiveStatus: 'achieved', canonical: { version: 1 } }] })
    expect(store.reconcileDeployment(scope, state.deployment.id)).toMatchObject({ state: 'canary' })
    expect(store.reconcileDeploymentWithCanonicalPromotion(scope, state.deployment.id)).toMatchObject({ state: 'promoted' })

    const correction = revisionObservation(state.run.id, 2, 'not-achieved')
    correction.observation.taskFamilyDigest = familyDigest
    const replaced = store.replaceWatchObservation(scope, state.watchId, correction)!
    expect(replaced.observations).toHaveLength(1)
    expect(replaced.observations[0]).toMatchObject({ runId: state.run.id, objectiveStatus: 'not-achieved', canonical: { version: 2 } })
    expect(store.replaceWatchObservation(scope, state.watchId, correction)).toEqual(replaced)
    expect(store.replaceWatchObservation(scope, state.watchId, achieved)).toEqual(replaced)
    expect(store.reconcileDeployment(scope, state.deployment.id)).toMatchObject({ state: 'blocked' })
    expect(store.rollbackWatch(scope, state.watchId)).toMatchObject({ state: 'rolled-back', rollbackVersion: 3 })
    expect(store.get(scope, 'read-report')).toMatchObject({ version: 3, restoredFromVersion: 1 })
    store.close()
  })

  it('never promotes from claim or ordinary reconciliation and requires the explicit canonical promotion path', () => {
    const store = new SkillStore(':memory:'), state = qualifiedDeployment(store)
    const achieved = revisionObservation(state.run.id, 1, 'achieved')
    achieved.observation.taskFamilyDigest = acceptanceDigest(state.admitted.taskFamily)
    store.replaceWatchObservation(scope, state.watchId, achieved)
    expect(store.reconcileDeployment(scope, state.deployment.id)).toMatchObject({ state: 'canary' })
    expect(() => store.claim(scope, { invocationId: 'must-not-promote', goalId: 'later-goal', sessionId: 'later-session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'later-goal-run' })).toThrow(/quota exhausted/u)
    expect(store.getDeployment(scope, state.deployment.id)).toMatchObject({ state: 'canary' })
    expect(store.reconcileDeploymentWithCanonicalPromotion(scope, state.deployment.id)).toMatchObject({ state: 'promoted' })
    store.close()
  })

  it('commits a positive canonical observation and promotion in one store transaction', () => {
    const store = new SkillStore(':memory:'), state = qualifiedDeployment(store)
    const achieved = revisionObservation(state.run.id, 1, 'achieved')
    achieved.observation.taskFamilyDigest = acceptanceDigest(state.admitted.taskFamily)

    const committed = store.replaceWatchObservationAndPromote(scope, state.watchId, state.deployment.id, achieved)

    expect(committed.watch).toMatchObject({ observations: [{ runId: state.run.id, objectiveStatus: 'achieved', canonical: { version: 1 } }] })
    expect(committed.deployment).toMatchObject({ id: state.deployment.id, state: 'promoted' })
    expect(store.listWatches(scope)).toMatchObject([{ observations: [{ runId: state.run.id, objectiveStatus: 'achieved' }] }])
    expect(store.getDeployment(scope, state.deployment.id)).toMatchObject({ state: 'promoted' })
    store.close()
  })

  it('rolls back a positive canonical observation when promotion reconciliation rejects malformed deployment state', async () => {
    const path = await database(), store = new SkillStore(path), state = qualifiedDeployment(store)
    const achieved = revisionObservation(state.run.id, 1, 'achieved')
    achieved.observation.taskFamilyDigest = acceptanceDigest(state.admitted.taskFamily)
    const malformed = new DatabaseSync(path)
    malformed.prepare("UPDATE skill_deployments SET deployment_json=json_set(deployment_json, '$.runIds', json('null')) WHERE scope_key=? AND id=?")
      .run(acceptanceDigest(scope), state.deployment.id)
    malformed.close()

    expect(() => store.replaceWatchObservationAndPromote(scope, state.watchId, state.deployment.id, achieved)).toThrow()

    expect(store.listWatches(scope)).toMatchObject([{ observations: [], canonicalRevisions: [] }])
    expect(store.getDeployment(scope, state.deployment.id)).toMatchObject({ state: 'canary' })
    store.close()
  })

  it('keeps duplicate and out-of-order revisions idempotent but rejects same-revision disagreement', () => {
    const store = new SkillStore(':memory:'), state = qualifiedDeployment(store)
    const familyDigest = acceptanceDigest(state.admitted.taskFamily)
    const second = revisionObservation(state.run.id, 2, 'achieved'); second.observation.taskFamilyDigest = familyDigest
    const saved = store.replaceWatchObservation(scope, state.watchId, second)!
    expect(store.replaceWatchObservation(scope, state.watchId, second)).toEqual(saved)
    const laterScopeWatermark = structuredClone(second)
    laterScopeWatermark.observation.canonical.scopeWatermark += 1
    expect(store.replaceWatchObservation(scope, state.watchId, laterScopeWatermark)).toEqual(saved)
    const stale = revisionObservation(state.run.id, 1, 'not-achieved'); stale.observation.taskFamilyDigest = familyDigest
    expect(store.replaceWatchObservation(scope, state.watchId, stale)).toEqual(saved)
    const conflict = revisionObservation(state.run.id, 2, 'not-achieved', 'conflict'); conflict.observation.taskFamilyDigest = familyDigest
    expect(() => store.replaceWatchObservation(scope, state.watchId, conflict)).toThrow(/revision|conflict/u)
    expect(store.reconcileDeploymentWithCanonicalPromotion(scope, state.deployment.id)).toMatchObject({ state: 'promoted' })
    expect(store.get(scope, 'read-report')).toMatchObject({ version: 2 })
    store.close()
  })

  it('persists canonical invalidation across restart and never lets a withdrawn success keep a deployment promoted', async () => {
    const path = await database(); let store = new SkillStore(path); const state = qualifiedDeployment(store)
    const first = revisionObservation(state.run.id, 1, 'achieved'); first.observation.taskFamilyDigest = acceptanceDigest(state.admitted.taskFamily)
    store.replaceWatchObservation(scope, state.watchId, first)
    expect(store.reconcileDeploymentWithCanonicalPromotion(scope, state.deployment.id)).toMatchObject({ state: 'promoted' })
    store.close(); store = new SkillStore(path)

    const invalidated = { kind: 'invalidated' as const, runId: state.run.id, canonical: canonical(2, 'retract') }
    const watch = store.replaceWatchObservation(scope, state.watchId, invalidated)!
    expect(watch.observations).toEqual([])
    expect(store.replaceWatchObservation(scope, state.watchId, invalidated)).toEqual(watch)
    expect(store.reconcileDeployment(scope, state.deployment.id)).toMatchObject({ state: 'blocked' })
    expect(store.rollbackWatch(scope, state.watchId)).toMatchObject({ state: 'rolled-back', rollbackVersion: 3 })
    store.close(); store = new SkillStore(path)
    expect(store.listWatches(scope)).toMatchObject([{ state: 'rolled-back', rollbackVersion: 3, observations: [] }])
    expect(store.replaceWatchObservation(scope, state.watchId, first)).toMatchObject({ state: 'rolled-back', observations: [] })
    expect(store.get(scope, 'read-report')).toMatchObject({ version: 3, restoredFromVersion: 1 })
    store.close()
  })

  it.each(['canary', 'promoted'] as const)('blocks a legacy v1 %s deployment with observations across restart without changing its active definition', async legacyState => {
    const path = await database(); let store = new SkillStore(path), state = qualifiedDeployment(store, legacyState === 'canary' ? 2 : 1)
    const achieved = revisionObservation(state.run.id, 1, 'achieved')
    achieved.observation.taskFamilyDigest = acceptanceDigest(state.admitted.taskFamily)
    store.replaceWatchObservation(scope, state.watchId, achieved)
    expect(legacyState === 'promoted'
      ? store.reconcileDeploymentWithCanonicalPromotion(scope, state.deployment.id)
      : store.reconcileDeployment(scope, state.deployment.id)).toMatchObject({ state: legacyState })
    store.close()
    const legacy = new DatabaseSync(path)
    legacy.prepare("UPDATE skill_watches SET watch_json=json_remove(json_set(watch_json, '$.proofVersion', 'sole-skill-run/v1'), '$.canonicalRevisions', '$.observations[0].canonical') WHERE id=?").run(state.watchId)
    legacy.close(); store = new SkillStore(path)
    expect(store.getDeployment(scope, state.deployment.id)).toMatchObject({ state: 'blocked' })
    expect(store.get(scope, 'read-report')).toMatchObject({ version: 2 })
    expect(() => store.assertDeploymentRun(scope, state.run.id)).toThrow(/deployment unavailable/u)
    expect(() => store.claim(scope, { invocationId: `legacy-${legacyState}`, goalId: 'legacy-goal', sessionId: 'legacy-session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'legacy-goal-run' })).toThrow(/deployment unavailable/u)
    store.close(); store = new SkillStore(path)
    expect(store.getDeployment(scope, state.deployment.id)).toMatchObject({ state: 'blocked' })
    store.close()
  })

  it('blocks a legacy qualified deployment even when its linked watch was already exhausted', async () => {
    const path = await database(); let store = new SkillStore(path), state = qualifiedDeployment(store, 1)
    const achieved = revisionObservation(state.run.id, 1, 'achieved')
    achieved.observation.taskFamilyDigest = acceptanceDigest(state.admitted.taskFamily)
    store.replaceWatchObservation(scope, state.watchId, achieved)
    expect(store.reconcileDeploymentWithCanonicalPromotion(scope, state.deployment.id)).toMatchObject({ state: 'promoted' })
    store.close()
    const legacy = new DatabaseSync(path)
    legacy.prepare("UPDATE skill_watches SET state='exhausted', watch_json=json_remove(json_set(watch_json, '$.state', 'exhausted', '$.proofVersion', 'sole-skill-run/v1'), '$.canonicalRevisions', '$.observations[0].canonical') WHERE id=?").run(state.watchId)
    legacy.close(); store = new SkillStore(path)
    expect(store.getDeployment(scope, state.deployment.id)).toMatchObject({ state: 'blocked' })
    expect(() => store.claim(scope, { invocationId: 'legacy-exhausted', goalId: 'legacy-goal', sessionId: 'legacy-session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'legacy-goal-run' })).toThrow(/deployment unavailable/u)
    expect(() => store.assertDeploymentRun(scope, state.run.id)).toThrow(/deployment unavailable/u)
    store.close()
  })

  it('blocks a forged v2 promoted deployment without enough canonical achieved observations across restart', async () => {
    const path = await database(); let store = new SkillStore(path), state = qualifiedDeployment(store, 1)
    const achieved = revisionObservation(state.run.id, 1, 'achieved')
    achieved.observation.taskFamilyDigest = acceptanceDigest(state.admitted.taskFamily)
    store.replaceWatchObservation(scope, state.watchId, achieved)
    expect(store.reconcileDeploymentWithCanonicalPromotion(scope, state.deployment.id)).toMatchObject({ state: 'promoted' })
    store.close()
    const forged = new DatabaseSync(path)
    forged.prepare("UPDATE skill_watches SET watch_json=json_set(watch_json, '$.observations', json('[]'), '$.canonicalRevisions', json('[]')) WHERE id=?").run(state.watchId)
    forged.close(); store = new SkillStore(path)
    expect(store.getDeployment(scope, state.deployment.id)).toMatchObject({ state: 'blocked' })
    expect(store.get(scope, 'read-report')).toMatchObject({ version: 2 })
    expect(() => store.assertDeploymentRun(scope, state.run.id)).toThrow(/deployment unavailable/u)
    expect(() => store.claim(scope, { invocationId: 'empty-canonical', goalId: 'empty-goal', sessionId: 'empty-session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'empty-goal-run' })).toThrow(/deployment unavailable/u)
    store.close()
  })

  it.each([
    ['observation canonical', "'$.observations[0].canonical.digest'"],
    ['revision digest', "'$.canonicalRevisions[0].digest'"],
    ['revision binding', "'$.canonicalRevisions[0].binding.receiptDigest'"],
  ] as const)('blocks a malformed v2 promoted deployment with a wrong %s', async (_kind, pathExpression) => {
    const path = await database(); let store = new SkillStore(path), state = qualifiedDeployment(store, 1)
    const achieved = revisionObservation(state.run.id, 1, 'achieved')
    achieved.observation.taskFamilyDigest = acceptanceDigest(state.admitted.taskFamily)
    store.replaceWatchObservation(scope, state.watchId, achieved)
    expect(store.reconcileDeploymentWithCanonicalPromotion(scope, state.deployment.id)).toMatchObject({ state: 'promoted' })
    store.close()
    const forged = new DatabaseSync(path)
    forged.prepare(`UPDATE skill_watches SET watch_json=json_set(watch_json, ${pathExpression}, ?) WHERE id=?`).run('f'.repeat(64), state.watchId)
    forged.close(); store = new SkillStore(path)
    expect(store.getDeployment(scope, state.deployment.id)).toMatchObject({ state: 'blocked' })
    expect(() => store.assertDeploymentRun(scope, state.run.id)).toThrow(/deployment unavailable/u)
    expect(() => store.claim(scope, { invocationId: `wrong-${_kind}`, goalId: 'wrong-goal', sessionId: 'wrong-session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'wrong-goal-run' })).toThrow(/deployment unavailable/u)
    store.close()
  })

  it('preserves a complete current v2 promoted deployment across repeated reopen', async () => {
    const path = await database(); let store = new SkillStore(path), state = qualifiedDeployment(store, 1)
    const achieved = revisionObservation(state.run.id, 1, 'achieved')
    achieved.observation.taskFamilyDigest = acceptanceDigest(state.admitted.taskFamily)
    store.replaceWatchObservation(scope, state.watchId, achieved)
    expect(store.reconcileDeploymentWithCanonicalPromotion(scope, state.deployment.id)).toMatchObject({ state: 'promoted' })
    store.close()
    for (let index = 0; index < 2; index++) {
      store = new SkillStore(path)
      expect(store.getDeployment(scope, state.deployment.id)).toMatchObject({ state: 'promoted' })
      expect(store.assertDeploymentRun(scope, state.run.id)).toMatchObject({ state: 'promoted' })
      store.close()
    }
  })

  it.each(['achieved', 'not-achieved'] as const)('keeps a standalone %s watch observation-only', objectiveStatus => {
    const store = new SkillStore(':memory:')
    store.save(scope, definition())
    const active = store.save(scope, definition(), 1)
    const watch = store.createWatch(scope, { ownerRouteId: 'route', skillName: active.name, version: 2, fallbackVersion: 1, expiresAt: Date.now() + 60_000, maxRuns: 1, failureThreshold: 1 }, { route: 'receipt' })
    const claimed = store.claim(scope, { invocationId: `standalone-${objectiveStatus}`, goalId: `goal-${objectiveStatus}`, sessionId: 'session', skillName: active.name, version: 2, inputs: {}, goalExecutionRunId: `goal-run-${objectiveStatus}` })
    store.finish(scope, claimed.run.id, 'succeeded', [])
    const observed = store.observeWatch(scope, watch.id, { runId: claimed.run.id, receiptDigest: (objectiveStatus === 'achieved' ? 'a' : 'b').repeat(64), objectiveStatus, verifiedAt: Date.now(), validUntil: Date.now() + 60_000, executionTraceDigest: 'c'.repeat(64) })
    expect(observed).toMatchObject({ observations: [{ objectiveStatus }] })
    expect(observed).not.toHaveProperty('taskFamily')
    const afterRollbackAttempt = store.rollbackWatch(scope, watch.id)
    expect(afterRollbackAttempt).toMatchObject({ state: 'watching' })
    expect(afterRollbackAttempt).not.toHaveProperty('rollbackVersion')
    expect(store.get(scope, active.name)).toMatchObject({ version: 2 })
    expect(store.get(scope, active.name)).not.toHaveProperty('restoredFromVersion')
    store.close()
  })

  it.each(['failed', 'unknown', 'running'] as const)('keeps a deployed run debit across restart and blocks %s deployed work', async state => {
    const path = await database(), first = new SkillStore(path); first.save(scope, definition())
    const candidate = first.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Improve.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    const comparison = first.claimComparison(scope, { sessionId: 'session', candidateId: candidate.id, parentDigest: candidate.parentDigest!, profileId: 'profile', profileDigest: 'd'.repeat(64), invocationId: 'qualified' }, 1).comparison
    const admitted = admission(candidate), result = { qualified: true, admissionDigest: acceptanceDigest(admitted) }; first.finishComparison(scope, comparison.id, 'complete', result)
    const deployed = first.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), admitted, { ownerRouteId: 'route', expiresAt: Date.now() + 60000, maxRuns: 2, canaryRuns: 2 }, { route: 'receipt' })
    const run = first.claim(scope, { invocationId: 'debit', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'goal-run' })
    if (state !== 'running') first.finish(scope, run.run.id, state, [])
    first.close()
    const restored = new SkillStore(path)
    expect(restored.getDeployment(scope, deployed.deployment.id)).toMatchObject({ runIds: [run.run.id], state: 'blocked' })
    expect(() => restored.claim(scope, { invocationId: 'later', goalId: 'other', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'goal-run' })).toThrow(/deployment unavailable/)
    expect(() => restored.assertDeploymentRun(scope, run.run.id)).toThrow(/deployment unavailable/)
    restored.close()
  })

  it('fails closed across restart for a legacy deployment watch without causal proof version', async () => {
    const path = await database(), first = new SkillStore(path); first.save(scope, definition())
    const candidate = first.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Improve.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    const comparison = first.claimComparison(scope, { sessionId: 'session', candidateId: candidate.id, parentDigest: candidate.parentDigest!, profileId: 'profile', profileDigest: 'd'.repeat(64), invocationId: 'qualified' }, 1).comparison
    const admitted = admission(candidate), result = { qualified: true, admissionDigest: acceptanceDigest(admitted) }; first.finishComparison(scope, comparison.id, 'complete', result)
    const active = first.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), admitted, { ownerRouteId: 'route', expiresAt: Date.now() + 60000, maxRuns: 2, canaryRuns: 1 }, { route: 'receipt' })
    first.close()
    const legacy = new DatabaseSync(path)
    legacy.prepare("UPDATE skill_watches SET watch_json=json_remove(watch_json, '$.proofVersion') WHERE id=?").run(active.deployment.watchId)
    legacy.prepare("UPDATE skill_deployments SET deployment_json=json_remove(deployment_json, '$.admissionDigest', '$.candidateDefinitionDigest', '$.taskFamily') WHERE id=?").run(active.deployment.id)
    legacy.close()
    const restored = new SkillStore(path)
    expect(restored.getDeployment(scope, active.deployment.id)).toMatchObject({ state: 'blocked' })
    expect(restored.listWatches(scope)).toMatchObject([{ id: active.deployment.watchId, state: 'revoked' }])
    expect(() => restored.claim(scope, { invocationId: 'legacy', goalId: 'legacy-goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'legacy-goal-run' })).toThrow(/deployment unavailable/)
    restored.close()
  })

  it('rolls back a qualified activation when the deployment record cannot be inserted', async () => {
    const path = await database(), store = new SkillStore(path); store.save(scope, definition())
    const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Improve.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    const comparison = store.claimComparison(scope, { sessionId: 'session', candidateId: candidate.id, parentDigest: candidate.parentDigest!, profileId: 'profile', profileDigest: 'd'.repeat(64), invocationId: 'qualified' }, 1).comparison
    const admitted = admission(candidate), result = { qualified: true, admissionDigest: acceptanceDigest(admitted) }; store.finishComparison(scope, comparison.id, 'complete', result)
    const writer = new DatabaseSync(path)
    writer.exec("CREATE TRIGGER reject_deployment BEFORE INSERT ON skill_deployments BEGIN SELECT RAISE(ABORT, 'deployment storage unavailable'); END")
    expect(() => store.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), admitted, { ownerRouteId: 'route', expiresAt: Date.now() + 60000, maxRuns: 2, canaryRuns: 1 }, { route: 'receipt' })).toThrow(/deployment storage unavailable/)
    expect(store.get(scope, 'read-report')).toMatchObject({ version: 1 })
    expect(store.getCandidate(scope, candidate.id)).toMatchObject({ state: 'pending' })
    expect(store.listWatches(scope)).toEqual([]); expect(store.listDeployments(scope)).toEqual([])
    writer.close(); store.close()
  })
  it('commits watched activation atomically and never renews it after lost response and restart', async () => {
    const path = await database(), store = new SkillStore(path)
    store.save(scope, definition())
    const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Revise.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    const trial = store.claim(scope, { invocationId: 'trial', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, candidateId: candidate.id, goalExecutionRunId: 'goal-run' })
    store.finish(scope, trial.run.id, 'succeeded', [])
    const watch = { input: { ownerRouteId: 'route', skillName: 'read-report', version: 2, fallbackVersion: 1, expiresAt: Date.now() + 60000, maxRuns: 2, failureThreshold: 1 }, routeReceipt: { generation: 1 } }
    const writer = new DatabaseSync(path)
    writer.exec("CREATE TRIGGER reject_watch BEFORE INSERT ON skill_watches BEGIN SELECT RAISE(ABORT, 'watch storage unavailable'); END")
    expect(() => store.activateCandidate(scope, candidate.id, trial.run.id, 'receipt', watch)).toThrow(/watch storage unavailable/)
    expect(store.get(scope, 'read-report')?.version).toBe(1)
    expect(store.getCandidate(scope, candidate.id)?.state).toBe('pending')
    expect(store.listWatches(scope)).toEqual([])
    writer.exec('DROP TRIGGER reject_watch'); writer.close()
    const active = store.activateCandidate(scope, candidate.id, trial.run.id, 'receipt', watch)
    const watches = store.listWatches(scope); expect(watches).toHaveLength(1)
    expect(watches[0]).toMatchObject({ version: 2, fallbackVersion: 1, state: 'watching', runIds: [] })
    store.close()
    const restored = new SkillStore(path)
    expect(restored.activateCandidate(scope, candidate.id, trial.run.id, 'receipt', watch)).toEqual(active)
    expect(restored.listWatches(scope)).toEqual(watches)
    expect(() => restored.activateCandidate(scope, candidate.id, trial.run.id, 'receipt', { ...watch, input: { ...watch.input, maxRuns: 3 } })).toThrow(/candidate conflict/)
    expect(() => restored.activateCandidate(scope, candidate.id, trial.run.id, 'receipt')).toThrow(/candidate conflict/)
    restored.close()
  })
  it('uses immutable version CAS and owner-scoped reads', () => {
    const store = new SkillStore(':memory:'); const first = store.save(scope, definition())
    expect(first.version).toBe(1); expect(store.list(scope)).toHaveLength(1); expect(store.get(otherScope, first.name)).toBeUndefined()
    expect(() => store.save(scope, definition())).toThrow(/version conflict/)
    const second = store.save(scope, definition(), 1)
    expect(second).toMatchObject({ version: 2, parentVersion: 1 }); expect(store.get(scope, first.name, 1)?.version).toBe(1)
    expect(store.retire(scope, first.name, 2)).toMatchObject({ retired: true, version: 2 })
    expect(store.get(scope, first.name)).toBeUndefined(); expect(store.list(scope)).toEqual([]); store.close()
  })

  it('persists runs, fences duplicate finish, and never replays an interrupted run', async () => {
    const path = await database(); const first = new SkillStore(path)
    first.save(scope, definition())
    const claimed = first.claim(scope, { invocationId: 'invoke', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: { path: '/tmp/a' } })
    expect(claimed.claimed).toBe(true); expect(first.claim(scope, { invocationId: 'invoke', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: { path: '/tmp/a' } }).claimed).toBe(false)
    expect(() => first.claim(scope, { invocationId: 'invoke', goalId: 'other', sessionId: 'session', skillName: 'read-report', version: 1, inputs: { path: '/tmp/a' } })).toThrow(/invocation conflict/)
    expect(() => first.claim(scope, { invocationId: 'parallel', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} })).toThrow()
    first.close()
    const reopened = new SkillStore(path)
    expect(reopened.getRun(scope, claimed.run.id)).toMatchObject({ state: 'unknown' })
    expect(() => reopened.finish(scope, claimed.run.id, 'succeeded', [])).toThrow(/run state conflict/)
    expect(() => reopened.claim(scope, { invocationId: 'later', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} })).toThrow(/unresolved invocation/u)
    const later = reopened.claim(scope, { invocationId: 'later', goalId: 'other-goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} })
    expect(reopened.checkpoint(scope, later.run.id, [{ id: 'read', state: 'succeeded' }])).toMatchObject({ state: 'running', steps: [{ id: 'read', state: 'succeeded' }] })
    expect(reopened.finish(scope, later.run.id, 'succeeded', [{ id: 'read', state: 'succeeded' }])).toMatchObject({ state: 'succeeded' })
    expect(() => reopened.finish(scope, later.run.id, 'failed', [])).toThrow(/run state conflict/)
    expect(reopened.getRun(otherScope, later.run.id)).toBeUndefined(); reopened.close()
  })

  it('fences replacement invocation IDs for running or unknown work in the same skill Goal, including candidate trials', () => {
    const store = new SkillStore(':memory:'); store.save(scope, definition())
    const running = store.claim(scope, { invocationId: 'running-first', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} })
    expect(() => store.claim(scope, { invocationId: 'running-second', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} })).toThrow(/unresolved invocation/u)
    store.finish(scope, running.run.id, 'unknown', [])
    expect(() => store.claim(scope, { invocationId: 'unknown-second', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} })).toThrow(/unresolved invocation/u)
    expect(store.claim(scope, { invocationId: 'separate-goal', goalId: 'other-goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} }).claimed).toBe(true)
    const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Trial.', trigger: 'owner request', expiresAt: Date.now() + 60000 })
    const trial = store.claim(scope, { invocationId: 'trial-first', goalId: 'trial-goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, candidateId: candidate.id, goalExecutionRunId: 'goal-run' })
    expect(() => store.claim(scope, { invocationId: 'trial-second', goalId: 'trial-goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, candidateId: candidate.id, goalExecutionRunId: 'goal-run' })).toThrow(/unresolved invocation/u)
    store.finish(scope, trial.run.id, 'unknown', []); store.close()
  })

  it('recovers multiple legacy running invocations before adding the per-goal index', async () => {
    const path = await database(); const first = new SkillStore(path)
    first.save(scope, definition())
    const claim = first.claim(scope, { invocationId: 'legacy-first', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {} })
    first.close()
    const legacy = new DatabaseSync(path)
    legacy.exec("DROP INDEX skill_runs_one_active")
    legacy.prepare("INSERT INTO skill_runs SELECT 'legacy-second', scope_key, json_set(identity_json, '$.invocationId', 'legacy-second'), json_set(run_json, '$.id', 'legacy-second', '$.invocationId', 'legacy-second'), state FROM skill_runs WHERE id=?").run(claim.run.id)
    legacy.close()
    const restored = new SkillStore(path)
    expect(restored.getRun(scope, claim.run.id)?.state).toBe('unknown')
    expect(restored.getRun(scope, 'legacy-second')?.state).toBe('unknown')
    expect(() => restored.finish(scope, claim.run.id, 'succeeded', [])).toThrow(/run state conflict/u)
    restored.close()
  })

  it('creates private state files and rejects a symlinked database', async () => {
    const path = await database(); const store = new SkillStore(path); store.close()
    expect((await lstat(path)).mode & 0o077).toBe(0)
    const root = await mkdtemp(join(tmpdir(), 'assistant-skills-link-')); roots.push(root)
    const target = join(root, 'target.sqlite'); const link = join(root, 'link.sqlite')
    await writeFile(target, 'not a database'); await symlink(target, link)
    expect(() => new SkillStore(link)).toThrow(/unsafe database file/)
  })

  it('keeps candidates out of the active directory and enforces their parent and expiry', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    try {
      const store = new SkillStore(':memory:')
      const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 0, reason: 'Improve wording.', trigger: 'owner request', expiresAt: Date.now() + 1000 })
      expect(store.list(scope)).toEqual([]); expect(store.get(scope, candidate.definition.name)).toBeUndefined(); expect(store.listCandidates(scope)).toMatchObject([{ id: candidate.id, state: 'pending' }]); expect(store.getCandidate(otherScope, candidate.id)).toBeUndefined()
      expect(store.stageCandidate(scope, definition(), { expectedVersion: 0, reason: 'Improve wording.', trigger: 'owner request', expiresAt: Date.now() + 2000 })).toEqual(candidate)
      const rejected = store.stageCandidate(scope, definition(), { expectedVersion: 0, reason: 'Do not use.', trigger: 'owner request', expiresAt: Date.now() + 2000 })
      expect(store.rejectCandidate(scope, rejected.id).state).toBe('rejected'); expect(store.rejectCandidate(scope, rejected.id).state).toBe('rejected')
      expect(() => store.claim(scope, { invocationId: 'trial', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {}, candidateId: candidate.id })).toThrow(/invalid invocation/)
      vi.advanceTimersByTime(1500)
      expect(store.stageCandidate(scope, definition(), { expectedVersion: 0, reason: 'Improve wording.', trigger: 'owner request', expiresAt: Date.now() + 2000 })).toEqual(candidate)
      expect(() => store.claim(scope, { invocationId: 'trial', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {}, candidateId: candidate.id, goalExecutionRunId: 'goal-run' })).toThrow(/candidate unavailable/)
      store.close()
    } finally { vi.useRealTimers() }
  })

  it('keeps legacy candidate IDs stable and persists exact failure provenance through activation and rollback', async () => {
    const path = await database(), first = new SkillStore(path), parent = first.save(scope, definition()), repair = failureCandidate(parent)
    const options = { expectedVersion: 1, reason: 'Repair.', trigger: 'failure:read-report', expiresAt: Date.now() + 60_000 }
    const legacy = first.stageCandidate(scope, repair.definition, options)
    expect(legacy.id).toBe(`skill-candidate-${acceptanceDigest([scope, repair.definition, 1, acceptanceDigest(parent), options.reason, options.trigger])}`)
    expect(legacy).not.toHaveProperty('failureProvenance')
    const candidate = first.stageCandidate(scope, repair.definition, { ...options, failureProvenance: repair.provenance })
    expect(candidate.id).not.toBe(legacy.id); expect(candidate.failureProvenance).toEqual(repair.provenance)
    expect(() => first.stageCandidate(scope, repair.definition, { ...options, failureProvenance: { ...repair.provenance, rollbackTarget: { ...repair.provenance.rollbackTarget, digest: '0'.repeat(64) } } })).toThrow(/provenance|rollback/u)
    const trial = first.claim(scope, { invocationId: 'repair-trial', goalId: 'trial-goal', sessionId: 'trial-session', skillName: parent.name, version: 2, inputs: {}, candidateId: candidate.id, goalExecutionRunId: 'trial-run' })
    first.finish(scope, trial.run.id, 'succeeded', [])
    expect(first.activateCandidate(scope, candidate.id, trial.run.id, 'receipt')).toMatchObject({ version: 2, parentVersion: 1 })
    expect(first.getCandidate(scope, candidate.id)?.failureProvenance).toEqual(repair.provenance)
    expect(first.rollback(scope, parent.name, 2, 1)).toMatchObject({ version: 3, restoredFromVersion: 1 })
    first.close()
    const restored = new SkillStore(path)
    expect(restored.getCandidate(scope, candidate.id)).toMatchObject({ state: 'activated', failureProvenance: repair.provenance })
    restored.close()
  })

  it('claims candidate trials without an active definition and activates atomically only after success', () => {
    const store = new SkillStore(':memory:')
    const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 0, reason: 'New workflow.', trigger: 'owner request', expiresAt: Date.now() + 60000 })
    const trial = store.claim(scope, { invocationId: 'trial', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 1, inputs: {}, candidateId: candidate.id, goalExecutionRunId: 'goal-run' })
    expect(trial.claimed).toBe(true); expect(store.get(scope, 'read-report')).toBeUndefined()
    expect(() => store.activateCandidate(scope, candidate.id, trial.run.id, 'receipt')).toThrow(/trial acceptance required/)
    store.finish(scope, trial.run.id, 'succeeded', [])
    const activated = store.activateCandidate(scope, candidate.id, trial.run.id, 'receipt')
    expect(activated).toMatchObject({ version: 1, parentVersion: null })
    expect(store.activateCandidate(scope, candidate.id, trial.run.id, 'receipt')).toEqual(activated)
    expect(() => store.activateCandidate(scope, candidate.id, trial.run.id, 'other-receipt')).toThrow(/candidate conflict/)
    expect(() => store.rejectCandidate(scope, candidate.id)).toThrow(/candidate conflict/)
    store.close()
  })

  it('does not activate unknown trials and rolls back by appending an immutable version', () => {
    const store = new SkillStore(':memory:'); const first = store.save(scope, definition())
    const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Revise workflow.', trigger: 'owner request', expiresAt: Date.now() + 60000 })
    const trial = store.claim(scope, { invocationId: 'trial', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, candidateId: candidate.id, goalExecutionRunId: 'goal-run' })
    store.finish(scope, trial.run.id, 'unknown', [])
    expect(() => store.activateCandidate(scope, candidate.id, trial.run.id, 'receipt')).toThrow(/trial acceptance required/)
    const second = store.save(scope, definition(), 1)
    const restored = store.rollback(scope, 'read-report', 2, 1)
    expect(restored).toMatchObject({ version: 3, parentVersion: 2, restoredFromVersion: 1 })
    expect(store.get(scope, 'read-report', first.version)).toMatchObject({ version: 1, retired: false })
    expect(store.get(scope, 'read-report', second.version)).toMatchObject({ version: 2, retired: false })
    expect(store.rollback(scope, 'read-report', 2, 1)).toEqual(restored)
    expect(store.get(scope, 'read-report', 4)).toBeUndefined()
    store.save(scope, definition(), 3)
    expect(store.rollback(scope, 'read-report', 4, 3)).toMatchObject({ version: 5, restoredFromVersion: 3 })
    store.close()
  })

  it('persists bounded candidate comparisons without replaying interrupted work', async () => {
    const path = await database(); const first = new SkillStore(path); const parent = first.save(scope, definition())
    const candidate = first.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Compare.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    const identity = { sessionId: 'session', candidateId: candidate.id, parentDigest: candidate.parentDigest!, profileId: 'profile', profileDigest: 'd'.repeat(64), invocationId: 'compare-1' }
    const claim = first.claimComparison(scope, identity, 1); expect(claim.claimed).toBe(true); first.close()
    const reopened = new SkillStore(path); expect(reopened.getComparison(scope, claim.comparison.id)).toMatchObject({ state: 'unknown' })
    expect(reopened.claimComparison(scope, identity, 1)).toMatchObject({ claimed: false, comparison: { state: 'unknown' } })
    expect(reopened.getComparison(otherScope, claim.comparison.id)).toBeUndefined(); reopened.close()
    expect(parent.version).toBe(1)
  })

  it('fences comparison identity, budget, parent changes and finish CAS', () => {
    const store = new SkillStore(':memory:'); store.save(scope, definition())
    const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Compare.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    const identity = { sessionId: 'session', candidateId: candidate.id, parentDigest: candidate.parentDigest!, profileId: 'profile', profileDigest: 'd'.repeat(64), invocationId: 'one' }
    const first = store.claimComparison(scope, identity, 1); expect(() => store.claimComparison(scope, { ...identity, candidateId: 'other' }, 1)).toThrow(/comparison conflict|candidate unavailable/u)
    expect(store.finishComparison(scope, first.comparison.id, 'complete', { winner: 'parent' })).toMatchObject({ state: 'complete', result: { winner: 'parent' } })
    expect(() => store.finishComparison(scope, first.comparison.id, 'unknown', null)).toThrow(/comparison state conflict/u)
    expect(() => store.claimComparison(scope, { ...identity, invocationId: 'two', profileDigest: 'e'.repeat(64) }, 1)).toThrow(/budget exhausted/u)
    const secondCandidate = store.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Other.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    store.save(scope, definition(), 1)
    expect(() => store.claimComparison(scope, { ...identity, candidateId: secondCandidate.id, invocationId: 'three' }, 2)).toThrow(/candidate unavailable/u)
    store.close()
  })
})


it('preserves declared file observations through persistence and rollback without rewriting legacy versions', async () => {
  const path = await database(), old = definition(), source = { ...old.source, steps: [{ id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'new' } }] }
  const next = createDefinition(source, { name: old.name, description: 'Write with observation.' }, ['write'])
  let store = new SkillStore(path)
  const legacy = store.save(scope, old), saved = store.save(scope, next, 1)
  expect(saved.fileObservations).toEqual(next.fileObservations)
  store.close(); store = new SkillStore(path)
  try {
    expect(store.get(scope, old.name, 1)).toEqual(legacy)
    expect(store.get(scope, old.name, 2)).toEqual(saved)
    expect(store.rollback(scope, old.name, 2, 1).fileObservations).toBeUndefined()
    expect(store.rollback(scope, old.name, 3, 2).fileObservations).toEqual(next.fileObservations)
    expect(store.get(scope, old.name, 1)).toEqual(legacy)
  } finally { store.close() }
})
