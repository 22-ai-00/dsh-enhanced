import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { deliverySchemaVersion } from '../src/sqlite.ts'
import { DeliveryStore } from '../src/store.ts'
import type { ConversationRef, ExternalPrincipalKey } from '../src/types.ts'

const roots: string[] = []
const principal: ExternalPrincipalKey = { channel: 'lark', account: 'bot-foreground', tenant: 'tenant-a', user: 'ou-owner' }
const conversation: ConversationRef = { channel: 'lark', account: 'bot-foreground', tenant: 'tenant-a', kind: 'dm', chat: 'oc-owner' }

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-foreground-'))
  roots.push(root)
  const path = join(root, 'delivery.sqlite')
  let now = 1_000
  const store = new DeliveryStore({ path, now: () => now, codeGenerator: () => 'PAIR1234' })
  const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/foreground', agentPreset: 'primary', sessionId: 'session-foreground', policyRef: 'owner-dm' })
  return { path, store, binding, owner: store.getPrincipal(principal)!, advanceTo(value: number) { now = value } }
}

function claimed(store: DeliveryStore, bindingId: string, eventId = 'evt-foreground') {
  const inbox = store.acceptInbound({ channel: 'lark', account: 'bot-foreground', eventId, occurredAt: 1, principal, conversation, kind: 'text', text: 'ordinary user task' }).record
  store.queueInbox(inbox.id, bindingId)
  expect(store.claimInbox({ ownerId: `worker-${eventId}`, leaseMs: 10_000, limit: 1, maxAttempts: 3 })[0]?.record.id).toBe(inbox.id)
  return inbox
}

