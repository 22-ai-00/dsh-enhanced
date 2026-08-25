import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, test } from 'vitest'
import { PolicyLedger, PolicyLedgerError } from '../src/ledger.ts'

const temporaryRoots: string[] = []

async function temporaryDatabase() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-ledger-'))
  temporaryRoots.push(root)
  return join(root, 'policy.sqlite')
}

type MigrationWorkerResult =
  | { ok: true }
  | { ok: false; error: { name?: string; code?: string; message?: string } }

function migrationWorker(path: string, phase: SharedArrayBuffer): {
  ready: Promise<void>
  result: Promise<MigrationWorkerResult>
} {
  const loader = fileURLToPath(new URL('./fixtures/ts-source-loader.mjs', import.meta.url))
  const worker = new Worker(new URL('./fixtures/policy-migration-worker.mjs', import.meta.url), {
    workerData: { path, phase },
    execArgv: ['--no-warnings', '--experimental-transform-types', '--loader', loader],
  })
  const ready = new Promise<void>((resolve, reject) => {
    worker.once('error', reject)
    worker.on('message', (message: { type?: string }) => { if (message.type === 'ready') resolve() })
  })
  const result = new Promise<MigrationWorkerResult>((resolve, reject) => {
    worker.once('error', reject)
    worker.on('message', (message: { type?: string } & MigrationWorkerResult) => {
      if (message.type === 'result') resolve(message)
    })
    worker.on('exit', code => {
      if (code !== 0) reject(new Error(`policy migration worker exited with code ${code}`))
    })
  })
  return { ready, result }
}

async function concurrentlyMigrate(path: string): Promise<MigrationWorkerResult[]> {
  // Keep a writer open so every worker reaches the migration lock from the same
  // on-disk version. This deterministically exercises lock-wait revalidation.
  const migrationLock = new DatabaseSync(path)
  migrationLock.exec('BEGIN IMMEDIATE')
  const phase = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
  const first = migrationWorker(path, phase)
  const second = migrationWorker(path, phase)
  await Promise.all([first.ready, second.ready])
  expect(Atomics.load(new Int32Array(phase), 0)).toBe(2)
  Atomics.store(new Int32Array(phase), 1, 1)
  Atomics.notify(new Int32Array(phase), 1, 2)
  await new Promise(resolve => setTimeout(resolve, 100))
  migrationLock.exec('COMMIT')
  migrationLock.close()
  return Promise.all([first.result, second.result])
}

