import { describe, expect, it, vi } from 'vitest'
import type { EvaluationCanonicalLearningEvidenceTuple } from '@dsh-enhanced/assistant-evaluation'
import { controlPlaneDigest } from '../src/store.js'
import { inspectCreationCapabilityTaskAssociations, type CreationCapabilityFeedbackInput } from '../src/creation-capability-feedback.js'
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
  const source: { projection: EvaluationCanonicalLearningEvidenceTuple; scopeWatermark: number } =
    { projection: original, scopeWatermark: 1 }
  const delivery = {
    inspectOwnerForegroundLearningTask: vi.fn(({ outcomeId }: { outcomeId: string }) => {
      const current = [...heads.values()].find(item => item.canonical.triggerOutcomeId === outcomeId)
      return current
    }),
    inspectOwnerForegroundTaskSource: vi.fn(({ inboxId }: { inboxId: string }) => {
      const found = calls.find(c => c.foreground?.task.inboxId === inboxId)?.foreground?.task
      return found && { authorityId: owner.authorityId, authorityHash: owner.authorityHash,
        principalId: owner.principalId, owner: { principalRecordId: owner.principalRecordId,
          principalVersion: owner.principalVersion }, binding: { ...found.binding, sessionId: found.sessionId } }
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
  return { input, heads, source, delivery, evaluation }
}

function learning(inboxId: string, sessionId: string, version = 1, disposition: 'upsert' | 'retract' = 'upsert') {
  const projection = { subjectKind: 'foreground-turn' as const, subjectRef: inboxId, version,
    digest: String(version).repeat(64), disposition }
  const canonical = { triggerOutcomeId: `outcome-${inboxId}-${version}`, scopeWatermark: version,
    projection, objective: { status: 'achieved' } }
  return { protocol: 'assistant-delivery/owner-foreground-learning/v1' as const,
    owner: { ...owner, bindingVersion: 3, generation: 4 }, canonical,
    judgement: 'owner-feedback' as const, ownerRevision: { version, action: 'initial' as const },
    source: { inboxId, sessionId, objective: 'secret task text', truncated: false, quiescent: true,
      modelSelectionState: 'frozen' as const } }
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
