import {
  chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { openPreferenceDatabase, preferenceSchemaVersion } from '../src/sqlite.ts'
import { PreferenceStore, PreferenceStoreError } from '../src/store.ts'
import type { PreferenceSignalInput } from '../src/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'preference-learning-store-'))
  roots.push(value)
  return value
}

function store(now: () => number = () => 10_000, path = ':memory:') {
  return new PreferenceStore({
    path,
    now,
    signalTtlMs: 100_000,
    hypothesisTtlMs: 50_000,
    minSignalsForActivation: 2,
    minConfidenceBps: 7_500,
    maxContradictionBps: 2_500,
    maxActiveOverlays: 2,
    maxReviewHypotheses: 10,
    maxOverlayBytes: 2_048,
  })
}

function signal(overrides: Partial<PreferenceSignalInput> = {}): PreferenceSignalInput {
  return {
    scope: { workspace: '/work/alpha', preset: 'primary' },
    preferenceKey: 'response.verbosity',
    candidateValue: 'concise',
    stance: 'support',
    actorTrust: 'owner-authenticated',
    interpretationTrust: 'typed-feedback',
    source: 'direct-owner-feedback',
    occurredAt: 10_000,
    idempotencyKey: 'signal-1',
    ...overrides,
  }
}

describe('preference database', () => {
  test('creates a private WAL/FULL database and rejects unsafe paths', () => {
    const path = join(root(), 'private', 'preferences.sqlite')
    const database = openPreferenceDatabase(path)
    expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(preferenceSchemaVersion)
    expect((database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2)
    database.close()
    expect(statSync(path).mode & 0o777).toBe(0o600)

    expect(() => openPreferenceDatabase('relative.sqlite')).toThrowError(/absolute/i)
    const unsafe = join(root(), 'unsafe.sqlite')
    closeSync(openSync(unsafe, 'w', 0o666))
    chmodSync(unsafe, 0o644)
    expect(() => openPreferenceDatabase(unsafe)).toThrowError(/permission/i)
  })

  test('rejects a database created by a newer implementation', () => {
    const path = join(root(), 'future.sqlite')
    const database = new DatabaseSync(path)
    database.exec(`PRAGMA user_version = ${preferenceSchemaVersion + 1}`)
    database.close()
    chmodSync(path, 0o600)
    expect(() => openPreferenceDatabase(path)).toThrowError(/newer/i)
  })
})

describe('preference store', () => {
  test('records typed signals idempotently without retaining the raw idempotency key', () => {
    const target = store()
    const first = target.appendSignal(signal())
    expect(first.idempotencyKey).toMatch(/^pref-idem-[a-f0-9]{64}$/u)
    expect(first.idempotencyKey).not.toContain('signal-1')
    expect(target.appendSignal(signal())).toEqual(first)
    expect(() => target.appendSignal(signal({ candidateValue: 'detailed' })))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'idempotency-conflict' }))
    target.close()
  })

  test('rolls back the whole producer batch when any durable receipt would be invalid', () => {
    const target = store()
    target.appendSignal(signal({ idempotencyKey: 'already-recorded' }))

    expect(() => target.appendSignals([
      signal({
        preferenceKey: 'response.structure', candidateValue: 'bullets',
        idempotencyKey: 'must-not-partially-record',
      }),
      signal({ candidateValue: 'detailed', idempotencyKey: 'already-recorded' }),
    ])).toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({
      code: 'idempotency-conflict',
    }))

    expect(target.health().signals).toBe(1)
    expect(target.list({ workspace: '/work/alpha', preset: 'primary' }))
      .not.toContainEqual(expect.objectContaining({ preferenceKey: 'response.structure' }))
    target.close()
  })

  test('keeps T0 observational, makes T2 proposal-only, and forbids T3', () => {
    const target = store()
    target.appendSignal(signal({
      preferenceKey: 'feedback.response', candidateValue: 'helpful', idempotencyKey: 'feedback',
    }))
    expect(target.list({ workspace: '/work/alpha', preset: 'primary' })).toEqual([])

    target.appendSignal(signal({
      preferenceKey: 'memory.retention', candidateValue: 'long-term', idempotencyKey: 'memory',
    }))
    const proposed = target.list({ workspace: '/work/alpha', preset: 'primary' })[0]!
    expect(proposed).toMatchObject({ riskTier: 'T2', claimState: 'proposed', effectState: 'inactive' })
    expect(() => target.activate(proposed.scope, proposed.id, proposed.version))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'forbidden-tier' }))

    expect(() => target.appendSignal(signal({
      preferenceKey: 'policy.approval_boundary', candidateValue: 'host-defined', idempotencyKey: 'policy',
    }))).toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'forbidden-tier' }))
    target.close()
  })

  test('computes bounded confidence, activates only ready T1, and rolls back on newer owner correction', () => {
    const target = store()
    target.appendSignal(signal({ idempotencyKey: 'support-1', occurredAt: 9_900 }))
    let hypothesis = target.list({ workspace: '/work/alpha', preset: 'primary' })[0]!
    expect(hypothesis).toMatchObject({
      riskTier: 'T1', claimState: 'tentative', effectState: 'shadow', supportingSignals: 1,
    })
    expect(() => target.activate(hypothesis.scope, hypothesis.id, hypothesis.version))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'not-ready' }))

    target.appendSignal(signal({ idempotencyKey: 'support-2', occurredAt: 9_901 }))
    hypothesis = target.list(hypothesis.scope)[0]!
    expect(hypothesis.confidenceBps).toBeGreaterThanOrEqual(9_900)
    hypothesis = target.activate(hypothesis.scope, hypothesis.id, hypothesis.version)
    expect(hypothesis).toMatchObject({ effectState: 'active' })
    expect(target.overlay(hypothesis.scope)).toContain('Prefer concise responses.')

    target.appendSignal(signal({
      candidateValue: 'detailed', idempotencyKey: 'contradiction', occurredAt: 10_000,
    }))
    const rolledBack = target.get(hypothesis.scope, hypothesis.id)!
    expect(rolledBack).toMatchObject({
      claimState: 'rejected', effectState: 'rolled-back', version: hypothesis.version + 1,
    })
    expect(target.overlay(hypothesis.scope)).toBeUndefined()
    target.close()
  })

  test('never rolls back a newer active owner preference for delayed older feedback', () => {
    const target = store()
    target.appendSignal(signal({ idempotencyKey: 'newer-owner-1', occurredAt: 9_990 }))
    target.appendSignal(signal({ idempotencyKey: 'newer-owner-2', occurredAt: 9_991 }))
    const ready = target.list({ workspace: '/work/alpha', preset: 'primary' })[0]!
    const active = target.activate(ready.scope, ready.id, ready.version)

    target.appendSignal(signal({
      candidateValue: 'detailed',
      idempotencyKey: 'delayed-older-owner-selection',
      occurredAt: 9_000,
    }))

    expect(target.get(active.scope, active.id)).toMatchObject({
      claimState: 'tentative', effectState: 'active',
    })
    expect(target.overlay(active.scope)).toContain('concise')
    target.close()
  })

  test('never activates from unverified or model-inferred repetition alone', () => {
    const target = store()
    for (let index = 0; index < 30; index += 1) {
      target.appendSignal(signal({
        scope: { workspace: '/work/unverified', preset: 'primary' },
        actorTrust: 'unverified',
        interpretationTrust: 'typed-feedback',
        source: 'system-observation',
        idempotencyKey: `unverified-${index}`,
      }))
      target.appendSignal(signal({
        scope: { workspace: '/work/model', preset: 'primary' },
        actorTrust: 'owner-authenticated',
        interpretationTrust: 'model-inference',
        source: 'system-observation',
        idempotencyKey: `model-${index}`,
      }))
    }
    for (const workspace of ['/work/unverified', '/work/model']) {
      const hypothesis = target.list({ workspace, preset: 'primary' })[0]!
      expect(hypothesis).toMatchObject({ effectState: 'shadow', supportingSignals: 0 })
      expect(() => target.activate(hypothesis.scope, hypothesis.id, hypothesis.version))
        .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'not-ready' }))
    }
    target.close()
  })

  test('never lets low-trust inference roll back an active owner preference', () => {
    const target = store()
    target.appendSignal(signal({ idempotencyKey: 'owner-1' }))
    target.appendSignal(signal({ idempotencyKey: 'owner-2', occurredAt: 9_999 }))
    const ready = target.list({ workspace: '/work/alpha', preset: 'primary' })[0]!
    const active = target.activate(ready.scope, ready.id, ready.version)

    for (let index = 0; index < 20; index += 1) {
      target.appendSignal(signal({
        candidateValue: 'detailed',
        actorTrust: 'owner-authenticated',
        interpretationTrust: 'model-inference',
        source: 'system-observation',
        occurredAt: 9_900 - index,
        idempotencyKey: `low-trust-contradiction-${index}`,
      }))
    }
    expect(target.get(active.scope, active.id)).toMatchObject({
      claimState: 'tentative', effectState: 'active', confidenceBps: expect.any(Number),
    })
    expect(target.overlay(active.scope)).toContain('concise')
    target.close()
  })

  test('gives the latest explicit owner selection precedence over accumulated old choices', () => {
    const target = store()
    for (let index = 0; index < 4; index += 1) {
      target.appendSignal(signal({
        occurredAt: 9_900 + index,
        idempotencyKey: `old-concise-${index}`,
      }))
    }
    target.appendSignal(signal({
      candidateValue: 'detailed', occurredAt: 10_000, idempotencyKey: 'latest-detailed',
    }))
    const hypotheses = target.list({ workspace: '/work/alpha', preset: 'primary' })
    const concise = hypotheses.find(item => item.candidateValue === 'concise')!
    const detailed = hypotheses.find(item => item.candidateValue === 'detailed')!
    expect(() => target.activate(concise.scope, concise.id, concise.version))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'not-ready' }))
    expect(() => target.activate(detailed.scope, detailed.id, detailed.version))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'not-ready' }))
    target.close()
  })

  test('isolates exact Agent scopes and enforces one active value per catalog key', () => {
    const target = store()
    for (let index = 1; index <= 2; index += 1) {
      target.appendSignal(signal({ idempotencyKey: `alpha-${index}`, occurredAt: 10_000 - index }))
      target.appendSignal(signal({
        scope: { workspace: '/work/beta', preset: 'primary' },
        idempotencyKey: `beta-${index}`,
        occurredAt: 10_000 - index,
      }))
    }
    const alpha = target.list({ workspace: '/work/alpha', preset: 'primary' })[0]!
    const beta = target.list({ workspace: '/work/beta', preset: 'primary' })[0]!
    target.activate(alpha.scope, alpha.id, alpha.version)
    expect(target.overlay(alpha.scope)).toContain('concise')
    expect(target.overlay(beta.scope)).toBeUndefined()
    expect(target.get(beta.scope, alpha.id)).toBeUndefined()
    target.close()
  })

  test('expires decayed hypotheses deterministically', () => {
    let now = 1_000
    const target = new PreferenceStore({
      path: ':memory:', now: () => now, signalTtlMs: 10_000, hypothesisTtlMs: 2_000,
      minSignalsForActivation: 2, minConfidenceBps: 7_500, maxContradictionBps: 2_500,
      maxActiveOverlays: 2, maxReviewHypotheses: 10, maxOverlayBytes: 2_048,
    })
    target.appendSignal(signal({ occurredAt: 1_000, idempotencyKey: 'expiring' }))
    now = 3_001
    expect(target.list({ workspace: '/work/alpha', preset: 'primary' })[0]).toMatchObject({
      claimState: 'expired', effectState: 'inactive', confidenceBps: expect.any(Number),
    })
    target.close()
  })

  test('forgets an exact scope durably while leaving other scopes intact', () => {
    let now = 10_000
    const target = store(() => now)
    target.appendSignal(signal({ idempotencyKey: 'old-alpha' }))
    target.appendSignal(signal({
      scope: { workspace: '/work/beta', preset: 'primary' }, idempotencyKey: 'beta',
    }))
    const forgotten = target.forgetScope({ workspace: '/work/alpha', preset: 'primary' }, 'forget-alpha')
    expect(forgotten).toMatchObject({ replayed: false, deletedSignals: 1, deletedHypotheses: 1 })
    expect(target.forgetScope({ workspace: '/work/alpha', preset: 'primary' }, 'forget-alpha'))
      .toEqual({ ...forgotten, replayed: true })
    expect(target.list({ workspace: '/work/alpha', preset: 'primary' })).toEqual([])
    expect(target.list({ workspace: '/work/beta', preset: 'primary' })).toHaveLength(1)
    expect(() => target.appendSignal(signal({ idempotencyKey: 'replayed-old' })))
      .toThrowError(expect.objectContaining<Partial<PreferenceStoreError>>({ code: 'scope-forgotten' }))
    now = 20_000
    expect(target.appendSignal(signal({ occurredAt: 20_000, idempotencyKey: 'new-alpha' }))).toBeDefined()
    target.close()
  })

  test('does not report privacy forget success while exact scope bytes remain in DB or WAL files', () => {
    const directory = root()
    const path = join(directory, 'privacy.sqlite')
    const secretWorkspace = '/work/SECRET_SCOPE_6c8d899a6f13'
    const target = store(() => 10_000, path)
    target.appendSignal(signal({
      scope: { workspace: secretWorkspace, preset: 'primary' },
      idempotencyKey: 'privacy-scan-signal',
    }))
    const files = [path, `${path}-wal`, `${path}-shm`]
    const secretBytes = Buffer.from(secretWorkspace)
    expect(files.some(file => existsSync(file) && readFileSync(file).includes(secretBytes))).toBe(true)

    expect(target.forgetScope(
      { workspace: secretWorkspace, preset: 'primary' },
      'privacy-scan-forget',
    )).toMatchObject({ replayed: false, deletedSignals: 1, deletedHypotheses: 1 })
    expect(files.every(file => !existsSync(file) || !readFileSync(file).includes(secretBytes))).toBe(true)
    if (existsSync(`${path}-wal`)) expect(statSync(`${path}-wal`).size).toBe(0)
    target.close()
  })

  test('reports content-free aggregate health only', () => {
    const target = store()
    target.appendSignal(signal())
    const health = target.health()
    expect(health).toMatchObject({ ready: true, enabled: true, signals: 1, hypotheses: 1, shadow: 1 })
    expect(JSON.stringify(health)).not.toMatch(/workspace|verbosity|concise|primary/u)
    target.close()
  })

  test('physically purges expired signal rows in bounded maintenance batches', () => {
    let now = 10_000
    const target = store(() => now)
    target.appendSignal(signal({ idempotencyKey: 'retained-1' }))
    target.appendSignal(signal({ idempotencyKey: 'retained-2' }))
    now = 110_001
    expect(target.maintain(1)).toEqual({ deletedSignals: 1 })
    expect(target.health().signals).toBe(1)
    expect(target.maintain(1)).toEqual({ deletedSignals: 1 })
    expect(target.health().signals).toBe(0)
    expect(target.maintain(1)).toEqual({ deletedSignals: 0 })
    target.close()
  })

  test('does not report TTL deletion success while expired signal bytes remain in DB or WAL files', () => {
    let now = 10_000
    const directory = root()
    const path = join(directory, 'retention.sqlite')
    const expiredWorkspace = '/work/EXPIRED_SCOPE_e0c1ce2fb1e2'
    const target = store(() => now, path)
    target.appendSignal(signal({
      scope: { workspace: expiredWorkspace, preset: 'primary' },
      preferenceKey: 'feedback.response',
      candidateValue: 'helpful',
      idempotencyKey: 'retention-scan-signal',
    }))
    const files = [path, `${path}-wal`, `${path}-shm`]
    const expiredBytes = Buffer.from(expiredWorkspace)
    expect(files.some(file => existsSync(file) && readFileSync(file).includes(expiredBytes))).toBe(true)

    now = 110_001
    expect(target.maintain()).toEqual({ deletedSignals: 1 })
    expect(files.every(file => !existsSync(file) || !readFileSync(file).includes(expiredBytes))).toBe(true)
    if (existsSync(`${path}-wal`)) expect(statSync(`${path}-wal`).size).toBe(0)
    target.close()
  })
})
