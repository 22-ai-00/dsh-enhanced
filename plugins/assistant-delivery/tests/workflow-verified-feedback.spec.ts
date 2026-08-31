import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore, DeliveryStoreError } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createFixture(): Promise<{
  store: DeliveryStore
  binding: ReturnType<DeliveryStore['createBinding']>
  principal: { channel: string; account: string; tenant: string; user: string }
  conversation: { channel: string; account: string; tenant: string; kind: 'dm'; chat: string }
}> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-verified-workflow-'))
  roots.push(root)
  const store = new DeliveryStore({ path: join(root, 'delivery.sqlite'), now: () => 1_000 })
  const principal = {
    channel: 'lark', account: 'bot/prod', tenant: 'tenant-a', user: 'owner@example.com',
  }
  const conversation = {
    channel: 'lark', account: 'bot/prod', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner',
  }
  const pairing = store.issuePairing(principal, { ttlMs: 10_000, maxAttempts: 1 })
  store.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  const binding = store.createBinding({
    conversation,
    principal,
    workspace: '/work/owner',
    agentPreset: 'primary',
    sessionId: 'verified-workflow-session',
    policyRef: 'owner-dm',
  })
  return { store, binding, principal, conversation }
}

function claimInbox(store: DeliveryStore, inboxId: string, bindingId: string): void {
  store.queueInbox(inboxId, bindingId)
  const claimed = store.claimInbox({ ownerId: 'worker', leaseMs: 10_000, limit: 1, maxAttempts: 3 })
  expect(claimed).toHaveLength(1)
  expect(claimed[0]?.record.id).toBe(inboxId)
}

function finishSourceInbox(store: DeliveryStore, inboxId: string): void {
  const claimed = store.getInbox(inboxId)!
  store.finishInbox({
    inboxId,
    ownerId: 'worker',
    fencingToken: claimed.fencingToken!,
    outcome: 'processed',
  })
}

function recordCompletedAgentReply(input: {
  store: DeliveryStore
  binding: ReturnType<DeliveryStore['createBinding']>
  principal: { channel: string; account: string; tenant: string; user: string }
  conversation: { channel: string; account: string; tenant: string; kind: 'dm'; chat: string }
  eventId: string
  text: string
  providerMessageId: string
}): { inboxId: string; outboxId: string } {
  const sourceInbox = input.store.acceptInbound({
    channel: input.principal.channel,
    account: input.principal.account,
    eventId: input.eventId,
    occurredAt: 900,
    principal: input.principal,
    conversation: input.conversation,
    kind: 'text',
    text: input.text,
    metadata: { source: 'websocket' },
  }).record
  claimInbox(input.store, sourceInbox.id, input.binding.id)
  finishSourceInbox(input.store, sourceInbox.id)
  const reply = input.store.enqueue({
    idempotencyKey: `inbound:${sourceInbox.id}:reply`,
    bindingId: input.binding.id,
    target: { principal: input.principal, conversation: input.conversation },
    text: 'Completed agent reply.',
    format: 'markdown',
    replyToEventId: sourceInbox.eventId,
  })
  const outboxClaim = input.store.claimOutbox({
    ownerId: 'sender', leaseMs: 10_000, limit: 1, maxAttempts: 3,
  })[0]!
  input.store.finishOutbox({
    outboxId: reply.id,
    ownerId: 'sender',
    fencingToken: outboxClaim.fencingToken,
    outcome: 'accepted',
    providerMessageId: input.providerMessageId,
  })
  return { inboxId: sourceInbox.id, outboxId: reply.id }
}

function recordObjectiveFeedback(input: {
  store: DeliveryStore
  binding: ReturnType<DeliveryStore['createBinding']>
  principal: { channel: string; account: string; tenant: string; user: string }
  conversation: { channel: string; account: string; tenant: string; kind: 'dm'; chat: string }
  eventId: string
  providerMessageId: string
  objectiveStatus: 'achieved' | 'partial' | 'not-achieved'
}): string {
  const feedbackInbox = input.store.acceptInbound({
    channel: input.principal.channel,
    account: input.principal.account,
    eventId: input.eventId,
    occurredAt: 1_000,
    principal: input.principal,
    conversation: input.conversation,
    kind: 'command',
    text: `/feedback ${input.objectiveStatus}`,
    metadata: {
      source: 'websocket',
      replyToProviderMessageId: input.providerMessageId,
    },
  }).record
  claimInbox(input.store, feedbackInbox.id, input.binding.id)
  return feedbackInbox.id
}

