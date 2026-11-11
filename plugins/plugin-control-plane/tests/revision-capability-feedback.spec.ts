import { createHash } from 'node:crypto'
import { normalizeForegroundToolArguments } from '@dsh-enhanced/assistant-delivery'
import { describe, expect, test, vi } from 'vitest'
import { revisionCallArgumentsDigest } from '../src/revision-capability-journal.js'
import type { EvaluationCanonicalLearningEvidenceTuple } from '@dsh-enhanced/assistant-evaluation'
import { revisionBenefitContractDigest, type RevisionBenefitContract } from '@dsh-enhanced/assistant-growth-contract'
import { evaluateRevisionBenefitEvidence, inspectRevisionCapabilityBenefitWindow,
  revisionBenefitPairedWindows, revisionBenefitWindowsArePaired, mergeRevisionBenefitWindows,
  revisionBenefitObservationDeadline, autoRollbackInferiorRevision } from '../src/revision-capability-feedback.js'
import type { RevisionCapabilityBenefitSample, RevisionCapabilityCallEvidence } from '../src/revision-capability-types.js'

const d = (value: string) => value.repeat(64)
const now = 20_000
const owner = { authorityId: 'authority', authorityHash: d('a'), principalId: 'owner',
  principalRecordId: 'principal-row', principalVersion: 2, workspace: '/work', agentPreset: 'primary' }
const tool = { name: 'evolved_rsi_revision_0', originalName: 'read_test', description: '', parameters: {} }
const version: RevisionCapabilityBenefitSample['version'] = { planId: 'revision-plan', entryId: 'entry-1',
  role: 'revision', name: 'rsi-revision-tool', adoptedAt: 10_000, expiresAt: 100_000,
  receiptDigest: d('1'), artifactSha256: d('2'), schemaDigest: d('3'), tools: [tool] }

