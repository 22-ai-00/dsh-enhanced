import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'
import type { InboundEnvelope } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-native-admission-'))
  roots.push(root)
  const path = join(root, 'delivery.sqlite')
  let now = 1_000
  const store = new DeliveryStore({ path, now: () => now, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'web', account: 'control-plane', tenant: 'local', user: 'operator' }
  const conversation = { channel: 'web', account: 'control-plane', tenant: 'local', kind: 'dm' as const, chat: 'operator' }
  const issue = store.issuePairing(principal, { ttlMs: 10_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issue.challenge.id, principal, code: issue.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/web', agentPreset: 'primary',
    sessionId: 'web-session', policyRef: 'local-control-plane' })
  const owner = store.getPrincipal(principal)!
  const ownerLineage = { principalRecordId: owner.id, principalVersion: owner.version }
  return { path, store, binding, principal, conversation, ownerLineage, now: (value: number) => { now = value } }
}

function envelope(eventId: string, f: Awaited<ReturnType<typeof fixture>>): InboundEnvelope {
  return { channel: 'web', account: 'control-plane', eventId, occurredAt: 1_000,
    principal: f.principal, conversation: f.conversation, kind: 'text', text: `native ${eventId}` }
}

function admit(f: Awaited<ReturnType<typeof fixture>>, eventId = 'native-1') {
  return f.store.claimNativeInbox({ envelope: envelope(eventId, f), binding: f.binding, ownerLineage: f.ownerLineage,
    ownerId: 'host-native-web', leaseMs: 100 })
}

