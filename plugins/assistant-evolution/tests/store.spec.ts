import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ApprovalDispatchRoute, ApprovalDispatchRouteV2 } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import { EvolutionStore, EvolutionStoreError } from '../src/store.ts'
import type { StoredRule } from '../src/types.ts'

const roots: string[] = []
const scopeKey = JSON.stringify(['/work/alpha', 'primary'])
let projectionScopeWatermark = 0

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  projectionScopeWatermark = 0
})

function nextProjectionScopeWatermark(): number { return ++projectionScopeWatermark }

function projectionDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function store(now: () => number = () => 1_000) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-evolution-store-'))
  roots.push(root)
  return new EvolutionStore({ path: join(root, 'evolution.sqlite'), now })
}

function observe(
  target: EvolutionStore,
  situation: string,
  outcome: 'succeeded' | 'failed',
  index: number,
  ruleId?: string,
) {
  const subjectRef = JSON.stringify(['evaluation-outcome', situation, index])
  const digest = projectionDigest({
    scopeKey, subjectRef, situation, outcome, ruleId: ruleId ?? null,
  })
  return target.applyTaskLearningProjection({
    scopeKey,
    scopeWatermark: nextProjectionScopeWatermark(),
    subjectKind: 'outcome',
    subjectRef,
    version: 1,
    digest,
    disposition: 'upsert',
    situation,
    outcome,
    detail: `attempt ${index}`,
    evidenceRef: `evaluation:${situation}:${index}`,
    occurredAt: 1_000 + index,
    ...(ruleId === undefined ? {} : { ruleId, guidanceVersion: 1 }),
  }).episode!
}

const thresholds = {
  scopeKey,
  window: 10,
  minSample: 4,
  adoptFailureRate: 0.4,
  retireFailureRate: 0.4,
  limit: 10,
}

const v2Dispatch: ApprovalDispatchRouteV2 = {
  routeVersion: 2,
  sourceId: 'dsh-enhanced-assistant-evolution',
  bindingId: 'binding-owner-dm',
  bindingVersion: 13,
  bindingGeneration: 4,
  workspace: '/work/alpha',
  principal: 'owner:lark:123',
  principalRecordId: 'principal-owner-record',
  principalVersion: 8,
}

function policyCreationIntent(
  idempotencyKey: string,
  dispatch: ApprovalDispatchRouteV2,
) {
  return {
    idempotencyKey,
    requester: 'agent:primary',
    principal: 'owner:lark:123',
    action: 'evolution.adopt',
    resource: { kind: 'evolution', id: 'situation:route-fidelity' },
    diff: '{"op":"adopt"}',
    summary: 'Adopt route-fidelity guidance',
    ttlMs: 60_000,
    dispatch,
  }
}

const routeFidelityMutation = {
  op: 'adopt' as const,
  ruleId: 'rule-route-fidelity',
  input: { scopeKey, situation: 'route-fidelity', guidance: 'Keep the complete approval route.' },
  baseline: { scopeKey, situation: 'route-fidelity', failures: 4, total: 4 },
}

function retirementMutation(
  target: EvolutionStore,
  rule: StoredRule,
  expectedVersion: number,
  reason: string,
) {
  const candidate = target.retirementCandidate({
    scopeKey: rule.scopeKey,
    ruleId: rule.id,
    window: 10,
    minSample: 1,
    retireFailureRate: 0.4,
  })!
  return {
    op: 'retire' as const,
    scopeKey: rule.scopeKey,
    ruleId: rule.id,
    situation: rule.situation,
    guidance: rule.guidance,
    generation: rule.generation,
    expectedVersion,
    reason,
    evaluation: candidate.stats,
    baseline: candidate.baseline!,
    evidence: {
      sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
      digest: candidate.evidenceDigest,
      total: candidate.evidenceTotal,
    },
  }
}