function call(key: string, inboxId: string, sessionId = 'session-1', claimedAt = 11_000,
  status: RevisionCapabilityCallEvidence['status'] = 'completed'): RevisionCapabilityCallEvidence {
  return { protocol: 'dsh-created-capability-revision-call/v1', entryId: 'entry-1', key,
    versionPlanId: version.planId, toolAlias: tool.name, status, attribution: 'foreground',
    originalName: tool.originalName, receiptDigest: version.receiptDigest,
    artifactSha256: version.artifactSha256, schemaDigest: version.schemaDigest, role: 'revision',
    adoptedAt: version.adoptedAt, expiresAt: version.expiresAt, claimedAt, settledAt: claimedAt + 500,
    foreground: { protocol: 'assistant-delivery/foreground-tool-call/v1',
      task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId, sessionId,
        scope: { workspace: owner.workspace, preset: owner.agentPreset },
        owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
        binding: { id: 'binding-' + inboxId, version: 3, generation: 4 }, dispatchedAt: claimedAt - 100 },
      turn: 1, call: { id: key, toolName: tool.name, eventSeq: 8, eventDigest: d('e'), argumentsDigest: d('f') } } }
}
function learning(inboxId: string, sessionId: string, status: 'achieved' | 'not-achieved' = 'achieved',
  revision: 'initial' | 'correct' | 'withdraw' = 'initial') {
  const projection = { subjectKind: 'foreground-turn' as const, subjectRef: inboxId, version: 1,
    digest: d('4'), disposition: 'upsert' as const }
  return { protocol: 'assistant-delivery/owner-foreground-learning/v1' as const,
    owner: { ...owner, bindingVersion: 3, generation: 4 },
    canonical: { triggerOutcomeId: 'outcome-' + inboxId, scopeWatermark: 1, projection,
      objective: { outcomeId: 'objective-' + inboxId, status } },
    judgement: 'owner-feedback' as const, ownerRevision: { version: 1, action: revision },
    source: { inboxId, sessionId, objective: 'secret task text', truncated: false, quiescent: true,
      modelSelectionState: 'frozen' as const, modelSelection: { provider: 'p', model: 'm' } } }
}
function fixture(calls: RevisionCapabilityCallEvidence[]) {
  const heads = new Map<string, ReturnType<typeof learning>>()
  for (const item of calls) if (item.foreground) heads.set(item.foreground.task.inboxId,
    learning(item.foreground.task.inboxId, item.foreground.task.sessionId))
  const executions = new Map<string, { dispatchedAt: number; completedAt: number; quiescent: boolean }>()
  for (const item of calls) if (item.foreground) executions.set(item.foreground.task.inboxId,
    { dispatchedAt: 10_800, completedAt: 11_600, quiescent: true })
  const projection: EvaluationCanonicalLearningEvidenceTuple = { subjectKind: 'foreground-turn',
    subjectRef: 'trigger', version: 1, digest: d('5'), disposition: 'upsert' }
  const evaluation = {
    canonicalHostScope: vi.fn(() => ({ workspace: owner.workspace, preset: owner.agentPreset })),
    getTrustedForegroundLearningProjection: vi.fn(({ inboxId }: { inboxId: string }) => heads.get(inboxId)?.canonical),
    withTrustedCanonicalTaskWriterFence: vi.fn((input: { evidence: readonly { subjectRef: string }[] },
      callback: () => unknown) => input.evidence.length === 0 ? { matched: true, value: callback() }
        : { matched: true, value: callback() }),
    inspectTrustedOutcomeMetrics: vi.fn(() => ({ inputTokens: 10, outputTokens: 5 })),
  }
  const delivery = {
    inspectOwnerForegroundLearningTask: vi.fn(({ outcomeId }: { outcomeId: string }) =>
      [...heads.values()].find(item => item.canonical.triggerOutcomeId === outcomeId)),
    inspectOwnerForegroundTaskSource: vi.fn(({ inboxId }: { inboxId: string }) => {
      const task = calls.find(item => item.foreground?.task.inboxId === inboxId)?.foreground?.task
      return task === undefined ? undefined : { authorityId: owner.authorityId, authorityHash: owner.authorityHash,
        principalId: owner.principalId, owner: { principalRecordId: owner.principalRecordId,
          principalVersion: owner.principalVersion },
        binding: { id: task.binding.id, version: task.binding.version, generation: task.binding.generation,
          sessionId: task.sessionId }, execution: executions.get(inboxId) }
    }),
  }
  const sample: RevisionCapabilityBenefitSample = { version, calls }
  const input = { sample, windowStart: 10_000, windowEnd: 13_000, owner,
    evaluation: evaluation as never, delivery: delivery as never, now }
  return { input, heads, execution: executions, evaluation, delivery, projection }
}

