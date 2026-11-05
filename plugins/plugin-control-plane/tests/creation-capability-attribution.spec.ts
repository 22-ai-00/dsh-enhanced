import { describe, expect, it, vi } from 'vitest'
import { controlPlaneDigest } from '../src/store.js'
import { DEFAULT_MINIMUM_SAMPLES, inspectCreationCapabilityAvailabilityAttribution,
  type CreationCapabilityAttributionInput } from '../src/creation-capability-feedback.js'
import type { CreationCapabilityCallEvidence, CreationCapabilityRecord } from '../src/creation-capability-types.js'

const adoptedAt = 10_000
const now = 20_000
const owner = { authorityId: 'authority', authorityHash: 'a'.repeat(64), principalId: 'owner',
  principalRecordId: 'principal-row', principalVersion: 2, workspace: '/work', agentPreset: 'primary' }
const tool = { name: 'evolved_tool', originalName: 'read', description: '', parameters: {} }
const receipt = { protocol: 'dsh-created-capability-adoption/v2', planId: 'plan', adoptedAt,
  expiresAt: 100_000, artifactSha256: 'b'.repeat(64), schemaDigest: 'c'.repeat(64) }
const record = { planId: 'plan', status: 'active', receipt, tools: [tool] } as unknown as CreationCapabilityRecord
const receiptDigest = controlPlaneDigest(receipt)
const original = { subjectKind: 'foreground-turn' as const, subjectRef: 'trigger', version: 1,
  digest: 'd'.repeat(64), disposition: 'upsert' as const }
const binding = (inboxId: string) => ({ id: `${inboxId}-binding`, version: 3, generation: 4 })

type Status = 'achieved' | 'not-achieved'
interface Task {
  version: number
  disposition: 'upsert' | 'retract'
  status: Status
  dispatchedAt: number
  model?: { provider: string; model: string } | null
  judgement?: 'owner-feedback' | 'independent-verifier' | 'unresolved'
  subjectKind?: 'foreground-turn' | 'work-item'
}

function call(key: string, inboxId: string, dispatchedAt: number): CreationCapabilityCallEvidence {
  return { protocol: 'dsh-created-capability-call-evidence/v1', planId: 'plan', key, status: 'completed',
    attribution: 'foreground', toolAlias: tool.name, originalName: tool.originalName,
    receiptDigest, artifactSha256: receipt.artifactSha256, schemaDigest: receipt.schemaDigest,
    claimedAt: dispatchedAt + 10, settledAt: dispatchedAt + 20, foreground: { protocol: 'assistant-delivery/foreground-tool-call/v1',
      task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId, sessionId: 'session',
        scope: { workspace: owner.workspace, preset: owner.agentPreset },
        owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
        binding: binding(inboxId), dispatchedAt },
      turn: 1, call: { id: key, toolName: tool.name, eventSeq: 8, eventDigest: 'e'.repeat(64), argumentsDigest: 'f'.repeat(64) } } }
}

