import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import { normalizeConfig } from '../src/config.js'
import { buildMemoryIndex } from '../src/index-memory.js'
import {
  AssociationParamTuningLedger,
  classifyProfileChange,
  clampAssocParamProfile,
  DECAY_HALF_LIFE_LADDER,
  describeRelaxationChange,
  describeSingleTighteningStep,
  ensureParamTuningSchema,
  fromAssociationConfig,
  hasAssocObservedRegression,
  isProfileTighterOrEqual,
  proposeAssocParamTightening,
  toHotPathProfile,
  withinAssocParamBounds,
  type AssocParamProfileValues,
  type AssocWindowStats,
} from '../src/param-tuning.js'
import { openAssociationDatabase } from '../src/sqlite.js'
import { tokenizeAssociationText } from '../src/tokenize.js'
import {
  computeOwnerScopeKey,
  computePrincipalDigest,
  NODE_KINDS,
  type NodeKind,
} from '../src/types.js'

const DAY_MS = 86_400_000
const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'assoc-param-tuning-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeScopeKey(label = 'owner-param'): string {
  return computeOwnerScopeKey({
    mode: 'delivery',
    principalDigest: computePrincipalDigest(label),
    principalRecordId: `pr-${label}`,
    principalVersion: 1,
    workspace: '/ws/param',
    agentPreset: 'primary',
  })
}

function makeDefaultProfile(overrides?: Partial<AssocParamProfileValues>): AssocParamProfileValues {
  const base = fromAssociationConfig(normalizeConfig({ databasePath: ':memory:' }))
  return {
    ...base,
    ...overrides,
    sourceWeightsPct: {
      ...base.sourceWeightsPct,
      ...overrides?.sourceWeightsPct,
    },
  }
}

function makeStats(overrides?: Partial<AssocWindowStats>): AssocWindowStats {
  const exposures: Record<string, { total: number; unusedOrCorrected: number }> = {}
  for (const kind of NODE_KINDS) {
    exposures[kind] = { total: 0, unusedOrCorrected: 0 }
  }
  return {
    fromAt: 0,
    toAt: 1000,
    totalSteps: 20,
    timedOutSteps: 0,
    p99LatencyUs: 500,
    injectedTasks: 20,
    decidedTasks: 20,
    usedTasks: 12,
    correctedTasks: 0,
    sourceExposures: {
      ...(exposures as Record<NodeKind, { total: number; unusedOrCorrected: number }>),
      ...overrides?.sourceExposures,
    },
    ...overrides,
  }
}

function insertTrainingBatch(
  db: DatabaseSync,
  scopeKey: string,
  prefix: string,
  count: number,
  at: number,
  options?: {
    readonly timedOutCount?: number
    readonly usedCount?: number
    readonly correctedCount?: number
    readonly injectedCount?: number
    readonly sourcePlugin?: string
    readonly nodeIdPrefix?: string
  },
): void {
  const timedOutCount = options?.timedOutCount ?? 0
  const usedCount = options?.usedCount ?? 0
  const correctedCount = options?.correctedCount ?? 0
  const injectedCount = options?.injectedCount ?? count
  const sourcePlugin = options?.sourcePlugin ?? 'personal-memory'
  const nodeIdPrefix = options?.nodeIdPrefix ?? 'a:m-batch'

  const insertMetric = db.prepare(`
    INSERT INTO assoc_step_metrics (
      task_id, owner_scope_key, in_holdout, latency_us, timed_out,
      fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at
    ) VALUES (?, ?, 0, ?, ?, 'none', ?, ?, '{}', ?)
  `)
  const insertExposure = db.prepare(`
    INSERT INTO assoc_exposures (
      task_id, node_id, owner_scope_key, source_plugin, exposed_at,
      was_exposed, assoc_read_count, weak_use_count, strong_used, weak_used, corrected
    ) VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, 0, ?)
  `)

  for (let i = 0; i < count; i += 1) {
    const taskId = `${prefix}-t-${i}`
    const timedOut = i < timedOutCount ? 1 : 0
    const inj = i < injectedCount && timedOut === 0 ? 3 : 0
    insertMetric.run(taskId, scopeKey, timedOut ? 6_000 : 400, timedOut, inj, inj, at + i)
    if (inj > 0) {
      const readCount = i < usedCount ? 1 : 0
      const corrected = i < correctedCount ? 1 : 0
      insertExposure.run(
        taskId,
        `${nodeIdPrefix}-${i}`,
        scopeKey,
        sourcePlugin,
        at + i,
        readCount,
        readCount > 0 ? 1 : 0,
        corrected,
      )
    }
  }
}

function insertHoldoutBatch(
  db: DatabaseSync,
  scopeKey: string,
  prefix: string,
  count: number,
  at: number,
  options?: { readonly timedOutCount?: number },
): void {
  const timedOutCount = options?.timedOutCount ?? 0
  const insertHoldout = db.prepare(`
    INSERT INTO assoc_holdout_assignments (
      task_id, owner_scope_key, task_kind, session_id, turn_number,
      in_holdout, bucket_bps, rate_bps, hmac_digest, assigned_at
    ) VALUES (?, ?, 'foreground-turn', 'sess-h', ?, 1, 500, 1250, ?, ?)
  `)
  const insertMetric = db.prepare(`
    INSERT INTO assoc_step_metrics (
      task_id, owner_scope_key, in_holdout, latency_us, timed_out,
      fallback_mode, injected_count, candidate_count, source_counts_json, occurred_at
    ) VALUES (?, ?, 1, ?, ?, 'holdout', 0, 0, '{}', ?)
  `)
  const digest = 'a'.repeat(64)
  for (let i = 0; i < count; i += 1) {
    const taskId = `${prefix}-hold-${i}`
    insertHoldout.run(taskId, scopeKey, i, digest, at + i)
    insertMetric.run(taskId, scopeKey, 0, i < timedOutCount ? 1 : 0, at + i)
  }
}

