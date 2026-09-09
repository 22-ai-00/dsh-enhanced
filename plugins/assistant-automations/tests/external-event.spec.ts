import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { externalEventDigest, parseExternalEventEnvelope } from '../src/external-event.ts'
import { AssistantAutomationsService } from '../src/service.ts'
import { AutomationStore, AutomationStoreError } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function envelope(kind: 'webhook' | 'lark-calendar' = 'webhook') {
  return {
    protocol: 'dsh-external-event/v1' as const,
    source: { id: 'event-test', kind, version: '1', configDigest: 'a'.repeat(64) },
    event: { id: 'event-1', occurredAt: 1_000, receivedAt: 1_001 },
    observation: { digest: 'b'.repeat(64), revision: '1', timeBasis: kind === 'webhook' ? 'source-signed' as const : 'observed' as const },
    trust: { method: kind === 'webhook' ? 'hmac-sha256' as const : 'https-observation' as const, content: 'untrusted' as const },
    target: { automationId: 'auto-event' }, deduplicationKey: 'event-test:event-1',
  }
}

const definition = {
  name: 'Event handler', prompt: 'Observe only.', schedule: { kind: 'at' as const, at: '2030-01-01T00:00:00.000Z' },
  workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock', allowedTools: [],
  timeoutMs: 60_000, maxOutputTokens: 100, maxToolCalls: 0, misfire: { kind: 'skip' as const },
  overlap: 'skip' as const, retrySafety: 'never' as const, maxRetries: 0, principal: 'owner:test',
}

describe('external event envelope', () => {
  test('takes a deep-frozen snapshot and rejects unbound JSON shape', () => {
    const input = envelope()
    const parsed = parseExternalEventEnvelope(input)
    input.event.id = 'changed'
    expect(parsed.event.id).toBe('event-1')
    expect(Object.isFrozen(parsed.event)).toBe(true)
    expect(externalEventDigest(parsed)).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => parseExternalEventEnvelope({ ...envelope(), payload: 'run this' })).toThrow(TypeError)
    expect(() => parseExternalEventEnvelope({ ...envelope(), deduplicationKey: 'wrong' })).toThrow(TypeError)
    expect(() => parseExternalEventEnvelope({ ...envelope(), [Symbol('hidden')]: 'nope' })).toThrow(TypeError)
    expect(() => parseExternalEventEnvelope({ ...envelope(), source: { ...envelope().source, version: '1\n2' } })).toThrow(TypeError)
    expect(parseExternalEventEnvelope({ ...envelope(), event: { id: 'event-1', occurredAt: 3_600_001, receivedAt: 1 } }))
      .toMatchObject({ event: { occurredAt: 3_600_001, receivedAt: 1 } })
  })

  test.each(['webhook', 'lark-calendar'] as const)('persists exact %s provenance across restart and rejects a changed duplicate', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-event-'))
    roots.push(root)
    const path = join(root, 'automations.sqlite')
    const firstStore = new AutomationStore({ path, now: () => 2_000 })
    firstStore.createApproved({ automationId: 'auto-event', idempotencyKey: 'create-event', definition })
    const input = envelope(kind)
    const first = firstStore.ingestExternal({ automationId: 'auto-event', externalEventId: input.deduplicationKey,
      occurredAt: input.event.occurredAt, envelope: input })
    input.observation.revision = 'mutated-after-ingest'
    expect(first.externalEvent?.observation.revision).toBe('1')
    firstStore.close()
    const restarted = new AutomationStore({ path, now: () => 2_001 })
    expect(restarted.getOccurrence(first.id)).toMatchObject({ externalEvent: { observation: { revision: '1' } } })
    expect(restarted.ingestExternal({ automationId: 'auto-event', externalEventId: envelope(kind).deduplicationKey,
      occurredAt: 1_000, envelope: envelope(kind) }).id).toBe(first.id)
    const changed = envelope(kind); changed.observation.revision = '2'
    expect(() => restarted.ingestExternal({ automationId: 'auto-event', externalEventId: changed.deduplicationKey,
      occurredAt: changed.event.occurredAt, envelope: changed }))
      .toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'idempotency-conflict' }))
    restarted.close()
  })

  test('rejects a mismatched envelope before real Policy authorization and persists an authorized Service ingestion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-event-service-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [{ id: 'allow-event', effect: 'allow', subject: { kind: 'external', id: 'event-test' },
        actions: ['ingest'], resource: { kind: 'automation', id: 'auto-event' }, context: { initiators: ['external'] } }],
    })
    await ctx.plugin(AssistantAutomationsService, {
      databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false,
      allowUnbudgetedExecution: true,
    })
    const service = ctx.assistantAutomations as AssistantAutomationsService
    const durableStore = (service as unknown as { store: AutomationStore }).store
    durableStore.createApproved({ automationId: 'auto-event', idempotencyKey: 'event-service-create', definition })
    const policy = ctx.assistantPolicy as AssistantPolicyService
    const authorize = vi.spyOn(policy, 'authorize')
    const valid = envelope()
    const wrongEvent = {
      ...valid,
      event: { ...valid.event, id: 'wrong-event' },
      deduplicationKey: 'event-test:wrong-event',
    }
    const inputs = [
      { sourceId: 'wrong-source', envelope: valid },
      { sourceId: 'event-test', envelope: { ...valid, target: { automationId: 'wrong-target' } } },
      { sourceId: 'event-test', envelope: wrongEvent },
      { sourceId: 'event-test', envelope: { ...valid, event: { ...valid.event, occurredAt: 1_001 } } },
    ]
    for (const input of inputs) {
      expect(() => service.ingestExternal({ sourceId: input.sourceId, automationId: 'auto-event',
        eventId: 'event-1', occurredAt: 1_000, envelope: input.envelope })).toThrow()
    }
    expect(authorize).not.toHaveBeenCalled()
    const occurrence = service.ingestExternal({ sourceId: 'event-test', automationId: 'auto-event',
      eventId: 'event-1', occurredAt: 1_000, envelope: valid })
    expect(authorize).toHaveBeenCalledTimes(1)
    const persisted = durableStore.getOccurrence(occurrence.id)!
    expect(persisted.externalEvent).toEqual(parseExternalEventEnvelope(valid))
    expect(Object.isFrozen(persisted.externalEvent)).toBe(true)
    await ctx.fiber.restart()
  })
})
