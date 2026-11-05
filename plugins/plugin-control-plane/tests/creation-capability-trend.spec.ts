import { describe, expect, it, vi } from 'vitest'
import { controlPlaneDigest } from '../src/store.js'
import { DEFAULT_MINIMUM_SAMPLES, TREND_ASSUMPTIONS, TREND_DEFAULT_WINDOW_MS, inspectCreationCapabilityOrdinaryUseTrend,
  type CreationCapabilityTrendInput } from '../src/creation-capability-feedback.js'
import type { CreationCapabilityCallEvidence, CreationCapabilityRecord } from '../src/creation-capability-types.js'

const H = 60 * 60 * 1000
const adoptedAt = 1_000 * H
const now = adoptedAt + 3 * H
const owner = { authorityId: 'authority', authorityHash: 'a'.repeat(64), principalId: 'owner',
  principalRecordId: 'principal-row', principalVersion: 2, workspace: '/work', agentPreset: 'primary' }
const tool = { name: 'evolved_tool', originalName: 'read', description: '', parameters: {} }
const receipt = { protocol: 'dsh-created-capability-adoption/v2', planId: 'plan', adoptedAt,
  expiresAt: adoptedAt + 1_000 * H, artifactSha256: 'b'.repeat(64), schemaDigest: 'c'.repeat(64) }
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
  session: string
  model?: { provider: string; model: string }
}

function call(key: string, inboxId: string, dispatchedAt: number, sessionId: string): CreationCapabilityCallEvidence {
  return { protocol: 'dsh-created-capability-call-evidence/v1', planId: 'plan', key, status: 'completed',
    attribution: 'foreground', toolAlias: tool.name, originalName: tool.originalName,
    receiptDigest, artifactSha256: receipt.artifactSha256, schemaDigest: receipt.schemaDigest,
    claimedAt: dispatchedAt + 10, settledAt: dispatchedAt + 20, foreground: { protocol: 'assistant-delivery/foreground-tool-call/v1',
      task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId, sessionId,
        scope: { workspace: owner.workspace, preset: owner.agentPreset },
        owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
        binding: binding(inboxId), dispatchedAt },
      turn: 1, call: { id: key, toolName: tool.name, eventSeq: 8, eventDigest: 'e'.repeat(64), argumentsDigest: 'f'.repeat(64) } } }
}