describe('evidence ledger', () => {
  test('replays an identical projection and rejects a reused version with new content', () => {
    const target = store()
    const first = observe(target, 'weekly-report', 'failed', 1)
    expect(observe(target, 'weekly-report', 'failed', 1)).toEqual(first)

    const subjectRef = JSON.stringify(['evaluation-outcome', 'weekly-report', 1])
    expect(() => target.applyTaskLearningProjection({
      scopeKey,
      scopeWatermark: nextProjectionScopeWatermark(),
      subjectKind: 'outcome',
      subjectRef,
      version: 1,
      digest: projectionDigest({
        scopeKey, subjectRef, situation: 'weekly-report', outcome: 'succeeded', ruleId: null,
      }),
      disposition: 'upsert',
      situation: 'weekly-report',
      outcome: 'succeeded',
      detail: 'attempt 1',
      evidenceRef: 'evaluation:weekly-report:1',
      occurredAt: 1_001,
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'idempotency-conflict' }))
    target.close()
  })

  test('deduplicates one immutable projection across advancing scope watermarks', () => {
    const target = store()
    const subjectRef = 'evaluation-outcome:immutable-42'
    const input = {
      scopeKey,
      subjectKind: 'outcome' as const,
      subjectRef,
      version: 1,
      digest: projectionDigest({ subjectRef, outcome: 'failed' }),
      disposition: 'upsert' as const,
      situation: 'weekly-report',
      outcome: 'failed' as const,
      detail: 'objective assertion failed',
      evidenceRef: 'evaluation:immutable-42',
      occurredAt: 1_042,
    }
    const first = target.applyTaskLearningProjection({
      ...input,
      scopeWatermark: nextProjectionScopeWatermark(),
    }).episode!
    const replay = target.applyTaskLearningProjection({
      ...input,
      scopeWatermark: nextProjectionScopeWatermark(),
    }).episode!

    expect(replay).toEqual(first)
    expect(target.stats(scopeKey, 'weekly-report', 10)).toMatchObject({ failures: 1, total: 1 })

    for (const conflicting of [
      {
        ...input,
        outcome: 'succeeded' as const,
        digest: projectionDigest({ subjectRef, outcome: 'succeeded' }),
      },
      {
        ...input,
        detail: 'a different canonical assessment',
        digest: projectionDigest({ subjectRef, detail: 'a different canonical assessment' }),
      },
      {
        ...input,
        ruleId: 'different-rule',
        guidanceVersion: 1,
        digest: projectionDigest({ subjectRef, ruleId: 'different-rule', guidanceVersion: 1 }),
      },
    ]) {
      expect(() => target.applyTaskLearningProjection({
        ...conflicting,
        scopeWatermark: nextProjectionScopeWatermark(),
      })).toThrowError(
        expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'idempotency-conflict' }),
      )
    }
    target.close()
  })

  test('replaces one learning vote with newer canonical revisions and rejects same-version disagreement', () => {
    const target = store()
    const subjectRef = 'automation-run:daily-report:run-42'
    const common = {
      scopeKey,
      subjectKind: 'automation-run' as const,
      subjectRef,
      situation: 'automation:daily-report',
      outcome: 'failed' as const,
      detail: 'authoritative Evaluation objective: not-achieved',
      occurredAt: 1_042,
      disposition: 'upsert' as const,
    }
    const first = target.applyTaskLearningProjection({
      ...common,
      scopeWatermark: nextProjectionScopeWatermark(),
      version: 1,
      digest: projectionDigest({ subjectRef, version: 1, outcome: 'failed' }),
      evidenceRef: 'evaluation:first-assessment',
    }).episode!
    const sameSubject = target.applyTaskLearningProjection({
      ...common,
      scopeWatermark: nextProjectionScopeWatermark(),
      version: 2,
      digest: projectionDigest({ subjectRef, version: 2, outcome: 'failed' }),
      detail: 'independent verification also failed',
      evidenceRef: 'evaluation:second-assessment',
    }).episode!

    expect(sameSubject.id).not.toBe(first.id)
    expect(sameSubject.evidenceRef).toBe('evaluation:second-assessment')
    expect(target.stats(scopeKey, common.situation, 10)).toMatchObject({ failures: 1, total: 1 })
    expect(() => target.applyTaskLearningProjection({
      ...common,
      scopeWatermark: nextProjectionScopeWatermark(),
      version: 2,
      digest: projectionDigest({ subjectRef, version: 2, outcome: 'succeeded' }),
      outcome: 'succeeded',
      detail: 'authoritative Evaluation objective: achieved',
      evidenceRef: 'evaluation:contradictory-assessment',
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({
      code: 'idempotency-conflict',
    }))
    target.close()
  })

  test('counts failures only within the most recent window', () => {
    const target = store()
    for (let index = 1; index <= 6; index += 1) observe(target, 'sync', 'failed', index)
    for (let index = 7; index <= 9; index += 1) observe(target, 'sync', 'succeeded', index)

    expect(target.stats(scopeKey, 'sync', 3)).toMatchObject({ failures: 0, total: 3 })
    expect(target.stats(scopeKey, 'sync', 9)).toMatchObject({ failures: 6, total: 9 })
    target.close()
  })

  test('rejects unbounded or empty inputs instead of storing them', () => {
    const target = store()
    expect(() => observe(target, '   ', 'failed', 1))
      .toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'invalid-input' }))
    expect(() => target.stats(scopeKey, 'sync', 0))
      .toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'invalid-input' }))
    target.close()
  })
})