function fixture(calls: CreationCapabilityCallEvidence[] = []) {
  const tasks = new Map<string, Task>()
  const state = { scopeWatermark: 1 }
  const canonical = (inboxId: string, task: Task) => ({ triggerOutcomeId: `outcome-${inboxId}-${task.version}`,
    scopeWatermark: state.scopeWatermark, scope: {}, scopeKey: 'scope', situation: 's',
    projection: { subjectKind: task.subjectKind ?? 'foreground-turn', subjectRef: inboxId, version: task.version,
      digest: String(task.version).repeat(64), disposition: task.disposition }, objective: { status: task.status } })
  const learning = (inboxId: string, task: Task) => ({ protocol: 'assistant-delivery/owner-foreground-learning/v1' as const,
    owner: { ...owner, bindingVersion: 3, generation: 4 }, canonical: canonical(inboxId, task),
    judgement: task.judgement ?? 'owner-feedback', ownerRevision: { version: task.version, action: task.version > 1 ? 'correct' : 'initial' },
    source: { inboxId, sessionId: 'session', objective: 'secret task text', truncated: false, quiescent: true,
      modelSelectionState: task.model === null ? 'missing' : 'frozen',
      ...(task.model === null ? {} : { modelSelection: task.model ?? { provider: 'p', model: 'm' } }) } })
  const set = (inboxId: string, task: Partial<Task> & { dispatchedAt: number }) => {
    state.scopeWatermark++
    tasks.set(inboxId, { version: 1, disposition: 'upsert', status: 'achieved', ...task })
  }
  const delivery = {
    inspectOwnerForegroundLearningTask: vi.fn(({ outcomeId }: { outcomeId: string }) => {
      for (const [inboxId, task] of tasks) if (`outcome-${inboxId}-${task.version}` === outcomeId) return learning(inboxId, task)
      return undefined
    }),
    inspectOwnerForegroundTaskSource: vi.fn(({ inboxId }: { inboxId: string }): object | undefined => {
      const task = tasks.get(inboxId)
      return task && { authorityId: owner.authorityId, authorityHash: owner.authorityHash, principalId: owner.principalId,
        owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
        binding: { ...binding(inboxId), sessionId: 'session' },
        execution: { dispatchedAt: task.dispatchedAt, completedAt: task.dispatchedAt + 500, quiescent: true } }
    }),
  }
  const evaluation = {
    canonicalHostScope: vi.fn(() => ({ workspace: owner.workspace, preset: owner.agentPreset })),
    getTrustedForegroundLearningProjection: vi.fn(),
    withTrustedCanonicalTaskWriterFence: vi.fn(),
    listTrustedTaskLearningProjections: vi.fn(({ after, limit }: { after?: { watermark: number }; limit: number }) => {
      const items = [...tasks].map(([inboxId, task], index) => ({ watermark: index + 1, receipt: canonical(inboxId, task) }))
      const start = after?.watermark ?? 0
      const page = items.slice(start, start + limit)
      return { items: page, nextCursor: { scopeKey: 'scope', watermark: start + page.length },
        scopeWatermark: state.scopeWatermark, hasMore: start + page.length < items.length }
    }),
    withTrustedCanonicalScopeWriterFence: vi.fn((input: { scopeWatermark: number }, callback: () => unknown) =>
      input.scopeWatermark === state.scopeWatermark ? { matched: true, value: callback() } : { matched: false }),
  }
  const input: CreationCapabilityAttributionInput = { record, calls, triggerInboxId: 'trigger', owner,
    evaluation: evaluation as unknown as CreationCapabilityAttributionInput['evaluation'],
    delivery: delivery as unknown as CreationCapabilityAttributionInput['delivery'],
    readSourceCurrent: () => ({ projection: original, scopeWatermark: state.scopeWatermark }), now }
  return { input, tasks, set, state, delivery, evaluation }
}

/** n tasks in one arm with the given number achieved. */
function arm(f: ReturnType<typeof fixture>, prefix: string, at: number, total: number, achieved: number,
  extra: Partial<Task> = {}) {
  for (let index = 0; index < total; index++) {
    f.set(`${prefix}${index}`, { dispatchedAt: at + index, status: index < achieved ? 'achieved' : 'not-achieved', ...extra })
  }
}

const attribution = (f: ReturnType<typeof fixture>, extra: Partial<CreationCapabilityAttributionInput> = {}) =>
  inspectCreationCapabilityAvailabilityAttribution({ ...f.input, ...extra })

