import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.js'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.js'
import { createCreationCapabilityTrendSnapshot, TREND_SNAPSHOT_MAX_PAGE } from '../src/creation-capability-trend-snapshot.js'
import type { CreationCapabilityOrdinaryUseTrend } from '../src/creation-capability-types.js'

const H = 60 * 60 * 1000
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function ledger(now = () => 5_000): { path: string; store: ControlPlaneStore } {
  const root = mkdtempSync(join(tmpdir(), 'cp-trend-snapshot-'))
  roots.push(root)
  const path = join(root, 'control.sqlite')
  return { path, store: new ControlPlaneStore({ path, now }) }
}

const quality = (samples: number, achieved: number) => ({ status: samples >= 5 ? 'measured' as const : 'insufficient' as const,
  samples, achieved, notAchieved: samples - achieved })

/** Synthetic observational trend; the snapshot layer treats everything but its identity fields as opaque. */
function trend(planId = 'plan', scopeWatermark = 7): CreationCapabilityOrdinaryUseTrend {
  const adoptedAt = 1_000 * H
  const windows = [-2, -1, 0, 1].map(index => ({ index, startExclusive: adoptedAt + index * 24 * H,
    endInclusive: adoptedAt + (index + 1) * 24 * H, complete: index < 1 }))
  const cells = windows.map(({ index }) => ({ index, treated: quality(6, 4 + (index > 0 ? 1 : 0)), control: quality(6, 3),
    calls: index >= 0 ? 2 : 0, exposedTasks: index >= 0 ? 2 : 0 }))
  return { protocol: 'dsh-created-capability-ordinary-use-trend/v1', causal: false,
    design: 'session-cohort-difference-in-differences-model-stratified', planId, receiptDigest: 'a'.repeat(64),
    artifactSha256: 'b'.repeat(64), schemaDigest: 'c'.repeat(64), adoptionStatus: 'active', withinSignedUseWindow: true,
    minimumSamples: 5, windowMs: 24 * H, parallelTrendThreshold: 0.2, scopeWatermark, rowsDigest: 'd'.repeat(64), windows,
    population: { scanned: 30, counted: 24, excluded: { nonForeground: 0, trigger: 2, retracted: 1, unverified: 3, outsideWindow: 0 } },
    cohorts: { treatedSessions: 3, controlSessions: 4 }, concurrentAdoptions: { status: 'none', count: 0 },
    strata: [
      { model: { state: 'frozen', provider: 'supplier', model: 'task-model', reasoningEffort: 'high' }, cells,
        differenceInDifferences: { status: 'estimated', estimate: 0.1666666666666667, adjustedEstimate: 0.14,
          standardError: 0.21, interval95: { low: -0.27, high: 0.55 } },
        parallelTrend: { status: 'not-flagged', testedWindows: 2, gapChange: 0 } },
      { model: { state: 'missing' }, cells, differenceInDifferences: { status: 'insufficient' },
        parallelTrend: { status: 'untestable', testedWindows: 0 } }],
    flags: ['partial-window'], assumptions: ['observational'], regressions: { status: 'unmeasured' }, cost: { status: 'unmeasured' } }
}

