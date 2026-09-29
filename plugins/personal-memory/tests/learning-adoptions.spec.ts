import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { growthObjectDigest, memoryLearningRequestDigest,
  type MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import { MemoryStore, MemoryStoreError, memoryPrincipalDigest } from '../src/store.ts'
import type { MemoryLearningAdoptionGrant, MemoryLearningReviewReceipt } from '../src/learning-adoptions.ts'
import { validateMemoryLearningAdoptionGrant, validateLearningReviewReceipt } from '../src/learning-adoptions.ts'
import type { MemoryAgentContext, MemoryEntryInput } from '../src/types.ts'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function path(): string { const root = mkdtempSync(join(tmpdir(), 'memory-learning-adoptions-')); roots.push(root); return join(root, 'memory.sqlite') }
const owner = { authorityId: 'ordinary-owner', authorityHash: 'a'.repeat(64),
  principalId: 'lark/primary/personal/ou_owner', principalRecordId: 'principal-one', principalVersion: 1,
  workspace: '/work/owner', agentPreset: 'standard' }
const namespace = { mode: 'delivery' as const, principalDigest: memoryPrincipalDigest(owner.principalId),
  principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion }
const identity = { owner: 'agent' as const, scope: 'workspace' as const, workspace: owner.workspace, agentPreset: owner.agentPreset }
const context: MemoryAgentContext = { namespace, workspace: owner.workspace, agentPreset: owner.agentPreset }
function grant(overrides: Partial<MemoryLearningAdoptionGrant> = {}): MemoryLearningAdoptionGrant {
  return { authorityId: 'memory-grant-one', owner, reviewAuthorityId: 'independent-review', reviewAuthorityDigest: 'b'.repeat(64),
    expiresAt: 200_000, maxMutations: 3, maxTotalContentBytes: 100, maxRecordTtlMs: 50_000,
    kinds: ['fact', 'experience'], operations: ['add', 'replace', 'remove'], ...overrides }
}
function request(operationId: string, content = 'Atlas uses a migration journal', mutation?: MemoryLearningReviewRequest['mutation']): MemoryLearningReviewRequest {
  return { protocol: 'memory-learning-review/v1', operationId, extractionSessionId: 'extraction-one', owner,
    source: { inboxId: 'inbox-one', sourceDigest: 'c'.repeat(64), contentDigest: 'd'.repeat(64) },
    mutation: mutation ?? { op: 'add', entry: { kind: 'fact', content } }, evidenceQuote: 'Atlas uses a migration journal' }
}
function receipt(value: MemoryLearningReviewRequest, authorization = grant()): MemoryLearningReviewReceipt {
  const body = { protocol: 'memory-learning-review-receipt/v1' as const, operationId: value.operationId,
    requestDigest: memoryLearningRequestDigest(value), authorityId: authorization.reviewAuthorityId,
    authorityDigest: authorization.reviewAuthorityDigest, sessionId: 'memory-review-one',
    model: { provider: 'fixture', model: 'fixed' }, status: 'approved' as const, reason: 'Quote supports the proposed memory.',
    outputDigest: 'e'.repeat(64) }
  return { ...body, receiptDigest: growthObjectDigest(body) }
}
function commit(store: MemoryStore, value: MemoryLearningReviewRequest, authorization = grant()) {
  return store.applyLearningAdoption({ grant: authorization, request: value, reviewReceipt: receipt(value, authorization), sourceObservedAt: 90_000 })
}
function manual(content: string): MemoryEntryInput {
  return { kind: 'fact', content, sensitivity: 'private', trust: 'user-confirmed', confidence: 1,
    provenance: { source: 'owner', observedAt: 100_000 } }
}

test('freezes grant authority and exact adoption result across lost ACK, restart and manual replacement', () => {
  const database = path(); let now = 100_000
  const first = new MemoryStore({ path: database, now: () => now })
  const authorization = grant()
  const registered = first.registerLearningGrant(authorization)
  expect(first.registerLearningGrant(authorization)).toEqual(registered)
  expect(() => first.registerLearningGrant(grant({ maxMutations: 10 }))).toThrowError(
    expect.objectContaining<Partial<MemoryStoreError>>({ code: 'idempotency-conflict' }))
  const source = request('operation-one')
  const adopted = commit(first, source)
  expect(adopted).toMatchObject({ protocol: 'memory-learning-adoption/v1', authorityId: authorization.authorityId,
    requestDigest: memoryLearningRequestDigest(source), reviewReceiptDigest: receipt(source).receiptDigest,
    record: { owner: 'agent', scope: 'workspace', trust: 'agent-observed', confidence: 0.5,
      provenance: { source: 'assistant-memory-learning', observedAt: 90_000, uri: 'delivery:foreground:inbox-one' } } })
  expect(first.get(namespace, identity, adopted.record.id)).toBeUndefined()
  expect(first.search({ context, query: 'migration journal' })).toEqual([])
  expect(first.inspectLearningTarget({ owner, id: adopted.record.id, expectedVersion: 1 })).toMatchObject({ managed: true, version: 1 })
  expect(first.lookupLearningAdoption({ authorityId: authorization.authorityId, operationId: source.operationId,
    requestDigest: adopted.requestDigest })).toEqual(adopted)
  const refs = first.listManagedLearningSources(context)
  expect(refs).toMatchObject([{ authorityId: authorization.authorityId, id: adopted.record.id, version: 1,
    recordDigest: adopted.recordDigest, sourceDigest: source.source.sourceDigest, request: source }])
  expect(first.withLearningVisibility(refs, () => first.search({ context, query: 'migration journal' }).map(hit => hit.record.id)))
    .toEqual([adopted.record.id])
  expect(first.get(namespace, identity, adopted.record.id)).toBeUndefined()
  first.close()

  const reopened = new MemoryStore({ path: database, now: () => now })
  expect(reopened.registerLearningGrant(authorization)).toEqual(registered)
  const manuallyChanged = reopened.applyApprovedMutation({ op: 'replace', namespace, identity, id: adopted.record.id,
    expectedVersion: 1, idempotencyKey: 'owner-manual-replacement', entry: manual('Owner confirmed a new rule') })
  expect(manuallyChanged.version).toBe(2)
  expect(reopened.get(namespace, identity, adopted.record.id)).toEqual(manuallyChanged)
  expect(reopened.inspectLearningTarget({ owner, id: adopted.record.id, expectedVersion: 2 })).toBeUndefined()
  expect(reopened.listManagedLearningSources(context)).toEqual([])
  now = 300_000
  expect(commit(reopened, source)).toEqual(adopted)
  expect(reopened.lookupLearningAdoption({ authorityId: authorization.authorityId, operationId: source.operationId,
    requestDigest: adopted.requestDigest })).toEqual(adopted)
  expect(() => commit(reopened, request('operation-two'))).toThrow(/expired/u)
  expect(() => commit(reopened, request('operation-one', 'Different request'))).toThrow(/reused/u)
  reopened.close()
})

test('rejects manual ABA and unrelated targets; exact automatic replacements remain managed', () => {
  const store = new MemoryStore({ path: path(), now: () => 100_000 })
  store.registerLearningGrant(grant())
  const added = commit(store, request('add'))
  const replacementRequest = request('replace', '', { op: 'replace', id: added.record.id, expectedVersion: 1,
    entry: { kind: 'fact', content: 'Atlas uses a verified snapshot' } })
  const replaced = commit(store, replacementRequest)
  expect(replaced.record.version).toBe(2)
  expect(store.inspectLearningTarget({ owner, id: added.record.id, expectedVersion: 1 })).toBeUndefined()
  expect(store.inspectLearningTarget({ owner, id: added.record.id, expectedVersion: 2 })).toMatchObject({ content: 'Atlas uses a verified snapshot' })
  const restored = store.applyApprovedMutation({ op: 'replace', namespace, identity, id: added.record.id, expectedVersion: 2,
    idempotencyKey: 'manual-aba', entry: manual('Atlas uses a verified snapshot') })
  expect(restored.version).toBe(3)
  expect(store.inspectLearningTarget({ owner, id: added.record.id, expectedVersion: 3 })).toBeUndefined()
  expect(store.get(namespace, identity, added.record.id)).toEqual(restored)
  const illegal = request('takeover', '', { op: 'replace', id: added.record.id, expectedVersion: 3,
    entry: { kind: 'fact', content: 'Automatic takeover denied' } })
  expect(() => commit(store, illegal)).toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'version-conflict' }))
  store.close()
})