function seedLegacyVersion(path: string, version: 1 | 2 | 3): void {
  new PolicyLedger({ path }).close()
  const database = new DatabaseSync(path)
  database.exec('PRAGMA foreign_keys = OFF')
  if (version <= 3) database.exec('DROP TABLE approval_idempotency_tombstones')
  if (version === 2) {
    database.exec('ALTER TABLE approval_dispatches DROP COLUMN proposal_version')
  }
  if (version === 1) {
    database.exec(`
      DROP TABLE approval_dispatches;
      ALTER TABLE approval_proposals DROP COLUMN diff_text;
    `)
  }
  database.prepare(`UPDATE schema_meta SET value = ? WHERE key = 'schema-version'`).run(String(version))
  database.exec(`PRAGMA user_version = ${version}`)
  database.close()
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('policy ledger', () => {
  test('creates a forward-versioned schema that survives reopening', async () => {
    const path = await temporaryDatabase()
    new PolicyLedger({ path }).close()

    const database = new DatabaseSync(path)
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number }
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as { name: string }[]
    database.close()

    expect(version.user_version).toBe(5)
    expect(tables.map(table => table.name)).toEqual([
      'approval_dispatches',
      'approval_idempotency_tombstones',
      'approval_proposals',
      'audit_events',
      'budget_periods',
      'budget_reservations',
      'emergency_state',
      'schema_meta',
    ])
  })

  test('migrates v1 proposals without inventing raw diffs or approval routes', async () => {
    const path = await temporaryDatabase()
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE approval_proposals (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL,
        principal TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        decision_reason TEXT,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      INSERT INTO schema_meta(key, value) VALUES ('schema-version', '1');
      PRAGMA user_version = 1;
    `)
    const legacyDiff = '+ legacy'
    legacy.prepare(`
      INSERT INTO approval_proposals(
        id, idempotency_key, requester, principal, action, resource_kind,
        resource_id, diff_hash, summary, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      'legacy-proposal',
      'legacy-key',
      'agent:primary',
      'owner:lark:123',
      'memory.add',
      'memory',
      'fact:legacy',
      createHash('sha256').update(legacyDiff).digest('hex'),
      'Legacy proposal',
      1_000,
      2_000,
    )
    legacy.close()

    const migratedLedger = new PolicyLedger({ path, now: () => 1_500 })
    const legacyReplay = {
      idempotencyKey: 'legacy-key',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'memory.add',
      resource: { kind: 'memory', id: 'fact:legacy' },
      diff: legacyDiff,
      summary: 'Legacy proposal',
      ttlMs: 1_000,
    }
    expect(migratedLedger.propose(legacyReplay)).toMatchObject({
      proposalId: 'legacy-proposal',
      replayed: true,
    })
    expect(() => migratedLedger.propose({
      ...legacyReplay,
      dispatch: {
        sourceId: 'lark-primary',
        bindingId: 'binding-owner',
        workspace: '/work/alpha',
        principal: 'owner:lark:123',
      },
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    migratedLedger.close()

    const migrated = new DatabaseSync(path)
    const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number }
    const proposal = migrated.prepare(
      'SELECT diff_text FROM approval_proposals WHERE id = ?',
    ).get('legacy-proposal') as { diff_text: string | null }
    const dispatches = migrated.prepare('SELECT COUNT(*) AS count FROM approval_dispatches')
      .get() as { count: number }
    migrated.close()

    expect(version.user_version).toBe(5)
    expect(proposal.diff_text).toBeNull()
    expect(dispatches.count).toBe(0)
  })

  test('migrates existing v2 dispatches with an immutable proposal version', async () => {
    const path = await temporaryDatabase()
    const v2 = new DatabaseSync(path)
    v2.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE approval_proposals (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL,
        principal TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        diff_text TEXT,
        summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        decision_reason TEXT,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE approval_dispatches (
        proposal_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        principal TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued')),
        payload_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        enqueued_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (proposal_id) REFERENCES approval_proposals(id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO schema_meta(key, value) VALUES ('schema-version', '2');
      PRAGMA user_version = 2;
    `)
    const diff = '+ migrated route'
    const diffHash = createHash('sha256').update(diff).digest('hex')
    const canonicalPayload = [
      'v2-proposal', 'lark-primary', 'binding-owner', '/work/alpha', 'owner:lark:123',
      'agent:primary', 'memory.add', 'memory', 'fact:v2', 'Migrate v2 route', diff,
      diffHash, 5_000, 1,
    ]
    const payloadHash = createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex')
    v2.prepare(`
      INSERT INTO approval_proposals(
        id, idempotency_key, requester, principal, action, resource_kind, resource_id,
        diff_hash, diff_text, summary, status, created_at, expires_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)
    `).run(
      'v2-proposal', 'v2-key', 'agent:primary', 'owner:lark:123', 'memory.add',
      'memory', 'fact:v2', diffHash, diff, 'Migrate v2 route', 1_000, 5_000,
    )
    v2.prepare(`
      INSERT INTO approval_dispatches(
        proposal_id, source_id, binding_id, workspace, principal, state,
        payload_hash, created_at, version
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 1)
    `).run(
      'v2-proposal', 'lark-primary', 'binding-owner', '/work/alpha',
      'owner:lark:123', payloadHash, 1_000,
    )
    const insertPrivacyProposal = v2.prepare(`
      INSERT INTO approval_proposals(
        id, idempotency_key, requester, principal, action, resource_kind, resource_id,
        diff_hash, diff_text, summary, status, created_at, expires_at, version
      ) VALUES (?, ?, 'agent:primary', 'owner:lark:123', 'memory.add', 'memory', ?,
                ?, ?, ?, ?, 1000, 5000, ?)
    `)
    insertPrivacyProposal.run(
      'v2-unrouted', 'v2-unrouted-key', 'fact:unrouted', diffHash, diff,
      'Privacy proposal', 'pending', 1,
    )
    insertPrivacyProposal.run(
      'v2-enqueued', 'v2-enqueued-key', 'fact:enqueued', diffHash, diff,
      'Privacy proposal', 'pending', 1,
    )
    insertPrivacyProposal.run(
      'v2-terminal', 'v2-terminal-key', 'fact:terminal', diffHash, diff,
      'Privacy proposal', 'approved', 2,
    )
    v2.prepare(`
      INSERT INTO approval_dispatches(
        proposal_id, source_id, binding_id, workspace, principal, state,
        payload_hash, created_at, enqueued_at, version
      ) VALUES (?, 'lark-primary', 'binding-owner', '/work/alpha', 'owner:lark:123',
                'enqueued', ?, 1000, 1200, 2)
    `).run('v2-enqueued', 'f'.repeat(64))
    v2.close()

    const migrated = new PolicyLedger({ path, now: () => 1_500 })
    expect(migrated.listPendingApprovalDispatches()).toEqual([
      expect.objectContaining({
        proposalId: 'v2-proposal',
        proposalVersion: 1,
        payloadHash,
        diff,
      }),
    ])
    migrated.close()

    const inspected = new DatabaseSync(path)
    const schema = inspected.prepare('PRAGMA user_version').get() as { user_version: number }
    const dispatch = inspected.prepare(`
      SELECT proposal_version FROM approval_dispatches WHERE proposal_id = 'v2-proposal'
    `).get() as { proposal_version: number }
    const privacyRows = inspected.prepare(`
      SELECT id, diff_text FROM approval_proposals
      WHERE id IN ('v2-proposal', 'v2-unrouted', 'v2-enqueued', 'v2-terminal')
      ORDER BY id
    `).all() as Array<{ id: string; diff_text: string | null }>
    inspected.close()
    expect(schema.user_version).toBe(5)
    expect(dispatch.proposal_version).toBe(1)
    expect(privacyRows).toEqual([
      { id: 'v2-enqueued', diff_text: null },
      { id: 'v2-proposal', diff_text: diff },
      { id: 'v2-terminal', diff_text: null },
      { id: 'v2-unrouted', diff_text: null },
    ])
  })

  test.each([0, 1, 2, 3] as const)(
    'serializes two process openers while migrating schema v%s',
    async version => {
      const path = await temporaryDatabase()
      if (version !== 0) seedLegacyVersion(path, version)

      expect(await concurrentlyMigrate(path))
        .toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })])
      const migrated = new DatabaseSync(path)
      const schema = migrated.prepare('PRAGMA user_version').get() as { user_version: number }
      const journal = migrated.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      migrated.close()
      expect(schema.user_version).toBe(5)
      expect(journal.journal_mode).toBe('wal')
    },
  )

  test('creates private storage directories and database files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-permissions-'))
    temporaryRoots.push(root)
    const directory = join(root, 'private-policy')
    const path = join(directory, 'policy.sqlite')

    new PolicyLedger({ path }).close()

    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('migrates v4 tombstones as legacy-unbound and never attributes a recovery to them', async () => {
    const path = await temporaryDatabase()
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE approval_proposals (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL,
        principal TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        diff_text TEXT,
        summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        decision_reason TEXT,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE approval_idempotency_tombstones (
        idempotency_key TEXT PRIMARY KEY,
        not_after INTEGER NOT NULL,
        abandoned_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_meta(key, value) VALUES ('schema-version', '4');
      INSERT INTO approval_idempotency_tombstones(idempotency_key, not_after, abandoned_at)
      VALUES ('legacy-abandoned', 2000, 2000);
      PRAGMA user_version = 4;
    `)
    legacy.exec('PRAGMA journal_mode = WAL')
    legacy.close()

    expect(await concurrentlyMigrate(path))
      .toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })])

    const ledger = new PolicyLedger({ path, now: () => 3_000 })
    const recovery = {
      idempotencyKey: 'legacy-abandoned',
      requester: 'agent:wiki',
      principal: 'owner:lark:123',
      action: 'wiki.upsert',
      resource: { kind: 'wiki', id: 'page:legacy' },
      diff: '+ sensitive legacy content',
      summary: 'Write legacy page',
      notAfter: 2_000,
    }
    expect(() => ledger.recoverOrCreateProposal(recovery))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    expect(() => ledger.recoverOrCreateProposal({ ...recovery, requester: 'agent:attacker' }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    expect(() => ledger.propose({ ...recovery, ttlMs: 1_000 }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    ledger.close()

    const migrated = new DatabaseSync(path)
    const schema = migrated.prepare('PRAGMA user_version').get() as { user_version: number }
    const tombstone = migrated.prepare(`
      SELECT intent_hash FROM approval_idempotency_tombstones WHERE idempotency_key = 'legacy-abandoned'
    `).get() as { intent_hash: string }
    const intentColumn = (migrated.prepare(`
      PRAGMA table_info(approval_idempotency_tombstones)
    `).all() as Array<{ name: string; dflt_value: string | null }>)
      .find(column => column.name === 'intent_hash')
    migrated.close()
    expect(schema.user_version).toBe(5)
    expect(tombstone.intent_hash).toBe('legacy-v4-unbound')
    expect(intentColumn?.dflt_value).toBeNull()
  })

  test('atomically prevents two connections from overspending one budget', async () => {
    const path = await temporaryDatabase()
    const first = new PolicyLedger({ path, now: () => 10_000 })
    const second = new PolicyLedger({ path, now: () => 10_000 })

    first.reserve({
      scope: 'agent:primary',
      metric: 'model-cents',
      limit: 10,
      amount: 6,
      periodMs: 60_000,
      idempotencyKey: 'turn-1',
    })

    expect(() => second.reserve({
      scope: 'agent:primary',
      metric: 'model-cents',
      limit: 10,
      amount: 5,
      periodMs: 60_000,
      idempotencyKey: 'turn-2',
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'budget-exhausted' }))

    const accepted = second.reserve({
      scope: 'agent:primary',
      metric: 'model-cents',
      limit: 10,
      amount: 4,
      periodMs: 60_000,
      idempotencyKey: 'turn-3',
    })
    expect(accepted.remaining).toBe(0)
    first.close()
    second.close()
  })

  test('returns the original reservation for an idempotent replay', async () => {
    const ledger = new PolicyLedger({ path: await temporaryDatabase(), now: () => 20_000 })
    const input = {
      scope: 'workspace:/alpha',
      metric: 'background-turns',
      limit: 3,
      amount: 1,
      periodMs: 60_000,
      idempotencyKey: 'occurrence-1',
    }

    const first = ledger.reserve(input)
    const replay = ledger.reserve(input)

    expect(first.status).toBe('reserved')
    expect(replay).toEqual({ ...first, replayed: true })
    expect(replay.remaining).toBe(2)
    ledger.close()
  })

  test('finalizes or releases a reservation exactly once', async () => {
    const ledger = new PolicyLedger({ path: await temporaryDatabase(), now: () => 30_000 })
    const first = ledger.reserve({
      scope: 'agent:primary',
      metric: 'tool-calls',
      limit: 10,
      amount: 4,
      periodMs: 60_000,
      idempotencyKey: 'call-1',
    })
    const second = ledger.reserve({
      scope: 'agent:primary',
      metric: 'tool-calls',
      limit: 10,
      amount: 3,
      periodMs: 60_000,
      idempotencyKey: 'call-2',
    })

    expect(ledger.finalize(first.reservationId, 2).status).toBe('finalized')
    expect(ledger.finalize(first.reservationId, 2).replayed).toBe(true)
    expect(ledger.release(second.reservationId).status).toBe('released')
    expect(ledger.release(second.reservationId).replayed).toBe(true)

    const third = ledger.reserve({
      scope: 'agent:primary',
      metric: 'tool-calls',
      limit: 10,
      amount: 8,
      periodMs: 60_000,
      idempotencyKey: 'call-3',
    })
    expect(third.remaining).toBe(0)
    ledger.close()
  })

  test('starts an independent budget period after rollover', async () => {
    const path = await temporaryDatabase()
    let now = 59_999
    const ledger = new PolicyLedger({ path, now: () => now })
    const common = {
      scope: 'agent:primary',
      metric: 'background-turns',
      limit: 1,
      amount: 1,
      periodMs: 60_000,
    }
    ledger.reserve({ ...common, idempotencyKey: 'before-rollover' })
    now = 60_000

    const next = ledger.reserve({ ...common, idempotencyKey: 'after-rollover' })

    expect(next.periodStart).toBe(60_000)
    expect(next.remaining).toBe(0)
    ledger.close()
  })

  test('replays the same reservation after rollover instead of charging a new period', async () => {
    const path = await temporaryDatabase()
    let now = 59_999
    const ledger = new PolicyLedger({ path, now: () => now })
    const input = {
      scope: 'agent:primary',
      metric: 'background-turns',
      limit: 1,
      amount: 1,
      periodMs: 60_000,
      idempotencyKey: 'durable-operation',
    }
    const created = ledger.reserve(input)
    ledger.finalize(created.reservationId, 1)
    now = 60_001

    expect(ledger.reserve(input)).toMatchObject({
      reservationId: created.reservationId,
      status: 'finalized',
      periodStart: 0,
      replayed: true,
    })
    ledger.close()
  })

  test('persists emergency stop state and requires an actor and reason', async () => {
    const path = await temporaryDatabase()
    const first = new PolicyLedger({ path, now: () => 40_000 })

    expect(first.getEmergencyStop()).toEqual({
      enabled: false,
      reason: undefined,
      actor: undefined,
      updatedAt: undefined,
      version: 0,
    })
    expect(() => first.setEmergencyStop({ enabled: true, actor: '', reason: 'incident' }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }))
    first.setEmergencyStop({ enabled: true, actor: 'owner:lark:123', reason: 'incident' })
    first.close()

    const reopened = new PolicyLedger({ path, now: () => 50_000 })
    expect(reopened.getEmergencyStop()).toEqual({
      enabled: true,
      reason: 'incident',
      actor: 'owner:lark:123',
      updatedAt: 40_000,
      version: 1,
    })
    reopened.close()
  })

  test('rejects incompatible future schemas instead of mutating them', async () => {
    const path = await temporaryDatabase()
    const database = new DatabaseSync(path)
    database.exec('PRAGMA user_version = 99')
    database.close()

    expect(() => new PolicyLedger({ path }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'schema-too-new' }))
  })
})
