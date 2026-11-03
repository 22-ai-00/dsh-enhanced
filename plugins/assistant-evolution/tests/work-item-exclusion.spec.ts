import { Context } from '@deepseek-ai/cordis'
import { evaluationLearningProjectionDigest, type TrustedTaskLearningProjectionReceipt } from '@dsh-enhanced/assistant-evaluation'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { AssistantEvolutionService, canonicalEvolutionHostScope } from '../src/service.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.restart()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

// A structural trusted-peer fixture tests Evolution's own receipt boundary,
// not Evaluation's independent producer authentication or WorkItems adoption.
async function fixture(subjectKind: 'work-item' | 'foreground-turn', disposition: 'upsert' | 'retract') {
  const root = await mkdtemp(join(tmpdir(), 'evolution-subject-exclusion-')); roots.push(root)
  const scope = Object.freeze({ workspace: '/work/alpha', preset: 'primary' })
  const objective = Object.freeze({ outcomeId: 'owner-feedback', status: 'achieved' as const,
    source: Object.freeze({ kind: 'user-feedback' as const, id: 'assistant-delivery/typed-owner-feedback' }),
    evidence: Object.freeze([Object.freeze({ kind: subjectKind, ref: 'subject' })]),
    occurredAt: 1000, evaluator: Object.freeze({ id: 'assistant-delivery-owner-feedback', version: '2' }) })
  const base = { triggerOutcomeId: 'owner-feedback', scope, scopeKey: JSON.stringify([scope.workspace, scope.preset]),
    scopeWatermark: 1, situation: 'owner-feedback', objective,
    projection: { subjectKind, subjectRef: 'subject', version: 1, disposition,
      ...(disposition === 'upsert' ? { evidenceOutcomeId: objective.outcomeId } : {}) } }
  const receipt: TrustedTaskLearningProjectionReceipt = Object.freeze({ ...base,
    projection: Object.freeze({ ...base.projection, digest: evaluationLearningProjectionDigest(base) }) })
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('assistantPolicy' as never, {} as never)
  ctx.provide('assistantEvaluation' as never, { getTrustedTaskLearningProjection: () => receipt } as never)
  const service = new AssistantEvolutionService(ctx, { databasePath: join(root, 'evolution.sqlite'), reconcileIntervalMs: 0 })
  return { service, scope: canonicalEvolutionHostScope(scope) }
}

test.each(['upsert', 'retract'] as const)('does not project or learn a work-item %s receipt', async disposition => {
  const { service, scope } = await fixture('work-item', disposition)
  const before = service.health()
  expect(() => service.projectTrustedEvaluationTaskRevision({ scope, evaluationId: 'owner-feedback' }))
    .toThrow(/mismatched trusted receipt/)
  expect(() => service.projectEvaluationOutcome({ scope, evaluationId: 'owner-feedback' }))
    .toThrow(/mismatched trusted receipt/)
  expect(service.health()).toEqual(before)
})

test('continues to project an independently supported foreground-turn receipt', async () => {
  const { service, scope } = await fixture('foreground-turn', 'upsert')
  expect(service.projectTrustedEvaluationTaskRevision({ scope, evaluationId: 'owner-feedback' }))
    .toMatchObject({ subjectKind: 'foreground-turn', disposition: 'upsert', status: 'applied' })
  expect(service.projectEvaluationOutcome({ scope, evaluationId: 'owner-feedback' }))
    .toMatchObject({ source: 'evaluation', learningEligible: true, outcome: 'succeeded' })
})
