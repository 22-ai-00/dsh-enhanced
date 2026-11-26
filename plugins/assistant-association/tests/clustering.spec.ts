import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { parseBenchmarkPlan, type BenchmarkPlan } from '@dsh-ray/assistant-evaluation/benchmark'
import type { OutcomeEnvelope } from '@dsh-ray/assistant-evaluation'
import {
  assertWp04CandidateOrigin,
  clusterEpisodes,
  computeEntityJaccard,
  computeEpisodeSimilarity,
  computeToolSequenceLcs,
  computeToolSequenceSimilarity,
  detectImplicitSignals,
  ensureClusteringSchema,
  listImplicitSignals,
  listSkillCandidates,
  reportImplicitSignalsToEvaluation,
  updateSkillCandidateStatus,
  Wp04OriginError,
  type ClusteringEpisodeInput,
} from '../src/clustering.js'
import { ensureEvalPoolSchema } from '../src/eval-pool.js'
import { evaluateHoldout, resolveHoldoutSeedKey } from '../src/holdout.js'
import { openAssociationDatabase } from '../src/sqlite.js'
import { computeOwnerScopeKey, computePrincipalDigest } from '../src/types.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'assoc-clustering-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function makeScopeKey(label = 'owner-cluster'): string {
  return computeOwnerScopeKey({
    mode: 'delivery',
    principalDigest: computePrincipalDigest(label),
    principalRecordId: `pr-${label}`,
    principalVersion: 1,
    workspace: '/ws/clustering',
    agentPreset: 'primary',
  })
}

function findTasksByHoldout(
  seedKey: Buffer,
  wantHoldout: boolean,
  count: number,
  prefix = 'task',
): string[] {
  const out: string[] = []
  let idx = 0
  while (out.length < count) {
    const candidate = `${prefix}-${idx}`
    idx += 1
    if (evaluateHoldout(seedKey, candidate, 1250).inHoldout === wantHoldout) {
      out.push(candidate)
    }
  }
  return out
}

function makeBenchmarkPlan(split: 'development' | 'holdout'): BenchmarkPlan {
  const versions = Object.fromEntries(
    ['model', 'prompt', 'skills', 'tools', 'policy', 'runtime'].map((k) => [k, sha(k)]),
  )
  const features = { memory: false, planning: false, review: false, growth: false }
  return parseBenchmarkPlan({
    schemaVersion: 1,
    id: `plan-${split}`,
    dataset: {
      id: `ds-${split}`,
      version: '1',
      digest: sha(`ds-${split}`),
      split,
    },
    comparison: 'capability',
    cases: [
      {
        id: 'case-1',
        domain: 'code',
        inputDigest: sha('in-1'),
        acceptanceDigest: sha('acc-1'),
      },
    ],
    variants: [
      { id: 'baseline', role: 'baseline', versions: { ...versions }, features: { ...features } },
      { id: 'candidate', role: 'candidate', versions: { ...versions }, features: { ...features } },
    ],
    budget: {
      durationMs: 1000,
      inputTokens: 0,
      outputTokens: 0,
      costUsdMicros: 0,
      toolCalls: 1,
    },
    repeats: 2,
    seed: 1,
  })
}

describe('episode similarity metrics', () => {
  test('computes entity Jaccard, ordered tool LCS, and weighted similarity', () => {
    expect(computeEntityJaccard([], [])).toBe(0)
    expect(computeEntityJaccard(['TypeScript', 'vitest'], ['typescript', 'VITEST'])).toBe(1)
    expect(computeEntityJaccard(['alpha', 'beta'], ['beta', 'gamma'])).toBeCloseTo(1 / 3, 6)

    expect(computeToolSequenceLcs(['read', 'grep', 'edit', 'test'], ['grep', 'edit', 'lint'])).toEqual([
      'grep',
      'edit',
    ])
    expect(computeToolSequenceSimilarity(['read', 'edit'], ['edit', 'read'])).toBe(0.5)
    expect(computeToolSequenceSimilarity([], ['read'])).toBe(0)

    const sim = computeEpisodeSimilarity(
      { entities: ['pnpm', 'vitest'], toolNames: ['read', 'edit', 'test'] },
      { entities: ['pnpm', 'vitest'], toolNames: ['read', 'edit', 'test'] },
    )
    expect(sim).toBeCloseTo(1, 6)
  })
})

