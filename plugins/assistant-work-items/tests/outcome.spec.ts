import { describe, expect, test } from 'vitest'
import {
  deriveReportOutcome,
  deriveRetryExhaustedOutcome,
  deriveWithdrawalOutcome,
  expiredOutcome,
  matchesOutcomeEvidence,
  MAX_OUTCOME_EVIDENCE_BYTES,
  observedOutcome,
  OUTCOME_EVIDENCE_SOURCE,
  outcomeEvidenceFor,
  SETTLEABLE_SOURCE_IDS,
  settlementBaseline,
} from '../src/outcome.ts'
import type { PeerOwnerForegroundTaskSource } from '../src/peers.ts'
import type {
  WorkItemOutcomeRecord,
  WorkItemProvenance,
  WorkItemRecord,
  WorkItemReportStatus,
} from '../src/types.ts'

const NOW = 1_700_000_000_000
const WINDOW = 604_800_000

function provenance(overrides: { source?: string; evidence?: Record<string, unknown> } = {}): WorkItemProvenance {
  return {
    source: overrides.source ?? 'owner-foreground-failures',
    sourceVersion: 'assistant-work-items/owner-foreground-failures/v1',
    signalDigest: 'sha256:signal',
    observedAt: NOW - 1_000,
    ...(overrides.evidence === undefined
      ? {}
      : { evidence: overrides.evidence }),
  } as unknown as WorkItemProvenance
}

function settleable(completionSequence = 4, authorityHash: string = 'sha256:authority'): WorkItemProvenance {
  return provenance({ evidence: { inboxId: 'inbox-1', executionStatus: 'failed', completionSequence, authorityHash } })
}

function derive(status: WorkItemReportStatus, value: WorkItemProvenance | null = settleable()) {
  return deriveReportOutcome({ status, provenance: value, now: NOW, windowMs: WINDOW })
}

function item(scope: { workspace: string; preset: string; principalId: string } = {
  workspace: '/work/alpha',
  preset: 'primary',
  principalId: 'owner:me',
}): WorkItemRecord {
  return { id: 'item-1', scope } as unknown as WorkItemRecord
}

function source(overrides: Partial<PeerOwnerForegroundTaskSource> = {}): PeerOwnerForegroundTaskSource {
  return {
    protocol: OUTCOME_EVIDENCE_SOURCE,
    inboxId: 'inbox-1',
    sourceDigest: 'sha256:digest',
    completionSequence: 5,
    authorityId: 'route-1',
    authorityHash: 'sha256:authority',
    principalId: 'owner:me',
    scope: { workspace: '/work/alpha', preset: 'primary' },
    binding: { id: 'binding-1', version: 2, generation: 3, sessionId: 'session-1' },
    execution: { dispatchedAt: NOW - 500, status: 'succeeded', quiescent: true, completedAt: NOW, executionRef: 'exec-1' },
    ...overrides,
  } as PeerOwnerForegroundTaskSource
}

function outcome(overrides: Partial<WorkItemOutcomeRecord> = {}): WorkItemOutcomeRecord {
  return {
    itemId: 'item-1',
    revision: 1,
    settledBy: 'report-ready',
    executionStatus: 'succeeded',
    objectiveStatus: 'unknown',
    trust: 'agent-self-report',
    evidenceState: 'pending',
    evidenceReason: null,
    evidence: null,
    baselineSequence: 4,
    inboxId: 'inbox-1',
    authorityHash: 'sha256:authority',
    deadlineAt: NOW + WINDOW,
    settledAt: NOW - 1_000,
    recordedAt: NOW - 1_000,
    ...overrides,
  } as WorkItemOutcomeRecord
}

