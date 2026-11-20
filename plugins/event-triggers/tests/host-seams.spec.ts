import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test } from 'vitest'
import { EventTriggersService } from '../src/service.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FakePolicy extends Service {
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  evaluate() { return { effect: 'allow' as const, reasonCode: 'allow' } }
  authorize() { return { effect: 'allow' as const, reasonCode: 'allow' } }
}

class FakeAutomations extends Service {
  private readonly systemRows = new Map<string, {
    definitionHash: string
    definitionVersion: number
    ownerRouteId: string
    activationNonce: string
    definition: unknown
    status: 'active' | 'paused'
  }>()

  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  registerHostExecutor() { return () => {} }
  listSystemOwned() { return [] }
  reconcileSystem(input: { automationId: string; desiredStatus?: 'active' | 'paused'; definition: { execution: { ownerRouteId: string; activationNonce: string } } }) {
    const hash = createHash('sha256').update(JSON.stringify(input.definition)).digest('hex')
    this.systemRows.set(input.automationId, {
      definitionHash: hash,
      definitionVersion: 1,
      ownerRouteId: input.definition.execution.ownerRouteId,
      activationNonce: input.definition.execution.activationNonce,
      definition: input.definition,
      status: input.desiredStatus ?? 'active',
    })
    return { id: input.automationId, definition: input.definition }
  }
  inspectSystemOwned(input: { automationId: string }) {
    const row = this.systemRows.get(input.automationId)
    return {
      automationStatus: row?.status ?? 'paused',
      definitionHash: row?.definitionHash ?? '0'.repeat(64),
      definitionVersion: row?.definitionVersion ?? 1,
    }
  }
  inspectSystemOwnedActivation(input: { automationId: string }) {
    const row = this.systemRows.get(input.automationId)
    if (!row) return undefined
    return {
      definitionHash: row.definitionHash,
      ownerRouteId: row.ownerRouteId,
      activationNonce: row.activationNonce,
    }
  }
  pauseSystemOwned(input: { automationId: string }) {
    const row = this.systemRows.get(input.automationId)
    if (row) row.status = 'paused'
  }
  ingestExternal() {}
}

class FakeCredentials extends Service {
  constructor(ctx: Context, private readonly secret: string) { super(ctx, 'credentialsKeychain') }
  async withSecret<T>(_ctx: Context, _req: unknown, cb: (secret: string, signal: AbortSignal) => Promise<T>) {
    return cb(this.secret, new AbortController().signal)
  }
}

class FakeDelivery extends Service {
  constructor(ctx: Context) { super(ctx, 'assistantDelivery') }
  validateOwnerRoute(input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) {
    return Object.freeze({
      authorityId: input.authorityId,
      authorityHash: 'a'.repeat(64),
      principalId: input.principalId,
      principalRecordId: input.principalId === 'owner-a' ? 'rec-a' : 'rec-b',
      principalVersion: 1,
      workspace: input.workspace,
      agentPreset: input.agentPreset,
      bindingVersion: 1,
      generation: 1,
    })
  }
}