describe('WP04 candidate origin guard (assertWp04CandidateOrigin)', () => {
  test('rejects null holdoutSeedKey, holdout taskIds, SQLite in_holdout=1, mixed scopes, and holdout BenchmarkPlan', async () => {
    const dir = makeTempDir()
    const db = openAssociationDatabase(join(dir, 'wp04.sqlite'))
    try {
      ensureEvalPoolSchema(db)
      const seedKey = resolveHoldoutSeedKey({ databasePath: join(dir, 'wp04.sqlite') })
      const scopeA = makeScopeKey('owner-a')
      const scopeB = makeScopeKey('owner-b')
      const [nonHoldoutTask1, nonHoldoutTask2, nonHoldoutTask3] = findTasksByHoldout(
        seedKey,
        false,
        3,
        'nh',
      )
      const [holdoutTask] = findTasksByHoldout(seedKey, true, 1, 'ho')

      // (a) null holdoutSeedKey
      await expect(
        assertWp04CandidateOrigin({
          db,
          holdoutSeedKey: null,
          episodes: [{ taskId: nonHoldoutTask1!, ownerScopeKey: scopeA }],
        }),
      ).rejects.toThrow(Wp04OriginError)

      // (b.1) HMAC evaluates inHoldout === true
      await expect(
        assertWp04CandidateOrigin({
          db,
          holdoutSeedKey: seedKey,
          episodes: [
            { taskId: nonHoldoutTask1!, ownerScopeKey: scopeA },
            { taskId: holdoutTask!, ownerScopeKey: scopeA },
          ],
        }),
      ).rejects.toThrow(/sealed holdout/u)

      // (b.2) SQLite in_holdout = 1 in assoc_holdout_assignments
      db.prepare(`
        INSERT INTO assoc_holdout_assignments (
          task_id, owner_scope_key, task_kind, session_id, turn_number,
          in_holdout, bucket_bps, rate_bps, hmac_digest, assigned_at
        ) VALUES (?, ?, 'foreground-turn', 's1', 1, 1, 100, 1250, ?, 1000)
      `).run(nonHoldoutTask2!, scopeA, sha('hmac-1'))

      await expect(
        assertWp04CandidateOrigin({
          db,
          holdoutSeedKey: seedKey,
          episodes: [{ taskId: nonHoldoutTask2!, ownerScopeKey: scopeA }],
        }),
      ).rejects.toThrow(/in_holdout = 1/u)

      // (b.3) SQLite in_holdout = 1 in assoc_eval_pool
      db.prepare(`
        INSERT INTO assoc_eval_pool (
          task_id, owner_scope_key, subject_kind, subject_ref, pool_kind, in_holdout,
          objective_status, contract_ref, contract_digest, receipt_ref, receipt_digest,
          projection_version, projection_digest, entities_json, tool_names_json,
          status, occurred_at, updated_at
        ) VALUES (?, ?, 'foreground-turn', 'r-pool-ho', 'holdout', 1, 'achieved', 'c-p', ?, 'rc-p', ?, 1, ?, '[]', '[]', 'active', 1000, 1000)
      `).run(nonHoldoutTask3!, scopeA, sha('cp'), sha('rcp'), sha('pp'))

      await expect(
        assertWp04CandidateOrigin({
          db,
          holdoutSeedKey: seedKey,
          episodes: [{ taskId: nonHoldoutTask3!, ownerScopeKey: scopeA }],
        }),
      ).rejects.toThrow(/in_holdout = 1/u)

      // (c) multiple ownerScopeKeys
      const [nonHoldoutOther] = findTasksByHoldout(seedKey, false, 1, 'other-scope')
      await expect(
        assertWp04CandidateOrigin({
          db,
          holdoutSeedKey: seedKey,
          episodes: [
            { taskId: nonHoldoutTask1!, ownerScopeKey: scopeA },
            { taskId: nonHoldoutOther!, ownerScopeKey: scopeB },
          ],
        }),
      ).rejects.toThrow(/single ownerScopeKey/u)

      // (d) holdout BenchmarkPlan rejected by assertCandidateGenerationInput
      await expect(
        assertWp04CandidateOrigin({
          db,
          holdoutSeedKey: seedKey,
          episodes: [{ taskId: nonHoldoutTask1!, ownerScopeKey: scopeA }],
          benchmarkPlan: makeBenchmarkPlan('holdout'),
        }),
      ).rejects.toThrow(/holdout data must never be used for candidate generation/u)

      // Valid development BenchmarkPlan passes
      await expect(
        assertWp04CandidateOrigin({
          db,
          holdoutSeedKey: seedKey,
          episodes: [{ taskId: nonHoldoutTask1!, ownerScopeKey: scopeA }],
          benchmarkPlan: makeBenchmarkPlan('development'),
        }),
      ).resolves.toBeUndefined()
    } finally {
      db.close()
    }
  })
})

