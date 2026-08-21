import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PolicyLedger, PolicyLedgerError } from '../src/ledger.ts'

const temporaryRoots: string[] = []

async function temporaryDatabase() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-ledger-'))
  temporaryRoots.push(root)
  return join(root, 'policy.sqlite')
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

    expect(version.user_version).toBe(1)
    expect(tables.map(table => table.name)).toEqual([
      'approval_proposals',
      'audit_events',
      'budget_periods',
      'budget_reservations',
      'emergency_state',
      'schema_meta',
    ])
  })

  test('creates private storage directories and database files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-permissions-'))
    temporaryRoots.push(root)
    const directory = join(root, 'private-policy')
    const path = join(directory, 'policy.sqlite')

    new PolicyLedger({ path }).close()

    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
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
