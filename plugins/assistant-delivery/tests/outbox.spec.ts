import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'
import type { DeliveryReceipt, OutboundIntent } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-outbox-'))
  roots.push(root)
  let now = 1_000
  const databasePath = join(root, 'delivery.sqlite')
  const store = new DeliveryStore({ path: databasePath, now: () => now, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
  const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
  const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
    sessionId: 'session-1', policyRef: 'owner-dm' })
  return { binding, databasePath, principal, conversation, store, setNow(value: number) { now = value } }
}

function intent(key: string, f: Awaited<ReturnType<typeof fixture>>, text = 'hello'): OutboundIntent {
  return { idempotencyKey: key, bindingId: f.binding.id, target: { principal: f.principal, conversation: f.conversation },
    text, format: 'plain' }
}

function addBinding(value: Awaited<ReturnType<typeof fixture>>, index: number) {
  const principal = { ...value.principal, user: `ou_batch_${index}` }
  const issued = value.store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  value.store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const conversation = { ...value.conversation, chat: `oc_batch_${index}` }
  const binding = value.store.createBinding({ conversation, principal, workspace: `/work/batch-${index}`,
    agentPreset: 'primary', sessionId: `session-batch-${index}`, policyRef: 'owner-dm' })
  return { binding, conversation, principal }
}

function routeIntent(key: string, route: ReturnType<typeof addBinding>): OutboundIntent {
  return { idempotencyKey: key, bindingId: route.binding.id,
    target: { principal: route.principal, conversation: route.conversation }, text: 'hello', format: 'plain' }
}

