import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, it } from 'vitest'
import { EventTriggersService } from '../src/service.ts'
import { EVENT_OBSERVER_EXECUTOR } from '../src/observer.ts'
import { normalizeEventTriggersConfig } from '../src/config.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'event-triggers-lark-calendar-'))
  roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  let routeGeneration = 1
  ctx.provide('assistantDelivery' as never, { validateOwnerRoute: () => Object.freeze({ authorityId: 'route', authorityHash: 'a'.repeat(64), receiptVersion: 2 as const,
    principalId: 'owner:one', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: routeGeneration }) } as never)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), budgets: [{ id: 'calendar-observations', metric: 'requests', limit: 100, periodMs: 60_000, scope: 'subject' }], rules: [
    { id: 'observer', effect: 'allow', subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: root, principal: 'owner:one' }, actions: ['observe', 'reconcile', 'execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    { id: 'calendar', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:calendar', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: 'lark-calendar:cal_owner' }, context: { initiators: ['background'] }, budget: { id: 'calendar-observations', amount: 1 } },
    { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: 'event-triggers:calendar', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: 'calendar-target' }, context: { initiators: ['external'] } },
  ] })
  await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0, allowUnbudgetedExecution: true })
  let items: unknown[] = [{ event_id: 'one', summary: 'initial', start_time: { timestamp: '100' }, end_time: { timestamp: '200' }, status: 'confirmed' }]
  let denied = false
  const reader = { async readCalendarEventPage() {
    if (denied) throw new Error('should not read')
    return { has_more: false, page_token: 'ignored-terminal', items }
  } }
  const config = { databasePath: join(root, 'events.sqlite'), pollerEnabled: false, requestTimeoutMs: 1_000, triggers: [{
    id: 'calendar', kind: 'lark-calendar' as const, automationId: 'calendar-target', calendarId: 'cal_owner', startTime: 1, endTime: 10_000,
    pageSize: 100, maxPages: 3, maxEvents: 10, fireWhen: 'changed' as const, debounceMs: 0, cooldownMs: 0, maxFires: 10,
    observer: { workspace: root, preset: 'primary', principalId: 'owner:one', principalRecordId: 'record', principalVersion: 1, ownerRouteId: 'route', expiresAt: Date.now() + 60_000, budgetId: 'calendar-observations' },
  }] }
  const install = () => new EventTriggersService(ctx, config, { larkCalendarReader: reader })
  return { ctx, config, install, change: () => { items = [{ ...items[0] as object, summary: 'changed' }] }, remove: () => { items = [] }, revokeRoute: () => { routeGeneration = 2 }, denyRead: () => { denied = true } }
}