function fixture() {
  const tasks = new Map<string, Task>()
  const calls: CreationCapabilityCallEvidence[] = []
  const state = { scopeWatermark: 1 }
  const canonical = (inboxId: string, task: Task) => ({ triggerOutcomeId: `outcome-${inboxId}-${task.version}`,
    scopeWatermark: state.scopeWatermark, scope: {}, scopeKey: 'scope', situation: 's',
    projection: { subjectKind: 'foreground-turn', subjectRef: inboxId, version: task.version,
      digest: String(task.version).repeat(64), disposition: task.disposition }, objective: { status: task.status } })
  const delivery = {
    inspectOwnerForegroundLearningTask: vi.fn(({ outcomeId }: { outcomeId: string }) => {
      for (const [inboxId, task] of tasks) {
        if (`outcome-${inboxId}-${task.version}` !== outcomeId) continue
        return { protocol: 'assistant-delivery/owner-foreground-learning/v1', owner: { ...owner, bindingVersion: 3, generation: 4 },
          canonical: canonical(inboxId, task), judgement: 'owner-feedback',
          ownerRevision: { version: task.version, action: task.version > 1 ? 'correct' : 'initial' },
          source: { inboxId, sessionId: task.session, objective: 'secret task text', truncated: false, quiescent: true,
            modelSelectionState: 'frozen', modelSelection: task.model ?? { provider: 'p', model: 'm' } } }
      }
      return undefined
    }),
    inspectOwnerForegroundTaskSource: vi.fn(({ inboxId }: { inboxId: string }): object | undefined => {
      const task = tasks.get(inboxId)
      return task && { authorityId: owner.authorityId, authorityHash: owner.authorityHash, principalId: owner.principalId,
        owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
        binding: { ...binding(inboxId), sessionId: task.session },
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
  const set = (inboxId: string, task: Partial<Task> & { dispatchedAt: number }) => {
    state.scopeWatermark++
    tasks.set(inboxId, { version: 1, disposition: 'upsert', status: 'achieved', session: 'control', ...tasks.get(inboxId), ...task })
  }
  /** n tasks in one window and session; `exposed` adds one exact call per task. */
  const cell = (prefix: string, window: number, session: string, total: number, achieved: number,
    extra: Partial<Task> & { exposed?: boolean } = {}) => {
    const { exposed, ...rest } = extra
    for (let index = 0; index < total; index++) {
      const inboxId = `${prefix}${index}`
      const dispatchedAt = adoptedAt + window * H + 1 + index
      set(inboxId, { dispatchedAt, session, status: index < achieved ? 'achieved' : 'not-achieved', ...rest })
      if (exposed) calls.push(call(`${inboxId}-call`, inboxId, dispatchedAt, session))
    }
  }
  const input: CreationCapabilityTrendInput = { record, calls, triggerInboxId: 'trigger', owner,
    evaluation: evaluation as unknown as CreationCapabilityTrendInput['evaluation'],
    delivery: delivery as unknown as CreationCapabilityTrendInput['delivery'],
    readSourceCurrent: () => ({ projection: original, scopeWatermark: state.scopeWatermark }), now, windowMs: H }
  const trend = (extra: Partial<CreationCapabilityTrendInput> = {}) => inspectCreationCapabilityOrdinaryUseTrend({ ...input, ...extra })
  return { input, tasks, calls, set, cell, state, delivery, evaluation, trend }
}

const at = <T extends { index: number }>(cells: readonly T[], index: number) => cells.find(item => item.index === index)!

/** Price-Bonett adjusted rate (y + 0.5) / (n + 1) of one (achieved, samples) cell. */
const adjusted = ([a, n]: [number, number]) => (a + 0.5) / (n + 1)
/** Price-Bonett standard error of four (achieved, samples) cells. */
const standardError = (...cells: [number, number][]) =>
  Math.sqrt(cells.reduce((sum, cell) => { const p = adjusted(cell); return sum + p * (1 - p) / (cell[1] + 1) }, 0))

describe('created capability ordinary-use trend', () => {
  it('splits dispatch times into fixed (start, end] windows around adoption and marks the open window partial', () => {
    const f = fixture()
    f.set('edge', { dispatchedAt: adoptedAt })
    f.set('next', { dispatchedAt: adoptedAt + 1 })
    f.set('end0', { dispatchedAt: adoptedAt + H })
    f.set('start1', { dispatchedAt: adoptedAt + H + 1 })
    f.set('first', { dispatchedAt: adoptedAt - 4 * H + 1 })
    f.set('before-first', { dispatchedAt: adoptedAt - 4 * H })
    f.set('after-last', { dispatchedAt: adoptedAt + 3 * H + 1 })
    f.set('trigger', { dispatchedAt: adoptedAt - 1 })
    const result = f.trend({ minimumSamples: 1, now: adoptedAt + 2 * H + 1 })!
    expect(result.windows).toEqual([-4, -3, -2, -1, 0, 1, 2].map(index => ({ index,
      startExclusive: adoptedAt + index * H, endInclusive: index < 2 ? adoptedAt + (index + 1) * H : adoptedAt + 2 * H + 1,
      complete: index < 2 })))
    expect(result.population).toEqual({ scanned: 8, counted: 5,
      excluded: { nonForeground: 0, trigger: 1, retracted: 0, unverified: 0, outsideWindow: 2 } })
    const cells = result.strata[0]!.cells
    expect([-4, -1, 0, 1].map(index => at(cells, index).control.samples)).toEqual([1, 1, 2, 1])
    expect(result.flags).toContain('partial-window')
    expect(f.trend({ minimumSamples: 1, now: adoptedAt + 3 * H })!.flags).not.toContain('partial-window')
    // Post windows stop at the signed deadline and the configured cap.
    expect(f.trend({ now: adoptedAt + 2_000 * H })!.windows.filter(item => item.index >= 0)).toHaveLength(12)
    expect(f.trend({ now: adoptedAt + 2_000 * H, maxPostWindows: 52, windowMs: 90 * 24 * H })!.windows
      .filter(item => item.index >= 0)).toHaveLength(1)
    expect(f.trend({ now: adoptedAt })!.windows.filter(item => item.index >= 0)).toEqual([])
  })

  it('stops after windows at the signed expiry and flags a non-active adoption record', () => {
    const f = fixture()
    const expiresAt = adoptedAt + 2 * H + H / 2
    const expired = { ...record, status: 'closed', receipt: { ...receipt, expiresAt } } as unknown as CreationCapabilityRecord
    f.set('in-window', { dispatchedAt: adoptedAt + 2 * H + 1 })
    f.set('at-expiry', { dispatchedAt: expiresAt })
    f.set('after-expiry', { dispatchedAt: expiresAt + 1 })
    f.set('late', { dispatchedAt: adoptedAt + 3 * H })
    const result = f.trend({ record: expired, minimumSamples: 1, now: adoptedAt + 10 * H,
      otherAdoptedAt: [expiresAt, expiresAt + 1, adoptedAt + 3 * H] })!
    expect(result.withinSignedUseWindow).toBe(false)
    expect(result.adoptionStatus).toBe('closed')
    expect(result.windows.filter(item => item.index >= 0)).toEqual([
      { index: 0, startExclusive: adoptedAt, endInclusive: adoptedAt + H, complete: true },
      { index: 1, startExclusive: adoptedAt + H, endInclusive: adoptedAt + 2 * H, complete: true },
      { index: 2, startExclusive: adoptedAt + 2 * H, endInclusive: expiresAt, complete: false }])
    // Dispatches in (expiresAt, adoptedAt + 3H] fall inside the unclipped last window but are not post-adoption use.
    expect(result.population).toEqual({ scanned: 4, counted: 2,
      excluded: { nonForeground: 0, trigger: 0, retracted: 0, unverified: 0, outsideWindow: 2 } })
    expect(at(result.strata[0]!.cells, 2).control.samples).toBe(2)
    expect(result.concurrentAdoptions).toEqual({ status: 'flagged', count: 1 })
    expect(result.flags).toEqual(['concurrent-adoptions', 'partial-window', 'adoption-not-active'])
    expect(f.trend({ minimumSamples: 1, now: adoptedAt + 10 * H })!.flags).not.toContain('adoption-not-active')
  })

  it('marks sparse cells and the estimate insufficient while keeping exact counts', () => {
    const f = fixture()
    f.cell('t-pre', -1, 'treated', 4, 1)
    f.cell('t-post', 0, 'treated', 5, 5, { exposed: true })
    f.cell('c-pre', -1, 'control', 5, 2)
    f.cell('c-post', 0, 'control', 5, 2)
    const result = f.trend()!
    expect(result.minimumSamples).toBe(DEFAULT_MINIMUM_SAMPLES)
    const stratum = result.strata[0]!
    expect(at(stratum.cells, -1).treated).toEqual({ status: 'insufficient', samples: 4, achieved: 1, notAchieved: 3 })
    expect(at(stratum.cells, -2).treated).toEqual({ status: 'insufficient', samples: 0, achieved: 0, notAchieved: 0 })
    expect(at(stratum.cells, 0)).toMatchObject({ treated: { status: 'measured', samples: 5 }, control: { status: 'measured' },
      calls: 5, exposedTasks: 5 })
    expect(stratum.differenceInDifferences).toEqual({ status: 'insufficient' })
    expect(f.trend({ minimumSamples: 4 })!.strata[0]!.differenceInDifferences.status).toBe('estimated')
  })

  it('estimates pooled difference-in-differences with a Price-Bonett interval, never causal', () => {
    const f = fixture()
    f.cell('t-pre', -1, 'treated', 5, 2)
    f.cell('t-post', 0, 'treated', 5, 4, { exposed: true })
    f.cell('c-pre', -1, 'control', 5, 3)
    f.cell('c-post', 0, 'control', 5, 3)
    const result = f.trend()!
    expect(result).toMatchObject({ protocol: 'dsh-created-capability-ordinary-use-trend/v1', causal: false,
      design: 'session-cohort-difference-in-differences-model-stratified', receiptDigest, windowMs: H,
      cohorts: { treatedSessions: 1, controlSessions: 1 }, concurrentAdoptions: { status: 'none', count: 0 },
      regressions: { status: 'unmeasured' }, cost: { status: 'unmeasured' } })
    expect(result.assumptions).toEqual(TREND_ASSUMPTIONS)
    expect(result.assumptions.some(item => item.startsWith('parallel-trends'))).toBe(true)
    const did = result.strata[0]!.differenceInDifferences
    if (did.status !== 'estimated') throw new Error('expected an estimate')
    // (4/5 - 2/5) - (3/5 - 3/5)
    expect(did.estimate).toBeCloseTo(0.4, 12)
    // (4.5/6 - 2.5/6) - (3.5/6 - 3.5/6): the interval is centered on the adjusted contrast, not the raw one.
    const center = (adjusted([4, 5]) - adjusted([2, 5])) - (adjusted([3, 5]) - adjusted([3, 5]))
    expect(did.adjustedEstimate).toBeCloseTo(center, 12)
    expect(center).toBeCloseTo(1 / 3, 12)
    const se = standardError([2, 5], [4, 5], [3, 5], [3, 5])
    expect(did.standardError).toBeCloseTo(se, 12)
    expect(did.interval95.low).toBeCloseTo(center - 1.96 * se, 12)
    expect(did.interval95.high).toBeCloseTo(center + 1.96 * se, 12)
    // Unexposed tasks of a treated session stay treated; a control session never used it.
    f.cell('t-post-plain', 0, 'treated', 5, 0)
    const diluted = f.trend()!.strata[0]!
    expect(at(diluted.cells, 0)).toMatchObject({ treated: { samples: 10, achieved: 4 }, exposedTasks: 5, calls: 5 })
    expect(diluted.differenceInDifferences).toMatchObject({ estimate: expect.closeTo(0, 12) })
    expect(Object.isFrozen(result) && Object.isFrozen(result.strata[0]!.cells[0]!.treated)).toBe(true)
  })

  it('stratifies by frozen model and flags a missing control cohort and concurrent adoptions', () => {
    const f = fixture()
    f.cell('p', 0, 'treated', 1, 1, { exposed: true })
    f.cell('q', 0, 'treated', 1, 0, { model: { provider: 'q', model: 'n' } })
    const result = f.trend({ minimumSamples: 1, otherAdoptedAt: [adoptedAt - 4 * H, adoptedAt - 4 * H + 1, now, Number.NaN] })!
    expect(result.strata.map(item => item.model)).toEqual([{ state: 'frozen', provider: 'p', model: 'm' },
      { state: 'frozen', provider: 'q', model: 'n' }])
    expect(at(result.strata[1]!.cells, 0).treated.samples).toBe(1)
    expect(result.cohorts).toEqual({ treatedSessions: 1, controlSessions: 0 })
    expect(result.flags).toEqual(['no-control-cohort', 'concurrent-adoptions'])
    expect(result.concurrentAdoptions).toEqual({ status: 'flagged', count: 2 })
  })

  it('flags parallel-trend-suspect when the pre-adoption gap drifts beyond the threshold', () => {
    const f = fixture()
    f.cell('t4', -4, 'treated', 5, 5)
    f.cell('c4', -4, 'control', 5, 1)
    f.cell('t1', -1, 'treated', 5, 2)
    f.cell('c1', -1, 'control', 5, 1)
    f.cell('t0', 0, 'treated', 1, 1, { exposed: true })
    const suspect = f.trend()!
    // gap(-1) - gap(-4) = (2/5 - 1/5) - (5/5 - 1/5)
    expect(suspect.strata[0]!.parallelTrend).toEqual({ status: 'parallel-trend-suspect', testedWindows: 2,
      gapChange: expect.closeTo(-0.6, 12) })
    expect(suspect.flags).toContain('parallel-trend-suspect')
    expect(f.trend({ parallelTrendThreshold: 0.7 })!.strata[0]!.parallelTrend.status).toBe('not-flagged')
    expect(f.trend({ minimumSamples: 6 })!.strata[0]!.parallelTrend).toEqual({ status: 'untestable', testedWindows: 0 })
    f.set('t42', { dispatchedAt: adoptedAt - 4 * H + 2, version: 2, status: 'not-achieved' })
    f.set('t43', { dispatchedAt: adoptedAt - 4 * H + 3, version: 2, status: 'not-achieved' })
    f.set('t44', { dispatchedAt: adoptedAt - 4 * H + 4, version: 2, status: 'not-achieved' })
    const parallel = f.trend()!
    expect(parallel.strata[0]!.parallelTrend).toEqual({ status: 'not-flagged', testedWindows: 2, gapChange: expect.closeTo(0, 12) })
    expect(parallel.flags).not.toContain('parallel-trend-suspect')
  })

  it('follows owner corrections and withdrawals by the latest head', () => {
    const f = fixture()
    f.cell('t-pre', -1, 'treated', 5, 2)
    f.cell('t-post', 0, 'treated', 5, 4, { exposed: true })
    f.cell('c-pre', -1, 'control', 5, 3)
    f.cell('c-post', 0, 'control', 5, 3)
    const first = f.trend()!
    f.set('t-post4', { dispatchedAt: adoptedAt + 5, version: 2, status: 'achieved' })
    const corrected = f.trend()!
    expect(at(corrected.strata[0]!.cells, 0).treated.achieved).toBe(5)
    expect(corrected.strata[0]!.differenceInDifferences).toMatchObject({ estimate: expect.closeTo(0.6, 12) })
    expect(corrected.rowsDigest).not.toBe(first.rowsDigest)
    f.set('c-post0', { dispatchedAt: adoptedAt + 1, version: 3, disposition: 'retract' })
    const withdrawn = f.trend()!
    expect(withdrawn.population).toMatchObject({ counted: 19, excluded: { retracted: 1 } })
    expect(at(withdrawn.strata[0]!.cells, 0).control).toMatchObject({ status: 'insufficient', samples: 4, achieved: 2 })
    expect(withdrawn.strata[0]!.differenceInDifferences).toEqual({ status: 'insufficient' })
    expect(withdrawn.scopeWatermark).toBeGreaterThan(first.scopeWatermark)
    // Withdrawing every exposed task leaves no treated cohort.
    for (let index = 0; index < 5; index++) {
      f.set(`t-post${index}`, { dispatchedAt: adoptedAt + 1 + index, version: 4, disposition: 'retract' })
    }
    expect(f.trend()!.cohorts.treatedSessions).toBe(0)
  })

  it('reads one scope watermark and rereads inside the writer fence', () => {
    const f = fixture()
    f.cell('c', 0, 'control', 120, 60)
    expect(f.trend()!.population.scanned).toBe(120)
    expect(f.evaluation.withTrustedCanonicalScopeWriterFence).toHaveBeenLastCalledWith(
      { scope: { workspace: owner.workspace, preset: owner.agentPreset }, scopeWatermark: f.state.scopeWatermark }, expect.any(Function))
    expect(f.trend({ maxScannedHeads: 119 })).toBeUndefined()
    f.evaluation.withTrustedCanonicalScopeWriterFence.mockImplementationOnce(() => ({ matched: false }))
    expect(f.trend()).toBeUndefined()
    f.evaluation.withTrustedCanonicalScopeWriterFence.mockImplementationOnce((_input, callback) => {
      f.tasks.get('c0')!.status = 'not-achieved'; return { matched: true, value: callback() }
    })
    expect(f.trend()).toBeUndefined()
    f.evaluation.withTrustedCanonicalScopeWriterFence.mockImplementationOnce((_input, callback) => {
      f.tasks.get('c1')!.session = 'treated'; return { matched: true, value: callback() }
    })
    expect(f.trend()).toBeUndefined()
    const page = f.evaluation.listTrustedTaskLearningProjections.getMockImplementation()!
    f.evaluation.listTrustedTaskLearningProjections.mockImplementationOnce(argument => {
      const value = page(argument); f.state.scopeWatermark++; return value
    })
    expect(f.trend()).toBeUndefined()
    expect(f.trend({ readSourceCurrent: () => ({ projection: { ...original, disposition: 'retract' }, scopeWatermark: 1 }) }))
      .toBeUndefined()
    expect(f.trend({ record: { ...record, receipt: undefined } as unknown as CreationCapabilityRecord })).toBeUndefined()
    expect(f.trend()).toBeDefined()
  })

  it('keeps defaults, is a pure read, leaks no content and rejects malformed parameters', () => {
    const f = fixture()
    f.cell('secret-inbox', 0, 'secret-session', 1, 1, { exposed: true })
    const { windowMs: _windowMs, ...defaults } = f.input
    const result = inspectCreationCapabilityOrdinaryUseTrend(defaults)!
    expect(result).toMatchObject({ windowMs: TREND_DEFAULT_WINDOW_MS, parallelTrendThreshold: 0.2,
      withinSignedUseWindow: true, flags: ['no-control-cohort', 'partial-window'] })
    expect(result.windows.map(item => item.index)).toEqual([-4, -3, -2, -1, 0])
    expect(JSON.stringify(result)).not.toMatch(/secret|objective|outcome-|session"/)
    expect(f.evaluation.withTrustedCanonicalTaskWriterFence).not.toHaveBeenCalled()
    expect(f.calls.every(item => item.status === 'completed')).toBe(true)
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => f.trend({ minimumSamples: bad })).toThrow(TypeError)
      expect(() => f.trend({ windowMs: bad })).toThrow(TypeError)
      expect(() => f.trend({ preWindows: bad })).toThrow(TypeError)
      expect(() => f.trend({ maxPostWindows: bad })).toThrow(TypeError)
      expect(() => f.trend({ maxScannedHeads: bad })).toThrow(TypeError)
      expect(() => f.trend({ parallelTrendThreshold: bad })).toThrow(TypeError)
    }
    expect(() => f.trend({ windowMs: H - 1 })).toThrow(TypeError)
    expect(() => f.trend({ windowMs: 90 * 24 * H + 1 })).toThrow(TypeError)
    expect(() => f.trend({ preWindows: 1 })).toThrow(TypeError)
    expect(() => f.trend({ preWindows: 53 })).toThrow(TypeError)
    expect(() => f.trend({ maxPostWindows: 53 })).toThrow(TypeError)
    expect(() => f.trend({ parallelTrendThreshold: 1.01 })).toThrow(TypeError)
  })
})
