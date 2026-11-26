import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CompensationExecutor,
  CompensationLedger,
  CompensationRegistry,
  RecoveryCompensationError,
  inspectRecoveryOperatorSnapshot,
  normalizeCompensationRequest,
} from '../src/index.js'
import { openRecoveryDatabase, recoverySchemaVersion } from '../src/sqlite.js'

const tempRoots: string[] = []

function makeRoot(): string {
  const value = mkdtempSync(join(tmpdir(), 'assistant-recovery-comp-ledger-'))
  chmodSync(value, 0o700)
  tempRoots.push(value)
  return value
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('CompensationLedger', () => {
  it('shares recovery.sqlite while keeping PRAGMA user_version === 5 and passing operator snapshot', async () => {
    const dir = makeRoot()
    const dbPath = join(dir, 'state', 'recovery.sqlite')
    const db = openRecoveryDatabase(dbPath)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5)
    expect(recoverySchemaVersion).toBe(5)

    const ledger = new CompensationLedger({ database: db, now: () => 10_000 })
    const request = normalizeCompensationRequest(
      {
        idempotencyKey: 'comp-key-1',
        kind: 'fs.restore',
        target: { path: '/tmp/a.txt', apiToken: 'super-secret-token' },
        forwardActionId: 'fwd-1',
      },
      'rollback-state',
      20_000,
    )
    const { record, created } = ledger.prepareCapturing(request)
    expect(created).toBe(true)
    expect(record.status).toBe('capturing')

    const sealed = ledger.sealPrepared(record.id, record.version, {
      existed: true,
      secretContent: 'sensitive-preimage-body',
    })
    expect(sealed.status).toBe('prepared')
    expect(sealed.preimageDigest).toMatch(/^[a-f0-9]{64}$/u)

    const dispatched = ledger.markDispatched(sealed.id, sealed.version)
    const settled = ledger.settle(dispatched.id, dispatched.version, {
      status: 'succeeded',
      resultCode: 'restored',
      receipt: { restoredBytes: 22 },
    })
    expect(settled.status).toBe('succeeded')

    const publicStatus = ledger.getById(settled.id)!
    expect(publicStatus.preimageDigest).toBe(settled.preimageDigest)
    expect('preimage' in publicStatus).toBe(false)
    expect(publicStatus.target).toEqual({ path: '/tmp/a.txt', apiToken: '[REDACTED]' })

    const audit = ledger.listAudit(settled.id)
    expect(audit.map(entry => entry.event)).toEqual(['capturing', 'prepared', 'dispatched', 'settled'])

    db.close()

    // Re-open with inspectRecoveryOperatorSnapshot to confirm schema v5 invariance.
    const snapshot = inspectRecoveryOperatorSnapshot(dbPath)
    expect(snapshot.schemaVersion).toBe(5)
    expect(snapshot.protocol).toBe('assistant-recovery/operator-snapshot/v1')
  })

  it('upgrades an existing v5 database without compensation tables idempotently', () => {
    const dir = makeRoot()
    const dbPath = join(dir, 'legacy-v5.sqlite')
    const raw = new DatabaseSync(dbPath)
    raw.exec(`
      CREATE TABLE recovery_runtime_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        bootstrap_status TEXT NOT NULL,
        bootstrap_failure_code TEXT,
        bootstrap_generation INTEGER NOT NULL,
        bootstrap_attestation_valid INTEGER NOT NULL,
        bootstrap_attestations_json TEXT NOT NULL,
        bootstrap_attestation_set_digest TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO recovery_runtime_state VALUES (1, 'idle', NULL, 0, 0, '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', 0);
      PRAGMA user_version = 5;
    `)
    raw.close()
    chmodSync(dbPath, 0o600)

    const opened = openRecoveryDatabase(dbPath)
    const tables = opened
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'recovery_compensation%' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map(t => t.name)).toEqual(['recovery_compensation_audit', 'recovery_compensations'])
    expect((opened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5)
    opened.close()
  })

  it('detects tampered preimage_json via timingSafeEqual and recovers incomplete rows on restart', () => {
    const dir = makeRoot()
    const dbPath = join(dir, 'private', 'recovery.sqlite')
    let now = 5_000
    const ledger = new CompensationLedger({ path: dbPath, now: () => now })

    const capReq = normalizeCompensationRequest(
      { idempotencyKey: 'k-cap', kind: 'http.undo', target: { id: 1 }, forwardActionId: 'fwd-cap' },
      'cancel',
      15_000,
    )
    const cap = ledger.prepareCapturing(capReq).record

    const prepReq = normalizeCompensationRequest(
      { idempotencyKey: 'k-prep', kind: 'http.undo', target: { id: 2 }, forwardActionId: 'fwd-prep' },
      'cancel',
      15_000,
    )
    const prep = ledger.sealPrepared(ledger.prepareCapturing(prepReq).record.id, 1, { state: 'before' })

    const dispReq = normalizeCompensationRequest(
      { idempotencyKey: 'k-disp', kind: 'http.undo', target: { id: 3 }, forwardActionId: 'fwd-disp' },
      'cancel',
      15_000,
    )
    const dispSealed = ledger.sealPrepared(ledger.prepareCapturing(dispReq).record.id, 1, { state: 'before' })
    const disp = ledger.markDispatched(dispSealed.id, dispSealed.version)
    ledger.close()

    // Restart recovery
    now = 6_000
    const reopened = new CompensationLedger({ path: dbPath, now: () => now })
    const recovered = reopened.recoverIncomplete()
    expect(recovered).toEqual({ discardedCapturing: 1, terminalizedUnknown: 2 })

    // Capturing row was deleted, freeing forwardActionId and idempotencyKey
    expect(reopened.getById(cap.id)).toBeUndefined()
    expect(reopened.listAudit(cap.id).map(a => a.event)).toEqual(['capturing', 'discarded'])

    // Prepared and dispatched rows terminalized to unknown without replay
    expect(reopened.getById(prep.id)?.status).toBe('unknown')
    expect(reopened.getById(prep.id)?.resultCode).toBe('recovery-crash-no-replay')
    expect(reopened.getById(disp.id)?.status).toBe('unknown')
    expect(reopened.listAudit(disp.id).at(-1)?.event).toBe('recovered')
    reopened.close()

    // Tamper check
    const raw = new DatabaseSync(dbPath)
    raw.prepare("UPDATE recovery_compensations SET preimage_json = '{\"tampered\":true}' WHERE id = ?").run(prep.id)
    raw.close()

    const tamperedLedger = new CompensationLedger({ path: dbPath })
    expect(() => tamperedLedger.getById(prep.id)).toThrowError(
      expect.objectContaining<Partial<RecoveryCompensationError>>({ code: 'invalid-state' }),
    )
    tamperedLedger.close()
  })

  it('detects SQLite tampering across all request/identity/receipt columns on both getById and replay', async () => {
    const baseInput = {
      idempotencyKey: 'tamper-envelope-key-1',
      kind: 'fs.restore',
      target: { path: '/safe/a.txt' },
      forwardActionId: 'fwd-tamper-1',
      scope: {
        principalId: 'owner-1',
        workspace: '/workspace/safe',
        preset: 'primary',
        principalRecordId: 'rec-1',
        principalVersion: 1,
      },
      sourcePlugin: 'dsh-ray-assistant-skills',
      runId: 'run-tamper-1',
      stepId: 'step-tamper-1',
      metadata: { note: 'clean' },
    }

    const mutations: readonly {
      readonly label: string
      readonly sql: string
      readonly params: readonly (string | number | null)[]
    }[] = [
      { label: 'target_json', sql: "UPDATE recovery_compensations SET target_json = '{\"path\":\"/etc/passwd\"}' WHERE id = ?", params: [] },
      { label: 'metadata_json', sql: "UPDATE recovery_compensations SET metadata_json = '{\"note\":\"tampered\"}' WHERE id = ?", params: [] },
      { label: 'kind', sql: "UPDATE recovery_compensations SET kind = 'http.evil' WHERE id = ?", params: [] },
      { label: 'category', sql: "UPDATE recovery_compensations SET category = 'delete' WHERE id = ?", params: [] },
      { label: 'forward_action_id', sql: "UPDATE recovery_compensations SET forward_action_id = 'fwd-other' WHERE id = ?", params: [] },
      { label: 'scope_digest', sql: `UPDATE recovery_compensations SET scope_digest = '${'0'.repeat(64)}' WHERE id = ?`, params: [] },
      { label: 'source_plugin', sql: "UPDATE recovery_compensations SET source_plugin = 'other-plugin' WHERE id = ?", params: [] },
      { label: 'run_id', sql: "UPDATE recovery_compensations SET run_id = 'run-other' WHERE id = ?", params: [] },
      { label: 'step_id', sql: "UPDATE recovery_compensations SET step_id = 'step-other' WHERE id = ?", params: [] },
      { label: 'request_digest', sql: `UPDATE recovery_compensations SET request_digest = '${'1'.repeat(64)}' WHERE id = ?`, params: [] },
      { label: 'envelope_digest', sql: `UPDATE recovery_compensations SET envelope_digest = '${'2'.repeat(64)}' WHERE id = ?`, params: [] },
      { label: 'receipt_digest without receipt_json', sql: `UPDATE recovery_compensations SET receipt_json = NULL, receipt_digest = '${'3'.repeat(64)}' WHERE id = ?`, params: [] },
    ]

    for (const mutation of mutations) {
      const dir = makeRoot()
      const dbPath = join(dir, 'recovery.sqlite')
      const ledger = new CompensationLedger({ path: dbPath, now: () => 25_000 })
      const registry = new CompensationRegistry()
      registry.register({
        kind: 'fs.restore',
        category: 'rollback-state',
        compensate: () => ({ status: 'succeeded', resultCode: 'restored', receipt: { ok: true } }),
      })
      const executor = new CompensationExecutor(registry, ledger, { now: () => 25_000 })
      const settled = await executor.executeCompensation(baseInput)
      expect(settled.status, mutation.label).toBe('succeeded')
      ledger.close()

      const raw = new DatabaseSync(dbPath)
      raw.prepare(mutation.sql).run(...mutation.params, settled.id)
      raw.close()

      const reopenedLedger = new CompensationLedger({ path: dbPath, now: () => 26_000 })
      const reopenedRegistry = new CompensationRegistry()
      reopenedRegistry.register({
        kind: 'fs.restore',
        category: 'rollback-state',
        compensate: () => ({ status: 'succeeded', resultCode: 'should-not-run' }),
      })
      const reopenedExecutor = new CompensationExecutor(reopenedRegistry, reopenedLedger, { now: () => 26_000 })

      expect(() => reopenedLedger.getById(settled.id), `${mutation.label} getById`).toThrowError(
        expect.objectContaining<Partial<RecoveryCompensationError>>({ code: 'invalid-state' }),
      )
      await expect(
        reopenedExecutor.executeCompensation(baseInput),
        `${mutation.label} replay`,
      ).rejects.toMatchObject({ code: 'invalid-state' })
      reopenedLedger.close()
    }
  })

  it('succeeds when input.preimage differs from capturePreimage while still failing closed on envelope tamper', async () => {
    const dir = makeRoot()
    const dbPath = join(dir, 'recovery.sqlite')
    const ledger = new CompensationLedger({ path: dbPath, now: () => 30_000 })
    const registry = new CompensationRegistry()
    registry.register({
      kind: 'fs.restore',
      category: 'rollback-state',
      capturePreimage: () => ({ existed: true, content: 'captured-from-disk' }),
      compensate: ({ record }) => {
        expect(record.preimage).toEqual({ existed: true, content: 'captured-from-disk' })
        return { status: 'succeeded', resultCode: 'restored' }
      },
    })
    const executor = new CompensationExecutor(registry, ledger, { now: () => 30_000 })
    const input = {
      idempotencyKey: 'preimage-override-key-1',
      kind: 'fs.restore',
      target: { path: '/safe/b.txt' },
      preimage: { existed: true, content: 'caller-initial-hint' },
      metadata: { caller: 'test' },
    }
    const first = await executor.executeCompensation(input)
    expect(first.status).toBe('succeeded')
    expect(first.replayed).toBe(false)
    expect(ledger.getById(first.id)?.preimageDigest).toBe(first.preimageDigest)

    const replayed = await executor.executeCompensation(input)
    expect(replayed.replayed).toBe(true)
    expect(replayed.id).toBe(first.id)
    ledger.close()

    const raw = new DatabaseSync(dbPath)
    raw.prepare("UPDATE recovery_compensations SET metadata_json = '{\"caller\":\"evil\"}' WHERE id = ?").run(first.id)
    raw.close()

    const tampered = new CompensationLedger({ path: dbPath })
    expect(() => tampered.getById(first.id)).toThrowError(
      expect.objectContaining<Partial<RecoveryCompensationError>>({ code: 'invalid-state' }),
    )
    tampered.close()
  })

  it('migrates legacy v5 recovery_compensations lacking envelope_digest and fails closed on NULL envelope rows', () => {
    const dir = makeRoot()
    const dbPath = join(dir, 'legacy-comp.sqlite')
    const raw = new DatabaseSync(dbPath)
    raw.exec(`
      CREATE TABLE recovery_runtime_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        bootstrap_status TEXT NOT NULL,
        bootstrap_failure_code TEXT,
        bootstrap_generation INTEGER NOT NULL,
        bootstrap_attestation_valid INTEGER NOT NULL,
        bootstrap_attestations_json TEXT NOT NULL,
        bootstrap_attestation_set_digest TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO recovery_runtime_state VALUES (1, 'idle', NULL, 0, 0, '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', 0);
      CREATE TABLE recovery_compensations (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        idempotency_digest TEXT NOT NULL,
        forward_action_id TEXT UNIQUE,
        kind TEXT NOT NULL,
        category TEXT NOT NULL,
        scope_digest TEXT,
        source_plugin TEXT,
        run_id TEXT,
        step_id TEXT,
        target_json TEXT NOT NULL,
        metadata_json TEXT,
        request_digest TEXT NOT NULL,
        preimage_json TEXT,
        preimage_digest TEXT,
        status TEXT NOT NULL,
        result_code TEXT,
        receipt_json TEXT,
        receipt_digest TEXT,
        reason TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        settled_at INTEGER,
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO recovery_compensations VALUES (
        'comp-legacy-1', 'legacy-k', '${'a'.repeat(64)}', NULL, 'fs.restore', 'rollback-state',
        NULL, NULL, NULL, NULL, '{"path":"a.txt"}', NULL, '${'b'.repeat(64)}',
        '{"existed":true}', '${'c'.repeat(64)}', 'succeeded', 'restored',
        NULL, NULL, NULL, 999999, 1000, 1000, 1000, 1
      );
      PRAGMA user_version = 5;
    `)
    raw.close()
    chmodSync(dbPath, 0o600)

    const ledger = new CompensationLedger({ path: dbPath })
    expect(() => ledger.getById('comp-legacy-1')).toThrowError(
      expect.objectContaining<Partial<RecoveryCompensationError>>({ code: 'invalid-state' }),
    )
    ledger.close()
  })
})