describe('native Inbox admission', () => {
  test('atomically claims an exact native Inbox, leaving the scheduler unable to steal it from another connection', async () => {
    const f = await fixture()
    const admitted = admit(f)
    expect(admitted).toMatchObject({ duplicate: false, fencingToken: 1,
      record: { status: 'claimed', bindingId: f.binding.id, claimedBy: 'host-native-web', attemptCount: 1 } })

    const otherPrincipal = { ...f.principal, user: 'other-operator' }
    const issue = f.store.issuePairing(otherPrincipal, { ttlMs: 10_000, maxAttempts: 3 })
    f.store.confirmPairing({ challengeId: issue.challenge.id, principal: otherPrincipal, code: issue.code })
    const otherConversation = { ...f.conversation, chat: 'other-operator' }
    const otherBinding = f.store.createBinding({ conversation: otherConversation, principal: otherPrincipal,
      workspace: '/work/other', agentPreset: 'primary', sessionId: 'other-session', policyRef: 'other-route' })
    const other = f.store.acceptInbound({ ...envelope('ordinary-other', f), principal: otherPrincipal,
      conversation: otherConversation }).record
    f.store.queueInbox(other.id, otherBinding.id)

    const observer = new DeliveryStore({ path: f.path, now: () => 1_000 })
    const ordinary = observer.claimInbox({ ownerId: 'ordinary-scheduler', leaseMs: 100, limit: 10, maxAttempts: 3 })
    expect(ordinary).toMatchObject([{ record: { id: other.id } }])
    expect(ordinary.map(claim => claim.record.id)).not.toContain(admitted.record.id)
    expect(observer.getInbox(admitted.record.id)).toMatchObject({ status: 'claimed', fencingToken: 1 })
    observer.close()
    f.store.close()
  })

  test('returns an exact provider replay without renewing, reclaiming, or adding an attempt', async () => {
    const f = await fixture()
    const first = admit(f, 'native-replay')
    f.now(1_050)
    const replay = admit(f, 'native-replay')
    expect(replay).toEqual({ duplicate: true, record: first.record })
    expect(replay.fencingToken).toBeUndefined()
    expect(f.store.getInbox(first.record.id)).toMatchObject({ attemptCount: 1, leaseUntil: 1_100, fencingToken: 1 })
    f.store.close()
  })

  test('rejects a stale or revoked binding before persisting the native event', async () => {
    const f = await fixture()
    const owner = f.store.getPrincipal(f.principal)!
    f.store.revokePrincipal(owner.id, owner.version)
    expect(() => admit(f, 'native-revoked')).toThrowError(expect.objectContaining({ code: 'invalid-binding' }))
    expect(f.store.getInboxByProviderEvent('web', 'control-plane', 'native-revoked')).toBeUndefined()
    f.store.close()
  })

  test('rolls back a fresh native event when an earlier lane admission is unfinished', async () => {
    const f = await fixture()
    const earlier = f.store.acceptInbound(envelope('ordinary-earlier', f)).record
    f.store.queueInbox(earlier.id, f.binding.id)
    expect(() => admit(f, 'native-blocked')).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.getInboxByProviderEvent('web', 'control-plane', 'native-blocked')).toBeUndefined()
    expect(f.store.getInbox(earlier.id)).toMatchObject({ status: 'queued' })
    f.store.close()
  })

  test('rejects stale owner lineage even when the transport identity is unchanged', async () => {
    const f = await fixture()
    expect(() => f.store.claimNativeInbox({ envelope: envelope('stale-owner', f), binding: f.binding,
      ownerLineage: { ...f.ownerLineage, principalVersion: f.ownerLineage.principalVersion + 1 },
      ownerId: 'host-native-web', leaseMs: 100 })).toThrowError(expect.objectContaining({ code: 'invalid-binding' }))
    expect(f.store.getInboxByProviderEvent('web', 'control-plane', 'stale-owner')).toBeUndefined()
    f.store.close()
  })

  test('atomically promotes only the exact live construction lease into its new binding', async () => {
    const f = await fixture()
    const conversation = { ...f.conversation, chat: 'new-session' }
    const construction = { kind: 'construction' as const, sessionId: 'new-session', conversation,
      principal: f.principal, workspace: '/work/web', agentPreset: 'primary', generation: 1 }
    const claimed = f.store.claimSessionLease(construction, 'web-construction', 100)
    if (claimed.kind !== 'claimed') throw new Error('construction denied')
    expect(f.store.markSessionLeaseDispatched(claimed.lease)).toBe(true)
    const bindingInput = { conversation, principal: f.principal, workspace: '/work/web', agentPreset: 'primary',
      sessionId: 'new-session', policyRef: 'web', expectedGeneration: 1 }
    expect(() => f.store.createBinding({ ...bindingInput, constructionLease: { ...claimed.lease, fencingToken: 2 } })).toThrow()
    expect(() => f.store.createBinding({ ...bindingInput, workspace: '/other', constructionLease: claimed.lease })).toThrow()
    expect(f.store.getBindingBySession('new-session')).toBeUndefined()
    const binding = f.store.createBinding({ ...bindingInput, constructionLease: claimed.lease })
    expect(f.store.hasSessionLease(claimed.lease)).toBe(true)
    const observer = new DeliveryStore({ path: f.path, now: () => 1_000 })
    try {
      expect(observer.claimSessionLease({ kind: 'bound', binding }, 'second', 100)).toEqual({ kind: 'busy' })
      expect(f.store.finishSessionLease(claimed.lease, { quiescent: true })).toBe(true)
      expect(observer.claimSessionLease({ kind: 'bound', binding }, 'second', 100)).toMatchObject({ kind: 'claimed', lease: { fencingToken: 2 } })
    } finally { observer.close(); f.store.close() }
  })

  test.each([false, true])('never recovers native input as ordinary Delivery work after dispatch=%s', async dispatched => {
    const f = await fixture()
    const native = { ...envelope('native-crash', f), text: '/permission full' }
    const claimed = f.store.claimNativeInbox({ envelope: native, binding: f.binding, ownerLineage: f.ownerLineage,
      ownerId: 'host-native-web', leaseMs: 100 })
    if (dispatched) f.store.markInboxDispatching({ inboxId: claimed.record.id, ownerId: 'host-native-web', fencingToken: claimed.fencingToken!, binding: f.binding })
    f.now(1_101)
    expect(f.store.recoverInbox({ maxAttempts: 3 })).toMatchObject([{ id: claimed.record.id, status: 'dead_letter' }])
    expect(f.store.claimInbox({ ownerId: 'ordinary', leaseMs: 100, limit: 10, maxAttempts: 3 })).toEqual([])
    f.store.close()
  })

  test('shares dispatch, renewal, and completion fences with the ordinary Inbox state machine', async () => {
    const f = await fixture()
    const admitted = admit(f, 'native-lifecycle')
    if (admitted.fencingToken === undefined) throw new Error('fresh native admission did not receive a fence')
    expect(f.store.renewInboxClaim({ inboxId: admitted.record.id, ownerId: 'host-native-web',
      fencingToken: admitted.fencingToken, leaseMs: 100 })).toBe(true)
    const dispatching = f.store.markInboxDispatching({ inboxId: admitted.record.id, ownerId: 'host-native-web',
      fencingToken: admitted.fencingToken, binding: f.binding })
    expect(dispatching.failureCode).toBe('native-dispatch-started')
    expect(f.store.finishInbox({ inboxId: admitted.record.id, ownerId: 'host-native-web',
      fencingToken: admitted.fencingToken, outcome: 'processed' })).toMatchObject({ status: 'processed' })
    f.store.close()
  })
})
