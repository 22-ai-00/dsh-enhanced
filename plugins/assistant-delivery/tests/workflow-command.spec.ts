import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  growthObjectDigest,
  workflowArgumentShapeDigest,
} from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, describe, expect, test } from 'vitest'
import { parseWorkflowCommand } from '../src/workflow-command.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('workflow command', () => {
  test('parses a strict owner save command', () => {
    expect(parseWorkflowCommand(' save name="Daily summary" cron="0 9 * * *" timezone="UTC"'))
      .toEqual({ kind: 'save', name: 'Daily summary', cron: '0 9 * * *', timezone: 'UTC' })
  })

  test('supports discoverable help and exact retract', () => {
    expect(parseWorkflowCommand('')).toEqual({ kind: 'help' })
    expect(parseWorkflowCommand(' help')).toEqual({ kind: 'help' })
    expect(parseWorkflowCommand(' retract')).toEqual({ kind: 'retract' })
  })

  test('rejects duplicate, unknown, unquoted, and trailing fields', () => {
    expect(parseWorkflowCommand(' save name="a" name="b" cron="* * * * *" timezone="UTC"').kind)
      .toBe('invalid')
    expect(parseWorkflowCommand(' save name=a cron="* * * * *" timezone="UTC"').kind).toBe('invalid')
    expect(parseWorkflowCommand(' save name="a" cron="* * * * *" timezone="UTC" x="y"').kind)
      .toBe('invalid')
    expect(parseWorkflowCommand(' retract now').kind).toBe('invalid')
  })

  test('derives and persists the private template principal from the authenticated owner binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-workflow-principal-'))
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
      sessionId: 'workflow-session',
      policyRef: 'owner-dm',
    })
    const inbound = (eventId: string, text: string) => store.acceptInbound({
      channel: principal.channel,
      account: principal.account,
      eventId,
      occurredAt: 900,
      principal,
      conversation,
      kind: 'text' as const,
      text,
      metadata: { source: 'websocket' },
    }).record

    const sourceInbox = inbound('evt-source', 'Summarize the latest owner-visible work.')
    store.queueInbox(sourceInbox.id, binding.id)
    const sourceClaim = store.claimInbox({ ownerId: 'worker', leaseMs: 10_000, limit: 1, maxAttempts: 3 })[0]!
    store.finishInbox({
      inboxId: sourceInbox.id,
      ownerId: 'worker',
      fencingToken: sourceClaim.fencingToken,
      outcome: 'processed',
    })
    const sourceOutbox = store.enqueue({
      idempotencyKey: 'workflow-source-reply',
      bindingId: binding.id,
      target: { principal, conversation },
      text: 'Here is the summary.',
      format: 'plain',
      replyToEventId: sourceInbox.eventId,
    })
    const outboxClaim = store.claimOutbox({
      ownerId: 'sender', leaseMs: 10_000, limit: 1, maxAttempts: 3,
    })[0]!
    store.finishOutbox({
      outboxId: sourceOutbox.id,
      ownerId: 'sender',
      fencingToken: outboxClaim.fencingToken,
      outcome: 'accepted',
      providerMessageId: 'om_source',
    })
    const reviewInbox = inbound('evt-review', '/workflow save')
    store.queueInbox(reviewInbox.id, binding.id)
    store.claimInbox({ ownerId: 'worker', leaseMs: 10_000, limit: 1, maxAttempts: 3 })

    const subjectRef = 'a'.repeat(64)
    const taskRef = 'b'.repeat(64)
    const result = store.commitOwnerWorkflowTraceCommand({
      action: 'upsert',
      operationId: 'workflow-command:evt-review',
      payloadDigest: growthObjectDigest({ command: 'save', subjectRef }),
      binding,
      reviewInboxId: reviewInbox.id,
      sourceInboxId: sourceInbox.id,
      sourceOutboxId: sourceOutbox.id,
      subjectRef,
      occurredAt: sourceInbox.receivedAt,
      taskRef,
      // Runtime callers cannot forge this field: Store overwrites it from the
      // exact binding before validation and hashing.
      templateContent: {
        scope: { workspace: binding.workspace, preset: binding.agentPreset },
        ownerBindingId: binding.id,
        principalId: 'forged/channel/tenant/owner',
        name: 'Daily summary',
        prompt: sourceInbox.envelope.text,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
        timeoutMs: 60_000,
        toolCatalogIds: ['assistant.agent-turn'],
        deliveryBindingId: binding.id,
      } as unknown as NonNullable<
        Parameters<DeliveryStore['commitOwnerWorkflowTraceCommand']>[0]['templateContent']
      >,
      steps: [{
        catalogId: 'assistant.agent-turn',
        argumentSchemaDigest: workflowArgumentShapeDigest({ prompt: sourceInbox.envelope.text }),
      }],
    })
    const stored = store.getWorkflowAutomationTemplate(result.template!)
    expect(stored?.resolved).toMatchObject({
      ownerBindingId: binding.id,
      principalId: 'lark/bot%2Fprod/tenant-a/owner%40example.com',
      deliveryBindingId: binding.id,
    })
    expect(stored?.resolved.template.templateDigest).toBe(result.template?.templateDigest)
    store.close()
  })
})