describe('revision capability benefit windows', () => {
  test('aggregates only completed foreground calls inside the window from the exact version', () => {
    const f = fixture([call('a', 'one'), call('b', 'two'), call('c', 'failed'), call('d', 'corrected'),
      call('e', 'late', 'session-1', 15_000), call('f', 'unknown', 'session-1', 12_000, 'unknown')])
    f.heads.set('failed', learning('failed', 'session-1', 'not-achieved'))
    f.heads.set('corrected', learning('corrected', 'session-1', 'achieved', 'correct'))
    const stats = inspectRevisionCapabilityBenefitWindow(f.input)!
    expect(stats).toMatchObject({ artifactSha256: version.artifactSha256, windowStart: 10_000, windowEnd: 13_000,
      taskRevisions: 4, correctedOrWithdrawn: 1, failed: 1, reworked: 0, latencyMsTotal: 2_400, tokensTotal: 45 })
  })
  test('excludes unattributed, wrong-version, tampered and mixed-session evidence', () => {
    const { foreground: _foreground, ...unattributedCall } = call('u', 'one')
    const unattributed = { ...unattributedCall, attribution: 'unattributed' as const }
    const wrong = { ...call('w', 'one'), artifactSha256: d('9') }
    const f = fixture([unattributed, wrong])
    expect(inspectRevisionCapabilityBenefitWindow(f.input)).toMatchObject({ taskRevisions: 0,
      correctedOrWithdrawn: 0, failed: 0, tokensTotal: 0 })
    const mixed = fixture([call('a', 'same'), call('b', 'same', 'other-session')])
    expect(inspectRevisionCapabilityBenefitWindow(mixed.input)).toBeUndefined()
    const tamper = fixture([call('a', 'one')])
    tamper.delivery.inspectOwnerForegroundLearningTask.mockReturnValueOnce({ ...learning('one', 'session-1'),
      owner: { ...learning('one', 'session-1').owner, principalVersion: 3 } })
    expect(inspectRevisionCapabilityBenefitWindow(tamper.input)).toBeUndefined()
  })
  test('windows are equal-length, adjacent and bounded', () => {
    const sample = (overrides: Partial<typeof version>): RevisionCapabilityBenefitSample =>
      ({ version: { ...version, ...overrides }, calls: [] })
    const parent = { adoptedAt: 8_000, expiresAt: 100_000 }
    expect(revisionBenefitPairedWindows({ candidate: sample({}), parent, now })).toEqual({
      parent: { start: 8_000, end: 10_000 }, candidate: { start: 10_000, end: 12_000 } })
    expect(revisionBenefitWindowsArePaired({ start: 8_000, end: 10_000 }, { start: 10_000, end: 12_000 })).toBe(true)
    expect(revisionBenefitWindowsArePaired({ start: 8_000, end: 10_000 }, { start: 11_000, end: 13_000 })).toBe(false)
    expect(revisionBenefitWindowsArePaired({ start: 8_000, end: 10_000 }, { start: 10_000, end: 14_000 })).toBe(false)
    expect(revisionBenefitPairedWindows({ candidate: sample({ adoptedAt: 30_000 }), parent, now })).toBeUndefined()
    expect(revisionBenefitPairedWindows({ candidate: sample({}), parent: { ...parent, adoptedAt: 10_000 }, now }))
      .toBeUndefined()
    const merged = mergeRevisionBenefitWindows({
      protocol: 'assistant-growth/revision-benefit-window/v1', artifactSha256: d('1'), windowStart: 1, windowEnd: 2,
      taskRevisions: 2, correctedOrWithdrawn: 1, failed: 1, reworked: 0,
      latencyMsTotal: 10, tokensTotal: 20, inputTokensTotal: 12, outputTokensTotal: 8,
    }, {
      protocol: 'assistant-growth/revision-benefit-window/v1', artifactSha256: d('2'), windowStart: 1, windowEnd: 2,
      taskRevisions: 1, correctedOrWithdrawn: 0, failed: 0, reworked: 0,
      latencyMsTotal: 5, tokensTotal: 10, inputTokensTotal: 6, outputTokensTotal: 4,
    })!
    expect(merged).toMatchObject({ taskRevisions: 3, correctedOrWithdrawn: 1, failed: 1,
      latencyMsTotal: 15, tokensTotal: 30 })
  })
})

const contract = (overrides: Partial<RevisionBenefitContract> = {}): RevisionBenefitContract => ({
  protocol: 'assistant-growth/revision-benefit-contract/v1', model: { provider: 'p', model: 'm' },
  budget: { budgetId: 'b', amount: 1 }, minimumTaskRevisions: 2,
  thresholds: { maxFailureRateDelta: 0, maxReworkRateDelta: 0, maxCorrectionRateDelta: 0,
    maxLatencyRatio: 2, maxCostRatio: 2 }, createdAt: 1, expiresAt: 100_000, ...overrides })
const parentVersion = { adoptedAt: 8_000, expiresAt: 100_000 }
const pairedFor = (sample: RevisionCapabilityBenefitSample) =>
  revisionBenefitPairedWindows({ candidate: sample, parent: parentVersion, now })!