describe('versioned Evaluation task projections', () => {
  const digestFor = (version: number, marker = 0) => (version * 16 + marker).toString(16).padStart(64, '0')

  function upsertProjection(
    target: EvolutionStore,
    subjectRef: string,
    version: number,
    outcome: 'succeeded' | 'failed',
    situation = 'projection-window',
    occurredAt = 2_000 + version,
  ) {
    return target.applyTaskLearningProjection({
      scopeKey,
      scopeWatermark: nextProjectionScopeWatermark(),
      subjectKind: 'outcome',
      subjectRef,
      version,
      digest: digestFor(version),
      disposition: 'upsert',
      situation,
      outcome,
      detail: `authoritative revision ${version}`,
      evidenceRef: `evaluation:${subjectRef}:${version}`,
      occurredAt,
    })
  }

  test('accepts first version N, exact replay and gaps while rejecting rollback or same-version corruption', () => {
    const target = store()
    const first = upsertProjection(target, 'task:42', 5, 'failed')
    const replay = upsertProjection(target, 'task:42', 5, 'failed')
    expect(first.replayed).toBe(false)
    expect(replay).toMatchObject({ replayed: true, episode: { id: first.episode!.id } })

    expect(() => target.applyTaskLearningProjection({
      scopeKey,
      scopeWatermark: nextProjectionScopeWatermark(),
      subjectKind: 'outcome',
      subjectRef: 'task:42',
      version: 5,
      digest: digestFor(5, 1),
      disposition: 'retract',
      situation: 'projection-window',
      occurredAt: 2_005,
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({
      code: 'idempotency-conflict',
    }))
    expect(() => upsertProjection(target, 'task:42', 4, 'failed')).toThrowError(
      expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'version-conflict' }),
    )

    const replacement = upsertProjection(target, 'task:42', 9, 'succeeded')
    expect(replacement.episode?.id).not.toBe(first.episode?.id)
    expect(target.stats(scopeKey, 'projection-window', 10)).toMatchObject({ failures: 0, total: 1 })

    target.applyTaskLearningProjection({
      scopeKey,
      scopeWatermark: nextProjectionScopeWatermark(),
      subjectKind: 'outcome',
      subjectRef: 'task:42',
      version: 11,
      digest: digestFor(11),
      disposition: 'retract',
      situation: 'projection-window',
      occurredAt: 2_011,
    })
    expect(target.stats(scopeKey, 'projection-window', 10)).toMatchObject({ failures: 0, total: 0 })
    expect(target.getTaskLearningProjection({
      scopeKey,
      subjectKind: 'outcome',
      subjectRef: 'task:42',
    })).toMatchObject({ version: 11, disposition: 'retract' })

    upsertProjection(target, 'task:42', 14, 'failed')
    expect(target.stats(scopeKey, 'projection-window', 10)).toMatchObject({ failures: 1, total: 1 })
    expect(target.health()).toMatchObject({
      taskLearningProjections: 1,
      retractedTaskLearningProjections: 0,
      taskLearningProjectionRevisions: 4,
      taskLearningProjectionIntegrityErrors: 0,
    })
    target.close()
  })

  test('invalidates pending cards and refuses stale creation when a non-rendered window row changes', () => {
    const target = store()
    for (let index = 1; index <= 4; index += 1) {
      upsertProjection(target, `pending:${index}`, 1, 'failed', 'pending-window', 3_000 + index)
    }
    const candidate = target.candidates({
      ...thresholds,
      evidenceSampleLimit: 1,
    }).find(entry => entry.situation === 'pending-window')!
    expect(candidate.evidence).toHaveLength(1)
    expect(candidate.evidenceTotal).toBe(4)
    const mutation = {
      op: 'adopt' as const,
      input: { scopeKey, situation: 'pending-window', guidance: 'Use the reviewed workflow.' },
      baseline: candidate.stats,
      evidence: {
        sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
        digest: candidate.evidenceDigest,
        total: candidate.evidenceTotal,
        window: 10,
      },
    }
    const pending = target.createProposal({
      idempotencyKey: 'projection:pending-card',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation,
      expiresAt: 61_000,
    })
    upsertProjection(target, 'pending:1', 2, 'succeeded', 'pending-window', 3_001)
    expect(target.getProposal(pending.proposalId)?.status).toBe('conflicted')

    for (let index = 1; index <= 4; index += 1) {
      upsertProjection(target, `creation:${index}`, 1, 'failed', 'creation-window', 4_000 + index)
    }
    const stale = target.candidates({
      ...thresholds,
      evidenceSampleLimit: 1,
    }).find(entry => entry.situation === 'creation-window')!
    upsertProjection(target, 'creation:1', 2, 'succeeded', 'creation-window', 4_001)
    expect(() => target.createProposal({
      idempotencyKey: 'projection:stale-create',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: {
        op: 'adopt',
        input: { scopeKey, situation: 'creation-window', guidance: 'Never apply stale evidence.' },
        baseline: stale.stats,
        evidence: {
          sampleEpisodeIds: stale.evidence.map(entry => entry.episodeId),
          digest: stale.evidenceDigest,
          total: stale.evidenceTotal,
          window: 10,
        },
      },
      expiresAt: 61_000,
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({
      code: 'version-conflict',
    }))
    target.close()
  })
})

describe('candidate detection', () => {
  test('quarantines operational failures even when trusted infrastructure recorded them', () => {
    const target = store()
    for (let index = 1; index <= 5; index += 1) {
      const episode = target.recordEpisode({
        scopeKey,
        situation: 'automation:heartbeat',
        outcome: 'failed',
        detail: `configuration failure ${index}`,
        source: 'automation',
        trust: 'trusted',
        evidenceKind: 'operational',
        occurredAt: 1_000 + index,
        idempotencyKey: `heartbeat-operational:${index}`,
      })
      expect(episode).toMatchObject({ evidenceKind: 'operational', learningEligible: false })
    }

    expect(target.stats(scopeKey, 'automation:heartbeat', 10)).toMatchObject({ failures: 0, total: 0 })
    expect(target.candidates(thresholds)).toEqual([])
    target.close()
  })

  test('requires an immutable Evaluation reference before quality evidence is eligible', () => {
    const target = store()
    expect(() => target.recordEpisode({
      scopeKey,
      situation: 'weekly-report',
      outcome: 'failed',
      detail: 'assertion failed',
      source: 'automation',
      trust: 'trusted',
      evidenceKind: 'objective',
      occurredAt: 1_001,
      idempotencyKey: 'missing-evaluation-ref',
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'invalid-input' }))
    target.close()
  })

  test('stays silent until the sample is large enough', () => {
    const target = store()
    observe(target, 'weekly-report', 'failed', 1)
    observe(target, 'weekly-report', 'failed', 2)

    // Two failures is a coincidence, not a lesson worth changing behaviour over.
    expect(target.candidates(thresholds)).toEqual([])
    target.close()
  })

  test('proposes adoption once a situation fails often enough', () => {
    const target = store()
    for (let index = 1; index <= 3; index += 1) observe(target, 'weekly-report', 'failed', index)
    observe(target, 'weekly-report', 'succeeded', 4)

    const candidates = target.candidates(thresholds)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      situation: 'weekly-report',
      kind: 'adopt',
      stats: { failures: 3, total: 4 },
    })
    target.close()
  })

  test('never proposes adoption while a rule is already active for that situation', () => {
    const target = store()
    for (let index = 1; index <= 4; index += 1) observe(target, 'weekly-report', 'failed', index)
    const adopted = adopt(target, 'weekly-report', { failures: 4, total: 4 })
    expect(adopted.proposal.status).toBe('approved')

    // Later evidence must not produce a second, competing rule for one situation.
    for (let index = 5; index <= 8; index += 1) observe(target, 'weekly-report', 'failed', index)
    expect(target.candidates(thresholds).every(candidate => candidate.kind === 'retire')).toBe(true)
    target.close()
  })

  test('proposes retirement when an active rule does not beat its own baseline', () => {
    const target = store()
    for (let index = 1; index <= 4; index += 1) observe(target, 'flaky', 'failed', index)
    const rule = adopt(target, 'flaky', { failures: 4, total: 4 }).rule!
    const attributed = []
    for (let index = 5; index <= 8; index += 1) {
      attributed.push(observe(target, 'flaky', 'failed', index, rule.id))
    }
    observe(target, 'flaky', 'failed', 9)
    observe(target, 'flaky', 'failed', 10, 'another-rule')

    const candidates = target.candidates(thresholds)

    expect(candidates[0]).toMatchObject({ kind: 'retire', ruleId: rule.id, baseline: { failures: 4, total: 4 } })
    expect(candidates[0]?.evidence.map(entry => entry.episodeId))
      .toEqual(attributed.toReversed().map(entry => entry.id))
    expect(candidates[0]?.evidenceTotal).toBe(4)
    target.close()
  })

  test('keeps a rule that improved the situation below its baseline', () => {
    const target = store()
    for (let index = 1; index <= 4; index += 1) observe(target, 'improved', 'failed', index)
    const rule = adopt(target, 'improved', { failures: 4, total: 4 }).rule!
    for (let index = 5; index <= 12; index += 1) observe(target, 'improved', 'succeeded', index, rule.id)

    expect(target.candidates(thresholds)).toEqual([])
    target.close()
  })

  test('after retirement requires a fresh unattributed baseline before readoption', () => {
    let now = 2_000
    const target = store(() => now)
    for (let index = 1; index <= 4; index += 1) observe(target, 'readopt', 'failed', index)
    const rule = adopt(target, 'readopt', { failures: 4, total: 4 }).rule!
    now = 3_000
    observe(target, 'readopt', 'failed', 3_001, rule.id)
    const retirement = target.createProposal({
      idempotencyKey: 'retire:readopt',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: retirementMutation(target, rule, rule.version, 'did not help'),
      expiresAt: 61_000,
    })
    target.attachPolicy(retirement.proposalId, 'policy-retire-readopt')
    target.settleProposal({
      proposalId: retirement.proposalId,
      policyStatus: 'approved',
      policyVersion: 2,
    })

    expect(target.candidates(thresholds)).toEqual([])
    for (let index = 1; index <= 3; index += 1) {
      observe(target, 'readopt', 'failed', 2_000 + index)
    }
    expect(target.candidates(thresholds)).toEqual([])
    observe(target, 'readopt', 'failed', 2_004)
    expect(target.candidates(thresholds)).toMatchObject([{
      kind: 'adopt', situation: 'readopt', stats: { failures: 4, total: 4 },
    }])
    target.close()
  })
})