describe('outcome derivation', () => {
  test('ready with a settleable admission opens a bounded pending window', () => {
    const derived = derive('ready')
    expect(derived).toMatchObject({
      settledBy: 'report-ready',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      trust: 'agent-self-report',
      evidenceState: 'pending',
      evidenceReason: null,
      evidence: null,
      baselineSequence: 4,
      inboxId: 'inbox-1',
      authorityHash: 'sha256:authority',
      deadlineAt: NOW + WINDOW,
      settledAt: NOW,
    })
  })

  test('the pending window persists the admitted authority hash, not a same-pass value', () => {
    expect(derive('ready')).toMatchObject({ evidenceState: 'pending', authorityHash: 'sha256:authority' })
    // A baseline without an admitted hash still opens the window, but the fence
    // then fails closed because no receipt can match a `null` admitted hash.
    const legacy = provenance({ evidence: { inboxId: 'inbox-1', executionStatus: 'failed', completionSequence: 4 } })
    expect(derive('ready', legacy)).toMatchObject({ evidenceState: 'pending', authorityHash: null })
  })

  test('ready without an independent channel settles as not-applicable', () => {
    expect(derive('ready', null)).toMatchObject({
      objectiveStatus: 'unknown',
      evidenceState: 'not-applicable',
      evidenceReason: 'no-independent-source',
      baselineSequence: null,
      inboxId: null,
      authorityHash: null,
      deadlineAt: null,
    })
    expect(derive('ready', provenance({ evidence: { inboxId: 'inbox-1' } }))).toMatchObject({
      evidenceState: 'not-applicable',
      evidenceReason: 'no-independent-source',
    })
  })

  test('only owner-foreground failures are settleable', () => {
    expect(SETTLEABLE_SOURCE_IDS).toEqual(['owner-foreground-failures'])
    expect(settlementBaseline(provenance({ source: 'other-source', evidence: { inboxId: 'inbox-1', completionSequence: 2 } }))).toBeNull()
    expect(settlementBaseline(settleable(2))).toMatchObject({ inboxId: 'inbox-1', completionSequence: 2, authorityHash: 'sha256:authority' })
    // A baseline missing the admitted hash is still returned, with `null`.
    expect(settlementBaseline(provenance({ evidence: { inboxId: 'inbox-1', executionStatus: 'failed', completionSequence: 2 } }))).toMatchObject({ authorityHash: null })
  })

  test('blocked and failed reports settle immediately as not-achieved', () => {
    expect(derive('blocked')).toMatchObject({
      settledBy: 'report-blocked',
      executionStatus: 'succeeded',
      objectiveStatus: 'not-achieved',
      evidenceState: 'not-applicable',
    })
    expect(derive('failed')).toMatchObject({
      settledBy: 'report-failed',
      executionStatus: 'failed',
      objectiveStatus: 'not-achieved',
      evidenceState: 'not-applicable',
    })
  })

  test('progress and waiting are not terminal and derive nothing', () => {
    expect(derive('progress')).toBeNull()
    expect(derive('waiting')).toBeNull()
  })

  test('withdrawal and retry exhaustion derive their own settled revisions', () => {
    expect(deriveWithdrawalOutcome(NOW)).toMatchObject({
      settledBy: 'withdrawn',
      executionStatus: 'cancelled',
      objectiveStatus: 'unknown',
      trust: 'external-receipt',
      evidenceState: 'not-applicable',
    })
    expect(deriveRetryExhaustedOutcome(NOW)).toMatchObject({
      settledBy: 'retry-exhausted',
      executionStatus: 'unknown',
      objectiveStatus: 'not-achieved',
      trust: 'agent-self-report',
    })
  })

  test('no derivation can claim the objective was achieved', () => {
    const statuses: WorkItemReportStatus[] = ['ready', 'blocked', 'failed', 'progress', 'waiting']
    const drafts = [
      ...statuses.map(status => derive(status)),
      ...statuses.map(status => derive(status, null)),
      deriveWithdrawalOutcome(NOW),
      deriveRetryExhaustedOutcome(NOW),
      expiredOutcome(outcome(), NOW + WINDOW, false),
      expiredOutcome(outcome(), NOW + WINDOW, true),
      observedOutcome(outcome(), { inboxId: 'inbox-1' }, null, NOW),
    ].filter(draft => draft !== null)
    expect(drafts.length).toBeGreaterThan(0)
    for (const draft of drafts) expect(['unknown', 'not-achieved']).toContain(draft.objectiveStatus)
  })
})

