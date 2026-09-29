import { describe, expect, it } from 'vitest'
import {
  memoryLearningRequestDigest, validateMemoryLearningProposal, validateMemoryLearningReviewRequest,
  type MemoryLearningReviewRequest,
} from '../src/memory-learning.js'

function request(): MemoryLearningReviewRequest {
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
