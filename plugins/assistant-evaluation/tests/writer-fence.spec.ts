import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EvaluationStore, EvaluationStoreError } from '../src/store.ts'
import type {
  EvaluationLearningWriterFence,
  EvaluationScope,
  OutcomeEnvelope,
} from '../src/types.ts'

const roots: string[] = []
const scope: EvaluationScope = { workspace: '/work/alpha', preset: 'primary' }

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'assistant-evaluation-writer-fence-'))
  roots.push(root)
  return join(root, 'evaluation.sqlite')
}

function outcome(overrides: Partial<OutcomeEnvelope>): OutcomeEnvelope {
  return {
    scope,
    situation: 'automation:writer-fence',
    executionStatus: 'succeeded',
    objectiveStatus: 'unknown',
    deliveryStatus: 'not-required',
    source: { kind: 'automation', id: 'assistant-automations' },
    trust: 'trusted',
    evidence: [{ kind: 'automation-run', ref: 'writer-fence-run' }],
    metrics: {},
    occurredAt: 1_000,
    idempotencyKey: 'writer-fence:terminal',
    evaluator: { id: 'assistant-automations', version: 'terminal-v1' },
    ...overrides,
  }
}

function ownerObjective(
  objectiveStatus: 'achieved' | 'not-achieved',
  idempotencyKey: string,
): OutcomeEnvelope {
  return outcome({
    objectiveStatus,
    deliveryStatus: 'delivered',
    source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
    evidence: [
      { kind: 'automation-run', ref: 'writer-fence-run' },
      { kind: 'delivery-outbox', ref: 'writer-fence-outbox' },
    ],
    occurredAt: objectiveStatus === 'not-achieved' ? 2_000 : 3_000,
    idempotencyKey,
    evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
  })
}

function completeAll(target: EvaluationStore): void {
  for (const entry of target.listPendingProjections(100, 10_000)) {
    expect(target.completeProjection({ evaluationId: entry.evaluationId, now: 10_000 })).toBe(true)
  }
}

