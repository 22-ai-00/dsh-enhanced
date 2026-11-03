import { describe, expect, it } from 'vitest'
import {
  memoryLearningRequestDigest, validateMemoryLearningProposal, validateMemoryLearningReviewRequest, hasWorkItemLearningFeedbackText,
  type MemoryLearningReviewRequest, type ForegroundMemoryLearningReviewRequest, type WorkItemMemoryLearningReviewRequest,
} from '../src/memory-learning.js'

function request(): ForegroundMemoryLearningReviewRequest {
  return {
    protocol: 'memory-learning-review/v1', operationId: 'learning:1', extractionSessionId: 'extract:1',
    owner: { authorityId: 'owner:1', authorityHash: 'a'.repeat(64), principalId: 'lark/app/tenant/owner',
      principalRecordId: 'principal:1', principalVersion: 1, workspace: '/workspace/project', agentPreset: 'assistant' },
    source: { inboxId: 'inbox:1', sourceDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) },
    mutation: { op: 'add', entry: { kind: 'fact', content: 'The owner says the project uses pnpm.',
      knowledge: { claim: { key: 'project.package-manager', value: 'pnpm' } } } },
    evidenceQuote: '这个项目使用 pnpm。',
  }
}

describe('ordinary memory learning wire boundary', () => {
  it('preserves the pre-work-item v1 wire bytes and digest', () => {
    const original = request()
    expect(JSON.stringify(validateMemoryLearningReviewRequest(original))).toBe(JSON.stringify(original))
    // Captured from the previously built v1 contract before compiling this change.
    expect(memoryLearningRequestDigest(original)).toBe('8ff7c29ff6c6122812b4a33fe88a1b1fb1bf937c72bcc50b29bb9098a8641636')
  })
  it('binds the owner lineage, original source, exact candidate and extraction session independently of key order', () => {
    const original = request(), digest = memoryLearningRequestDigest(original)
    expect(memoryLearningRequestDigest(Object.fromEntries(Object.entries(original).reverse()) as MemoryLearningReviewRequest)).toBe(digest)
    for (const change of [
      (item: MemoryLearningReviewRequest) => { item.owner.principalVersion++ },
      (item: MemoryLearningReviewRequest) => { item.source.contentDigest = 'd'.repeat(64) },
      (item: MemoryLearningReviewRequest) => { item.evidenceQuote = 'another quotation' },
      (item: MemoryLearningReviewRequest) => { item.extractionSessionId = 'extract:2' },
    ]) {
      const changed = structuredClone(original); change(changed)
      expect(memoryLearningRequestDigest(changed)).not.toBe(digest)
    }
    const copy = validateMemoryLearningReviewRequest(original)
    copy.owner.principalVersion++
    expect(original.owner.principalVersion).toBe(1)
  })

  it('does not permit a model to set ownership, provenance, trust, authorization or TTL', () => {
    const original = request()
    for (const field of ['owner', 'source', 'authorityId', 'approved', 'namespace']) {
      expect(() => validateMemoryLearningProposal({ mutation: original.mutation, evidenceQuote: original.evidenceQuote,
        [field]: 'model-selected' })).toThrow()
    }
    if (original.mutation.op !== 'add') throw new Error('fixture')
    const entry = original.mutation.entry
    for (const field of ['trust', 'confidence', 'provenance', 'sensitivity', 'expiresAt', 'supersedes']) {
      expect(() => validateMemoryLearningProposal({ mutation: { op: 'add', entry: {
        ...entry, [field]: 'model-selected',
      } }, evidenceQuote: original.evidenceQuote })).toThrow()
    }
  })

  it('requires a current outcome locator for experiences, including explicitly unsuccessful tasks', () => {
    const input = request()
    input.mutation = { op: 'add', entry: { kind: 'experience', content: 'Avoid retrying an unknown external operation.' } }
    expect(() => validateMemoryLearningReviewRequest(input)).toThrow('experience without outcome')
    input.source.canonical = { outcomeId: 'outcome:1', version: 2, digest: 'd'.repeat(64), objectiveStatus: 'not-achieved' }
    expect(validateMemoryLearningReviewRequest(input).source.canonical?.objectiveStatus).toBe('not-achieved')
    expect(() => validateMemoryLearningReviewRequest({ ...input, source: { ...input.source,
      canonical: { ...input.source.canonical, objectiveStatus: 'unknown' },
    } })).toThrow('objective status')
  })

  it('requires exact record versions for correction and removal and rejects accidental normalization', () => {
    const input = request()
    input.mutation = { op: 'remove', id: 'memory:1', expectedVersion: 2 }
    expect(validateMemoryLearningReviewRequest(input).mutation).toEqual(input.mutation)
    expect(() => validateMemoryLearningReviewRequest({ ...input, mutation: { ...input.mutation, expectedVersion: 0 } })).toThrow()
    expect(() => validateMemoryLearningReviewRequest({ ...input, mutation: { ...input.mutation, entry: { kind: 'fact', content: 'x' } } })).toThrow()
    for (const content of [' fact ', 'e\u0301', '\ud800', '记'.repeat(1366)]) {
      expect(() => validateMemoryLearningProposal({ mutation: { op: 'add', entry: { kind: 'fact', content } }, evidenceQuote: 'exact' })).toThrow()
    }
    expect(validateMemoryLearningProposal({ mutation: { op: 'add', entry: { kind: 'fact', content: '事实' } },
      evidenceQuote: '  exact source whitespace\n' }).evidenceQuote).toBe('  exact source whitespace\n')
  })

  it('rejects getters and non-JSON fields before invoking candidate-owned code', () => {
    let invoked = false
    const item = request()
    Object.defineProperty(item, 'evidenceQuote', { enumerable: true, get: () => { invoked = true; return 'forged' } })
    expect(() => validateMemoryLearningReviewRequest(item)).toThrow()
    expect(invoked).toBe(false)
    const hidden = request()
    Object.defineProperty(hidden, 'grant', { value: 'forged', enumerable: false })
    expect(() => validateMemoryLearningReviewRequest(hidden)).toThrow()
    expect(() => validateMemoryLearningReviewRequest({ ...request(), [Symbol('authority')]: true })).toThrow()
    const list: string[] = []
    Object.defineProperty(list, '0', { enumerable: true, get: () => { invoked = true; return 'forged' } })
    expect(() => validateMemoryLearningProposal({ mutation: { op: 'add', entry: {
      kind: 'fact', content: 'fact', knowledge: { applicability: list },
    } }, evidenceQuote: 'original' })).toThrow()
    expect(invoked).toBe(false)
    const hiddenList: string[] = []
    Object.defineProperty(hiddenList, '0', { enumerable: false, value: 'hidden condition' })
    expect(() => validateMemoryLearningProposal({ mutation: { op: 'add', entry: {
      kind: 'fact', content: 'fact', knowledge: { applicability: hiddenList },
    } }, evidenceQuote: 'original' })).toThrow()
  })
})

