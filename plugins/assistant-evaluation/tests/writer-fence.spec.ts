import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