describe('autonomous low-risk rollback', () => {
  const rollbackOptions = (rule: StoredRule) => ({
    scopeKey,
    ruleId: rule.id,
    expectedVersion: rule.version,
    window: 10,
    minSample: 4,
    retireFailureRate: 0.4,
    evidenceSampleLimit: 2,
  })

  test('atomically retires only an exact rule with Host-derived regression evidence', () => {
    const target = store()
    const rule = adopt(target, 'rollback-regression', { failures: 4, total: 4 }).rule!
    const episodes: Array<{ id: string }> = []
    for (let index = 1; index <= 4; index += 1) {
      episodes.push(observe(target, rule.situation, 'failed', index, rule.id))
    }

    const result = target.rollbackRule(rollbackOptions(rule))

    expect(result).toMatchObject({
      replayed: false,
      rule: { id: rule.id, status: 'retired', version: 2 },
      rollback: {
        scopeKey,
        ruleId: rule.id,
        expectedVersion: 1,
        resultVersion: 2,
        risk: 'low',
        evaluation: { failures: 4, total: 4 },
        baseline: { failures: 4, total: 4 },
        evidence: { total: 4 },
      },
    })
    expect(result.rollback.reason).toMatch(/Automatic low-risk rollback.*4\/4.*4\/4/u)
    expect(result.rollback.evidence.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.rollback.evidence.sampleEpisodeIds)
      .toEqual(episodes.toReversed().slice(0, 2).map(episode => episode.id))
    expect(target.activeRule(scopeKey, rule.situation)).toBeUndefined()
    expect(target.health()).toMatchObject({ autonomousRollbacks: 1, retiredRules: 1 })
    target.close()
  })

  test('replays the exact target and expected version without a second mutation', () => {
    const target = store()
    const rule = adopt(target, 'rollback-replay', { failures: 4, total: 4 }).rule!
    for (let index = 1; index <= 4; index += 1) {
      observe(target, rule.situation, 'failed', index, rule.id)
    }

    const first = target.rollbackRule(rollbackOptions(rule))
    const replay = target.rollbackRule(rollbackOptions(rule))

    expect(replay.replayed).toBe(true)
    expect(replay.rollback).toEqual(first.rollback)
    expect(replay.rule).toEqual(first.rule)
    expect(target.health().autonomousRollbacks).toBe(1)
    target.close()
  })

  test('fails closed for insufficient, improved, cross-scope, or stale evidence', () => {
    const target = store()
    const insufficient = adopt(target, 'rollback-insufficient', { failures: 4, total: 4 }).rule!
    for (let index = 1; index <= 3; index += 1) {
      observe(target, insufficient.situation, 'failed', index, insufficient.id)
    }
    expect(() => target.rollbackRule(rollbackOptions(insufficient)))
      .toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'invalid-state' }))

    const improved = adopt(target, 'rollback-improved', { failures: 4, total: 4 }).rule!
    for (let index = 1; index <= 2; index += 1) {
      observe(target, improved.situation, 'failed', index, improved.id)
    }
    for (let index = 3; index <= 4; index += 1) {
      observe(target, improved.situation, 'succeeded', index, improved.id)
    }
    expect(() => target.rollbackRule(rollbackOptions(improved)))
      .toThrowError(/regression evidence/u)
    expect(() => target.rollbackRule({
      ...rollbackOptions(improved),
      scopeKey: JSON.stringify(['/work/beta', 'primary']),
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'not-found' }))
    expect(() => target.rollbackRule({ ...rollbackOptions(improved), expectedVersion: 99 }))
      .toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'version-conflict' }))
    expect(target.listRules(scopeKey, 'active')).toHaveLength(2)
    expect(target.health().autonomousRollbacks).toBe(0)
    target.close()
  })
})

