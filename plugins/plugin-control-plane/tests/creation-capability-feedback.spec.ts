import { describe, expect, it, vi } from 'vitest'
import type { EvaluationCanonicalLearningEvidenceTuple } from '@dsh-enhanced/assistant-evaluation'
import { controlPlaneDigest } from '../src/store.js'
import { DEFAULT_MINIMUM_SAMPLES, inspectCreationCapabilityOrdinaryUseReport, inspectCreationCapabilityTaskAssociations,
  type CreationCapabilityFeedbackInput } from '../src/creation-capability-feedback.js'
import type { CreationCapabilityCallEvidence, CreationCapabilityRecord } from '../src/creation-capability-types.js'

const now = 10_000
const owner = { authorityId: 'authority', authorityHash: 'a'.repeat(64), principalId: 'owner',
  principalRecordId: 'principal-row', principalVersion: 2, workspace: '/work', agentPreset: 'primary' }
const tool = { name: 'evolved_tool', originalName: 'read', description: '', parameters: {} }
const receipt = { protocol: 'dsh-created-capability-adoption/v2', planId: 'plan', adoptedAt: 100,
  expiresAt: 20_000, artifactSha256: 'b'.repeat(64), schemaDigest: 'c'.repeat(64) }
const record = { planId: 'plan', status: 'active', receipt, tools: [tool] } as unknown as CreationCapabilityRecord
const receiptDigest = controlPlaneDigest(receipt)
const original = { subjectKind: 'foreground-turn' as const, subjectRef: 'trigger', version: 1,
  digest: 'd'.repeat(64), disposition: 'upsert' as const }

function call(key: string, inboxId: string, sessionId: string, status: CreationCapabilityCallEvidence['status'] = 'completed'):
CreationCapabilityCallEvidence {
  return { protocol: 'dsh-created-capability-call-evidence/v1', planId: 'plan', key, status,
    attribution: 'foreground', toolAlias: tool.name, originalName: tool.originalName,
    receiptDigest, artifactSha256: receipt.artifactSha256, schemaDigest: receipt.schemaDigest,
    claimedAt: 200, settledAt: 300, foreground: { protocol: 'assistant-delivery/foreground-tool-call/v1',
      task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId, sessionId,
        scope: { workspace: owner.workspace, preset: owner.agentPreset },
        owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
        binding: { id: `${inboxId}-binding`, version: 3, generation: 4 }, dispatchedAt: 150 },
      turn: 1, call: { id: key, toolName: tool.name, eventSeq: 8, eventDigest: 'e'.repeat(64),
        argumentsDigest: 'f'.repeat(64) } } }
}

