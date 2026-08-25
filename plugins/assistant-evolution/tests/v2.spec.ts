import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { evolutionSchemaVersion, openEvolutionDatabase } from '../src/sqlite.ts'
import { EvolutionStore, EvolutionStoreError } from '../src/store.ts'
import type { EpisodeInput, EvolutionMutation } from '../src/types.ts'

const roots: string[] = []
const alphaScope = JSON.stringify(['/work/alpha', 'primary'])
const betaScope = JSON.stringify(['/work/beta', 'primary'])

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function databasePath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `assistant-evolution-${name}-`))
  roots.push(root)
  return join(root, 'evolution.sqlite')
}

function store(now: () => number = () => 2_000): EvolutionStore {
  return new EvolutionStore({ path: databasePath('v2'), now })
}

function record(target: EvolutionStore, input: {
  scopeKey: string
  situation: string
  index: number
  outcome?: 'succeeded' | 'failed'
  trust?: 'trusted' | 'self-reported'
  source?: 'automation' | 'foreground'
  ruleId?: string
  guidanceVersion?: number
  claimedRuleId?: string
  occurredAt?: number
  idempotencyKey?: string
}) {
  return target.recordEpisode({
    scopeKey: input.scopeKey,
    situation: input.situation,
    outcome: input.outcome ?? 'failed',
    detail: `attempt ${input.index}`,
    source: input.source ?? 'automation',
    trust: input.trust ?? 'trusted',
    occurredAt: input.occurredAt ?? 1_000 + input.index,
    idempotencyKey: input.idempotencyKey ?? `${input.scopeKey}:${input.situation}:${input.index}`,
    ...(input.ruleId === undefined ? {} : {
      ruleId: input.ruleId,
      ...((input.trust ?? 'trusted') === 'trusted'
        ? { guidanceVersion: input.guidanceVersion ?? 1 }
        : {}),
    }),
    ...(input.claimedRuleId === undefined ? {} : { claimedRuleId: input.claimedRuleId }),
  } as EpisodeInput)
}

const thresholds = {
  scopeKey: alphaScope,
  window: 10,
  minSample: 4,
  adoptFailureRate: 0.4,
  retireFailureRate: 0.4,
  limit: 10,
}

function adopt(target: EvolutionStore, input: {
  scopeKey?: string
  situation: string
  callerRuleId?: string
  suffix?: string
}) {
  const scopeKey = input.scopeKey ?? alphaScope
  const proposal = target.createProposal({
    idempotencyKey: `adopt:${scopeKey}:${input.situation}:${input.suffix ?? '1'}`,
    requester: 'agent:primary',
    principal: 'owner:lark:123',
    mutation: {
      op: 'adopt',
      ruleId: input.callerRuleId ?? 'caller-controlled-rule-id',
      input: { scopeKey, situation: input.situation, guidance: `Take care with ${input.situation}.` },
      baseline: { scopeKey, situation: input.situation, failures: 4, total: 4 },
    } as EvolutionMutation,
    expiresAt: 61_000,
  })
  target.attachPolicy(proposal.proposalId, `policy:${proposal.proposalId}`)
  return target.settleProposal({ proposalId: proposal.proposalId, policyStatus: 'approved', policyVersion: 2 })
}

function retire(target: EvolutionStore, ruleId: string, expectedVersion: number) {
  const rule = target.getRule(ruleId)!
  record(target, {
    scopeKey: rule.scopeKey,
    situation: rule.situation,
    index: 9_000 + expectedVersion,
    occurredAt: rule.adoptedAt + 1,
    ruleId,
    guidanceVersion: rule.generation,
  })
  const candidate = target.retirementCandidate({
    scopeKey: rule.scopeKey,
    ruleId,
    window: 10,
    minSample: 1,
    retireFailureRate: 0.4,
  })!
  const proposal = target.createProposal({
    idempotencyKey: `retire:${ruleId}:${expectedVersion}`,
    requester: 'agent:primary',
    principal: 'owner:lark:123',
    mutation: {
      op: 'retire',
      ruleId,
      expectedVersion,
      reason: 'did not help',
      evaluation: candidate.stats,
      baseline: candidate.baseline!,
      evidence: {
        sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
        digest: candidate.evidenceDigest,
        total: candidate.evidenceTotal,
      },
    },
    expiresAt: 61_000,
  })
  target.attachPolicy(proposal.proposalId, `policy:${proposal.proposalId}`)
  return target.settleProposal({ proposalId: proposal.proposalId, policyStatus: 'approved', policyVersion: 2 })
}

