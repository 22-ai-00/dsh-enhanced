import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import ts from 'typescript'
import { afterEach, describe, expect, test } from 'vitest'
import { EvolutionStore } from '../src/store.ts'

const roots: string[] = []
const scopeKey = JSON.stringify(['/work/alpha', 'primary'])

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `assistant-evolution-${name}-`))
  roots.push(root)
  return root
}

/** Bundle only the dependency-free store modules for real worker isolation. */
function workerModule(root: string): string {
  const output = join(root, 'worker-module')
  const source = fileURLToPath(new URL('../src/', import.meta.url))
  mkdirSync(output)
  for (const name of ['types', 'sqlite', 'review', 'store']) {
    const compiled = ts.transpileModule(readFileSync(join(source, `${name}.ts`), 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
      },
      fileName: `${name}.ts`,
    }).outputText
    writeFileSync(join(output, `${name}.js`), compiled)
  }
  writeFileSync(join(output, 'package.json'), JSON.stringify({ type: 'module' }))
  return pathToFileURL(join(output, 'store.js')).href
}

interface WorkerResult {
  ok?: true
  episodeId?: string
  episode?: Record<string, unknown>
  settled?: {
    proposal: { proposalId: string; status: string; resultRuleId?: string }
    replayed: boolean
    rule?: { id: string }
  }
  rollback?: {
    rollback: { ruleId: string; resultVersion: number; evidence: { digest: string } }
    replayed: boolean
    rule: { id: string; status: string; version: number }
  }
  error?: { name: string; code?: string; message: string }
}