function adopt(target: EvolutionStore, situation: string, baseline: { failures: number; total: number }) {
  const proposal = target.createProposal({
    idempotencyKey: `adopt:${situation}`,
    requester: 'agent:primary',
    principal: 'owner:lark:123',
    mutation: {
      op: 'adopt',
      ruleId: `rule-${situation}`,
      input: { scopeKey, situation, guidance: `Take extra care with ${situation}.` },
      baseline: { scopeKey, situation, ...baseline },
    },
    expiresAt: 61_000,
  })
  target.attachPolicy(proposal.proposalId, `policy-${situation}`)
  return target.settleProposal({
    proposalId: proposal.proposalId,
    policyStatus: 'approved',
    policyVersion: 2,
  })
}

describe('approval-gated rule changes', () => {
  test('round-trips a complete v2 Policy creation route across SQLite restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-evolution-route-v2-'))
    roots.push(root)
    const path = join(root, 'evolution.sqlite')
    const first = new EvolutionStore({ path, now: () => 1_000 })
    const idempotencyKey = 'adopt:route-fidelity'
    const created = first.createProposal({
      idempotencyKey,
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: routeFidelityMutation,
      expiresAt: 61_000,
      creationIntent: policyCreationIntent(idempotencyKey, v2Dispatch),
    })
    expect(created.creationIntent?.dispatch).toStrictEqual(v2Dispatch)
    first.close()

    const raw = new DatabaseSync(path, { readOnly: true })
    const row = raw.prepare('SELECT creation_intent_json FROM evolution_proposals WHERE id = ?')
      .get(created.proposalId) as { creation_intent_json: string }
    expect((JSON.parse(row.creation_intent_json) as { dispatch: unknown }).dispatch)
      .toStrictEqual(v2Dispatch)
    raw.close()

    const reopened = new EvolutionStore({ path, now: () => 2_000 })
    expect(reopened.getProposal(created.proposalId)?.creationIntent?.dispatch)
      .toStrictEqual(v2Dispatch)
    expect(reopened.listPendingProposals(10)[0]?.creationIntent?.dispatch)
      .toStrictEqual(v2Dispatch)
    reopened.close()
  })

  test('reads a legacy v1 creation route but rejects it at the new write boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-evolution-route-v1-'))
    roots.push(root)
    const path = join(root, 'evolution.sqlite')
    const target = new EvolutionStore({ path, now: () => 1_000 })
    const idempotencyKey = 'adopt:legacy-route'
    const legacyDispatch: ApprovalDispatchRoute = {
      sourceId: v2Dispatch.sourceId,
      bindingId: v2Dispatch.bindingId,
      workspace: v2Dispatch.workspace,
      principal: v2Dispatch.principal,
    }
    expect(() => target.createProposal({
      idempotencyKey,
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: routeFidelityMutation,
      expiresAt: 61_000,
      creationIntent: policyCreationIntent(
        idempotencyKey,
        legacyDispatch as unknown as ApprovalDispatchRouteV2,
      ),
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'invalid-input' }))

    const created = target.createProposal({
      idempotencyKey,
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: routeFidelityMutation,
      expiresAt: 61_000,
      creationIntent: policyCreationIntent(idempotencyKey, v2Dispatch),
    })
    target.close()
    const database = new DatabaseSync(path)
    const row = database.prepare('SELECT creation_intent_json FROM evolution_proposals WHERE id = ?')
      .get(created.proposalId) as { creation_intent_json: string }
    const intent = JSON.parse(row.creation_intent_json) as Record<string, unknown>
    database.prepare('UPDATE evolution_proposals SET creation_intent_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...intent, dispatch: legacyDispatch }), created.proposalId)
    database.close()
    const reopened = new EvolutionStore({ path, now: () => 2_000 })
    expect(reopened.getProposal(created.proposalId)?.creationIntent?.dispatch)
      .toStrictEqual(legacyDispatch)
    reopened.close()
  })

  test.each([
    ['bindingVersion', { bindingVersion: v2Dispatch.bindingVersion + 1 }],
    ['bindingGeneration', { bindingGeneration: v2Dispatch.bindingGeneration + 1 }],
    ['principalRecordId', { principalRecordId: `${v2Dispatch.principalRecordId}-other` }],
    ['principalVersion', { principalVersion: v2Dispatch.principalVersion + 1 }],
  ])('rejects a creation-intent winner replay with changed %s', (_field, changed) => {
    const target = store()
    const idempotencyKey = `adopt:route-winner:${_field}`
    const input = {
      idempotencyKey,
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: routeFidelityMutation,
      expiresAt: 61_000,
    }
    target.createProposal({
      ...input,
      creationIntent: policyCreationIntent(idempotencyKey, v2Dispatch),
    })
    expect(() => target.createProposal({
      ...input,
      creationIntent: policyCreationIntent(
        idempotencyKey,
        { ...v2Dispatch, ...changed } as ApprovalDispatchRouteV2,
      ),
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({
      code: 'idempotency-conflict',
    }))
    target.close()
  })

  test.each([
    ['missing fence', { ...v2Dispatch, principalVersion: undefined }],
    ['invalid generation', { ...v2Dispatch, bindingGeneration: 0 }],
    ['unknown key', { ...v2Dispatch, unexpected: true }],
  ])('rejects a tampered stored v2 creation route: %s', (_case, malformed) => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-evolution-route-tamper-'))
    roots.push(root)
    const path = join(root, 'evolution.sqlite')
    const first = new EvolutionStore({ path, now: () => 1_000 })
    const idempotencyKey = `adopt:route-tamper:${_case}`
    const created = first.createProposal({
      idempotencyKey,
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: routeFidelityMutation,
      expiresAt: 61_000,
      creationIntent: policyCreationIntent(idempotencyKey, v2Dispatch),
    })
    first.close()

    const database = new DatabaseSync(path)
    const row = database.prepare('SELECT creation_intent_json FROM evolution_proposals WHERE id = ?')
      .get(created.proposalId) as { creation_intent_json: string }
    const intent = JSON.parse(row.creation_intent_json) as Record<string, unknown>
    database.prepare('UPDATE evolution_proposals SET creation_intent_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...intent, dispatch: malformed }), created.proposalId)
    database.close()

    const reopened = new EvolutionStore({ path, now: () => 2_000 })
    expect(() => reopened.getProposal(created.proposalId))
      .toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'invalid-state' }))
    reopened.close()
  })

  test('refuses to activate a proposal whose frozen samples are only operational telemetry', () => {
    const target = store()
    const episodes: Array<{ id: string }> = []
    for (let index = 1; index <= 4; index += 1) {
      episodes.push(target.recordEpisode({
        scopeKey,
        situation: 'automation:operational-only',
        outcome: 'failed',
        detail: `provider failure ${index}`,
        source: 'automation',
        trust: 'trusted',
        evidenceKind: 'operational',
        occurredAt: 1_000 + index,
        idempotencyKey: `operational-activation:${index}`,
      }))
    }
    expect(() => target.createProposal({
      idempotencyKey: 'adopt:operational-only',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: {
        op: 'adopt',
        input: {
          scopeKey,
          situation: 'automation:operational-only',
          guidance: 'Do not learn from this.',
        },
        baseline: {
          scopeKey,
          situation: 'automation:operational-only',
          failures: 4,
          total: 4,
        },
        evidence: {
          sampleEpisodeIds: episodes.map(episode => episode.id),
          digest: 'a'.repeat(64),
          total: 4,
        },
      },
      expiresAt: 61_000,
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({
      code: 'version-conflict',
    }))
    expect(target.listRules(scopeKey)).toEqual([])
    target.close()
  })

  test('a pending proposal changes nothing until it is settled', () => {
    const target = store()
    const proposal = target.createProposal({
      idempotencyKey: 'adopt:weekly-report',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: {
        op: 'adopt',
        ruleId: 'rule-weekly-report',
        input: { scopeKey, situation: 'weekly-report', guidance: 'Draft the report a day early.' },
        baseline: { scopeKey, situation: 'weekly-report', failures: 3, total: 4 },
      },
      expiresAt: 61_000,
    })

    expect(proposal.status).toBe('pending')
    expect(target.listRules(scopeKey)).toEqual([])
    target.close()
  })

  test('a rejection leaves no rule behind', () => {
    const target = store()
    const proposal = target.createProposal({
      idempotencyKey: 'adopt:rejected',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: {
        op: 'adopt',
        ruleId: 'rule-rejected',
        input: { scopeKey, situation: 'rejected', guidance: 'Never adopted.' },
        baseline: { scopeKey, situation: 'rejected', failures: 4, total: 4 },
      },
      expiresAt: 61_000,
    })
    target.attachPolicy(proposal.proposalId, 'policy-rejected')

    const settled = target.settleProposal({
      proposalId: proposal.proposalId,
      policyStatus: 'rejected',
      policyVersion: 2,
    })

    expect(settled.proposal.status).toBe('rejected')
    expect(target.listRules(scopeKey)).toEqual([])
    expect(target.getEvolutionApplicationReceipt(proposal.proposalId)).toMatchObject({
      localProposalId: proposal.proposalId,
      policyProposalId: 'policy-rejected',
      applicationStatus: 'rejected',
      operation: 'adopt',
      revision: 2,
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(target.listPendingEvolutionApplicationReceipts(10)).toHaveLength(1)
    target.close()
  })

  test('records Policy expiry as a domain terminal receipt without applying guidance', () => {
    const target = store()
    const proposal = target.createProposal({
      idempotencyKey: 'adopt:expired',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: {
        op: 'adopt',
        input: { scopeKey, situation: 'expired', guidance: 'Never applied.' },
        baseline: { scopeKey, situation: 'expired', failures: 4, total: 4 },
      },
      expiresAt: 61_000,
    })
    target.attachPolicy(proposal.proposalId, 'policy-expired')

    const settled = target.settleProposal({
      proposalId: proposal.proposalId,
      policyStatus: 'expired',
      policyVersion: 2,
    })

    expect(settled.proposal.status).toBe('expired')
    expect(target.getEvolutionApplicationReceipt(proposal.proposalId)).toMatchObject({
      policyProposalId: 'policy-expired',
      applicationStatus: 'expired',
      operation: 'adopt',
    })
    expect(target.listRules(scopeKey)).toEqual([])
    target.close()
  })

  test('settling twice is idempotent and does not duplicate the rule', () => {
    const target = store()
    const first = adopt(target, 'weekly-report', { failures: 4, total: 4 })
    const replay = target.settleProposal({
      proposalId: first.proposal.proposalId,
      policyStatus: 'approved',
      policyVersion: 2,
    })

    expect(replay.replayed).toBe(true)
    expect(target.listRules(scopeKey, 'active')).toHaveLength(1)
    const receipt = target.getEvolutionApplicationReceipt(first.proposal.proposalId)!
    expect(receipt).toMatchObject({
      policyProposalId: 'policy-weekly-report',
      applicationStatus: 'applied',
      operation: 'adopt',
      ruleId: first.rule!.id,
      resultingRuleVersion: 1,
      ruleStatus: 'active',
      revision: 2,
    })
    const pending = target.listPendingEvolutionApplicationReceipts(10)[0]!
    expect(pending).toMatchObject({ state: 'pending', attemptCount: 0 })
    expect(target.settleEvolutionApplicationPublication({
      localProposalId: receipt.localProposalId,
      receiptDigest: receipt.receiptDigest,
      outcome: 'retry',
      error: 'delivery-test-error',
    })).toMatchObject({ state: 'pending', attemptCount: 1, lastError: 'delivery-test-error' })
    expect(target.settleEvolutionApplicationPublication({
      localProposalId: receipt.localProposalId,
      receiptDigest: receipt.receiptDigest,
      outcome: 'published',
    })).toMatchObject({ state: 'published', attemptCount: 2 })
    expect(target.listPendingEvolutionApplicationReceipts(10)).toEqual([])
    target.close()
  })

  test('recovers an unacknowledged terminal presentation after process restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-evolution-receipt-restart-'))
    roots.push(root)
    const path = join(root, 'evolution.sqlite')
    const first = new EvolutionStore({ path, now: () => 7_000 })
    const local = first.createProposal({
      idempotencyKey: 'adopt:restart-receipt',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: {
        op: 'adopt',
        input: { scopeKey, situation: 'restart-receipt', guidance: 'Persist the receipt.' },
        baseline: { scopeKey, situation: 'restart-receipt', failures: 4, total: 4 },
      },
      expiresAt: 61_000,
    })
    first.attachPolicy(local.proposalId, 'policy-restart-receipt')
    first.settleProposal({
      proposalId: local.proposalId,
      policyStatus: 'approved',
      policyVersion: 2,
    })
    const before = first.getEvolutionApplicationReceipt(local.proposalId)!
    first.close()

    const reopened = new EvolutionStore({ path, now: () => 8_000 })
    expect(reopened.getEvolutionApplicationReceipt(local.proposalId)).toEqual(before)
    expect(reopened.listPendingEvolutionApplicationReceipts(10)).toMatchObject([{
      state: 'pending',
      attemptCount: 0,
      receipt: { receiptDigest: before.receiptDigest },
    }])
    reopened.settleEvolutionApplicationPublication({
      localProposalId: local.proposalId,
      receiptDigest: before.receiptDigest,
      outcome: 'published',
    })
    expect(reopened.listPendingEvolutionApplicationReceipts(10)).toEqual([])
    reopened.close()
  })

  test('a competing active rule conflicts instead of overwriting the approved one', () => {
    const target = store()
    adopt(target, 'weekly-report', { failures: 4, total: 4 })
    const second = target.createProposal({
      idempotencyKey: 'adopt:weekly-report:again',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: {
        op: 'adopt',
        ruleId: 'rule-weekly-report-2',
        input: { scopeKey, situation: 'weekly-report', guidance: 'A competing directive.' },
        baseline: { scopeKey, situation: 'weekly-report', failures: 4, total: 4 },
      },
      expiresAt: 61_000,
    })
    target.attachPolicy(second.proposalId, 'policy-weekly-report-2')

    const settled = target.settleProposal({
      proposalId: second.proposalId,
      policyStatus: 'approved',
      policyVersion: 2,
    })

    expect(settled.proposal.status).toBe('conflicted')
    expect(target.listRules(scopeKey, 'active')).toHaveLength(1)
    expect(target.getEvolutionApplicationReceipt(second.proposalId)).toMatchObject({
      applicationStatus: 'conflicted',
      operation: 'adopt',
    })
    target.close()
  })

  test('retirement requires the expected version and is a compare-and-set', () => {
    const target = store()
    const rule = adopt(target, 'flaky', { failures: 4, total: 4 }).rule!
    observe(target, 'flaky', 'failed', 100, rule.id)
    const stale = target.createProposal({
      idempotencyKey: 'retire:flaky:stale',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: retirementMutation(target, rule, 99, 'stale view'),
      expiresAt: 61_000,
    })
    target.attachPolicy(stale.proposalId, 'policy-retire-stale')

    const settled = target.settleProposal({
      proposalId: stale.proposalId,
      policyStatus: 'approved',
      policyVersion: 2,
    })

    expect(settled.proposal.status).toBe('conflicted')
    expect(target.getRule(rule.id)?.status).toBe('active')
    target.close()
  })

  test('retires an active rule and frees the situation for a fresh proposal', () => {
    const target = store()
    const rule = adopt(target, 'flaky', { failures: 4, total: 4 }).rule!
    observe(target, 'flaky', 'failed', 100, rule.id)
    const retire = target.createProposal({
      idempotencyKey: 'retire:flaky',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: retirementMutation(target, rule, rule.version, 'did not help'),
      expiresAt: 61_000,
    })
    target.attachPolicy(retire.proposalId, 'policy-retire')

    const settled = target.settleProposal({
      proposalId: retire.proposalId,
      policyStatus: 'approved',
      policyVersion: 2,
    })

    expect(settled.proposal.status).toBe('approved')
    expect(target.getRule(rule.id)).toMatchObject({ status: 'retired', retiredReason: 'did not help' })
    expect(target.getEvolutionApplicationReceipt(retire.proposalId)).toMatchObject({
      applicationStatus: 'applied',
      operation: 'retire',
      ruleId: rule.id,
      resultingRuleVersion: 2,
      ruleStatus: 'retired',
    })
    expect(target.activeRule(scopeKey, 'flaky')).toBeUndefined()
    target.close()
  })

  test('rejects a baseline that misstates its own evidence', () => {
    const target = store()
    expect(() => target.createProposal({
      idempotencyKey: 'adopt:bad-baseline',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: {
        op: 'adopt',
        ruleId: 'rule-bad',
        input: { scopeKey, situation: 'bad', guidance: 'Impossible baseline.' },
        baseline: { scopeKey, situation: 'bad', failures: 5, total: 4 },
      },
      expiresAt: 61_000,
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'invalid-input' }))
    target.close()
  })

  test('rejects malformed adoption evidence references before they reach an approval diff', () => {
    const target = store()
    expect(() => target.createProposal({
      idempotencyKey: 'adopt:bad-evidence-reference',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      mutation: {
        op: 'adopt',
        input: { scopeKey, situation: 'bad-evidence', guidance: 'Do not trust forged provenance.' },
        baseline: { scopeKey, situation: 'bad-evidence', failures: 4, total: 4 },
        evidence: {
          sampleEpisodeIds: ['episode-forged\napproval text'],
          digest: 'a'.repeat(64),
          total: 4,
        },
      },
      expiresAt: 61_000,
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'invalid-input' }))
    target.close()
  })

  test('survives a restart with the adopted rule intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-evolution-restart-'))
    roots.push(root)
    const path = join(root, 'evolution.sqlite')
    const first = new EvolutionStore({ path, now: () => 1_000 })
    adopt(first, 'weekly-report', { failures: 4, total: 4 })
    first.close()

    const second = new EvolutionStore({ path, now: () => 2_000 })
    expect(second.listRules(scopeKey, 'active')).toMatchObject([{ situation: 'weekly-report', status: 'active' }])
    second.close()
  })
})
