import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'
import { deliverySchemaVersion } from '../src/sqlite.ts'
import type { DeliveryProgressIntent } from '../src/types.ts'

const roots: string[] = []
const principal = { channel: 'lark', account: 'bot-progress', tenant: 'tenant-a', user: 'ou-owner' }
const conversation = { channel: 'lark', account: 'bot-progress', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc-owner' }
const fingerprint = 'a'.repeat(64)

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-progress-'))
  roots.push(root)
  const path = join(root, 'delivery.sqlite')
  let now = 1_000
  const open = () => new DeliveryStore({ path, now: () => now, codeGenerator: () => 'PAIR1234' })
  const store = open()
  const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/progress',
    agentPreset: 'primary', sessionId: 'session-progress', policyRef: 'owner-dm' })
  const owner = store.getPrincipal(principal)!
  const admit = (eventId: string) => {
    const inbox = store.acceptInbound({ channel: 'lark', account: 'bot-progress', eventId,
      occurredAt: 1, principal, conversation, kind: 'text', text: 'long task' }).record
    store.queueInbox(inbox.id, binding.id)
    const claim = store.claimInbox({ ownerId: `worker-${eventId}`, leaseMs: 30_000, limit: 1, maxAttempts: 3 })[0]!
    store.bindForegroundTaskExecution({ inboxId: inbox.id,
      scope: { workspace: '/work/progress', preset: 'primary' },
      owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: now })
    const intent: DeliveryProgressIntent = { bindingId: binding.id, eventId,
      target: { principal, conversation }, update: { kind: 'started' } }
    return { claim, inbox, intent }
  }
  return { path, store, open, binding, owner, admit, setNow(value: number) { now = value } }
}