describe('durable outbox', () => {
  test('persists immutable idempotent intents before any adapter work', async () => {
    const f = await fixture()
    const first = f.store.enqueue(intent('automation:one:owner', f))
    expect(first).toMatchObject({ status: 'pending', attemptCount: 0 })
    expect(f.store.enqueue(intent('automation:one:owner', f))).toEqual(first)
    expect(() => f.store.enqueue(intent('automation:one:owner', f, 'changed')))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    f.store.close()
  })

  test('rejects arbitrary or mismatched routes and bounded content violations', async () => {
    const f = await fixture()
    expect(() => f.store.enqueue({ ...intent('route-1', f), bindingId: 'forged' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...intent('route-2', f), target: {
      ...intent('route-2', f).target, conversation: { ...f.conversation, chat: 'other' },
    } })).toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue(intent('route-3', f, 'x'.repeat(65_537))))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    f.store.close()
  })

  test('stores only a typed, bounded approval card intent', async () => {
    const f = await fixture()
    const approval: OutboundIntent = {
      ...intent('approval:one', f, 'Approve this reviewed action?'),
      format: 'approval',
      approval: {
        operationId: 'operation-1', proposalId: 'proposal-1', expectedVersion: 1,
        expiresAt: 10_000, title: 'Approval required', diffHash: 'a'.repeat(64),
      },
    }
    expect(f.store.enqueue(approval)).toMatchObject({ status: 'pending', intent: approval })
    expect(() => f.store.enqueue({ ...intent('approval:missing', f), format: 'approval' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...intent('approval:forged', f), approval: approval.approval! }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...approval, idempotencyKey: 'approval:bad-expiry',
      approval: { ...approval.approval!, expiresAt: -1 } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...approval, idempotencyKey: 'approval:bad-diff-hash',
      approval: { ...approval.approval!, diffHash: 'forged' } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(f.store.getApprovalIntent('operation-1', f.binding.id)).toEqual(approval.approval)
    expect(f.store.getApprovalIntent('operation-1', 'another-binding')).toBeUndefined()
    f.store.close()
  })

  test('stores only a typed, bounded model-picker intent', async () => {
    const f = await fixture()
    const modelPicker: OutboundIntent = {
      ...intent('model-picker:one', f, '请选择模型'),
      format: 'model-picker',
      modelPicker: {
        operationId: 'model-picker-1',
        expiresAt: 10_000,
        current: { provider: 'codex-subscription', model: 'default', reasoningEffort: 'high' },
        providers: [{ id: 'codex-subscription', name: 'Codex' }],
        models: [{ provider: 'codex-subscription', id: 'default', name: 'Default', effortIds: ['high'] }],
        efforts: [{ id: 'high', name: 'High' }],
      },
    }
    expect(f.store.enqueue(modelPicker)).toMatchObject({ status: 'pending', intent: modelPicker })
    expect(f.store.getModelPicker('model-picker-1', f.binding.id)).toEqual(modelPicker.modelPicker)
    expect(() => f.store.enqueue({ ...intent('model-picker:missing', f), format: 'model-picker' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...modelPicker, idempotencyKey: 'model-picker:oversized',
      modelPicker: { ...modelPicker.modelPicker!, providers: Array.from({ length: 21 }, (_, index) => ({
        id: `provider-${index}`, name: `Provider ${index}`,
      })) } })).toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...modelPicker, idempotencyKey: 'model-picker:bad-effort-link',
      modelPicker: { ...modelPicker.modelPicker!, models: [{
        provider: 'codex-subscription', id: 'default', name: 'Default', effortIds: ['missing'],
      }] } })).toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    f.store.close()
  })

  test('persists and validates the exact delivered model-picker record across reopen', async () => {
    const f = await fixture()
    const modelPicker: OutboundIntent = {
      ...intent('model-picker:delivered', f, '请选择模型'),
      format: 'model-picker',
      modelPicker: {
        operationId: 'model-picker-delivered',
        expiresAt: 10_000,
        current: { provider: 'codex-subscription', model: 'default' },
        providers: [{ id: 'codex-subscription', name: 'Codex' }],
        models: [{ provider: 'codex-subscription', id: 'default', name: 'Default', effortIds: [] }],
        efforts: [],
      },
    }
    const queued = f.store.enqueue(modelPicker)
    const claim = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.finishOutbox({ outboxId: queued.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_model_picker' })
    expect(f.store.getModelPickerRecord('model-picker-delivered', f.binding.id)).toMatchObject({
      id: queued.id, status: 'accepted', providerMessageId: 'om_model_picker', intent: modelPicker,
    })

    f.store.close()
    const reopened = new DeliveryStore({ path: f.databasePath, now: () => 2_000 })
    expect(reopened.getModelPickerRecord('model-picker-delivered', f.binding.id)).toMatchObject({
      id: queued.id, status: 'accepted', providerMessageId: 'om_model_picker', intent: modelPicker,
    })
    reopened.close()
  })

  test('stores only a typed permission-picker intent and retrieves its accepted provider message', async () => {
    const f = await fixture()
    const permissionPicker: OutboundIntent = {
      ...intent('permission-picker:one', f, '请选择权限模式'),
      format: 'permission-picker',
      permissionPicker: {
        operationId: 'permission-picker-1',
        issuedAt: 1_000,
        expiresAt: 10_000,
        current: 'full',
        expectedStateHash: 'a'.repeat(64),
        emergencyStopVersion: 0,
        bindingVersion: f.binding.version,
        sessionId: f.binding.sessionId,
      },
    }
    const record = f.store.enqueue(permissionPicker)
    const claim = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_permission_picker' })

    expect(f.store.getPermissionPicker('permission-picker-1', f.binding.id)).toEqual(permissionPicker.permissionPicker)
    expect(f.store.getPermissionPicker('permission-picker-1', 'another-binding')).toBeUndefined()
    expect(f.store.getPermissionPickerRecord('permission-picker-1', f.binding.id)).toMatchObject({
      id: record.id,
      status: 'accepted',
      providerMessageId: 'om_permission_picker',
      intent: permissionPicker,
    })

    expect(() => f.store.enqueue({ ...intent('permission-picker:missing', f), format: 'permission-picker' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...intent('permission-picker:forged', f),
      permissionPicker: permissionPicker.permissionPicker! }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...permissionPicker, idempotencyKey: 'permission-picker:mixed-approval',
      approval: {
        operationId: 'approval-1', proposalId: 'proposal-1', expectedVersion: 1,
        expiresAt: 10_000, title: 'Approval required', diffHash: 'b'.repeat(64),
      } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...permissionPicker, idempotencyKey: 'permission-picker:mixed-model',
      modelPicker: {} as NonNullable<OutboundIntent['modelPicker']> }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...permissionPicker, idempotencyKey: 'permission-picker:bad-time',
      permissionPicker: { ...permissionPicker.permissionPicker!, issuedAt: 10_000 } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...permissionPicker, idempotencyKey: 'permission-picker:bad-current',
      permissionPicker: { ...permissionPicker.permissionPicker!, current: 'unlocked' as 'full' } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...permissionPicker, idempotencyKey: 'permission-picker:bad-hash',
      permissionPicker: { ...permissionPicker.permissionPicker!, expectedStateHash: 'forged' } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...permissionPicker, idempotencyKey: 'permission-picker:bad-emergency-version',
      permissionPicker: { ...permissionPicker.permissionPicker!, emergencyStopVersion: -1 } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...permissionPicker, idempotencyKey: 'permission-picker:stale-binding',
      permissionPicker: { ...permissionPicker.permissionPicker!, bindingVersion: f.binding.version + 1 } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.enqueue({ ...permissionPicker, idempotencyKey: 'permission-picker:wrong-session',
      permissionPicker: { ...permissionPicker.permissionPicker!, sessionId: 'another-session' } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    f.store.close()
  })

  test('fails closed when a persisted permission-picker payload diverges from its immutable intent hash', async () => {
    const f = await fixture()
    const permissionPicker: OutboundIntent = {
      ...intent('permission-picker:tampered', f, '请选择权限模式'),
      format: 'permission-picker',
      permissionPicker: {
        operationId: 'permission-picker-tampered',
        issuedAt: 1_000,
        expiresAt: 10_000,
        current: 'ask',
        expectedStateHash: 'a'.repeat(64),
        emergencyStopVersion: 0,
        bindingVersion: f.binding.version,
        sessionId: f.binding.sessionId,
      },
    }
    const record = f.store.enqueue(permissionPicker)
    const database = new DatabaseSync(f.databasePath)
    database.prepare('UPDATE outbox_messages SET intent_json = ? WHERE id = ?').run(JSON.stringify({
      ...permissionPicker,
      permissionPicker: { ...permissionPicker.permissionPicker, expectedStateHash: 'b'.repeat(64) },
    }), record.id)
    database.close()

    expect(() => f.store.getPermissionPickerRecord('permission-picker-tampered', f.binding.id))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.getPermissionPicker('permission-picker-tampered', f.binding.id))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    f.store.close()
  })

  test('fails closed when a persisted model-picker payload diverges from its immutable intent hash', async () => {
    const f = await fixture()
    const modelPicker: OutboundIntent = {
      ...intent('model-picker:tampered', f, '请选择模型'),
      format: 'model-picker',
      modelPicker: {
        operationId: 'model-picker-tampered',
        expiresAt: 10_000,
        current: { provider: 'codex-subscription', model: 'default' },
        providers: [{ id: 'codex-subscription', name: 'Codex' }],
        models: [{ provider: 'codex-subscription', id: 'default', name: 'Default', effortIds: [] }],
        efforts: [],
      },
    }
    const record = f.store.enqueue(modelPicker)
    const database = new DatabaseSync(f.databasePath)
    database.prepare('UPDATE outbox_messages SET intent_json = ? WHERE id = ?').run(JSON.stringify({
      ...modelPicker,
      modelPicker: { ...modelPicker.modelPicker, expiresAt: 20_000 },
    }), record.id)
    database.close()

    expect(() => f.store.getModelPickerRecord('model-picker-tampered', f.binding.id))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    expect(() => f.store.getModelPicker('model-picker-tampered', f.binding.id))
      .toThrowError(expect.objectContaining({ code: 'invalid-intent' }))
    f.store.close()
  })

  test('serializes a route lane and fences send completion', async () => {
    const f = await fixture()
    const one = f.store.enqueue(intent('one', f))
    const two = f.store.enqueue(intent('two', f))
    const first = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 10, maxAttempts: 3 })
    expect(first).toEqual([expect.objectContaining({ mode: 'send', record: expect.objectContaining({ id: one.id }) })])
    expect(f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 10, maxAttempts: 3 })).toEqual([])
    expect(() => f.store.finishOutbox({ outboxId: one.id, ownerId: 'worker-b', fencingToken: first[0]!.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_1' })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    f.store.finishOutbox({ outboxId: one.id, ownerId: 'worker-a', fencingToken: first[0]!.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_1' })
    expect(f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 10, maxAttempts: 3 })[0]?.record.id).toBe(two.id)
    f.store.close()
  })

  test('renews only an exact unexpired outbox claim and fences completion after expiry', async () => {
    const f = await fixture()
    const record = f.store.enqueue(intent('renew-outbox', f))
    const claim = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3,
      unknownReconcileRoutes: [] })[0]!

    f.setNow(1_050)
    expect(f.store.renewOutboxClaim({
      outboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken, leaseMs: 100,
    })).toBe(true)
    expect(f.store.getOutbox(record.id)).toMatchObject({ status: 'attempting', leaseUntil: 1_150 })
    expect(f.store.renewOutboxClaim({
      outboxId: record.id, ownerId: 'worker-b', fencingToken: claim.fencingToken, leaseMs: 100,
    })).toBe(false)

    f.setNow(1_150)
    expect(f.store.renewOutboxClaim({
      outboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken, leaseMs: 100,
    })).toBe(false)
    expect(() => f.store.finishOutbox({
      outboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_expired',
    })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    expect(f.store.recoverOutbox({ maxAttempts: 3 })).toEqual([
      expect.objectContaining({ id: record.id, status: 'unknown_after_send' }),
    ])
    f.store.close()
  })

  test('keeps ambiguous sends unknown and only claims them for reconciliation', async () => {
    const f = await fixture()
    const record = f.store.enqueue(intent('ambiguous', f))
    const send = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 4 })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-a', fencingToken: send.fencingToken,
      outcome: 'unknown_after_send', failureCode: 'response-lost' })
    const reconcile = f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 4 })[0]!
    expect(reconcile).toMatchObject({ mode: 'reconcile', record: { id: record.id, status: 'attempting' } })
    f.setNow(1_100)
    expect(f.store.recoverOutbox({ maxAttempts: 4 })).toEqual([
      expect.objectContaining({ id: record.id, status: 'unknown_after_send' }),
    ])
    const next = f.store.claimOutbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 4 })[0]!
    expect(next.mode).toBe('reconcile')
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-c', fencingToken: next.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_reconciled' })
    f.store.close()
  })

  test('reconciles an unknown send after the independent send budget is exhausted', async () => {
    const f = await fixture()
    const unknown = f.store.enqueue(intent('unknown-at-send-limit', f))
    const following = f.store.enqueue(intent('after-unknown-at-send-limit', f))
    const sent = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    f.store.finishOutbox({ outboxId: unknown.id, ownerId: 'worker-a', fencingToken: sent.fencingToken,
      outcome: 'unknown_after_send', failureCode: 'response-lost' })

    const reconciled = f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 1,
      unknownReconcileRoutes: [{ channel: 'lark', account: 'bot-1' }] })[0]!
    expect(reconciled).toMatchObject({ mode: 'reconcile', record: { id: unknown.id, attemptCount: 2 } })
    f.store.finishOutbox({ outboxId: unknown.id, ownerId: 'worker-b', fencingToken: reconciled.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_reconciled_at_limit' })
    expect(f.store.claimOutbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 1,
      unknownReconcileRoutes: [{ channel: 'lark', account: 'bot-1' }] })[0])
      .toMatchObject({ mode: 'send', record: { id: following.id } })
    f.store.close()
  })

  test('bounds inconclusive reconciliation separately and unblocks its lane without resending', async () => {
    const f = await fixture()
    const unknown = f.store.enqueue(intent('unknown-reconcile-limit', f))
    const following = f.store.enqueue(intent('after-unknown-reconcile-limit', f))
    const sent = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    f.store.finishOutbox({ outboxId: unknown.id, ownerId: 'worker-a', fencingToken: sent.fencingToken,
      outcome: 'unknown_after_send', failureCode: 'response-lost' })
    const reconcile = f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 1,
      unknownReconcileRoutes: [{ channel: 'lark', account: 'bot-1' }] })[0]!
    expect(reconcile).toMatchObject({ mode: 'reconcile', record: { id: unknown.id } })
    f.store.finishOutbox({ outboxId: unknown.id, ownerId: 'worker-b', fencingToken: reconcile.fencingToken,
      outcome: 'unknown_after_send', failureCode: 'reconcile-inconclusive' })

    const next = f.store.claimOutbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 1,
      unknownReconcileRoutes: [{ channel: 'lark', account: 'bot-1' }] })[0]!
    expect(f.store.getOutbox(unknown.id)).toMatchObject({ status: 'dead', attemptCount: 2,
      failureCode: 'reconcile-attempts-exhausted' })
    expect(next).toMatchObject({ mode: 'send', record: { id: following.id } })
    f.store.close()
  })

  test('uses explicit retry timing and dead-letters exhausted attempts', async () => {
    const f = await fixture()
    const record = f.store.enqueue(intent('retry', f))
    const first = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 2 })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'retry_wait', failureCode: 'rate-limit', retryAt: 1_200 })
    expect(f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 2 })).toEqual([])
    f.setNow(1_200)
    const second = f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 2 })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-b', fencingToken: second.fencingToken,
      outcome: 'retry_wait', failureCode: 'rate-limit', retryAt: 1_300 })
    f.setNow(1_300)
    expect(f.store.claimOutbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 2 })).toEqual([])
    expect(f.store.getOutbox(record.id)).toMatchObject({ status: 'dead', failureCode: 'attempts-exhausted' })
    f.store.close()
  })

  test('claims one explicit operator retry after automatic attempts are exhausted', async () => {
    const f = await fixture()
    const record = f.store.enqueue(intent('operator-retry', f))
    const first = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'retry_wait', failureCode: 'rate-limit', retryAt: 1_100 })
    f.setNow(1_100)
    expect(f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 1 })).toEqual([])
    expect(f.store.getOutbox(record.id)).toMatchObject({ status: 'dead', attemptCount: 1,
      failureCode: 'attempts-exhausted' })

    expect(f.store.resolveOutbox({ outboxId: record.id, expectedAttemptCount: 1, resolution: 'retry' }))
      .toMatchObject({ status: 'pending', attemptCount: 1 })
    const retried = f.store.claimOutbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    expect(retried).toMatchObject({ fencingToken: 2, mode: 'send',
      record: { id: record.id, status: 'attempting', attemptCount: 2 } })
    expect(() => f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_stale' }))
      .toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    f.store.close()
  })

  test('rejects operator retry and claiming after the referenced binding is revoked', async () => {
    const f = await fixture()
    const record = f.store.enqueue(intent('revoked-retry', f))
    const claim = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 1,
      unknownReconcileRoutes: [] })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
      outcome: 'dead', failureCode: 'permanent' })
    f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version, sessionId: 'session-rotated' })

    expect(() => f.store.resolveOutbox({
      outboxId: record.id, expectedAttemptCount: 1, resolution: 'retry',
    })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 3,
      unknownReconcileRoutes: [] })).toEqual([])
    f.store.close()
  })

  test('dead-letters an unknown send for a revoked binding before claiming the replacement lane', async () => {
    const f = await fixture()
    const unknown = f.store.enqueue(intent('revoked-unknown', f))
    const send = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.finishOutbox({ outboxId: unknown.id, ownerId: 'worker-a', fencingToken: send.fencingToken,
      outcome: 'unknown_after_send', failureCode: 'response-lost' })

    const replacement = f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version,
      sessionId: 'session-replacement' })
    const following = f.store.enqueue({ ...intent('replacement-lane', f), bindingId: replacement.id })

    const claims = f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 3,
      unknownReconcileRoutes: [], maintenanceLimit: 1 })
    expect(f.store.getOutbox(unknown.id)).toMatchObject({ status: 'dead', attemptCount: 1,
      failureCode: 'binding-revoked-unknown' })
    expect(claims).toEqual([
      expect.objectContaining({ mode: 'send', record: expect.objectContaining({ id: following.id }) }),
    ])
    f.store.close()
  })

  test('skips an unsupported unknown lane without starving another lane', async () => {
    const f = await fixture()
    const unknown = f.store.enqueue(intent('unknown-unsupported', f))
    const first = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.finishOutbox({ outboxId: unknown.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'unknown_after_send', failureCode: 'response-lost' })

    const otherPrincipal = { ...f.principal, user: 'ou_other' }
    const pairing = f.store.issuePairing(otherPrincipal, { ttlMs: 5_000, maxAttempts: 3 })
    f.store.confirmPairing({ challengeId: pairing.challenge.id, principal: otherPrincipal, code: pairing.code })
    const otherConversation = { ...f.conversation, chat: 'oc_other' }
    const otherBinding = f.store.createBinding({ conversation: otherConversation, principal: otherPrincipal,
      workspace: '/work/other', agentPreset: 'primary', sessionId: 'session-other', policyRef: 'owner-dm' })
    const other = f.store.enqueue({ idempotencyKey: 'other-lane', bindingId: otherBinding.id,
      target: { principal: otherPrincipal, conversation: otherConversation }, text: 'other', format: 'plain' })

    const claims = f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 3,
      unknownReconcileRoutes: [] })
    expect(claims).toEqual([expect.objectContaining({ mode: 'send', record: expect.objectContaining({ id: other.id }) })])
    expect(f.store.getOutbox(unknown.id)).toMatchObject({ status: 'unknown_after_send', attemptCount: 1,
      failureCode: 'response-lost' })
    f.store.close()
  })

  test('bounds expired outbox recovery to the requested database batch', async () => {
    const f = await fixture()
    const records = Array.from({ length: 3 }, (_, index) => f.store.enqueue(
      routeIntent(`expired-batch-${index}`, addBinding(f, index)),
    ))
    expect(f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 3, maxAttempts: 3,
      unknownReconcileRoutes: [] })).toHaveLength(3)
    f.setNow(1_100)

    expect(f.store.recoverOutbox({ maxAttempts: 3, limit: 2 })).toHaveLength(2)
    expect(records.map(record => f.store.getOutbox(record.id)?.status)).toEqual([
      'unknown_after_send', 'unknown_after_send', 'attempting',
    ])
    expect(f.store.recoverOutbox({ maxAttempts: 3, limit: 2 })).toHaveLength(1)
    f.store.close()
  })

  test('bounds exhausted outbox cleanup performed by a claim call', async () => {
    const f = await fixture()
    const records = Array.from({ length: 3 }, (_, index) => f.store.enqueue(
      routeIntent(`exhausted-batch-${index}`, addBinding(f, index)),
    ))
    const claims = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 3, maxAttempts: 1,
      unknownReconcileRoutes: [] })
    for (const claim of claims) {
      f.store.finishOutbox({ outboxId: claim.record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
        outcome: 'retry_wait', failureCode: 'temporary', retryAt: 1_100 })
    }
    f.setNow(1_100)

    expect(f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 1,
      unknownReconcileRoutes: [], maintenanceLimit: 2 })).toEqual([])
    expect(records.map(record => f.store.getOutbox(record.id)?.status)).toEqual([
      'dead', 'dead', 'retry_wait',
    ])
    f.store.close()
  })

  test('bounds revoked outbox cleanup performed by a claim call', async () => {
    const f = await fixture()
    const records = Array.from({ length: 3 }, (_, index) => f.store.enqueue(intent(`revoked-batch-${index}`, f)))
    f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version,
      sessionId: 'session-rotated-for-batch' })

    expect(f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3,
      unknownReconcileRoutes: [], maintenanceLimit: 2 })).toEqual([])
    expect(records.map(record => f.store.getOutbox(record.id)?.status)).toEqual(['dead', 'dead', 'pending'])
    expect(f.store.claimOutbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 3,
      unknownReconcileRoutes: [], maintenanceLimit: 2 })).toEqual([])
    expect(f.store.getOutbox(records[2]!.id)).toMatchObject({ status: 'dead', failureCode: 'binding-revoked' })
    f.store.close()
  })

  test('applies matching receipts monotonically and idempotently', async () => {
    const f = await fixture()
    const record = f.store.enqueue(intent('receipt', f))
    const claim = f.store.claimOutbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.finishOutbox({ outboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
      outcome: 'accepted', providerMessageId: 'om_1' })
    const delivered: DeliveryReceipt = { channel: 'lark', account: 'bot-1', providerMessageId: 'om_1',
      status: 'delivered', occurredAt: 1_100 }
    expect(f.store.recordReceipt(delivered)).toMatchObject({ status: 'delivered' })
    expect(f.store.recordReceipt(delivered)).toMatchObject({ status: 'delivered' })
    expect(f.store.recordReceipt({ ...delivered, status: 'accepted', occurredAt: 1_200 })).toMatchObject({ status: 'delivered' })
    expect(() => f.store.recordReceipt({ ...delivered, providerMessageId: 'om_other' }))
      .toThrowError(expect.objectContaining({ code: 'receipt-mismatch' }))
    f.store.close()
  })
})
