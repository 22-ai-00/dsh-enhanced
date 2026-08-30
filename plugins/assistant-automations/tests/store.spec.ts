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
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 })
    expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual(expect.arrayContaining([
        { name: 'automation_attempts' },
        { name: 'automation_definitions' },
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
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 })
    const rows = migrated.prepare(`
      SELECT status, attempt_count, last_error_code FROM automation_evaluation_outbox ORDER BY id
    `).all()
    expect(rows).toEqual(version === 5
      ? [{ status: 'dead-letter', attempt_count: 1, last_error_code: 'legacy-unverifiable-provenance' }]
      : [])
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
