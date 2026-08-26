import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import * as delivery from '../src/index.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('trusted local pairing control plane', () => {
  test('pairs one exact principal without returning a pairing secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-operator-'))
    roots.push(root)
    const pairPrincipalLocally = (delivery as Record<string, unknown>).pairPrincipalLocally

    expect(pairPrincipalLocally).toBeTypeOf('function')
    const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' }
    const result = (pairPrincipalLocally as (input: unknown) => unknown)({
      databasePath: join(root, 'delivery.sqlite'),
      principal,
    })

    expect(result).toMatchObject({ principal, role: 'owner', status: 'active' })
    expect(JSON.stringify(result)).not.toMatch(/code|challenge|secret/i)
  })

  test('atomically hands owner authority to a reconfigured exact principal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-owner-handoff-'))
    roots.push(root)
    const databasePath = join(root, 'delivery.sqlite')
    const pairPrincipalLocally = (delivery as Record<string, unknown>).pairPrincipalLocally as (input: {
      databasePath: string
      principal: { channel: string; account: string; tenant: string; user: string }
    }) => ReturnType<DeliveryStore['getPrincipal']>
    const oldPrincipal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_old' }
    const newPrincipal = { channel: 'lark', account: 'secondary', tenant: 'new-tenant', user: 'ou_new' }
    const staleLinkedPrincipal = { channel: 'telegram', account: 'primary', tenant: 'personal', user: 'tg_old' }
    const orphanLinkedPrincipal = { channel: 'slack', account: 'legacy', tenant: 'personal', user: 'slack_orphan' }
    const first = pairPrincipalLocally({ databasePath, principal: oldPrincipal })!
    const store = new DeliveryStore({ path: databasePath })
    const oldBinding = store.createBinding({
      conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_old' },
      principal: oldPrincipal,
      workspace: '/work/owner',
      agentPreset: 'standard',
      sessionId: 'old-owner-session',
      policyRef: 'owner-dm',
    })
    const issued = store.issuePairing(newPrincipal, { ttlMs: 60_000, maxAttempts: 1 })
    const initiallyLinked = store.confirmPairing({
      challengeId: issued.challenge.id,
      principal: newPrincipal,
      code: issued.code,
    })
    expect(initiallyLinked.role).toBe('linked')
    const staleIssued = store.issuePairing(staleLinkedPrincipal, { ttlMs: 60_000, maxAttempts: 1 })
    const staleCandidate = store.confirmPairing({
      challengeId: staleIssued.challenge.id,
      principal: staleLinkedPrincipal,
      code: staleIssued.code,
    })
    const staleLinked = store.linkPrincipal({
      owner: oldPrincipal,
      linked: staleLinkedPrincipal,
      expectedLinkedVersion: staleCandidate.version,
    })
    const staleBinding = store.createBinding({
      conversation: { channel: 'telegram', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'tg_old' },
      principal: staleLinkedPrincipal,
      workspace: '/work/linked',
      agentPreset: 'standard',
      sessionId: 'stale-linked-session',
      policyRef: 'linked-dm',
    })
    const orphanIssued = store.issuePairing(orphanLinkedPrincipal, { ttlMs: 60_000, maxAttempts: 1 })
    const orphanLinked = store.confirmPairing({
      challengeId: orphanIssued.challenge.id,
      principal: orphanLinkedPrincipal,
      code: orphanIssued.code,
    })
    expect(orphanLinked).toMatchObject({ role: 'linked', status: 'active' })
    expect(orphanLinked).not.toHaveProperty('linkedToId')
    const orphanBinding = store.createBinding({
      conversation: { channel: 'slack', account: 'legacy', tenant: 'personal', kind: 'dm', chat: 'slack_orphan' },
      principal: orphanLinkedPrincipal,
      workspace: '/work/orphan',
      agentPreset: 'standard',
      sessionId: 'orphan-linked-session',
      policyRef: 'legacy-linked-dm',
    })
    store.close()

    const handedOff = pairPrincipalLocally({ databasePath, principal: newPrincipal })!
    expect(handedOff).toMatchObject({ principal: newPrincipal, role: 'owner', status: 'active' })

    const reopened = new DeliveryStore({ path: databasePath })
    try {
      expect(reopened.getPrincipal(oldPrincipal)).toMatchObject({
        id: first.id,
        role: 'owner',
        status: 'revoked',
      })
      expect(reopened.getPrincipal(newPrincipal)).toMatchObject({
        id: initiallyLinked.id,
        role: 'owner',
        status: 'active',
      })
      expect(reopened.getBinding(oldBinding.id)?.status).toBe('revoked')
      expect(reopened.getPrincipal(staleLinkedPrincipal)).toMatchObject({
        id: staleLinked.id,
        role: 'linked',
        status: 'revoked',
        linkedToId: first.id,
      })
      expect(reopened.getBinding(staleBinding.id)?.status).toBe('revoked')

      expect(reopened.getPrincipal(orphanLinkedPrincipal)).toMatchObject({
        id: orphanLinked.id,
        role: 'linked',
        status: 'revoked',
      })
      expect(reopened.getBinding(orphanBinding.id)?.status).toBe('revoked')

      const retainedPrincipal = { channel: 'telegram', account: 'secondary', tenant: 'new-tenant', user: 'tg_new' }
      const retainedIssued = reopened.issuePairing(retainedPrincipal, { ttlMs: 60_000, maxAttempts: 1 })
      const retainedCandidate = reopened.confirmPairing({
        challengeId: retainedIssued.challenge.id,
        principal: retainedPrincipal,
        code: retainedIssued.code,
      })
      const retained = reopened.linkPrincipal({
        owner: newPrincipal,
        linked: retainedPrincipal,
        expectedLinkedVersion: retainedCandidate.version,
      })
      const retainedBinding = reopened.createBinding({
        conversation: { channel: 'telegram', account: 'secondary', tenant: 'new-tenant', kind: 'dm', chat: 'tg_new' },
        principal: retainedPrincipal,
        workspace: '/work/retained',
        agentPreset: 'standard',
        sessionId: 'retained-linked-session',
        policyRef: 'linked-dm',
      })

      const retry = pairPrincipalLocally({ databasePath, principal: newPrincipal })
      expect(retry).toEqual(handedOff)
      expect(reopened.getPrincipal(retainedPrincipal)).toMatchObject({
        id: retained.id,
        role: 'linked',
        status: 'active',
        linkedToId: handedOff.id,
      })
      expect(reopened.getBinding(retainedBinding.id)?.status).toBe('active')
    } finally {
      reopened.close()
    }
  })

  test('handoff retires links whose former owner was already revoked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-revoked-owner-handoff-'))
    roots.push(root)
    const databasePath = join(root, 'delivery.sqlite')
    const oldOwner = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_old' }
    const replacement = { channel: 'lark', account: 'secondary', tenant: 'personal', user: 'ou_new' }
    const linkedPrincipal = { channel: 'telegram', account: 'primary', tenant: 'personal', user: 'tg_old' }
    const store = new DeliveryStore({ path: databasePath })
    const owner = store.handoffOwner(oldOwner)
    const issued = store.issuePairing(linkedPrincipal, { ttlMs: 60_000, maxAttempts: 1 })
    const candidate = store.confirmPairing({
      challengeId: issued.challenge.id,
      principal: linkedPrincipal,
      code: issued.code,
    })
    const linked = store.linkPrincipal({ owner: oldOwner, linked: linkedPrincipal,
      expectedLinkedVersion: candidate.version })
    const binding = store.createBinding({
      conversation: { channel: 'telegram', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'tg_old' },
      principal: linkedPrincipal,
      workspace: '/work/linked',
      agentPreset: 'standard',
      sessionId: 'already-revoked-owner-link',
      policyRef: 'linked-dm',
    })
    store.revokePrincipal(owner.id, owner.version)
    expect(store.getPrincipal(linkedPrincipal)).toMatchObject({ id: linked.id, status: 'active', linkedToId: owner.id })

    const next = store.handoffOwner(replacement)
    expect(next).toMatchObject({ principal: replacement, role: 'owner', status: 'active' })
    expect(store.getPrincipal(linkedPrincipal)).toMatchObject({ id: linked.id, role: 'linked', status: 'revoked' })
    expect(store.getBinding(binding.id)?.status).toBe('revoked')
    store.close()
  })

  test('finds only the unique active owner DM binding for an exact Lark route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-owner-binding-'))
    roots.push(root)
    const databasePath = join(root, 'delivery.sqlite')
    const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' }
    const store = new DeliveryStore({ path: databasePath })
    try {
      store.issuePairing(principal, { ttlMs: 60_000, maxAttempts: 1 })
      const issued = store.issuePairing(principal, { ttlMs: 60_000, maxAttempts: 1 })
      store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
      store.createBinding({
        conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
        principal, workspace: '/work/owner', agentPreset: 'standard', sessionId: 'owner', policyRef: 'owner-dm',
      })
    } finally {
      store.close()
    }
    const find = (delivery as Record<string, unknown>).findActiveOwnerDmBindingsLocally
    expect(find).toBeTypeOf('function')
    expect((find as (input: unknown) => unknown)({
      databasePath, account: 'primary', tenant: 'personal', workspace: '/work/owner', agentPreset: 'standard',
    })).toEqual([expect.objectContaining({ conversation: expect.objectContaining({ kind: 'dm' }), principal })])
  })
})