function fixture(calls: CreationCapabilityCallEvidence[]) {
  const heads = new Map<string, ReturnType<typeof learning>>()
  for (const c of calls) if (c.foreground) heads.set(c.foreground.task.inboxId,
    learning(c.foreground.task.inboxId, c.foreground.task.sessionId))
  const executions = new Map<string, { dispatchedAt: number; completedAt: number; quiescent: boolean } | undefined>()
  for (const c of calls) if (c.foreground) executions.set(c.foreground.task.inboxId,
    { dispatchedAt: 150, completedAt: 450, quiescent: true })
  const source: { projection: EvaluationCanonicalLearningEvidenceTuple; scopeWatermark: number } =
    { projection: original, scopeWatermark: 1 }
  const delivery = {
    inspectOwnerForegroundLearningTask: vi.fn(({ outcomeId }: { outcomeId: string }) => {
      const current = [...heads.values()].find(item => item.canonical.triggerOutcomeId === outcomeId)
      return current
    }),
    inspectOwnerForegroundTaskSource: vi.fn(({ inboxId }: { inboxId: string }): object | undefined => {
      const found = calls.find(c => c.foreground?.task.inboxId === inboxId)?.foreground?.task
      return found && { authorityId: owner.authorityId, authorityHash: owner.authorityHash,
        principalId: owner.principalId, owner: { principalRecordId: owner.principalRecordId,
          principalVersion: owner.principalVersion }, binding: { ...found.binding, sessionId: found.sessionId }, execution: executions.get(inboxId) }
    }),
  }
  const evaluation = {
    canonicalHostScope: vi.fn(() => ({ workspace: owner.workspace, preset: owner.agentPreset })),
    getTrustedForegroundLearningProjection: vi.fn(({ inboxId }: { inboxId: string }) => heads.get(inboxId)?.canonical),
    withTrustedCanonicalTaskWriterFence: vi.fn((input: { scopeWatermark: number;
      evidence: readonly { subjectRef: string }[] }, callback: () => unknown) => {
      const watermark = Math.max(source.scopeWatermark, ...[...heads.values()].map(item => item.canonical.scopeWatermark))
      if (input.scopeWatermark !== watermark || input.evidence.some(tuple =>
        tuple.subjectRef !== 'trigger' && !heads.has(tuple.subjectRef))) return { matched: false }
      return { matched: true, value: callback() }
    }),
  }
  const input: CreationCapabilityFeedbackInput = { record, calls, triggerInboxId: 'trigger', owner,
    evaluation: evaluation as unknown as CreationCapabilityFeedbackInput['evaluation'],
    delivery: delivery as unknown as CreationCapabilityFeedbackInput['delivery'],
    readSourceCurrent: () => source, now }
  return { input, heads, source, delivery, evaluation, executions }
}

function learning(inboxId: string, sessionId: string, version = 1, disposition: 'upsert' | 'retract' = 'upsert',
  options: { status?: 'achieved' | 'not-achieved'; modelSelectionState?: 'missing' | 'frozen' | 'inconsistent';
    modelSelection?: { provider: string; model: string; reasoningEffort?: string } | null } = {}) {
  const projection = { subjectKind: 'foreground-turn' as const, subjectRef: inboxId, version,
    digest: String(version).repeat(64), disposition }
  const canonical = { triggerOutcomeId: `outcome-${inboxId}-${version}`, scopeWatermark: version,
    projection, objective: { status: options.status ?? 'achieved' } }
  return { protocol: 'assistant-delivery/owner-foreground-learning/v1' as const,
    owner: { ...owner, bindingVersion: 3, generation: 4 }, canonical,
    judgement: 'owner-feedback' as const, ownerRevision: { version, action: 'initial' as const },
    source: { inboxId, sessionId, objective: 'secret task text', truncated: false, quiescent: true,
      modelSelectionState: options.modelSelectionState ?? 'frozen',
      ...(options.modelSelection === null ? {} : { modelSelection: options.modelSelection ?? { provider: 'p', model: 'm' } }) } }
}

