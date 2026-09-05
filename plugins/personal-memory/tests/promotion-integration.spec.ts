import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService, type ApprovalDispatchRouteV2 } from '@dsh-enhanced/assistant-policy'
import {
  AssistantDeliveryService,
  externalPrincipalId,
  type ConversationBinding,
  type ConversationRef,
  type DeliveryInboundRuntime,
  type DeliveryPrincipal,
  type ExternalPrincipalKey,
  type InboundEnvelope,
} from '@dsh-enhanced/assistant-delivery'
import {
  PREFERENCE_MEMORY_PROMOTION_CONTENT,
  PREFERENCE_MEMORY_PROMOTION_RENDERER_ID,
  withPreferenceMemoryPromotionCancellationDigest,
  withPreferenceMemoryPromotionRequestDigest,
} from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryPromotionCancelledError, MemoryProposalManager } from '../src/proposals.ts'
import { PersonalMemoryService } from '../src/service.ts'
import { memoryPrincipalDigest, MemoryStore } from '../src/store.ts'
import type { MemoryOwnerNamespace, MemoryProposalInput } from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []
const stores = new Set<MemoryStore>()
const principal = 'lark/main/tenant/owner'
const scope = Object.freeze({ workspace: '/work/alpha', preset: 'primary' })
const principalKey: ExternalPrincipalKey = Object.freeze({
  channel: 'lark', account: 'main', tenant: 'tenant', user: 'owner',
})
const replacementPrincipalKey: ExternalPrincipalKey = Object.freeze({
  channel: 'lark', account: 'main', tenant: 'tenant', user: 'replacement',
})
const conversation: ConversationRef = Object.freeze({
  channel: 'lark', account: 'main', tenant: 'tenant', kind: 'dm', chat: 'owner-chat',
})

afterEach(async () => {
  for (const store of stores) store.close()
  stores.clear()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function namespace(principalRecordId = 'principal-row-owner', principalVersion = 1): MemoryOwnerNamespace {
  return Object.freeze({
    mode: 'delivery' as const,
    principalDigest: memoryPrincipalDigest(principal),
    principalRecordId,
    principalVersion,
  })
}

function dispatch(bindingGeneration = 1, principalVersion = 1): ApprovalDispatchRouteV2 {
  return Object.freeze({
    routeVersion: 2,
    sourceId: 'dsh-enhanced-personal-memory',
    bindingId: `binding-owner-${bindingGeneration}`,
    bindingVersion: bindingGeneration,
    bindingGeneration,
    workspace: scope.workspace,
    principal,
    principalRecordId: 'principal-row-owner',
    principalVersion,
  })
}

function promotionRequest(
  index: number,
  ownerGeneration = 1,
  principalVersion = 1,
  principalRecordId = 'principal-row-owner',
) {
  return withPreferenceMemoryPromotionRequestDigest({
    contractVersion: 1 as const,
    promotionId: `promotion-integration-${index}`,
    promotionGeneration: 1,
    idempotencyKey: `preference-memory-integration:${index}`,
    scope,
    principalId: principal,
    principalLineage: { principalRecordId, principalVersion },
    ownerGeneration,
    hypothesis: {
      id: `hypothesis-integration-${index}`,
      key: 'memory.retention' as const,
      value: 'long-term' as const,
      version: 2,
      confidenceBps: 9_000,
      contradictionBps: 500,
      supportingSignals: 3,
      distinctSignalSources: 2,
      evidenceMass: 3_000,
    },
    rendererId: PREFERENCE_MEMORY_PROMOTION_RENDERER_ID,
    observedAt: 100_000,
    deadlineAt: 160_000,
  })
}

function proposalInput(index: number, ownerGeneration = 1, principalVersion = 1): MemoryProposalInput {
  const request = promotionRequest(index, ownerGeneration, principalVersion)
  return Object.freeze({
    idempotencyKey: request.idempotencyKey,
    requester: 'preference-learning',
    principal,
    namespace: namespace('principal-row-owner', principalVersion),
    dispatch: dispatch(ownerGeneration, principalVersion),
    ttlMs: 60_000,
    notAfter: request.deadlineAt,
    promotion: {
      promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration,
      requestDigest: request.requestDigest,
      scope: request.scope,
      ownerGeneration: request.ownerGeneration,
    },
    mutation: {
      op: 'add' as const,
      identity: { owner: 'user' as const, scope: 'workspace' as const, workspace: scope.workspace },
      entry: {
        kind: 'preference' as const,
        content: PREFERENCE_MEMORY_PROMOTION_CONTENT,
        sensitivity: 'private' as const,
        trust: 'user-confirmed' as const,
        confidence: 0.9,
        provenance: {
          source: `preference-learning:${PREFERENCE_MEMORY_PROMOTION_RENDERER_ID}`,
          observedAt: request.observedAt,
          uri: `preference://${request.hypothesis.id}/v${request.hypothesis.version}`,
        },
      },
    },
  })
}

function agent(sessionId = `memory-promotion-integration-${Math.random()}`): Agent {
  const id = SessionId(sessionId)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 1,
    cwd: scope.workspace, agentPreset: scope.preset, isSeeded: false,
  })
  return {
    id, options: {}, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {},
  }
}

