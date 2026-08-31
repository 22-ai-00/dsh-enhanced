import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { AutomationStore, AutomationStoreError, stableOccurrenceId } from '../src/store.ts'
import { openAutomationDatabase } from '../src/sqlite.ts'

const temporaryRoots: string[] = []
const minute = 60_000

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function store(now: () => number = () => Date.parse('2026-08-21T10:07:00.000Z')) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-store-'))
  temporaryRoots.push(root)
  const path = join(root, 'state', 'automations.sqlite')
  return { root, path, store: new AutomationStore({ path, now }) }
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Daily review',
    prompt: 'Review the current project and report risks.',
    schedule: { kind: 'every', anchorAt: '2026-08-21T10:00:00.000Z', intervalMs: 15 * minute },
    workspace: '/work/alpha',
    agentPreset: 'primary',
    provider: 'mock',
    model: 'mock-model',
    allowedTools: ['wiki_search', 'wiki_read'],
    timeoutMs: 5 * minute,
    maxOutputTokens: 2_048,
    maxToolCalls: 20,
    misfire: { kind: 'latest' },
    overlap: 'skip',
    retrySafety: 'never',
    maxRetries: 0,
    principal: 'owner:lark:123',
    ...overrides,
  }
}

describe('automation SQLite store', () => {
  test('opens a hardened private forward-migrated database', async () => {
    const fixture = await store()
    expect((await stat(join(fixture.root, 'state'))).mode & 0o777).toBe(0o700)
    expect((await stat(fixture.path)).mode & 0o777).toBe(0o600)
    const database = new DatabaseSync(fixture.path, { readOnly: true })
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 })
    expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual(expect.arrayContaining([
        { name: 'automation_attempts' },
        { name: 'automation_circuit_operations' },
        { name: 'automation_definitions' },
        { name: 'automation_incidents' },
        { name: 'automation_occurrences' },
        { name: 'automation_runs' },
        { name: 'automation_system_reconciles' },
        { name: 'automation_tasks' },
        { name: 'duty_lease' },
      ]))
    database.close()
    fixture.store.close()
  })

  test('refuses relative paths and future schemas', async () => {
    expect(() => new AutomationStore({ path: 'relative.sqlite' }))
      .toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'invalid-path' }))
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-future-'))
    temporaryRoots.push(root)
    const path = join(root, 'future.sqlite')
    const database = new DatabaseSync(path)
    database.exec('PRAGMA user_version = 99')
    database.close()
    await chmod(path, 0o600)
    expect(() => new AutomationStore({ path }))
      .toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'schema-too-new' }))
  })

  test('migrates v8 incidents into generation one without trusting legacy enqueue as presentation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-v8-incidents-'))
    temporaryRoots.push(root)
    const path = join(root, 'legacy.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE automation_incidents (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, definition_hash TEXT NOT NULL,
        stage TEXT NOT NULL, state TEXT NOT NULL, failure_class TEXT NOT NULL,
        failure_phase TEXT NOT NULL, failure_code TEXT NOT NULL, side_effect_state TEXT NOT NULL,
        retryability TEXT NOT NULL, notification_route_id TEXT NOT NULL, alert_status TEXT NOT NULL,
        alert_ref TEXT, run_id TEXT, opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        resolved_at INTEGER, version INTEGER NOT NULL,
        UNIQUE (automation_id, definition_hash, stage)
      ) STRICT;
      INSERT INTO automation_incidents VALUES
        ('incident-open', 'auto-open', '${'a'.repeat(64)}', 'terminal', 'open', 'configuration',
          'host-execution', 'catalog-mismatch', 'none', 'after-intervention', 'owner-route',
          'enqueued', 'legacy-outbox-open', 'run-open', 1000, 1100, NULL, 4),
        ('incident-resolved', 'auto-resolved', '${'b'.repeat(64)}', 'terminal', 'resolved', 'configuration',
          'host-execution', 'catalog-mismatch', 'none', 'after-intervention', 'owner-route',
          'enqueued', 'legacy-outbox-resolved', 'run-resolved', 1000, 1200, 1200, 5);
      PRAGMA user_version = 8;
    `)
    legacy.close()
    await chmod(path, 0o600)

    const migrated = openAutomationDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 })
    expect(migrated.prepare(`
      SELECT id, lifecycle_generation, presentation_revision, alert_status, alert_ref
      FROM automation_incidents ORDER BY id
    `).all()).toEqual([
      { id: 'incident-open', lifecycle_generation: 1, presentation_revision: 4,
        alert_status: 'pending', alert_ref: null },
      { id: 'incident-resolved', lifecycle_generation: 1, presentation_revision: 5,
        alert_status: 'suppressed', alert_ref: null },
    ])
    migrated.close()
  })

  test.each([4, 5])('does not promote schema-v%s history without an immutable execution snapshot', async version => {
    const root = await mkdtemp(join(tmpdir(), `assistant-automations-v${version}-`))
    temporaryRoots.push(root)
    const path = join(root, 'legacy.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE automation_runs (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE automation_attempts (id TEXT PRIMARY KEY) STRICT;
      ${version === 5 ? `
      CREATE TABLE automation_evaluation_outbox (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        observation_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO automation_runs(id) VALUES ('legacy-run');
      INSERT INTO automation_evaluation_outbox VALUES (
        'legacy-evaluation', 'legacy-run', 'terminal', 'pending', '{}', 1000, 1000
      );
      ` : ''}
      PRAGMA user_version = ${version};
    `)
    legacy.close()
    await chmod(path, 0o600)

    const migrated = openAutomationDatabase(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 })
    const rows = migrated.prepare(`
      SELECT status, attempt_count, last_error_code FROM automation_evaluation_outbox ORDER BY id
    `).all()
    expect(rows).toEqual(version === 5
      ? [{ status: 'dead-letter', attempt_count: 1, last_error_code: 'legacy-unverifiable-provenance' }]
      : [])
    migrated.close()
  })

  test('migrates v6 preview effect intents to terminal suppression atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-v6-preview-'))
    temporaryRoots.push(root)
    const path = join(root, 'legacy.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE automation_occurrences (
        id TEXT PRIMARY KEY, dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1))
      ) STRICT;
      CREATE TABLE automation_runs (
        id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE, automation_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
        session_id TEXT, artifact_ref TEXT, output_preview TEXT NOT NULL, usage_json TEXT NOT NULL,
        delivery_status TEXT, delivery_ref TEXT,
        evidence_status TEXT NOT NULL CHECK (evidence_status IN ('pending', 'recorded', 'suppressed')),
        evidence_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO automation_occurrences VALUES ('occ-preview', 1), ('occ-production', 0);
      INSERT INTO automation_runs VALUES
        ('run-preview', 'occ-preview', 'auto-preview', 'task-preview', 'attempt-preview', 'succeeded',
         NULL, NULL, 'preview', '{}', 'pending', 'old-delivery', 'pending', '{"legacy":true}', 1, 1),
        ('run-production', 'occ-production', 'auto-production', 'task-production', 'attempt-production', 'succeeded',
         NULL, NULL, 'production', '{}', 'pending', NULL, 'pending', '{"legacy":true}', 2, 2);
      PRAGMA user_version = 6;
    `)
    legacy.close()
    await chmod(path, 0o600)

    const migrated = openAutomationDatabase(path)
    expect(migrated.prepare(`
      SELECT id, execution_mode, definition_hash, evidence_status, evidence_json,
        delivery_status, delivery_ref, json_extract(diagnostic_json, '$.failureClass') AS failure_class
      FROM automation_runs ORDER BY id
    `).all()).toEqual([
      {
        id: 'run-preview', execution_mode: 'preview', definition_hash: null,
        evidence_status: 'suppressed', evidence_json: null,
        delivery_status: 'suppressed', delivery_ref: null, failure_class: 'unknown',
      },
      {
        id: 'run-production', execution_mode: 'unknown', definition_hash: null,
        evidence_status: 'pending', evidence_json: '{"legacy":true}',
        delivery_status: 'pending', delivery_ref: null, failure_class: 'unknown',
      },
    ])
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 })
    migrated.close()
  })

  test('repairs the pre-half-open schema-v7 preview without clearing exact open circuits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-v7-circuit-preview-'))
    temporaryRoots.push(root)
    const path = join(root, 'legacy.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE automation_circuits (
        automation_id TEXT NOT NULL, definition_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
        failure_class TEXT NOT NULL CHECK (failure_class IN ('configuration', 'policy', 'budget')),
        failure_phase TEXT NOT NULL, failure_code TEXT NOT NULL,
        opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        PRIMARY KEY (automation_id, definition_hash)
      ) STRICT;
      CREATE INDEX automation_open_circuits ON automation_circuits(state, updated_at, automation_id);
      INSERT INTO automation_circuits VALUES (
        'legacy-open', '${'a'.repeat(64)}', 'open', 'configuration', 'preflight',
        'legacy-config', 100, 100, 7
      );
      PRAGMA user_version = 7;
    `)
    legacy.close()
    await chmod(path, 0o600)

    const migrated = openAutomationDatabase(path)
    expect(migrated.prepare(`PRAGMA table_info('automation_circuits')`).all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'probe_token' }),
        expect.objectContaining({ name: 'probe_lease_until' }),
        expect.objectContaining({ name: 'probe_task_id' }),
      ]))
    expect(migrated.prepare(`
      SELECT state, probe_token, probe_lease_until, probe_task_id, version
      FROM automation_circuits WHERE automation_id = 'legacy-open'
    `).get()).toEqual({
      state: 'open', probe_token: null, probe_lease_until: null, probe_task_id: null, version: 7,
    })
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 })
    expect(migrated.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_incidents'
    `).get()).toEqual({ name: 'automation_incidents' })
    expect(migrated.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_circuit_operations'
    `).get()).toEqual({ name: 'automation_circuit_operations' })
    migrated.close()
  })

  test('validates immutable definitions and replays creation idempotently', async () => {
    const fixture = await store()
    const created = fixture.store.createApproved({
      automationId: 'auto-review', idempotencyKey: 'create:review', definition: definition(),
    })
    const replay = fixture.store.createApproved({
      automationId: 'auto-review', idempotencyKey: 'create:review', definition: definition(),
    })
    expect(created).toMatchObject({
      id: 'auto-review', status: 'active', version: 1,
      nextRunAt: Date.parse('2026-08-21T10:15:00.000Z'), definition: definition(),
    })
    expect(replay).toEqual(created)
    expect(() => fixture.store.createApproved({
      automationId: 'auto-review', idempotencyKey: 'create:review', definition: definition({ prompt: 'changed' }),
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'idempotency-conflict' }))
    expect(() => fixture.store.createApproved({
      automationId: 'bad', idempotencyKey: 'create:bad', definition: definition({ workspace: 'relative' }),
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'invalid-definition' }))
    fixture.store.close()
  })

  test('uses version CAS for pause/resume/delete and never erases the immutable snapshot', async () => {
    const fixture = await store()
    const created = fixture.store.createApproved({
      automationId: 'auto-state', idempotencyKey: 'create:state', definition: definition(),
    })
    const paused = fixture.store.changeApproved({
      automationId: created.id, operation: 'pause', expectedVersion: 1, idempotencyKey: 'pause:state',
    })
    expect(paused).toMatchObject({ status: 'paused', version: 2, nextRunAt: undefined })
    expect(() => fixture.store.changeApproved({
      automationId: created.id, operation: 'resume', expectedVersion: 1, idempotencyKey: 'stale:state',
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'version-conflict' }))
    const resumed = fixture.store.changeApproved({
      automationId: created.id, operation: 'resume', expectedVersion: 2, idempotencyKey: 'resume:state',
    })
    const deleted = fixture.store.changeApproved({
      automationId: created.id, operation: 'delete', expectedVersion: 3, idempotencyKey: 'delete:state',
    })
    expect(resumed).toMatchObject({ status: 'active', version: 3 })
    expect(deleted).toMatchObject({ status: 'deleted', version: 4, definition: created.definition })
    expect(fixture.store.list()).toHaveLength(1)
    fixture.store.close()
  })

  test('reconciles only its exact system-owned row and replays each revision idempotently', async () => {
    const fixture = await store()
    const created = fixture.store.reconcileSystemOwned({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-primary',
      idempotencyKey: 'heartbeat-primary:v1', definition: definition({ prompt: 'Check scratch v1.' }),
    })
    const replay = fixture.store.reconcileSystemOwned({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-primary',
      idempotencyKey: 'heartbeat-primary:v1', definition: definition({ prompt: 'Check scratch v1.' }),
    })
    const updated = fixture.store.reconcileSystemOwned({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-primary',
      idempotencyKey: 'heartbeat-primary:v2', definition: definition({ prompt: 'Check scratch v2.' }),
    })
    const paused = fixture.store.reconcileSystemOwned({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-primary',
      idempotencyKey: 'heartbeat-primary:v3', desiredStatus: 'paused',
      definition: definition({ prompt: 'Check scratch v2.' }),
    })

    expect(created).toMatchObject({ id: 'heartbeat-primary', owner: 'assistant-heartbeat', version: 1 })
    expect(replay).toEqual(created)
    expect(updated).toMatchObject({ owner: 'assistant-heartbeat', version: 2,
      definition: { prompt: 'Check scratch v2.' } })
    expect(paused).toMatchObject({ owner: 'assistant-heartbeat', version: 3,
      status: 'paused', nextRunAt: undefined })
    expect(() => fixture.store.reconcileSystemOwned({
      owner: 'another-plugin', automationId: 'heartbeat-primary',
      idempotencyKey: 'takeover', definition: definition(),
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'invalid-state' }))
    expect(() => fixture.store.reconcileSystemOwned({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-primary',
      idempotencyKey: 'heartbeat-primary:v1', definition: definition({ prompt: 'changed replay' }),
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'idempotency-conflict' }))

    fixture.store.createApproved({ automationId: 'user-row', idempotencyKey: 'user-row', definition: definition() })
    expect(() => fixture.store.reconcileSystemOwned({
      owner: 'assistant-heartbeat', automationId: 'user-row',
      idempotencyKey: 'take-user-row', definition: definition(),
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'invalid-state' }))
    fixture.store.close()
  })

  test('never claims a normal paused Automation task through either claim path', async () => {
    const fixture = await store(() => 1_000)
    const created = fixture.store.createApproved({
      automationId: 'ordinary-paused-task', idempotencyKey: 'create:ordinary-paused-task', definition: definition(),
    })
    const occurrence = fixture.store.createManual({
      automationId: created.id, requestId: 'queued-before-pause', dryRun: false,
    })
    const task = fixture.store.listTasks({ automationId: created.id, limit: 10 })[0]!
    expect(task.occurrenceId).toBe(occurrence.id)
    fixture.store.changeApproved({
      automationId: created.id, operation: 'pause', expectedVersion: created.version,
      idempotencyKey: 'pause:ordinary-paused-task',
    })
    const duty = fixture.store.acquireDuty({ ownerId: 'paused-guard', now: 1_000, leaseMs: 1_000 })

    expect(fixture.store.claimNextTask({
      ownerId: duty.ownerId, fencingToken: duty.fencingToken, now: 1_001, leaseMs: 100,
    })).toBeUndefined()
    expect(fixture.store.claimTask({
      taskId: task.id, ownerId: duty.ownerId, fencingToken: duty.fencingToken, now: 1_001, leaseMs: 100,
    })).toBeUndefined()
    expect(fixture.store.listTasks({ automationId: created.id, limit: 10 })[0])
      .toMatchObject({ id: task.id, status: 'scheduled', attemptCount: 0 })
    fixture.store.close()
  })

  test('pauses one exact system-owned revision with a content-free crash-safe CAS receipt', async () => {
    const fixture = await store(() => 1_000)
    const automationId = 'recovery-retired-job'
    const owner = 'assistant-recovery'
    const secretDefinition = definition({ prompt: 'never expose this recovery prompt' })
    fixture.store.reconcileSystemOwned({
      owner,
      automationId,
      idempotencyKey: 'recovery-retired-job:v1',
      definition: secretDefinition,
    })
    const definitionHash = fixture.store.getDefinitionHash(automationId)!
    const inspectBefore = new DatabaseSync(fixture.path, { readOnly: true })
    const before = inspectBefore.prepare(`
      SELECT create_idempotency_key, definition_hash, definition_json, status, next_run_at, version
      FROM automation_definitions WHERE id = ?
    `).get(automationId)
    inspectBefore.close()

    // Two independently opened stores model competing Host controllers. Only
    // one fresh operation may consume the exact active/version CAS.
    const contender = new AutomationStore({ path: fixture.path, now: () => 1_001 })
    const input = {
      owner,
      operationId: 'recovery-config:v2:pause-retired-job',
      automationId,
      definitionHash,
      expectedVersion: 1,
    }
    const first = fixture.store.pauseSystemOwned(input)
    expect(first).toEqual({
      operationId: input.operationId,
      owner,
      automationId,
      definitionHash,
      expectedVersion: 1,
      definitionVersion: 2,
      automationStatus: 'paused',
      replayed: false,
    })
    expect(Object.isFrozen(first)).toBe(true)
    expect(() => contender.pauseSystemOwned({
      ...input,
      operationId: 'recovery-config:v2:competing-pause',
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'version-conflict' }))

    const inspectAfter = new DatabaseSync(fixture.path, { readOnly: true })
    const after = inspectAfter.prepare(`
      SELECT create_idempotency_key, definition_hash, definition_json, status, next_run_at, version
      FROM automation_definitions WHERE id = ?
    `).get(automationId) as Record<string, unknown>
    const ledger = inspectAfter.prepare(`
      SELECT system_owner, automation_id, result_json
      FROM automation_system_reconciles WHERE idempotency_key = ?
    `).get(input.operationId) as Record<string, unknown>
    inspectAfter.close()
    expect(after).toEqual({
      ...(before as Record<string, unknown>),
      status: 'paused',
      next_run_at: null,
      version: 2,
    })
    expect(ledger).toMatchObject({ system_owner: owner, automation_id: automationId })
    expect(JSON.stringify(ledger)).not.toContain('never expose this recovery prompt')

    // Simulate all processes stopping after the winning commit but before its
    // caller persists the response. A fresh store gets the durable receipt.
    fixture.store.close()
    contender.close()
    const restarted = new AutomationStore({ path: fixture.path, now: () => 1_002 })
    expect(restarted.pauseSystemOwned(input)).toEqual({ ...first, replayed: true })
    expect(() => restarted.pauseSystemOwned({ ...input, expectedVersion: 2 }))
      .toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'idempotency-conflict' }))
    expect(() => restarted.pauseSystemOwned({
      ...input,
      operationId: 'recovery-config:v2:already-paused',
      expectedVersion: 2,
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'invalid-state' }))
    expect(() => restarted.pauseSystemOwned({
      ...input,
      owner: 'another-owner',
      operationId: 'recovery-config:v2:cross-owner',
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'not-found' }))

    // A later reconcile advances the same immutable hash. A stale inventory
    // tuple cannot pause this newer active revision.
    restarted.reconcileSystemOwned({
      owner,
      automationId,
      idempotencyKey: 'recovery-retired-job:resume-v3',
      desiredStatus: 'active',
      definition: secretDefinition,
    })
    expect(restarted.get(automationId)).toMatchObject({ status: 'active', version: 3 })
    expect(() => restarted.pauseSystemOwned({
      ...input,
      operationId: 'recovery-config:v2:stale-revision',
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'version-conflict' }))
    restarted.close()
  })

  test('materializes stable occurrences with latest/skip/bounded replay and survives rollback/restart', async () => {
    let now = Date.parse('2026-08-21T10:07:00.000Z')
    const fixture = await store(() => now)
    for (const [id, misfire] of [
      ['latest', { kind: 'latest' }],
      ['skip', { kind: 'skip' }],
      ['bounded', { kind: 'bounded-replay', limit: 2 }],
    ] as const) {
      fixture.store.createApproved({
        automationId: `auto-${id}`, idempotencyKey: `create:${id}`, definition: definition({ misfire }),
      })
    }
    now = Date.parse('2026-08-21T10:46:00.000Z')

    const first = fixture.store.materializeDue({ now, misfireGraceMs: minute, maxCatchUp: 10 })
    const second = fixture.store.materializeDue({ now, misfireGraceMs: minute, maxCatchUp: 10 })

    expect(first.filter(value => value.automationId === 'auto-latest' && value.status === 'pending')
      .map(value => value.scheduledAt)).toEqual([Date.parse('2026-08-21T10:45:00.000Z')])
    expect(first.filter(value => value.automationId === 'auto-skip' && value.status === 'pending')).toEqual([])
    expect(first.filter(value => value.automationId === 'auto-bounded' && value.status === 'pending')
      .map(value => value.scheduledAt)).toEqual([
        Date.parse('2026-08-21T10:30:00.000Z'), Date.parse('2026-08-21T10:45:00.000Z'),
      ])
    expect(second).toEqual([])
    const occurrences = fixture.store.listOccurrences({ limit: 100 })
    expect(new Set(occurrences.map(value => value.id)).size).toBe(occurrences.length)
    expect(occurrences.every(value => value.id === stableOccurrenceId(value.automationId, 'scheduled', String(value.scheduledAt))))
      .toBe(true)

    now = Date.parse('2026-08-21T10:10:00.000Z')
    expect(fixture.store.materializeDue({ now, misfireGraceMs: minute, maxCatchUp: 10 })).toEqual([])
    fixture.store.close()
    const reopened = new AutomationStore({ path: fixture.path, now: () => now })
    expect(reopened.materializeDue({ now, misfireGraceMs: minute, maxCatchUp: 10 })).toEqual([])
    reopened.close()
  })

  test('deduplicates future external events independently of the time schedule', async () => {
    const fixture = await store()
    fixture.store.createApproved({
      automationId: 'auto-event', idempotencyKey: 'create:event', definition: definition(),
    })
    const first = fixture.store.ingestExternal({
      automationId: 'auto-event', externalEventId: 'webhook:42', occurredAt: 123_000,
    })
    const replay = fixture.store.ingestExternal({
      automationId: 'auto-event', externalEventId: 'webhook:42', occurredAt: 123_000,
    })
    expect(replay).toEqual(first)
    expect(first.id).toBe(stableOccurrenceId('auto-event', 'external', 'webhook:42'))
    expect(fixture.store.listTasks({ automationId: 'auto-event', limit: 10 })).toHaveLength(1)
    fixture.store.close()
  })
})