describe('trusted scoped evidence', () => {
  test('an exact replay includes rule attribution and occurredAt', () => {
    const target = store()
    const common = {
      scopeKey: alphaScope,
      situation: 'weekly-report',
      index: 1,
      ruleId: 'rule-one',
      occurredAt: 1_001,
      idempotencyKey: 'run:1',
    }
    record(target, common)

    expect(() => record(target, { ...common, ruleId: 'rule-two' }))
      .toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'idempotency-conflict' }))
    expect(() => record(target, { ...common, occurredAt: 1_002 }))
      .toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'idempotency-conflict' }))
    target.close()
  })

  test('adoption uses only trusted unattributed evidence from the requested scope', () => {
    const target = store()
    for (let index = 1; index <= 4; index += 1) {
      record(target, { scopeKey: alphaScope, situation: 'weekly-report', index })
      record(target, { scopeKey: betaScope, situation: 'weekly-report', index, idempotencyKey: `beta:${index}` })
      record(target, {
        scopeKey: alphaScope,
        situation: 'self-reported',
        index,
        trust: 'self-reported',
        source: 'foreground',
      })
    }

    expect(target.candidates(thresholds)).toMatchObject([{
      kind: 'adopt', situation: 'weekly-report', scopeKey: alphaScope,
      stats: { failures: 4, total: 4 },
    }])
    expect(target.candidates({ ...thresholds, scopeKey: betaScope })).toMatchObject([{
      kind: 'adopt', situation: 'weekly-report', scopeKey: betaScope,
    }])
    expect(target.candidates({ ...thresholds, scopeKey: alphaScope })
      .some(candidate => candidate.situation === 'self-reported')).toBe(false)
    target.close()
  })

  test('does not retire from pre-adoption, untrusted, or wrongly attributed evidence', () => {
    const target = store(() => 2_000)
    for (let index = 1; index <= 4; index += 1) {
      record(target, { scopeKey: alphaScope, situation: 'flaky', index, occurredAt: 1_000 + index })
    }
    const rule = adopt(target, { situation: 'flaky' }).rule!

    expect(target.candidates(thresholds)).toEqual([])
    for (let index = 1; index <= 4; index += 1) {
      record(target, {
        scopeKey: alphaScope,
        situation: 'flaky',
        index: 10 + index,
        occurredAt: 2_000 + index,
        trust: 'self-reported',
        source: 'foreground',
        ruleId: rule.id,
      })
      record(target, {
        scopeKey: alphaScope,
        situation: 'flaky',
        index: 20 + index,
        occurredAt: 2_000 + index,
        ruleId: 'some-other-rule',
      })
    }
    expect(target.candidates(thresholds)).toEqual([])

    for (let index = 1; index <= 4; index += 1) {
      record(target, {
        scopeKey: alphaScope,
        situation: 'flaky',
        index: 30 + index,
        occurredAt: 3_000 + index,
        ruleId: rule.id,
      })
    }
    expect(target.candidates(thresholds)).toMatchObject([{
      kind: 'retire', ruleId: rule.id, stats: { failures: 4, total: 4 },
    }])
    target.close()
  })
})

describe('versioned rule identity', () => {
  test('retire then readopt creates a new UUID-backed id and increments generation', () => {
    const target = store()
    const first = adopt(target, { situation: 'flaky', callerRuleId: 'fixed', suffix: 'first' }).rule!
    retire(target, first.id, first.version)
    const second = adopt(target, { situation: 'flaky', callerRuleId: 'fixed', suffix: 'second' }).rule!

    expect(first.id).not.toBe('fixed')
    expect(second.id).not.toBe(first.id)
    expect(first.generation).toBe(1)
    expect(second.generation).toBe(2)
    target.close()
  })

  test('active rules are unique only within one scope', () => {
    const target = store()
    const alpha = adopt(target, { situation: 'shared', scopeKey: alphaScope, suffix: 'alpha' }).rule!
    const beta = adopt(target, { situation: 'shared', scopeKey: betaScope, suffix: 'beta' }).rule!

    expect(alpha.scopeKey).toBe(alphaScope)
    expect(beta.scopeKey).toBe(betaScope)
    expect(target.listRules(alphaScope, 'active')).toHaveLength(1)
    expect(target.listRules(betaScope, 'active')).toHaveLength(1)
    target.close()
  })
})

