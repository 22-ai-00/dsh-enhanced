import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'
import type { OutboundIntent } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-picker-state-'))
  roots.push(root)
  let now = 1_000
  const path = join(root, 'delivery.sqlite')
  const store = new DeliveryStore({ path, now: () => now, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
  const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
  const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
    sessionId: 'session-1', policyRef: 'owner-dm' })
  const reply = (key: string, text: string): OutboundIntent => ({
    idempotencyKey: key,
    bindingId: binding.id,
    target: { principal, conversation },
    text,
    format: 'plain',
  })
  return { binding, conversation, path, principal, reply, store, setNow(value: number) { now = value } }
}

describe('durable model-picker state', () => {
  test('CAS-fences stale navigation and closes navigation after confirmation starts', async () => {
    const f = await fixture()
    const initial = { revision: 0, provider: 'codex', model: 'default' }
    const first = f.store.advanceModelPicker({
      operationId: 'picker-1', bindingId: f.binding.id, expected: initial,
      next: { provider: 'claude', model: 'sonnet' },
    })
    expect(first).toEqual({ applied: true, state: { revision: 1, provider: 'claude', model: 'sonnet' } })
    expect(f.store.advanceModelPicker({
      operationId: 'picker-1', bindingId: f.binding.id, expected: initial,
      next: { provider: 'codex', model: 'mini' },
    })).toEqual({ applied: false, state: first.state })

    const payload = { callbackEventId: 'callback-1', provider: 'claude', model: 'sonnet' }
    const pending = f.store.beginModelSelectionSettlement({
      operationId: 'picker-1', bindingId: f.binding.id, expected: first.state, payload,
    })
    expect(pending).toMatchObject({ replayed: false, status: 'pending' })
    expect(() => f.store.advanceModelPicker({
      operationId: 'picker-1', bindingId: f.binding.id, expected: first.state,
      next: { provider: 'claude', model: 'opus' },
    })).toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    f.store.close()
  })

  test('atomically persists selection, reply, and a replayable settlement result', async () => {
    const f = await fixture()
    const expected = { revision: 0, provider: 'alternate', model: 'precise', reasoningEffort: 'high' }
    const payload = { callbackEventId: 'callback-1', provider: 'alternate', model: 'precise', effort: 'high' }
    const pending = f.store.beginModelSelectionSettlement({
      operationId: 'picker-2', bindingId: f.binding.id, expected, payload,
    })
    const result = { status: 'selected', selection: { provider: 'alternate', model: 'precise', reasoningEffort: 'high' } }
    expect(f.store.completeModelSelectionSettlement({
      operationId: 'picker-2', payloadHash: pending.payloadHash, result,
      selection: { conversation: f.conversation, route: result.selection },
      reply: f.reply('model-selection:callback-1:reply', 'selected alternate/precise'),
    })).toEqual(result)
    expect(f.store.getModelSelection(f.conversation)).toMatchObject({
      provider: 'alternate', model: 'precise', reasoningEffort: 'high', version: 1,
    })

    f.store.close()
    const reopened = new DeliveryStore({ path: f.path, now: () => 2_000 })
    expect(reopened.beginModelSelectionSettlement({
      operationId: 'picker-2', bindingId: f.binding.id, expected, payload,
    })).toMatchObject({ replayed: true, status: 'completed', result })
    expect(reopened.getModelSelection(f.conversation)).toMatchObject({ version: 1 })
    expect(() => reopened.beginModelSelectionSettlement({
      operationId: 'picker-2', bindingId: f.binding.id, expected,
      payload: { ...payload, model: 'fast' },
    })).toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    reopened.close()
  })

  test('clears only the exact persisted stale reasoning effort with a version fence', async () => {
    const f = await fixture()
    const stale = f.store.setModelSelection(f.conversation, {
      provider: 'alternate', model: 'precise', reasoningEffort: 'max',
    })
    expect(f.store.clearStaleModelReasoningEffort({ conversation: f.conversation, expected: stale }))
      .toMatchObject({ applied: true, selection: { provider: 'alternate', model: 'precise', version: 2 } })
    expect(f.store.getModelSelection(f.conversation)?.reasoningEffort).toBeUndefined()

    const newer = f.store.setModelSelection(f.conversation, {
      provider: 'alternate', model: 'fast', reasoningEffort: 'low',
    })
    expect(f.store.clearStaleModelReasoningEffort({ conversation: f.conversation, expected: stale }))
      .toEqual({ applied: false })
    expect(f.store.getModelSelection(f.conversation)).toEqual(newer)
    f.store.close()
  })

  test('rolls selection back when the confirmation reply cannot be enqueued', async () => {
    const f = await fixture()
    f.store.enqueue(f.reply('model-selection:callback-conflict:reply', 'existing reply'))
    const expected = { revision: 0, provider: 'alternate', model: 'precise' }
    const pending = f.store.beginModelSelectionSettlement({
      operationId: 'picker-conflict', bindingId: f.binding.id, expected,
      payload: { callbackEventId: 'callback-conflict', provider: 'alternate', model: 'precise' },
    })
    expect(() => f.store.completeModelSelectionSettlement({
      operationId: 'picker-conflict', payloadHash: pending.payloadHash,
      result: { status: 'selected' },
      selection: { conversation: f.conversation, route: expected },
      reply: f.reply('model-selection:callback-conflict:reply', 'different reply'),
    })).toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(f.store.getModelSelection(f.conversation)).toBeUndefined()
    expect(f.store.beginModelSelectionSettlement({
      operationId: 'picker-conflict', bindingId: f.binding.id, expected,
      payload: { callbackEventId: 'callback-conflict', provider: 'alternate', model: 'precise' },
    })).toMatchObject({ replayed: true, status: 'pending' })
    f.store.close()
  })

  test('prevents an older card operation from overwriting a newer operation in the same conversation', async () => {
    const f = await fixture()
    const first = f.store.beginModelSelectionSettlement({
      operationId: 'picker-old', bindingId: f.binding.id,
      expected: { revision: 0, provider: 'alternate', model: 'old' },
      payload: { callbackEventId: 'callback-old' },
    })
    const second = f.store.beginModelSelectionSettlement({
      operationId: 'picker-new', bindingId: f.binding.id,
      expected: { revision: 0, provider: 'alternate', model: 'new' },
      payload: { callbackEventId: 'callback-new' },
    })
    const superseded = { status: 'rejected', reason: 'selection-superseded' }
    expect(f.store.completeModelSelectionSettlement({
      operationId: 'picker-old', payloadHash: first.payloadHash,
      result: { status: 'selected', selection: { provider: 'alternate', model: 'old' } },
      selection: { conversation: f.conversation, route: { provider: 'alternate', model: 'old' } },
      reply: f.reply('model-selection:callback-old:reply', 'selected old'),
      superseded: { result: superseded, reply: f.reply('model-selection:callback-old:reply', 'superseded old') },
    })).toEqual(superseded)
    expect(f.store.getModelSelection(f.conversation)).toBeUndefined()

    expect(f.store.completeModelSelectionSettlement({
      operationId: 'picker-new', payloadHash: second.payloadHash,
      result: { status: 'selected', selection: { provider: 'alternate', model: 'new' } },
      selection: { conversation: f.conversation, route: { provider: 'alternate', model: 'new' } },
      reply: f.reply('model-selection:callback-new:reply', 'selected new'),
      superseded: { result: superseded, reply: f.reply('model-selection:callback-new:reply', 'superseded new') },
    })).toMatchObject({ status: 'selected' })
    expect(f.store.getModelSelection(f.conversation)).toMatchObject({ provider: 'alternate', model: 'new' })
    f.store.close()
  })

  test('CAS-orders asynchronous text model commands with card confirmations', async () => {
    const f = await fixture()
    const older = f.store.beginModelCommand(f.conversation)
    const card = f.store.beginModelSelectionSettlement({
      operationId: 'picker-newer-than-text', bindingId: f.binding.id,
      expected: { revision: 0, provider: 'alternate', model: 'card' },
      payload: { callbackEventId: 'callback-card' },
    })
    expect(f.store.commitModelCommand({
      conversation: f.conversation, expectedEpoch: older,
      route: { provider: 'alternate', model: 'old' },
    })).toEqual({ applied: false })
    expect(f.store.completeModelSelectionSettlement({
      operationId: 'picker-newer-than-text', payloadHash: card.payloadHash,
      result: { status: 'selected' },
      selection: { conversation: f.conversation, route: { provider: 'alternate', model: 'card' } },
      reply: f.reply('model-selection:callback-card:reply', 'selected card'),
    })).toEqual({ status: 'selected' })
    expect(f.store.getModelSelection(f.conversation)).toMatchObject({ provider: 'alternate', model: 'card' })
    f.store.close()
  })

  test('reclaims a pending confirmation with a fencing token after a worker restart', async () => {
    const f = await fixture()
    f.store.beginModelSelectionSettlement({
      operationId: 'picker-recovery', bindingId: f.binding.id,
      expected: { revision: 0, provider: 'alternate', model: 'precise' },
      payload: { callbackEventId: 'callback-recovery', provider: 'alternate', model: 'precise' },
    })
    const first = f.store.claimModelSelectionSettlements({ ownerId: 'worker-old', leaseMs: 100 })[0]!
    expect(first).toMatchObject({ operationId: 'picker-recovery', fencingToken: 1 })
    expect(f.store.claimModelSelectionSettlements({ ownerId: 'worker-new', leaseMs: 100 })).toEqual([])

    f.setNow(1_050)
    expect(f.store.renewModelSelectionSettlement({
      operationId: first.operationId, ownerId: 'worker-old', fencingToken: first.fencingToken, leaseMs: 100,
    })).toBe(true)
    f.store.close()
    let recoveryNow = 1_101
    const recoveredStore = new DeliveryStore({ path: f.path, now: () => recoveryNow })
    expect(recoveredStore.claimModelSelectionSettlements({ ownerId: 'worker-new', leaseMs: 100 })).toEqual([])
    recoveryNow = 1_151
    const recovered = recoveredStore.claimModelSelectionSettlements({ ownerId: 'worker-new', leaseMs: 100 })[0]!
    expect(recovered).toMatchObject({ operationId: 'picker-recovery', fencingToken: 2 })
    const completion = {
      operationId: 'picker-recovery', payloadHash: recovered.payloadHash,
      result: { status: 'selected' },
      selection: { conversation: f.conversation, route: { provider: 'alternate', model: 'precise' } },
      reply: f.reply('model-selection:callback-recovery:reply', 'selected alternate/precise'),
    } as const
    expect(() => recoveredStore.completeModelSelectionSettlement({
      ...completion, ownerId: 'worker-old', fencingToken: first.fencingToken,
    })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    expect(recoveredStore.completeModelSelectionSettlement({
      ...completion, ownerId: 'worker-new', fencingToken: recovered.fencingToken,
    })).toEqual({ status: 'selected' })
    recoveredStore.close()
  })

  test('transactionally fences principal revocation before selection and reply commit', async () => {
    const f = await fixture()
    const expected = { revision: 0, provider: 'alternate', model: 'precise' }
    const pending = f.store.beginModelSelectionSettlement({
      operationId: 'picker-revoked', bindingId: f.binding.id, expected,
      payload: { callbackEventId: 'callback-revoked' },
    })
    const claim = f.store.claimModelSelectionSettlements({ ownerId: 'worker', leaseMs: 100 })[0]!
    const owner = f.store.getPrincipal(f.principal)!
    f.store.revokePrincipal(owner.id, owner.version)

    expect(() => f.store.completeModelSelectionSettlement({
      operationId: claim.operationId,
      payloadHash: pending.payloadHash,
      result: { status: 'selected' },
      selection: { conversation: f.conversation, route: expected },
      reply: f.reply('model-selection:callback-revoked:reply', 'selected alternate/precise'),
      ownerId: 'worker',
      fencingToken: claim.fencingToken,
    })).toThrowError(expect.objectContaining({ code: 'unauthorized-principal' }))
    expect(f.store.completeModelSelectionSettlement({
      operationId: claim.operationId,
      payloadHash: pending.payloadHash,
      result: { status: 'rejected', reason: 'authorization-revoked' },
      ownerId: 'worker',
      fencingToken: claim.fencingToken,
    })).toEqual({ status: 'rejected', reason: 'authorization-revoked' })
    expect(f.store.getModelSelection(f.conversation)).toBeUndefined()
    expect(f.store.listOutbox({ bindingId: f.binding.id })).toEqual([])
    f.store.close()
  })
})