const parentStats = (windows: { parent: { start: number; end: number } }) =>
  ({ protocol: 'assistant-growth/revision-benefit-window/v1' as const, artifactSha256: d('6'),
    windowStart: windows.parent.start, windowEnd: windows.parent.end, taskRevisions: 2,
    correctedOrWithdrawn: 0, failed: 0, reworked: 0,
    latencyMsTotal: 2_000, tokensTotal: 30, inputTokensTotal: 20, outputTokensTotal: 10 })

describe('revision benefit evaluation', () => {
  test('records non-inferior for a paired parent/candidate window and inferior for a failing candidate', () => {
    const passing = fixture([call('a', 'one'), call('b', 'two')])
    const windows = pairedFor(passing.input.sample)
    const result = evaluateRevisionBenefitEvidence({ contract: contract(), parent: parentStats(windows) as never,
      windows, candidate: passing.input.sample, owner, evaluation: passing.evaluation as never,
      delivery: passing.delivery as never, now })!
    expect(result.evaluation.verdict).toEqual({ status: 'non-inferior', reason: 'all-metrics-within-thresholds' })
    expect(result.contractDigest).toBe(revisionBenefitContractDigest(contract()))
    expect(result.candidate).toMatchObject({ taskRevisions: 2, failed: 0 })
    const failing = fixture([call('a', 'one'), call('b', 'two')])
    const failingWindows = pairedFor(failing.input.sample)
    failing.heads.set('one', learning('one', 'session-1', 'not-achieved'))
    const inferior = evaluateRevisionBenefitEvidence({ contract: contract(), parent: parentStats(failingWindows) as never,
      windows: failingWindows, candidate: failing.input.sample, owner, evaluation: failing.evaluation as never,
      delivery: failing.delivery as never, now })!
    expect(inferior.evaluation.verdict).toMatchObject({ status: 'inferior', reason: 'failure-rate' })
  })
  test('refuses unpaired windows or statistics that do not match the pair', () => {
    const passing = fixture([call('a', 'one'), call('b', 'two')])
    expect(evaluateRevisionBenefitEvidence({ contract: contract(), parent: parentStats(pairedFor(passing.input.sample)) as never,
      windows: { parent: { start: 1, end: 2 }, candidate: { start: 1_000, end: 10_000 } },
      candidate: passing.input.sample, owner, evaluation: passing.evaluation as never,
      delivery: passing.delivery as never, now })).toBeUndefined()
    const windows = pairedFor(passing.input.sample)
    expect(evaluateRevisionBenefitEvidence({ contract: contract(),
      parent: { ...parentStats(windows), windowStart: windows.parent.start - 1 } as never,
      windows, candidate: passing.input.sample, owner, evaluation: passing.evaluation as never,
      delivery: passing.delivery as never, now })).toBeUndefined()
  })
  test('post-adoption parent calls stay outside this pair and enter only a later candidate baseline', () => {
    const parentVersion = { adoptedAt: 8_000, expiresAt: 100_000 }
    const sample = (planId: string, adoptedAt: number, calls: RevisionCapabilityCallEvidence[]) =>
      ({ version: { ...version, planId, adoptedAt }, calls })
    const parentCall = (key: string, inboxId: string, claimedAt: number) => {
      const base = call(key, inboxId)
      return { ...base, versionPlanId: 'parent-plan', role: 'parent' as const,
        adoptedAt: parentVersion.adoptedAt, expiresAt: parentVersion.expiresAt,
        claimedAt, settledAt: claimedAt + 500,
        foreground: { ...base.foreground!, task: { ...base.foreground!.task, dispatchedAt: claimedAt - 100 } } }
    }
    const parentCalls = [parentCall('p1', 'p-one', 9_000), parentCall('p2', 'p-two', 9_400)]
    const candidateCalls = [call('c1', 'c-one'), call('c2', 'c-two')]
    // Calls made by the parent version after the first adoption: 20_500.
    const lateParentCall = parentCall('p3', 'p-three', 20_500)
    const first = revisionBenefitPairedWindows({ candidate: sample('revision-plan-a', 10_000, candidateCalls),
      parent: parentVersion, now: 20_000 })!
    expect(first.parent).toEqual({ start: 8_000, end: 10_000 })
    expect(first.candidate).toEqual({ start: 10_000, end: 12_000 })
    // The late call is outside the first pair, so it cannot leak into that window.
    const firstParent = fixture([...parentCalls, lateParentCall])
    firstParent.input.sample.version = { ...version, planId: 'parent-plan', role: 'parent',
      adoptedAt: parentVersion.adoptedAt, expiresAt: parentVersion.expiresAt }
    const firstParentStats = inspectRevisionCapabilityBenefitWindow({ ...firstParent.input,
      windowStart: first.parent.start, windowEnd: first.parent.end })!
    expect(firstParentStats.taskRevisions).toBe(2)
    // A later candidate adoption re-anchors the pair; the same late call is now
    // inside the parent baseline window.
    const second = revisionBenefitPairedWindows({ candidate: sample('revision-plan-b', 30_000, candidateCalls),
      parent: { adoptedAt: 10_000, expiresAt: 100_000 }, now: 40_000 })!
    expect(second.parent).toEqual({ start: 20_000, end: 30_000 })
    expect(second.candidate).toEqual({ start: 30_000, end: 40_000 })
    expect(lateParentCall.claimedAt).toBeGreaterThanOrEqual(second.parent.start)
  })
  test('stays insufficient for too few samples or unmeasured cost and latency', () => {
    const few = fixture([call('a', 'one')])
    const fewWindows = pairedFor(few.input.sample)
    expect(evaluateRevisionBenefitEvidence({ contract: contract(), parent: parentStats(fewWindows) as never,
      windows: fewWindows, candidate: few.input.sample, owner, evaluation: few.evaluation as never,
      delivery: few.delivery as never, now })!.evaluation.verdict)
      .toEqual({ status: 'insufficient', reason: 'below-minimum-samples' })
    const unmeasured = fixture([call('a', 'one'), call('b', 'two')])
    const unmeasuredWindows = pairedFor(unmeasured.input.sample)
    unmeasured.evaluation.inspectTrustedOutcomeMetrics.mockReturnValue(undefined as never)
    expect(evaluateRevisionBenefitEvidence({ contract: contract(), parent: parentStats(unmeasuredWindows) as never,
      windows: unmeasuredWindows, candidate: unmeasured.input.sample, owner, evaluation: unmeasured.evaluation as never,
      delivery: unmeasured.delivery as never, now })!.evaluation.verdict)
      .toEqual({ status: 'insufficient', reason: 'cost-or-latency-unmeasured' })
  })
})

