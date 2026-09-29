import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import { externalPrincipalId, ownerRouteAuthorityHash } from '@dsh-enhanced/assistant-delivery'
import type { OwnerForegroundTaskSourceContent, OwnerForegroundTaskSourceScope } from '@dsh-enhanced/assistant-delivery'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { EvaluationStore, type EvaluationScope } from '@dsh-enhanced/assistant-evaluation'
import { afterEach, expect, test, vi } from 'vitest'
import { MemoryReviewRuntime } from '../src/memory-review.ts'
import { SourceReviewStore } from '../src/source-review-store.ts'
import { runNativeMemoryReview } from '../src/memory-review-native.ts'

vi.mock('../src/memory-review-native.ts', () => ({ runNativeMemoryReview: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

test('holds real Delivery and Evaluation writer locks through review admission and approval, including an empty canonical scope', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'memory-review-fences-')))
  const deliveryPath = join(root, 'delivery.sqlite'), evaluationPath = join(root, 'evaluation.sqlite')
  const delivery = new DeliveryStore({ path: deliveryPath, codeGenerator: () => 'PAIR1234' })
  const evaluation = new EvaluationStore({ path: evaluationPath })
  const otherDelivery = new DatabaseSync(deliveryPath), otherEvaluation = new DatabaseSync(evaluationPath)
  otherDelivery.exec('PRAGMA busy_timeout=1'); otherEvaluation.exec('PRAGMA busy_timeout=1')
  let runtime: MemoryReviewRuntime | undefined
  try {
    const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
    const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'owner-chat' }
    const authority = { id: 'ordinary-owner', principal, conversation, workspace: root,
      agentPreset: 'assistant', policyRef: 'owner-dm', minimumGeneration: 1 }
    const pairing = delivery.issuePairing(principal, { ttlMs: 5000, maxAttempts: 3 })
    delivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const principalRow = delivery.getPrincipal(principal)!
    const owner = { authorityId: authority.id, authorityHash: ownerRouteAuthorityHash(authority),
      principalId: externalPrincipalId(principal), principalRecordId: principalRow.id, principalVersion: principalRow.version,
      workspace: root, agentPreset: authority.agentPreset }
    const binding = delivery.createBinding({ principal, conversation, workspace: root,
      agentPreset: authority.agentPreset, policyRef: authority.policyRef, sessionId: 'owner-session' })
    const lineage = { principalRecordId: principalRow.id, principalVersion: principalRow.version }
    const admitted = delivery.claimNativeInbox({ envelope: { channel: 'lark', account: 'bot', eventId: 'event',
      occurredAt: Date.now(), principal, conversation, kind: 'text', text: 'This project uses pnpm.' },
    binding, ownerLineage: lineage, ownerId: 'native-worker', leaseMs: 100_000 })
    delivery.bindForegroundTaskExecution({ inboxId: admitted.record.id, scope: { workspace: root, preset: authority.agentPreset },
      owner: lineage, binding, dispatchedAt: Date.now() })
    delivery.recordForegroundExecutionModelSelection({ inboxId: admitted.record.id, provider: 'supplier', model: 'task-model' })
    delivery.enqueue({ idempotencyKey: `inbound:${admitted.record.id}:reply`, bindingId: binding.id,
      target: { principal, conversation }, text: 'Acknowledged.', format: 'plain', replyToEventId: 'event' })
    delivery.finishForegroundTaskExecution({ inboxId: admitted.record.id, status: 'succeeded', quiescent: true, completedAt: Date.now() })
    const scope: OwnerForegroundTaskSourceScope = { authorityId: authority.id, principalId: owner.principalId,
      workspace: root, agentPreset: authority.agentPreset, expectedOwner: { ...lineage, authorityHash: owner.authorityHash } }
    const source = delivery.listOwnerForegroundTaskSources(scope, authority).items[0]!
    const sourceInput = { ...scope, inboxId: source.inboxId, expectedSourceDigest: source.sourceDigest }
    const content = delivery.readOwnerForegroundTaskSource(sourceInput, authority)!
    const request: MemoryLearningReviewRequest = { protocol: 'memory-learning-review/v1', operationId: 'review:1',
      extractionSessionId: 'extract:1', owner,
      source: { inboxId: source.inboxId, sourceDigest: source.sourceDigest, contentDigest: content.contentDigest },
      mutation: { op: 'add', entry: { kind: 'fact', content: 'The owner says this project uses pnpm.' } },
      evidenceQuote: 'This project uses pnpm.' }
    const services: Record<string, unknown> = {
      assistantDelivery: {
        inspectOwnerForegroundLearningTask: () => undefined,
        readOwnerForegroundTaskSource: (input: typeof sourceInput) => delivery.readOwnerForegroundTaskSource(input, authority),
        withOwnerForegroundTaskSourceFence: <T>(input: typeof sourceInput, callback: (source: Readonly<OwnerForegroundTaskSourceContent>) => T) =>
          delivery.withOwnerForegroundTaskSourceFence(input, authority, callback),
      },
      assistantEvaluation: {
        inspectTrustedTaskOwnerRevision: () => undefined,
        canonicalHostScope: (scope: EvaluationScope) => scope,
        getTrustedForegroundLearningProjection: (input: { scope: EvaluationScope; inboxId: string }) => evaluation.getForegroundLearningProjection(input.scope, input.inboxId),
        listTrustedTaskLearningProjections: (input: { scope: EvaluationScope; limit: number }) => evaluation.listTaskLearningProjectionFeed(input.scope, undefined, input.limit),
        withTrustedCanonicalScopeWriterFence: <T>(input: { scope: EvaluationScope; scopeWatermark: number }, callback: () => T) =>
          evaluation.withCanonicalScopeWriterFence(input.scope, { scopeWatermark: input.scopeWatermark }, callback),
      },
      assistantPolicy: { evaluate: () => ({ effect: 'allow' }), authorize: () => ({ effect: 'allow' }) },
    }
    runtime = new MemoryReviewRuntime({ get: (name: string) => services[name] } as unknown as Context,
      { authorityId: 'review-grant', owner, expiresAt: Date.now() + 60_000, maxReviews: 1,
        policy: 'Preserve attributed owner statements.', maxInputBytes: 32768, maxOutputTokens: 512, timeoutMs: 10_000 },
      join(root, 'verifier.sqlite'))
    const locked = () => {
      // Even the first competing write to an empty canonical scope must wait.
      expect(() => otherDelivery.exec('BEGIN IMMEDIATE')).toThrow(/locked/u)
      expect(() => otherEvaluation.exec('BEGIN IMMEDIATE')).toThrow(/locked/u)
    }
    const claim = SourceReviewStore.prototype.claim, finish = SourceReviewStore.prototype.finish
    const admission = vi.spyOn(SourceReviewStore.prototype, 'claim').mockImplementation(function (this: SourceReviewStore, input) {
      locked(); return claim.call(this, input)
    })
    const completion = vi.spyOn(SourceReviewStore.prototype, 'finish').mockImplementation(function (this: SourceReviewStore, ...args) {
      locked(); return finish.apply(this, args)
    })
    vi.mocked(runNativeMemoryReview).mockResolvedValue({ status: 'approved', reason: 'Explicit owner statement.', outputDigest: 'e'.repeat(64) })
    expect((await runtime.run(request)).status).toBe('approved')
    expect(admission).toHaveBeenCalledTimes(1); expect(completion).toHaveBeenCalledTimes(1)
    expect(runtime.lookup(request)?.status).toBe('approved')
    otherDelivery.exec('BEGIN IMMEDIATE; ROLLBACK')
    otherEvaluation.exec('BEGIN IMMEDIATE; ROLLBACK')
  } finally {
    await runtime?.close()
    otherDelivery.close(); otherEvaluation.close(); delivery.close(); evaluation.close()
    await rm(root, { recursive: true, force: true })
  }
})