describe('cross-ledger learning writer fence', () => {
  test('fences an empty exact scope against the first canonical write and rejects stale watermarks', () => {
    const database = databasePath()
    const target = new EvaluationStore({ path: database, now: () => 5_000 })
    const writer = new EvaluationStore({ path: database, now: () => 5_000 })
    const probe = new DatabaseSync(database)
    probe.exec('PRAGMA busy_timeout = 1')
    try {
      expect(target.listTaskLearningProjectionFeed(scope, undefined, 1).scopeWatermark).toBe(0)
      expect(target.withCanonicalScopeWriterFence(scope, { scopeWatermark: 0 }, () => {
        expect(target.getForegroundLearningProjection(scope, 'absent')).toBeUndefined()
        // A second real SQLite connection cannot acquire the writer lock,
        // including while this scope has no canonical rows at all.
        expect(() => probe.exec('BEGIN IMMEDIATE')).toThrow(/locked/)
        return 'empty-scope-commit'
      })).toEqual({ matched: true, value: 'empty-scope-commit' })
      writer.append(outcome({ objectiveStatus: 'achieved' }))
      const blocked = vi.fn(() => 'must-not-run')
      expect(target.withCanonicalScopeWriterFence(scope, { scopeWatermark: 0 }, blocked))
        .toEqual({ matched: false, reason: 'watermark-changed' })
      expect(blocked).not.toHaveBeenCalled()
      expect(target.withCanonicalScopeWriterFence(scope, { scopeWatermark: 1 }, () => 'current'))
        .toEqual({ matched: true, value: 'current' })
      expect(target.listPendingProjections(100, 10_000)).toHaveLength(1)
      expect(target.withCanonicalScopeWriterFence({ ...scope, workspace: '/work/empty-other' }, { scopeWatermark: 0 }, () => 'other'))
        .toEqual({ matched: true, value: 'other' })
      for (const watermark of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => target.withCanonicalScopeWriterFence(scope, { scopeWatermark: watermark }, blocked)).toThrow(EvaluationStoreError)
      }
      for (const method of ['withLearningWriterFence', 'withCanonicalTaskWriterFence'] as const) {
        for (const watermark of [0, 1]) {
          expect(() => target[method](scope, { scopeWatermark: watermark, evidence: [] }, blocked)).toThrow(EvaluationStoreError)
        }
      }
      expect(blocked).not.toHaveBeenCalled()
    } finally { probe.close(); writer.close(); target.close() }
  })

  test('rolls back scope-fenced mutations on callback failure and asynchronous results', async () => {
    const target = new EvaluationStore({ path: databasePath(), now: () => 5_000 })
    try {
      const stored = target.append(outcome({ objectiveStatus: 'achieved' }))
      const scopeWatermark = target.listTaskLearningProjectionFeed(scope, undefined, 1).scopeWatermark
      const complete = () => expect(target.completeProjection({ evaluationId: stored.id, now: 10_000 })).toBe(true)
      expect(() => target.withCanonicalScopeWriterFence(scope, { scopeWatermark }, () => {
        complete()
        throw new Error('downstream failed')
      })).toThrow('downstream failed')
      expect(target.listPendingProjections(100, 10_000)).toHaveLength(1)
      expect(() => target.withCanonicalScopeWriterFence(scope, { scopeWatermark }, () => {
        complete()
        return Promise.resolve('escaped')
      })).toThrow(EvaluationStoreError)
      expect(target.listPendingProjections(100, 10_000)).toHaveLength(1)
      expect(() => target.withCanonicalScopeWriterFence(scope, { scopeWatermark }, () => {
        complete()
        // eslint-disable-next-line unicorn/no-thenable -- intentional hostile callback result
        return { then() {} }
      })).toThrow(EvaluationStoreError)
      expect(target.listPendingProjections(100, 10_000)).toHaveLength(1)
      const rejected = Promise.reject(new Error('callback promise rejected'))
      expect(() => target.withCanonicalScopeWriterFence(scope, { scopeWatermark }, () => {
        complete()
        return rejected
      })).toThrow(EvaluationStoreError)
      await Promise.resolve()
      expect(target.listPendingProjections(100, 10_000)).toHaveLength(1)
      expect(target.withCanonicalScopeWriterFence(scope, { scopeWatermark }, () => { complete(); return 'committed' }))
        .toEqual({ matched: true, value: 'committed' })
      expect(target.listPendingProjections(100, 10_000)).toEqual([])
    } finally { target.close() }
  })

  test('rejects function thenables and then getters without evaluating them through every writer fence', () => {
    const target = new EvaluationStore({ path: databasePath(), now: () => 5_000 })
    try {
      const stored = target.append(outcome({ objectiveStatus: 'achieved' }))
      const receipt = target.getTaskLearningProjection(scope, stored.id)!
      completeAll(target)
      const fence = { scopeWatermark: receipt.scopeWatermark, evidence: [{
        subjectKind: receipt.projection.subjectKind, subjectRef: receipt.projection.subjectRef,
        version: receipt.projection.version, digest: receipt.projection.digest, disposition: 'upsert' as const,
      }] }
      const then = vi.fn()
      const getter = vi.fn(() => { throw new Error('then getter must never run') })
      // eslint-disable-next-line unicorn/no-thenable -- intentional hostile function result
      const functionThenable = Object.assign(() => 'function-value', { then })
      // eslint-disable-next-line unicorn/no-thenable -- intentional hostile getter result
      const getterThenable = Object.defineProperty({}, 'then', { get: getter })
      for (const method of ['withLearningWriterFence', 'withCanonicalTaskWriterFence', 'withCanonicalScopeWriterFence'] as const) {
        // eslint-disable-next-line unicorn/no-thenable -- even a non-callable then must be rejected without reading it
        for (const value of [functionThenable, getterThenable, { then: 0 }]) {
          expect(() => target[method](scope, fence, () => value)).toThrow(EvaluationStoreError)
        }
        expect(target[method](scope, fence, () => 'ordinary-sync-value'))
          .toEqual({ matched: true, value: 'ordinary-sync-value' })
      }
      expect(then).not.toHaveBeenCalled()
      expect(getter).not.toHaveBeenCalled()
    } finally { target.close() }
  })

  test('distinguishes pending projection, advanced watermark, and changed evidence without entering the callback', () => {
    const target = new EvaluationStore({ path: databasePath(), now: () => 5_000 })
    target.append(outcome({}))
    const firstObjective = target.append(ownerObjective('not-achieved', 'writer-fence:failed'))
    const first = target.getTaskLearningProjection(scope, firstObjective.id)!
    expect(first.projection.disposition).toBe('upsert')
    completeAll(target)

    const fence: EvaluationLearningWriterFence = {
      scopeWatermark: first.scopeWatermark,
      evidence: [{
        subjectKind: first.projection.subjectKind,
        subjectRef: first.projection.subjectRef,
        version: first.projection.version,
        digest: first.projection.digest,
        disposition: 'upsert',
      }],
    }
    const committed = vi.fn(() => 'evolution-commit')
    expect(target.withLearningWriterFence(scope, fence, committed)).toEqual({
      matched: true,
      value: 'evolution-commit',
    })
    expect(committed).toHaveBeenCalledOnce()

    const correction = target.append(ownerObjective('achieved', 'writer-fence:correction'))
    const corrected = target.getTaskLearningProjection(scope, correction.id)!
    expect(corrected).toMatchObject({
      scopeWatermark: first.scopeWatermark + 1,
      projection: { disposition: 'retract', version: first.projection.version + 1 },
    })

    const canonicalFence = {
      scopeWatermark: corrected.scopeWatermark,
      evidence: [{
        subjectKind: corrected.projection.subjectKind,
        subjectRef: corrected.projection.subjectRef,
        version: corrected.projection.version,
        digest: corrected.projection.digest,
        disposition: corrected.projection.disposition,
      }],
    }
    const invalidated = vi.fn(() => 'downstream-invalidated')
    // Canonical reconciliation fences the exact retract immediately; it does
    // not wait for the optional Evolution projection outbox to drain.
    expect(target.withCanonicalTaskWriterFence(scope, canonicalFence, invalidated)).toEqual({
      matched: true,
      value: 'downstream-invalidated',
    })
    expect(invalidated).toHaveBeenCalledOnce()

    const staleDisposition = vi.fn(() => 'must-not-run')
    expect(target.withCanonicalTaskWriterFence(scope, {
      ...canonicalFence,
      evidence: [{ ...canonicalFence.evidence[0]!, disposition: 'upsert' }],
    }, staleDisposition)).toEqual({ matched: false, reason: 'evidence-changed' })
    expect(staleDisposition).not.toHaveBeenCalled()
    for (const evidence of [
      { ...canonicalFence.evidence[0]!, version: canonicalFence.evidence[0]!.version + 1 },
      { ...canonicalFence.evidence[0]!, digest: '0'.repeat(64) },
      { ...canonicalFence.evidence[0]!, subjectRef: 'another-run' },
    ]) {
      expect(target.withCanonicalTaskWriterFence(scope, {
        ...canonicalFence, evidence: [evidence],
      }, staleDisposition)).toEqual({ matched: false, reason: 'evidence-changed' })
    }
    expect(target.withCanonicalTaskWriterFence(scope, {
      ...canonicalFence, scopeWatermark: canonicalFence.scopeWatermark - 1,
    }, staleDisposition)).toEqual({ matched: false, reason: 'watermark-changed' })
    expect(target.withCanonicalTaskWriterFence(
      { workspace: '/work/other', preset: 'primary' },
      canonicalFence,
      staleDisposition,
    )).toEqual({ matched: false, reason: 'watermark-changed' })
    expect(() => target.withLearningWriterFence(scope, {
      scopeWatermark: corrected.scopeWatermark,
      evidence: [canonicalFence.evidence[0]!],
    } as EvaluationLearningWriterFence, staleDisposition)).toThrowError(
      expect.objectContaining<Partial<EvaluationStoreError>>({ code: 'invalid-input' }),
    )

    const blocked = vi.fn(() => 'must-not-run')
    expect(target.withLearningWriterFence(scope, fence, blocked)).toEqual({
      matched: false,
      reason: 'watermark-changed',
    })
    expect(blocked).not.toHaveBeenCalled()

    const pendingFence = {
      ...fence,
      scopeWatermark: corrected.scopeWatermark,
    }
    expect(target.withLearningWriterFence(scope, pendingFence, blocked)).toEqual({
      matched: false,
      reason: 'projection-pending',
    })
    expect(blocked).not.toHaveBeenCalled()

    completeAll(target)
    expect(target.withLearningWriterFence(scope, pendingFence, blocked)).toEqual({
      matched: false,
      reason: 'evidence-changed',
    })
    expect(blocked).not.toHaveBeenCalled()
    target.close()
  })

  test('rolls back the Evaluation writer transaction when a callback tries to escape asynchronously', () => {
    const target = new EvaluationStore({ path: databasePath(), now: () => 5_000 })
    target.append(outcome({}))
    const objective = target.append(ownerObjective('not-achieved', 'writer-fence:async-failed'))
    const receipt = target.getTaskLearningProjection(scope, objective.id)!
    completeAll(target)
    const fence: EvaluationLearningWriterFence = {
      scopeWatermark: receipt.scopeWatermark,
      evidence: [{
        subjectKind: receipt.projection.subjectKind,
        subjectRef: receipt.projection.subjectRef,
        version: receipt.projection.version,
        digest: receipt.projection.digest,
        disposition: 'upsert',
      }],
    }

    expect(() => target.withLearningWriterFence(scope, fence, async () => 'escaped'))
      .toThrowError(expect.objectContaining<Partial<EvaluationStoreError>>({ code: 'invalid-input' }))
    expect(() => target.append(ownerObjective('achieved', 'writer-fence:after-rollback'))).not.toThrow()
    const retracted = target.getTaskLearningProjection(
      scope,
      target.append(ownerObjective('achieved', 'writer-fence:after-rollback')).id,
    )!
    expect(retracted.projection.disposition).toBe('retract')
    expect(() => target.withCanonicalTaskWriterFence(scope, {
      scopeWatermark: retracted.scopeWatermark,
      evidence: [{
        subjectKind: retracted.projection.subjectKind,
        subjectRef: retracted.projection.subjectRef,
        version: retracted.projection.version,
        digest: retracted.projection.digest,
        disposition: retracted.projection.disposition,
      }],
    }, async () => 'escaped')).toThrowError(
      expect.objectContaining<Partial<EvaluationStoreError>>({ code: 'invalid-input' }),
    )
    target.close()
  })

  test('rejects an exact tuple after another task advances the same scope watermark', () => {
    const target = new EvaluationStore({ path: databasePath(), now: () => 5_000 })
    const first = target.append(outcome({ objectiveStatus: 'achieved' }))
    const receipt = target.getTaskLearningProjection(scope, first.id)!
    expect(target.getGoalOutcomeLearningProjection(scope, 'writer-fence-run')).toBeUndefined()
    target.append(outcome({
      situation: 'automation:writer-fence-other',
      evidence: [{ kind: 'automation-run', ref: 'writer-fence-other-run' }],
      objectiveStatus: 'achieved',
      idempotencyKey: 'writer-fence:other',
    }))
    const callback = vi.fn(() => 'must-not-run')
    expect(target.withCanonicalTaskWriterFence(scope, {
      scopeWatermark: receipt.scopeWatermark,
      evidence: [{
        subjectKind: receipt.projection.subjectKind,
        subjectRef: receipt.projection.subjectRef,
        version: receipt.projection.version,
        digest: receipt.projection.digest,
        disposition: receipt.projection.disposition,
      }],
    }, callback)).toEqual({ matched: false, reason: 'watermark-changed' })
    expect(callback).not.toHaveBeenCalled()
    target.close()
  })
})