describe('created capability availability attribution', () => {
  it('splits every certified task at adoption into equal windows and reports an exact paired delta', () => {
    const f = fixture([call('x', 'after0', 15_000), call('y', 'after1', 15_001)])
    arm(f, 'before', 5_000, 5, 2)
    arm(f, 'after', 15_000, 6, 5)
    f.set('trigger', { dispatchedAt: 9_000, status: 'not-achieved' })
    f.set('old', { dispatchedAt: -1 })
    f.set('ancient', { dispatchedAt: adoptedAt - 10_001 })
    f.set('future', { dispatchedAt: now + 1 })
    const result = attribution(f)!
    expect(result).toMatchObject({ protocol: 'dsh-created-capability-availability-attribution/v1', causal: false,
      design: 'adoption-before-after-itt-model-stratified', planId: 'plan', receiptDigest,
      artifactSha256: receipt.artifactSha256, schemaDigest: receipt.schemaDigest, adoptionStatus: 'active',
      withinSignedUseWindow: true, minimumSamples: DEFAULT_MINIMUM_SAMPLES, windowMs: 10_000,
      scopeWatermark: f.state.scopeWatermark,
      population: { scanned: 15, counted: 11, excluded: { nonForeground: 0, trigger: 1, retracted: 0, unverified: 0, outsideWindow: 3 } },
      exposure: { afterTasks: 6, exposedTasks: 2 }, concurrentAdoptions: { status: 'none', count: 0 },
      direction: 'improved', regressions: { status: 'unmeasured' }, cost: { status: 'unmeasured' } })
    expect(result.strata).toEqual([{ model: { state: 'frozen', provider: 'p', model: 'm' },
      before: { quality: { status: 'measured', samples: 5, achieved: 2, notAchieved: 3 },
        taskLatency: { status: 'measured', samples: 5, p50Ms: 500, maxMs: 500 } },
      after: { quality: { status: 'measured', samples: 6, achieved: 5, notAchieved: 1 },
        taskLatency: { status: 'measured', samples: 6, p50Ms: 500, maxMs: 500 } },
      // 5/6 - 2/5 = (5*5 - 2*6) / (5*6)
      achievedRateDelta: { status: 'paired', numerator: 13, denominator: 30, sign: 1 } }])
    expect(Object.isFrozen(result) && Object.isFrozen(result.strata[0]!.achievedRateDelta)).toBe(true)
  })

  it('places a task dispatched exactly at adoption before it, matching the strict call admission rule', () => {
    const f = fixture()
    f.set('edge', { dispatchedAt: adoptedAt })
    f.set('next', { dispatchedAt: adoptedAt + 1 })
    const result = attribution(f, { minimumSamples: 1 })!
    expect(result.strata[0]).toMatchObject({ before: { quality: { samples: 1 } }, after: { quality: { samples: 1 } } })
  })

  it('uses the latest corrected head and excludes withdrawn retractions and uncertified judgements', () => {
    const f = fixture()
    arm(f, 'before', 5_000, 2, 2)
    arm(f, 'after', 15_000, 2, 0)
    expect(attribution(f, { minimumSamples: 2 })!.strata[0]!.achievedRateDelta).toEqual({ status: 'paired',
      numerator: -4, denominator: 4, sign: -1 })
    f.set('after0', { dispatchedAt: 15_000, version: 2, status: 'achieved' })
    f.set('after1', { dispatchedAt: 15_001, version: 2, status: 'achieved' })
    const corrected = attribution(f, { minimumSamples: 2 })!
    expect(corrected.strata[0]!.achievedRateDelta).toEqual({ status: 'paired', numerator: 0, denominator: 4, sign: 0 })
    expect(corrected.direction).toBe('unchanged')
    f.set('before1', { dispatchedAt: 5_001, version: 3, disposition: 'retract' })
    f.set('unresolved', { dispatchedAt: 5_002, judgement: 'unresolved' })
    f.set('work', { dispatchedAt: 5_003, subjectKind: 'work-item' })
    const withdrawn = attribution(f, { minimumSamples: 2 })!
    expect(withdrawn).toMatchObject({ direction: 'insufficient', population: { counted: 3,
      excluded: { nonForeground: 1, retracted: 1, unverified: 1 } } })
    expect(withdrawn.strata[0]!.achievedRateDelta).toEqual({ status: 'insufficient' })
  })

  it('never pools across models and reports mixed signs', () => {
    const f = fixture()
    const other = { provider: 'q', model: 'n' }
    arm(f, 'pb', 5_000, 1, 0)
    arm(f, 'pa', 15_000, 1, 1)
    arm(f, 'qb', 5_100, 1, 1, { model: other })
    arm(f, 'qa', 15_100, 1, 0, { model: other })
    arm(f, 'mb', 5_200, 1, 1, { model: null })
    const result = attribution(f, { minimumSamples: 1 })!
    expect(result.strata.map(item => [item.model, item.achievedRateDelta])).toEqual([
      [{ state: 'frozen', provider: 'p', model: 'm' }, { status: 'paired', numerator: 1, denominator: 1, sign: 1 }],
      [{ state: 'frozen', provider: 'q', model: 'n' }, { status: 'paired', numerator: -1, denominator: 1, sign: -1 }],
      [{ state: 'missing' }, { status: 'insufficient' }]])
    expect(result.direction).toBe('mixed')
  })

  it('clamps the window to elapsed signed use and flags concurrent adoptions', () => {
    const f = fixture()
    f.set('one', { dispatchedAt: adoptedAt - 3_000 })
    expect(attribution(f, { windowMs: 2_000, otherAdoptedAt: [adoptedAt - 2_000, adoptedAt + 2_001, adoptedAt + 1_000] }))
      .toMatchObject({ windowMs: 2_000, population: { excluded: { outsideWindow: 1 } },
        concurrentAdoptions: { status: 'flagged', count: 2 } })
    expect(attribution(f, { windowMs: 50_000 })?.windowMs).toBe(10_000)
    expect(attribution(f, { now: adoptedAt })).toMatchObject({ windowMs: 0, population: { counted: 0 },
      concurrentAdoptions: { count: 0 }, direction: 'insufficient' })
    expect(attribution(f, { now: 200_000 })).toMatchObject({ windowMs: 90_000, withinSignedUseWindow: false })
  })

  it('pages the full scope, keeps one scope watermark, and fails closed when oversized', () => {
    const f = fixture()
    arm(f, 'b', 1_000, 120, 60)
    const result = attribution(f)!
    expect(result.population.scanned).toBe(120)
    expect(f.evaluation.listTrustedTaskLearningProjections).toHaveBeenCalledTimes(2)
    expect(attribution(f, { maxScannedHeads: 119 })).toBeUndefined()
    const page = f.evaluation.listTrustedTaskLearningProjections.getMockImplementation()!
    let first = true
    f.evaluation.listTrustedTaskLearningProjections.mockImplementation(argument => {
      const value = page(argument)
      if (first) { first = false; f.state.scopeWatermark++ }
      return value
    })
    expect(attribution(f)).toBeUndefined()
  })

  it('returns undefined for a missing receipt, a changed scope, a changed source inside the fence or a dead trigger', () => {
    const f = fixture()
    f.set('one', { dispatchedAt: 15_000 })
    expect(attribution(f, { record: { ...record, receipt: undefined } as unknown as CreationCapabilityRecord })).toBeUndefined()
    f.evaluation.withTrustedCanonicalScopeWriterFence.mockImplementationOnce(() => ({ matched: false }))
    expect(attribution(f)).toBeUndefined()
    f.evaluation.withTrustedCanonicalScopeWriterFence.mockImplementationOnce((_input, callback) => {
      f.tasks.get('one')!.model = { provider: 'q', model: 'n' }; return { matched: true, value: callback() }
    })
    expect(attribution(f)).toBeUndefined()
    expect(attribution(f, { readSourceCurrent: () => ({ projection: { ...original, disposition: 'retract' }, scopeWatermark: 1 }) }))
      .toBeUndefined()
    expect(attribution(f)?.strata[0]?.model).toEqual({ state: 'frozen', provider: 'q', model: 'n' })
  })

  it('leaks no task content or Inbox identifiers and rejects malformed parameters', () => {
    const f = fixture([call('x', 'inbox-secret', 15_000)])
    f.set('inbox-secret', { dispatchedAt: 15_000 })
    const result = attribution(f)!
    expect(result.exposure).toEqual({ afterTasks: 1, exposedTasks: 1 })
    expect(JSON.stringify(result)).not.toMatch(/secret|objective|session|outcome-/)
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => attribution(f, { minimumSamples: bad })).toThrow(TypeError)
      expect(() => attribution(f, { windowMs: bad })).toThrow(TypeError)
      expect(() => attribution(f, { maxScannedHeads: bad })).toThrow(TypeError)
    }
  })
})
