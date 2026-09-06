import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { describe, expect, it } from 'vitest'
import {
  developmentCases, developmentCorpus, developmentDataset, developmentPrompt, judgeDevelopmentResponse,
} from '../../src/benchmark/corpus.ts'

describe('public development corpus', () => {
  it('contains eight frozen, synthetic public tasks with independently bound inputs', () => {
    expect(developmentCorpus).toHaveLength(8)
    expect(developmentCorpus.filter(task => task.domain === 'research')).toHaveLength(4)
    expect(developmentCorpus.filter(task => task.domain === 'injection')).toHaveLength(4)
    expect(Object.isFrozen(developmentCorpus)).toBe(true)
    expect(Object.isFrozen(developmentCorpus[0]!.sources)).toBe(true)
    expect(developmentDataset).toEqual({
      id: 'dsh-research-grounding', version: '1', split: 'development', digest: acceptanceDigest(developmentCorpus),
    })
    const cases = developmentCases()
    expect(new Set(cases.map(task => task.inputDigest)).size).toBe(8)
    expect(cases.map(task => task.acceptanceDigest)).toEqual(developmentCorpus.map(task => acceptanceDigest(task.acceptance)))
    expect(cases).not.toBe(developmentCases())
    expect(Object.isFrozen(cases)).toBe(true)
  })

  it('prompts include every input but never serialize the oracle', () => {
    for (const task of developmentCorpus) {
      const prompt = developmentPrompt(task.id)
      expect(prompt).toContain(task.objective)
      for (const item of task.sources) { expect(prompt).toContain(item.id); expect(prompt).toContain(item.text) }
      expect(prompt).not.toContain('"acceptance"')
      expect(prompt).not.toContain(acceptanceCanonicalJson(task.acceptance))
    }
    expect(() => developmentPrompt('missing')).toThrow('unknown development case')
  })

  it('achieves only specified answers and exact source sets', () => {
    for (const task of developmentCorpus) {
      const output = JSON.stringify({ answer: task.acceptance.answer, citations: [...task.acceptance.citations].reverse() })
      expect(judgeDevelopmentResponse(task.id, output).verdict).toBe('achieved')
    }
    expect(judgeDevelopmentResponse('calculate-reagent-mass', JSON.stringify({ answer: 46.5, citations: ['recipe', 'stock', 'unit-note'] })).verdict).toBe('not-achieved')
    expect(judgeDevelopmentResponse('injection-fabricated-citation-bait', JSON.stringify({ answer: 640, citations: ['purchase-order', 'approval-rule', 'finance-seal'] })).verdict).toBe('not-achieved')
    expect(judgeDevelopmentResponse('injection-fake-system-role', JSON.stringify({ answer: '豁免', citations: ['sample-k', 'quality-range'] })).verdict).toBe('not-achieved')
    expect(judgeDevelopmentResponse('injection-ignore-original-task', JSON.stringify({ answer: '已接管', citations: [] })).verdict).toBe('not-achieved')
  })

  it('rejects malformed, oversized, duplicate, and extra-field replies', () => {
    const task = developmentCorpus[0]!
    const expected = JSON.stringify({ answer: task.acceptance.answer, citations: task.acceptance.citations })
    expect(judgeDevelopmentResponse(task.id, '```json\n' + expected + '\n```').verdict).toBe('not-achieved')
    expect(judgeDevelopmentResponse(task.id, JSON.stringify({ answer: task.acceptance.answer, citations: [task.acceptance.citations[0], task.acceptance.citations[0]] })).verdict).toBe('not-achieved')
    expect(judgeDevelopmentResponse(task.id, JSON.stringify({ answer: task.acceptance.answer, citations: task.acceptance.citations, extra: true })).verdict).toBe('not-achieved')
    expect(judgeDevelopmentResponse(task.id, ' '.repeat(64 * 1024 + 1)).verdict).toBe('not-achieved')
    expect(() => judgeDevelopmentResponse('missing', expected)).toThrow('unknown development case')
  })

  it('binds evidence to the corpus-derived hashes, output, and verdict', () => {
    const task = developmentCorpus[1]!
    const good = JSON.stringify({ answer: task.acceptance.answer, citations: task.acceptance.citations })
    const changed = JSON.stringify({ answer: 0, citations: task.acceptance.citations })
    const goodResult = judgeDevelopmentResponse(task.id, good)
    expect(goodResult.evidenceDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(judgeDevelopmentResponse(task.id, good).evidenceDigest).toBe(goodResult.evidenceDigest)
    expect(judgeDevelopmentResponse(task.id, changed).evidenceDigest).not.toBe(goodResult.evidenceDigest)
    expect(developmentCases()[1]!.inputDigest).toBe(acceptanceDigest({ objective: task.objective, sources: task.sources }))
  })
})
