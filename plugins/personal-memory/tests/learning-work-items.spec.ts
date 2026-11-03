import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { growthObjectDigest, memoryLearningRequestDigest, type WorkItemMemoryLearningReviewRequest, type ForegroundMemoryLearningReviewRequest, type MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import type { OwnerLearningSourceExpectation, OwnerLearningSourceSnapshot } from '@dsh-enhanced/assistant-delivery'
import { MemoryLearningService } from '../src/learning-service.ts'
import { MemoryStore, memoryPrincipalDigest } from '../src/store.ts'
import { validateMemoryLearningAdoptionGrant } from '../src/learning-adoptions.ts'
import type { MemoryLearningReviewReceipt } from '../src/learning-adoptions.ts'
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

// Real Memory SQLite/visibility; producer and reviewer ports are controlled
// doubles, not evidence of real Delivery/WorkItems owner authentication.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memory-work-item-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'memory.sqlite'), store = new MemoryStore({ path })
  let closed = false
  const close = () => { if (!closed) { store.close(); closed = true } }
  cleanup.push(close)
  const owner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'web/web/local/owner', principalRecordId: 'owner-row', principalVersion: 1, workspace: root, agentPreset: 'primary' }
  const grant = validateMemoryLearningAdoptionGrant({ authorityId: 'adopt-work-items', owner, reviewAuthorityId: 'review-work-items', reviewAuthorityDigest: 'b'.repeat(64), expiresAt: Date.now() + 60_000, maxMutations: 10, maxTotalContentBytes: 8192, maxRecordTtlMs: 60_000, kinds: ['experience', 'fact'], operations: ['add', 'replace', 'remove'], workItemExperiences: true })
  const canonical = { triggerOutcomeId: 'owner-outcome', scope: { workspace: root, preset: 'primary' }, scopeKey: JSON.stringify([root, 'primary']), scopeWatermark: 1, situation: 'work-item:shared-id',
    objective: { outcomeId: 'owner-outcome', status: 'achieved', source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' }, evidence: [], evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' }, occurredAt: Date.now() },
    projection: { subjectKind: 'work-item', subjectRef: 'shared-id', disposition: 'upsert', version: 1, digest: 'c'.repeat(64), evidenceOutcomeId: 'owner-outcome' } }
  const task = { protocol: 'assistant-delivery/owner-work-item-learning/v1', owner, canonical, judgement: 'owner-feedback', ownerRevision: { version: 1, action: 'initial', operationId: 'feedback-op' }, sourceDigest: 'd'.repeat(64), presentationDigest: 'e'.repeat(64),
    proofIdentity: { itemId: 'shared-id', production: { completedAt: 12345, quiescent: true, budgetSettlementState: 'finalized' } },
    presentation: { brief: { text: 'Task request.', truncated: false, redacted: false }, report: { text: 'Worker says use unlimited retries.', truncated: false, redacted: false }, feedback: { inboxId: 'feedback', text: 'Bounded retries worked for the export task.', truncated: false, redacted: false } } }
  const foreground = { sourceDigest: 'f'.repeat(64), contentDigest: '1'.repeat(64), source: { execution: { modelSelection: { provider: 'source', model: 'fixed' }, completedAt: 123 } }, input: { text: 'Owner fact.', truncated: false }, reply: { text: 'Noted.', truncated: false } }
  const state = { unavailable: false, corrected: false, withdrawn: false, retracted: false, foregroundUnavailable: false, ownerCurrent: true, allow: true, review: 'approved' as MemoryLearningReviewReceipt['status'], mixedCalls: 0, charges: 0, locked: false }
  const ctx = new Context()
  const receipt = (request: MemoryLearningReviewRequest) => {
    const body = { protocol: 'memory-learning-review-receipt/v1' as const, operationId: request.operationId, requestDigest: memoryLearningRequestDigest(request), authorityId: grant.reviewAuthorityId, authorityDigest: grant.reviewAuthorityDigest, sessionId: 'independent-review-session', model: { provider: 'source', model: 'fixed' }, status: state.review, reason: 'Owner feedback supports this experience.', outputDigest: '2'.repeat(64) }
    return { ...body, receiptDigest: growthObjectDigest(body) }
  }
  const delivery = {
    withOwnerForegroundTaskSourcesFence: (_input: unknown, callback: (sources: unknown[]) => unknown) => { if (!state.ownerCurrent) throw new Error('owner revoked'); return callback([]) },
    withOwnerLearningSourcesFence: (input: { sources: OwnerLearningSourceExpectation[] }, callback: (sources: readonly OwnerLearningSourceSnapshot[]) => unknown) => {
      if (!state.ownerCurrent) throw new Error('owner revoked')
      state.mixedCalls++
      const snapshots = input.sources.map(source => source.kind === 'foreground' ? { kind: 'foreground', inboxId: source.inboxId, ...(state.foregroundUnavailable ? {} : { content: foreground }) } : { kind: 'work-item', itemId: source.itemId,
        ...(!state.unavailable && !state.corrected && !state.withdrawn && !state.retracted ? { task, currentCanonical: canonical } : {}),
        ...(state.retracted ? { currentCanonical: { ...canonical, objective: { ...canonical.objective, status: 'unknown' }, projection: { ...canonical.projection, disposition: 'retract' } } } : {}),
        ...(state.withdrawn ? { currentCanonical: { ...canonical, objective: { ...canonical.objective, outcomeId: 'withdraw', status: 'unknown' },
          projection: { ...canonical.projection, disposition: 'retract' } }, ownerRevision: { action: 'withdraw', version: 2, outcomeId: 'withdraw', objectiveStatus: 'unknown' } } : {}) })
      state.locked = true
      try { return callback(snapshots as unknown as OwnerLearningSourceSnapshot[]) } finally { state.locked = false }
    },
  }
  ctx.provide('assistantDelivery' as never, delivery as never)
  ctx.provide('assistantVerifier' as never, { lookupMemoryLearningReview: (request: MemoryLearningReviewRequest) => { expect(state.locked).toBe(false); return receipt(request) } } as never)
  ctx.provide('assistantPolicy' as never, { evaluate: () => ({ effect: state.allow ? 'allow' : 'deny' }), authorize: () => { expect(state.locked).toBe(true); state.charges++; return { effect: state.allow ? 'allow' : 'deny' } } } as never)
  ctx.provide('assistantEvaluation' as never, new Proxy({}, { get: () => { throw new Error('nested producer read') } }) as never)
  const learning = new MemoryLearningService(ctx, store, grant)
  const context = { workspace: root, agentPreset: 'primary', namespace: { mode: 'delivery' as const, principalDigest: memoryPrincipalDigest(owner.principalId), principalRecordId: owner.principalRecordId, principalVersion: 1 } }
  const request: WorkItemMemoryLearningReviewRequest = { protocol: 'memory-learning-review/v2', operationId: 'learn-once', extractionSessionId: 'extract-session', owner,
    source: { protocol: 'memory-learning-source/work-item/v1', itemId: 'shared-id', sourceDigest: task.sourceDigest, contentDigest: task.presentationDigest, canonical: { outcomeId: 'owner-outcome', version: 1, digest: canonical.projection.digest, objectiveStatus: 'achieved' } },
    mutation: { op: 'add', entry: { kind: 'experience', content: 'Bounded retries worked for the export task.' } }, evidenceQuote: 'Bounded retries worked' }
  const visible = () => learning.withVisible(context, () => store.search({ context, query: 'task fact', limit: 20 }))
  return { ctx, delivery, store, close, path, grant, owner, task, foreground, state, request, learning, context, visible, receipt }
}