describe('Lark Calendar trigger service composition', () => {
  it('rejects empty calendar IDs and unsafe time bounds during configuration', async () => {
    const { config } = await fixture()
    for (const update of [{ calendarId: '' }, { startTime: Number.MAX_SAFE_INTEGER + 1, endTime: Number.MAX_SAFE_INTEGER + 2 }, { endTime: 31_536_002 }]) {
      expect(() => normalizeEventTriggersConfig({ ...config, triggers: [{ ...config.triggers[0]!, ...update }] })).toThrow()
    }
    expect(normalizeEventTriggersConfig(config).triggers[0]).toMatchObject({ calendarId: 'cal_owner', startTime: 1, endTime: 10_000 })
  })

  it('persists a changed or deleted exact-calendar snapshot for the existing event source reader', async () => {
    const f = await fixture(), service = f.install()
    await service.pollOnce()
    const before = service.sourceSnapshot('calendar')
    expect(before).toMatchObject({ kind: 'lark-calendar', sourceId: 'event-triggers:calendar', highWaterSequence: 0 })
    f.change(); await service.pollOnce()
    expect(service.firstEventAfter(before, 0, Date.now() + 1_000)).toMatchObject({ sequence: 1, envelope: { source: { kind: 'lark-calendar' }, trust: { content: 'untrusted', method: 'https-observation' } } })
    f.remove(); await service.pollOnce()
    expect(service.firstEventAfter(before, 1, Date.now() + 1_000)).toMatchObject({ sequence: 2 })
  })

  it('does not persist an observation after owner-route revocation', async () => {
    const f = await fixture(), service = f.install()
    await service.pollOnce()
    f.change(); f.revokeRoute()
    await expect(service.pollOnce()).rejects.toThrow(/owner route|source|permission/i)
    expect(service.health()).toMatchObject({ pendingEvents: 0, deliveredEvents: 0 })
  })

  it('resolves rolling relative windows from service clock, preserves static configDigest, and avoids step churn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-triggers-lark-rolling-'))
    roots.push(root)
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('assistantDelivery' as never, { validateOwnerRoute: () => Object.freeze({
      authorityId: 'route', authorityHash: 'a'.repeat(64), receiptVersion: 2 as const,
      principalId: 'owner:one', principalRecordId: 'record', principalVersion: 1, workspace: root,
      agentPreset: 'primary', bindingVersion: 1, generation: 1,
    }) } as never)
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      budgets: [{ id: 'calendar-observations', metric: 'requests', limit: 100, periodMs: 60_000, scope: 'subject' }],
      rules: [
        { id: 'observer', effect: 'allow', subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: root, principal: 'owner:one' }, actions: ['observe', 'reconcile', 'execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
        { id: 'calendar', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:cal-roll', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: 'lark-calendar:cal_owner' }, context: { initiators: ['background'] }, budget: { id: 'calendar-observations', amount: 1 } },
        { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: 'event-triggers:cal-roll', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: 'calendar-target' }, context: { initiators: ['external'] } },
      ],
    })
    await ctx.plugin(AssistantAutomationsService, {
      databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'),
      schedulerEnabled: false, reconcileIntervalMs: 0, allowUnbudgetedExecution: true,
    })

    const calls: Array<{ startTime: number; endTime: number }> = []
    const allEvents = [
      { event_id: 'ev-1', summary: 'early', start_time: { timestamp: '20' }, end_time: { timestamp: '30' }, status: 'confirmed' },
      { event_id: 'ev-2', summary: 'upcoming', start_time: { timestamp: '250' }, end_time: { timestamp: '300' }, status: 'confirmed' },
    ]
    const reader = {
      async readCalendarEventPage(input: { startTime: number; endTime: number }) {
        calls.push({ startTime: input.startTime, endTime: input.endTime })
        const items = allEvents.filter(ev => {
          const ts = Number(ev.start_time.timestamp)
          return ts >= input.startTime && ts <= input.endTime
        })
        return { has_more: false, items }
      },
    }

    let nowMs = 10_000 // rawSec = 10 (< lookbackSeconds 60 -> clamps startTime to 0)
    const intakeEvents: string[] = []
    const observer = {
      workspace: root, preset: 'primary', principalId: 'owner:one', principalRecordId: 'record',
      principalVersion: 1, ownerRouteId: 'route', expiresAt: Date.now() + 60_000, budgetId: 'calendar-observations',
    }
    const service = new EventTriggersService(ctx, {
      databasePath: join(root, 'events.sqlite'),
      pollerEnabled: false,
      requestTimeoutMs: 1_000,
      triggers: [{
        id: 'cal-roll', kind: 'lark-calendar', automationId: 'calendar-target', calendarId: 'cal_owner',
        lookbackSeconds: 60, lookaheadSeconds: 120, windowStepSeconds: 60,
        pageSize: 100, maxPages: 3, maxEvents: 10, fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 10,
        observer, intake: { enabled: true },
      }],
    }, {
      now: () => nowMs,
      larkCalendarReader: reader,
      intakeObserver: { protocol: 1, observe: obs => { intakeEvents.push(obs.summary) } },
    })

    await service.pollOnce()
    // baseSec = floor(10 / 60)*60 = 0 -> startTime=0, endTime=120
    expect(calls[0]).toEqual({ startTime: 0, endTime: 120 })
    const snap = service.sourceSnapshot('cal-roll')

    // Within same 60s step (nowMs=45_000 -> baseSec=0), window stays identical
    nowMs = 45_000
    await service.pollOnce()
    expect(calls[1]).toEqual({ startTime: 0, endTime: 120 })
    expect(intakeEvents).toEqual([])

    // Advance to 180s -> baseSec=180 -> window [120, 300] enters ev-2!
    nowMs = 180_000
    await service.pollOnce()
    expect(calls[2]).toEqual({ startTime: 120, endTime: 300 })
    expect(intakeEvents).toHaveLength(1)
    expect(intakeEvents[0]).toContain('window=-60s..+120s step=60s')
    expect(intakeEvents[0]).not.toContain('undefined')

    // Next tick in same step does not re-fire and keeps identical configDigest
    nowMs = 200_000
    await service.pollOnce()
    expect(intakeEvents).toHaveLength(1)
    expect(service.sourceSnapshot('cal-roll').configDigest).toBe(snap.configDigest)
  })
})
