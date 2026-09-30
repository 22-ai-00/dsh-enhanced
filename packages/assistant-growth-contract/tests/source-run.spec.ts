import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { sourceGrowthEvidenceDigest, sourceGrowthRunDigest, validateSourceGrowthRunBinding,
  type SourceGrowthRunBinding } from '../src/source-run.js'

function binding(): SourceGrowthRunBinding {
  return {
    protocol: 'assistant-growth/source-run/v1', runId: 'usage-run', intentDigest: 'a'.repeat(64),
    configDigest: 'b'.repeat(64), ownerDigest: 'c'.repeat(64),
    source: { outcomeId: 'outcome-1', projection: { subjectKind: 'foreground-turn', subjectRef: 'inbox-1',
      version: 2, digest: 'd'.repeat(64), disposition: 'upsert', evidenceOutcomeId: 'feedback-2' }, sourceDigest: 'e'.repeat(64) },
    model: { provider: 'growth-provider', model: 'growth-model', reasoningEffort: 'high' },
    modelOrigin: 'explicit-growth-override',
    budget: { budgetId: 'usage-budget', amount: 1, maxModelCalls: 4, maxToolCalls: 16,
      maxOutputTokens: 2048, maxDurationMs: 30_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage', automationId: 'usage-run', definitionHash: 'f'.repeat(64), occurrenceId: 'occurrence-1' },
    sessionId: 'growth-session', toolContractDigest: '1'.repeat(64), executionContractDigest: '2'.repeat(64),
    createdAt: 1000, generationDeadlineAt: 31_000, expiresAt: 61_000,
  }
}

test('generation provenance survives JSON persistence and every authority revision changes its digest', () => {
  const original = binding()
  const originalDigest = sourceGrowthRunDigest(original)
  expect(sourceGrowthRunDigest(JSON.parse(JSON.stringify(original)))).toBe(originalDigest)
  const changes: Array<(value: SourceGrowthRunBinding) => void> = [
    value => { value.model.model = 'other-model' },
    value => { value.model.reasoningEffort = 'medium' },
    value => { value.modelOrigin = 'inherited-owner-task' },
    value => { value.budget.amount = 2 },
    value => { value.budget.maxModelCalls = 5 },
    value => { value.source.projection.version = 3 },
    value => { value.source.outcomeId = 'outcome-2' },
    value => { value.ownerDigest = '9'.repeat(64) },
    value => { value.native.occurrenceId = 'occurrence-2' },
    value => { value.sessionId = 'other-session' },
    value => { value.toolContractDigest = '8'.repeat(64) },
    value => { value.executionContractDigest = '7'.repeat(64) },
    value => { value.expiresAt++ },
  ]
  for (const change of changes) {
    const revised = structuredClone(original)
    change(revised)
    expect(sourceGrowthRunDigest(revised)).not.toBe(originalDigest)
  }
})

test.each([
  (value: SourceGrowthRunBinding) => { value.native.automationId = 'another-run' },
  (value: SourceGrowthRunBinding) => { value.generationDeadlineAt = value.createdAt },
  (value: SourceGrowthRunBinding) => { value.generationDeadlineAt = value.expiresAt + 1 },
  (value: SourceGrowthRunBinding) => { value.budget.maxDurationMs = 1 },
  (value: SourceGrowthRunBinding) => { value.budget.amount = 0 },
  (value: SourceGrowthRunBinding) => { value.source.projection.version = 0 },
  (value: SourceGrowthRunBinding) => { Object.assign(value.model, { apiKey: 'must-not-cross' }) },
  (value: SourceGrowthRunBinding) => { Object.assign(value, { approved: true }) },
  (value: SourceGrowthRunBinding) => { Object.assign(value.source.projection, { disposition: 'retract' }) },
  (value: SourceGrowthRunBinding) => { Object.assign(value, { modelOrigin: 'guessed-after-restart' }) },
])('rejects inconsistent native identity, widened authority and unrecognized claims: %j', change => {
  const value = binding()
  change(value)
  expect(() => validateSourceGrowthRunBinding(value)).toThrow()
})

test('evidence hashing retains the existing private source shape including absent optional feedback', () => {
  const value = { protocol: 'source/v1', source: { sessionId: 'original', objective: 'owner task' },
    judgement: 'owner-feedback', ownerRevision: undefined }
  const canonical = '{"judgement":"owner-feedback","protocol":"source/v1","source":{"objective":"owner task","sessionId":"original"}}'
  expect(sourceGrowthEvidenceDigest(value)).toBe(createHash('sha256').update(canonical).digest('hex'))
  expect(sourceGrowthEvidenceDigest({ ...value, ownerRevision: { version: 2, action: 'correct' } }))
    .not.toBe(sourceGrowthEvidenceDigest(value))
})

test('rejects cycles and objects that can synthesize an evidence value', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic['self'] = cyclic
  expect(() => sourceGrowthEvidenceDigest(cyclic)).toThrow()
  expect(() => sourceGrowthEvidenceDigest(new Date())).toThrow()
  expect(() => sourceGrowthEvidenceDigest(JSON.parse('{"__proto__":{"approved":true}}'))).toThrow()
})