test('charges quota atomically across two writers and rolls back failed mutations', () => {
  const database = path()
  const first = new MemoryStore({ path: database, now: () => 100_000 })
  const second = new MemoryStore({ path: database, now: () => 100_000 })
  const limit = grant({ maxMutations: 1, maxTotalContentBytes: 40 })
  first.registerLearningGrant(limit)
  expect(() => commit(first, request('bad', 'x'.repeat(60)), limit)).toThrowError(
    expect.objectContaining<Partial<MemoryStoreError>>({ code: 'record-limit' }))
  expect(first.listManagedLearningSources(context)).toEqual([])
  const adopted = commit(second, request('good', 'Atlas journal'), limit)
  expect(adopted.record.content).toBe('Atlas journal')
  expect(() => commit(first, request('late', 'Another fact'), limit)).toThrowError(
    expect.objectContaining<Partial<MemoryStoreError>>({ code: 'record-limit' }))
  const check = new DatabaseSync(database, { readOnly: true })
  expect(check.prepare("SELECT used_mutations, used_content_bytes FROM memory_learning_adoptions WHERE row_kind='grant'").get())
    .toEqual({ used_mutations: 1, used_content_bytes: Buffer.byteLength('Atlas journal') })
  expect(check.prepare("SELECT COUNT(*) AS count FROM memory_learning_adoptions WHERE row_kind='operation'").get())
    .toEqual({ count: 1 })
  check.close(); second.close(); first.close()
})