describe('verified workflow feedback producer', () => {
  test('records only owner-achieved closed-set replies, omits source prose, and reuses the static template', async () => {
    const fixture = await createFixture()
    const first = recordCompletedAgentReply({
      ...fixture,
      eventId: 'evt-daily-one',
      text: 'prepare daily workspace status summary',
      providerMessageId: 'om-daily-one',
    })
    const firstFeedback = recordObjectiveFeedback({
      ...fixture,
      eventId: 'evt-feedback-one',
      providerMessageId: 'om-daily-one',
      objectiveStatus: 'achieved',
    })
    const firstResult = fixture.store.commitVerifiedWorkflowTraceFeedback({
      binding: fixture.binding,
      feedbackInboxId: firstFeedback,
      sourceInboxId: first.inboxId,
      sourceOutboxId: first.outboxId,
      objectiveStatus: 'achieved',
    })
    expect(firstResult.outcome).toBe('trace-recorded')
    if (firstResult.outcome !== 'trace-recorded') throw new Error('expected a workflow trace')
    expect(firstResult.revision.evidence).toMatchObject({
      signal: 'verified-repetition', objectiveStatus: 'achieved', ownerBindingId: fixture.binding.id,
    })
    expect(firstResult.revision.evidence?.taskEvidenceDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(firstResult.template.privacyAttestation.kind).toBe('deterministic-deidentification')
    const resolved = fixture.store.getWorkflowAutomationTemplate(firstResult.template)
    expect(resolved?.resolved).toMatchObject({
      name: 'Daily workspace status summary',
      prompt: 'Prepare the daily workspace status summary from current workspace context. Include completed work, blockers, and next steps. Do not rely on prior delivery content.',
      schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      toolCatalogIds: ['assistant.agent-turn'],
    })
    expect(JSON.stringify(firstResult)).not.toContain('prepare daily workspace status summary')

    const replay = fixture.store.commitVerifiedWorkflowTraceFeedback({
      binding: fixture.binding,
      feedbackInboxId: firstFeedback,
      sourceInboxId: first.inboxId,
      sourceOutboxId: first.outboxId,
      objectiveStatus: 'achieved',
    })
    expect(replay).toMatchObject({ outcome: 'trace-recorded', replayed: true })
    finishSourceInbox(fixture.store, firstFeedback)

    const second = recordCompletedAgentReply({
      ...fixture,
      eventId: 'evt-daily-two',
      text: '准备每日工作区状态摘要',
      providerMessageId: 'om-daily-two',
    })
    const secondFeedback = recordObjectiveFeedback({
      ...fixture,
      eventId: 'evt-feedback-two',
      providerMessageId: 'om-daily-two',
      objectiveStatus: 'achieved',
    })
    const secondResult = fixture.store.commitVerifiedWorkflowTraceFeedback({
      binding: fixture.binding,
      feedbackInboxId: secondFeedback,
      sourceInboxId: second.inboxId,
      sourceOutboxId: second.outboxId,
      objectiveStatus: 'achieved',
    })
    expect(secondResult.outcome).toBe('trace-recorded')
    if (secondResult.outcome !== 'trace-recorded') throw new Error('expected a second workflow trace')
    expect(secondResult.template.templateRef).toBe(firstResult.template.templateRef)
    expect(secondResult.revision.evidence?.taskRef).not.toBe(firstResult.revision.evidence?.taskRef)
    expect(JSON.stringify(secondResult)).not.toContain('准备每日工作区状态摘要')
    expect(fixture.store.listPendingWorkflowTraceRevisions()).toHaveLength(2)
    fixture.store.close()
  })

  test('abstains for non-catalog text and never lets a later contradictory owner result overwrite it', async () => {
    const fixture = await createFixture()
    const source = recordCompletedAgentReply({
      ...fixture,
      eventId: 'evt-private',
      text: 'prepare daily workspace status summary for owner-secret-739',
      providerMessageId: 'om-private',
    })
    const achievedFeedback = recordObjectiveFeedback({
      ...fixture,
      eventId: 'evt-private-achieved',
      providerMessageId: 'om-private',
      objectiveStatus: 'achieved',
    })
    expect(fixture.store.commitVerifiedWorkflowTraceFeedback({
      binding: fixture.binding,
      feedbackInboxId: achievedFeedback,
      sourceInboxId: source.inboxId,
      sourceOutboxId: source.outboxId,
      objectiveStatus: 'achieved',
    })).toEqual({ outcome: 'no-trace', reason: 'privacy-abstained', replayed: false })
    expect(JSON.stringify(fixture.store.listPendingWorkflowTraceRevisions())).not.toContain('owner-secret-739')
    finishSourceInbox(fixture.store, achievedFeedback)

    const conflictingFeedback = recordObjectiveFeedback({
      ...fixture,
      eventId: 'evt-private-partial',
      providerMessageId: 'om-private',
      objectiveStatus: 'partial',
    })
    try {
      fixture.store.commitVerifiedWorkflowTraceFeedback({
        binding: fixture.binding,
        feedbackInboxId: conflictingFeedback,
        sourceInboxId: source.inboxId,
        sourceOutboxId: source.outboxId,
        objectiveStatus: 'partial',
      })
      throw new Error('expected an immutable owner judgement conflict')
    } catch (error) {
      expect(error).toBeInstanceOf(DeliveryStoreError)
      expect((error as DeliveryStoreError).code).toBe('idempotency-conflict')
    }
    expect(fixture.store.listPendingWorkflowTraceRevisions()).toHaveLength(0)
    fixture.store.close()
  })
})