describe('created capability trend snapshots', () => {
  it('seals a trend and lists it with frozen strata, window bounds and digests', () => {
    const { store } = ledger()
    const sealed = store.sealCreatedCapabilityTrendSnapshot(trend())
    expect(sealed.created).toBe(true)
    const snapshot = sealed.record.snapshot
    expect(snapshot).toMatchObject({ protocol: 'dsh-created-capability-ordinary-use-trend-snapshot/v1', causal: false,
      planId: 'plan', receiptDigest: 'a'.repeat(64), trendDigest: controlPlaneDigest(trend()),
      window: { windowMs: 24 * H, preWindows: 2, postWindows: 2, startExclusive: 952 * H, endInclusive: 1_048 * H, complete: false },
      models: [{ state: 'frozen', provider: 'supplier', model: 'task-model', reasoningEffort: 'high' }, { state: 'missing' }],
      flags: ['partial-window'] })
    expect(snapshot.trend.causal).toBe(false)
    expect(snapshot.inputsDigest).toMatch(/^[a-f0-9]{64}$/u)
    const { digest, ...unsigned } = snapshot
    expect(digest).toBe(controlPlaneDigest(unsigned))
    expect(Object.isFrozen(snapshot.models)).toBe(true)
    const page = store.listCreatedCapabilityTrendSnapshots()
    expect(page).toEqual({ protocol: 'dsh-created-capability-ordinary-use-trend-snapshot-list/v1', causal: false,
      items: [{ sequence: 1, sealedAt: 5_000, snapshot }] })
    expect(store.listCreatedCapabilityTrendSnapshots({ planId: 'other' }).items).toEqual([])
    store.close()
  })

  it('gives the same input the same digest and never duplicates it', () => {
    let now = 5_000
    const { store } = ledger(() => now)
    const first = store.sealCreatedCapabilityTrendSnapshot(trend())
    now = 9_000
    const again = store.sealCreatedCapabilityTrendSnapshot(trend())
    expect(again).toEqual({ created: false, record: first.record })
    expect(createCreationCapabilityTrendSnapshot(trend()).digest).toBe(first.record.snapshot.digest)
    expect(store.listCreatedCapabilityTrendSnapshots().items).toHaveLength(1)
    // A changed input is a new, separately addressed seal; the earlier one stays untouched.
    const changed = store.sealCreatedCapabilityTrendSnapshot(trend('plan', 8))
    expect(changed.created).toBe(true)
    expect(changed.record.snapshot.inputsDigest).not.toBe(first.record.snapshot.inputsDigest)
    expect(changed.record.sealedAt).toBe(9_000)
    expect(store.listCreatedCapabilityTrendSnapshots().items.map(item => item.sequence)).toEqual([2, 1])
    store.close()
  })

  it('refuses rewriting and detects a tampered row on read', () => {
    const { path, store } = ledger()
    store.sealCreatedCapabilityTrendSnapshot(trend())
    const raw = new DatabaseSync(path)
    expect(() => raw.exec("UPDATE created_capability_trend_snapshots SET sealed_at=sealed_at+1"))
      .toThrow(/append-only/u)
    expect(() => raw.exec('DELETE FROM created_capability_trend_snapshots')).toThrow(/append-only/u)
    // An out-of-band writer that removes the guard still cannot make a changed row read as sealed.
    raw.exec('DROP TRIGGER created_capability_trend_snapshots_no_update')
    raw.exec(`UPDATE created_capability_trend_snapshots
      SET snapshot_json=json_set(snapshot_json,'$.trend.cohorts.treatedSessions',99)`)
    expect(() => store.listCreatedCapabilityTrendSnapshots()).toThrow(/trend snapshot changed/u)
    expect(() => store.sealCreatedCapabilityTrendSnapshot(trend())).toThrow(/trend snapshot changed/u)
    raw.close()
    store.close()
    // Reopening restores the guard but never silently accepts the tampered row.
    const reopened = new ControlPlaneStore({ path, now: () => 6_000 })
    expect(() => reopened.listCreatedCapabilityTrendSnapshots()).toThrow(/trend snapshot changed/u)
    const check = new DatabaseSync(path)
    expect(() => check.exec('UPDATE created_capability_trend_snapshots SET sealed_at=1')).toThrow(/append-only/u)
    check.close()
    reopened.close()
  })

  it('detects a tampered derived field, plan column or digest column', () => {
    for (const change of [`snapshot_json=json_set(snapshot_json,'$.causal',json('true'))`,
      `snapshot_json=json_set(snapshot_json,'$.models[1].state','frozen')`,
      `snapshot_json=json_set(snapshot_json,'$.window.complete',json('true'))`,
      `plan_id='other-plan'`, `snapshot_digest='${'e'.repeat(64)}'`]) {
      const { path, store } = ledger()
      store.sealCreatedCapabilityTrendSnapshot(trend())
      const raw = new DatabaseSync(path)
      raw.exec('DROP TRIGGER created_capability_trend_snapshots_no_update')
      raw.exec(`UPDATE created_capability_trend_snapshots SET ${change}`)
      expect(() => store.listCreatedCapabilityTrendSnapshots()).toThrow(/trend snapshot/u)
      raw.close()
      store.close()
    }
  })

  it('bounds pagination', () => {
    let now = 1_000
    const { store } = ledger(() => ++now)
    for (let watermark = 1; watermark <= 5; watermark++) store.sealCreatedCapabilityTrendSnapshot(trend('plan', watermark))
    store.sealCreatedCapabilityTrendSnapshot(trend('other-plan', 1))
    const first = store.listCreatedCapabilityTrendSnapshots({ limit: 2 })
    expect(first.items.map(item => item.sequence)).toEqual([6, 5])
    expect(first.nextBeforeSequence).toBe(5)
    const second = store.listCreatedCapabilityTrendSnapshots({ planId: 'plan', limit: 2, beforeSequence: first.nextBeforeSequence! })
    expect(second.items.map(item => item.sequence)).toEqual([4, 3])
    const last = store.listCreatedCapabilityTrendSnapshots({ planId: 'plan', limit: 2, beforeSequence: second.nextBeforeSequence! })
    expect(last.items.map(item => item.sequence)).toEqual([2, 1])
    expect(last.nextBeforeSequence).toBeUndefined()
    expect(store.listCreatedCapabilityTrendSnapshots({ limit: TREND_SNAPSHOT_MAX_PAGE }).items).toHaveLength(6)
    for (const query of [{ limit: 0 }, { limit: TREND_SNAPSHOT_MAX_PAGE + 1 }, { limit: 1.5 }, { beforeSequence: 0 },
      { beforeSequence: -1 }, { planId: '' }, { planId: '../x' }, { planId: 'p'.repeat(161) }]) {
      expect(() => store.listCreatedCapabilityTrendSnapshots(query)).toThrow(/query is invalid/u)
    }
    store.close()
  })

  it('refuses a trend that is not an observational trend result', () => {
    const { store } = ledger()
    expect(() => store.sealCreatedCapabilityTrendSnapshot({ ...trend(), causal: true } as never)).toThrow(/input is invalid/u)
    expect(() => store.sealCreatedCapabilityTrendSnapshot({ ...trend(), windows: [] })).toThrow(/input is invalid/u)
    expect(() => store.sealCreatedCapabilityTrendSnapshot({ ...trend(), rowsDigest: 'x' })).toThrow(/input is invalid/u)
    expect(store.listCreatedCapabilityTrendSnapshots().items).toEqual([])
    store.close()
  })
})