describe('deterministic episode clustering & skill candidate emission', () => {
  test('clusters non-holdout episodes deterministically, excludes holdout, and emits WP04-verified pending candidates', async () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'cluster.sqlite')
    const db = openAssociationDatabase(dbPath)
    try {
      ensureEvalPoolSchema(db)
      const seedKey = resolveHoldoutSeedKey({ databasePath: dbPath })
      const scopeKey = makeScopeKey('owner-1')

      const nonHoldouts = findTasksByHoldout(seedKey, false, 5, 'ep')
      const [hmacHoldout] = findTasksByHoldout(seedKey, true, 1, 'ep-ho')
      const dbHoldoutReplay = nonHoldouts[3]!
      const noToolsTask = nonHoldouts[4]!

      // Mark dbHoldoutReplay as in_holdout = 1 in assoc_replay_episodes
      db.prepare(`
        INSERT INTO assoc_replay_episodes (
          task_id, owner_scope_key, in_holdout, cues_json, used_node_ids_json,
          corrected_node_ids_json, profile_version, occurred_at
        ) VALUES (?, ?, 1, '[]', '[]', '[]', 0, 5000)
      `).run(dbHoldoutReplay, scopeKey)

      const episodes: ClusteringEpisodeInput[] = [
        {
          id: 'n-3',
          taskId: nonHoldouts[2]!,
          ownerScopeKey: scopeKey,
          entities: ['vitest', 'typescript', 'sqlite'],
          toolNames: ['read', 'grep', 'edit', 'test'],
          createdAt: 3000,
          metadata: { extra: { goalId: 'goal-1', sessionId: 'sess-2' } },
        },
        {
          id: 'n-ho',
          taskId: hmacHoldout!,
          ownerScopeKey: scopeKey,
          entities: ['vitest', 'typescript', 'sqlite'],
          toolNames: ['read', 'grep', 'edit', 'test'],
          createdAt: 1500,
        },
        {
          id: 'n-db-ho',
          taskId: dbHoldoutReplay,
          ownerScopeKey: scopeKey,
          entities: ['vitest', 'typescript', 'sqlite'],
          toolNames: ['read', 'grep', 'edit', 'test'],
          createdAt: 2500,
        },
        {
          id: 'n-no-tools',
          taskId: noToolsTask,
          ownerScopeKey: scopeKey,
          entities: ['vitest', 'typescript', 'sqlite'],
          toolNames: [],
          createdAt: 1200,
        },
        {
          id: 'n-1',
          taskId: nonHoldouts[0]!,
          ownerScopeKey: scopeKey,
          entities: ['vitest', 'typescript', 'pnpm'],
          toolNames: ['read', 'grep', 'edit', 'test'],
          createdAt: 1000,
          metadata: { extra: { goalId: 'goal-1', sessionId: 'sess-1' } },
        },
        {
          id: 'n-2',
          taskId: nonHoldouts[1]!,
          ownerScopeKey: scopeKey,
          entities: ['vitest', 'typescript'],
          toolNames: ['read', 'grep', 'edit', 'test'],
          createdAt: 2000,
          metadata: { extra: { goalId: 'goal-1', sessionId: 'sess-1' } },
        },
      ]

      const res1 = await clusterEpisodes(db, {
        ownerScopeKey: scopeKey,
        holdoutSeedKey: seedKey,
        episodes,
        nowMs: 10_000,
      })

      expect(res1.excludedHoldoutCount).toBe(2)
      expect(res1.clusters).toHaveLength(1)
      expect(res1.candidates).toHaveLength(1)

      const candidate = res1.candidates[0]!
      expect(candidate.memberTaskIds).toEqual([nonHoldouts[0]!, nonHoldouts[1]!, nonHoldouts[2]!].sort())
      expect(candidate.memberTaskIds).not.toContain(hmacHoldout!)
      expect(candidate.memberTaskIds).not.toContain(dbHoldoutReplay)
      expect(candidate.memberTaskIds).not.toContain(noToolsTask)
      expect(candidate.toolSequence).toEqual(['read', 'grep', 'edit', 'test'])
      expect(candidate.sharedEntities).toEqual(['typescript', 'vitest'])
      expect(candidate.goalLocators).toEqual([
        { goalId: 'goal-1', sessionId: 'sess-1' },
        { goalId: 'goal-1', sessionId: 'sess-2' },
      ])
      expect(candidate.wp04Verified).toBe(true)
      expect(candidate.status).toBe('pending')
      expect(candidate.similarity).toBeGreaterThanOrEqual(0.55)

      // Deterministic across shuffled input ordering & preserves status update
      expect(updateSkillCandidateStatus(db, scopeKey, candidate.candidateId, 'staged', 11_000)).toBe(true)

      const res2 = await clusterEpisodes(db, {
        ownerScopeKey: scopeKey,
        holdoutSeedKey: seedKey,
        episodes: [...episodes].reverse(),
        nowMs: 12_000,
      })
      expect(res2.candidates[0]!.candidateId).toBe(candidate.candidateId)
      expect(res2.candidates[0]!.clusterId).toBe(candidate.clusterId)
      expect(res2.candidates[0]!.status).toBe('staged')

      const listed = listSkillCandidates(db, scopeKey, { status: 'staged' })
      expect(listed).toHaveLength(1)
      expect(listed[0]!.candidateId).toBe(candidate.candidateId)
    } finally {
      db.close()
    }
  })

  test('loads episode nodes directly from assoc_nodes and rejects holdout BenchmarkPlan before candidate writes', async () => {
    const dir = makeTempDir()
    const db = new DatabaseSync(join(dir, 'nodes.sqlite'))
    try {
      db.exec(`
        CREATE TABLE assoc_nodes (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          source_plugin TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          owner_scope_key TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          entities_json TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `)
      const seedKey = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex')
      const scopeKey = makeScopeKey('db-nodes')
      const taskIds = findTasksByHoldout(seedKey, false, 3, 'fg')

      const insert = db.prepare(`
        INSERT INTO assoc_nodes (
          id, kind, source_plugin, source_ref, owner_scope_key, status,
          title, entities_json, metadata_json, created_at, updated_at
        ) VALUES (?, 'episode', 'assistant-delivery', ?, ?, 'active', ?, ?, ?, ?, ?)
      `)
      for (let i = 0; i < 3; i += 1) {
        insert.run(
          `a:e-${i}`,
          taskIds[i]!,
          scopeKey,
          `[turn] fix lint ${i}`,
          JSON.stringify(['oxlint', 'pnpm']),
          JSON.stringify({ toolNames: ['read', 'edit', 'shell'] }),
          1000 + i * 100,
          1000 + i * 100,
        )
      }

      await expect(
        clusterEpisodes(db, {
          ownerScopeKey: scopeKey,
          holdoutSeedKey: seedKey,
          benchmarkPlan: makeBenchmarkPlan('holdout'),
        }),
      ).rejects.toThrow(/holdout data must never be used for candidate generation/u)

      expect(listSkillCandidates(db, scopeKey)).toHaveLength(0)

      const ok = await clusterEpisodes(db, {
        ownerScopeKey: scopeKey,
        holdoutSeedKey: seedKey,
        benchmarkPlan: makeBenchmarkPlan('development'),
        nowMs: 5000,
      })
      expect(ok.candidates).toHaveLength(1)
      expect(listSkillCandidates(db, scopeKey)).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})

describe('implicit low-trust signals & self-reported evaluation reporting', () => {
  test('detects re-ask, redo, and owner-correction strictly with trust=low and excludes holdout', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'signals.sqlite')
    const db = openAssociationDatabase(dbPath)
    try {
      ensureClusteringSchema(db)
      ensureEvalPoolSchema(db)
      const seedKey = resolveHoldoutSeedKey({ databasePath: dbPath })
      const scopeKey = makeScopeKey('signals')
      const nonHoldouts = findTasksByHoldout(seedKey, false, 5, 'sig')
      const [hmacHoldout] = findTasksByHoldout(seedKey, true, 1, 'sig-ho')

      // Mark nonHoldouts[2] as corrected in assoc_exposures
      db.prepare(`
        INSERT INTO assoc_exposures (
          task_id, node_id, owner_scope_key, source_plugin, exposed_at, corrected
        ) VALUES (?, 'a:m-1', ?, 'personal-memory', 2000, 1)
      `).run(nonHoldouts[2]!, scopeKey)

      // Mark nonHoldouts[3] as corrected in assoc_replay_episodes
      db.prepare(`
        INSERT INTO assoc_replay_episodes (
          task_id, owner_scope_key, in_holdout, cues_json, used_node_ids_json,
          corrected_node_ids_json, profile_version, occurred_at
        ) VALUES (?, ?, 0, '[]', '[]', '["a:m-2"]', 1, 3000)
      `).run(nonHoldouts[3]!, scopeKey)

      // Put nonHoldouts[4] in assoc_eval_pool with in_holdout = 1
      db.prepare(`
        INSERT INTO assoc_eval_pool (
          task_id, owner_scope_key, subject_kind, subject_ref, pool_kind, in_holdout,
          objective_status, contract_ref, contract_digest, receipt_ref, receipt_digest,
          projection_version, projection_digest, entities_json, tool_names_json,
          status, occurred_at, updated_at
        ) VALUES (?, ?, 'foreground-turn', 'r-ho', 'holdout', 1, 'failed', 'c1', ?, 'rc1', ?, 1, ?, '["deploy"]', '["shell"]', 'active', 1500, 1500)
      `).run(nonHoldouts[4]!, scopeKey, sha('c1'), sha('rc1'), sha('p1'))

      const episodes: ClusteringEpisodeInput[] = [
        {
          id: 'ep-1',
          taskId: nonHoldouts[0]!,
          ownerScopeKey: scopeKey,
          title: 'deploy staging service',
          entities: ['deploy', 'staging', 'docker'],
          toolNames: ['read', 'shell'],
          objectiveStatus: 'failed',
          createdAt: 1_000,
        },
        {
          id: 'ep-2',
          taskId: nonHoldouts[1]!,
          ownerScopeKey: scopeKey,
          title: 'deploy staging service',
          entities: ['deploy', 'staging', 'docker'],
          toolNames: ['read', 'shell'],
          objectiveStatus: 'achieved',
          createdAt: 61_000, // 60s later -> within 1h re-ask window + follows failed -> redo
        },
        {
          id: 'ep-3',
          taskId: nonHoldouts[2]!,
          ownerScopeKey: scopeKey,
          title: 'deploy staging service',
          entities: ['deploy', 'staging', 'docker'],
          toolNames: ['read', 'shell'],
          createdAt: 120_000, // assoc_exposures.corrected = 1 -> owner-correction
        },
        {
          id: 'ep-ho-hmac',
          taskId: hmacHoldout!,
          ownerScopeKey: scopeKey,
          title: 'deploy staging service',
          entities: ['deploy', 'staging', 'docker'],
          toolNames: ['read', 'shell'],
          objectiveStatus: 'blocked',
          corrected: true,
          createdAt: 500,
        },
        {
          id: 'ep-ho-pool',
          taskId: nonHoldouts[4]!,
          ownerScopeKey: scopeKey,
          title: 'deploy staging service',
          entities: ['deploy', 'staging', 'docker'],
          toolNames: ['read', 'shell'],
          objectiveStatus: 'abandoned',
          corrected: true,
          createdAt: 1_500,
        },
        {
          id: 'ep-4',
          taskId: nonHoldouts[3]!,
          ownerScopeKey: scopeKey,
          title: 'unrelated billing query',
          entities: ['invoice', 'billing'],
          toolNames: [],
          createdAt: 300_000, // standalone replay corrected_node_ids_json
        },
      ]

      const result = detectImplicitSignals(db, {
        ownerScopeKey: scopeKey,
        holdoutSeedKey: seedKey,
        episodes,
        nowMs: 500_000,
      })

      expect(result.excludedHoldoutCount).toBe(2)

      const stored = listImplicitSignals(db, scopeKey)
      const kinds = stored.map((s) => s.kind).sort()
      expect(kinds).toEqual(['owner-correction', 'owner-correction', 're-ask', 'redo'])

      for (const sig of stored) {
        expect(sig.trust).toBe('low')
        expect(sig.candidateOnly).toBe(true)
        expect(sig.reportOnly).toBe(true)
        const taskIds = sig.evidence.taskIds as string[]
        expect(taskIds).not.toContain(hmacHoldout!)
        expect(taskIds).not.toContain(nonHoldouts[4]!)
      }

      // SQLite CHECK constraints reject trusted / non-candidate / non-report rows
      expect(() =>
        db.prepare(`
          INSERT INTO assoc_implicit_signals (
            signal_id, owner_scope_key, cluster_id, kind, trust, candidate_only, report_only, evidence_json, created_at
          ) VALUES ('bad-1', ?, 'c1', 're-ask', 'trusted', 1, 1, '{}', 100)
        `).run(scopeKey),
      ).toThrow()

      // Reporting to Evaluation uses strictly trust: 'self-reported'
      const appended: OutcomeEnvelope[] = []
      const evalPeer = {
        append: vi.fn((env: OutcomeEnvelope) => {
          appended.push(env)
          return env
        }),
      }
      const rep = reportImplicitSignalsToEvaluation(evalPeer, stored, {
        workspace: '/ws/clustering',
        preset: 'primary',
      })
      expect(rep.reported).toBe(stored.length)
      expect(rep.skipped).toBe(0)
      for (const env of appended) {
        expect(env.trust).toBe('self-reported')
        expect(env.trust).not.toBe('trusted')
      }
    } finally {
      db.close()
    }
  })
})
