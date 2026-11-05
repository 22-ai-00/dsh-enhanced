import { removeEmptyWorkItemReplySchema } from './helpers/work-item-reply-schema.js'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import { DeliveryStore } from '../src/store.js'
import { externalPrincipalId, ownerRouteAuthorityHash } from '../src/canonical.js'
import { foregroundTerminationKinds, normalizeForegroundTerminationObservation, type ForegroundTerminationObservation } from '../src/foreground-termination.js'
import type { OwnerRouteAuthority, OwnerForegroundTaskSourceScope } from '../src/types.js'
const roots: string[] = [], stores = new Set<DeliveryStore>()
afterEach(async () => { for (const store of stores) store.close(); stores.clear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
const conversation = { channel: principal.channel, account: principal.account, tenant: principal.tenant, kind: 'dm' as const, chat: 'chat' }
const authority: OwnerRouteAuthority = { id: 'owner', principal, conversation, workspace: '/work/termination', agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const observed = (causeCode: ForegroundTerminationObservation['causeCode'] = 'runtime-error', producer: ForegroundTerminationObservation['producer'] = 'delivery-agent') =>
  normalizeForegroundTerminationObservation({ protocol: 'assistant-delivery/foreground-termination/v1', producer, kind: foregroundTerminationKinds[causeCode], causeCode, handleDisposed: true, effects: 'unknown', replay: 'forbidden' })
async function fixture(text = '检查 🧪 tasks\n原始输入') {
  const root = await mkdtemp(join(tmpdir(), 'delivery-termination-')); roots.push(root)
  const path = join(root, 'delivery.sqlite'), store = new DeliveryStore({ path, now: () => 1000, codeGenerator: () => 'PAIR1234' }); stores.add(store)
  const challenge = store.issuePairing(principal, { ttlMs: 5000, maxAttempts: 3 }); store.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
  const owner = store.getPrincipal(principal)!, binding = store.createBinding({ principal, conversation, workspace: authority.workspace, agentPreset: authority.agentPreset, policyRef: authority.policyRef, sessionId: 'session' })
  const admitted = store.claimNativeInbox({ envelope: { channel: principal.channel, account: principal.account, eventId: 'event', occurredAt: 1,
    principal, conversation, kind: 'text', text, metadata: { private: 'never-return-this-metadata' } }, binding,
    ownerLineage: { principalRecordId: owner.id, principalVersion: owner.version }, ownerId: 'worker', leaseMs: 10000 })
  store.bindForegroundTaskExecution({ inboxId: admitted.record.id, scope: { workspace: authority.workspace, preset: authority.agentPreset }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: 1 })
  const scope: OwnerForegroundTaskSourceScope = { authorityId: authority.id, principalId: externalPrincipalId(principal), workspace: authority.workspace, agentPreset: authority.agentPreset,
    expectedOwner: { authorityHash: ownerRouteAuthorityHash(authority), principalRecordId: owner.id, principalVersion: owner.version } }
  return { root, path, store, owner, binding, scope, inboxId: admitted.record.id, inbox: admitted.record, text }
}
const finish = (f: Awaited<ReturnType<typeof fixture>>, termination = observed()) => f.store.finishForegroundTaskExecution({ inboxId: f.inboxId, status: 'unknown', quiescent: false, completedAt: 2, termination })
const source = (f: Awaited<ReturnType<typeof fixture>>) => f.store.inspectOwnerForegroundTaskSource({ ...f.scope, inboxId: f.inboxId }, authority)!
const read = (f: Awaited<ReturnType<typeof fixture>>, extra: { offset?: number; maxBytes?: number } = {}) => f.store.readOwnerForegroundTaskInput({ ...f.scope, inboxId: f.inboxId, expectedSourceDigest: source(f).sourceDigest, ...extra }, authority)
function sql(path: string, action: (db: DatabaseSync) => void) { const db = new DatabaseSync(path); try { action(db) } finally { db.close() } }

test.each(Object.keys(foregroundTerminationKinds) as ForegroundTerminationObservation['causeCode'][])('normalizes the exact fixed %s observation without effects or replay claims', cause => {
  const value = observed(cause)
  expect(value.kind).toBe(foregroundTerminationKinds[cause]); expect(value.effects).toBe('unknown'); expect(value.replay).toBe('forbidden'); expect(Object.isFrozen(value)).toBe(true)
})

test('rejects wrong mapping, raw error/tool fields, proxies, accessors and non-JSON objects', () => {
  const valid = observed()
  for (const invalid of [{ ...valid, kind: 'completed' }, { ...valid, producer: 'model' }, { ...valid, causeCode: 'arbitrary' }, { ...valid, effects: 'none' },
    { ...valid, replay: 'allowed' }, { ...valid, handleDisposed: 1 }, { ...valid, error: 'private exception' }, { ...valid, arguments: { secret: 'raw tool input' } },
    { ...valid, protocol: 'other' }, [], null, new Date(), new Proxy({ ...valid }, {})]) expect(() => normalizeForegroundTerminationObservation(invalid)).toThrow()
  let reads = 0; const accessor = { ...valid }; Object.defineProperty(accessor, 'causeCode', { enumerable: true, get: () => { reads++; return 'runtime-error' } })
  expect(() => normalizeForegroundTerminationObservation(accessor)).toThrow(); expect(reads).toBe(0)
  const coercible = { toString() { reads++; return 'delivery-agent' } }
  expect(() => normalizeForegroundTerminationObservation({ ...valid, producer: coercible })).toThrow(); expect(reads).toBe(0)
})

test('keeps unknown execution status, exposes only original input, and survives reopen without reply or frozen supplier', async () => {
  const f = await fixture(); finish(f)
  expect(source(f)).toMatchObject({ execution: { status: 'unknown', quiescent: false, modelSelectionState: 'missing' }, termination: observed() })
  const page = read(f)!
  expect(page.input).toEqual({ text: f.text, fullTextDigest: hash(f.text), fullBytes: Buffer.byteLength(f.text), returnedBytes: Buffer.byteLength(f.text), offset: 0 })
  expect(JSON.stringify(page)).not.toContain('never-return-this-metadata')
  expect(f.store.readOwnerForegroundTaskSource({ ...f.scope, inboxId: f.inboxId, expectedSourceDigest: source(f).sourceDigest }, authority)).toBeUndefined()
  const digest = page.sourceDigest; f.store.close(); stores.delete(f.store)
  const reopened = new DeliveryStore({ path: f.path }); stores.add(reopened)
  expect(reopened.readOwnerForegroundTaskInput({ ...f.scope, inboxId: f.inboxId, expectedSourceDigest: digest }, authority)).toEqual(page)
})

test('completion is exact and immutable, including absent versus present observations', async () => {
  const f = await fixture(), completion = { inboxId: f.inboxId, status: 'unknown' as const, quiescent: false, completedAt: 2, termination: observed() }
  f.store.finishForegroundTaskExecution(completion); f.store.finishForegroundTaskExecution({ ...completion, termination: { ...completion.termination } })
  const { termination: _termination, ...absent } = completion
  expect(() => f.store.finishForegroundTaskExecution(absent)).toThrow()
  for (const changed of [{ ...completion, termination: observed('turn-missing') }, { ...completion, completedAt: 3 }]) {
    expect(() => f.store.finishForegroundTaskExecution(changed)).toThrow()
  }
  sql(f.path, db => {
    for (const statement of ['UPDATE delivery_foreground_executions SET termination_json=NULL', "UPDATE delivery_foreground_executions SET termination_json='{}'", 'DELETE FROM delivery_foreground_executions']) expect(() => db.exec(statement)).toThrow()
  })
  const legacy = await fixture(); legacy.store.finishForegroundTaskExecution({ inboxId: legacy.inboxId, status: 'unknown', quiescent: false, completedAt: 2 })
  expect(() => legacy.store.finishForegroundTaskExecution({ inboxId: legacy.inboxId, status: 'unknown', quiescent: false, completedAt: 2, termination: observed() })).toThrow()
  expect(read(legacy)).toBeUndefined()
})

test('validates completion coupling before the atomic transition and rejects pending/invalid SQL observations', async () => {
  const f = await fixture()
  for (const completion of [{ status: 'succeeded', quiescent: true, termination: observed() }, { status: 'unknown', quiescent: false, termination: observed('turn-completed') },
    { status: 'succeeded', quiescent: true, termination: { ...observed('turn-completed'), handleDisposed: false } }]) {
    expect(() => f.store.finishForegroundTaskExecution({ ...completion, status: completion.status as 'succeeded' | 'unknown', inboxId: f.inboxId, completedAt: 2 })).toThrow()
  }
  sql(f.path, db => {
    expect(db.prepare('SELECT status,termination_json FROM delivery_foreground_executions').get()).toMatchObject({ status: 'pending', termination_json: null })
    expect(() => db.prepare('UPDATE delivery_foreground_executions SET termination_json=?').run(JSON.stringify(observed()))).toThrow()
    for (const invalid of ['{}', JSON.stringify({ ...observed(), extra: 'raw' }), JSON.stringify({ ...observed(), kind: 'completed' }), JSON.stringify(observed()) + '\0hidden']) {
      expect(() => db.prepare("UPDATE delivery_foreground_executions SET status='unknown',quiescent=0,completed_at=2,execution_ref=inbox_id,termination_json=?").run(invalid)).toThrow()
    }
    expect(db.prepare('SELECT status FROM delivery_foreground_executions').get()).toMatchObject({ status: 'pending' })
  })
})

test('pages complete UTF-8 original input with a stable full-input digest and strict byte boundaries', async () => {
  const f = await fixture('a中🧪界xyz'.repeat(1200)); finish(f)
  let offset = 0, whole = '', contentDigest: string | undefined
  while (true) { const page = read(f, { offset, maxBytes: 7 })!; expect(page.input.returnedBytes).toBeLessThanOrEqual(7); expect(page.input.returnedBytes).toBe(Buffer.byteLength(page.input.text));
    expect(page.input.fullTextDigest).toBe(hash(f.text)); contentDigest ??= page.contentDigest; expect(page.contentDigest).toBe(contentDigest); whole += page.input.text
    if (page.input.nextOffset === undefined) break; expect(page.input.nextOffset).toBeGreaterThan(offset); offset = page.input.nextOffset }
  expect(whole).toBe(f.text)
  expect(read(f)!.input.returnedBytes).toBeLessThanOrEqual(4096)
  expect(read(f, { offset: Buffer.byteLength(f.text) })!.input.text).toBe('')
  for (const page of [{ offset: 2 }, { offset: -1 }, { offset: 1.5 }, { offset: Buffer.byteLength(f.text) + 1 }, { maxBytes: 3 }, { maxBytes: 8193 }]) expect(() => read(f, page)).toThrow()
})

test('revalidates owner, binding, envelope and expected source digest', async () => {
  const f = await fixture(); finish(f); const before = source(f)
  expect(f.store.readOwnerForegroundTaskInput({ ...f.scope, inboxId: f.inboxId, expectedSourceDigest: 'f'.repeat(64) }, authority)).toBeUndefined()
  expect(() => f.store.readOwnerForegroundTaskInput({ ...f.scope, expectedOwner: { ...f.scope.expectedOwner, principalVersion: 2 }, inboxId: f.inboxId, expectedSourceDigest: before.sourceDigest }, authority)).toThrow()
  sql(f.path, db => db.prepare("UPDATE conversation_bindings SET session_id='changed' WHERE id=?").run(f.binding.id))
  expect(f.store.readOwnerForegroundTaskInput({ ...f.scope, inboxId: f.inboxId, expectedSourceDigest: before.sourceDigest }, authority)).toBeUndefined()
  sql(f.path, db => db.prepare('UPDATE inbox_messages SET envelope_hash=? WHERE id=?').run('a'.repeat(64), f.inboxId))
  expect(f.store.inspectOwnerForegroundTaskSource({ ...f.scope, inboxId: f.inboxId }, authority)).toBeUndefined()
})

test('migrates real schema27 rows without guessing observations or changing the old source digest', async () => {
  const f = await fixture(); f.store.finishForegroundTaskExecution({ inboxId: f.inboxId, status: 'unknown', quiescent: false, completedAt: 2 })
  const before = source(f), { sourceDigest, ...body } = before
  expect(sourceDigest).toBe(hash(acceptanceCanonicalJson({ ...body, envelopeHash: f.inbox.envelopeHash })))
  expect(before).not.toHaveProperty('termination'); f.store.close(); stores.delete(f.store)
  sql(f.path, db => { removeEmptyWorkItemReplySchema(db); for (const trigger of ['insert','update','immutable']) db.exec(`DROP TRIGGER delivery_foreground_termination_${trigger}`)
    db.exec('ALTER TABLE delivery_foreground_executions DROP COLUMN termination_json; PRAGMA user_version=27') })
  const reopened = new DeliveryStore({ path: f.path }); stores.add(reopened)
  expect(reopened.inspectOwnerForegroundTaskSource({ ...f.scope, inboxId: f.inboxId }, authority)).toEqual(before)
  expect(reopened.readOwnerForegroundTaskInput({ ...f.scope, inboxId: f.inboxId, expectedSourceDigest: sourceDigest }, authority)).toBeUndefined()
  sql(f.path, db => { expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(31); expect(db.prepare('SELECT termination_json FROM delivery_foreground_executions').get()?.termination_json).toBeNull() })
})

test('permits observed completion input without relaxing the successful content reader contract', async () => {
  const f = await fixture()
  f.store.finishForegroundTaskExecution({ inboxId: f.inboxId, status: 'succeeded', quiescent: true, completedAt: 2, termination: observed('turn-completed') })
  expect(source(f)).toMatchObject({ execution: { status: 'succeeded', quiescent: true, modelSelectionState: 'missing' }, termination: observed('turn-completed') })
  expect(read(f)?.input.text).toBe(f.text)
  expect(f.store.readOwnerForegroundTaskSource({ ...f.scope, inboxId: f.inboxId, expectedSourceDigest: source(f).sourceDigest }, authority)).toBeUndefined()
  f.store.revokePrincipal(f.owner.id, f.owner.version)
  expect(() => f.store.readOwnerForegroundTaskInput({ ...f.scope, inboxId: f.inboxId, expectedSourceDigest: 'f'.repeat(64) }, authority)).toThrow(/owner authority changed/u)
})

test.each(['noncanonical', 'invalid-utf8', 'nul'] as const)('fails closed for %s observation storage instead of treating it as a legacy row', async corruption => {
  const f = await fixture(); finish(f); const before = source(f)
  const canonical = JSON.stringify(observed())
  const bytes = corruption === 'noncanonical' ? Buffer.from(' ' + canonical)
    : corruption === 'nul' ? Buffer.from(canonical + '\0hidden')
      : Buffer.from(canonical.replace('delivery-agent', 'delivery-agXnt'))
  if (corruption === 'invalid-utf8') bytes[bytes.indexOf('X')] = 255
  sql(f.path, db => {
    db.exec('DROP TRIGGER delivery_foreground_termination_immutable; DROP TRIGGER delivery_foreground_termination_update; PRAGMA ignore_check_constraints=ON')
    db.prepare('UPDATE delivery_foreground_executions SET termination_json=CAST(? AS TEXT)').run(bytes)
  })
  expect(f.store.inspectOwnerForegroundTaskSource({ ...f.scope, inboxId: f.inboxId }, authority)).toBeUndefined()
  expect(f.store.readOwnerForegroundTaskInput({ ...f.scope, inboxId: f.inboxId, expectedSourceDigest: before.sourceDigest }, authority)).toBeUndefined()
  f.store.close(); stores.delete(f.store)
  expect(() => new DeliveryStore({ path: f.path })).toThrow(/termination schema/u)
})

test.each(['nul-suffix', 'invalid-utf8', 'noncanonical', 'hash-nul-suffix'] as const)('rejects raw Inbox %s byte drift for observed input and source', async corruption => {
  const f = await fixture('aX原始输入'); finish(f); const before = source(f)
  sql(f.path, db => {
    const row = db.prepare('SELECT CAST(envelope_json AS BLOB) AS bytes, CAST(envelope_hash AS BLOB) AS hash FROM inbox_messages WHERE id=?').get(f.inboxId) as { bytes: Uint8Array; hash: Uint8Array }
    if (corruption === 'hash-nul-suffix') db.prepare('UPDATE inbox_messages SET envelope_hash=CAST(? AS TEXT) WHERE id=?').run(Buffer.concat([row.hash, Buffer.from('\0hidden')]), f.inboxId)
    else {
      const bytes = corruption === 'nul-suffix' ? Buffer.concat([row.bytes, Buffer.from('\0hidden')])
        : corruption === 'noncanonical' ? Buffer.concat([Buffer.from(' '), row.bytes]) : Buffer.from(row.bytes)
      if (corruption === 'invalid-utf8') bytes[bytes.indexOf('X')] = 255
      db.prepare('UPDATE inbox_messages SET envelope_json=CAST(? AS TEXT) WHERE id=?').run(bytes, f.inboxId)
    }
  })
  expect(f.store.inspectOwnerForegroundTaskSource({ ...f.scope, inboxId: f.inboxId }, authority)).toBeUndefined()
  expect(f.store.readOwnerForegroundTaskInput({ ...f.scope, inboxId: f.inboxId, expectedSourceDigest: before.sourceDigest }, authority)).toBeUndefined()
})

test('preserves legitimate escaped U+0000 in canonical original input', async () => {
  const f = await fixture('before\0after 🧪'); finish(f)
  expect(read(f)?.input.text).toBe(f.text)
})
