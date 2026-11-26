import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
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
  return { service, store, binding, observer, observe, signals, report, observation, context: () => adapterContext!,
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

  test('forwards the transient text only to an opted-in observer and only when it matches the digest', async () => {
    const plain = await fixture(); plain.own(plain.observer); plain.service.registerInboundIntakeObserver(plain.observer)
    plain.context().observe!(plain.observation({ text: 'hello' }))
    expect(plain.signals[0]).not.toHaveProperty('sourceText')

    const f = await fixture()
    const opted: DeliveryInboundIntakeObserver = Object.freeze({ protocol: 1 as const, acceptsSourceText: true as const, observe: f.observe })
    f.own(opted); f.service.registerInboundIntakeObserver(opted)
    f.context().observe!(f.observation({ text: 'hello' }))
    f.context().observe!(f.observation({ eventId: 'om_2', text: 'hello!' }))
    { const { contentDigest: _digest, ...undigested } = f.observation({ eventId: 'om_3', text: 'hello' }); f.context().observe!(undigested) }
    f.context().observe!(f.observation({ eventId: 'om_4', text: 'x'.repeat(65_537), contentDigest: createHash('sha256').update('x'.repeat(65_537)).digest('hex') }))
    expect(f.signals.map(signal => [signal.sourceEventId, signal.sourceText])).toEqual([
      ['intake-test/om_1', 'hello'], ['intake-test/om_2', undefined], ['intake-test/om_3', undefined], ['intake-test/om_4', undefined],
    ])
    expect(Object.hasOwn(f.signals[1]!, 'sourceText')).toBe(false)
    expect(f.store.getInboxByProviderEvent('lark', 'intake-test', 'om_1')).toBeUndefined()
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

  test('prepares a foreground-turn acceptance contract only when opted into intake objective with matching owner binding', async () => {
    const f = await fixture()
    const prepare = vi.fn(() => ({ contractId: 'contract-intake-1', contractDigest: 'c'.repeat(64) }))
    const verifierStub = {
      ownsTaskAcceptanceRegistration: (value: unknown) => value === registration,
    }
    const ctx = (f.service as unknown as { context: Context }).context
    ctx.provide('assistantVerifier' as never, verifierStub as never)
    const registration = {
      protocol: 'assistant-verifier/host-producer/v1' as const,
      generation: (f.service as unknown as { trustedAcceptanceProducerGeneration(): string }).trustedAcceptanceProducerGeneration(),
      owner: verifierStub,
      requiresAcceptance: true,
      prepare,
      completed: async () => {},
    }
    const unregisterSink = f.service.registerTaskAcceptanceSink(registration)
    try {
      const binding = f.binding
      const objective = 'Run verification check on workspace'
      const objectiveDigest = createHash('sha256').update(objective, 'utf8').digest('hex')
      const observer = Object.freeze({
        protocol: 1 as const,
        acceptsSourceText: true as const,
        acceptsIntakeObjective: true as const,
        originBindingId: binding.id,
        acceptanceObjective: 'Bounded intake acceptance profile',
        observe: f.observe,
      }) as DeliveryInboundIntakeObserver
      f.own(observer)
      f.service.registerInboundIntakeObserver(observer)

      // Allowlisted inferred candidate receives objective, objectiveDigest, and prepared acceptance handle.
      f.context().observe!(f.observation({
        eventId: 'om_inferred_1',
        addressed: false,
        contentDigest: objectiveDigest,
        text: objective,
      }))
      expect(prepare).toHaveBeenCalledOnce()
      expect(prepare).toHaveBeenCalledWith({
        scope,
        owner: { principalRecordId: expect.any(String), principalVersion: 1 },
        task: { kind: 'foreground-turn', ref: 'intake:lark:intake-test:om_inferred_1' },
        objective: 'Bounded intake acceptance profile',
      })
      expect(f.signals[0]).toMatchObject({
        sourceEventId: 'intake-test/om_inferred_1',
        sourceText: objective,
        objective,
        objectiveDigest,
        acceptance: { contractId: 'contract-intake-1', contractDigest: 'c'.repeat(64) },
      })

      // Explicit addressed message carries objective when verified, but does not mint extra verifier contracts.
      prepare.mockClear()
      f.context().observe!(f.observation({
        eventId: 'om_explicit_1',
        addressed: true,
        contentDigest: objectiveDigest,
        text: objective,
      }))
      expect(prepare).not.toHaveBeenCalled()
      expect(f.signals[1]).toMatchObject({ objective, objectiveDigest })
      expect(Object.hasOwn(f.signals[1]!, 'acceptance')).toBe(false)

      // Stranger or missing-profile fails closed without acceptance handle and never throws.
      prepare.mockReturnValueOnce(null as never)
      f.context().observe!(f.observation({
        eventId: 'om_null_profile',
        addressed: false,
        contentDigest: objectiveDigest,
        text: objective,
      }))
      expect(Object.hasOwn(f.signals[2]!, 'acceptance')).toBe(false)

      f.context().observe!(f.observation({
        eventId: 'om_stranger',
        principal: stranger,
        addressed: false,
        contentDigest: objectiveDigest,
        text: objective,
      }))
      expect(Object.hasOwn(f.signals[3]!, 'acceptance')).toBe(false)
    } finally {
      unregisterSink()
    }
  })

  test('notifies foreground task completion listeners on execution finish and unregisters cleanly', async () => {
    const f = await fixture()
    const binding = f.binding
    const row = f.store.getPrincipal(principal)!
    const claimAndBind = (suffix: string) => {
      const admitted = f.store.claimNativeInbox({
        envelope: { channel: principal.channel, account: principal.account, eventId: `evt-${suffix}`, occurredAt: Date.now(), principal, conversation, kind: 'text', text: 'hello' },
        binding,
        ownerLineage: { principalRecordId: row.id, principalVersion: row.version },
        ownerId: 'worker-1',
        leaseMs: 60_000,
      })
      f.store.bindForegroundTaskExecution({
        inboxId: admitted.record.id,
        scope,
        owner: { principalRecordId: row.id, principalVersion: row.version },
        binding,
        dispatchedAt: Date.now(),
      })
      return admitted
    }

    const first = claimAndBind('1')
    const listener = vi.fn()
    const unsubscribe = f.service.onForegroundTaskCompletion(listener)
    ;(f.service as unknown as { completeForegroundTaskExecution(id: string, input: { status: 'succeeded'; quiescent: boolean }): void })
      .completeForegroundTaskExecution(first.record.id, { status: 'succeeded', quiescent: true })
    f.store.finishInbox({ inboxId: first.record.id, ownerId: 'worker-1', fencingToken: first.fencingToken!, outcome: 'processed' })
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    const second = claimAndBind('2')
    ;(f.service as unknown as { completeForegroundTaskExecution(id: string, input: { status: 'succeeded'; quiescent: boolean }): void })
      .completeForegroundTaskExecution(second.record.id, { status: 'succeeded', quiescent: true })
    expect(listener).toHaveBeenCalledOnce()
  })
})