describe('quantized parameter profile grid, bounds & partial order', () => {
  test('converts from config, clamps to fixed grid, and projects to HotPathProfile', () => {
    const cfg = normalizeConfig({ databasePath: ':memory:' })
    const baseline = fromAssociationConfig(cfg)
    expect(baseline.decayHalfLifeMs).toBe(14 * DAY_MS)
    expect(baseline.maxHops).toBe(2)
    expect(baseline.maxItems).toBe(8)
    expect(baseline.hysteresisDeltaMilli).toBe(150)
    expect(baseline.sourceWeightsPct.goal).toBe(120)
    expect(withinAssocParamBounds(baseline)).toBe(true)

    const clamped = clampAssocParamProfile({
      decayHalfLifeMs: 2_000_000_000, // snaps to 1_209_600_000 or 2_592_000_000
      maxHops: 99,
      maxItems: 2,
      hysteresisDeltaMilli: 73,
      sourceWeightsPct: {
        ...baseline.sourceWeightsPct,
        memory: 999,
        dream: -10,
      },
    })
    expect(clamped.maxHops).toBe(2)
    expect(clamped.maxItems).toBe(5)
    expect(clamped.hysteresisDeltaMilli).toBe(50)
    expect(clamped.sourceWeightsPct.memory).toBe(150)
    expect(clamped.sourceWeightsPct.dream).toBe(20)
    expect(DECAY_HALF_LIFE_LADDER).toContain(clamped.decayHalfLifeMs)
    expect(withinAssocParamBounds(clamped)).toBe(true)

    const hotProfile = toHotPathProfile(baseline, cfg)
    expect(hotProfile.maxHops).toBe(2)
    expect(hotProfile.maxItems).toBe(8)
    expect(hotProfile.hysteresisDelta).toBe(0.15)
    expect(hotProfile.sourceWeights.memory).toBe(1.0)
    expect(Object.isFrozen(hotProfile.sourceWeights)).toBe(true)
  })

  test('classifies identical, tighten, relax, and routes mixed tighten+relax to relax', () => {
    const base = makeDefaultProfile()
    expect(classifyProfileChange(base, { ...base })).toBe('identical')

    // Tightening: smaller maxItems, smaller maxHops, larger hysteresis, shorter decay, smaller weight
    const tighter = makeDefaultProfile({ maxItems: 7 })
    expect(isProfileTighterOrEqual(tighter, base)).toBe(true)
    expect(classifyProfileChange(base, tighter)).toBe('tighten')
    expect(describeSingleTighteningStep(base, tighter)).toEqual({
      parameter: 'maxItems',
      from: 8,
      to: 7,
      steps: 1,
    })

    const tighterHyst = makeDefaultProfile({ hysteresisDeltaMilli: 200 })
    expect(classifyProfileChange(base, tighterHyst)).toBe('tighten')

    const tighterDecay = makeDefaultProfile({ decayHalfLifeMs: 7 * DAY_MS })
    expect(classifyProfileChange(base, tighterDecay)).toBe('tighten')

    // Pure relaxation
    const looser = makeDefaultProfile({ decayHalfLifeMs: 30 * DAY_MS })
    expect(isProfileTighterOrEqual(looser, base)).toBe(false)
    expect(classifyProfileChange(base, looser)).toBe('relax')
    expect(describeRelaxationChange(base, looser)).toEqual({
      parameter: 'decayHalfLifeMs',
      from: 14 * DAY_MS,
      to: 30 * DAY_MS,
      steps: 1,
    })

    // Mixed tighten + relax MUST classify as 'relax' (and fail single-parameter check)
    const mixed = makeDefaultProfile({
      maxItems: 7, // tighten
      hysteresisDeltaMilli: 100, // relax
    })
    expect(classifyProfileChange(base, mixed)).toBe('relax')
    expect(describeSingleTighteningStep(base, mixed)).toBeUndefined()
    expect(describeRelaxationChange(base, mixed)).toBeUndefined()
  })

  test('pure proposer & BigInt regression checks are deterministic and never trigger on positive evidence', () => {
    const base = makeDefaultProfile()
    const ledger = new AssociationParamTuningLedger(openAssociationDatabase(':memory:'))
    const policy = ledger.policy

    expect(proposeAssocParamTightening(base, makeStats({ totalSteps: 10, decidedTasks: 10, injectedTasks: 10 }), policy))
      .toEqual({ kind: 'no-op', reason: 'insufficient-sample' })
    expect(proposeAssocParamTightening(base, makeStats({ usedTasks: 10, correctedTasks: 1 }), policy))
      .toEqual({ kind: 'no-op', reason: 'below-threshold' })

    // High timeout prefers maxHops first
    const timeoutProp = proposeAssocParamTightening(base, makeStats({ timedOutSteps: 5 }), policy)
    expect(timeoutProp).toMatchObject({
      kind: 'tighten',
      triggerReason: 'high-timeout-rate',
      change: { parameter: 'maxHops', from: 2, to: 1 },
    })

    // Noisy source kind prioritized on low usage
    const noisyProp = proposeAssocParamTightening(
      base,
      makeStats({
        usedTasks: 1,
        sourceExposures: {
          ...makeStats().sourceExposures,
          dream: { total: 12, unusedOrCorrected: 12 },
        },
      }),
      policy,
    )
    expect(noisyProp).toMatchObject({
      kind: 'tighten',
      triggerReason: 'noisy-source-kind',
      change: { parameter: 'sourceWeightsPct.dream', from: 80, to: 70 },
    })

    // Regression predicate with BigInt exact math
    const basis = makeStats({ totalSteps: 20, timedOutSteps: 1, injectedTasks: 20, usedTasks: 10, correctedTasks: 2 })
    expect(hasAssocObservedRegression(basis, makeStats({ totalSteps: 100, timedOutSteps: 0, injectedTasks: 100, usedTasks: 90, correctedTasks: 0 }), policy).regressed).toBe(false)
    expect(hasAssocObservedRegression(basis, makeStats({ totalSteps: 20, timedOutSteps: 1, injectedTasks: 20, usedTasks: 10, correctedTasks: 4 }), policy).regressed).toBe(false) // 20% <= 10% + 10%
    expect(hasAssocObservedRegression(basis, makeStats({ totalSteps: 20, timedOutSteps: 1, injectedTasks: 20, usedTasks: 10, correctedTasks: 5 }), policy)).toEqual({ regressed: true, reason: 'correction-rate-regressed' })
    expect(hasAssocObservedRegression(basis, makeStats({ totalSteps: 20, timedOutSteps: 3, injectedTasks: 20, usedTasks: 10, correctedTasks: 2 }), policy)).toEqual({ regressed: true, reason: 'timeout-rate-regressed' })
    expect(hasAssocObservedRegression(basis, makeStats({ totalSteps: 20, timedOutSteps: 1, injectedTasks: 20, usedTasks: 6, correctedTasks: 2 }), policy)).toEqual({ regressed: true, reason: 'usage-rate-regressed' })
  })
})