async function realDeliveryMemoryHarness() {
  const root = await mkdtemp(join(tmpdir(), 'memory-promotion-real-delivery-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const policy = new AssistantPolicyService(ctx, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [{
      id: 'allow-memory-integration', effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: scope.workspace },
      actions: ['propose', 'read', 'search'], resource: { kind: 'memory', id: '*' },
    }, {
      id: 'allow-delivery-integration', effect: 'allow',
      subject: { kind: 'external', id: principal },
      actions: ['ingest'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['external'] },
    }],
  }, { now: () => 100_000 })
  const delivery = new AssistantDeliveryService(ctx, {
    databasePath: join(root, 'delivery.sqlite'),
    spoolPath: join(root, 'spool'),
    schedulerEnabled: false,
    defaultWorkspace: scope.workspace,
    defaultAgentPreset: scope.preset,
  })
  const memory = new PersonalMemoryService(ctx, {
    databasePath: join(root, 'memory.sqlite'),
    approvalMode: 'delivery-required',
    reconcileIntervalMs: 0,
  })
  const deliveryStore = (delivery as unknown as { deliveryStore: {
    handoffOwner(input: ExternalPrincipalKey): DeliveryPrincipal
    createBinding(input: {
      conversation: ConversationRef
      principal: ExternalPrincipalKey
      workspace: string
      agentPreset: string
      sessionId: string
      policyRef: string
    }): ConversationBinding
    getActiveBinding(input: ConversationRef): ConversationBinding | undefined
    getPrincipal(input: ExternalPrincipalKey): DeliveryPrincipal | undefined
  } }).deliveryStore
  const memoryStore = (memory as unknown as { memoryStore: MemoryStore }).memoryStore
  return { ctx, policy, delivery, deliveryStore, memory, memoryStore }
}