describe('schema 35 migration', () => {
  const version = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), 'cp-trend-snapshot-migration-'))
    roots.push(root)
    return join(root, 'control.sqlite')
  }

  it('adds the append-only snapshot table to a schema 34 ledger', () => {
    const path = fresh()
    openControlPlaneDatabase(path).close()
    const legacy = new DatabaseSync(path)
    legacy.exec('DROP TABLE created_capability_trend_snapshots; PRAGMA user_version = 34;')
    legacy.close()
    const migrated = openControlPlaneDatabase(path)
    expect(version(migrated)).toBe(controlPlaneSchemaVersion)
    expect(controlPlaneSchemaVersion).toBe(35)
    expect(migrated.prepare("SELECT name FROM sqlite_schema WHERE tbl_name='created_capability_trend_snapshots' ORDER BY name")
      .all().map(row => (row as { name: string }).name)).toEqual(['created_capability_trend_snapshots',
      'created_capability_trend_snapshots_no_delete', 'created_capability_trend_snapshots_no_update',
      'created_capability_trend_snapshots_plan', 'sqlite_autoindex_created_capability_trend_snapshots_1'])
    migrated.close()
  })

  it('fails closed on a missing or unknown snapshot table', () => {
    const missing = fresh()
    openControlPlaneDatabase(missing).close()
    const dropped = new DatabaseSync(missing)
    dropped.exec('DROP TABLE created_capability_trend_snapshots')
    dropped.close()
    expect(() => openControlPlaneDatabase(missing)).toThrow(/missing created capability trend snapshot schema/u)
    const unknown = fresh()
    openControlPlaneDatabase(unknown).close()
    const changed = new DatabaseSync(unknown)
    changed.exec(`DROP TABLE created_capability_trend_snapshots;
      CREATE TABLE created_capability_trend_snapshots (sequence INTEGER PRIMARY KEY, snapshot_json TEXT) STRICT;
      PRAGMA user_version = 34;`)
    changed.close()
    expect(() => openControlPlaneDatabase(unknown)).toThrow(/unknown created capability trend snapshot schema/u)
    const after = new DatabaseSync(unknown)
    expect(version(after)).toBe(34)
    after.close()
  })
})