describe('schema v3 migration through the v2 quarantine', () => {
  test('quarantines unverifiable pending v2 proposals as durable conflicts', () => {
    const path = databasePath('v2-to-v3')
    const v2 = new DatabaseSync(path)
    v2.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE evolution_episodes (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, situation TEXT NOT NULL,
        outcome TEXT NOT NULL, detail TEXT NOT NULL, source TEXT NOT NULL, scope_key TEXT NOT NULL,
        trust TEXT NOT NULL, rule_id TEXT, claimed_rule_id TEXT, occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE evolution_rules (
        id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, situation TEXT NOT NULL, guidance TEXT NOT NULL,
        status TEXT NOT NULL, baseline_failures INTEGER NOT NULL, baseline_total INTEGER NOT NULL,
        adopted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, retired_reason TEXT,
        version INTEGER NOT NULL, generation INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE evolution_proposals (
        id TEXT PRIMARY KEY, policy_proposal_id TEXT UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL, principal TEXT NOT NULL, scope_key TEXT NOT NULL,
        mutation_hash TEXT NOT NULL, mutation_json TEXT NOT NULL, status TEXT NOT NULL,
        expires_at INTEGER NOT NULL, result_rule_id TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE evolution_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
        operation TEXT NOT NULL, rule_id TEXT NOT NULL, result_version INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_meta VALUES ('schema-version', '2');
      INSERT INTO evolution_proposals VALUES (
        'v2-pending', 'policy-v2', 'v2-key', 'agent:primary', 'owner', '${alphaScope}',
        'hash', '{}', 'pending', 9999, NULL, 100, 100, 1
      );
      PRAGMA user_version = 2;
    `)
    v2.close()

    const migrated = openEvolutionDatabase(path)
    expect(migrated.prepare(`
      SELECT status, version, creation_intent_json, settlement_expectation_json
      FROM evolution_proposals WHERE id = 'v2-pending'
    `).get()).toEqual({
      status: 'conflicted',
      version: 2,
      creation_intent_json: null,
      settlement_expectation_json: null,
    })
    expect(migrated.prepare('PRAGMA table_info(evolution_episodes)').all()
      .filter((column: unknown) => (column as { name: string }).name === 'guidance_version')).toHaveLength(1)
    migrated.close()
  })

  test('quarantines v1 rows instead of treating them as scoped trusted evidence', () => {
    const path = databasePath('migration')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE evolution_episodes (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, situation TEXT NOT NULL,
        outcome TEXT NOT NULL, detail TEXT NOT NULL, source TEXT NOT NULL, rule_id TEXT, occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE evolution_rules (
        id TEXT PRIMARY KEY, situation TEXT NOT NULL, guidance TEXT NOT NULL, status TEXT NOT NULL,
        baseline_failures INTEGER NOT NULL, baseline_total INTEGER NOT NULL, adopted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, retired_reason TEXT, version INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX evolution_rules_active_situation
        ON evolution_rules(situation) WHERE status = 'active';
      CREATE TABLE evolution_proposals (
        id TEXT PRIMARY KEY, policy_proposal_id TEXT UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL, principal TEXT NOT NULL, mutation_hash TEXT NOT NULL,
        mutation_json TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL,
        result_rule_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE evolution_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
        operation TEXT NOT NULL, rule_id TEXT NOT NULL, result_version INTEGER NOT NULL, occurred_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_meta VALUES ('schema-version', '1');
      INSERT INTO evolution_episodes VALUES ('episode-1', 'legacy-episode', 'weekly-report', 'failed', 'old', 'foreground', 'claimed-rule', 100);
      INSERT INTO evolution_rules VALUES ('legacy-rule', 'weekly-report', 'old guidance', 'active', 4, 4, 100, 100, NULL, 1);
      INSERT INTO evolution_proposals VALUES (
        'legacy-proposal', NULL, 'legacy-proposal-key', 'agent:primary', 'owner', 'hash', '{}',
        'pending', 9999, NULL, 100, 100, 1
      );
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const migrated = openEvolutionDatabase(path)
    expect(evolutionSchemaVersion).toBe(3)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    expect(migrated.prepare(`SELECT scope_key, trust, rule_id, claimed_rule_id FROM evolution_episodes`).get())
      .toEqual({ scope_key: 'legacy:v1', trust: 'legacy', rule_id: null, claimed_rule_id: 'claimed-rule' })
    expect(migrated.prepare(`SELECT scope_key, generation FROM evolution_rules`).get())
      .toEqual({ scope_key: 'legacy:v1', generation: 0 })
    expect(migrated.prepare(`SELECT status, scope_key FROM evolution_proposals`).get())
      .toEqual({ status: 'expired', scope_key: 'legacy:v1' })
    expect(migrated.prepare('PRAGMA table_info(evolution_episodes)').all()
      .some((column: unknown) => (column as { name: string }).name === 'guidance_version')).toBe(true)
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evolution_guidance_exposures'").get())
      .toEqual({ name: 'evolution_guidance_exposures' })
    migrated.close()

    const target = new EvolutionStore({ path })
    expect(target.candidates(thresholds)).toEqual([])
    expect(target.listRules(alphaScope, 'active')).toEqual([])
    target.close()
  })
})