test('does not adopt an existing manual audit result even when its mutation is identical', () => {
  const database = path()
  const store = new MemoryStore({ path: database, now: () => 100_000 })
  const authorization = grant()
  const source = request('occupied')
  const reservedKey = `memory-learning:${growthObjectDigest([authorization.authorityId, source.operationId])}`
  const original = store.applyApprovedMutation({ op: 'add', namespace, identity, idempotencyKey: reservedKey,
    entry: { kind: 'fact', content: source.mutation.op === 'remove' ? '' : source.mutation.entry.content,
      sensitivity: 'private', trust: 'agent-observed', confidence: 0.5,
      provenance: { source: 'assistant-memory-learning', observedAt: 90_000, uri: 'delivery:foreground:inbox-one' },
      expiresAt: 150_000 } })
  store.registerLearningGrant(authorization)
  expect(() => commit(store, source, authorization)).toThrowError(
    expect.objectContaining<Partial<MemoryStoreError>>({ code: 'idempotency-conflict' }))
  expect(store.get(namespace, identity, original.id)).toEqual(original)
  expect(store.listManagedLearningSources(context)).toEqual([])
  expect(store.lookupLearningAdoption({ authorityId: authorization.authorityId, operationId: source.operationId,
    requestDigest: memoryLearningRequestDigest(source) })).toBeUndefined()
  const check = new DatabaseSync(database, { readOnly: true })
  expect(check.prepare("SELECT used_mutations FROM memory_learning_adoptions WHERE row_kind='grant'").get())
    .toEqual({ used_mutations: 0 })
  check.close(); store.close()
})

