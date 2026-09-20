import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'
import type { ConversationRef, ExternalPrincipalKey } from '../src/types.ts'

const roots: string[] = []
const principal: ExternalPrincipalKey = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation: ConversationRef = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm', chat: 'oc_owner' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-binding-'))
  roots.push(root)
  let now = 1_000
  const path = join(root, 'delivery.sqlite')
  const store = new DeliveryStore({ path, now: () => now, codeGenerator: () => 'PAIR1234' })
  return { path, store, tick() { now += 1 } }
}

function authorize(store: DeliveryStore): void {
  const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
}

describe('conversation bindings', () => {
  test('persists a random database instance namespace and rotates it when the database is rebuilt', async () => {
    const { path, store } = await fixture()
    const first = store.instanceId()
    expect(first).toMatch(/^[0-9a-f]{32}$/u)
    store.close()

    const reopened = new DeliveryStore({ path })
    expect(reopened.instanceId()).toBe(first)
    reopened.close()

    await Promise.all([
      rm(path, { force: true }),
      rm(`${path}-shm`, { force: true }),
      rm(`${path}-wal`, { force: true }),
    ])
    const rebuilt = new DeliveryStore({ path })
    expect(rebuilt.instanceId()).toMatch(/^[0-9a-f]{32}$/u)
    expect(rebuilt.instanceId()).not.toBe(first)
    rebuilt.close()
  })

  test('re-pairs a revoked principal with the next durable conversation generation', async () => {
    const { store, tick } = await fixture()
    authorize(store)
    const first = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'session-1', policyRef: 'owner-dm' })
    const owner = store.getPrincipal(principal)!
    store.revokePrincipal(owner.id, owner.version)
    tick()
    authorize(store)

    expect(store.nextBindingGeneration(conversation)).toBe(2)
    const second = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'session-2', policyRef: 'owner-dm', expectedGeneration: 2 })

    expect(second).toMatchObject({ generation: 2, sessionId: 'session-2', status: 'active' })
    expect(store.listBindings(conversation)).toEqual([
      second,
      expect.objectContaining({ id: first.id, generation: 1, status: 'revoked' }),
    ])
    expect(() => store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'stale-session', policyRef: 'owner-dm', expectedGeneration: 1 }))
      .toThrowError(expect.objectContaining({ code: 'version-conflict' }))
    store.close()
  })

  test('requires an active paired principal and absolute workspace', async () => {
    const { store } = await fixture()
    const input = { conversation, principal, workspace: '/work/alpha', agentPreset: 'primary', sessionId: 'session-1', policyRef: 'owner-dm' }
    expect(() => store.createBinding(input)).toThrowError(expect.objectContaining({ code: 'unauthorized-principal' }))
    authorize(store)
    expect(() => store.createBinding({ ...input, workspace: 'relative' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-binding' }))
    store.close()
  })

  test('creates one active binding and returns the winner of duplicate creation', async () => {
    const { store } = await fixture()
    authorize(store)
    const input = { conversation, principal, workspace: '/work/alpha', agentPreset: 'primary', sessionId: 'session-1', policyRef: 'owner-dm' }
    const first = store.createBinding(input)
    expect(first).toMatchObject({ generation: 1, sessionId: 'session-1', status: 'active', version: 1 })
    expect(store.createBinding({ ...input, sessionId: 'losing-session' })).toEqual(first)
    expect(store.getActiveBinding(conversation)).toEqual(first)
    store.close()
  })

  test('persists an immutable accepted foreground execution before dispatch and survives restart', async () => {
    const { path, store } = await fixture()
    authorize(store)
    const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'session-acceptance', policyRef: 'owner-dm' })
    const inbox = store.acceptInbound({ channel: 'lark', account: 'bot-1', eventId: 'evt-acceptance', occurredAt: 1,
      principal, conversation, kind: 'text', text: 'preserve  exact objective\n' }).record
    store.queueInbox(inbox.id, binding.id)
    const claim = store.claimInbox({ ownerId: 'test-owner', leaseMs: 10_000, limit: 1, maxAttempts: 3 })[0]!
    const owner = store.getPrincipal(principal)!
    const contract = {
      id: 'contract-foreground-1', digest: 'a'.repeat(64),
      scope: { workspace: '/work/alpha', preset: 'primary' },
      owner: { principalRecordId: owner.id, principalVersion: owner.version },
      task: { kind: 'foreground-turn' as const, ref: inbox.id }, objective: 'preserve  exact objective\n',
    }
    store.bindForegroundTaskAcceptance({ inboxId: inbox.id, contractId: contract.id, contractDigest: contract.digest,
      scope: contract.scope, owner: contract.owner, binding, dispatchedAt: 1_000 })
    expect(store.inspectForegroundAcceptedExecution(contract)).toBeNull()
    store.recordForegroundTaskModelSelection({ contractId: contract.id, provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' })
    store.recordForegroundTaskModelSelection({ contractId: contract.id, provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' })
    expect(() => store.bindForegroundTaskAcceptance({ inboxId: inbox.id, contractId: contract.id,
      contractDigest: 'b'.repeat(64), scope: contract.scope, owner: contract.owner, binding, dispatchedAt: 1_000 }))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    store.finishForegroundTaskAcceptance({ contractId: contract.id, status: 'succeeded', quiescent: true, completedAt: 1_001 })
    expect(store.inspectForegroundAcceptedExecution(contract)).toEqual(expect.objectContaining({
      contractId: contract.id, dispatchedAt: 1_000, status: 'succeeded', quiescent: true, executionRef: inbox.id,
      modelSelectionState: 'frozen', modelSelection: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
    }))
    expect(() => store.recordForegroundTaskModelSelection({ contractId: contract.id,
      provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.inspectForegroundAcceptedExecutionForOwner({
      inboxId: inbox.id, scope: contract.scope, owner: contract.owner, bindingId: binding.id,
    })).toEqual(expect.objectContaining({ contractId: contract.id, executionRef: inbox.id }))
    expect(store.inspectForegroundAcceptedExecutionForOwner({
      inboxId: inbox.id, scope: contract.scope, owner: { ...contract.owner, principalVersion: contract.owner.principalVersion + 1 }, bindingId: binding.id,
    })).toBeNull()
    store.finishInbox({ inboxId: claim.record.id, ownerId: 'test-owner', fencingToken: claim.fencingToken, outcome: 'processed' })
    const legacyInbox = store.acceptInbound({ channel: 'lark', account: 'bot-1', eventId: 'evt-acceptance-missing-route', occurredAt: 2,
      principal, conversation, kind: 'text', text: 'legacy route unavailable' }).record
    store.queueInbox(legacyInbox.id, binding.id)
    const legacyClaim = store.claimInbox({ ownerId: 'test-owner-legacy', leaseMs: 10_000, limit: 1, maxAttempts: 3 })[0]
    expect(legacyClaim?.record.id).toBe(legacyInbox.id)
    const legacyContract = { ...contract, id: 'contract-foreground-missing-route', digest: 'c'.repeat(64),
      task: { kind: 'foreground-turn' as const, ref: legacyInbox.id } }
    store.bindForegroundTaskAcceptance({ inboxId: legacyInbox.id, contractId: legacyContract.id,
      contractDigest: legacyContract.digest, scope: legacyContract.scope, owner: legacyContract.owner, binding, dispatchedAt: 1_002 })
    store.finishForegroundTaskAcceptance({ contractId: legacyContract.id, status: 'succeeded', quiescent: true, completedAt: 1_003 })
    expect(store.inspectForegroundAcceptedExecution(legacyContract)).toEqual(expect.objectContaining({ modelSelectionState: 'missing' }))
    expect(() => store.recordForegroundTaskModelSelection({ contractId: legacyContract.id, provider: 'provider-a', model: 'model-a' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    store.close()

    const reopened = new DeliveryStore({ path })
    expect(reopened.inspectForegroundAcceptedExecution(contract)).toEqual(expect.objectContaining({ status: 'succeeded', modelSelection: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } }))
    expect(reopened.inspectForegroundAcceptedExecution({ ...contract, task: { kind: 'foreground-turn', ref: 'other' } })).toBeNull()
    reopened.close()
    void claim
  })

  test('keeps an accepted execution inconsistent after distinct live request routes', async () => {
    const { store } = await fixture()
    authorize(store)
    const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'session-inconsistent', policyRef: 'owner-dm' })
    const inbox = store.acceptInbound({ channel: 'lark', account: 'bot-1', eventId: 'evt-inconsistent', occurredAt: 1,
      principal, conversation, kind: 'text', text: 'route consistency' }).record
    store.queueInbox(inbox.id, binding.id)
    store.claimInbox({ ownerId: 'test-owner', leaseMs: 10_000, limit: 1, maxAttempts: 3 })
    const owner = store.getPrincipal(principal)!
    const contract = { id: 'contract-inconsistent', digest: 'b'.repeat(64), scope: { workspace: '/work/alpha', preset: 'primary' },
      owner: { principalRecordId: owner.id, principalVersion: owner.version }, task: { kind: 'foreground-turn' as const, ref: inbox.id }, objective: 'route consistency' }
    store.bindForegroundTaskAcceptance({ inboxId: inbox.id, contractId: contract.id, contractDigest: contract.digest,
      scope: contract.scope, owner: contract.owner, binding, dispatchedAt: 1 })
    store.recordForegroundTaskModelSelection({ contractId: contract.id, provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' })
    store.recordForegroundTaskModelSelection({ contractId: contract.id, provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' })
    store.recordForegroundTaskModelSelection({ contractId: contract.id, provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' })
    store.finishForegroundTaskAcceptance({ contractId: contract.id, status: 'succeeded', quiescent: true, completedAt: 2 })
    expect(store.inspectForegroundAcceptedExecution(contract)).toEqual(expect.objectContaining({ modelSelectionState: 'inconsistent' }))
    expect(store.inspectForegroundAcceptedExecution(contract)?.modelSelection).toBeUndefined()
    store.close()
  })

  test('migrates a v21 foreground acceptance table once and leaves legacy routes missing', async () => {
    const { path, store } = await fixture()
    store.close()
    const database = new DatabaseSync(path)
    try {
      database.exec(`ALTER TABLE delivery_task_acceptance_executions DROP COLUMN model_reasoning_effort;
        ALTER TABLE delivery_task_acceptance_executions DROP COLUMN model_id;
        ALTER TABLE delivery_task_acceptance_executions DROP COLUMN model_provider;
        ALTER TABLE delivery_task_acceptance_executions DROP COLUMN model_selection_state;
        PRAGMA user_version = 21;`)
    } finally { database.close() }
    const migrated = new DeliveryStore({ path })
    migrated.close()
    const inspected = new DatabaseSync(path, { readOnly: true })
    const columns = (inspected.prepare('PRAGMA table_info(delivery_task_acceptance_executions)').all() as Array<{ name: string }>)
      .map(row => row.name)
    expect(columns).toEqual(expect.arrayContaining(['model_selection_state', 'model_provider', 'model_id', 'model_reasoning_effort']))
    expect(inspected.prepare('PRAGMA user_version').get()).toEqual({ user_version: 22 })
    inspected.close()
  })

  test('/new preserves old history and atomically increments generation', async () => {
    const { store, tick } = await fixture()
    authorize(store)
    const first = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'session-1', policyRef: 'owner-dm' })
    tick()
    const second = store.rotateBinding({ bindingId: first.id, expectedVersion: 1, sessionId: 'session-2' })
    expect(second).toMatchObject({ generation: 2, sessionId: 'session-2', status: 'active' })
    expect(store.getBinding(first.id)).toMatchObject({ generation: 1, status: 'revoked' })
    expect(store.listBindings(conversation)).toEqual([second, expect.objectContaining({ id: first.id, status: 'revoked' })])
    expect(() => store.rotateBinding({ bindingId: first.id, expectedVersion: 1, sessionId: 'session-3' }))
      .toThrowError(expect.objectContaining({ code: 'version-conflict' }))
    store.close()
  })

  test('isolates account, tenant, chat, and thread keys', async () => {
    const { store } = await fixture()
    authorize(store)
    store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
      sessionId: 'session-1', policyRef: 'owner-dm' })
    for (const changed of [
      { ...conversation, account: 'bot-2' }, { ...conversation, tenant: 'tenant-b' }, { ...conversation, chat: 'oc_other' },
      { ...conversation, kind: 'group' as const, thread: 'thread-1' },
    ]) expect(store.getActiveBinding(changed)).toBeUndefined()
    store.close()
  })

  test('persists one model selection per canonical conversation independently of binding generations', async () => {
    const { store, tick } = await fixture()
    expect(store.getModelSelection(conversation)).toBeUndefined()
    const first = store.setModelSelection(conversation, { provider: 'codex-subscription', model: 'default' })
    expect(first).toMatchObject({ provider: 'codex-subscription', model: 'default', version: 1, updatedAt: 1_000 })
    tick()
    expect(store.setModelSelection(conversation, { provider: 'codex-subscription', model: 'default' })).toEqual(first)
    expect(store.setModelSelection(conversation, {
      provider: 'claude-subscription', model: 'sonnet', reasoningEffort: 'high',
    })).toMatchObject({
      provider: 'claude-subscription', model: 'sonnet', reasoningEffort: 'high', version: 2, updatedAt: 1_001,
    })
    expect(store.getModelSelection({ ...conversation, chat: 'oc_other' })).toBeUndefined()
    expect(store.clearModelSelection(conversation)).toBe(true)
    expect(store.clearModelSelection(conversation)).toBe(false)
    expect(store.getModelSelection(conversation)).toBeUndefined()
    store.close()
  })
})