describe('AssociationParamTuningLedger durability, tamper fallback & auto-tightening', () => {
  test('schema is idempotent, enforces immutability triggers, and falls back on version tamper', () => {
    const db = openAssociationDatabase(':memory:')
    ensureParamTuningSchema(db)
    ensureParamTuningSchema(db) // idempotent

    const scopeKey = makeScopeKey('tamper')
    let now = 100_000
    const ledger = new AssociationParamTuningLedger(db, {
      now: () => now,
      policy: { observationMs: DAY_MS },
    })

    // Baseline v0
    const v0 = ledger.current(scopeKey)
    expect(v0.version).toBe(0)
    expect(v0.origin).toBe('baseline')
    expect(v0.source).toBe('active')

    // Request v1 (maxItems: 8 -> 7) and settle
    const r1 = ledger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxItems: 7 }),
      reason: 'tighten-1',
      idempotencyKey: 'req-1',
    })
    expect(r1).toMatchObject({ status: 'adopted', version: 1 })
    now += DAY_MS
    expect(ledger.tick({ scopeKey })).toEqual({ action: 'settled', version: 1 })
    const v1 = ledger.current(scopeKey)
    expect(v1.version).toBe(1)

    // Request v2 (maxItems: 7 -> 6)
    const r2 = ledger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxItems: 6 }),
      reason: 'tighten-2',
      idempotencyKey: 'req-2',
    })
    expect(r2).toMatchObject({ status: 'adopted', version: 2 })
    expect(ledger.current(scopeKey)).toMatchObject({ version: 2, source: 'active' })

    // Immutability triggers block direct update/delete
    expect(() =>
      db.exec("UPDATE assoc_param_profile_versions SET params_json = '{}' WHERE version = 2"),
    ).toThrow(/immutable/)
    expect(() => db.exec('DELETE FROM assoc_param_profile_versions WHERE version = 2')).toThrow(
      /durable/,
    )

    // Tamper v2 -> falls back to exact verified parent v1
    db.exec(`
      DROP TRIGGER assoc_param_profile_versions_immutable;
      UPDATE assoc_param_profile_versions SET params_json = '{"bad":true}' WHERE version = 2;
    `)
    const afterV2Tamper = ledger.current(scopeKey)
    expect(afterV2Tamper.version).toBe(1)
    expect(afterV2Tamper.source).toBe('parent-fallback')
    expect(afterV2Tamper.digest).toBe(v1.digest)
    expect(afterV2Tamper.parameters.maxItems).toBe(7)

    // Tamper v1 as well -> falls back to verified v0 baseline
    db.exec(`UPDATE assoc_param_profile_versions SET params_json = '{"bad":true}' WHERE version = 1;`)
    const afterV1Tamper = ledger.current(scopeKey)
    expect(afterV1Tamper.version).toBe(0)
    expect(afterV1Tamper.origin).toBe('baseline')
    expect(afterV1Tamper.source).toBe('default')
    expect(afterV1Tamper.digest).toBe(v0.digest)

    db.close()
  })

  test('auto-tightens on low usage and preserves observing state across DB close/reopen', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'assoc.sqlite')
    const scopeKey = makeScopeKey('persist')
    let now = 1_000_000

    {
      const db1 = openAssociationDatabase(dbPath)
      ensureParamTuningSchema(db1)
      insertTrainingBatch(db1, scopeKey, 'b1', 20, now - 10_000, {
        usedCount: 0,
        correctedCount: 0,
      })
      const ledger1 = new AssociationParamTuningLedger(db1, {
        now: () => now,
        policy: { observationMs: DAY_MS, minSourceSample: 50 }, // skip per-source, step maxItems
      })

      const tick1 = ledger1.tick({ scopeKey })
      expect(tick1).toMatchObject({
        action: 'adopted',
        version: 1,
        change: { parameter: 'maxItems', from: 8, to: 7 },
      })
      expect(ledger1.status(scopeKey)).toMatchObject({
        state: 'observing',
        observeFrom: now,
        observeUntil: now + DAY_MS,
      })
      db1.close()
    }

    // Reopen DB in a fresh instance and verify observing state continues and settles at observeUntil
    {
      const db2 = openAssociationDatabase(dbPath)
      ensureParamTuningSchema(db2)
      const ledger2 = new AssociationParamTuningLedger(db2, {
        now: () => now,
        policy: { observationMs: DAY_MS, minSourceSample: 50 },
      })

      expect(ledger2.current(scopeKey)).toMatchObject({
        version: 1,
        origin: 'auto',
        source: 'active',
        parameters: { maxItems: 7 },
      })
      expect(ledger2.status(scopeKey)).toMatchObject({
        state: 'observing',
        observeFrom: now,
        observeUntil: now + DAY_MS,
      })

      // Mid-observation with positive evidence stays observing
      insertTrainingBatch(db2, scopeKey, 'b2', 20, now + 100, {
        usedCount: 16,
        correctedCount: 0,
      })
      now += 1_000
      expect(ledger2.tick({ scopeKey })).toEqual({ action: 'observing', version: 1 })

      // At observeUntil -> settles to idle
      now += DAY_MS
      expect(ledger2.tick({ scopeKey })).toEqual({ action: 'settled', version: 1 })
      expect(ledger2.status(scopeKey).state).toBe('idle')
      expect(ledger2.current(scopeKey).version).toBe(1)
      db2.close()
    }
  })
})