describe('negative benefit rollback decision', () => {
  const runtime = (currentPlanId = 'revision-plan') => ({
    listEntries: () => [{ entryId: 'entry-1', currentPlanId }],
    inspectEntry: () => ({ currentPlanId }),
    rollback: vi.fn(async () => ({ fromPlanId: currentPlanId, toPlanId: 'parent-plan' })),
  })
  test('only a pinned post-window inferior outcome performs the exact CAS rollback', async () => {
    const rollback = vi.fn(async (_input: unknown) => ({ fromPlanId: 'revision-plan', toPlanId: 'parent-plan' }))
    const target = runtime()
    const base = { runtime: target, planId: 'revision-plan', benefitConfigured: true,
      pinnedContractDigest: d('1'), growthRunCreatedAt: 1_000, observeWindowMs: 0, now: 10_000,
      rollback: (_runtime: unknown, input: { entryId: string; expectedCurrentPlanId: string }) => rollback(input) }
    expect(await autoRollbackInferiorRevision({ ...base, outcome: undefined })).toMatchObject({ rolledBack: false, reason: 'outcome-missing' })
    expect(await autoRollbackInferiorRevision({ ...base, outcome: { contractDigest: d('2'), status: 'inferior', reason: 'failure-rate' } }))
      .toMatchObject({ rolledBack: false, reason: 'outcome-missing' })
    expect(await autoRollbackInferiorRevision({ ...base, outcome: { contractDigest: d('1'), status: 'non-inferior', reason: 'ok' } }))
      .toMatchObject({ rolledBack: false, reason: 'outcome:non-inferior' })
    expect(await autoRollbackInferiorRevision({ ...base, observeWindowMs: 60_000,
      outcome: { contractDigest: d('1'), status: 'inferior', reason: 'failure-rate' } }))
      .toMatchObject({ rolledBack: false, reason: 'observation-open' })
    expect(await autoRollbackInferiorRevision({ ...base, observationDeadline: 5_000, outcome: undefined }))
      .toMatchObject({ rolledBack: true, reason: 'observation-expired-unverified' })
    expect(await autoRollbackInferiorRevision({ ...base, observationDeadline: 5_000,
      outcome: { contractDigest: d('1'), status: 'non-inferior', reason: 'ok' } }))
      .toMatchObject({ rolledBack: false, reason: 'outcome:non-inferior' })
    // A terminal decision may only act on the pinned contract digest; a foreign
    // outcome never authorizes a rollback.
    const rollbacksBefore = rollback.mock.calls.length
    expect(await autoRollbackInferiorRevision({ ...base, observationDeadline: 5_000,
      outcome: { contractDigest: d('2'), status: 'inferior', reason: 'failure-rate' } }))
      .toMatchObject({ rolledBack: false, reason: 'outcome-contract-mismatch' })
    expect(rollback).toHaveBeenCalledTimes(rollbacksBefore)
    expect(await autoRollbackInferiorRevision({ ...base,
      outcome: { contractDigest: d('1'), status: 'inferior', reason: 'failure-rate' } }))
      .toMatchObject({ rolledBack: true, reason: 'failure-rate' })
    expect(rollback).toHaveBeenCalledWith({ entryId: 'entry-1', expectedCurrentPlanId: 'revision-plan' })
    expect(await autoRollbackInferiorRevision({ ...base, runtime: runtime('other-plan'),
      outcome: { contractDigest: d('1'), status: 'inferior', reason: 'failure-rate' } }))
      .toMatchObject({ rolledBack: false, reason: 'entry-not-found' })
  })
})