describe('preference Memory cross-instance and owner integration', () => {
  test('cancellation-before-submit wins across two stores and a cold restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-promotion-cancel-race-'))
    roots.push(root)
    const memoryPath = join(root, 'memory.sqlite')
    const ctx = new Context()
    contexts.push(ctx)
    const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), rules: [] }, {
      now: () => 100_000,
    })
    const first = new MemoryStore({ path: memoryPath, now: () => 100_000 })
    const second = new MemoryStore({ path: memoryPath, now: () => 100_001 })
    stores.add(first)
    stores.add(second)
    const request = promotionRequest(1)
    const cancellation = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const,
      promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration,
      requestDigest: request.requestDigest,
      principalLineage: request.principalLineage,
      ownerGeneration: request.ownerGeneration,
      reason: 'forget' as const,
      occurredAt: 100_001,
    })

    expect(first.cancelPromotionBeforeOrAfterSubmit(cancellation).outcome).toBe('cancelled')
    expect(second.cancelPromotionBeforeOrAfterSubmit(cancellation).outcome).toBe('replayed')
    expect(() => new MemoryProposalManager(second, policy).propose(proposalInput(1)))
      .toThrowError(MemoryPromotionCancelledError)
    expect(policy.listPendingApprovalDispatches()).toEqual([])

    first.close()
    second.close()
    const restarted = new MemoryStore({ path: memoryPath, now: () => 100_002 })
    stores.add(restarted)
    expect(() => new MemoryProposalManager(restarted, policy).propose(proposalInput(1)))
      .toThrowError(MemoryPromotionCancelledError)
    expect(restarted.listPendingProposals(10)).toEqual([])
    expect(restarted.listPendingPromotionResults(10)).toEqual([])
  })

  test('compensates commit-before-ACK loss across two stores and restart without reviving the old lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-promotion-confirm-cancel-race-'))
    roots.push(root)
    const memoryPath = join(root, 'memory.sqlite')
    const ctx = new Context()
    contexts.push(ctx)
    const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), rules: [] }, {
      now: () => 100_000,
    })
    const first = new MemoryStore({ path: memoryPath, now: () => 100_000 })
    const second = new MemoryStore({ path: memoryPath, now: () => 100_001 })
    stores.add(first)
    stores.add(second)
    const input = proposalInput(2)
    const manager = new MemoryProposalManager(first, policy, () => 'current')
    const pending = manager.propose(input)
    const committed = manager.decide({
      proposalId: pending.proposalId, principal, expectedVersion: pending.version,
      decision: 'approved', reason: 'confirmed before result acknowledgement',
    })
    const [result] = first.listPendingPromotionResults(10)
    if (result === undefined || committed.record === undefined || input.promotion === undefined) {
      throw new Error('expected a durable confirmed promotion')
    }
    const ownerNamespace = namespace()
    if (ownerNamespace.mode !== 'delivery') throw new Error('expected a Delivery namespace')
    const cancellation = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const, promotionId: input.promotion.promotionId,
      promotionGeneration: input.promotion.promotionGeneration,
      requestDigest: input.promotion.requestDigest, principalLineage: {
        principalRecordId: ownerNamespace.principalRecordId, principalVersion: ownerNamespace.principalVersion,
      },
      ownerGeneration: input.promotion.ownerGeneration, reason: 'forget' as const, occurredAt: 100_001,
    })

    expect(second.cancelPromotionBeforeOrAfterSubmit(cancellation))
      .toMatchObject({ outcome: 'cancelled', receipt: { outcome: 'cancelled' } })
    expect(first.get(namespace(), input.mutation.identity, committed.record.id)).toBeUndefined()
    expect(first.search({
      context: { workspace: scope.workspace, agentPreset: scope.preset, namespace: namespace() },
      query: 'long-term',
    })).toEqual([])
    // The exact result stays until Preference ACKs it; its replay cannot recreate Memory.
    expect(first.listPendingPromotionResults(10)).toEqual([result])

    first.close()
    second.close()
    const restarted = new MemoryStore({ path: memoryPath, now: () => 100_002 })
    stores.add(restarted)
    expect(restarted.cancelPromotionBeforeOrAfterSubmit(cancellation))
      .toMatchObject({ outcome: 'replayed', receipt: { outcome: 'replayed' } })
    expect(restarted.list(namespace(), input.mutation.identity)).toEqual([])
    expect(restarted.list(namespace(), input.mutation.identity, { includeRemoved: true }))
      .toEqual([expect.objectContaining({ id: committed.record.id, status: 'removed', version: 2 })])
    expect(restarted.completePromotionResult(restarted.listPendingPromotionResults(10)[0]!)).toBe(true)
    expect(restarted.listPendingPromotionResults(10)).toEqual([])
  })

  test('keeps confirmed Memory visible after real Delivery slash-new binding rotation', async () => {
    const { delivery, deliveryStore, memory } = await realDeliveryMemoryHarness()
    deliveryStore.handoffOwner(principalKey)
    const runtime: DeliveryInboundRuntime = {
      createSession: async ({ generation }) => ({
        sessionId: `memory-session-${generation}`,
        workspace: scope.workspace,
        agentPreset: scope.preset,
        policyRef: 'owner-dm',
      }),
      cancelActive: async () => false,
      process: async () => ({ outcome: 'processed' }),
    }
    delivery.registerInboundRuntime(runtime)
    const inbound = (eventId: string, kind: InboundEnvelope['kind'], text: string): InboundEnvelope => ({
      channel: principalKey.channel, account: principalKey.account, eventId, occurredAt: 100_000,
      principal: principalKey, conversation, kind, text,
    })
    await delivery.acceptInbound(inbound('memory-seed-session', 'text', 'establish owner session'))
    const firstBinding = deliveryStore.getActiveBinding(conversation)!
    expect(firstBinding).toMatchObject({ generation: 1, sessionId: 'memory-session-1' })
    const firstAgent = agent(firstBinding.sessionId)
    const proposal = memory.propose(firstAgent, {
      idempotencyKey: 'same-lineage-visible',
      mutation: proposalInput(2).mutation,
    })
    const committed = memory.decideProposal({
      proposalId: proposal.proposalId, principal, expectedVersion: proposal.version,
      decision: 'approved', reason: 'confirmed',
    })

    const ownerBefore = deliveryStore.getPrincipal(principalKey)!
    const reset = await delivery.acceptInbound(inbound('memory-real-slash-new', 'command', '/new'))
    const nextBinding = deliveryStore.getActiveBinding(conversation)!
    const ownerAfter = deliveryStore.getPrincipal(principalKey)!
    expect(reset).toMatchObject({ duplicate: false, status: 'queued' })
    expect(nextBinding.id).not.toBe(firstBinding.id)
    expect(nextBinding.sessionId).toBe('memory-session-2')
    expect(nextBinding.generation).toBe(firstBinding.generation + 1)
    expect({ id: ownerAfter.id, version: ownerAfter.version })
      .toEqual({ id: ownerBefore.id, version: ownerBefore.version })
    expect(delivery.preferencePrincipalForAgent(firstAgent)).toBeUndefined()
    const nextAgent = agent(nextBinding.sessionId)
    expect(memory.read(nextAgent, { ids: [committed.record!.id] })[0]?.content)
      .toBe(PREFERENCE_MEMORY_PROMOTION_CONTENT)
    expect(memory.search(nextAgent, { query: 'long-term' })[0]?.record.id).toBe(committed.record!.id)
  })

  test('real Delivery A-to-B-to-A principal rotation isolates old records and fences pending promotion', async () => {
    const { policy, delivery, deliveryStore, memory } = await realDeliveryMemoryHarness()
    const ownerA1 = deliveryStore.handoffOwner(principalKey)
    const bindingA1 = deliveryStore.createBinding({
      conversation, principal: principalKey, workspace: scope.workspace, agentPreset: scope.preset,
      sessionId: 'memory-owner-a1', policyRef: 'owner-dm',
    })
    const agentA1 = agent(bindingA1.sessionId)
    const baseConfirmedMutation = proposalInput(30).mutation
    if (baseConfirmedMutation.op !== 'add') throw new Error('expected fixed promotion add mutation')
    const confirmedMutation = {
      ...baseConfirmedMutation,
      entry: {
        ...baseConfirmedMutation.entry,
        content: 'A1-only confirmed Memory before owner rotation',
      },
    }
    const confirmedProposal = memory.propose(agentA1, {
      idempotencyKey: 'owner-a1-confirmed-memory',
      mutation: confirmedMutation,
    })
    const confirmedA1 = memory.decideProposal({
      proposalId: confirmedProposal.proposalId, principal, expectedVersion: confirmedProposal.version,
      decision: 'approved', reason: 'confirmed before owner rotation',
    })
    expect(confirmedA1.record?.content).toBe(confirmedMutation.entry.content)
    const request = promotionRequest(3, bindingA1.generation, ownerA1.version)
    const route = delivery.prepareOwnerApprovalForPreference({
      sourceId: 'dsh-enhanced-personal-memory', scope, principalId: externalPrincipalId(principalKey),
      principalLineage: { principalRecordId: ownerA1.id, principalVersion: ownerA1.version },
      ownerGeneration: bindingA1.generation,
    })
    if ('kind' in route) throw new Error('expected current A1 route')
    const basePromotionInput = proposalInput(3, bindingA1.generation, ownerA1.version)
    const promotionInput: MemoryProposalInput = {
      ...basePromotionInput,
      namespace: namespace(ownerA1.id, ownerA1.version),
      principal: externalPrincipalId(principalKey),
      notAfter: Date.now() + 60_000,
    }
    const pending = new MemoryProposalManager(
      (memory as unknown as { memoryStore: MemoryStore }).memoryStore,
      policy,
      proposal => {
        if (proposal.namespace.mode !== 'delivery' || proposal.promotion === undefined) return 'current'
        const current = delivery.prepareOwnerApprovalForPreference({
          sourceId: 'dsh-enhanced-personal-memory', scope: proposal.promotion.scope,
          principalId: proposal.principal,
          principalLineage: {
            principalRecordId: proposal.namespace.principalRecordId,
            principalVersion: proposal.namespace.principalVersion,
          },
          ownerGeneration: proposal.promotion.ownerGeneration,
        })
        return 'kind' in current ? 'stale-owner' : 'current'
      },
    ).propose({ ...promotionInput, dispatch: route, promotion: {
      promotionId: request.promotionId, promotionGeneration: request.promotionGeneration,
      requestDigest: request.requestDigest, scope: request.scope, ownerGeneration: request.ownerGeneration,
    } })

    deliveryStore.handoffOwner(replacementPrincipalKey)
    const ownerA3 = deliveryStore.handoffOwner(principalKey)
    const bindingA3 = deliveryStore.createBinding({
      conversation, principal: principalKey, workspace: scope.workspace, agentPreset: scope.preset,
      sessionId: 'memory-owner-a3', policyRef: 'owner-dm',
    })
    expect(ownerA3.id).toBe(ownerA1.id)
    expect(ownerA3.version).toBeGreaterThan(ownerA1.version)
    expect(bindingA3.generation).toBeGreaterThan(bindingA1.generation)
    const agentA3 = agent(bindingA3.sessionId)
    expect(() => memory.read(agentA3, { ids: [confirmedA1.record!.id] })).toThrow(/not found/iu)
    expect(memory.search(agentA3, { query: 'A1-only' }))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({
        record: expect.objectContaining({ id: confirmedA1.record!.id }),
      })]))
    const settled = memory.decideProposal({
      proposalId: pending.proposalId, principal, expectedVersion: pending.version,
      decision: 'approved', reason: 'approval raced principal rotation',
    })

    expect(settled).toMatchObject({ status: 'conflicted' })
    const memoryStore = (memory as unknown as { memoryStore: MemoryStore }).memoryStore
    expect(memoryStore.list(namespace(ownerA1.id, ownerA1.version), promotionInput.mutation.identity))
      .toEqual([expect.objectContaining({ id: confirmedA1.record!.id })])
    expect(memoryStore.list(namespace(ownerA3.id, ownerA3.version), promotionInput.mutation.identity)).toEqual([])
    expect(memoryStore.listPendingPromotionResults(10)[0]).toMatchObject({ status: 'stale-owner' })
  })
})