describe('holdout-replay-gated relaxation & counterfactual runHotPathQuery replay', () => {
  function buildReplayIndex(scopeKey: string, nowMs: number) {
    return buildMemoryIndex({
      nodes: [
        {
          id: 'n-used-1',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:u1',
          ownerScopeKey: scopeKey,
          scopeMode: 'workspace',
          workspace: '/ws/param',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'alpha_service recovery runbook 1',
          entities: ['alpha_service'],
          tokens: tokenizeAssociationText('alpha_service recovery runbook 1'),
          expiresAt: null,
          updatedAt: nowMs - 100,
        },
        {
          id: 'n-used-2',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:u2',
          ownerScopeKey: scopeKey,
          scopeMode: 'workspace',
          workspace: '/ws/param',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'alpha_service recovery runbook 2',
          entities: ['alpha_service'],
          tokens: tokenizeAssociationText('alpha_service recovery runbook 2'),
          expiresAt: null,
          updatedAt: nowMs - 200,
        },
        {
          id: 'n-used-3',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:u3',
          ownerScopeKey: scopeKey,
          scopeMode: 'workspace',
          workspace: '/ws/param',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'alpha_service recovery runbook 3',
          entities: ['alpha_service'],
          tokens: tokenizeAssociationText('alpha_service recovery runbook 3'),
          expiresAt: null,
          updatedAt: nowMs - 300,
        },
        {
          id: 'n-used-4',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:u4',
          ownerScopeKey: scopeKey,
          scopeMode: 'workspace',
          workspace: '/ws/param',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'alpha_service recovery runbook 4',
          entities: ['alpha_service'],
          tokens: tokenizeAssociationText('alpha_service recovery runbook 4'),
          expiresAt: null,
          updatedAt: nowMs - 400,
        },
        {
          id: 'n-used-5',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:u5',
          ownerScopeKey: scopeKey,
          scopeMode: 'workspace',
          workspace: '/ws/param',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'alpha_service recovery runbook 5',
          entities: ['alpha_service'],
          tokens: tokenizeAssociationText('alpha_service recovery runbook 5'),
          expiresAt: null,
          updatedAt: nowMs - 500,
        },
        {
          id: 'n-used-6',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:u6',
          ownerScopeKey: scopeKey,
          scopeMode: 'workspace',
          workspace: '/ws/param',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'alpha_service sixth helpful item',
          entities: ['alpha_service'],
          tokens: tokenizeAssociationText('alpha_service sixth helpful item'),
          expiresAt: null,
          updatedAt: nowMs - 600,
        },
        {
          id: 'n-noise-7',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:n7',
          ownerScopeKey: scopeKey,
          scopeMode: 'workspace',
          workspace: '/ws/param',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'alpha_service old stale item',
          entities: ['alpha_service'],
          tokens: tokenizeAssociationText('alpha_service old stale item'),
          expiresAt: null,
          updatedAt: nowMs - 700,
        },
      ],
      edges: [],
      synonyms: [],
    })
  }

  test('rejects relaxation when replay is disabled, and rejects mixed/multi-param when enabled', () => {
    const db = openAssociationDatabase(':memory:')
    ensureParamTuningSchema(db)
    const scopeKey = makeScopeKey('relax-disabled')
    let now = 100_000

    // Disabled replay
    const disabledLedger = new AssociationParamTuningLedger(db, {
      now: () => now,
      policy: { relaxationReplayEnabled: false, observationMs: DAY_MS },
    })
    disabledLedger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxItems: 7 }),
      reason: 'tighten',
    })
    now += DAY_MS
    disabledLedger.tick({ scopeKey })

    expect(
      disabledLedger.requestChange({
        scopeKey,
        candidate: makeDefaultProfile({ maxItems: 8 }),
        reason: 'relax',
      }),
    ).toEqual({ status: 'rejected', reason: 'loosening-requires-holdout' })
    // Mixed tighten+relax also rejected with loosening-requires-holdout when replay disabled
    expect(
      disabledLedger.requestChange({
        scopeKey,
        candidate: makeDefaultProfile({ maxItems: 6, hysteresisDeltaMilli: 100 }),
        reason: 'mixed',
      }),
    ).toEqual({ status: 'rejected', reason: 'loosening-requires-holdout' })

    // Enabled replay: mixed tighten+relax rejected with not-single-parameter
    const enabledLedger = new AssociationParamTuningLedger(db, {
      now: () => now,
      policy: { relaxationReplayEnabled: true, observationMs: DAY_MS },
    })
    expect(
      enabledLedger.requestChange({
        scopeKey,
        candidate: makeDefaultProfile({ maxItems: 6, hysteresisDeltaMilli: 100 }),
        reason: 'mixed',
      }),
    ).toEqual({ status: 'rejected', reason: 'not-single-parameter' })

    db.close()
  })

  test('gates relaxation via holdout seal + counterfactual runHotPathQuery replay (insufficient-holdout, holdout-drifted, stale-parent, no-net-benefit, adopted)', () => {
    const db = openAssociationDatabase(':memory:')
    ensureParamTuningSchema(db)
    const scopeKey = makeScopeKey('relax-gate')
    let now = 2_000_000
    const index = buildReplayIndex(scopeKey, now)

    const ledger = new AssociationParamTuningLedger(db, {
      now: () => now,
      policy: { observationMs: DAY_MS, minHoldoutSamples: 20, autoTightenEnabled: true },
    })

    // First tighten to v1 (maxItems: 5) so relaxing to maxItems: 6 is in bounds
    ledger.requestChange({ scopeKey, candidate: makeDefaultProfile({ maxItems: 7 }), reason: 't1' })
    now += DAY_MS
    ledger.tick({ scopeKey })
    ledger.requestChange({ scopeKey, candidate: makeDefaultProfile({ maxItems: 6 }), reason: 't2' })
    now += DAY_MS
    ledger.tick({ scopeKey })
    ledger.requestChange({ scopeKey, candidate: makeDefaultProfile({ maxItems: 5 }), reason: 't3' })
    now += DAY_MS
    ledger.tick({ scopeKey })
    expect(ledger.current(scopeKey).version).toBe(3)

    // 1. Insufficient holdout (< 20) -> holdout-failed
    insertHoldoutBatch(db, scopeKey, 'few', 5, now - 500)
    const p1 = ledger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxItems: 6 }),
      reason: 'relax-too-early',
    })
    expect(p1.status).toBe('proposed')
    now += 10
    const t1 = ledger.tick({ scopeKey, index })
    expect(t1).toMatchObject({
      action: 'relax-rejected',
      reason: 'holdout-failed',
      replay: { verdict: 'fail', failureReason: 'insufficient-holdout' },
    })

    // 2. Add >= 20 holdout samples, but replay episodes have n-used-6 as noise (not in usedIds) -> no-net-benefit
    insertHoldoutBatch(db, scopeKey, 'full', 20, now - 500)
    insertTrainingBatch(db, scopeKey, 'train', 20, now - 500, { usedCount: 16, correctedCount: 0 })
    const insertEpisode = db.prepare(`
      INSERT INTO assoc_replay_episodes (
        task_id, owner_scope_key, in_holdout, cues_json, used_node_ids_json,
        corrected_node_ids_json, profile_version, occurred_at
      ) VALUES (?, ?, 0, ?, ?, ?, 3, ?)
    `)
    insertEpisode.run(
      'ep-1',
      scopeKey,
      JSON.stringify([{ kind: 'user', text: 'check alpha_service', weight: 1.0 }]),
      JSON.stringify(['n-used-1', 'n-used-2', 'n-used-3', 'n-used-4', 'n-used-5']),
      JSON.stringify(['n-used-6']),
      now - 100,
    )
    const p2 = ledger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxItems: 6 }),
      reason: 'relax-noisy',
    })
    expect(p2.status).toBe('proposed')
    now += 10
    const t2 = ledger.tick({ scopeKey, index })
    expect(t2).toMatchObject({
      action: 'relax-rejected',
      reason: 'holdout-failed',
      replay: { verdict: 'fail', failureReason: 'no-net-benefit' },
    })

    // 3. Holdout drift check: mutate holdout membership inside sealed window before tick
    const p3 = ledger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxItems: 6 }),
      reason: 'relax-drift',
    })
    expect(p3.status).toBe('proposed')
    db.prepare(
      `INSERT INTO assoc_holdout_assignments (
        task_id, owner_scope_key, task_kind, session_id, turn_number,
        in_holdout, bucket_bps, rate_bps, hmac_digest, assigned_at
      ) VALUES (?, ?, 'foreground-turn', 's', 99, 1, 100, 1250, ?, ?)`,
    ).run('drift-task', scopeKey, 'b'.repeat(64), now - 10)
    now += 10
    expect(ledger.tick({ scopeKey, index })).toMatchObject({
      action: 'relax-rejected',
      reason: 'holdout-drifted',
    })

    // 4. Stale parent check: parent moves while proposal is pending
    const p4 = ledger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxItems: 6 }),
      reason: 'relax-stale',
    })
    expect(p4.status).toBe('proposed')
    // Advance parent via direct valid v4 insertion & head update
    const v3 = ledger.current(scopeKey)
    const v4Params = makeDefaultProfile({ maxItems: 5, hysteresisDeltaMilli: 200 })
    const v4ParamsDigest = growthObjectDigest(v4Params)
    const v4Basis = { stats: makeStats() }
    const v4Change = { parameter: 'hysteresisDeltaMilli', from: 150, to: 200, steps: 1 }
    const v4Digest = growthObjectDigest({
      protocol: 'assistant-association/param-profile/v1',
      scopeKey,
      version: 4,
      parentVersion: 3,
      parentDigest: v3.digest,
      parameters: v4Params,
      paramsDigest: v4ParamsDigest,
      basis: v4Basis,
      change: v4Change,
      origin: 'manual',
    })
    db.prepare(
      `INSERT INTO assoc_param_profile_versions
       (scope_key, version, parent_version, params_json, params_digest, basis_json, change_json, origin, digest, idempotency_key, created_at)
       VALUES (?, 4, 3, ?, ?, ?, ?, 'manual', ?, 'manual-v4', ?)`,
    ).run(
      scopeKey,
      JSON.stringify(v4Params),
      v4ParamsDigest,
      JSON.stringify(v4Basis),
      JSON.stringify(v4Change),
      v4Digest,
      now,
    )
    db.prepare(
      `UPDATE assoc_param_profile_heads SET active_version = 4, latest_version = 4, active_digest = ?, changed_at = ? WHERE scope_key = ?`,
    ).run(v4Digest, now, scopeKey)
    now += 10
    expect(ledger.tick({ scopeKey, index })).toMatchObject({
      action: 'relax-rejected',
      reason: 'stale-parent',
    })

    // 5. Genuine counterfactual pass: replace ep-1 with episode where n-used-6 IS used!
    db.exec('DELETE FROM assoc_replay_episodes')
    insertEpisode.run(
      'ep-good-1',
      scopeKey,
      JSON.stringify([{ kind: 'user', text: 'check alpha_service', weight: 1.0 }]),
      JSON.stringify(['n-used-1', 'n-used-2', 'n-used-3', 'n-used-4', 'n-used-5', 'n-used-6']),
      JSON.stringify([]),
      now - 100,
    )
    const p5 = ledger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxItems: 6, hysteresisDeltaMilli: 200 }),
      reason: 'relax-good',
    })
    expect(p5.status).toBe('proposed')
    now += 10
    const adopted = ledger.tick({ scopeKey, index })
    expect(adopted).toMatchObject({
      action: 'relax-adopted',
      version: 5,
      change: { parameter: 'maxItems', from: 5, to: 6 },
      replay: {
        verdict: 'pass',
        parent: { usedHits: 5, noiseExposed: 0 },
        candidate: { usedHits: 6, noiseExposed: 0 },
      },
    })
    expect(ledger.current(scopeKey)).toMatchObject({
      version: 5,
      origin: 'replay',
      parameters: { maxItems: 6, hysteresisDeltaMilli: 200 },
    })

    db.close()
  })
})