describe('durable progress journal', () => {
  test('reserves creation before provider I/O and never recreates a missing handle across restart', async () => {
    const f = await fixture()
    const { intent } = f.admit('evt-creating')
    expect(f.store.beginProgress(intent, fingerprint, 1, true)).toMatchObject({ created: true,
      record: { state: 'creating' } })
    expect(f.store.getProgress(intent, fingerprint)?.providerHandle).toBeUndefined()
    f.store.close()
    const reopened = f.open()
    expect(reopened.beginProgress(intent, fingerprint, 2, true)).toMatchObject({ created: false,
      record: { state: 'creating', sequence: 1 } })
    expect(reopened.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toEqual([])
    reopened.close()
  })

  test('persists terminal before a slow create returns and fences a terminal that beats started', async () => {
    const f = await fixture()
    const first = f.admit('evt-creating-terminal').intent
    f.store.beginProgress(first, fingerprint, 3, true)
    const failed: DeliveryProgressIntent = { ...first, update: { kind: 'failed', code: 'agent-task-timeout' } }
    expect(f.store.stageProgressTerminal(failed, fingerprint)).toMatchObject({ state: 'creating',
      terminal: { kind: 'failed', code: 'agent-task-timeout' } })
    expect(f.store.attachProgressHandle(first, fingerprint, JSON.stringify({ cotId: 'cot-late', messageId: 'om-late' })))
      .toMatchObject({ state: 'pending', terminal: { kind: 'failed', code: 'agent-task-timeout' } })
    expect(f.store.advanceProgress(first, fingerprint)).toBeUndefined()

    const other = await fixture()
    const second = other.admit('evt-terminal-first').intent
    expect(other.store.stageProgressTerminal({ ...second, update: { kind: 'failed' } }, fingerprint))
      .toMatchObject({ state: 'creating', terminal: { kind: 'failed' } })
    expect(other.store.beginProgress(second, fingerprint, 4, true)).toMatchObject({ created: false,
      record: { state: 'creating' } })
    expect(other.store.getProgress(second, fingerprint)?.providerHandle).toBeUndefined()
    f.store.close()
    other.store.close()
  })

  test('recovers only settled Inbox and marks dispatch-ambiguous foreground result unknown', async () => {
    const f = await fixture()
    const { intent, inbox, claim } = f.admit('evt-ambiguous')
    f.store.beginProgress(intent, fingerprint, 1, false)
    f.store.attachProgressHandle(intent, fingerprint, JSON.stringify({ cotId: 'cot-1', messageId: 'om-1' }))
    expect(f.store.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toEqual([])
    f.store.finishInbox({ inboxId: inbox.id, ownerId: 'worker-evt-ambiguous',
      fencingToken: claim.fencingToken, outcome: 'dead_letter', failureCode: 'dispatch-ambiguous' })
    f.store.close()
    const reopened = f.open()
    expect(reopened.recoverProgress('lark', 'wrong-account', fingerprint, 16)).toEqual([])
    expect(reopened.recoverProgress('lark', 'bot-progress', 'b'.repeat(64), 16)).toEqual([])
    expect(reopened.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toMatchObject([{
      state: 'pending', terminal: { kind: 'failed', code: 'INTERRUPTED_RESULT_UNKNOWN' },
      providerHandle: JSON.stringify({ cotId: 'cot-1', messageId: 'om-1' }),
    }])
    expect(reopened.inspectForegroundExecutionForOwner({ inboxId: inbox.id,
      scope: { workspace: '/work/progress', preset: 'primary' },
      owner: { principalRecordId: f.owner.id, principalVersion: f.owner.version },
      bindingId: f.binding.id, bindingVersion: f.binding.version,
      bindingGeneration: f.binding.generation })).toMatchObject({ status: 'unknown', quiescent: false })
    reopened.close()
  })

  test('pages past denied old progress without spending retries and revisits it after authorization changes', async () => {
    const f = await fixture()
    const denied = new Set<string>()
    const records: Array<ReturnType<typeof f.admit>> = []
    const handle = JSON.stringify({ cotId: 'cot-page', messageId: 'om-page' })
    for (let index = 0; index < 4; index += 1) {
      f.setNow(1_000 + index * 1_000)
      const record = f.admit(`evt-page-${index}`)
      f.store.beginProgress(record.intent, fingerprint, index + 1, false)
      f.store.attachProgressHandle(record.intent, fingerprint, handle)
      f.store.finishInbox({ inboxId: record.inbox.id, ownerId: `worker-evt-page-${index}`,
        fencingToken: record.claim.fencingToken, outcome: 'dead_letter', failureCode: 'dispatch-ambiguous' })
      if (index < 3) denied.add(record.inbox.id)
      records.push(record)
    }
    const authorize = (_binding: unknown, inbox: { id: string }) => !denied.has(inbox.id)
    expect(f.store.recoverProgress('lark', 'bot-progress', fingerprint, 2, authorize)).toEqual([])
    expect(f.store.recoverProgress('lark', 'bot-progress', fingerprint, 2, authorize)).toMatchObject([{
      eventId: records[3]!.inbox.eventId, providerHandle: handle,
      terminal: { kind: 'failed', code: 'INTERRUPTED_RESULT_UNKNOWN' },
    }])
    const raw = new DatabaseSync(f.path)
    try {
      expect(raw.prepare('SELECT COUNT(*) AS count FROM delivery_progress').get()).toEqual({ count: 4 })
      for (const record of records.slice(0, 3)) {
        expect(raw.prepare('SELECT state, retry_attempts FROM delivery_progress WHERE inbox_id = ?')
          .get(record.inbox.id)).toEqual({ state: 'active', retry_attempts: 0 })
      }
    } finally { raw.close() }
    f.store.confirmProgressTerminal({ ...records[3]!.intent, update: { kind: 'failed' } }, fingerprint)
    denied.delete(records[0]!.inbox.id)
    expect(f.store.recoverProgress('lark', 'bot-progress', fingerprint, 2, authorize)).toEqual([])
    expect(f.store.recoverProgress('lark', 'bot-progress', fingerprint, 2, authorize))
      .toMatchObject([{ eventId: records[0]!.inbox.eventId, providerHandle: handle }])
    f.store.close()
  })

  test('keeps a settled Inbox open while its session lease is live, then closes unknown without foreground proof', async () => {
    const f = await fixture()
    const inbox = f.store.acceptInbound({ channel: 'lark', account: 'bot-progress',
      eventId: 'evt-live-lease', occurredAt: 1, principal, conversation,
      kind: 'text', text: 'task with unconfirmed result' }).record
    f.store.queueInbox(inbox.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-live-lease', leaseMs: 30_000, limit: 1, maxAttempts: 3 })[0]!
    const intent: DeliveryProgressIntent = { bindingId: f.binding.id, eventId: inbox.eventId,
      target: { principal, conversation }, update: { kind: 'started' } }
    f.store.beginProgress(intent, fingerprint, 1, false)
    f.store.attachProgressHandle(intent, fingerprint, JSON.stringify({ cotId: 'cot-live', messageId: 'om-live' }))
    const lease = f.store.claimSessionLease({ kind: 'bound', binding: f.binding }, 'host-live', 10_000)
    expect(lease.kind).toBe('claimed')
    if (lease.kind !== 'claimed') throw new Error('session lease unavailable')
    expect(f.store.markSessionLeaseDispatched(lease.lease)).toBe(true)
    f.store.finishInbox({ inboxId: inbox.id, ownerId: 'worker-live-lease',
      fencingToken: claim.fencingToken, outcome: 'processed' })
    expect(f.store.recoverProgress('lark', 'bot-progress', fingerprint, 2)).toEqual([])
    const raw = new DatabaseSync(f.path)
    try {
      expect(raw.prepare('SELECT retry_attempts FROM delivery_progress WHERE inbox_id = ?')
        .get(inbox.id)).toEqual({ retry_attempts: 0 })
    } finally { raw.close() }
    expect(f.store.finishSessionLease(lease.lease, { quiescent: false })).toBe(true)
    // The exhausted scan page wraps; the next sweep rechecks authority and lease state.
    expect(f.store.recoverProgress('lark', 'bot-progress', fingerprint, 2)).toEqual([])
    expect(f.store.recoverProgress('lark', 'bot-progress', fingerprint, 2)).toMatchObject([{
      eventId: inbox.eventId, terminal: { kind: 'failed', code: 'INTERRUPTED_RESULT_UNKNOWN' },
    }])
    expect(f.store.getInbox(inbox.id)).toMatchObject({ status: 'processed', attemptCount: 1 })
    f.store.close()
  })

  test('keeps a failed terminal write pending for bounded same-handle retry, then acknowledges once', async () => {
    const f = await fixture()
    const { intent, inbox, claim } = f.admit('evt-complete')
    f.store.beginProgress(intent, fingerprint, 1, true)
    f.store.attachProgressHandle(intent, fingerprint, JSON.stringify({ cotId: 'cot-2', messageId: 'om-2' }))
    f.store.finishForegroundTaskExecution({ inboxId: inbox.id, status: 'succeeded', quiescent: true, completedAt: 1_001 })
    f.store.finishInbox({ inboxId: inbox.id, ownerId: 'worker-evt-complete',
      fencingToken: claim.fencingToken, outcome: 'processed' })
    const completed: DeliveryProgressIntent = { ...intent, update: { kind: 'completed' } }
    expect(f.store.stageProgressTerminal(completed, fingerprint)).toMatchObject({
      state: 'pending', terminal: { kind: 'completed' }, providerHandle: JSON.stringify({ cotId: 'cot-2', messageId: 'om-2' }),
    })
    f.store.close()
    const reopened = f.open()
    expect(reopened.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toEqual([])
    f.setNow(11_000)
    expect(reopened.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toHaveLength(1)
    // Simulated provider write failure: no confirmation. The next attempt is delayed.
    expect(reopened.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toEqual([])
    f.setNow(31_000)
    expect(reopened.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toHaveLength(1)
    reopened.confirmProgressTerminal(completed, fingerprint)
    expect(reopened.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toEqual([])
    reopened.close()
  })

  test('rejects wrong binding and a changed binding generation before retrying provider I/O', async () => {
    const f = await fixture()
    const { intent, inbox, claim } = f.admit('evt-binding')
    f.store.beginProgress(intent, fingerprint, 1, true)
    f.store.attachProgressHandle(intent, fingerprint, JSON.stringify({ cotId: 'cot-bound', messageId: 'om-bound' }))
    expect(f.store.getProgress({ ...intent, bindingId: 'other' }, fingerprint)).toBeUndefined()
    expect(f.store.stageProgressTerminal({ ...intent, bindingId: 'other', update: { kind: 'failed' } }, fingerprint))
      .toBeUndefined()
    f.store.finishInbox({ inboxId: inbox.id, ownerId: 'worker-evt-binding',
      fencingToken: claim.fencingToken, outcome: 'dead_letter', failureCode: 'dispatch-ambiguous' })
    f.store.close()
    const raw = new DatabaseSync(f.path)
    raw.prepare("UPDATE conversation_bindings SET generation = generation + 1 WHERE id = ?").run(f.binding.id)
    raw.close()
    const reopened = f.open()
    expect(reopened.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toEqual([])
    reopened.close()
  })

  test.each([
    { kind: 'failed' as const, code: 'agent-task-timeout' },
    { kind: 'paused' as const },
  ])('preserves explicit $kind terminal and exhausts eight retries without recreating', async update => {
    const f = await fixture()
    const { intent, inbox, claim } = f.admit(`evt-${update.kind}`)
    f.store.beginProgress(intent, fingerprint, 1, true)
    const handle = JSON.stringify({ cotId: 'cot-terminal', messageId: 'om-terminal' })
    f.store.attachProgressHandle(intent, fingerprint, handle)
    f.store.stageProgressTerminal({ ...intent, update }, fingerprint)
    f.store.finishInbox({ inboxId: inbox.id, ownerId: `worker-evt-${update.kind}`,
      fencingToken: claim.fencingToken, outcome: 'dead_letter', failureCode: 'dispatch-ambiguous' })
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      f.setNow(attempt * 300_000)
      let recovered = f.store.recoverProgress('lark', 'bot-progress', fingerprint, 16)
      if (recovered.length === 0) recovered = f.store.recoverProgress('lark', 'bot-progress', fingerprint, 16)
      expect(recovered).toMatchObject([{
        terminal: update, providerHandle: handle,
      }])
    }
    f.setNow(3_000_000)
    expect(f.store.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toEqual([])
    expect(f.store.beginProgress(intent, fingerprint, 2, true)).toBeUndefined()
    f.store.close()
  })

  test('does not recover an optimistic completed terminal as success without quiescent proof', async () => {
    const f = await fixture()
    const { intent, inbox, claim } = f.admit('evt-unproven')
    f.store.beginProgress(intent, fingerprint, 1, true)
    f.store.attachProgressHandle(intent, fingerprint, JSON.stringify({ cotId: 'cot-unproven', messageId: 'om-unproven' }))
    f.store.stageProgressTerminal({ ...intent, update: { kind: 'completed' } }, fingerprint)
    f.store.finishInbox({ inboxId: inbox.id, ownerId: 'worker-evt-unproven',
      fencingToken: claim.fencingToken, outcome: 'processed' })
    f.setNow(11_000)
    expect(f.store.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toMatchObject([{
      terminal: { kind: 'failed', code: 'INTERRUPTED_RESULT_UNKNOWN' },
    }])
    f.store.close()
  })

  test('migrates v26 without inventing historical handles or touching Inbox rows', async () => {
    const f = await fixture()
    const { intent, inbox } = f.admit('evt-old')
    f.store.close()
    const raw = new DatabaseSync(f.path)
    raw.exec('DROP TABLE delivery_progress; PRAGMA user_version = 26;')
    raw.close()
    const reopened = f.open()
    expect(reopened.getInbox(inbox.id)?.status).toBe('claimed')
    expect(reopened.getProgress(intent, fingerprint)).toBeUndefined()
    expect(reopened.recoverProgress('lark', 'bot-progress', fingerprint, 16)).toEqual([])
    reopened.close()
    const check = new DatabaseSync(f.path)
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    check.close()
  })
})
