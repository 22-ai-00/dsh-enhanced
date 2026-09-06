import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-session-lease-')); roots.push(root)
  let now = 10
  const path = join(root, 'delivery.sqlite')
  const store = new DeliveryStore({ path, now: () => now, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'owner' }
  const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'chat-a' }
  const issue = store.issuePairing(principal, { ttlMs: 1_000, maxAttempts: 3 }); store.confirmPairing({ challengeId: issue.challenge.id, principal, code: issue.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/a', agentPreset: 'primary', sessionId: 'session-a', policyRef: 'route' })
  return { path, store, binding, principal, conversation, now: (value: number) => { now = value } }
}

describe('session leases', () => {
  test('migrates a v18 database without disturbing existing data', async () => {
    const f = await fixture(); f.store.close()
    const database = new DatabaseSync(f.path); database.exec('DROP TABLE delivery_session_leases; PRAGMA user_version = 18;'); database.close()
    const reopened = new DeliveryStore({ path: f.path })
    expect(reopened.getBinding(f.binding.id)?.sessionId).toBe('session-a')
    const inspected = new DatabaseSync(f.path)
    expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(19)
    inspected.close()
    reopened.close()
  })

  test('fences prepared expiry and keeps dispatched or unknown work unreclaimable', async () => {
    const f = await fixture(); const target = { kind: 'bound' as const, binding: f.binding }
    const first = f.store.claimSessionLease(target, 'worker-a', 5)
    expect(first.kind).toBe('claimed'); if (first.kind !== 'claimed') return
    const second = new DeliveryStore({ path: f.path, now: () => 10 })
    expect(second.claimSessionLease(target, 'worker-b', 5)).toMatchObject({ kind: 'busy' })
    f.now(16); second.close()
    const replacementStore = new DeliveryStore({ path: f.path, now: () => 16 })
    const replacement = replacementStore.claimSessionLease(target, 'worker-b', 5)
    expect(replacement).toMatchObject({ kind: 'claimed', lease: { fencingToken: 2 } })
    expect(f.store.markSessionLeaseDispatched(first.lease)).toBe(false)
    if (replacement.kind === 'claimed') {
      expect(replacementStore.markSessionLeaseDispatched(replacement.lease)).toBe(true)
      expect(f.store.claimSessionLease(target, 'worker-c', 5)).toEqual({ kind: 'busy' })
      f.now(30)
      expect(f.store.claimSessionLease(target, 'worker-c', 5)).toEqual({ kind: 'unknown' })
      expect(replacementStore.finishSessionLease(replacement.lease, { quiescent: false })).toBe(true)
      expect(replacementStore.finishSessionLease(replacement.lease, { quiescent: true })).toBe(true)
      expect(f.store.claimSessionLease(target, 'worker-c', 5)).toMatchObject({ kind: 'claimed', lease: { fencingToken: 3 } })
    }
    replacementStore.close(); f.store.close()
  })

  test('denies stale authority and supports linked active principals', async () => {
    const f = await fixture()
    expect(f.store.claimSessionLease({ kind: 'bound', binding: { ...f.binding, version: f.binding.version + 1 } }, 'worker', 5)).toEqual({ kind: 'denied' })
    const linked = { ...f.principal, user: 'linked' }; const issue = f.store.issuePairing(linked, { ttlMs: 1_000, maxAttempts: 3 }); f.store.confirmPairing({ challengeId: issue.challenge.id, principal: linked, code: issue.code })
    const binding = f.store.createBinding({ conversation: { ...f.conversation, chat: 'chat-linked' }, principal: linked, workspace: '/work/l', agentPreset: 'primary', sessionId: 'session-linked', policyRef: 'route' })
    expect(f.store.claimSessionLease({ kind: 'bound', binding }, 'worker', 5)).toMatchObject({ kind: 'claimed' })
    f.store.close()
  })

  test('keeps the same fence usable after repeated renewals', async () => {
    const f = await fixture(); const target = { kind: 'bound' as const, binding: f.binding }
    const claim = f.store.claimSessionLease(target, 'worker', 5)
    expect(claim.kind).toBe('claimed'); if (claim.kind !== 'claimed') return
    f.now(11)
    expect(f.store.renewSessionLease(claim.lease, 10)).toBe(true)
    expect(f.store.hasSessionLease(claim.lease)).toBe(true)
    expect(f.store.renewSessionLease(claim.lease, 10)).toBe(true)
    expect(f.store.markSessionLeaseDispatched(claim.lease)).toBe(true)
    f.store.close()
  })

  test('keeps an orphan construction owned by its original principal after release', async () => {
    const f = await fixture()
    const target = { kind: 'construction' as const, sessionId: 'orphan-session',
      conversation: { ...f.conversation, chat: 'orphan-chat' }, principal: f.principal,
      workspace: '/work/a', agentPreset: 'primary', generation: 1 }
    const claim = f.store.claimSessionLease(target, 'host-a', 5)
    expect(claim.kind).toBe('claimed'); if (claim.kind !== 'claimed') throw new Error('claim failed')
    expect(f.store.markSessionLeaseDispatched(claim.lease)).toBe(true)
    expect(f.store.finishSessionLease(claim.lease, { quiescent: true })).toBe(true)
    const other = { ...f.principal, user: 'other-owner' }
    const issue = f.store.issuePairing(other, { ttlMs: 1_000, maxAttempts: 3 })
    f.store.confirmPairing({ challengeId: issue.challenge.id, principal: other, code: issue.code })
    expect(f.store.claimSessionLease({ ...target, principal: other }, 'host-b', 5)).toEqual({ kind: 'denied' })
    const second = f.store.claimSessionLease(target, 'host-a-restarted', 5)
    expect(second).toMatchObject({ kind: 'claimed', lease: { fencingToken: 2 } })
    f.store.close()
  })

  test('rechecks a changed binding revision before reclaiming an expired prepared lease', async () => {
    const f = await fixture()
    const claim = f.store.claimSessionLease({ kind: 'bound', binding: f.binding }, 'host-a', 5)
    expect(claim.kind).toBe('claimed'); if (claim.kind !== 'claimed') throw new Error('claim failed')
    const database = new DatabaseSync(f.path)
    database.prepare('UPDATE conversation_bindings SET version = version + 1 WHERE id = ?').run(f.binding.id)
    database.close(); f.now(16)
    const binding = f.store.getBinding(f.binding.id)!
    expect(f.store.claimSessionLease({ kind: 'bound', binding }, 'host-b', 5)).toMatchObject({ kind: 'claimed', lease: { fencingToken: 2 } })
    expect(f.store.hasSessionLease(claim.lease)).toBe(false)
    f.store.close()
  })

  test('serializes construction against a bound session and generation', async () => {
    const f = await fixture()
    expect(f.store.claimSessionLease({ kind: 'construction', sessionId: f.binding.sessionId, conversation: f.conversation, principal: f.principal, workspace: '/work/a', agentPreset: 'primary', generation: 1 }, 'worker-existing', 5)).toEqual({ kind: 'denied' })
    const construction = { kind: 'construction' as const, sessionId: 'session-new', conversation: { ...f.conversation, chat: 'chat-new' }, principal: f.principal, workspace: '/work/a', agentPreset: 'primary', generation: 1 }
    expect(f.store.claimSessionLease(construction, 'worker-a', 5)).toMatchObject({ kind: 'claimed' })
    const forged = { ...construction, generation: 2 }
    expect(f.store.claimSessionLease(forged, 'worker-b', 5)).toEqual({ kind: 'denied' })
    const created = f.store.createBinding({ conversation: construction.conversation, principal: f.principal, workspace: '/work/a', agentPreset: 'primary', sessionId: 'session-new', policyRef: 'route', expectedGeneration: 1 })
    expect(f.store.claimSessionLease({ kind: 'bound', binding: created }, 'worker-b', 5)).toMatchObject({ kind: 'busy' })
    f.store.close()
  })

  test('defers only an undispatched claimed inbox without spending an attempt', async () => {
    const f = await fixture()
    const inbox = f.store.acceptInbound({ channel: 'lark', account: 'bot-1', eventId: 'lease-busy', occurredAt: 1,
      principal: f.principal, conversation: f.conversation, kind: 'text', text: 'wait' }).record
    f.store.queueInbox(inbox.id, f.binding.id)
    const lease = f.store.claimSessionLease({ kind: 'bound', binding: f.binding }, 'session-worker', 20)
    const first = f.store.claimInbox({ ownerId: 'inbox-worker', leaseMs: 10, limit: 1, maxAttempts: 1 })[0]!
    expect(f.store.deferInboxForSessionLease({ inboxId: inbox.id, ownerId: 'inbox-worker', fencingToken: first.fencingToken, retryAt: 10 })).toBe(true)
    expect(f.store.getInbox(inbox.id)).toMatchObject({ status: 'retry_wait', attemptCount: 0, fencingToken: first.fencingToken, failureCode: 'session-lease-busy' })
    const second = f.store.claimInbox({ ownerId: 'inbox-worker', leaseMs: 10, limit: 1, maxAttempts: 1 })[0]!
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
    f.store.markInboxDispatching({ inboxId: inbox.id, ownerId: 'inbox-worker', fencingToken: second.fencingToken, binding: f.binding })
    expect(f.store.deferInboxForSessionLease({ inboxId: inbox.id, ownerId: 'inbox-worker', fencingToken: second.fencingToken, retryAt: 10 })).toBe(false)
    expect(lease.kind).toBe('claimed')
    f.store.close()
  })
})