describe('created capability current task associations', () => {
  it('groups completed calls by exact Inbox, excludes trigger and unattributed/unknown, and leaks no content', () => {
    const legacy = call('f', 'four', 'same-session')
    legacy.attribution = 'legacy-unattributed'
    delete legacy.foreground
    const calls = [call('a', 'one', 'same-session'), call('b', 'one', 'same-session'),
      call('c', 'two', 'same-session'), call('d', 'trigger', 'same-session'),
      call('e', 'three', 'same-session', 'unknown'), legacy]
    const f = fixture(calls)
    const result = inspectCreationCapabilityTaskAssociations(f.input)
    expect(result.map(item => [item.inboxId, item.callKeys])).toEqual([['one', ['a', 'b']], ['two', ['c']]])
    expect(result.every(item => item.adoptionStatus === 'active' && item.withinSignedUseWindow
      && item.receiptDigest === receiptDigest
      && item.artifactSha256 === receipt.artifactSha256 && item.schemaDigest === receipt.schemaDigest)).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/secret task text|arguments|result|objective/)
  })

  it('replaces a corrected canonical head and drops a retraction or stale writer fence', () => {
    const f = fixture([call('a', 'one', 'session')])
    expect(inspectCreationCapabilityTaskAssociations(f.input)[0]?.task.projection.version).toBe(1)
    f.heads.set('one', learning('one', 'session', 2))
    expect(inspectCreationCapabilityTaskAssociations(f.input)[0]?.task.projection.version).toBe(2)
    f.heads.set('one', learning('one', 'session', 3, 'retract'))
    expect(inspectCreationCapabilityTaskAssociations(f.input)).toEqual([])
    f.heads.set('one', learning('one', 'session', 4))
    f.evaluation.withTrustedCanonicalTaskWriterFence.mockImplementationOnce(() => ({ matched: false }))
    expect(inspectCreationCapabilityTaskAssociations(f.input)).toEqual([])
    f.evaluation.withTrustedCanonicalTaskWriterFence.mockImplementationOnce((_input, callback) => {
      f.heads.set('one', learning('one', 'session', 5)); return { matched: true, value: callback() }
    })
    expect(inspectCreationCapabilityTaskAssociations(f.input)).toEqual([])
  })

  it('rejects owner ABA, changed original task, exact binding drift and late or out-of-window calls', () => {
    const f = fixture([call('a', 'one', 'session')])
    f.delivery.inspectOwnerForegroundLearningTask.mockReturnValueOnce({ ...learning('one', 'session'),
      owner: { ...learning('one', 'session').owner, principalVersion: 3 } })
    expect(inspectCreationCapabilityTaskAssociations(f.input)).toEqual([])
    f.source.projection = { ...original, disposition: 'retract' }
    expect(inspectCreationCapabilityTaskAssociations(f.input)).toEqual([])
    f.source.projection = original
    f.delivery.inspectOwnerForegroundTaskSource.mockReturnValueOnce({ authorityId: owner.authorityId,
      authorityHash: owner.authorityHash, principalId: owner.principalId,
      owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
      binding: { id: 'other-binding', version: 3, generation: 4, sessionId: 'session' } })
    expect(inspectCreationCapabilityTaskAssociations(f.input)).toEqual([])
    const late = call('late', 'one', 'session'); late.claimedAt = receipt.expiresAt
    expect(inspectCreationCapabilityTaskAssociations({ ...f.input, calls: [late] })).toEqual([])
  })

  it('keeps terminal status separate from the signed time window', () => {
    const f = fixture([call('a', 'one', 'session')])
    const closed = { ...record, status: 'closed' as const }
    expect(inspectCreationCapabilityTaskAssociations({ ...f.input, record: closed })[0]).toMatchObject({
      adoptionStatus: 'closed', withinSignedUseWindow: true })
    expect(inspectCreationCapabilityTaskAssociations({ ...f.input, now: receipt.expiresAt + 1 })[0]).toMatchObject({
      adoptionStatus: 'active', withinSignedUseWindow: false })
  })
})

function timed(key: string, inboxId: string, latency: number, sessionId = 'session'): CreationCapabilityCallEvidence {
  const item = call(key, inboxId, sessionId); item.settledAt = item.claimedAt! + latency; return item
}
const report = (f: ReturnType<typeof fixture>, minimumSamples?: number) =>
  inspectCreationCapabilityOrdinaryUseReport({ ...f.input, ...(minimumSamples === undefined ? {} : { minimumSamples }) })