function runWorker(moduleUrl: string, data: Record<string, unknown>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      void (async () => {
        try {
          const { EvolutionStore } = await import(workerData.moduleUrl)
          if (workerData.barrierBeforeOpen !== undefined) {
            const barrier = new Int32Array(workerData.barrierBeforeOpen)
            Atomics.add(barrier, 0, 1)
            Atomics.notify(barrier, 0)
            Atomics.wait(barrier, 1, 0)
          }
          const store = new EvolutionStore({ path: workerData.path, now: () => 5_000 })
          if (workerData.barrier !== undefined) {
            const barrier = new Int32Array(workerData.barrier)
            Atomics.add(barrier, 0, 1)
            Atomics.notify(barrier, 0)
            Atomics.wait(barrier, 1, 0)
          }
          let result
          if (workerData.action === 'record') {
            const episode = store.recordEpisode(workerData.input)
            result = { ok: true, episodeId: episode.id, episode }
          } else if (workerData.action === 'project') {
            const projection = store.applyTaskLearningProjection(workerData.input)
            result = {
              ok: true,
              episodeId: projection.episode?.id,
              episode: projection.episode,
            }
          } else if (workerData.action === 'settle') {
            result = { ok: true, settled: store.settleProposal(workerData.input) }
          } else if (workerData.action === 'rollback') {
            result = { ok: true, rollback: store.rollbackRule(workerData.input) }
          } else {
            result = { ok: true }
          }
          store.close()
          parentPort.postMessage(result)
        } catch (error) {
          parentPort.postMessage({ error: {
            name: error?.name ?? 'Error', code: error?.code, message: String(error?.message ?? error),
          } })
        }
      })()
    `, { eval: true, workerData: { moduleUrl, ...data } })
    worker.once('message', value => resolve(value as WorkerResult))
    worker.once('error', reject)
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`evolution race worker exited ${code}`))
    })
  })
}

async function releaseWhenReady(barrier: SharedArrayBuffer, expected: number): Promise<void> {
  const view = new Int32Array(barrier)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll)
      reject(new Error(`only ${Atomics.load(view, 0)}/${expected} race workers became ready`))
    }, 10_000)
    const poll = setInterval(() => {
      if (Atomics.load(view, 0) !== expected) return
      clearTimeout(timeout)
      clearInterval(poll)
      resolve()
    }, 2)
  })
  Atomics.store(view, 1, 1)
  Atomics.notify(view, 1, expected)
}

function seedAdoptProposal(path: string): { proposalId: string } {
  const store = new EvolutionStore({ path, now: () => 1_000 })
  const proposal = store.createProposal({
    idempotencyKey: 'concurrent-adopt',
    requester: 'agent:primary',
    principal: 'owner:lark:123',
    mutation: {
      op: 'adopt',
      input: { scopeKey, situation: 'weekly-report', guidance: 'Draft early.' },
      baseline: { scopeKey, situation: 'weekly-report', failures: 4, total: 4 },
    },
    expiresAt: 60_000,
  })
  store.attachPolicy(proposal.proposalId, 'policy-concurrent-adopt')
  store.close()
  return { proposalId: proposal.proposalId }
}

function seedRollbackRule(path: string) {
  const store = new EvolutionStore({ path, now: () => 1_000 })
  const proposal = store.createProposal({
    idempotencyKey: 'concurrent-rollback-adopt',
    requester: 'agent:primary',
    principal: 'owner:lark:123',
    mutation: {
      op: 'adopt',
      input: { scopeKey, situation: 'automation:concurrent-rollback', guidance: 'Try this approach.' },
      baseline: { scopeKey, situation: 'automation:concurrent-rollback', failures: 4, total: 4 },
    },
    expiresAt: 60_000,
  })
  store.attachPolicy(proposal.proposalId, 'policy-concurrent-rollback-adopt')
  const rule = store.settleProposal({
    proposalId: proposal.proposalId,
    policyStatus: 'approved',
    policyVersion: 2,
  }).rule!
  for (let index = 1; index <= 4; index += 1) {
    const subjectRef = JSON.stringify(['evaluation-outcome', 'concurrent-rollback', index])
    const digest = createHash('sha256').update(JSON.stringify({
      scopeKey,
      subjectRef,
      situation: rule.situation,
      outcome: 'failed',
      ruleId: rule.id,
      guidanceVersion: rule.generation,
    })).digest('hex')
    store.applyTaskLearningProjection({
      scopeKey,
      scopeWatermark: index,
      subjectKind: 'outcome',
      subjectRef,
      version: 1,
      digest,
      disposition: 'upsert',
      situation: rule.situation,
      outcome: 'failed',
      detail: `failure ${index}`,
      evidenceRef: `evaluation:concurrent-rollback:${index}`,
      ruleId: rule.id,
      guidanceVersion: rule.generation,
      occurredAt: 2_000 + index,
    })
  }
  store.close()
  return rule
}

describe('multi-process SQLite safety', () => {
  test('32 concurrent exact self-reported episode replays all return the winning row', async () => {
    const root = temporaryRoot('episode-race')
    const moduleUrl = workerModule(root)
    const path = join(root, 'evolution.sqlite')
    const initialized = new EvolutionStore({ path })
    initialized.close()
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
    const input = {
      scopeKey,
      situation: 'weekly-report',
      outcome: 'failed',
      detail: 'same run',
      source: 'foreground' as const,
      trust: 'self-reported' as const,
      evidenceKind: 'operational' as const,
      occurredAt: 10_000,
      idempotencyKey: 'exact-run',
    }

    const pending = Array.from({ length: 32 }, () => runWorker(moduleUrl, {
      path, action: 'record', input, barrier,
    }))
    await releaseWhenReady(barrier, 32)
    const results = await Promise.all(pending)

    expect(results.map(result => result.error)).toEqual(Array.from({ length: 32 }))
    expect(new Set(results.map(result => result.episodeId)).size).toBe(1)
    expect(results.every(result => JSON.stringify(result.episode) === JSON.stringify(results[0]!.episode))).toBe(true)
  }, 30_000)

  test('32 concurrent exact versioned projections count one immutable Evaluation result', async () => {
    const root = temporaryRoot('evaluation-reference-race')
    const moduleUrl = workerModule(root)
    const path = join(root, 'evolution.sqlite')
    const initialized = new EvolutionStore({ path })
    initialized.close()
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
    const subjectRef = 'evaluation-outcome:aliased-result'
    const input = {
      scopeKey,
      scopeWatermark: 1,
      subjectKind: 'outcome' as const,
      subjectRef,
      version: 1,
      digest: createHash('sha256').update(JSON.stringify({ subjectRef, outcome: 'failed' })).digest('hex'),
      disposition: 'upsert' as const,
      situation: 'weekly-report',
      outcome: 'failed',
      detail: 'same immutable Evaluation result',
      evidenceRef: 'evaluation:aliased-result',
      occurredAt: 10_000,
    }

    const pending = Array.from({ length: 32 }, () => runWorker(moduleUrl, {
      path,
      action: 'project',
      input,
      barrier,
    }))
    await releaseWhenReady(barrier, 32)
    const results = await Promise.all(pending)

    expect(results.map(result => result.error)).toEqual(Array.from({ length: 32 }))
    expect(new Set(results.map(result => result.episodeId)).size).toBe(1)
    const inspected = new EvolutionStore({ path })
    expect(inspected.stats(scopeKey, 'weekly-report', 10)).toEqual({
      scopeKey, situation: 'weekly-report', failures: 1, total: 1,
    })
    inspected.close()
  }, 30_000)

  test('32 concurrent Evaluation outcomes for one Automation run create one episode', async () => {
    const root = temporaryRoot('automation-learning-subject-race')
    const moduleUrl = workerModule(root)
    const path = join(root, 'evolution.sqlite')
    const initialized = new EvolutionStore({ path })
    initialized.close()
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
    const subjectRef = 'automation-run:daily-report:run-42'
    const common = {
      scopeKey,
      scopeWatermark: 1,
      subjectKind: 'automation-run' as const,
      subjectRef,
      version: 1,
      digest: createHash('sha256').update(JSON.stringify({ subjectRef, outcome: 'failed' })).digest('hex'),
      disposition: 'upsert' as const,
      situation: 'automation:daily-report',
      outcome: 'failed' as const,
      detail: 'authoritative Evaluation objective: not-achieved',
      evidenceRef: 'evaluation:automation-run-42',
      occurredAt: 10_000,
    }
    const pending = Array.from({ length: 32 }, () => runWorker(moduleUrl, {
      path,
      action: 'project',
      input: common,
      barrier,
    }))
    await releaseWhenReady(barrier, 32)
    const results = await Promise.all(pending)

    expect(results.map(result => result.error)).toEqual(Array.from({ length: 32 }))
    expect(new Set(results.map(result => result.episodeId)).size).toBe(1)
    const inspected = new EvolutionStore({ path })
    expect(inspected.stats(scopeKey, common.situation, 10)).toMatchObject({ failures: 1, total: 1 })
    expect(() => inspected.applyTaskLearningProjection({
      ...common,
      scopeWatermark: 2,
      digest: createHash('sha256').update(JSON.stringify({
        subjectRef, outcome: 'succeeded',
      })).digest('hex'),
      outcome: 'succeeded',
      detail: 'authoritative Evaluation objective: achieved',
      evidenceRef: 'evaluation:automation-run-42:contradiction',
    })).toThrow(/different canonical content/iu)
    inspected.close()
  }, 30_000)

  test('24 concurrent settlements report exactly one apply and exact replays thereafter', async () => {
    const root = temporaryRoot('settlement-race')
    const moduleUrl = workerModule(root)
    const path = join(root, 'evolution.sqlite')
    const proposal = seedAdoptProposal(path)
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)

    const pending = Array.from({ length: 24 }, () => runWorker(moduleUrl, {
      path,
      action: 'settle',
      input: { proposalId: proposal.proposalId, policyStatus: 'approved', policyVersion: 2 },
      barrier,
    }))
    await releaseWhenReady(barrier, 24)
    const results = await Promise.all(pending)

    expect(results.map(result => result.error)).toEqual(Array.from({ length: 24 }))
    const settlements = results.map(result => result.settled!)
    expect(settlements.filter(result => !result.replayed)).toHaveLength(1)
    expect(new Set(settlements.map(result => result.proposal.status))).toEqual(new Set(['approved']))
    expect(settlements.every(result => result.rule !== undefined)).toBe(true)
    expect(new Set(settlements.map(result => result.rule?.id)).size).toBe(1)
    expect(settlements[0]!.rule?.id).toBeDefined()
  }, 30_000)

  test('24 concurrent exact rollbacks produce one mutation and durable replays', async () => {
    const root = temporaryRoot('rollback-race')
    const moduleUrl = workerModule(root)
    const path = join(root, 'evolution.sqlite')
    const rule = seedRollbackRule(path)
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
    const input = {
      scopeKey,
      ruleId: rule.id,
      expectedVersion: rule.version,
      window: 10,
      minSample: 4,
      retireFailureRate: 0.4,
      evidenceSampleLimit: 4,
    }

    const pending = Array.from({ length: 24 }, () => runWorker(moduleUrl, {
      path, action: 'rollback', input, barrier,
    }))
    await releaseWhenReady(barrier, 24)
    const results = await Promise.all(pending)

    expect(results.map(result => result.error)).toEqual(Array.from({ length: 24 }))
    const rollbacks = results.map(result => result.rollback!)
    expect(rollbacks.filter(result => !result.replayed)).toHaveLength(1)
    expect(new Set(rollbacks.map(result => result.rollback.evidence.digest)).size).toBe(1)
    expect(new Set(rollbacks.map(result => JSON.stringify(result.rollback))).size).toBe(1)
    expect(rollbacks.every(result => result.rule.status === 'retired'
      && result.rule.version === 2)).toBe(true)

    const database = new DatabaseSync(path)
    expect(database.prepare('SELECT COUNT(*) AS count FROM evolution_autonomous_rollbacks').get())
      .toEqual({ count: 1 })
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM evolution_audit WHERE operation = 'rollback'",
    ).get()).toEqual({ count: 1 })
    database.close()
  }, 30_000)

  test('concurrent fresh opens create the schema exactly once', async () => {
    const root = temporaryRoot('fresh-open-race')
    const moduleUrl = workerModule(root)
    const path = join(root, 'evolution.sqlite')
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)

    const pending = Array.from({ length: 16 }, () => runWorker(moduleUrl, {
      path, action: 'open', barrierBeforeOpen: barrier,
    }))
    await releaseWhenReady(barrier, 16)
    const results = await Promise.all(pending)

    expect(results.map(result => result.error)).toEqual(Array.from({ length: 16 }))
    const opened = new DatabaseSync(path)
    expect(opened.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'evolution_rules'").get())
      .toEqual({ count: 1 })
    opened.close()
  }, 30_000)

  test('concurrent v1 opens migrate once without duplicate table or column failures', async () => {
    const root = temporaryRoot('migration-race')
    const moduleUrl = workerModule(root)
    const path = join(root, 'evolution.sqlite')
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
      PRAGMA user_version = 1;
    `)
    legacy.close()
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)

    const pending = Array.from({ length: 16 }, () => runWorker(moduleUrl, {
      path, action: 'open', barrierBeforeOpen: barrier,
    }))
    await releaseWhenReady(barrier, 16)
    const results = await Promise.all(pending)

    expect(results.map(result => result.error)).toEqual(Array.from({ length: 16 }))
    const migrated = new DatabaseSync(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBeGreaterThan(1)
    for (const [table, columns] of [
      ['evolution_episodes', [
        'scope_key', 'trust', 'claimed_rule_id', 'guidance_version',
        'evidence_kind', 'evidence_ref', 'learning_eligible',
      ]],
      ['evolution_rules', ['scope_key', 'generation']],
      ['evolution_proposals', ['scope_key', 'creation_intent_json', 'settlement_expectation_json']],
    ] as const) {
      const info = migrated.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
      for (const column of columns) expect(info.filter(candidate => candidate.name === column)).toHaveLength(1)
    }
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'evolution_guidance_exposures'").get())
      .toEqual({ count: 1 })
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'evolution_autonomous_rollbacks'").get())
      .toEqual({ count: 1 })
    migrated.close()
  }, 30_000)
})
