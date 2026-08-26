import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
