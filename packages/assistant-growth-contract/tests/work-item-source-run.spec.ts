import { expect, test } from 'vitest'
import { anySourceGrowthRunDigest, sourceGrowthRunDigest, validateAnySourceGrowthRunBinding,
  validateSourceGrowthRunBinding, validateWorkItemGrowthAuthorityPins, validateWorkItemSourceGrowthRunBinding,
  validateWorkItemRevisionSourceGrowthRunBinding, workItemGrowthAuthorityPinsDigest,
  workItemRevisionAuthorityPinsDigest, type SourceGrowthRunBinding, type WorkItemRevisionSourceGrowthRunBinding,
  type WorkItemSourceGrowthRunBinding } from '../src/source-run.js'

function binding(): WorkItemSourceGrowthRunBinding {
  const acceptance = { protocol: 'assistant-growth/creation-acceptance-authority/v1' as const, authorityId: 'creation-acceptance', keyId: 'key', authorityDigest: 'a'.repeat(64), namePrefix: 'assistant-', expiresAt: 60_000 }
  return { protocol: 'assistant-growth/source-run/v2', mode: 'create', runId: 'work-item-growth', intentDigest: 'b'.repeat(64), configDigest: 'c'.repeat(64), ownerDigest: 'd'.repeat(64),
    source: { protocol: 'assistant-growth/work-item-source/v1', itemId: 'item-one', outcomeId: 'owner-failure',
      projection: { subjectKind: 'work-item', subjectRef: 'item-one', version: 2, digest: 'e'.repeat(64), disposition: 'upsert', evidenceOutcomeId: 'owner-failure' },
      objectiveStatus: 'not-achieved', sourceDigest: 'f'.repeat(64), presentationDigest: '1'.repeat(64),
      context: { protocol: 'assistant-delivery/work-item-engineering-context/v1', manifestDigest: '2'.repeat(64), objectiveDigest: '3'.repeat(64), objectiveBytes: 123 } },
    model: { provider: 'source-supplier', model: 'observed-model' }, modelOrigin: 'inherited-owner-task', creationAcceptance: acceptance,
    authorities: { protocol: 'assistant-growth/work-item-authorities/v1', sourceJobs: { authorityId: 'source-jobs', authorityDigest: '4'.repeat(64), expiresAt: 65_000 },
      creationGrant: { id: 'creation-grant', digest: '5'.repeat(64), expiresAt: 63_000 }, creationAcceptance: acceptance,
      adoption: { authorityId: 'adoption', authorityDigest: '6'.repeat(64), expiresAt: 62_000 } },
    budget: { budgetId: 'source-budget', amount: 1, maxModelCalls: 3, maxToolCalls: 12, maxOutputTokens: 2048, maxDurationMs: 30_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage', automationId: 'work-item-growth', definitionHash: '7'.repeat(64), occurrenceId: 'occ-one' },
    sessionId: 'author-session', toolContractDigest: '8'.repeat(64), executionContractDigest: '9'.repeat(64), createdAt: 1000, generationDeadlineAt: 31_000, expiresAt: 100_000 }
}

test('typed work-item provenance is durable and does not widen foreground-only APIs', () => {
  const value = binding()
  validateWorkItemSourceGrowthRunBinding(value); validateAnySourceGrowthRunBinding(value)
  expect(anySourceGrowthRunDigest(JSON.parse(JSON.stringify(value)))).toBe(anySourceGrowthRunDigest(value))
  expect(value.model).not.toHaveProperty('reasoningEffort')
  expect(() => validateSourceGrowthRunBinding(value)).toThrow()
  expect(() => sourceGrowthRunDigest(value as unknown as SourceGrowthRunBinding)).toThrow()
  // Source validity can outlast particular generation grants; this creates no new grant.
  expect(value.expiresAt).toBeGreaterThan(value.authorities.sourceJobs.expiresAt)
})

test('all authority pins and exact context bytes participate in the canonical digest', () => {
  const original = binding(), digest = anySourceGrowthRunDigest(original)
  for (const change of [
    (v: WorkItemSourceGrowthRunBinding) => { v.authorities.sourceJobs.authorityDigest = 'a'.repeat(64) },
    (v: WorkItemSourceGrowthRunBinding) => { v.authorities.creationGrant.digest = 'a'.repeat(64) },
    (v: WorkItemSourceGrowthRunBinding) => { v.authorities.adoption.authorityDigest = 'a'.repeat(64) },
    (v: WorkItemSourceGrowthRunBinding) => { v.source.context.manifestDigest = 'a'.repeat(64) },
    (v: WorkItemSourceGrowthRunBinding) => { v.source.context.objectiveDigest = 'a'.repeat(64) },
    (v: WorkItemSourceGrowthRunBinding) => { v.source.context.objectiveBytes++ },
    (v: WorkItemSourceGrowthRunBinding) => { v.model.reasoningEffort = 'high' },
  ]) { const value = structuredClone(original); change(value); expect(anySourceGrowthRunDigest(value)).not.toBe(digest) }
  expect(workItemGrowthAuthorityPinsDigest(original.authorities)).toHaveLength(64)
})

const corrupt: Array<[string, (v: WorkItemSourceGrowthRunBinding) => void]> = [
  ['fake Inbox', v => { Object.assign(v.source, { inboxId: 'fake' }) }],
  ['foreground projection', v => { Object.assign(v.source.projection, { subjectKind: 'foreground-turn' }) }],
  ['different item', v => { v.source.projection.subjectRef = 'other-item' }],
  ['unknown source', v => { Object.assign(v.source, { protocol: 'unknown' }) }],
  ['unknown binding', v => { Object.assign(v, { protocol: 'assistant-growth/source-run/v3' }) }],
  ['success', v => { Object.assign(v.source, { objectiveStatus: 'achieved' }) }],
  ['unknown objective', v => { Object.assign(v.source, { objectiveStatus: 'unknown' }) }],
  ['retract', v => { Object.assign(v.source.projection, { disposition: 'retract' }) }],
  ['modify', v => { Object.assign(v, { mode: 'modify' }) }],
  ['revise', v => { Object.assign(v, { mode: 'revise' }) }],
  ['revision field', v => { Object.assign(v, { revisionAcceptance: v.creationAcceptance }) }],
  ['undefined revision field', v => { Object.assign(v, { revisionRegressionAcceptance: undefined }) }],
  ['missing acceptance', v => { Reflect.deleteProperty(v, 'creationAcceptance') }],
  ['missing pins', v => { Reflect.deleteProperty(v, 'authorities') }],
  ['acceptance mismatch', v => { v.creationAcceptance = { ...v.creationAcceptance, keyId: 'other-key' } }],
  ['context missing', v => { Reflect.deleteProperty(v.source, 'context') }],
  ['context extra', v => { Object.assign(v.source.context, { text: 'not-a-locator' }) }],
  ['context zero', v => { v.source.context.objectiveBytes = 0 }],
  ['context over max', v => { v.source.context.objectiveBytes = 16_385 }],
  ['context fraction', v => { v.source.context.objectiveBytes = 1.5 }],
  ['wrong hash', v => { v.authorities.sourceJobs.authorityDigest = 'A'.repeat(64) }],
  ['extra pin', v => { Object.assign(v.authorities.creationGrant, { budget: 100 }) }],
  ['unknown pins', v => { Object.assign(v.authorities, { protocol: 'unknown' }) }],
  ['unsafe amount', v => { v.budget.amount = Number.MAX_SAFE_INTEGER + 1 }],
  ['wrong native', v => { v.native.automationId = 'different-run' }],
  ['renewed generation', v => { v.generationDeadlineAt = v.createdAt + v.budget.maxDurationMs + 1 }],
]
test.each(corrupt)('rejects %s without converting it into a foreground source', (_label, change) => {
  const value = structuredClone(binding()); change(value)
  expect(() => validateWorkItemSourceGrowthRunBinding(value)).toThrow()
  expect(() => validateAnySourceGrowthRunBinding(value)).toThrow()
})

test.each(['sourceJobs', 'creationGrant', 'creationAcceptance', 'adoption'] as const)('generation never outlives the %s pin', key => {
  const value = structuredClone(binding())
  value.authorities[key].expiresAt = value.createdAt
  if (key === 'creationAcceptance') value.creationAcceptance = { ...value.authorities.creationAcceptance }
  expect(() => validateWorkItemSourceGrowthRunBinding(value)).toThrow()
  value.authorities[key].expiresAt = value.generationDeadlineAt - 1
  if (key === 'creationAcceptance') value.creationAcceptance = { ...value.authorities.creationAcceptance }
  expect(() => validateWorkItemSourceGrowthRunBinding(value)).toThrow()
  value.authorities[key].expiresAt = value.generationDeadlineAt
  if (key === 'creationAcceptance') value.creationAcceptance = { ...value.authorities.creationAcceptance }
  validateWorkItemSourceGrowthRunBinding(value)
})

test('accessors, thenables and proxies are rejected before user code can run', () => {
  let calls = 0
  const accessor = binding(); Object.defineProperty(accessor.source, 'itemId', { enumerable: true, get() { calls++; return 'item-one' } })
  // Deliberate hostile thenable: validation must reject it without assimilation.
  // oxlint-disable-next-line unicorn/no-thenable
  const thenable = binding(); Object.defineProperty(thenable, 'then', { enumerable: true, value: () => { calls++ } })
  const proxied = binding(); proxied.authorities.creationGrant = new Proxy(proxied.authorities.creationGrant, { get(target, key, receiver) { calls++; return Reflect.get(target, key, receiver) } })
  for (const value of [accessor, thenable, proxied, new Proxy(binding(), { getPrototypeOf() { calls++; return Object.prototype } })]) {
    expect(() => validateWorkItemSourceGrowthRunBinding(value)).toThrow()
    expect(() => validateAnySourceGrowthRunBinding(value)).toThrow()
  }
  expect(calls).toBe(0)
  const thenablePins = binding().authorities
  // oxlint-disable-next-line unicorn/no-thenable
  Object.defineProperty(thenablePins, 'then', { enumerable: true, value: () => { calls++ } })
  expect(() => validateWorkItemGrowthAuthorityPins(thenablePins)).toThrow()
  expect(calls).toBe(0)
})

function revisionBinding(): WorkItemRevisionSourceGrowthRunBinding {
  const base = structuredClone(binding())
  const revisionAcceptance = { protocol: 'assistant-growth/revision-acceptance-authority/v1' as const, authorityId: 'revision-acceptance', keyId: 'revision-key', authorityDigest: 'b'.repeat(64), namePrefix: 'assistant-', expiresAt: 61_000 }
  const revisionGrant = { id: 'revision-grant', digest: 'c'.repeat(64), expiresAt: 64_000, workItemFailures: true as const }
  const { creationAcceptance: _drop, ...rest } = base
  return { ...rest, protocol: 'assistant-growth/source-run/v3', mode: 'revise-created',
    revisionAcceptance,
    authorities: { protocol: 'assistant-growth/work-item-revision-authorities/v1',
      sourceJobs: { authorityId: 'source-jobs', authorityDigest: '4'.repeat(64), expiresAt: 65_000 },
      revisionGrant, revisionAcceptance } }
}

test('typed revision provenance keeps work-item identity and never widens create or foreground APIs', () => {
  const value = revisionBinding()
  validateWorkItemRevisionSourceGrowthRunBinding(value); validateAnySourceGrowthRunBinding(value)
  expect(anySourceGrowthRunDigest(JSON.parse(JSON.stringify(value)))).toBe(anySourceGrowthRunDigest(value))
  expect(() => validateWorkItemSourceGrowthRunBinding(value)).toThrow()
  expect(() => validateSourceGrowthRunBinding(value)).toThrow()
  expect(Object.hasOwn(value, 'creationAcceptance')).toBe(false)
})

test('all revision authority pins participate in the canonical digest', () => {
  const original = revisionBinding(), digest = anySourceGrowthRunDigest(original)
  for (const change of [
    (v: WorkItemRevisionSourceGrowthRunBinding) => { v.authorities.sourceJobs.authorityDigest = 'a'.repeat(64) },
    (v: WorkItemRevisionSourceGrowthRunBinding) => { v.authorities.revisionGrant.digest = 'a'.repeat(64) },
    (v: WorkItemRevisionSourceGrowthRunBinding) => { v.authorities.revisionGrant.expiresAt = 63_500 },
    (v: WorkItemRevisionSourceGrowthRunBinding) => { v.revisionAcceptance.keyId = 'other-key' },
  ]) { const value = structuredClone(original); change(value); expect(anySourceGrowthRunDigest(value)).not.toBe(digest) }
  expect(workItemRevisionAuthorityPinsDigest(original.authorities)).toHaveLength(64)
})

const revisionCorrupt: Array<[string, (v: WorkItemRevisionSourceGrowthRunBinding) => void]> = [
  ['create mode', v => { Object.assign(v, { mode: 'create' }) }],
  ['v2 protocol', v => { Object.assign(v, { protocol: 'assistant-growth/source-run/v2' }) }],
  ['missing revision acceptance', v => { Reflect.deleteProperty(v, 'revisionAcceptance') }],
  ['missing revision pins', v => { Reflect.deleteProperty(v, 'authorities') }],
  ['wrong pins protocol', v => { Object.assign(v.authorities, { protocol: 'assistant-growth/work-item-authorities/v1' }) }],
  ['no work item failures', v => { Object.assign(v.authorities.revisionGrant, { workItemFailures: false }) }],
  ['acceptance mismatch', v => { v.revisionAcceptance = { ...v.revisionAcceptance, keyId: 'other-key' } }],
  ['regression without pin', v => { Object.assign(v, { revisionRegressionAcceptance: v.revisionAcceptance }) }],
  ['expired pin', v => { v.authorities.revisionGrant.expiresAt = v.createdAt }],
]
test.each(revisionCorrupt)('rejects %s revision binding without falling back to creation', (_label, change) => {
  const value = structuredClone(revisionBinding()); change(value)
  expect(() => validateWorkItemRevisionSourceGrowthRunBinding(value)).toThrow()
  expect(() => validateAnySourceGrowthRunBinding(value)).toThrow()
})

test('revision with regression acceptance requires the matching pin and participates in expiry', () => {
  const regression = { protocol: 'assistant-growth/revision-regression-acceptance-authority/v1' as const, authorityId: 'revision-regression', keyId: 'regression-key', authorityDigest: 'd'.repeat(64), namePrefix: 'assistant-', expiresAt: 62_000 }
  const withRegression = { ...structuredClone(revisionBinding()), revisionRegressionAcceptance: regression }
  withRegression.authorities.revisionRegressionAcceptance = regression
  validateWorkItemRevisionSourceGrowthRunBinding(withRegression)
  const expired = structuredClone(withRegression)
  expired.authorities.revisionRegressionAcceptance = { ...regression, expiresAt: expired.createdAt }
  expect(() => validateWorkItemRevisionSourceGrowthRunBinding(expired)).toThrow()
})

test('generation never outlives any revision pin', () => {
  for (const key of ['sourceJobs', 'revisionGrant', 'revisionAcceptance'] as const) {
    const value = structuredClone(revisionBinding())
    value.authorities[key].expiresAt = value.createdAt
    if (key === 'revisionAcceptance') value.revisionAcceptance = { ...value.authorities.revisionAcceptance }
    expect(() => validateWorkItemRevisionSourceGrowthRunBinding(value)).toThrow()
value.authorities[key].expiresAt = value.generationDeadlineAt - 1
    if (key === 'revisionAcceptance') value.revisionAcceptance = { ...value.authorities.revisionAcceptance }
    expect(() => validateWorkItemRevisionSourceGrowthRunBinding(value)).toThrow()
    value.authorities[key].expiresAt = value.generationDeadlineAt
    if (key === 'revisionAcceptance') value.revisionAcceptance = { ...value.authorities.revisionAcceptance }
    validateWorkItemRevisionSourceGrowthRunBinding(value)
  }
})
