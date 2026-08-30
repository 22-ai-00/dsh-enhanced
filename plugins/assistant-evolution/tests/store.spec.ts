import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { EvolutionStore, EvolutionStoreError } from '../src/store.ts'
import type { StoredRule } from '../src/types.ts'

const roots: string[] = []
const scopeKey = JSON.stringify(['/work/alpha', 'primary'])

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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
  return target.recordEpisode({
    scopeKey,
    situation,
    outcome,
    detail: `attempt ${index}`,
    source: 'automation',
    trust: 'trusted',
    occurredAt: 1_000 + index,
    idempotencyKey: `${situation}:${index}`,
    ...(ruleId === undefined ? {} : { ruleId, guidanceVersion: 1 }),
  })
}

const thresholds = {
  scopeKey,
  window: 10,
  minSample: 4,
  adoptFailureRate: 0.4,
  retireFailureRate: 0.4,
  limit: 10,
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
    ruleId: rule.id,
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
  test('replays an identical episode and rejects a reused key with new content', () => {
    const target = store()
    const first = observe(target, 'weekly-report', 'failed', 1)
    expect(observe(target, 'weekly-report', 'failed', 1)).toEqual(first)

    expect(() => target.recordEpisode({
      situation: 'weekly-report',
      outcome: 'succeeded',
      detail: 'attempt 1',
      source: 'automation',
      scopeKey,
      trust: 'trusted',
      occurredAt: 1_001,
      idempotencyKey: 'weekly-report:1',
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'idempotency-conflict' }))
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

describe('candidate detection', () => {
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
    const episodes = []
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
    target.close()
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
