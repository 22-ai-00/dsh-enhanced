import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { parseExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { CredentialsKeychainService } from '@dsh-enhanced/credentials-keychain'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EVENT_OBSERVER_EXECUTOR } from '../src/observer.ts'
import { EventTriggersService } from '../src/service.ts'
import { toWorkItemIntakeInput, type EventIntakeObservation } from '../src/intake.ts'

const goalWaitStoreModule = new URL('../../assistant-goals/src/event-wait-store.ts', import.meta.url).href

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const lookup = async () => [{ address: '93.184.216.34', family: 4 }]

describe('task-system, calendar, and email service composition + durable cursor restarts', () => {
  test('composes Keychain, Policy, Automations, Intake, GoalEventWaitStore, and persists cursors across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-triggers-new-sources-'))
    roots.push(root)
    const scope = {
      principalId: 'owner:one',
      principalRecordId: 'record-1',
      principalVersion: 1,
      workspace: root,
      preset: 'primary',
    }
    const observer = {
      ...scope,
      ownerRouteId: 'route-1',
      expiresAt: Date.now() + 120_000,
      budgetId: 'source-obs',
    }

    let taskPhase = 1
    let calPhase = 1
    let emailPhase = 1
    let sawIfNoneMatchOnRestart = false
    let sawCalSyncTokenOnRestart = false

    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      if (url.startsWith('https://tasks.example.com/')) {
        expect(headers.get('authorization')).toBe('Bearer secret-task-tok')
        if (headers.get('if-none-match') === '"task-etag-2"') {
          sawIfNoneMatchOnRestart = true
          return new Response(null, { status: 304, headers: { etag: '"task-etag-2"' } })
        }
        return new Response(JSON.stringify({
          items: taskPhase === 1
            ? [{ id: 'T-1', status: 'open', title: 'Secret task title one' }]
            : [{ id: 'T-1', status: 'done', title: 'Secret task title updated' }],
        }), { status: 200, headers: { etag: `"task-etag-${taskPhase}"` } })
      }
      if (url.startsWith('https://cal.example.com/')) {
        expect(headers.get('authorization')).toBe('Bearer secret-cal-tok')
        const parsed = new URL(url)
        if (parsed.searchParams.get('syncToken') === 'cal-sync-2') {
          sawCalSyncTokenOnRestart = true
          return new Response(JSON.stringify({ nextSyncToken: 'cal-sync-2', items: [] }), { status: 200 })
        }
        return new Response(JSON.stringify({
          nextSyncToken: `cal-sync-${calPhase}`,
          items: calPhase === 1
            ? [{ id: 'C-1', status: 'confirmed', summary: 'Private meeting 1' }]
            : [{ id: 'C-1', status: 'confirmed', sequence: 2, summary: 'Private meeting moved' }],
        }), { status: 200 })
      }
      if (url.startsWith('https://mail.example.com/')) {
        expect(headers.get('authorization')).toBe('Bearer secret-mail-tok')
        return new Response(JSON.stringify({
          methodResponses: [
            ['Email/query', { accountId: 'acc-1', queryState: `qs-${emailPhase}`, ids: ['E-1'] }, 'q0'],
            ['Email/get', {
              accountId: 'acc-1',
              state: `gs-${emailPhase}`,
              list: [{
                id: 'E-1',
                receivedAt: '2026-03-01T10:00:00Z',
                keywords: emailPhase === 1 ? {} : { $flagged: true },
                from: [{ email: 'boss@secret.org' }],
                subject: 'Confidential Q1 Numbers',
                preview: 'Top secret financial figures',
              }],
            }, 'g0'],
          ],
        }), { status: 200 })
      }
      throw new Error(`unexpected URL: ${url}`)
    })

    const buildConfig = () => ({
      databasePath: join(root, 'events.sqlite'),
      pollerEnabled: false,
      allowedHttpOrigins: [
        'https://tasks.example.com',
        'https://cal.example.com',
        'https://mail.example.com',
      ],
      triggers: [
        {
          id: 'tasks-src', kind: 'task-system' as const, automationId: 'auto-tasks',
          url: 'https://tasks.example.com/items', itemsPointer: '/items',
          credentialHandle: 'task-cred', fireWhen: 'changed' as const, debounceMs: 0, cooldownMs: 0, maxFires: 10,
          observer, intake: { enabled: true },
        },
        {
          id: 'cal-src', kind: 'calendar' as const, automationId: 'auto-cal',
          url: 'https://cal.example.com/events', format: 'json-events' as const, itemsPointer: '/items',
          credentialHandle: 'cal-cred', fireWhen: 'changed' as const, debounceMs: 0, cooldownMs: 0, maxFires: 10,
          observer, intake: { enabled: true },
        },
        {
          id: 'mail-src', kind: 'email' as const, automationId: 'auto-mail',
          url: 'https://mail.example.com/jmap', protocol: 'jmap' as const, accountId: 'acc-1',
          credentialHandle: 'mail-cred', fireWhen: 'changed' as const, debounceMs: 0, cooldownMs: 0, maxFires: 10,
          observer, intake: { enabled: true },
        },
      ],
    })

    const mountStack = async (nowFn: () => number, intakeList?: EventIntakeObservation[]) => {
      const ctx = new Context()
      contexts.push(ctx)
      ctx.provide('assistantDelivery' as never, {
        validateOwnerRoute: () => Object.freeze({
          authorityId: 'route-1', authorityHash: 'a'.repeat(64), receiptVersion: 2 as const,
          principalId: scope.principalId, principalRecordId: scope.principalRecordId, principalVersion: scope.principalVersion,
          workspace: root, agentPreset: scope.preset, bindingVersion: 1, generation: 1,
        }),
      } as never)
      await ctx.plugin(AssistantPolicyService, {
        databasePath: join(root, 'policy.sqlite'),
        budgets: [{ id: 'source-obs', metric: 'requests', limit: 200, periodMs: 60_000, scope: 'subject' }],
        rules: [
          { id: 'observer', effect: 'allow', subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: root, principal: 'owner:one' }, actions: ['observe', 'reconcile', 'execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
          { id: 'obs-tasks', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:tasks-src', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: 'https://tasks.example.com/items' }, context: { initiators: ['background'] }, budget: { id: 'source-obs', amount: 1 } },
          { id: 'obs-cal', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:cal-src', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: 'https://cal.example.com/events' }, context: { initiators: ['background'] }, budget: { id: 'source-obs', amount: 1 } },
          { id: 'obs-mail', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:mail-src', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: 'https://mail.example.com/jmap' }, context: { initiators: ['background'] }, budget: { id: 'source-obs', amount: 1 } },
          { id: 'cred-use', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-event-triggers' }, actions: ['credential.use'], resource: { kind: 'credential', id: '*' }, context: { initiators: ['background'] } },
          { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: '*', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['external'] } },
        ],
      })
      await ctx.plugin(AssistantAutomationsService, {
        databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'),
        schedulerEnabled: false, reconcileIntervalMs: 0, allowUnbudgetedExecution: true,
      })
      await ctx.plugin({
        name: 'new-sources-creds',
        apply(runtime: Context) {
          new CredentialsKeychainService(runtime, {
            databasePath: join(root, 'credentials.sqlite'),
            handles: [
              { id: 'task-cred', provider: 'environment', environmentName: 'TASK_TOK', consumers: ['dsh-enhanced-event-triggers'], purposes: ['task-system.observe'], maxLeaseMs: 30_000 },
              { id: 'cal-cred', provider: 'environment', environmentName: 'CAL_TOK', consumers: ['dsh-enhanced-event-triggers'], purposes: ['calendar.observe'], maxLeaseMs: 30_000 },
              { id: 'mail-cred', provider: 'environment', environmentName: 'MAIL_TOK', consumers: ['dsh-enhanced-event-triggers'], purposes: ['email.observe'], maxLeaseMs: 30_000 },
            ],
          }, { env: { TASK_TOK: 'secret-task-tok', CAL_TOK: 'secret-cal-tok', MAIL_TOK: 'secret-mail-tok' } })
        },
      })
      let service!: EventTriggersService
      await ctx.plugin({
        name: 'dsh-enhanced-event-triggers',
        apply(runtime: Context) {
          service = new EventTriggersService(runtime, buildConfig(), {
            now: nowFn,
            lookup,
            fetcher,
            ...(intakeList ? { intakeObserver: { protocol: 1, observe: obs => { intakeList.push(obs) } } } : {}),
          })
        },
      })
      return { ctx, service }
    }

    let now = 10_000
    const intake: EventIntakeObservation[] = []
    const firstRun = await mountStack(() => now, intake)

    // inspectOwnerSources retains rich kinds
    expect(firstRun.service.inspectOwnerSources(scope).map(s => s.kind)).toEqual(['task-system', 'calendar', 'email'])

    // Baseline poll
    await firstRun.service.pollOnce()
    expect(intake).toHaveLength(0)

    // Snapshot projects onto 'http-json' for GoalEventWaitStore compatibility
    const taskSnap = firstRun.service.sourceSnapshot('tasks-src')
    const calSnap = firstRun.service.sourceSnapshot('cal-src')
    const mailSnap = firstRun.service.sourceSnapshot('mail-src')
    expect([taskSnap.kind, calSnap.kind, mailSnap.kind]).toEqual(['http-json', 'http-json', 'http-json'])

    const { validateGoalEventWaitIntent } = await import(goalWaitStoreModule) as {
      validateGoalEventWaitIntent: (value: unknown) => unknown
    }
    const { acceptanceDigest } = await import('@dsh-enhanced/task-acceptance-contract')
    const objective = 'Follow up when mail source changes'
    const defDigest = acceptanceDigest({ objective })
    expect(() => validateGoalEventWaitIntent({
      id: 'wait-mail-1',
      wake: {
        scope,
        goalId: 'goal-1',
        definition: { version: 1, digest: defDigest, objective },
        native: {
          sessionId: 's1',
          goalId: 'ng1',
          revision: 1,
          objective,
          phase: 'paused',
          roundsStarted: 0,
          maxGoalRounds: 5,
          updatedAt: now,
        },
        attestation: {
          scope: { workspace: root, preset: 'primary' },
          principalId: scope.principalId,
          principalLineage: { principalRecordId: scope.principalRecordId, principalVersion: scope.principalVersion },
          bindingId: 'route-1',
          bindingVersion: 1,
          bindingGeneration: 1,
          sessionId: 's1',
        },
        ownerRouteId: 'route-1',
        budgetId: 'source-obs',
      },
      source: mailSnap,
      createdAt: now,
      expiresAt: now + 60_000,
      runTimeoutMs: 5_000,
    })).not.toThrow()

    // Trigger changes on all 3 sources
    now = 20_000
    taskPhase = 2
    calPhase = 2
    emailPhase = 2
    await firstRun.service.pollOnce()

    expect(firstRun.service.health()).toMatchObject({ triggersObserved: 3, failingTriggers: 0, deliveredEvents: 3 })
    const outboxBeforeCheck = firstRun.service.inspectOwnerOutboxEvents({ scope })
    expect(outboxBeforeCheck.items.map(i => i.triggerKind).sort()).toEqual(['calendar', 'email', 'task-system'])
    expect(intake).toHaveLength(3)
    expect(intake.map(i => i.triggerKind).sort()).toEqual(['calendar', 'email', 'task-system'])
    for (const obs of intake) {
      const workInput = toWorkItemIntakeInput(obs)
      expect(workInput.source).toBe('event-triggers')
      expect(workInput.contentDigest).toBe(obs.observationDigest)
    }

    const outboxPage = firstRun.service.inspectOwnerOutboxEvents({ scope })
    expect(outboxPage.items.map(i => i.triggerKind).sort()).toEqual(['calendar', 'email', 'task-system'])

    const mailEvent = firstRun.service.firstEventAfter(mailSnap, mailSnap.highWaterSequence, now + 60_000)
    expect(mailEvent).toBeDefined()
    expect(parseExternalEventEnvelope(mailEvent!.envelope).source.kind).toBe('http-json')

    // Shutdown cleanly & verify restart reuses durable trigger_cursor
    await firstRun.ctx.fiber.restart()
    contexts.pop()

    now = 30_000
    const secondRun = await mountStack(() => now)
    await secondRun.service.pollOnce()
    expect(sawIfNoneMatchOnRestart).toBe(true)
    expect(sawCalSyncTokenOnRestart).toBe(true)
    expect(secondRun.service.health()).toMatchObject({ deliveredEvents: 3, pendingEvents: 0, failingTriggers: 0 })
    await secondRun.ctx.fiber.restart()
    contexts.pop()

    // Inspect SQLite directly to verify cursors persisted and zero secrets or raw email PII were written
    const db = new DatabaseSync(join(root, 'events.sqlite'), { readOnly: true })
    try {
      const cursors = db.prepare('SELECT trigger_id, cursor_json FROM trigger_cursor ORDER BY trigger_id').all() as Array<{ trigger_id: string; cursor_json: string }>
      expect(cursors).toEqual([
        { trigger_id: 'cal-src', cursor_json: JSON.stringify({ syncToken: 'cal-sync-2' }) },
        { trigger_id: 'mail-src', cursor_json: JSON.stringify({ jmapState: 'qs-2' }) },
        { trigger_id: 'tasks-src', cursor_json: JSON.stringify({ etag: '"task-etag-2"' }) },
      ])
      const allOutbox = JSON.stringify(db.prepare('SELECT * FROM event_outbox').all())
      const allState = JSON.stringify(db.prepare('SELECT * FROM trigger_state').all())
      for (const secretOrPii of [
        'secret-task-tok',
        'secret-cal-tok',
        'secret-mail-tok',
        'Confidential Q1 Numbers',
        'Top secret financial figures',
        'boss@secret.org',
        'Private meeting moved',
        'Secret task title updated',
      ]) {
        expect(allOutbox).not.toContain(secretOrPii)
        expect(allState).not.toContain(secretOrPii)
      }
    } finally {
      db.close()
    }
  })
})
