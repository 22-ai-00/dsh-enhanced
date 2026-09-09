import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefinition, type VerifiedWorkflowSource } from '../src/definition.ts'
import { SkillStore } from '../src/store.ts'
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
async function database() { const root = await mkdtemp(join(tmpdir(), 'assistant-skills-')); roots.push(root); return join(root, 'skills.sqlite') }

describe('SkillStore', () => {
  it('atomically deploys only a completed exact qualification and promotes after fresh successful canary evidence', () => {
    const store = new SkillStore(':memory:'); store.save(scope, definition())
    const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Improve.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    const comparison = store.claimComparison(scope, { sessionId: 'session', candidateId: candidate.id, parentDigest: candidate.parentDigest!, profileId: 'profile', profileDigest: 'd'.repeat(64), invocationId: 'qualified' }, 1).comparison
    const result = { qualified: true, gates: ['quality'] }; store.finishComparison(scope, comparison.id, 'complete', result)
    const input = { ownerRouteId: 'route', expiresAt: Date.now() + 60000, maxRuns: 2, canaryRuns: 1 }, receipt = { route: 'receipt' }
    expect(() => store.activateQualifiedCandidate(scope, candidate.id, comparison.id, 'e'.repeat(64), input, receipt)).toThrow(/qualification unavailable/)
    const active = store.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), input, receipt)
    expect(active).toMatchObject({ definition: { version: 2, parentVersion: 1 }, deployment: { state: 'canary', runIds: [] } })
    expect(store.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), input, receipt)).toEqual(active)
    const run = store.claim(scope, { invocationId: 'canary', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'goal-run' })
    expect(store.claim(scope, { invocationId: 'canary', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'goal-run' }).claimed).toBe(false)
    store.finish(scope, run.run.id, 'succeeded', [])
    expect(store.reconcileDeployment(scope, active.deployment.id)?.state).toBe('canary')
    store.observeWatch(scope, active.deployment.watchId, { runId: run.run.id, receiptDigest: 'f'.repeat(64), objectiveStatus: 'achieved', verifiedAt: Date.now(), validUntil: Date.now() + 60000 })
    expect(store.reconcileDeployment(scope, active.deployment.id)).toMatchObject({ state: 'promoted' })
    expect(store.assertDeploymentRun(scope, run.run.id)).toMatchObject({ id: active.deployment.id, state: 'promoted' })
    const second = store.claim(scope, { invocationId: 'promoted', goalId: 'second-goal', sessionId: 'second-session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'second-goal-run' })
    store.finish(scope, second.run.id, 'succeeded', [])
    expect(() => store.claim(scope, { invocationId: 'over-quota', goalId: 'third-goal', sessionId: 'third-session', skillName: 'read-report', version: 2, inputs: {} })).toThrow(/quota exhausted/)
    store.observeWatch(scope, active.deployment.watchId, { runId: second.run.id, receiptDigest: 'a'.repeat(64), objectiveStatus: 'not-achieved', verifiedAt: Date.now(), validUntil: Date.now() + 60000 })
    expect(store.reconcileDeployment(scope, active.deployment.id)?.state).toBe('blocked')
    expect(store.rollbackWatch(scope, active.deployment.watchId)?.state).toBe('rolled-back')
    expect(store.reconcileDeployment(scope, active.deployment.id)?.state).toBe('rolled-back')
    expect(store.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), input, receipt).deployment.state).toBe('rolled-back')
    expect(store.get(scope, 'read-report')?.version).toBe(3)
    store.close()
  })

  it.each(['failed', 'unknown', 'running'] as const)('keeps a deployed run debit across restart and blocks %s deployed work', async state => {
    const path = await database(), first = new SkillStore(path); first.save(scope, definition())
    const candidate = first.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Improve.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    const comparison = first.claimComparison(scope, { sessionId: 'session', candidateId: candidate.id, parentDigest: candidate.parentDigest!, profileId: 'profile', profileDigest: 'd'.repeat(64), invocationId: 'qualified' }, 1).comparison
    const result = { qualified: true }; first.finishComparison(scope, comparison.id, 'complete', result)
    const deployed = first.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), { ownerRouteId: 'route', expiresAt: Date.now() + 60000, maxRuns: 2, canaryRuns: 2 }, { route: 'receipt' })
    const run = first.claim(scope, { invocationId: 'debit', goalId: 'goal', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'goal-run' })
    if (state !== 'running') first.finish(scope, run.run.id, state, [])
    first.close()
    const restored = new SkillStore(path)
    expect(restored.getDeployment(scope, deployed.deployment.id)).toMatchObject({ runIds: [run.run.id], state: 'blocked' })
    expect(() => restored.claim(scope, { invocationId: 'later', goalId: 'other', sessionId: 'session', skillName: 'read-report', version: 2, inputs: {}, goalExecutionRunId: 'goal-run' })).toThrow(/deployment unavailable/)
    expect(() => restored.assertDeploymentRun(scope, run.run.id)).toThrow(/deployment unavailable/)
    restored.close()
  })

  it('rolls back a qualified activation when the deployment record cannot be inserted', async () => {
    const path = await database(), store = new SkillStore(path); store.save(scope, definition())
    const candidate = store.stageCandidate(scope, definition(), { expectedVersion: 1, reason: 'Improve.', trigger: 'owner', expiresAt: Date.now() + 60000 })
    const comparison = store.claimComparison(scope, { sessionId: 'session', candidateId: candidate.id, parentDigest: candidate.parentDigest!, profileId: 'profile', profileDigest: 'd'.repeat(64), invocationId: 'qualified' }, 1).comparison
    const result = { qualified: true }; store.finishComparison(scope, comparison.id, 'complete', result)
    const writer = new DatabaseSync(path)
    writer.exec("CREATE TRIGGER reject_deployment BEFORE INSERT ON skill_deployments BEGIN SELECT RAISE(ABORT, 'deployment storage unavailable'); END")
    expect(() => store.activateQualifiedCandidate(scope, candidate.id, comparison.id, acceptanceDigest(result), { ownerRouteId: 'route', expiresAt: Date.now() + 60000, maxRuns: 2, canaryRuns: 1 }, { route: 'receipt' })).toThrow(/deployment storage unavailable/)
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