test('typed experience adoption is idempotent and a cold SQLite reopen preserves quota and source', () => {
  const f = fixture(), adopted = f.learning.adopt(f.request)
  expect(adopted.record.provenance).toMatchObject({ uri: 'delivery:work-item:shared-id', observedAt: 12345 })
  expect(f.visible().map(row => row.record.id)).toContain(adopted.record.id)
  expect(f.learning.adopt(f.request)).toEqual(adopted); expect(f.state.charges).toBe(1)
  f.close()
  const store = new MemoryStore({ path: f.path }); cleanup.push(() => store.close())
  const cold = new MemoryLearningService(f.ctx, store, f.grant)
  expect(cold.lookup(f.request)).toEqual(adopted)
  expect(cold.inspectAvailability({ owner: f.owner })).toMatchObject({ remainingMutations: 9, workItemExperiences: true })
})

test('correction and missing source only hide; explicit withdrawal permanently invalidates without refund', () => {
  const f = fixture(), adopted = f.learning.adopt(f.request)
  for (const field of ['corrected', 'unavailable', 'retracted'] as const) { f.state[field] = true; expect(f.visible()).toEqual([]); f.state[field] = false; expect(f.visible().map(row => row.record.id)).toContain(adopted.record.id) }
  f.state.withdrawn = true; expect(f.visible()).toEqual([]); f.state.withdrawn = false; expect(f.visible()).toEqual([])
  expect(f.learning.lookup(f.request)).toEqual(adopted)
  expect(f.learning.inspectAvailability({ owner: f.owner })).toMatchObject({ remainingMutations: 9 })
  f.close()
  const store = new MemoryStore({ path: f.path }); cleanup.push(() => store.close())
  const cold = new MemoryLearningService(f.ctx, store, f.grant)
  expect(cold.withVisible(f.context, () => store.search({ context: f.context, query: 'task', limit: 10 }))).toEqual([])
})