describe('ordinary foreground execution receipts', () => {
  test('persists exact owner execution and frozen actual model across restart', async () => {
    const { path, store, binding, owner } = await fixture()
    const inbox = claimed(store, binding.id)
    const input = { inboxId: inbox.id, scope: { workspace: '/work/foreground', preset: 'primary' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: 1_001 }
    store.bindForegroundTaskExecution(input)
    store.recordForegroundExecutionModelSelection({ inboxId: inbox.id, provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' })
    store.recordForegroundExecutionModelSelection({ inboxId: inbox.id, provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' })
    store.finishForegroundTaskExecution({ inboxId: inbox.id, status: 'succeeded', quiescent: true, completedAt: 1_002 })
    const ownerInput = { inboxId: inbox.id, scope: input.scope, owner: input.owner, bindingId: binding.id, bindingVersion: binding.version, bindingGeneration: binding.generation }
    expect(store.inspectForegroundExecutionForOwner(ownerInput)).toEqual(expect.objectContaining({ status: 'succeeded', quiescent: true, executionRef: inbox.id, modelSelectionState: 'frozen', modelSelection: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } }))
    expect(() => store.recordForegroundExecutionModelSelection({ inboxId: inbox.id, provider: 'provider-a', model: 'model-a' })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    store.close()
    const reopened = new DeliveryStore({ path })
    expect(reopened.inspectForegroundExecutionForOwner(ownerInput)).toEqual(expect.objectContaining({ status: 'succeeded', modelSelectionState: 'frozen' }))
    reopened.close()
  })

  test('rejects replay and forged owner scope or binding lineage', async () => {
    const { path, store, binding, owner } = await fixture()
    const inbox = claimed(store, binding.id)
    const input = { inboxId: inbox.id, scope: { workspace: '/work/foreground', preset: 'primary' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: 1 }
    for (const forged of [
      { ...input, scope: { ...input.scope, preset: 'other' } },
      { ...input, owner: { ...input.owner, principalVersion: input.owner.principalVersion + 1 } },
      { ...input, binding: { ...input.binding, generation: input.binding.generation + 1 } },
    ]) expect(() => store.bindForegroundTaskExecution(forged)).toThrowError(expect.objectContaining({ code: 'invalid-binding' }))
    store.bindForegroundTaskExecution(input)
    expect(() => store.bindForegroundTaskExecution(input)).toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    store.finishForegroundTaskExecution({ inboxId: inbox.id, status: 'failed', quiescent: true, completedAt: 2 })
    const exact = { inboxId: inbox.id, scope: input.scope, owner: input.owner, bindingId: binding.id, bindingVersion: binding.version, bindingGeneration: binding.generation }
    expect(store.inspectForegroundExecutionForOwner(exact)).toEqual(expect.objectContaining({ status: 'unknown', quiescent: false }))
    for (const forged of [
      { ...exact, scope: { ...exact.scope, preset: 'other' } },
      { ...exact, owner: { ...exact.owner, principalVersion: exact.owner.principalVersion + 1 } },
      { ...exact, bindingVersion: exact.bindingVersion + 1 },
      { ...exact, bindingGeneration: exact.bindingGeneration + 1 },
    ]) expect(store.inspectForegroundExecutionForOwner(forged)).toBeNull()
    store.close()
    const database = new DatabaseSync(path)
    try {
      expect(() => database.prepare('UPDATE delivery_foreground_executions SET execution_ref = NULL WHERE inbox_id = ?').run(inbox.id)).toThrow()
    } finally { database.close() }
  })

  test('permanently marks competing model routes inconsistent and refuses late writes', async () => {
    const { store, binding, owner } = await fixture()
    const inbox = claimed(store, binding.id)
    const input = { inboxId: inbox.id, scope: { workspace: '/work/foreground', preset: 'primary' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: 1 }
    store.bindForegroundTaskExecution(input)
    store.recordForegroundExecutionModelSelection({ inboxId: inbox.id, provider: 'provider-a', model: 'model-a' })
    store.recordForegroundExecutionModelSelection({ inboxId: inbox.id, provider: 'provider-b', model: 'model-b' })
    store.recordForegroundExecutionModelSelection({ inboxId: inbox.id, provider: 'provider-a', model: 'model-a' })
    store.finishForegroundTaskExecution({ inboxId: inbox.id, status: 'succeeded', quiescent: true, completedAt: 2 })
    const receipt = store.inspectForegroundExecutionForOwner({ inboxId: inbox.id, scope: input.scope, owner: input.owner, bindingId: binding.id, bindingVersion: binding.version, bindingGeneration: binding.generation })
    expect(receipt).toEqual(expect.objectContaining({ modelSelectionState: 'inconsistent' }))
    expect(receipt?.modelSelection).toBeUndefined()
    store.close()
  })

  test('makes a crashed ordinary dispatch ambiguous during recovery', async () => {
    const { store, binding, owner, advanceTo } = await fixture()
    const inbox = claimed(store, binding.id, 'evt-recovery')
    store.bindForegroundTaskExecution({ inboxId: inbox.id, scope: { workspace: '/work/foreground', preset: 'primary' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: 1_000 })
    advanceTo(20_000)
    expect(store.recoverInbox({ maxAttempts: 3 })).toEqual([expect.objectContaining({ id: inbox.id, status: 'dead_letter', failureCode: 'dispatch-ambiguous' })])
    store.close()
  })

  test('keeps a completed pre-/new execution readable through its revoked binding snapshot', async () => {
    const { store, binding, owner } = await fixture()
    const inbox = claimed(store, binding.id, 'evt-before-new')
    const input = { inboxId: inbox.id, scope: { workspace: '/work/foreground', preset: 'primary' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: 1 }
    store.bindForegroundTaskExecution(input)
    store.finishForegroundTaskExecution({ inboxId: inbox.id, status: 'succeeded', quiescent: true, completedAt: 2 })
    store.rotateBinding({ bindingId: binding.id, expectedVersion: binding.version, sessionId: 'session-after-new' })
    const revoked = store.getBinding(binding.id)!
    expect(revoked).toMatchObject({ status: 'revoked', version: binding.version + 1, generation: binding.generation })
    expect(store.inspectForegroundExecutionForOwner({ inboxId: inbox.id, scope: input.scope, owner: input.owner, bindingId: binding.id, bindingVersion: revoked.version, bindingGeneration: revoked.generation }))
      .toEqual(expect.objectContaining({ status: 'succeeded', executionRef: inbox.id }))
    expect(store.inspectForegroundExecutionForOwner({ inboxId: inbox.id, scope: input.scope, owner: input.owner, bindingId: binding.id, bindingVersion: binding.version, bindingGeneration: revoked.generation })).toBeNull()
    store.close()
  })

  test('migrates schema 22 without backfilling historical acceptance executions', async () => {
    const { path, store, binding, owner } = await fixture()
    const inbox = claimed(store, binding.id, 'evt-accepted-history')
    store.bindForegroundTaskAcceptance({ inboxId: inbox.id, contractId: 'contract-history', contractDigest: 'a'.repeat(64), scope: { workspace: '/work/foreground', preset: 'primary' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: 1 })
    store.finishForegroundTaskAcceptance({ contractId: 'contract-history', status: 'succeeded', quiescent: true, completedAt: 2 })
    store.close()
    const database = new DatabaseSync(path)
    try {
      database.exec('DROP TABLE delivery_foreground_executions; PRAGMA user_version = 22;')
    } finally { database.close() }
    const migrated = new DeliveryStore({ path })
    expect(migrated.inspectForegroundExecutionForOwner({ inboxId: inbox.id, scope: { workspace: '/work/foreground', preset: 'primary' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, bindingId: binding.id, bindingVersion: binding.version, bindingGeneration: binding.generation })).toBeNull()
    expect(migrated.inspectForegroundAcceptedExecution({ id: 'contract-history', digest: 'a'.repeat(64), scope: { workspace: '/work/foreground', preset: 'primary' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, task: { kind: 'foreground-turn', ref: inbox.id }, objective: 'old contract' })).toEqual(expect.objectContaining({ status: 'succeeded' }))
    migrated.close()
    const inspected = new DatabaseSync(path, { readOnly: true })
    expect(inspected.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delivery_foreground_executions'").get()).toEqual({ name: 'delivery_foreground_executions' })
    inspected.close()
  })
})