describe('created capability ordinary-use report', () => {
  it('measures one latest certified judgement per Inbox, call and task latency, and binds the exact associations', () => {
    const f = fixture(['a', 'b', 'c', 'd', 'e'].map((inbox, index) => timed(inbox, inbox, (index + 1) * 10)))
    for (const inbox of ['d', 'e']) f.heads.set(inbox, learning(inbox, 'session', 1, 'upsert', { status: 'not-achieved' }))
    f.executions.set('a', { dispatchedAt: 150, completedAt: 1_150, quiescent: true })
    const result = report(f)!
    expect(result).toMatchObject({ protocol: 'dsh-created-capability-ordinary-use-report/v1', causal: false,
      planId: 'plan', receiptDigest, artifactSha256: receipt.artifactSha256, schemaDigest: receipt.schemaDigest,
      adoptionStatus: 'active', withinSignedUseWindow: true, minimumSamples: DEFAULT_MINIMUM_SAMPLES,
      unknown: { inboxes: 0 }, regressions: { status: 'unmeasured' }, cost: { status: 'unmeasured' },
      overall: { quality: { status: 'measured', samples: 5, achieved: 3, notAchieved: 2 },
        callLatency: { status: 'measured', samples: 5, p50Ms: 30, maxMs: 50 },
        taskLatency: { status: 'measured', samples: 5, p50Ms: 300, maxMs: 1_000 } } })
    expect(result.strata).toEqual([{ model: { state: 'frozen', provider: 'p', model: 'm' }, ...result.overall }])
    const associations = [...inspectCreationCapabilityTaskAssociations(f.input)].sort((a, b) => a.inboxId < b.inboxId ? -1 : 1)
    expect(result.associationsDigest).toBe(controlPlaneDigest(associations))
    expect(Object.isFrozen(result) && Object.isFrozen(result.overall.quality) && Object.isFrozen(result.strata)
      && Object.isFrozen(result.strata[0]!.model)).toBe(true)
  })

  it('reports zeros or counts below the minimum as insufficient without percentiles', () => {
    const empty = report(fixture([]))!
    expect(empty).toMatchObject({ unknown: { inboxes: 0 }, strata: [], overall: {
      quality: { status: 'insufficient', samples: 0, achieved: 0, notAchieved: 0 },
      callLatency: { status: 'unmeasured', samples: 0 }, taskLatency: { status: 'unmeasured', samples: 0 } } })
    const few = report(fixture([timed('a', 'one', 10), timed('b', 'two', 20)]))!
    expect(few.overall).toEqual({ quality: { status: 'insufficient', samples: 2, achieved: 2, notAchieved: 0 },
      callLatency: { status: 'insufficient', samples: 2 }, taskLatency: { status: 'insufficient', samples: 2 } })
  })

  it('counts a corrected head once at its latest revision and drops a retraction to unknown', () => {
    const f = fixture([call('a', 'one', 'session'), call('b', 'two', 'session')])
    f.heads.set('one', learning('one', 'session', 2, 'upsert', { status: 'not-achieved' }))
    expect(report(f, 1)?.overall.quality).toEqual({ status: 'measured', samples: 2, achieved: 1, notAchieved: 1 })
    f.heads.set('one', learning('one', 'session', 3, 'retract'))
    // The exact writer fence fails while the newest scope write is outside the evidence; a later included head clears it.
    expect(report(f, 1)).toBeUndefined()
    f.heads.set('two', learning('two', 'session', 4))
    expect(report(f, 1)).toMatchObject({ unknown: { inboxes: 1 },
      overall: { quality: { status: 'measured', samples: 1, achieved: 1, notAchieved: 0 } } })
  })

  it('takes one quality sample per multi-call Inbox and nearest-rank p50 for odd and even call counts', () => {
    const odd = report(fixture([timed('a', 'one', 10), timed('b', 'one', 30), timed('c', 'one', 20)]), 1)!
    expect(odd.overall.quality.samples).toBe(1)
    expect(odd.overall.callLatency).toEqual({ status: 'measured', samples: 3, p50Ms: 20, maxMs: 30 })
    const even = report(fixture([timed('a', 'one', 40), timed('b', 'one', 10), timed('c', 'two', 30),
      timed('d', 'two', 20)]), 1)!
    expect(even.overall.quality.samples).toBe(2)
    expect(even.overall.callLatency).toEqual({ status: 'measured', samples: 4, p50Ms: 20, maxMs: 40 })
  })

  it('stratifies by exact frozen model and keeps missing and inconsistent selections separate', () => {
    const f = fixture(['a', 'b', 'c', 'd', 'e'].map(inbox => call(inbox, inbox, 'session')))
    f.heads.set('a', learning('a', 'session', 1, 'upsert', { modelSelection: { provider: 'p', model: 'm', reasoningEffort: 'high' } }))
    f.heads.set('c', learning('c', 'session', 1, 'upsert', { modelSelectionState: 'missing', modelSelection: null }))
    f.heads.set('d', learning('d', 'session', 1, 'upsert', { modelSelectionState: 'inconsistent', modelSelection: null }))
    f.heads.set('e', learning('e', 'session', 1, 'upsert', { modelSelection: null }))
    const result = report(f, 1)!
    expect(result.strata.map(item => [item.model, item.quality.samples])).toEqual([
      [{ state: 'frozen', provider: 'p', model: 'm', reasoningEffort: 'high' }, 1],
      [{ state: 'frozen', provider: 'p', model: 'm' }, 1], [{ state: 'inconsistent' }, 2], [{ state: 'missing' }, 1]])
    expect(result.overall.quality.samples).toBe(5)
  })

  it('skips task latency for non-quiescent, negative or missing execution and reports all skipped as unmeasured', () => {
    const f = fixture([call('a', 'one', 'session'), call('b', 'two', 'session'), call('c', 'three', 'session')])
    f.executions.set('one', { dispatchedAt: 150, completedAt: 450, quiescent: false })
    f.executions.set('two', { dispatchedAt: 450, completedAt: 150, quiescent: true })
    expect(report(f, 1)?.overall.taskLatency).toEqual({ status: 'measured', samples: 1, p50Ms: 300, maxMs: 300 })
    f.executions.set('three', undefined)
    expect(report(f, 1)?.overall).toMatchObject({ quality: { samples: 3 }, taskLatency: { status: 'unmeasured', samples: 0 } })
  })

  it('returns undefined only for a missing receipt, a failed or changed fence, a mixed-session Inbox or a throw', () => {
    const f = fixture([call('a', 'one', 'session')])
    expect(report({ ...f, input: { ...f.input, record: { ...record, receipt: undefined } as unknown as CreationCapabilityRecord } })).toBeUndefined()
    f.evaluation.withTrustedCanonicalTaskWriterFence.mockImplementationOnce(() => ({ matched: false }))
    expect(report(f)).toBeUndefined()
    f.evaluation.withTrustedCanonicalTaskWriterFence.mockImplementationOnce((_input, callback) => {
      f.executions.set('one', { dispatchedAt: 150, completedAt: 999, quiescent: true }); return { matched: true, value: callback() }
    })
    expect(report(f)).toBeUndefined()
    expect(report({ ...f, input: { ...f.input, calls: [call('a', 'one', 'session'), call('b', 'one', 'other')] } })).toBeUndefined()
    f.source.projection = { ...original, disposition: 'retract' }
    expect(report(f)).toBeUndefined()
    f.source.projection = original
    expect(report(f)?.overall.quality.samples).toBe(1)
  })

  it('excludes trigger, unknown and out-of-window calls and counts unresolved judgements as unknown Inboxes', () => {
    const late = call('late', 'four', 'session'); late.claimedAt = receipt.expiresAt
    const f = fixture([call('a', 'one', 'session'), call('b', 'two', 'session'), call('t', 'trigger', 'session'),
      call('u', 'three', 'session', 'unknown'), late])
    f.heads.delete('two')
    expect(report(f, 1)).toMatchObject({ unknown: { inboxes: 1 }, overall: { quality: { samples: 1 },
      callLatency: { samples: 1 } } })
  })

  it('leaks no task content and rejects a malformed minimum', () => {
    const f = fixture([call('a', 'one', 'session')])
    expect(JSON.stringify(report(f))).not.toMatch(/secret task text|arguments|result|objective|sessionId|inboxId/)
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => report(f, bad)).toThrow(TypeError)
  })
})