test('uses distinct audit keys for colon-ambiguous grant and operation id pairs', () => {
  const database = path()
  const store = new MemoryStore({ path: database, now: () => 100_000 })
  const firstGrant = grant({ authorityId: 'memory:grant' })
  const secondGrant = grant({ authorityId: 'memory' })
  store.registerLearningGrant(firstGrant)
  store.registerLearningGrant(secondGrant)
  const first = commit(store, request('one', 'First independent memory'), firstGrant)
  const second = commit(store, request('grant:one', 'Second independent memory'), secondGrant)
  expect(first.record.id).not.toBe(second.record.id)
  expect(store.lookupLearningAdoption({ authorityId: firstGrant.authorityId, operationId: 'one',
    requestDigest: first.requestDigest })).toEqual(first)
  expect(store.lookupLearningAdoption({ authorityId: secondGrant.authorityId, operationId: 'grant:one',
    requestDigest: second.requestDigest })).toEqual(second)
  const check = new DatabaseSync(database, { readOnly: true })
  const keys = check.prepare("SELECT idempotency_key FROM memory_audit WHERE idempotency_key LIKE 'memory-learning:%' ORDER BY idempotency_key")
    .all() as Array<{ idempotency_key: string }>
  expect(keys).toEqual([
    { idempotency_key: `memory-learning:${growthObjectDigest([firstGrant.authorityId, 'one'])}` },
    { idempotency_key: `memory-learning:${growthObjectDigest([secondGrant.authorityId, 'grant:one'])}` },
  ].sort((a, b) => a.idempotency_key.localeCompare(b.idempotency_key)))
  check.close(); store.close()
})

test('withdrawal invalidates only the exact managed version, never refunds quota or removes a manual edit', () => {
  const store = new MemoryStore({ path: path(), now: () => 100_000 })
  store.registerLearningGrant(grant())
  const adopted = commit(store, request('first'))
  const ref = { owner, id: adopted.record.id, version: adopted.record.version,
    recordDigest: adopted.recordDigest, sourceDigest: 'c'.repeat(64), reason: 'withdrawn' as const }
  expect(store.invalidateManagedLearningSource({ ...ref, sourceDigest: 'f'.repeat(64) })).toEqual({ invalidated: false })
  expect(store.invalidateManagedLearningSource(ref)).toEqual({ invalidated: true })
  expect(store.invalidateManagedLearningSource(ref)).toEqual({ invalidated: false })
  expect(store.listManagedLearningSources(context)).toEqual([])
  expect(store.withLearningVisibility([{ id: ref.id, version: ref.version, recordDigest: ref.recordDigest }],
    () => store.search({ context, query: 'migration' }))).toEqual([])
  const later = commit(store, request('second', 'Manual handoff is required'))
  const manualRecord = store.applyApprovedMutation({ op: 'replace', namespace, identity, id: later.record.id,
    expectedVersion: 1, idempotencyKey: 'owner-edit-after-adopt', entry: manual('Owner adjusted this fact') })
  expect(store.invalidateManagedLearningSource({ ...ref, id: later.record.id, recordDigest: later.recordDigest,
    reason: 'source-changed' })).toEqual({ invalidated: false })
  expect(store.get(namespace, identity, later.record.id)).toEqual(manualRecord)
  store.close()
})

test('visibility callbacks are synchronous, scoped and restored after failure', () => {
  const store = new MemoryStore({ path: path(), now: () => 100_000 })
  store.registerLearningGrant(grant())
  const adopted = commit(store, request('first'))
  const refs = [{ id: adopted.record.id, version: 1, recordDigest: adopted.recordDigest }]
  const getter = vi.fn(() => { throw new Error('then getter must not run') })
  // eslint-disable-next-line unicorn/no-thenable -- intentional hostile then getter
  const getterThenable = Object.defineProperty({}, 'then', { get: getter })
  expect(() => store.withLearningVisibility(refs, () => getterThenable)).toThrow(/synchronous/u)
  expect(getter).not.toHaveBeenCalled()
  expect(() => store.withLearningVisibility(refs, () => { throw new Error('consumer failed') })).toThrow('consumer failed')
  expect(() => store.withLearningVisibility(refs, () => store.withLearningVisibility(refs, () => 'nested'))).toThrow(/bounded/u)
  expect(store.get(namespace, identity, adopted.record.id)).toBeUndefined()
  expect(store.withLearningVisibility(refs, () => store.get(namespace, identity, adopted.record.id)?.id)).toBe(adopted.record.id)
  expect(store.get(namespace, identity, adopted.record.id)).toBeUndefined()
  store.close()
})

