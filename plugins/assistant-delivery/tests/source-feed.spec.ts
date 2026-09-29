import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantDeliveryService, externalPrincipalId, ownerRouteAuthorityHash } from '../src/index.ts'
import { DeliveryStore } from '../src/store.ts'
import { deliverySchemaVersion } from '../src/sqlite.ts'
import type { ConversationBinding, InboundEnvelope, OwnerForegroundTaskSourceScope, OwnerRouteAuthority } from '../src/types.ts'

const roots: string[] = []
const stores = new Set<DeliveryStore>()
const contexts = new Set<Context>()
const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'owner-chat' }
const authority: OwnerRouteAuthority = { id: 'ordinary-owner', principal, conversation,
  workspace: '/work/source-feed', agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.restart()
  contexts.clear()
  for (const store of stores) store.close()
  stores.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function open(path: string, now = () => 1_000) {
  const store = new DeliveryStore({ path, now, codeGenerator: () => 'PAIR1234' })
  stores.add(store)
  return store
}

function pair(store: DeliveryStore) {
  const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const owner = store.getPrincipal(principal)!
  return { owner, scope: { authorityId: authority.id, principalId: externalPrincipalId(principal),
    workspace: authority.workspace, agentPreset: authority.agentPreset,
    expectedOwner: { authorityHash: ownerRouteAuthorityHash(authority), principalRecordId: owner.id,
      principalVersion: owner.version } } satisfies OwnerForegroundTaskSourceScope }
}

function bind(store: DeliveryStore, sessionId = 'original-session') {
  return store.createBinding({ principal, conversation, workspace: authority.workspace,
    agentPreset: authority.agentPreset, policyRef: authority.policyRef, sessionId })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-source-feed-'))
  roots.push(root)
  const path = join(root, 'delivery.sqlite')
  let now = 1_000
  const store = open(path, () => now)
  return { root, path, store, ...pair(store), binding: bind(store), clock(value: number) { now = value } }
}

function dispatch(store: DeliveryStore, binding: ConversationBinding, eventId: string,
  options: { text?: string; model?: boolean; kind?: InboundEnvelope['kind']; metadata?: Record<string, string> } = {}) {
  const owner = store.getPrincipal(binding.principal)!
  const admitted = store.claimNativeInbox({ envelope: { channel: 'lark', account: 'bot', eventId,
    occurredAt: 1, principal, conversation, kind: options.kind ?? 'text', text: options.text ?? 'ordinary owner task',
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }) }, binding,
    ownerLineage: { principalRecordId: owner.id, principalVersion: owner.version }, ownerId: 'native-worker', leaseMs: 100_000 })
  store.bindForegroundTaskExecution({ inboxId: admitted.record.id, scope: { workspace: binding.workspace, preset: binding.agentPreset },
    owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: 1 })
  if (options.model !== false) store.recordForegroundExecutionModelSelection({ inboxId: admitted.record.id, provider: 'frozen-provider', model: 'frozen-model', reasoningEffort: 'high' })
  return admitted
}

function complete(store: DeliveryStore, inboxId: string, completedAt = 2, status: 'succeeded' | 'unknown' = 'succeeded') {
  store.finishForegroundTaskExecution({ inboxId, status, quiescent: status === 'succeeded', completedAt })
}

function processed(store: DeliveryStore, admitted: ReturnType<typeof dispatch>) {
  store.finishInbox({ inboxId: admitted.record.id, ownerId: 'native-worker', fencingToken: admitted.fencingToken!, outcome: 'processed' })
}

function reply(store: DeliveryStore, binding: ConversationBinding, inboxId: string, eventId: string, text = 'ordinary answer') {
  return store.enqueue({ idempotencyKey: `inbound:${inboxId}:reply`, bindingId: binding.id,
    target: { principal, conversation }, text, format: 'plain', replyToEventId: eventId })
}

function sourceInput(f: Awaited<ReturnType<typeof fixture>>, inboxId: string) {
  const source = f.store.listOwnerForegroundTaskSources(f.scope, authority).items.find(item => item.inboxId === inboxId)!
  return { ...f.scope, inboxId, expectedSourceDigest: source.sourceDigest }
}