function workItemRequest(): WorkItemMemoryLearningReviewRequest {
  return {
    ...request(), protocol: 'memory-learning-review/v2',
    source: { protocol: 'memory-learning-source/work-item/v1', itemId: 'work-item:1',
      sourceDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64),
      canonical: { outcomeId: 'outcome:owner-feedback', version: 2, digest: 'd'.repeat(64), objectiveStatus: 'not-achieved' } },
    mutation: { op: 'add', entry: { kind: 'experience', content: 'This reported attempt did not satisfy the owner.' } },
    evidenceQuote: '还是不行',
  }
}

describe('background memory learning wire boundary', () => {
  it('accepts visible testimony in a redacted source but not a placeholder as testimony', () => {
    for (const quote of ['[REDACTED]', '[REDACTED PRIVATE KEY]', '“[REDACTED]”，[REDACTED PRIVATE KEY]。', '🔒\u200b']) {
      expect(hasWorkItemLearningFeedbackText(quote)).toBe(false)
      expect(() => validateMemoryLearningReviewRequest({ ...workItemRequest(), evidenceQuote: quote })).toThrow('work-item feedback quotation')
    }
    for (const quote of ['仍未解决，[REDACTED] 的配置失败', 'Visible failure after [REDACTED PRIVATE KEY]', '2 retries failed']) {
      expect(hasWorkItemLearningFeedbackText(quote)).toBe(true)
      expect(validateMemoryLearningReviewRequest({ ...workItemRequest(), evidenceQuote: quote }).evidenceQuote).toBe(quote)
    }
  })
  it('keeps the background task locator separate and binds the exact feedback revision and presentation', () => {
    const original = workItemRequest(), before = memoryLearningRequestDigest(original)
    expect(validateMemoryLearningReviewRequest(original)).toEqual(original)
    expect(original.source).not.toHaveProperty('inboxId')
    for (const change of [
      (r: WorkItemMemoryLearningReviewRequest) => { r.source.itemId = 'work-item:2' },
      (r: WorkItemMemoryLearningReviewRequest) => { r.source.sourceDigest = 'e'.repeat(64) },
      (r: WorkItemMemoryLearningReviewRequest) => { r.source.contentDigest = 'f'.repeat(64) },
      (r: WorkItemMemoryLearningReviewRequest) => { r.source.canonical.version++ },
      (r: WorkItemMemoryLearningReviewRequest) => { r.source.canonical.outcomeId = 'outcome:correction' },
      (r: WorkItemMemoryLearningReviewRequest) => { r.source.canonical.objectiveStatus = 'achieved' },
    ]) {
      const copy = structuredClone(original); change(copy)
      expect(memoryLearningRequestDigest(copy)).not.toBe(before)
    }
  })

  it('rejects cross-protocol sources and a forged foreground Inbox on a background source', () => {
    const original = workItemRequest()
    for (const forged of [
      { ...original, source: request().source },
      { ...original, source: { ...original.source, inboxId: 'inbox:1' } },
      { ...request(), source: original.source },
      { ...original, source: { ...original.source, protocol: 'memory-learning-source/work-item/v2' } },
    ]) expect(() => validateMemoryLearningReviewRequest(forged)).toThrow()
  })

  it('requires an explicit current objective even for removal, never a worker settlement alone', () => {
    const original = workItemRequest()
    const { canonical: _canonical, ...withoutCanonical } = original.source
    for (const mutation of [original.mutation, { op: 'remove', id: 'memory:1', expectedVersion: 1 }]) {
      expect(() => validateMemoryLearningReviewRequest({ ...original, mutation, source: withoutCanonical })).toThrow()
      expect(() => validateMemoryLearningReviewRequest({ ...original, mutation, source: { ...original.source,
        canonical: { ...original.source.canonical, objectiveStatus: 'unknown' } } })).toThrow('objective status')
    }
  })

  it('does not turn a worker brief or report into an owner fact by adding or replacing a memory', () => {
    const original = workItemRequest()
    for (const mutation of [
      { op: 'add', entry: { kind: 'fact', content: 'The worker claimed this was true.' } },
      { op: 'replace', id: 'memory:1', expectedVersion: 1, entry: { kind: 'fact', content: 'The worker claimed this was true.' } },
    ]) expect(() => validateMemoryLearningReviewRequest({ ...original, mutation })).toThrow('work-item experience only')
    // Actual target kind and current owner are independently re-read by each consumer.
    expect(validateMemoryLearningReviewRequest({ ...original, mutation: { op: 'remove', id: 'memory:1', expectedVersion: 2 } }).mutation.op).toBe('remove')
  })

  it('rejects hidden fields and canonical getters before executing producer-controlled code', () => {
    let invoked = false
    const accessor = workItemRequest()
    Object.defineProperty(accessor.source.canonical, 'version', { enumerable: true, get: () => { invoked = true; return 2 } })
    expect(() => validateMemoryLearningReviewRequest(accessor)).toThrow()
    expect(invoked).toBe(false)
    const hidden = workItemRequest()
    Object.defineProperty(hidden.source, 'inboxId', { value: 'forged', enumerable: false })
    expect(() => validateMemoryLearningReviewRequest(hidden)).toThrow()
  })
})