test('migrates a v6 database once while preserving existing manual records and receipts', () => {
  const database = path()
  let store = new MemoryStore({ path: database, now: () => 100_000 })
  const original = store.applyApprovedMutation({ op: 'add', namespace, identity, idempotencyKey: 'old-manual', entry: manual('Retained original') })
  store.close()
  const old = new DatabaseSync(database)
  old.exec("DROP TABLE memory_learning_adoptions; UPDATE schema_meta SET value='6' WHERE key='schema-version'; PRAGMA user_version=6")
  old.close()
  store = new MemoryStore({ path: database, now: () => 100_000 })
  expect(store.get(namespace, identity, original.id)).toEqual(original)
  expect(store.applyApprovedMutation({ op: 'add', namespace, identity, idempotencyKey: 'old-manual', entry: manual('Retained original') })).toEqual(original)
  store.registerLearningGrant(grant())
  expect(commit(store, request('new')).record.version).toBe(1)
  store.close()
  const reopened = new DatabaseSync(database, { readOnly: true })
  expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
  expect(reopened.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get()).toEqual({ value: '7' })
  reopened.close()
})

test('strict grant and review validators reject accessors, array holes, forged approvals, and stale digests', () => {
  const getter = vi.fn(() => 'fact')
  const kindsWithGetter = ['fact']
  Object.defineProperty(kindsWithGetter, '0', { get: getter, enumerable: true })
  expect(() => validateMemoryLearningAdoptionGrant(grant({ kinds: kindsWithGetter as ['fact'] }))).toThrow()
  expect(getter).not.toHaveBeenCalled()
  // eslint-disable-next-line unicorn/no-new-array -- intentional sparse array fixture
  expect(() => validateMemoryLearningAdoptionGrant(grant({ kinds: new Array(1) as ['fact'] }))).toThrow()
  const custom = ['fact'] as Array<'fact'> & { custom?: string }
  custom.custom = 'hidden'
  expect(() => validateMemoryLearningAdoptionGrant(grant({ kinds: custom }))).toThrow()
  const nonEnumerable = ['fact']
  Object.defineProperty(nonEnumerable, '0', { value: 'fact', enumerable: false })
  expect(() => validateMemoryLearningAdoptionGrant(grant({ kinds: nonEnumerable as ['fact'] }))).toThrow()
  expect(() => validateMemoryLearningAdoptionGrant(grant({ operations: ['add', 'add'] }))).toThrow()
  expect(() => validateMemoryLearningAdoptionGrant(grant({ maxMutations: 1_001 }))).toThrow()
  const source = request('proof')
  const valid = receipt(source)
  expect(validateLearningReviewReceipt(valid, source, grant())).toEqual(valid)
  expect(() => validateLearningReviewReceipt({ ...valid, status: 'unknown' }, source, grant())).toThrow()
  expect(() => validateLearningReviewReceipt({ ...valid, receiptDigest: '0'.repeat(64) }, source, grant())).toThrow()
  expect(() => validateLearningReviewReceipt(valid, request('different'), grant())).toThrow()
  const inheritedModel = { ...valid, model: { provider: '@owner/provider', model: 'model@2026.09' } }
  const { receiptDigest: _previousDigest, ...modelBody } = inheritedModel
  expect(validateLearningReviewReceipt({ ...inheritedModel, receiptDigest: growthObjectDigest(modelBody) }, source, grant())).toBeDefined()
})