test('observation deadline is the paired candidate window end, not a lifetime cap', () => {
  const parent = { adoptedAt: 8_000, expiresAt: 100_000 }
  const sample = { version: { ...version, adoptedAt: 10_000, expiresAt: 100_000 }, calls: [] }
  const windows = revisionBenefitPairedWindows({ candidate: sample, parent, now: 20_000 })!
  expect(revisionBenefitObservationDeadline({ candidate: sample, parent, now: 20_000 })).toBe(windows.candidate.end)
  expect(windows.candidate.end).toBe(12_000)
  // A lifetime-only cap would have returned 100_000.
  expect(revisionBenefitObservationDeadline({ candidate: sample, parent, now: 20_000 })).not.toBe(sample.version.expiresAt)
})

test('revision journal digest matches real Delivery argument normalization for reordered keys', () => {
  const raw = '{"z":1,"a":{"y":2,"b":3},"m":[1,2]}'
  const normalized = normalizeForegroundToolArguments(raw)!
  const args: unknown = JSON.parse(raw)
  expect(revisionCallArgumentsDigest(args)).toBe(createHash('sha256').update(normalized).digest('hex'))
  // A canonical key-sorted serializer would differ, which is exactly the bug
  // this parity test guards.
  const sorted = JSON.stringify(Object.fromEntries(Object.entries(args as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
  expect(sorted).not.toBe(normalized)
})