describe('exact-parent rollback & anti-thrashing', () => {
  test('rolls back v2 to exact parent v1 on degradation, fences old evidence, and blocks immediate re-adoption', () => {
    const db = openAssociationDatabase(':memory:')
    ensureParamTuningSchema(db)
    const scopeKey = makeScopeKey('rollback-chain')
    let now = 5_000_000

    const ledger = new AssociationParamTuningLedger(db, {
      now: () => now,
      policy: { observationMs: DAY_MS, minSourceSample: 50 },
    })

    // Step 1: v0 -> v1 (maxItems: 8 -> 7) and settle
    insertTrainingBatch(db, scopeKey, 'era0', 20, now - 1_000, {
      usedCount: 0,
      correctedCount: 0,
    })
    expect(ledger.tick({ scopeKey })).toMatchObject({
      action: 'adopted',
      version: 1,
      change: { parameter: 'maxItems', from: 8, to: 7 },
    })
    // Positive post-adoption evidence for v1 -> settles
    insertTrainingBatch(db, scopeKey, 'era1-good', 20, now + 100, {
      usedCount: 18,
      correctedCount: 0,
    })
    now += DAY_MS
    expect(ledger.tick({ scopeKey })).toEqual({ action: 'settled', version: 1 })
    const v1 = ledger.current(scopeKey)
    expect(v1.version).toBe(1)

    // Step 2: New bad evidence triggers v1 -> v2 (maxItems: 7 -> 6)
    insertTrainingBatch(db, scopeKey, 'era1-bad', 20, now + 100, {
      usedCount: 0,
      correctedCount: 2,
    })
    now += 1_000
    expect(ledger.tick({ scopeKey })).toMatchObject({
      action: 'adopted',
      version: 2,
      change: { parameter: 'maxItems', from: 7, to: 6 },
    })
    const v2 = ledger.current(scopeKey)
    expect(v2.version).toBe(2)

    // Step 3: Post-adoption degradation on v2 (high correction rate) -> rolls back to EXACT parent v1!
    insertTrainingBatch(db, scopeKey, 'era2-worse', 20, now + 100, {
      usedCount: 0,
      correctedCount: 15,
    })
    now += 1_000
    const rb = ledger.tick({ scopeKey })
    expect(rb).toEqual({
      action: 'rolled-back',
      fromVersion: 2,
      toVersion: 1,
      reason: 'correction-rate-regressed',
    })
    expect(ledger.current(scopeKey)).toEqual(v1)

    // Rolled-back digest is recorded and old bad evidence is fenced out
    const status = ledger.status(scopeKey)
    expect(status.state).toBe('idle')
    expect(status.blockedParamsDigests).toContain(v2.paramsDigest)
    expect(status.events.map((e) => e.kind)).toEqual([
      'adopted',
      'settled',
      'adopted',
      'rolled-back',
    ])

    // Immediate tick enters rollback-cooldown
    expect(ledger.tick({ scopeKey })).toEqual({
      action: 'no-op',
      reason: 'rollback-cooldown',
    })

    // Explicit request for the exact rolled-back parameter set is blocked
    expect(
      ledger.requestChange({
        scopeKey,
        candidate: v2.parameters,
        reason: 'retry-rolled-back',
      }),
    ).toEqual({ status: 'rejected', reason: 'digest-previously-rolled-back' })

    // Advance past 7d rollbackCooldownMs -> old evidence remains fenced out (insufficient-sample) and v2.paramsDigest remains permanently blocked!
    now += 7 * DAY_MS
    expect(ledger.tick({ scopeKey })).toEqual({
      action: 'no-op',
      reason: 'insufficient-sample',
    })
    insertTrainingBatch(db, scopeKey, 'era3-bad', 20, now + 100, {
      usedCount: 0,
      correctedCount: 0,
    })
    now += 1_000
    const nextTighten = ledger.tick({ scopeKey })
    expect(nextTighten).toMatchObject({
      action: 'adopted',
      version: 3,
      change: { parameter: 'hysteresisDeltaMilli', from: 150, to: 200 },
    })
    expect(ledger.current(scopeKey).paramsDigest).not.toBe(v2.paramsDigest)

    db.close()
  })

  test('tampered observing version triggers immediate version-unverifiable rollback', () => {
    const db = openAssociationDatabase(':memory:')
    ensureParamTuningSchema(db)
    const scopeKey = makeScopeKey('tamper-observing')
    let now = 100_000
    const ledger = new AssociationParamTuningLedger(db, {
      now: () => now,
      policy: { observationMs: DAY_MS },
    })

    ledger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxHops: 1 }),
      reason: 'tighten-hops',
    })
    expect(ledger.status(scopeKey).state).toBe('observing')

    db.exec(`
      DROP TRIGGER assoc_param_profile_versions_immutable;
      UPDATE assoc_param_profile_versions SET params_json = '{"corrupt":1}' WHERE version = 1;
    `)
    now += 10
    expect(ledger.tick({ scopeKey })).toEqual({
      action: 'rolled-back',
      fromVersion: 1,
      toVersion: 0,
      reason: 'version-unverifiable',
    })
    expect(ledger.current(scopeKey).version).toBe(0)
    expect(ledger.status(scopeKey).state).toBe('idle')

    db.close()
  })

  test('rolls back on timeout-rate and usage-drop regressions, and rejects replay when candidate exceeds budget', () => {
    const db = openAssociationDatabase(':memory:')
    ensureParamTuningSchema(db)
    const scopeKey = makeScopeKey('timeout-usage-rb')
    let now = 1_000_000

    // 1. Timeout regression rollback
    const ledger = new AssociationParamTuningLedger(db, {
      now: () => now,
      policy: { observationMs: DAY_MS, minHoldoutSamples: 20 },
    })
    insertTrainingBatch(db, scopeKey, 'ok', 20, now - 1000, { usedCount: 16 })
    ledger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxItems: 7 }),
      reason: 'tighten-1',
    })
    insertTrainingBatch(db, scopeKey, 'to-bad', 20, now + 100, { timedOutCount: 6 })
    now += 500
    expect(ledger.tick({ scopeKey })).toEqual({
      action: 'rolled-back',
      fromVersion: 1,
      toVersion: 0,
      reason: 'timeout-rate-regressed',
    })

    // 2. Usage drop regression rollback (basis 16/20 used -> post 2/20 used) after cooldown expires
    now += 7 * DAY_MS
    insertTrainingBatch(db, scopeKey, 'basis-hi', 20, now + 100, { usedCount: 16 })
    now += 1_000
    ledger.requestChange({
      scopeKey,
      candidate: makeDefaultProfile({ maxHops: 1 }),
      reason: 'tighten-hops',
    })
    insertTrainingBatch(db, scopeKey, 'post-drop', 20, now + 100, { usedCount: 2 })
    now += 500
    expect(ledger.tick({ scopeKey })).toEqual({
      action: 'rolled-back',
      fromVersion: 2,
      toVersion: 0,
      reason: 'usage-rate-regressed',
    })

    // 3. Replay timeout/budget rejection via deterministic hotPathClock on a healthy scope
    const slowScope = makeScopeKey('slow-replay')
    insertHoldoutBatch(db, slowScope, 'h-lat', 20, now - 500)
    insertTrainingBatch(db, slowScope, 't-lat', 20, now - 500, { usedCount: 16 })
    db.prepare(
      `INSERT INTO assoc_replay_episodes (
        task_id, owner_scope_key, in_holdout, cues_json, used_node_ids_json,
        corrected_node_ids_json, profile_version, occurred_at
      ) VALUES (?, ?, 0, ?, ?, '[]', 0, ?)`,
    ).run(
      'ep-lat',
      slowScope,
      JSON.stringify([{ kind: 'user', text: 'check alpha_service', weight: 1.0 }]),
      JSON.stringify(['n-lat-1']),
      now - 100,
    )
    const index = buildMemoryIndex({
      nodes: [
        {
          id: 'n-lat-1',
          kind: 'memory',
          sourcePlugin: 'personal-memory',
          sourceRef: 'memory:lat1',
          ownerScopeKey: slowScope,
          scopeMode: 'workspace',
          workspace: '/ws/param',
          agentPreset: 'primary',
          trust: 'trusted',
          sensitivity: 'private',
          title: 'alpha_service latency test',
          entities: ['alpha_service'],
          tokens: tokenizeAssociationText('alpha_service latency test'),
          expiresAt: null,
          updatedAt: now - 100,
        },
      ],
      edges: [],
      synonyms: [],
    })

    let tickCalls = 0
    // First query (parent) takes <1ms, second query (candidate) exceeds 4.5ms budget
    const clock = () => {
      tickCalls += 1
      if (tickCalls <= 6) return tickCalls * 0.2
      return 10 + (tickCalls - 6) * 5
    }
    const slowLedger = new AssociationParamTuningLedger(db, {
      now: () => now,
      hotPathClock: clock,
      policy: { observationMs: DAY_MS, minHoldoutSamples: 20 },
    })
    const prop = slowLedger.requestChange({
      scopeKey: slowScope,
      candidate: makeDefaultProfile({ decayHalfLifeMs: 30 * DAY_MS }),
      reason: 'relax-slow',
    })
    expect(prop.status).toBe('proposed')
    now += 10
    expect(slowLedger.tick({ scopeKey: slowScope, index })).toMatchObject({
      action: 'relax-rejected',
      reason: 'holdout-failed',
      replay: { verdict: 'fail', failureReason: 'latency-budget-exceeded' },
    })

    db.close()
  })

  test('excludes was_exposed=0 rows from stats(), enforces rollbackCooldownMs/minStepSample/healthyUsageRatePpm/maxTimeoutMarginPpm, and sets active_version=parentInfo.version on parent fallback', () => {
    const db = openAssociationDatabase(':memory:')
    ensureParamTuningSchema(db)
    const scopeKey = makeScopeKey('s2-policy-wiring')
    let now = 10_000_000

    const ledger = new AssociationParamTuningLedger(db, {
      now: () => now,
      policy: {
        observationMs: DAY_MS,
        rollbackCooldownMs: 7 * DAY_MS,
        minSample: 20,
        minStepSample: 30,
        lowUsageRatePpm: 300_000,
        healthyUsageRatePpm: 250_000,
        timeoutMarginPpm: 100_000,
        maxTimeoutMarginPpm: 25_000,
        minSourceSample: 100,
      },
    })

    // 1. Align default policy margins with DEFAULT_PARAM_TUNING_CONFIG
    const defaultLedger = new AssociationParamTuningLedger(db)
    expect(defaultLedger.policy.timeoutMarginPpm).toBe(25_000)
    expect(defaultLedger.policy.usageDropMarginPpm).toBe(100_000)
    expect(defaultLedger.policy.rollbackCooldownMs).toBe(7 * DAY_MS)
    expect(defaultLedger.policy.minStepSample).toBe(20)
    expect(defaultLedger.policy.healthyUsageRatePpm).toBe(250_000)
    expect(defaultLedger.policy.maxTimeoutMarginPpm).toBe(25_000)

    // 2. was_exposed = 0 holdout/unexposed assoc_read rows MUST NOT inflate injectedTasks, usedTasks, or sourceExposures
    db.prepare(`
      INSERT INTO assoc_exposures (
        task_id, node_id, owner_scope_key, source_plugin, exposed_at,
        was_exposed, assoc_read_count, weak_use_count, strong_used, weak_used, corrected
      ) VALUES
        ('hold-read-1', 'a:m-1', ?, 'personal-memory', ?, 0, 1, 0, 0, 0, 0),
        ('uninj-read-2', 'a:m-2', ?, 'personal-memory', ?, 0, 1, 0, 0, 0, 0),
        ('real-exp-3', 'a:m-3', ?, 'personal-memory', ?, 1, 1, 0, 1, 0, 0),
        ('real-exp-4', 'a:m-4', ?, 'personal-memory', ?, 1, 0, 0, 0, 0, 0)
    `).run(scopeKey, now - 500, scopeKey, now - 400, scopeKey, now - 300, scopeKey, now - 200)
    db.prepare(`
      INSERT INTO assoc_holdout_assignments (
        task_id, owner_scope_key, task_kind, session_id, turn_number,
        in_holdout, bucket_bps, rate_bps, hmac_digest, assigned_at
      ) VALUES ('hold-read-1', ?, 'foreground-turn', 's-h', 1, 1, 500, 1250, ?, ?)
    `).run(scopeKey, 'a'.repeat(64), now - 500)

    const filteredStats = ledger.stats(scopeKey, now - 1_000, now, 'training')
    expect(filteredStats.injectedTasks).toBe(2)
    expect(filteredStats.usedTasks).toBe(1)
    expect(filteredStats.sourceExposures.memory).toEqual({ total: 2, unusedOrCorrected: 1 })

    // 3. minStepSample gates step-based tightening (totalSteps=20 < minStepSample=30 -> no-op)
    const stepGated = proposeAssocParamTightening(
      makeDefaultProfile(),
      makeStats({ totalSteps: 20, timedOutSteps: 10, injectedTasks: 20, usedTasks: 0 }),
      ledger.policy,
    )
    expect(stepGated).toEqual({ kind: 'no-op', reason: 'below-threshold' })

    // 4. healthyUsageRatePpm suppresses low-usage-rate when usedRatePpm (6/20 = 300_000) >= healthyUsageRatePpm (250_000)
    const healthySuppressed = proposeAssocParamTightening(
      makeDefaultProfile(),
      makeStats({ totalSteps: 30, timedOutSteps: 0, injectedTasks: 20, usedTasks: 6 }),
      ledger.policy,
    )
    expect(healthySuppressed).toEqual({ kind: 'no-op', reason: 'below-threshold' })

    // 5. maxTimeoutMarginPpm caps timeoutMarginPpm (100_000 capped to 25_000 -> 2/20 = 10% vs 1/20 = 5% regresses!)
    expect(
      hasAssocObservedRegression(
        makeStats({ totalSteps: 30, timedOutSteps: 1 }),
        makeStats({ totalSteps: 30, timedOutSteps: 3 }),
        ledger.policy,
      ),
    ).toEqual({ regressed: true, reason: 'timeout-rate-regressed' })

    // 6. rollbackCooldownMs blocks both tick() and requestChange() inside cooldown, then resumes after expiry
    const cooldownScope = makeScopeKey('cooldown-scope')
    insertTrainingBatch(db, cooldownScope, 'cd-0', 30, now - 2_000, { usedCount: 18 })
    const cd1 = ledger.requestChange({
      scopeKey: cooldownScope,
      candidate: makeDefaultProfile({ maxItems: 7 }),
      reason: 'cd-tighten',
    })
    expect(cd1).toMatchObject({ status: 'adopted', version: 1 })
    insertTrainingBatch(db, cooldownScope, 'cd-bad', 30, now + 100, { timedOutCount: 10 })
    now += 500
    expect(ledger.tick({ scopeKey: cooldownScope })).toMatchObject({
      action: 'rolled-back',
      fromVersion: 1,
      toVersion: 0,
    })

    // Inside cooldown: requestChange (tighten & relax) and tick() return 'rollback-cooldown'
    expect(
      ledger.requestChange({
        scopeKey: cooldownScope,
        candidate: makeDefaultProfile({ maxHops: 1 }),
        reason: 'cd-blocked-req',
      }),
    ).toEqual({ status: 'rejected', reason: 'rollback-cooldown' })
    insertTrainingBatch(db, cooldownScope, 'cd-bad-2', 30, now + 100, { timedOutCount: 10 })
    now += 500
    expect(ledger.tick({ scopeKey: cooldownScope })).toEqual({
      action: 'no-op',
      reason: 'rollback-cooldown',
    })

    // Past cooldown: tick() resumes auto-tightening
    now += 7 * DAY_MS
    insertTrainingBatch(db, cooldownScope, 'cd-bad-3', 30, now + 100, { timedOutCount: 10 })
    now += 500
    expect(ledger.tick({ scopeKey: cooldownScope })).toMatchObject({
      action: 'adopted',
      version: 2,
      triggerReason: 'high-timeout-rate',
    })

    // 7. Parent-tamper fallback during observing_version rollback sets active_version = parentInfo.version (0)
    const fallbackScope = makeScopeKey('parent-fallback-rb')
    ledger.requestChange({
      scopeKey: fallbackScope,
      candidate: makeDefaultProfile({ maxItems: 7 }),
      reason: 'v1',
    })
    now += DAY_MS
    expect(ledger.tick({ scopeKey: fallbackScope })).toEqual({ action: 'settled', version: 1 })
    ledger.requestChange({
      scopeKey: fallbackScope,
      candidate: makeDefaultProfile({ maxItems: 6 }),
      reason: 'v2',
    })
    db.exec(`
      DROP TRIGGER IF EXISTS assoc_param_profile_versions_immutable;
      UPDATE assoc_param_profile_versions SET params_json = '{"bad":1}' WHERE scope_key = '${fallbackScope}' AND version = 1;
    `)
    insertTrainingBatch(db, fallbackScope, 'fb-bad', 30, now + 100, { timedOutCount: 10 })
    now += 500
    expect(ledger.tick({ scopeKey: fallbackScope })).toEqual({
      action: 'rolled-back',
      fromVersion: 2,
      toVersion: 0,
      reason: 'version-unverifiable',
    })
    const headAfterFb = db
      .prepare('SELECT active_version, active_digest FROM assoc_param_profile_heads WHERE scope_key = ?')
      .get(fallbackScope) as { active_version: number; active_digest: string }
    expect(headAfterFb.active_version).toBe(0)
    expect(headAfterFb.active_digest).toBe(ledger.current(fallbackScope).digest)

    db.close()
  })

  test('recursively verifies ancestor payloads in #verified so tampered ancestor params_json or basis_json rejects entire descendant chain', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'ancestor-tamper.sqlite')
    const db = openAssociationDatabase(dbPath)
    ensureParamTuningSchema(db)

    let now = 20_000_000
    const ledger = new AssociationParamTuningLedger(db, {
      now: () => now,
      policy: { observationMs: DAY_MS },
    })

    // 1. Chain v0 -> v1 -> v2 -> v3: tamper v1.basis_json (leaving all digest columns untouched) -> rejects v3, v2, v1
    const basisScope = makeScopeKey('ancestor-basis-tamper')
    const v0 = ledger.current(basisScope)
    expect(
      ledger.requestChange({
        scopeKey: basisScope,
        candidate: makeDefaultProfile({ maxItems: 7 }),
        reason: 'v1',
      }),
    ).toMatchObject({ status: 'adopted', version: 1 })
    now += DAY_MS
    expect(ledger.tick({ scopeKey: basisScope })).toEqual({ action: 'settled', version: 1 })

    expect(
      ledger.requestChange({
        scopeKey: basisScope,
        candidate: makeDefaultProfile({ maxItems: 6 }),
        reason: 'v2',
      }),
    ).toMatchObject({ status: 'adopted', version: 2 })
    now += DAY_MS
    expect(ledger.tick({ scopeKey: basisScope })).toEqual({ action: 'settled', version: 2 })
    const v1 = ledger.status(basisScope).versions.find((v) => v.version === 1)!
    expect(v1).toBeDefined()

    expect(
      ledger.requestChange({
        scopeKey: basisScope,
        candidate: makeDefaultProfile({ maxItems: 5 }),
        reason: 'v3',
      }),
    ).toMatchObject({ status: 'adopted', version: 3 })
    now += DAY_MS
    expect(ledger.tick({ scopeKey: basisScope })).toEqual({ action: 'settled', version: 3 })
    expect(ledger.current(basisScope)).toMatchObject({ version: 3, source: 'active' })

    db.exec(`DROP TRIGGER IF EXISTS assoc_param_profile_versions_immutable;`)
    db.prepare(
      'UPDATE assoc_param_profile_versions SET basis_json = ? WHERE scope_key = ? AND version = 1',
    ).run('{"stats":{"tampered":true}}', basisScope)

    // Entire descendant chain v3 -> v2 -> v1 must be rejected, falling back to verified baseline v0
    expect(ledger.current(basisScope)).toMatchObject({
      version: 0,
      origin: 'baseline',
      source: 'default',
      digest: v0.digest,
    })
    expect(ledger.status(basisScope).versions).toEqual([])

    // 2. Chain v0 -> v1 -> v2 with v2 observing: tamper v1.params_json (digests untouched) -> tick() rejects v2 as version-unverifiable & rolls back to v0
    const paramsScope = makeScopeKey('ancestor-params-tamper')
    expect(
      ledger.requestChange({
        scopeKey: paramsScope,
        candidate: makeDefaultProfile({ maxItems: 7 }),
        reason: 'p-v1',
      }),
    ).toMatchObject({ status: 'adopted', version: 1 })
    now += DAY_MS
    expect(ledger.tick({ scopeKey: paramsScope })).toEqual({ action: 'settled', version: 1 })

    expect(
      ledger.requestChange({
        scopeKey: paramsScope,
        candidate: makeDefaultProfile({ maxItems: 7, maxHops: 1 }),
        reason: 'p-v2',
      }),
    ).toMatchObject({ status: 'adopted', version: 2 })
    expect(ledger.status(paramsScope).state).toBe('observing')

    db.prepare(
      'UPDATE assoc_param_profile_versions SET params_json = ? WHERE scope_key = ? AND version = 1',
    ).run('{"tampered":true}', paramsScope)

    now += 100
    expect(ledger.tick({ scopeKey: paramsScope })).toEqual({
      action: 'rolled-back',
      fromVersion: 2,
      toVersion: 0,
      reason: 'version-unverifiable',
    })
    expect(ledger.current(paramsScope).version).toBe(0)
    expect(ledger.status(paramsScope).versions).toEqual([])

    // 3. Chain v0 -> v1 -> v2 -> v3: tamper v2.params_json (digests untouched) -> rejects v3 & v2, falls back to verified v1
    const midScope = makeScopeKey('ancestor-mid-tamper')
    ledger.requestChange({ scopeKey: midScope, candidate: makeDefaultProfile({ maxItems: 7 }), reason: 'm-v1' })
    now += DAY_MS
    ledger.tick({ scopeKey: midScope })
    const midV1 = ledger.current(midScope)
    ledger.requestChange({ scopeKey: midScope, candidate: makeDefaultProfile({ maxItems: 6 }), reason: 'm-v2' })
    now += DAY_MS
    ledger.tick({ scopeKey: midScope })
    ledger.requestChange({ scopeKey: midScope, candidate: makeDefaultProfile({ maxItems: 5 }), reason: 'm-v3' })
    now += DAY_MS
    ledger.tick({ scopeKey: midScope })

    db.prepare(
      'UPDATE assoc_param_profile_versions SET params_json = ? WHERE scope_key = ? AND version = 2',
    ).run('{"tampered":true}', midScope)

    expect(ledger.current(midScope)).toMatchObject({
      version: 1,
      source: 'parent-fallback',
      digest: midV1.digest,
    })
    expect(ledger.status(midScope).versions.map((v) => v.version)).toEqual([1])

    db.close()
  })
})