describe('event-triggers inspectOwnerOutboxEvents host seam', () => {
  test('filters strictly by owner scope & active triggers, paginates, validates envelope digests, and never leaks secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-triggers-host-seams-'))
    roots.push(root)
    const watchedA = join(root, 'a.txt')
    const watchedB = join(root, 'b.txt')
    await writeFile(watchedA, 'v1')
    await writeFile(watchedB, 'v1')

    const ctx = new Context()
    new FakePolicy(ctx)
    new FakeAutomations(ctx)
    const secret = 'TOP_SECRET_WEBHOOK_TOKEN_DO_NOT_LEAK'
    new FakeCredentials(ctx, secret)
    new FakeDelivery(ctx)

    const now = 100_000
    const scopeA = {
      principalId: 'owner-a',
      principalRecordId: 'rec-a',
      principalVersion: 1,
      workspace: root,
      preset: 'primary',
    }
    const scopeB = {
      principalId: 'owner-b',
      principalRecordId: 'rec-b',
      principalVersion: 1,
      workspace: root,
      preset: 'primary',
    }
    const expiresAt = Date.now() + 600_000
    const dbPath = join(root, 'events.sqlite')

    const service = new EventTriggersService(ctx, {
      databasePath: dbPath,
      allowedFileRoots: [root],
      allowedHttpOrigins: ['https://api.example.test'],
      pollerEnabled: false,
      triggers: [
        {
          id: 'hook-a',
          kind: 'webhook',
          automationId: 'auto-hook-a',
          credentialHandle: 'cred-handle-secret-a',
          maxSkewMs: 60_000,
          ttlMs: 30_000,
          observer: { ...scopeA, ownerRouteId: 'route-a', expiresAt, budgetId: 'b-a' },
          intake: { enabled: true, summaryLabel: 'Webhook Alpha' },
        },
        {
          id: 'file-a',
          kind: 'file',
          automationId: 'auto-file-a',
          path: watchedA,
          fireWhen: 'changed',
          debounceMs: 0,
          observer: { ...scopeA, ownerRouteId: 'route-a', expiresAt, budgetId: 'b-a' },
        },
        {
          id: 'hook-b',
          kind: 'webhook',
          automationId: 'auto-hook-b',
          credentialHandle: 'cred-handle-secret-b',
          maxSkewMs: 60_000,
          observer: { ...scopeB, ownerRouteId: 'route-b', expiresAt, budgetId: 'b-b' },
        },
        {
          id: 'hook-disabled',
          kind: 'webhook',
          automationId: 'auto-hook-disabled',
          credentialHandle: 'cred-handle-secret-c',
          enabled: false,
          maxSkewMs: 60_000,
          observer: { ...scopeA, ownerRouteId: 'route-a', expiresAt, budgetId: 'b-a' },
        },
      ],
    }, { now: () => now })

    const signAndIngest = async (triggerId: string, nonce: string, payload: string) => {
      const body = Buffer.from(payload)
      const timestamp = String(now)
      const signature = `sha256=${createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n`).update(body).digest('hex')}`
      return service.ingestWebhook(triggerId, { timestamp, nonce, signature, body })
    }

    await signAndIngest('hook-a', 'ev-a-1', JSON.stringify({ bearer: 'Bearer raw-token-123', body: 'PRIVATE_RAW_BODY_1' }))
    await signAndIngest('hook-b', 'ev-b-1', JSON.stringify({ body: 'OWNER_B_BODY' }))
    await signAndIngest('hook-a', 'ev-a-2', JSON.stringify({ body: 'PRIVATE_RAW_BODY_2' }))

    // Owner A sees only Owner A's 2 events, paginated cleanly
    const page1 = service.inspectOwnerOutboxEvents({ scope: scopeA, afterSequence: 0, limit: 1 })
    expect(page1.hasMore).toBe(true)
    expect(page1.items).toHaveLength(1)
    expect(page1.items[0]).toMatchObject({
      sequence: 1,
      triggerId: 'hook-a',
      triggerKind: 'webhook',
      automationId: 'auto-hook-a',
      occurredAt: now,
      title: 'Webhook Alpha',
      ttlMs: 30_000,
    })
    expect(page1.nextSequence).toBe(1)

    const page2 = service.inspectOwnerOutboxEvents({ scope: scopeA, afterSequence: page1.nextSequence, limit: 10 })
    expect(page2.hasMore).toBe(false)
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]!.sequence).toBe(3)

    // Zero secret or unredacted body leakage
    const serialized = JSON.stringify([page1, page2])
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('cred-handle-secret-a')
    expect(serialized).not.toContain('raw-token-123')
    expect(serialized).not.toContain('PRIVATE_RAW_BODY')
    expect(serialized).not.toContain('OWNER_B_BODY')

    // Owner B sees only Owner B's event (sequence 2)
    const ownerBPage = service.inspectOwnerOutboxEvents({ scope: scopeB })
    expect(ownerBPage.items).toHaveLength(1)
    expect(ownerBPage.items[0]).toMatchObject({ sequence: 2, triggerId: 'hook-b' })

    // Wrong principalVersion or workspace sees nothing
    expect(service.inspectOwnerOutboxEvents({
      scope: { ...scopeA, principalVersion: 99 },
    }).items).toEqual([])
    expect(service.inspectOwnerOutboxEvents({
      scope: { ...scopeA, workspace: join(root, 'other') },
    }).items).toEqual([])

    // Tampered envelope_digest row is rejected by digest verification
    const db = new DatabaseSync(dbPath)
    db.prepare(`UPDATE event_outbox SET envelope_digest = ? WHERE sequence = 1`).run('f'.repeat(64))
    db.close()

    const afterTamper = service.inspectOwnerOutboxEvents({ scope: scopeA, afterSequence: 0, limit: 50 })
    expect(afterTamper.items.map(item => item.sequence)).toEqual([3])
    expect(afterTamper.nextSequence).toBe(3)

    // Invalid bounds fail closed
    expect(() => service.inspectOwnerOutboxEvents({ scope: scopeA, afterSequence: -1 })).toThrow(/afterSequence/i)
    expect(() => service.inspectOwnerOutboxEvents({ scope: scopeA, limit: 0 })).toThrow(/limit/i)

    await ctx.fiber.restart()
  })

  test('excludes expired and retired goal-scoped triggers from inspectOwnerOutboxEvents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-triggers-host-retired-'))
    roots.push(root)
    const ctx = new Context()
    new FakePolicy(ctx)
    const automations = new FakeAutomations(ctx)
    const secret = 'WEBHOOK_SECRET_RETIRED'
    new FakeCredentials(ctx, secret)
    new FakeDelivery(ctx)

    let goalPhase: 'active' | 'complete' = 'active'
    const scope = {
      principalId: 'owner-a',
      principalRecordId: 'rec-a',
      principalVersion: 1,
      workspace: root,
      preset: 'primary',
    }
    ctx.provide('assistantGoals' as never, {
      inspectGoalLifecycle: () => ({
        scope,
        id: 'goal-1',
        definition: { version: 1, digest: 'a'.repeat(64) },
        native: { sessionId: 's-1', goalId: 'ng-1', revision: 1, phase: goalPhase },
      }),
    } as never)

    const now = 100_000
    const dbPath = join(root, 'events.sqlite')
    const service = new EventTriggersService(ctx, {
      databasePath: dbPath,
      pollerEnabled: false,
      triggers: [
        {
          id: 'goal-hook',
          kind: 'webhook',
          automationId: 'auto-goal-hook',
          credentialHandle: 'cred-goal',
          maxSkewMs: 60_000,
          observerLifetime: 'goal',
          observer: { ...scope, ownerRouteId: 'route-a', expiresAt: Date.now() + 600_000, budgetId: 'b-a' },
        },
        {
          id: 'expired-hook',
          kind: 'webhook',
          automationId: 'auto-expired-hook',
          credentialHandle: 'cred-expired',
          maxSkewMs: 60_000,
          observer: { ...scope, ownerRouteId: 'route-a', expiresAt: 1, budgetId: 'b-a' },
        },
      ],
    }, { now: () => now })

    const snapshot = service.sourceSnapshot('goal-hook')
    service.claimGoalSource({
      triggerId: 'goal-hook',
      scope,
      goalId: 'goal-1',
      definition: { version: 1, digest: 'a'.repeat(64) },
      native: { sessionId: 's-1', goalId: 'ng-1', revision: 1 },
      configDigest: snapshot.configDigest,
      automationId: 'auto-goal-hook',
    })

    const body = Buffer.from('{}')
    const signature = `sha256=${createHmac('sha256', secret).update(`${now}\nnonce-goal-1\n`).update(body).digest('hex')}`
    await service.ingestWebhook('goal-hook', { timestamp: String(now), nonce: 'nonce-goal-1', signature, body })

    expect(service.inspectOwnerOutboxEvents({ scope }).items.map(item => item.triggerId)).toEqual(['goal-hook'])

    // Retire the goal source and verify it is excluded immediately
    goalPhase = 'complete'
    service.retireGoalSource({
      triggerId: 'goal-hook',
      scope,
      goalId: 'goal-1',
      definition: { version: 1, digest: 'a'.repeat(64) },
      native: { sessionId: 's-1', goalId: 'ng-1', revision: 1 },
      configDigest: snapshot.configDigest,
      automationId: 'auto-goal-hook',
    })
    expect(service.inspectOwnerOutboxEvents({ scope }).items).toEqual([])
    expect(automations).toBeDefined()

    await ctx.fiber.restart()
  })
})