describe('durable owner foreground completion feed', () => {
  test('does not miss reverse completions across pagination, two writers, equal timestamps, and a backwards clock', async () => {
    const f = await fixture()
    const second = open(f.path)
    const firstInbox = dispatch(f.store, f.binding, 'first')
    processed(f.store, firstInbox)
    const secondInbox = dispatch(f.store, f.binding, 'second')
    processed(f.store, secondInbox)
    const thirdInbox = dispatch(f.store, f.binding, 'third')
    expect(f.store.listOwnerForegroundTaskSources(f.scope, authority)).toMatchObject({ items: [], watermark: 0, hasMore: false })
    complete(second, secondInbox.record.id, 100)
    const firstPage = f.store.listOwnerForegroundTaskSources({ ...f.scope, limit: 1 }, authority)
    expect(firstPage.items.map(item => item.inboxId)).toEqual([secondInbox.record.id])
    expect(firstPage.items[0]!.admissionCursor.sequence).toBe(2)
    f.clock(20)
    complete(f.store, firstInbox.record.id, 100)
    complete(second, thirdInbox.record.id, 50)
    const page = second.listOwnerForegroundTaskSources({ ...f.scope, after: firstPage.nextCursor, limit: 1 }, authority)
    expect(page).toMatchObject({ watermark: 3, hasMore: true })
    expect(page.items.map(item => item.inboxId)).toEqual([firstInbox.record.id])
    const last = f.store.listOwnerForegroundTaskSources({ ...f.scope, after: page.nextCursor, limit: 1 }, authority)
    expect(last.items.map(item => item.inboxId)).toEqual([thirdInbox.record.id])
    expect(last).toMatchObject({ watermark: 3, hasMore: false, nextCursor: { sequence: 3 } })
    f.store.close(); second.close()
    const reopened = open(f.path)
    expect(reopened.listOwnerForegroundTaskSources(f.scope, authority).items.map(item => item.completionSequence)).toEqual([1, 2, 3])
    expect(reopened.listOwnerForegroundTaskSources({ ...f.scope, after: last.nextCursor }, authority).items).toEqual([])
  })

  test('publishes completion before Inbox processed and Outbox accepted without changing its source digest', async () => {
    const f = await fixture()
    const admitted = dispatch(f.store, f.binding, 'early', { metadata: { provider: 'private-envelope-metadata' } })
    complete(f.store, admitted.record.id)
    const input = sourceInput(f, admitted.record.id)
    expect(f.store.getInbox(admitted.record.id)?.status).toBe('claimed')
    expect(f.store.readOwnerForegroundTaskSource(input, authority)).toBeUndefined()
    const outbox = reply(f.store, f.binding, admitted.record.id, 'early')
    expect(outbox.status).toBe('pending')
    const content = f.store.readOwnerForegroundTaskSource(input, authority)!
    expect(content.source.execution).toMatchObject({ status: 'succeeded', quiescent: true,
      modelSelection: { provider: 'frozen-provider', model: 'frozen-model' } })
    expect(content.input.text).toBe('ordinary owner task')
    expect(JSON.stringify(content)).not.toContain('private-envelope-metadata')
    f.store.finishInbox({ inboxId: admitted.record.id, ownerId: 'native-worker', fencingToken: admitted.fencingToken!, outcome: 'processed' })
    const database = new DatabaseSync(f.path)
    try { database.prepare("UPDATE outbox_messages SET status = 'accepted' WHERE id = ?").run(outbox.id) }
    finally { database.close() }
    expect(f.store.readOwnerForegroundTaskSource(input, authority)).toEqual(content)
    expect(f.store.listOwnerForegroundTaskSources(f.scope, authority).watermark).toBe(1)
  })

  test('retains cursor and original source identity after /new, but rejects owner revoke and ABA', async () => {
    const f = await fixture()
    const inbox = dispatch(f.store, f.binding, 'before-new')
    complete(f.store, inbox.record.id); reply(f.store, f.binding, inbox.record.id, 'before-new')
    const page = f.store.listOwnerForegroundTaskSources(f.scope, authority)
    const input = sourceInput(f, inbox.record.id)
    const original = f.store.readOwnerForegroundTaskSource(input, authority)!
    processed(f.store, inbox)
    const rotated = f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version, sessionId: 'after-new' })
    expect(f.store.readOwnerForegroundTaskSource(input, authority)).toEqual(original)
    const newer = dispatch(f.store, rotated, 'after-new')
    complete(f.store, newer.record.id)
    expect(f.store.listOwnerForegroundTaskSources({ ...f.scope, after: page.nextCursor }, authority).items.map(item => item.inboxId)).toEqual([newer.record.id])
    f.store.revokePrincipal(f.owner.id, f.owner.version)
    expect(() => f.store.readOwnerForegroundTaskSource(input, authority)).toThrow(/owner authority changed/u)
    const repaired = pair(f.store)
    bind(f.store, 'after-owner-aba')
    expect(repaired.owner.id).toBe(f.owner.id)
    expect(repaired.owner.version).toBeGreaterThan(f.owner.version)
    expect(() => f.store.listOwnerForegroundTaskSources({ ...repaired.scope, after: page.nextCursor }, authority)).toThrow(/cursor/u)
    expect(f.store.listOwnerForegroundTaskSources(repaired.scope, authority).items).toEqual([])
    expect(f.store.readOwnerForegroundTaskSource({ ...input, ...repaired.scope }, authority)).toBeUndefined()
  })

  test('rejects cursor protocol/epoch/scope/sequence forgery and authority or generation-floor changes', async () => {
    const f = await fixture()
    const inbox = dispatch(f.store, f.binding, 'cursor')
    complete(f.store, inbox.record.id)
    const page = f.store.listOwnerForegroundTaskSources(f.scope, authority)
    for (const change of [{ protocol: 'other' }, { epoch: '0'.repeat(32) }, { scopeKey: 'f'.repeat(64) },
      { sequence: -1 }, { sequence: 2 }, { sequence: 0.5 }]) {
      expect(() => f.store.listOwnerForegroundTaskSources({ ...f.scope, after: { ...page.nextCursor, ...change } as typeof page.nextCursor }, authority)).toThrow(/cursor/u)
    }
    for (const limit of [0, 101, 1.5]) expect(() => f.store.listOwnerForegroundTaskSources({ ...f.scope, limit }, authority)).toThrow(/limit/u)
    expect(() => f.store.listOwnerForegroundTaskSources(f.scope, { ...authority, minimumGeneration: 2 })).toThrow(/owner/u)
    const changed = { ...authority, minimumGeneration: 2 }
    f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version, sessionId: 'new-floor' })
    const changedScope = { ...f.scope, expectedOwner: { ...f.scope.expectedOwner, authorityHash: ownerRouteAuthorityHash(changed) } }
    expect(f.store.listOwnerForegroundTaskSources(changedScope, changed).items).toEqual([])
    expect(() => f.store.listOwnerForegroundTaskSources({ ...changedScope, after: page.nextCursor }, changed)).toThrow(/cursor/u)
  })

  test('includes unknown/missing/inconsistent-model metadata while withholding their content', async () => {
    const f = await fixture()
    for (const name of ['unknown', 'missing', 'inconsistent']) {
      const inbox = dispatch(f.store, f.binding, name, { model: name !== 'missing' })
      if (name === 'inconsistent') f.store.recordForegroundExecutionModelSelection({ inboxId: inbox.record.id, provider: 'another', model: 'other' })
      complete(f.store, inbox.record.id, 2, name === 'unknown' ? 'unknown' : 'succeeded')
      reply(f.store, f.binding, inbox.record.id, name)
      expect(f.store.readOwnerForegroundTaskSource(sourceInput(f, inbox.record.id), authority)).toBeUndefined()
      processed(f.store, inbox)
    }
    expect(f.store.listOwnerForegroundTaskSources(f.scope, authority).items.map(item => item.execution.status)).toEqual(['unknown', 'succeeded', 'succeeded'])
  })

  test('returns UTF-8 byte prefixes and full-content digests without leaking envelope fields', async () => {
    const f = await fixture()
    const text = '😀你a'.repeat(4_000)
    const inbox = dispatch(f.store, f.binding, 'utf8', { text })
    complete(f.store, inbox.record.id); reply(f.store, f.binding, inbox.record.id, 'utf8', text)
    const input = sourceInput(f, inbox.record.id)
    const small = f.store.readOwnerForegroundTaskSource({ ...input, maxInputBytes: 6, maxReplyBytes: 7 }, authority)!
    expect(small.input).toEqual({ text: '😀', fullTextDigest: hash(text), returnedBytes: 4, fullBytes: 32_000, truncated: true })
    expect(small.reply).toMatchObject({ text: '😀你', returnedBytes: 7, fullBytes: 32_000, fullTextDigest: hash(text), truncated: true })
    const fullBudget = f.store.readOwnerForegroundTaskSource(input, authority)!
    expect(fullBudget.input.returnedBytes).toBeLessThanOrEqual(16_384)
    expect(fullBudget.input.text).not.toContain('�')
    expect(fullBudget.contentDigest).toBe(small.contentDigest)
    expect(fullBudget.reply.intentDigest).toMatch(/^[a-f0-9]{64}$/u)
    for (const limit of [0, -1, 16_385, 1.5]) {
      expect(() => f.store.readOwnerForegroundTaskSource({ ...input, maxInputBytes: limit }, authority)).toThrow(/byte limit/u)
      expect(() => f.store.readOwnerForegroundTaskSource({ ...input, maxReplyBytes: limit }, authority)).toThrow(/byte limit/u)
    }
  })

  test('requires the exact ordinary reply and refuses internal card payloads, metadata, route and event drift', async () => {
    const f = await fixture()
    const inbox = dispatch(f.store, f.binding, 'exact-reply')
    complete(f.store, inbox.record.id)
    const input = sourceInput(f, inbox.record.id)
    expect(() => reply(f.store, f.binding, inbox.record.id, 'wrong-event')).toThrow(/exact bound Inbox event/u)
    expect(f.store.readOwnerForegroundTaskSource(input, authority)).toBeUndefined()
    reply(f.store, f.binding, inbox.record.id, 'exact-reply')
    const database = new DatabaseSync(f.path)
    try {
      const original = f.store.getOutboxByIdempotencyKey(`inbound:${inbox.record.id}:reply`)!
      const good = { ...original.intent, replyToEventId: 'exact-reply' }
      const update = (intent: typeof good) => database.prepare('UPDATE outbox_messages SET intent_json = ?, intent_hash = ? WHERE id = ?')
        .run(JSON.stringify(intent), hash(JSON.stringify(intent)), original.id)
      update(good)
      expect(f.store.readOwnerForegroundTaskSource(input, authority)).toBeDefined()
      for (const bad of [
        { ...good, format: 'approval', approval: { operationId: 'internal' } },
        { ...good, format: 'model-picker', modelPicker: { operationId: 'internal' } },
        { ...good, format: 'permission-picker', permissionPicker: { operationId: 'internal' } },
        { ...good, metadata: { 'dsh.internal': 'private' } },
        { ...good, bindingId: 'wrong-binding' },
        { ...good, replyToEventId: 'wrong-event' },
        { ...good, target: { ...good.target, principal: { ...principal, user: 'another' } } },
      ]) {
        update(bad as typeof good)
        expect(f.store.readOwnerForegroundTaskSource(input, authority)).toBeUndefined()
      }
      update(good)
      expect(f.store.readOwnerForegroundTaskSource({ ...input, expectedSourceDigest: 'f'.repeat(64) }, authority)).toBeUndefined()
      const envelope = { ...f.store.getInbox(inbox.record.id)!.envelope, text: 'tampered source' }
      database.prepare('UPDATE inbox_messages SET envelope_json = ? WHERE id = ?').run(JSON.stringify(envelope), inbox.record.id)
      expect(f.store.readOwnerForegroundTaskSource(input, authority)).toBeUndefined()
      expect(f.store.listOwnerForegroundTaskSources(f.scope, authority)).toMatchObject({ items: [], watermark: 1, nextCursor: { sequence: 1 } })
    } finally { database.close() }
  })

  test('excludes Delivery control inputs from ordinary sources', async () => {
    const f = await fixture()
    for (const [index, text] of ['/model', '/permission auto', '/feedback helpful', '/new'].entries()) {
      const inbox = dispatch(f.store, f.binding, `control-${index}`, { text, kind: 'command' })
      complete(f.store, inbox.record.id)
      processed(f.store, inbox)
    }
    expect(f.store.listOwnerForegroundTaskSources(f.scope, authority)).toMatchObject({ items: [], watermark: 4, hasMore: false })
  })

  test('backfills v24 terminal receipts deterministically and orders old already-open writer completions atomically', async () => {
    const f = await fixture()
    const first = dispatch(f.store, f.binding, 'history-first')
    processed(f.store, first)
    const second = dispatch(f.store, f.binding, 'history-second')
    processed(f.store, second)
    const pending = dispatch(f.store, f.binding, 'old-writer', { model: false })
    complete(f.store, first.record.id, 100); complete(f.store, second.record.id, 50)
    f.store.close()
    const old = new DatabaseSync(f.path)
    try {
      old.exec(`DROP TRIGGER delivery_foreground_identity_immutable;
        DROP TRIGGER delivery_foreground_terminal_immutable;
        DROP TRIGGER delivery_foreground_terminal_delete_immutable;
        DROP TRIGGER delivery_foreground_completion_after_update;
        DROP TRIGGER delivery_foreground_completion_after_insert;
        DROP INDEX delivery_foreground_completion_order;
        DROP INDEX delivery_foreground_owner_completion_order;
        ALTER TABLE delivery_foreground_executions DROP COLUMN completion_sequence;
        DROP TABLE delivery_foreground_completion_clock; PRAGMA user_version = 24;`)
      const legacyModel = old.prepare("UPDATE delivery_foreground_executions SET model_selection_state = 'frozen', model_provider = ?, model_id = ? WHERE inbox_id = ? AND status = 'pending'")
      const legacyFinish = old.prepare("UPDATE delivery_foreground_executions SET status = 'succeeded', quiescent = 1, completed_at = ?, execution_ref = inbox_id WHERE inbox_id = ? AND status = 'pending'")
      const migrated = open(f.path)
      expect(migrated.listOwnerForegroundTaskSources(f.scope, authority).items.map(item => item.inboxId)).toEqual([second.record.id, first.record.id])
      legacyModel.run('old-provider', 'old-model', pending.record.id)
      legacyFinish.run(2, pending.record.id)
      expect(migrated.listOwnerForegroundTaskSources(f.scope, authority).items.map(item => item.completionSequence)).toEqual([1, 2, 3])
      expect(old.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
      for (const sql of ["status = 'unknown', quiescent = 0", 'completed_at = 999', "model_id = 'forged'", 'completion_sequence = 9', "workspace = '/forged'"]) {
        expect(() => old.prepare(`UPDATE delivery_foreground_executions SET ${sql} WHERE inbox_id = ?`).run(pending.record.id)).toThrow(/immutable/u)
      }
      expect(() => old.prepare('DELETE FROM delivery_foreground_executions WHERE inbox_id = ?').run(pending.record.id)).toThrow(/immutable/u)
      expect(migrated.listOwnerForegroundTaskSources(f.scope, authority).watermark).toBe(3)
    } finally { old.close() }
  })

  test('holds a synchronous source fence against another writer and rolls back callback failures or thenables', async () => {
    const f = await fixture()
    const inbox = dispatch(f.store, f.binding, 'fenced')
    complete(f.store, inbox.record.id); reply(f.store, f.binding, inbox.record.id, 'fenced')
    const input = sourceInput(f, inbox.record.id)
    const other = open(f.path)
    ;(other as unknown as { database: DatabaseSync }).database.exec('PRAGMA busy_timeout = 0')
    const inspector = new DatabaseSync(f.path, { readOnly: true })
    try {
      const before = f.store.getInbox(inbox.record.id)!.status
      const result = f.store.withOwnerForegroundTaskSourceFence(input, authority, content => {
        expect(content.source.inboxId).toBe(inbox.record.id)
        expect(() => other.revokePrincipal(f.owner.id, f.owner.version)).toThrow(/locked/u)
        return 'committed'
      })
      expect(result).toBe('committed')
      const finish = () => f.store.finishInbox({ inboxId: inbox.record.id, ownerId: 'native-worker', fencingToken: inbox.fencingToken!, outcome: 'processed' })
      // Use the existing connection's native statement to demonstrate rollback;
      // calling a public transaction inside this transaction would nest BEGIN.
      const writer = (f.store as unknown as { database: DatabaseSync }).database
      const change = () => writer.prepare("UPDATE inbox_messages SET status = 'processed' WHERE id = ?").run(inbox.record.id)
      expect(() => f.store.withOwnerForegroundTaskSourceFence(input, authority, () => { change(); throw new Error('consumer failed') })).toThrow('consumer failed')
      expect(inspector.prepare('SELECT status FROM inbox_messages WHERE id = ?').get(inbox.record.id)).toEqual({ status: before })
      expect(() => f.store.withOwnerForegroundTaskSourceFence(input, authority, () => { change(); return Promise.resolve('late') })).toThrow(/synchronous/u)
      // eslint-disable-next-line unicorn/no-thenable -- This test verifies that untrusted thenables are rejected without invocation.
      expect(() => f.store.withOwnerForegroundTaskSourceFence(input, authority, () => ({ then() { throw new Error('must not run') } }))).toThrow(/synchronous/u)
      expect(inspector.prepare('SELECT status FROM inbox_messages WHERE id = ?').get(inbox.record.id)).toEqual({ status: before })
      expect(() => f.store.withOwnerForegroundTaskSourceFence({ ...input, expectedSourceDigest: 'f'.repeat(64) }, authority, () => 'bad')).toThrow(/unavailable or changed/u)
      finish()
      other.revokePrincipal(f.owner.id, f.owner.version)
      expect(() => f.store.withOwnerForegroundTaskSourceFence(input, authority, () => 'bad')).toThrow(/owner authority changed/u)
    } finally { inspector.close() }
  })

  test('exposes the same Host-only service API and invalidates it on Fiber disposal', async () => {
    const f = await fixture()
    const inbox = dispatch(f.store, f.binding, 'service')
    complete(f.store, inbox.record.id); reply(f.store, f.binding, inbox.record.id, 'service')
    const input = sourceInput(f, inbox.record.id)
    const ctx = new Context(); contexts.add(ctx)
    await ctx.plugin(AssistantPolicyService, { databasePath: join(f.root, 'policy.sqlite'), rules: [] })
    await ctx.plugin(AssistantDeliveryService, { databasePath: f.path, spoolPath: join(f.root, 'spool'), schedulerEnabled: false, ownerRoutes: [authority] })
    expect(ctx.assistantDelivery.listOwnerForegroundTaskSources(f.scope).items[0]!.sourceDigest).toBe(input.expectedSourceDigest)
    expect(ctx.assistantDelivery.readOwnerForegroundTaskSource(input)?.source.execution.modelSelection?.model).toBe('frozen-model')
    expect(ctx.assistantDelivery.withOwnerForegroundTaskSourceFence(input, content => content.reply.text)).toBe('ordinary answer')
    const service = ctx.assistantDelivery
    await ctx.fiber.restart(); contexts.delete(ctx)
    expect(() => service.listOwnerForegroundTaskSources(f.scope)).toThrow()
  })
})
