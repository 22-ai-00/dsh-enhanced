import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.js'
import { DeliveryStore } from '../src/store.js'
import type { DeliveryAdapterContext, DeliveryInboundIntakeObserver, DeliveryInboundIntakeSignal, DeliveryInboundObservation } from '../src/types.js'
import { workItemReplyDigest, type WorkItemReplyConsumerRegistration } from '../src/work-item-replies.js'

// WP20 slice 2: Delivery turns an adapter observation into a metadata-only
// intake signal. The WorkItems peer is a narrow ownership fixture here; the
// real WorkItems ledger is exercised in assistant-work-items/tests.
const roots: string[] = [], contexts: Context[] = []
const principal = { channel: 'lark', account: 'intake-test', tenant: 'tenant', user: 'owner' }
const stranger = { ...principal, user: 'stranger' }
const conversation = { channel: principal.channel, account: principal.account, tenant: principal.tenant, kind: 'dm' as const, chat: 'owner-chat' }
const scope = { workspace: '/work/intake', preset: 'primary' }
const producerId = 'work-items-source'
const digest = createHash('sha256').update('hello').digest('hex')

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-inbound-intake-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'send', effect: 'allow', subject: { kind: 'background', id: producerId, workspace: scope.workspace, principal: 'lark/intake-test/tenant/owner' }, actions: ['send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
  ] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false })
  const service = ctx.assistantDelivery, store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const pair = store.issuePairing(principal, { ttlMs: 60000, maxAttempts: 3 }); store.confirmPairing({ challengeId: pair.challenge.id, principal, code: pair.code })
  const binding = store.createBinding({ conversation, principal, workspace: scope.workspace, agentPreset: scope.preset, sessionId: 'session', policyRef: 'owner' })
  const row = store.getPrincipal(principal)!, owner = { principalRecordId: row.id, principalVersion: row.version }
  let owned: unknown
  const registration: WorkItemReplyConsumerRegistration = { protocol: 1, sourceId: producerId, continuationAutomationId: 'reply-worker',
    inspectReport: input => ({ protocol: 'assistant-delivery/work-item-report/v1', itemId: input.itemId, reportRevision: 1, streamId: input.itemId,
      reportDigest: workItemReplyDigest(['report', input.itemId]), sourceId: producerId, scope, owner }),
    inspectChild: () => true, onPending: () => {}, onCancelled: () => {} }
  ctx.provide('assistantWorkItems' as never, {
    ownsWorkItemReplyRegistration: (input: unknown) => input === registration,
    ownsInboundIntakeObserver: (input: unknown) => owned !== undefined && input === owned,
  } as never)
  service.registerWorkItemReplyConsumer(registration)
  let adapterContext: DeliveryAdapterContext | undefined, sent = 0
  await service.registerAdapter({ channel: principal.channel, account: principal.account,
    capabilities: { formats: ['plain', 'markdown'], receipts: [], reconcileUnknownSend: false },
    start: async context => { adapterContext = context }, send: async () => ({ outcome: 'accepted', providerMessageId: `report-${++sent}` }) })
  const signals: DeliveryInboundIntakeSignal[] = []
  const observe = vi.fn((signal: DeliveryInboundIntakeSignal) => { signals.push(signal) })
  const observer: DeliveryInboundIntakeObserver = Object.freeze({ protocol: 1 as const, observe })
  async function report(itemId: string) {
    service.enqueueWorkItemReport({ sourceId: producerId, workspace: scope.workspace, bindingId: binding.id, idempotencyKey: `report:${itemId}`,
      text: `Report ${itemId}`, format: 'plain', itemId, reportRevision: 1 })
    await service.tick(); await service.whenIdle()
  }
  const observation = (overrides: Partial<DeliveryInboundObservation> = {}): DeliveryInboundObservation => ({
    eventId: 'om_1', occurredAt: 1_000, principal, conversation: { kind: 'dm', chat: conversation.chat },
    addressed: true, senderIsBot: false, contentDigest: digest, ...overrides })
  return { service, store, observer, observe, signals, report, observation, context: () => adapterContext!,
    own: (value: unknown) => { owned = value } }
}

