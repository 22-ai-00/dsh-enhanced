import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { describe, expect, it } from 'vitest'
import { developmentCases } from '../../src/benchmark/corpus.ts'
import {
  familiesDevelopmentCases, familiesDevelopmentCorpus, familiesDevelopmentDataset, familiesDevelopmentPrompt, judgeFamiliesDevelopmentResponse,
} from '../../src/benchmark/families-corpus.ts'
import { benchmarkDomains } from '../../src/benchmark/types.ts'

describe('public task-family development corpus (families-v1)', () => {
  it('covers every benchmark domain with frozen, distinct synthetic tasks', () => {
    expect(new Set(familiesDevelopmentCorpus.map(task => task.domain))).toEqual(new Set(benchmarkDomains))
    expect(familiesDevelopmentCorpus).toHaveLength(9)
    expect(Object.isFrozen(familiesDevelopmentCorpus)).toBe(true)
    expect(familiesDevelopmentDataset).toEqual({ id: 'dsh-task-families', version: '1', split: 'development', digest: acceptanceDigest(familiesDevelopmentCorpus) })
    const cases = familiesDevelopmentCases()
    expect(new Set(cases.map(task => task.inputDigest)).size).toBe(cases.length)
    const research = developmentCases()
    expect(cases.some(task => research.some(other => other.id === task.id || other.inputDigest === task.inputDigest))).toBe(false)
  })

  it('pins the dataset digest so fixture edits require a new version', () => {
    expect(familiesDevelopmentDataset.digest).toMatchInlineSnapshot(`"bb6ad3ada8a4b3acd302e19d274da390afe7e5c05144b6ff1d5381ca9e236e1e"`)
  })

  it('prompts include all sources and never serialize the oracle', () => {
    for (const task of familiesDevelopmentCorpus) {
      const prompt = familiesDevelopmentPrompt(task.id)
      expect(prompt).toContain(task.objective)
      for (const item of task.sources) expect(prompt).toContain(item.text)
      expect(prompt).not.toContain(acceptanceCanonicalJson(task.acceptance))
    }
    expect(() => familiesDevelopmentPrompt('missing')).toThrow('unknown families development case')
  })

  it('judges exact answers and citation sets deterministically', () => {
    for (const task of familiesDevelopmentCorpus) {
      const output = JSON.stringify({ answer: task.acceptance.answer, citations: [...task.acceptance.citations].reverse() })
      const first = judgeFamiliesDevelopmentResponse(task.id, output)
      expect(first.verdict).toBe('achieved')
      expect(judgeFamiliesDevelopmentResponse(task.id, output)).toEqual(first)
    }
    const judge = (id: string, answer: unknown, citations: string[]) => judgeFamiliesDevelopmentResponse(id, JSON.stringify({ answer, citations })).verdict
    expect(judge('code-page-count-off-by-one', [4, 4], ['page-spec', 'page-impl'])).toBe('not-achieved')
    expect(judge('code-page-count-off-by-one', [5, 4], ['page-spec', 'page-impl', 'style-guide'])).toBe('not-achieved')
    expect(judge('duplicate-action-idempotent-refund', 120, ['refund-retry', 'refund-ledger', 'idempotency-rule'])).toBe('not-achieved')
    expect(judge('revocation-withdrawn-deploy-approval', '可部署', ['approval', 'revocation', 'approval-policy'])).toBe('not-achieved')
    expect(judge('goal-change-latest-sort-key', 'cost', ['goal-v1', 'goal-v2', 'goal-rule'])).toBe('not-achieved')
    expect(judge('injection-tool-call-bait', '已清空', [])).toBe('not-achieved')
    expect(judgeFamiliesDevelopmentResponse('cross-day-handoff-next-batch', '5').verdict).toBe('not-achieved')
  })
})
