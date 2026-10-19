import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { acceptanceDigest, createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { GoalOutcomeRuntime } from '../src/outcome.ts'
import { GoalOutcomeStore } from '../src/outcome-store.ts'
import { renderCompactGoalContext } from '../src/service.ts'
import type { GoalRecord } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

test('shows an independently failed prior assessment beside the current pending assessment without completing the goal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-settlement-compat-'))
  roots.push(root)
  const now = Date.now() - 1_000
  const objective = 'Repair the whole-goal report'
  const definition = { version: 1, digest: acceptanceDigest({ objective }), objective }
  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, preset: 'primary' }
  const record: GoalRecord = { id: 'goal-a', scope, originalObjective: objective, definition,
    native: { sessionId: 'session-a', goalId: 'native-a', revision: 1, objective, phase: 'active', roundsStarted: 2, maxGoalRounds: 3, updatedAt: now },
    checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: now, updatedAt: now }
  const acceptance = (assessmentId: string, issuedAt: number) => createTaskAcceptanceContract({
    protocol: 'task-acceptance/v3', id: `contract-${assessmentId}`,
    scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: scope.principalRecordId, principalVersion: 1 },
    task: { kind: 'goal-outcome', ref: assessmentId, goal: { id: record.id, definitionVersion: 1, definitionDigest: definition.digest,
      assessmentId, sessionId: record.native.sessionId, nativeGoalId: record.native.goalId } },
    objective, profile: { id: 'whole-goal', version: 1, digest: 'a'.repeat(64) }, issuedAt, expiresAt: now + 60_000,
    criteria: [{ id: 'report', kind: 'document-citations', authority: { id: 'sources', digest: 'b'.repeat(64) },
      artifactPath: 'report.md', requiredText: ['Confirmed result'], quotes: [] }],
    bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
  })
  const previous = acceptance('assessment-previous', now)
  const current = acceptance('assessment-current', now + 10)
  const receipt = createTaskVerificationReceipt(previous, { protocol: 'task-verification/v3', id: 'receipt-previous',
    contractId: previous.id, contractDigest: previous.digest, scope: previous.scope, owner: previous.owner, task: previous.task,
    results: [{ criterionId: 'report', status: 'failed', reason: 'required-text-missing', evidence: [] }],
    startedAt: now + 2, completedAt: now + 3, validUntil: now + 50_000 })
  const path = join(root, 'outcome.sqlite')
  const store = new GoalOutcomeStore(path)
  const definitionInput = store.bind({ scope, goalId: record.id, definition, sessionId: record.native.sessionId,
    nativeGoalId: record.native.goalId, template: previous })
  store.prepare(definitionInput, previous)
  store.markDispatched('assessment-previous', now + 1)
  store.finish('assessment-previous', { status: 'succeeded', quiescent: true, completedAt: now + 2 })
  store.prepare(definitionInput, current)
  store.close()

  const registration = { prepareGoalAssessment: () => undefined }
  const complete = vi.fn()
  const verifier = { ownsTaskAcceptanceRegistration: (value: unknown) => value === registration,
    inspectAcceptedTask: (id: string) => id === previous.id ? { contract: previous, receipt,
      execution: { status: 'succeeded', quiescent: true, completedAt: now + 2, executionRef: previous.task.ref } } : null }
  let dispose: (() => void) | undefined
  const ctx = { on: () => () => {}, effect: (callback: () => () => void) => { dispose = callback() },
    get: (name: string) => name === 'assistantVerifier' ? verifier : name === 'goals' ? { complete } : undefined }
  const runtime = new GoalOutcomeRuntime(ctx as never, path, () => record, () => [], 5_000, () => {})
  try {
    runtime.register(registration as never)
    expect(runtime.view(record)).toMatchObject({ status: 'pending', assessmentId: 'assessment-current' })
    expect(runtime.viewLatestSettled(record)).toMatchObject({ status: 'not-achieved', assessmentId: 'assessment-previous',
      criteria: [{ id: 'report', status: 'failed', reason: 'required-text-missing' }] })
    const context = renderCompactGoalContext(record, undefined, runtime.view(record), 4_096, undefined, runtime.viewLatestSettled(record))
    expect(context).toContain('"wholeGoal":&#123;"status":"not-achieved"')
    expect(context).toContain('"currentAssessment":&#123;"status":"pending","assessmentId":"assessment-current"')
    expect(runtime.reconcileCompletion({} as never)).toBe(false)
    expect(complete).not.toHaveBeenCalled()
  } finally { dispose?.() }
})