describe('outcome evidence matching', () => {
  test('requires same inbox, newer completion, quiescent success and matching identity', () => {
    const authorityHash = 'sha256:authority'
    const matches = (overrides: Partial<PeerOwnerForegroundTaskSource> = {}) =>
      matchesOutcomeEvidence({ item: item(), outcome: outcome(), source: source(overrides), authorityHash })
    expect(matches()).toBe(true)
    expect(matches({ inboxId: 'inbox-2' })).toBe(false)
    expect(matches({ completionSequence: 4 })).toBe(false)
    expect(matches({ protocol: 'assistant-delivery/other-source/v1' })).toBe(false)
    expect(matches({ execution: { ...source().execution, status: 'failed' } })).toBe(false)
    expect(matches({ execution: { ...source().execution, quiescent: false } })).toBe(false)
    expect(matches({ principalId: 'owner:other' })).toBe(false)
    expect(matches({ authorityHash: 'sha256:other' })).toBe(false)
    expect(matches({ scope: { workspace: '/work/beta', preset: 'primary' } })).toBe(false)
    expect(matches({ scope: { workspace: '/work/alpha', preset: 'secondary' } })).toBe(false)
  })

  test('refuses a receipt for the original failed execution', () => {
    const before = outcome({ baselineSequence: 9 })
    const base = { item: item(), outcome: before, authorityHash: 'sha256:authority' }
    // A "succeeded" receipt for the very execution whose failure opened the
    // window is not repair evidence: only a strictly newer completion is.
    expect(matchesOutcomeEvidence({ ...base, source: source({ completionSequence: 9 }) })).toBe(false)
    expect(matchesOutcomeEvidence({ ...base, source: source({ completionSequence: 10 }) })).toBe(true)
  })

  test('a window missing its inbox or baseline sequence can never match', () => {
    const authorityHash = 'sha256:authority'
    expect(matchesOutcomeEvidence({
      item: item(),
      outcome: outcome({ inboxId: null }),
      source: source(),
      authorityHash,
    })).toBe(false)
    expect(matchesOutcomeEvidence({
      item: item(),
      outcome: outcome({ baselineSequence: null }),
      source: source(),
      authorityHash,
    })).toBe(false)
  })

  test('fences receipts against the admitted hash, not the current pass', () => {
    const admitted = outcome({ authorityHash: 'sha256:authority' })
    const base = { item: item(), outcome: admitted, authorityHash: 'sha256:authority' }
    expect(matchesOutcomeEvidence({ ...base, source: source({ authorityHash: 'sha256:authority' }) })).toBe(true)
    // Same pass value but a receipt minted under another admitted route: rejected.
    expect(matchesOutcomeEvidence({ ...base, source: source({ authorityHash: 'sha256:rotated' }) })).toBe(false)
    // No admitted hash means no receipt can ever match.
    expect(matchesOutcomeEvidence({ ...base, outcome: outcome({ authorityHash: null }), source: source() })).toBe(false)
  })

  test('a foreign evidence protocol is never evidence', () => {
    expect(matchesOutcomeEvidence({
      item: item(),
      outcome: outcome(),
      source: source({ protocol: 'assistant-delivery/foreground-executions/v2' }),
      authorityHash: 'sha256:authority',
    })).toBe(false)
  })

  test('builds allowlisted canonical evidence and drops oversized payloads whole', () => {
    const derived = outcomeEvidenceFor(source())
    expect(derived.reason).toBeNull()
    expect(derived.evidence).toMatchObject({
      inboxId: 'inbox-1',
      completionSequence: 5,
      executionStatus: 'succeeded',
      sourceDigest: 'sha256:digest',
      bindingVersion: 2,
      bindingGeneration: 3,
      scope: '/work/alpha/primary',
    })
    expect(JSON.stringify(derived.evidence)).toBe(
      '{"inboxId":"inbox-1","completionSequence":5,"completedAt":' + String(NOW)
      + ',"executionStatus":"succeeded","sourceDigest":"sha256:digest","bindingVersion":2,"bindingGeneration":3,"scope":"/work/alpha/primary"}',
    )
    const huge = outcomeEvidenceFor(source({ sourceDigest: 'x'.repeat(MAX_OUTCOME_EVIDENCE_BYTES + 1) }))
    expect(huge.evidence).toBeNull()
    expect(huge.reason).toBe('evidence-too-large')
  })

  test('observation widens trust but inherits the objective status', () => {
    const pending = outcome()
    const observed = observedOutcome(pending, { inboxId: 'inbox-1' }, null, NOW + 10)
    expect(observed).toMatchObject({
      settledBy: 'observed-evidence',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      trust: 'external-receipt',
      evidenceState: 'observed',
      evidenceReason: null,
      baselineSequence: 4,
      inboxId: 'inbox-1',
      authorityHash: 'sha256:authority',
      deadlineAt: null,
    })
    expect(observedOutcome(pending, null, 'evidence-too-large', NOW + 10)).toMatchObject({
      evidenceState: 'unverified',
      evidenceReason: 'evidence-too-large',
    })
  })

  test('expiry keeps status, drops the window and records why', () => {
    expect(expiredOutcome(outcome(), NOW + WINDOW, false)).toMatchObject({
      settledBy: 'window-expired',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      evidenceState: 'unverified',
      evidenceReason: 'window-expired',
      authorityHash: 'sha256:authority',
      deadlineAt: null,
    })
    expect(expiredOutcome(outcome(), NOW + WINDOW, true)).toMatchObject({
      evidenceReason: 'channel-unavailable',
    })
  })
})
