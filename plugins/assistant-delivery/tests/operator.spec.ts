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