describe('Delivery inbound intake observation', () => {
  test('registration is fenced by current WorkItems ownership and is exclusive', async () => {
    const f = await fixture()
    expect(() => f.service.registerInboundIntakeObserver(f.observer)).toThrow(/lacks current WorkItems ownership/u)
    f.own(f.observer)
    const unregister = f.service.registerInboundIntakeObserver(f.observer)
    expect(() => f.service.registerInboundIntakeObserver({ protocol: 1, observe: vi.fn() })).toThrow(/already registered/u)
    expect(() => f.service.registerInboundIntakeObserver('nope' as never)).toThrow(/invalid inbound intake observer/u)
    unregister(); unregister()
    expect(() => f.service.registerInboundIntakeObserver(f.observer)).not.toThrow()
  })

  test('maps an observation to a frozen metadata-only signal with the active allowlist', async () => {
    const f = await fixture(); f.own(f.observer); f.service.registerInboundIntakeObserver(f.observer)
    f.context().observe!(f.observation())
    f.context().observe!(f.observation({ eventId: 'om_2', principal: stranger, conversation: { kind: 'group', chat: 'oc_group' }, addressed: false }))
    expect(f.signals).toEqual([
      { source: 'lark-channel', sourceEventId: 'intake-test/om_1', kind: 'message', senderAllowlisted: true, addressed: true,
        threadFollowUp: false, senderIsBot: false, groupMessage: false, contentDigest: digest, occurredAt: 1_000 },
      { source: 'lark-channel', sourceEventId: 'intake-test/om_2', kind: 'message', senderAllowlisted: false, addressed: false,
        threadFollowUp: false, senderIsBot: false, groupMessage: true, contentDigest: digest, occurredAt: 1_000 },
    ])
    expect(Object.isFrozen(f.signals[0])).toBe(true)
    // A revoked principal is no longer allowlisted.
    const row = f.store.getPrincipal(principal)!; f.store.revokePrincipal(row.id, row.version)
    f.context().observe!(f.observation({ eventId: 'om_3' }))
    expect(f.signals[2]).toMatchObject({ senderAllowlisted: false })
  })

  test('a thread follow-up needs an allowlisted sender replying in-thread to a delivered report', async () => {
    const f = await fixture(); f.own(f.observer); f.service.registerInboundIntakeObserver(f.observer)
    await f.report('P')
    f.context().observe!(f.observation({ eventId: 'r1', replyToProviderMessageId: 'report-1', addressed: false }))
    f.context().observe!(f.observation({ eventId: 'r2', replyToProviderMessageId: 'unknown-message' }))
    f.context().observe!(f.observation({ eventId: 'r3', replyToProviderMessageId: 'report-1', conversation: { kind: 'group', chat: 'oc_other' } }))
    // A non-allowlisted reply to the same report is never a follow-up.
    f.context().observe!(f.observation({ eventId: 'r4', replyToProviderMessageId: 'report-1', principal: stranger }))
    expect(f.signals.map(signal => [signal.sourceEventId, signal.threadFollowUp])).toEqual([
      ['intake-test/r1', true], ['intake-test/r2', false], ['intake-test/r3', false], ['intake-test/r4', false],
    ])
  })

  test('is a no-op without a current observer and drops invalid or failing observations', async () => {
    const f = await fixture()
    expect(() => f.context().observe!(f.observation())).not.toThrow()
    f.own(f.observer); f.service.registerInboundIntakeObserver(f.observer)
    for (const invalid of [
      { eventId: '' }, { eventId: 'x'.repeat(257) }, { occurredAt: -1 }, { occurredAt: 1.5 }, { contentDigest: 'ABC' },
      { addressed: 'yes' as never }, { conversation: { kind: 'channel' as never, chat: 'c' } },
      { principal: { ...principal, channel: 'Bad Channel' } }, { replyToProviderMessageId: '' },
    ]) f.context().observe!(f.observation(invalid))
    f.context().observe!(null as never)
    expect(f.observe).not.toHaveBeenCalled()
    // Ownership loss silences the observer without unregistering it.
    f.own(undefined)
    f.context().observe!(f.observation())
    expect(f.observe).not.toHaveBeenCalled()
    f.own(f.observer)
    f.observe.mockImplementationOnce(() => { throw new Error('observer failure') })
    expect(() => f.context().observe!(f.observation())).not.toThrow()
    f.context().observe!(f.observation({ eventId: 'om_after' }))
    expect(f.signals.map(signal => signal.sourceEventId)).toEqual(['intake-test/om_after'])
    // Observation writes nothing to Delivery.
    expect(f.store.getInboxByProviderEvent('lark', 'intake-test', 'om_after')).toBeUndefined()
  })
})