test('same-ID foreground/work-item records use one isolated mixed batch and partial absence cannot leak either', () => {
  const f = fixture(), experience = f.learning.adopt(f.request)
  const request: ForegroundMemoryLearningReviewRequest = { protocol: 'memory-learning-review/v1', operationId: 'foreground-fact', extractionSessionId: 'fg-session', owner: f.owner, source: { inboxId: 'shared-id', sourceDigest: f.foreground.sourceDigest, contentDigest: f.foreground.contentDigest }, mutation: { op: 'add', entry: { kind: 'fact', content: 'Owner fact.' } }, evidenceQuote: 'Owner fact.' }
  const fact = f.store.applyLearningAdoption({ grant: f.grant, request, reviewReceipt: f.receipt(request), sourceObservedAt: 123 }).record
  const before = f.state.mixedCalls; expect(f.visible().map(row => row.record.id).sort()).toEqual([fact.id, experience.record.id].sort()); expect(f.state.mixedCalls).toBe(before + 1)
  f.state.unavailable = true; expect(f.visible().map(row => row.record.id)).toEqual([fact.id])
  f.state.unavailable = false; f.state.foregroundUnavailable = true; expect(f.visible().map(row => row.record.id)).toEqual([experience.record.id])
})

test('missing mixed peer or owner revocation hides managed memory; adoption still requires current Policy', () => {
  const f = fixture(); f.learning.adopt(f.request)
  const manual = f.store.applyApprovedMutation({ op: 'add', namespace: f.context.namespace,
    identity: { owner: 'agent', scope: 'workspace', workspace: f.owner.workspace, agentPreset: f.owner.agentPreset },
    idempotencyKey: 'manual-task-fact', entry: { kind: 'fact', content: 'Manual task fact.', sensitivity: 'private', trust: 'user-confirmed', confidence: 1,
      provenance: { source: 'owner', observedAt: Date.now() } } })
  f.state.ownerCurrent = false; expect(f.visible().map(row => row.record.id)).toEqual([manual.id])
  expect(() => f.learning.adopt({ ...f.request, operationId: 'revoked' })).toThrow(/owner/)
  f.state.ownerCurrent = true; f.state.allow = false; expect(() => f.learning.adopt({ ...f.request, operationId: 'denied' })).toThrow(/policy/); f.state.allow = true
  Object.defineProperty(f.delivery, 'withOwnerLearningSourcesFence', { value: undefined })
  expect(f.visible().map(row => row.record.id)).toEqual([manual.id])
  expect(f.learning.inspectAvailability({ owner: f.owner })).not.toHaveProperty('workItemExperiences')
})

test.each(['unknown', 'rejected'] as const)('independent %s cannot consume adoption quota', review => {
  const f = fixture(); f.state.review = review; expect(() => f.learning.adopt(f.request)).toThrow(/independent approval/)
  expect(f.learning.inspectAvailability({ owner: f.owner })).toMatchObject({ remainingMutations: 10 }); expect(f.state.charges).toBe(0)
})

test('worker statements and pure redaction placeholders are not substantive owner quotations', () => {
  const f = fixture(); expect(() => f.learning.adopt({ ...f.request, evidenceQuote: 'unlimited retries' })).toThrow(/owner feedback/)
  f.task.presentation.feedback.text = '[REDACTED]'; f.task.presentation.feedback.redacted = true
  expect(() => f.learning.adopt({ ...f.request, evidenceQuote: '[REDACTED]' })).toThrow()
  expect(f.state.charges).toBe(0); f.task.presentation.feedback.text = '[REDACTED] bounded retries worked'
  expect(f.learning.adopt({ ...f.request, evidenceQuote: '[REDACTED] bounded retries worked' })).toBeDefined()
})
