import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantDeliveryService,
  type OwnerRouteAuthority,
  ownerRouteAuthorityHash,
} from '../src/index.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
const contexts = new Set<Context>()

const principal = {
  channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner',
}
const conversation = {
  channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner',
}
const authority: OwnerRouteAuthority = {
  id: 'owner-route-primary',
  conversation,
  principal,
  workspace: '/work/alpha',
  agentPreset: 'primary',
  policyRef: 'owner-dm',
  minimumGeneration: 1,
}

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => {
    await ctx.fiber.restart()
    contexts.delete(ctx)
  }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('listActiveOwnerRouteScopes', () => {
  test('enumerates active owner routes with zero message or secret exposure and omits unbound/revoked routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-scopes-'))
    roots.push(root)
    const ctx = new Context()
    contexts.add(ctx)

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
          actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['foreground'] } },
        { id: 'owner-pair', effect: 'allow',
          subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
          actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['external'] } },
      ],
    })
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      ownerRoutes: [authority],
    })

    const service = ctx.assistantDelivery
    const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore

    // Before pairing/binding -> empty
    expect(service.listActiveOwnerRouteScopes()).toEqual([])

    const pairing = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    const owner = store.getPrincipal(principal)!
    store.createBinding({
      conversation,
      principal,
      workspace: '/work/alpha',
      agentPreset: 'primary',
      sessionId: 'session-1',
      policyRef: 'owner-dm',
    })

    const scopes = service.listActiveOwnerRouteScopes()
    expect(scopes).toHaveLength(1)
    expect(scopes[0]).toEqual({
      authorityId: 'owner-route-primary',
      authorityHash: ownerRouteAuthorityHash(authority),
      principalId: 'lark/bot-1/tenant-a/ou_owner',
      principalRecordId: owner.id,
      principalVersion: owner.version,
      workspace: '/work/alpha',
      agentPreset: 'primary',
    })
    // Ensure zero extra fields (no sessionId, conversation, messages, secrets)
    expect(Object.keys(scopes[0]!).sort()).toEqual([
      'agentPreset', 'authorityHash', 'authorityId', 'principalId',
      'principalRecordId', 'principalVersion', 'workspace',
    ])

    // Revoking owner removes route from active scopes
    store.revokePrincipal(owner.id, owner.version)
    expect(service.listActiveOwnerRouteScopes()).toEqual([])
  })
})
