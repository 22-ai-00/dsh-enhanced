import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
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
let projectionScopeWatermark = 0

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  projectionScopeWatermark = 0
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
  source?: 'automation' | 'evaluation' | 'foreground'
  ruleId?: string
  guidanceVersion?: number
  claimedRuleId?: string
  occurredAt?: number
  idempotencyKey?: string
}) {
  if ((input.trust ?? 'trusted') === 'trusted') {
    const subjectRef = JSON.stringify([
      'evaluation-outcome', input.scopeKey, input.situation, input.index,
    ])
    const occurredAt = input.occurredAt ?? 1_000 + input.index
    const ruleId = input.ruleId
    const digest = createHash('sha256').update(JSON.stringify({
      scopeKey: input.scopeKey,
      subjectRef,
      situation: input.situation,
      outcome: input.outcome ?? 'failed',
      ruleId: ruleId ?? null,
      occurredAt,
    })).digest('hex')
    return target.applyTaskLearningProjection({
      scopeKey: input.scopeKey,
      scopeWatermark: ++projectionScopeWatermark,
      subjectKind: 'outcome',
      subjectRef,
      version: 1,
      digest,
      disposition: 'upsert',
      situation: input.situation,
      outcome: input.outcome ?? 'failed',
      detail: `attempt ${input.index}`,
      evidenceRef: `evaluation:${input.scopeKey}:${input.situation}:${input.index}`,
      occurredAt,
      ...(ruleId === undefined ? {} : { ruleId, guidanceVersion: input.guidanceVersion ?? 1 }),
    }).episode!
  }
  return target.recordEpisode({
    scopeKey: input.scopeKey,
    situation: input.situation,
    outcome: input.outcome ?? 'failed',
    detail: `attempt ${input.index}`,
    source: input.source ?? ((input.trust ?? 'trusted') === 'trusted' ? 'evaluation' : 'foreground'),
    trust: input.trust ?? 'trusted',
    evidenceKind: (input.trust ?? 'trusted') === 'trusted' ? 'objective' : 'operational',
    ...((input.trust ?? 'trusted') === 'trusted'
      ? {
          evidenceRef: `evaluation:${input.scopeKey}:${input.situation}:${input.index}`,
          learningSubjectRef: JSON.stringify([
            'evaluation-outcome', input.scopeKey, input.situation, input.index,
          ]),
        }
      : {}),
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

describe('current schema', () => {
  test('creates and reopens a fresh version-12 database without replaying a migration', () => {
    const path = databasePath('fresh-v12-reopen')
    const created = openEvolutionDatabase(path)
    expect((created.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(evolutionSchemaVersion)
    expect(created.prepare(`SELECT value FROM schema_meta WHERE key = 'schema-version'`).get())
      .toEqual({ value: String(evolutionSchemaVersion) })
    created.close()

    const reopened = openEvolutionDatabase(path)
    expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(evolutionSchemaVersion)
    expect(reopened.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name = 'evolution_scope_learning_watermarks'
    `).get()).toEqual({ count: 1 })
    reopened.close()
  })
})

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
      scopeKey: rule.scopeKey,
      ruleId,
      situation: rule.situation,
      guidance: rule.guidance,
      generation: rule.generation,
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

describe('schema v4 migration through the v2 quarantine', () => {
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
    const insertEpisode = v2.prepare(`
      INSERT INTO evolution_episodes(
        id, idempotency_key, situation, outcome, detail, source, scope_key,
        trust, rule_id, claimed_rule_id, occurred_at)
      VALUES (?, ?, 'automation:legacy-failure', 'failed', 'execution failed',
        'automation', ?, 'trusted', NULL, NULL, ?)
    `)
    for (let index = 1; index <= 5; index += 1) {
      insertEpisode.run(`legacy-episode-${index}`, `legacy-run-${index}`, alphaScope, 100 + index)
    }
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

    const target = new EvolutionStore({ path })
    expect(target.candidates(thresholds)).toEqual([])
    const ledger = new DatabaseSync(path)
    const quarantined = ledger.prepare(`
      SELECT evidence_kind, evidence_ref, learning_eligible
      FROM evolution_episodes ORDER BY id
    `).all()
    expect(quarantined).toEqual(Array.from({ length: 5 }, () => ({
      evidence_kind: 'legacy-unknown', evidence_ref: null, learning_eligible: 0,
    })))
    ledger.close()

    // A cross-database crash may leave the Evolution row committed while the
    // Automation outbox still needs to replay. Both meanings are ineligible, so
    // v5 returns the quarantined winner instead of poisoning the outbox with an
    // idempotency conflict solely because the schema learned a new category.
    expect(target.recordEpisode({
      scopeKey: alphaScope,
      situation: 'automation:legacy-failure',
      outcome: 'failed',
      detail: 'execution failed',
      source: 'automation',
      trust: 'trusted',
      evidenceKind: 'operational',
      occurredAt: 101,
      idempotencyKey: 'legacy-run-1',
    })).toMatchObject({
      id: 'legacy-episode-1',
      evidenceKind: 'legacy-unknown',
      learningEligible: false,
    })
    target.close()
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
    expect(evolutionSchemaVersion).toBe(12)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(12)
    expect(migrated.prepare(`
      SELECT scope_key, trust, evidence_kind, evidence_ref, learning_eligible,
        rule_id, claimed_rule_id FROM evolution_episodes
    `).get()).toEqual({
      scope_key: 'legacy:v1',
      trust: 'legacy',
      evidence_kind: 'legacy-unknown',
      evidence_ref: null,
      learning_eligible: 0,
      rule_id: null,
      claimed_rule_id: 'claimed-rule',
    })
    expect(migrated.prepare(`SELECT scope_key, generation FROM evolution_rules`).get())
      .toEqual({ scope_key: 'legacy:v1', generation: 0 })
    expect(migrated.prepare(`SELECT status, scope_key FROM evolution_proposals`).get())
      .toEqual({ status: 'expired', scope_key: 'legacy:v1' })
    expect(migrated.prepare('PRAGMA table_info(evolution_episodes)').all()
      .some((column: unknown) => (column as { name: string }).name === 'guidance_version')).toBe(true)
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evolution_guidance_exposures'").get())
      .toEqual({ name: 'evolution_guidance_exposures' })
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evolution_autonomous_rollbacks'").get())
      .toEqual({ name: 'evolution_autonomous_rollbacks' })
    migrated.close()

    const target = new EvolutionStore({ path })
    expect(target.candidates(thresholds)).toEqual([])
    expect(target.listRules(alphaScope, 'active')).toEqual([])
    target.close()
  })
})

describe('schema v6 immutable Evaluation identity migration', () => {
  test('deterministically retains one quality row and quarantines duplicate v5 evidence', () => {
    const path = databasePath('v5-duplicate-quality')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE evolution_episodes (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        situation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL,
        source TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        trust TEXT NOT NULL,
        evidence_kind TEXT NOT NULL,
        evidence_ref TEXT,
        learning_eligible INTEGER NOT NULL,
        rule_id TEXT,
        guidance_version INTEGER,
        claimed_rule_id TEXT,
        occurred_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE evolution_proposals (
        id TEXT PRIMARY KEY,
        policy_proposal_id TEXT UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL,
        principal TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        mutation_hash TEXT NOT NULL,
        mutation_json TEXT NOT NULL,
        creation_intent_json TEXT,
        settlement_expectation_json TEXT,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        result_rule_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_meta VALUES ('schema-version', '5');
      INSERT INTO evolution_episodes VALUES
        ('episode-a', 'idem-a', 'weekly-report', 'failed', 'first', 'automation',
          '${alphaScope}', 'trusted', 'objective', 'evaluation:duplicate', 1,
          NULL, NULL, NULL, 100),
        ('episode-b', 'idem-b', 'weekly-report', 'succeeded', 'second', 'automation',
          '${alphaScope}', 'trusted', 'verification', 'evaluation:duplicate', 1,
          NULL, NULL, NULL, 101),
        ('episode-c', 'idem-c', 'weekly-report', 'failed', 'unique', 'automation',
          '${alphaScope}', 'trusted', 'objective', 'evaluation:unique', 1,
          NULL, NULL, NULL, 102);
      INSERT INTO evolution_proposals VALUES
        ('proposal-affected', NULL, 'proposal-idem-a', 'agent', 'owner', '${alphaScope}',
          'hash-a', '{}', NULL, NULL, 'pending', 999, NULL, 100, 100, 1),
        ('proposal-unaffected', NULL, 'proposal-idem-b', 'agent', 'owner', '${betaScope}',
          'hash-b', '{}', NULL, NULL, 'pending', 999, NULL, 100, 100, 1);
      PRAGMA user_version = 5;
    `)
    legacy.close()

    const migrated = openEvolutionDatabase(path)
    expect(evolutionSchemaVersion).toBe(12)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(12)
    expect(migrated.prepare(`
      SELECT id, evidence_kind, evidence_ref, learning_eligible
      FROM evolution_episodes ORDER BY id
    `).all()).toEqual([
      { id: 'episode-a', evidence_kind: 'legacy-unknown', evidence_ref: null, learning_eligible: 0 },
      { id: 'episode-b', evidence_kind: 'legacy-unknown', evidence_ref: null, learning_eligible: 0 },
      { id: 'episode-c', evidence_kind: 'legacy-unknown', evidence_ref: null, learning_eligible: 0 },
    ])
    expect(migrated.prepare(`
      SELECT id, status, version FROM evolution_proposals ORDER BY id
    `).all()).toEqual([
      { id: 'proposal-affected', status: 'conflicted', version: 2 },
      { id: 'proposal-unaffected', status: 'conflicted', version: 2 },
    ])
    expect(() => migrated.prepare(`
      INSERT INTO evolution_episodes(
        id, idempotency_key, situation, outcome, detail, source, scope_key,
        trust, evidence_kind, evidence_ref, learning_subject_ref, learning_eligible,
        rule_id, guidance_version, claimed_rule_id, occurred_at)
      VALUES (
        'episode-d', 'idem-d', 'weekly-report', 'failed', 'duplicate', 'automation',
        ?, 'trusted', 'objective', 'evaluation:duplicate', 'subject:duplicate',
        1, NULL, NULL, NULL, 103)
    `).run(alphaScope)).toThrow(/check/iu)
    migrated.close()
  })
})

describe('schema v7 Evaluation provenance migration', () => {
  test('rebuilds a v6 episode ledger so authoritative Evaluation provenance is representable', () => {
    const path = databasePath('v6-evaluation-source')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE evolution_episodes (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        situation TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
        detail TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('automation', 'foreground')),
        scope_key TEXT NOT NULL,
        trust TEXT NOT NULL CHECK (trust IN ('trusted', 'self-reported', 'legacy')),
        evidence_kind TEXT NOT NULL CHECK (
          evidence_kind IN ('operational', 'objective', 'verification', 'legacy-unknown')),
        evidence_ref TEXT,
        learning_eligible INTEGER NOT NULL CHECK (learning_eligible IN (0, 1)),
        rule_id TEXT,
        guidance_version INTEGER CHECK (guidance_version IS NULL OR guidance_version >= 1),
        claimed_rule_id TEXT,
        occurred_at INTEGER NOT NULL,
        CHECK (learning_eligible = 0 OR (
          trust = 'trusted'
          AND evidence_kind IN ('objective', 'verification')
          AND evidence_ref IS NOT NULL))
      ) STRICT;
      CREATE UNIQUE INDEX evolution_episodes_quality_evidence_identity
        ON evolution_episodes(scope_key, evidence_kind, evidence_ref)
        WHERE learning_eligible = 1;
      CREATE TABLE evolution_proposals (
        id TEXT PRIMARY KEY,
        policy_proposal_id TEXT UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL,
        principal TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        mutation_hash TEXT NOT NULL,
        mutation_json TEXT NOT NULL,
        creation_intent_json TEXT,
        settlement_expectation_json TEXT,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        result_rule_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_meta VALUES ('schema-version', '6');
      INSERT INTO evolution_episodes VALUES
        ('episode-v6', 'idem-v6', 'weekly-report', 'failed', 'legacy projection', 'automation',
          '${alphaScope}', 'trusted', 'objective', 'evaluation:v6', 1, NULL, NULL, NULL, 100),
        ('episode-v6-cross-kind', 'idem-v6-cross-kind', 'weekly-report', 'succeeded',
          'future kind alias', 'automation', '${alphaScope}', 'trusted', 'verification',
          'evaluation:v6', 1, NULL, NULL, NULL, 101);
      INSERT INTO evolution_proposals VALUES (
        'proposal-v6-affected', NULL, 'proposal-v6-idem', 'agent', 'owner', '${alphaScope}',
        'hash', '{}', NULL, NULL, 'pending', 999, NULL, 100, 100, 1
      );
      PRAGMA user_version = 6;
    `)
    legacy.close()

    const migrated = openEvolutionDatabase(path)
    expect(evolutionSchemaVersion).toBe(12)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(12)
    expect(migrated.prepare(`
      SELECT id, evidence_kind, evidence_ref, learning_eligible
      FROM evolution_episodes WHERE id LIKE 'episode-v6%' ORDER BY id
    `).all()).toEqual([
      { id: 'episode-v6', evidence_kind: 'legacy-unknown', evidence_ref: null, learning_eligible: 0 },
      {
        id: 'episode-v6-cross-kind', evidence_kind: 'legacy-unknown',
        evidence_ref: null, learning_eligible: 0,
      },
    ])
    expect(migrated.prepare(`
      SELECT status, version FROM evolution_proposals WHERE id = 'proposal-v6-affected'
    `).get()).toEqual({ status: 'conflicted', version: 2 })
    expect(() => migrated.prepare(`
      INSERT INTO evolution_episodes(
        id, idempotency_key, situation, outcome, detail, source, scope_key,
        trust, evidence_kind, evidence_ref, learning_subject_ref, learning_eligible,
        rule_id, guidance_version, claimed_rule_id, occurred_at)
      VALUES (
        'episode-v7', 'idem-v7', 'weekly-report', 'failed', 'authoritative projection',
        'evaluation', ?, 'trusted', 'objective', 'evaluation:v7', 'subject:v7',
        1, NULL, NULL, NULL, 101)
    `).run(alphaScope)).not.toThrow()
    expect(() => migrated.prepare(`
      INSERT INTO evolution_episodes(
        id, idempotency_key, situation, outcome, detail, source, scope_key,
        trust, evidence_kind, evidence_ref, learning_subject_ref, learning_eligible,
        rule_id, guidance_version, claimed_rule_id, occurred_at)
      VALUES (
        'episode-v7-alias', 'idem-v7-alias', 'weekly-report', 'failed', 'future kind alias',
        'evaluation', ?, 'trusted', 'verification', 'evaluation:v7', 'subject:v7-alias',
        1, NULL, NULL, NULL, 101)
    `).run(alphaScope)).toThrow(/unique/iu)
    migrated.close()
  })
})

describe('schema v8 learning-subject identity migration', () => {
  test('quarantines unverifiable v7 learning rows and conflicts their pending scope', () => {
    const path = databasePath('v7-learning-subject')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE evolution_episodes (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        situation TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
        detail TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('automation', 'evaluation', 'foreground')),
        scope_key TEXT NOT NULL,
        trust TEXT NOT NULL CHECK (trust IN ('trusted', 'self-reported', 'legacy')),
        evidence_kind TEXT NOT NULL CHECK (
          evidence_kind IN ('operational', 'objective', 'verification', 'legacy-unknown')),
        evidence_ref TEXT,
        learning_eligible INTEGER NOT NULL CHECK (learning_eligible IN (0, 1)),
        rule_id TEXT,
        guidance_version INTEGER CHECK (guidance_version IS NULL OR guidance_version >= 1),
        claimed_rule_id TEXT,
        occurred_at INTEGER NOT NULL,
        CHECK (learning_eligible = 0 OR (
          source = 'evaluation' AND trust = 'trusted'
          AND evidence_kind IN ('objective', 'verification') AND evidence_ref IS NOT NULL))
      ) STRICT;
      CREATE UNIQUE INDEX evolution_episodes_quality_evidence_identity
        ON evolution_episodes(scope_key, evidence_ref) WHERE learning_eligible = 1;
      CREATE TABLE evolution_proposals (
        id TEXT PRIMARY KEY, policy_proposal_id TEXT UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE, requester TEXT NOT NULL,
        principal TEXT NOT NULL, scope_key TEXT NOT NULL, mutation_hash TEXT NOT NULL,
        mutation_json TEXT NOT NULL, creation_intent_json TEXT,
        settlement_expectation_json TEXT, status TEXT NOT NULL,
        expires_at INTEGER NOT NULL, result_rule_id TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_meta VALUES ('schema-version', '7');
      INSERT INTO evolution_episodes VALUES
        ('v7-quality-a', 'v7-idem-a', 'automation:daily', 'failed', 'first assessment',
          'evaluation', '${alphaScope}', 'trusted', 'objective', 'evaluation:v7:a',
          1, NULL, NULL, NULL, 100),
        ('v7-quality-b', 'v7-idem-b', 'automation:daily', 'failed', 'second assessment',
          'evaluation', '${alphaScope}', 'trusted', 'objective', 'evaluation:v7:b',
          1, NULL, NULL, NULL, 100),
        ('v7-operational', 'v7-idem-operational', 'automation:daily', 'failed', 'run failed',
          'automation', '${betaScope}', 'trusted', 'operational', NULL,
          0, NULL, NULL, NULL, 101);
      INSERT INTO evolution_proposals VALUES
        ('v7-alpha-pending', NULL, 'v7-proposal-a', 'agent', 'owner', '${alphaScope}',
          'hash-a', '{}', NULL, NULL, 'pending', 999, NULL, 100, 100, 1),
        ('v7-beta-pending', NULL, 'v7-proposal-b', 'agent', 'owner', '${betaScope}',
          'hash-b', '{}', NULL, NULL, 'pending', 999, NULL, 100, 100, 1);
      PRAGMA user_version = 7;
    `)
    legacy.close()

    const migrated = openEvolutionDatabase(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(12)
    expect(migrated.prepare(`
      SELECT id, evidence_kind, evidence_ref, learning_subject_ref, learning_eligible
      FROM evolution_episodes ORDER BY id
    `).all()).toEqual([
      {
        id: 'v7-operational', evidence_kind: 'operational', evidence_ref: null,
        learning_subject_ref: null, learning_eligible: 0,
      },
      {
        id: 'v7-quality-a', evidence_kind: 'legacy-unknown', evidence_ref: null,
        learning_subject_ref: null, learning_eligible: 0,
      },
      {
        id: 'v7-quality-b', evidence_kind: 'legacy-unknown', evidence_ref: null,
        learning_subject_ref: null, learning_eligible: 0,
      },
    ])
    expect(migrated.prepare('SELECT id, status, version FROM evolution_proposals ORDER BY id').all())
      .toEqual([
        { id: 'v7-alpha-pending', status: 'conflicted', version: 2 },
        { id: 'v7-beta-pending', status: 'conflicted', version: 2 },
      ])
    const insert = migrated.prepare(`
      INSERT INTO evolution_episodes(
        id, idempotency_key, situation, outcome, detail, source, scope_key,
        trust, evidence_kind, evidence_ref, learning_subject_ref, learning_eligible,
        rule_id, guidance_version, claimed_rule_id, occurred_at)
      VALUES (?, ?, 'automation:daily', ?, ?, 'evaluation', ?, 'trusted', 'objective', ?, ?,
        1, NULL, NULL, NULL, 200)
    `)
    insert.run(
      'v8-quality-a', 'v8-idem-a', 'failed', 'same run', alphaScope,
      'evaluation:v8:a', 'automation-run:immutable-a',
    )
    expect(() => insert.run(
      'v8-quality-b', 'v8-idem-b', 'failed', 'same run', alphaScope,
      'evaluation:v8:b', 'automation-run:immutable-a',
    )).toThrow(/unique/iu)
    expect(() => insert.run(
      'v8-quality-null', 'v8-idem-null', 'failed', 'missing subject', alphaScope,
      'evaluation:v8:null', null,
    )).toThrow(/learning subject/iu)
    migrated.close()
  })
})
