import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import type { AutomationStore } from '../../assistant-automations/lib/store.js'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Config } from '../src/config.ts'
import type { PeerOwnerRouteReceipt, PeerPolicyRequest } from '../src/peers.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import { WorkItemStore } from '../src/store.ts'

const fixtures: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const { ctx, root } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

class PolicyPeer extends Service {
  readonly denied = new Set<string>()
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorize(_request: PeerPolicyRequest, options?: { idempotencyKey?: string }) {
    return this.denied.has(options?.idempotencyKey ?? '')
      ? { effect: 'deny' as const, reasonCode: 'test-denial' }
      : { effect: 'allow' as const, reasonCode: 'rule-allow' }
  }
}

class SchedulerPeer extends Service {
  readonly listeners = new Set<() => void>()
  readonly ingests: Array<{ eventId: string; occurredAt: number }> = []
  onIngest: (() => void) | undefined
  constructor(ctx: Context) {
    super(ctx, 'assistantAutomations')
    ctx.effect(() => () => this.listeners.clear())
  }
  onSchedulerWake(listener: () => void): () => void {
    const remove = () => { this.listeners.delete(listener) }
    this.ctx.effect(() => { this.listeners.add(listener); return remove })
    return remove
  }
  wake(): void { for (const listener of Array.from(this.listeners)) listener() }
  ingestExternal(input: { automationId: string; eventId: string; occurredAt: number }) {
    this.onIngest?.()
    this.ingests.push(input)
    return { id: `occ-${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)}`, automationId: input.automationId }
  }
}

function worker(occurrenceId: string): Agent {
  return { ctx: { get: () => Object.freeze({ mode: 'production', automationId: 'worker', occurrenceId }) } } as unknown as Agent
}

async function setup(options: { native?: boolean; automatic?: boolean; provider?: boolean; enabled?: boolean; mode?: 'active' | 'observe' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'work-items-scheduler-'))
  const ctx = new Context(); fixtures.push({ ctx, root })
  let ownerVersion = 1
  ctx.provide('assistantDelivery' as never, {
    // Keep native execution paused: this test proves ingestion, not a model run.
    isMaintenanceDraining: () => true,
    validateOwnerRoute(input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }): PeerOwnerRouteReceipt {
      return { receiptVersion: 2, ...input, authorityHash: 'sha256:owner', principalRecordId: 'owner-1', principalVersion: ownerVersion, bindingVersion: 1, generation: 1 }
    },
    enqueueBackground: () => Promise.resolve({ id: 'outbox' }),
  } as never)
  let policy: PolicyPeer | undefined
  if (options.native) {
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'), proposalMaintenanceIntervalMs: 0,
      budgets: [{ id: 'worker-runs', metric: 'automation-runs', limit: 2, periodMs: 86_400_000, scope: 'subject' }],
      rules: [
        { id: 'admit', effect: 'allow', subject: { kind: 'background', id: 'work-items/v1' }, actions: ['admit'], resource: { kind: 'automation', id: 'worker' } },
        { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: 'work-items/v1' }, actions: ['ingest'], resource: { kind: 'automation', id: 'worker' } },
      ],
    })
  } else policy = new PolicyPeer(ctx)
  const automationConfig = { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: options.automatic ?? false, tickIntervalMs: 1_000, reconcileIntervalMs: 0 }
  let provider = options.provider === false ? undefined : options.native
    ? ctx.plugin(AssistantAutomationsService, automationConfig)
    : ctx.plugin(SchedulerPeer)
  if (provider !== undefined) await provider
  if (options.native) {
    const store = (ctx.get('assistantAutomations' as never) as unknown as { store: AutomationStore }).store
    store.createApproved({ automationId: 'worker', idempotencyKey: 'worker-definition', definition: {
      name: 'Waiting worker', prompt: 'Frozen worker prompt.', schedule: { kind: 'at', at: '2035-01-01T00:00:00.000Z' },
      workspace: root, agentPreset: 'primary', provider: 'never-called', model: 'never-called', allowedTools: [],
      timeoutMs: 30_000, maxOutputTokens: 128, maxToolCalls: 0, misfire: { kind: 'skip' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      principal: 'owner:one', budgetId: 'worker-runs', budgetAmount: 1,
    } })
  }
  const config: Config = { enabled: options.enabled ?? true, mode: options.mode ?? 'active', databasePath: join(root, 'items.sqlite'), workRoot: join(root, 'work'), workerAutomationId: 'worker',
    scope: { workspace: root, preset: 'primary', principalId: 'owner:one', ownerRouteId: 'route', expiresAt: Date.now() + 86_400_000 },
    admission: { allowedKinds: ['review'], maxOpenItems: 100, maxAdmitsPerHour: 100, cooldownMs: 0 }, limits: { waitingResumeMs: 60_000 } }
  const consumer = ctx.plugin(AssistantWorkItemsService, config); await consumer
  const service = ctx.assistantWorkItems
  return { ctx, root, config, consumer, provider, policy, service, automationConfig,
    setOwnerVersion: (value: number) => { ownerVersion = value },
    async replaceProvider() {
      await provider?.dispose()
      provider = ctx.plugin(SchedulerPeer); await provider
      return ctx.get('assistantAutomations' as never) as unknown as SchedulerPeer
    },
  }
}

async function waiting(fixture: Awaited<ReturnType<typeof setup>>, externalId = 'first') {
  const admitted = fixture.service.admit({ kind: 'review', externalId, title: externalId, brief: 'Wait for the next due continuation.', originBindingId: 'owner-binding' })
  const occurrenceId = admitted.dispatch.occurrenceId!
  fixture.service.claim(worker(occurrenceId))
  await fixture.service.report(worker(occurrenceId), { status: 'waiting', summary: 'Durable waiting conclusion.', idempotencyKey: `waiting-${externalId}` })
  return admitted.item
}

describe('native scheduler-driven waiting continuation', () => {
  test.each([false, true])('native ticks (automatic=%s) enqueue a due occurrence once without running a model or reserving budget', async automatic => {
    const fixture = await setup({ native: true, automatic })
    const automations = fixture.ctx.get('assistantAutomations' as never) as unknown as AssistantAutomationsService
    const policy = fixture.ctx.get('assistantPolicy' as never) as unknown as AssistantPolicyService
    const reserve = vi.spyOn(policy, 'reserve')
    const store = (automations as unknown as { store: AutomationStore }).store
    const item = await waiting(fixture)
    const before = store.listOccurrences({ automationId: 'worker', limit: 10 })
    expect(before).toHaveLength(1)
    await automations.tick()
    expect(store.listOccurrences({ automationId: 'worker', limit: 10 })).toHaveLength(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_001)
    if (automatic) await vi.waitFor(() => expect(store.listOccurrences({ automationId: 'worker', limit: 10 })).toHaveLength(2), { timeout: 3_000, interval: 20 })
    else await automations.tick()
    const second = store.listOccurrences({ automationId: 'worker', limit: 10 })
    expect(second).toHaveLength(2)
    expect(new Set(second.map(occurrence => occurrence.id)).size).toBe(2)
    await automations.tick()
    expect(store.listOccurrences({ automationId: 'worker', limit: 10 })).toHaveLength(2)
    expect(store.listRuns({ automationId: 'worker', limit: 10 })).toEqual([])
    expect(reserve).not.toHaveBeenCalled()
    const workStore = new WorkItemStore(fixture.config.databasePath!)
    try { expect(workStore.findItemById(item.id)?.attempt).toBe(1) } finally { workStore.close() }
    expect(fixture.service.health().schedulerWake.subscribed).toBe(true)
  })

  test('keeps a committed-but-unknown native wake unchanged across later ticks while continuing the same page', async () => {
    const fixture = await setup({ native: true })
    const automations = fixture.ctx.get('assistantAutomations' as never) as unknown as AssistantAutomationsService
    const policy = fixture.ctx.get('assistantPolicy' as never) as unknown as AssistantPolicyService
    const reserve = vi.spyOn(policy, 'reserve')
    const automationStore = (automations as unknown as { store: AutomationStore }).store
    await waiting(fixture, 'unknown-receipt')
    await waiting(fixture, 'same-page-peer')
    const store = new WorkItemStore(fixture.config.databasePath!)
    try {
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_001)
      const due = store.listDueWaitingResumes(10)
      expect(due).toHaveLength(2)
      const unknown = due[0]!
      const other = due[1]!
      const ingest = automations.ingestExternal.bind(automations)
      const receipt = vi.spyOn(automations, 'ingestExternal').mockImplementation(input => {
        const occurrence = ingest(input)
        if (input.eventId === unknown.eventId) throw new Error('native occurrence committed but its receipt was lost')
        return occurrence
      })
      expect(automationStore.listOccurrences({ automationId: 'worker', limit: 10 })).toHaveLength(2)
      await automations.tick()
      // Both peer calls reached the real SQLite store; only one lost its reply.
      expect(automationStore.listOccurrences({ automationId: 'worker', limit: 10 })).toHaveLength(4)
      expect(store.getDispatch(unknown.itemId)).toMatchObject({ state: 'failed', reason: 'unknown_after_send',
        generation: unknown.generation, eventId: unknown.eventId, occurredAt: unknown.occurredAt })
      expect(store.getDispatch(other.itemId)).toMatchObject({ state: 'dispatched' })
      expect(fixture.service.health().dispatchUnknown).toBe(1)
      const frozenUnknown = store.getDispatch(unknown.itemId)
      for (let index = 0; index < 3; index += 1) await automations.tick()
      expect(receipt).toHaveBeenCalledTimes(2)
      expect(automationStore.listOccurrences({ automationId: 'worker', limit: 10 })).toHaveLength(4)
      expect(store.getDispatch(unknown.itemId)).toEqual(frozenUnknown)
      expect(store.findItemById(unknown.itemId)?.attempt).toBe(1)
      expect(store.findItemById(other.itemId)?.attempt).toBe(1)
      expect(automationStore.listRuns({ automationId: 'worker', limit: 10 })).toEqual([])
      expect(reserve).not.toHaveBeenCalled()
    } finally { store.close() }
  })

  test('only binds active intakes, supports late/replaced providers and detaches before close', async () => {
    const fixture = await setup({ provider: false })
    expect(fixture.service.health().schedulerWake.subscribed).toBe(false)
    const first = await fixture.replaceProvider()
    await vi.waitFor(() => expect(first.listeners.size).toBe(1))
    await waiting(fixture)
    const oldCallback = Array.from(first.listeners)[0]!
    const replacement = await fixture.replaceProvider()
    await vi.waitFor(() => expect(replacement.listeners.size).toBe(1))
    expect(first.listeners.size).toBe(0)
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_001)
    const store = new WorkItemStore(fixture.config.databasePath!)
    try {
      const cursor = store.meta('scheduler.waiting-resume.cursor')
      oldCallback()
      expect(store.meta('scheduler.waiting-resume.cursor')).toBe(cursor)
      expect(replacement.ingests).toHaveLength(0)
    } finally { store.close() }
    replacement.wake()
    expect(replacement.ingests).toHaveLength(1)
    const stale = [...replacement.listeners][0]!
    fixture.service.close(); fixture.service.close()
    expect(replacement.listeners.size).toBe(0)
    expect(() => stale()).not.toThrow()
    expect(fixture.service.health().schedulerWake.subscribed).toBe(false)
  })

  test.each([{ enabled: false, mode: 'active' as const }, { enabled: true, mode: 'observe' as const }])('disabled/observe never subscribe or acquire a ledger during native wake: %j', async options => {
    const fixture = await setup(options)
    const peer = fixture.ctx.get('assistantAutomations' as never) as unknown as SchedulerPeer
    expect(peer.listeners.size).toBe(0)
    const existed = existsSync(fixture.config.databasePath!)
    peer.wake()
    expect(existsSync(fixture.config.databasePath!)).toBe(existed)
    if (!options.enabled) expect(existed).toBe(false)
  })

  test('fixed ten-candidate pages stay fair across persistent denials and future due times', async () => {
    const fixture = await setup()
    const peer = fixture.ctx.get('assistantAutomations' as never) as unknown as SchedulerPeer
    for (let index = 0; index < 12; index += 1) await waiting(fixture, `item-${index}`)
    const store = new WorkItemStore(fixture.config.databasePath!)
    try {
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_001)
      const firstTen = store.listDueWaitingResumes(10)
      expect(firstTen).toHaveLength(10)
      for (const dispatch of firstTen) fixture.policy!.denied.add(store.findItemById(dispatch.itemId)!.authority!.idempotencyKey)
      const authorize = vi.spyOn(fixture.policy!, 'authorize')
      peer.wake()
      expect(authorize).toHaveBeenCalledTimes(10)
      expect(peer.ingests).toHaveLength(12)
      peer.wake()
      expect(peer.ingests).toHaveLength(14)
      expect(store.meta('scheduler.waiting-resume.cursor')).not.toBeNull()
      await waiting(fixture, 'future-item')
      expect(peer.ingests).toHaveLength(15)
      peer.wake()
      expect(peer.ingests).toHaveLength(15)
      vi.setSystemTime(Date.now() + 60_001)
      peer.wake(); peer.wake()
      expect(peer.ingests).toHaveLength(16)
    } finally { store.close() }
  })

  test('ignores expired owner authority and synchronously reentrant wake notifications', async () => {
    const fixture = await setup()
    const peer = fixture.ctx.get('assistantAutomations' as never) as unknown as SchedulerPeer
    await waiting(fixture)
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_001)
    fixture.setOwnerVersion(2)
    peer.wake(); expect(peer.ingests).toHaveLength(1)
    fixture.setOwnerVersion(1)
    peer.onIngest = () => peer.wake()
    peer.wake(); expect(peer.ingests).toHaveLength(2)
    peer.wake(); expect(peer.ingests).toHaveLength(2)
  })

  test('limits inspection to ten indexed candidates even when the first ten items are ineligible', async () => {
    const fixture = await setup()
    const peer = fixture.ctx.get('assistantAutomations' as never) as unknown as SchedulerPeer
    for (let index = 0; index < 12; index += 1) await waiting(fixture, `stale-${index}`)
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_001)
    const store = (fixture.service as unknown as { workItemsComponents: { store: WorkItemStore } }).workItemsComponents.store
    const firstTen = store.listDueWaitingResumes(10)
    const raw = new DatabaseSync(fixture.config.databasePath!)
    try {
      for (const dispatch of firstTen) raw.prepare("UPDATE work_item SET state = 'ready' WHERE id = ?").run(dispatch.itemId)
    } finally { raw.close() }
    const find = vi.spyOn(store, 'findItemById')
    const recover = vi.spyOn(store, 'reclaimExpired')
    peer.wake()
    expect(find).toHaveBeenCalledTimes(10)
    expect(peer.ingests).toHaveLength(12)
    expect(recover).not.toHaveBeenCalled()
    peer.wake()
    expect(peer.ingests).toHaveLength(14)
    expect(recover).not.toHaveBeenCalled()
  })

  test('an older peer keeps startup/claim recovery without installing a scheduler subscription', async () => {
    class OldPeer extends Service {
      ingests = 0
      constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
      ingestExternal(input: { automationId: string }) { this.ingests += 1; return { id: `legacy-occ-${this.ingests}`, automationId: input.automationId } }
    }
    const fixture = await setup({ provider: false })
    await fixture.ctx.plugin(OldPeer)
    expect(fixture.service.health().schedulerWake.subscribed).toBe(false)
    const peer = fixture.ctx.get('assistantAutomations' as never) as unknown as OldPeer
    await waiting(fixture)
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_001)
    expect(() => fixture.service.claim(worker('unbound'))).toThrow(/no work item is bound/)
    expect(peer.ingests).toBe(2)
  })
})

test('a native wake releases an owned follow-up after its item ends', async () => {
  const fixture = await setup()
  const admitted = fixture.service.admit({ kind: 'review', externalId: 'release', title: 'release', brief: 'x', originBindingId: 'owner-binding' })
  const occurrenceId = admitted.dispatch.occurrenceId!
  fixture.service.claim(worker(occurrenceId))
  expect(fixture.service.ownFollowUp({ protocol: 'work-items/follow-up/v1', itemId: admitted.item.id,
    bindingId: 'owner-binding', messageId: 'msg-release', sourceDigest: 'sha256:x' })).toMatchObject({ outcome: 'owned' })
  await fixture.service.report(worker(occurrenceId), { status: 'failed', summary: 'terminal', idempotencyKey: 'release-failed' })
  expect(fixture.service.followUps(admitted.item.id).map(record => record.state)).toEqual(['owned'])
  const peer = fixture.ctx.get('assistantAutomations' as never) as unknown as SchedulerPeer
  peer.wake()
  expect(fixture.service.followUps(admitted.item.id).map(record => record.state)).toEqual(['released'])
})

test('schema 7 migration preserves every historical row and real keyset queries use bounded indexes', async () => {
  const fixture = await setup()
  await waiting(fixture)
  fixture.service.close()
  const raw = new DatabaseSync(fixture.config.databasePath!)
  const data = () => ['work_item', 'work_item_event', 'work_item_claim', 'work_item_report', 'work_item_outcome', 'work_item_dispatch', 'work_item_follow']
    .map(table => raw.prepare(`SELECT * FROM ${table}`).all())
  const before = data()
  raw.exec("DROP TABLE work_item_intake_admission; DROP TABLE work_item_intake_evaluation; DROP TABLE work_item_intake; DROP TABLE work_item_continuation; DROP INDEX work_item_dispatch_waiting_due_idx; DROP INDEX work_item_claim_active_item_idx; PRAGMA user_version = 7; UPDATE work_item_schema_meta SET value = '7' WHERE key = 'schema_version';")
  const queries: string[] = []
  const original = DatabaseSync.prototype.prepare
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.includes('SELECT d.* FROM work_item_dispatch d INDEXED BY')) queries.push(sql)
    return original.call(this, sql)
  })
  const store = new WorkItemStore(fixture.config.databasePath!)
  try {
    expect(store.stats().schemaVersion).toBe(13)
    expect(data()).toEqual(before)
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_001)
    store.listDueWaitingResumes(10)
    expect(queries).toHaveLength(1)
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${queries[0]!}`).all(Date.now(), 0, '', 10)
    const details = plan.map(row => String(row['detail'])).join('\n')
    expect(details).toContain('SEARCH d USING INDEX work_item_dispatch_waiting_due_idx')
    expect(details).not.toMatch(/SCAN |TEMP B-TREE/u)
    const activePlan = raw.prepare("EXPLAIN QUERY PLAN SELECT * FROM work_item_claim WHERE item_id = ? AND state = 'active'").all('item')
    const activeDetails = activePlan.map(row => String(row['detail'])).join('\n')
    expect(activeDetails).toContain('work_item_claim_active_item_idx')
    console.info(`waiting-resume EXPLAIN: ${details}\nactive-claim EXPLAIN: ${activeDetails}`)
  } finally { prepare.mockRestore(); store.close(); raw.close() }
})

test.each(['table', 'trigger'] as const)('rejects sqliteXshadow %s before a version 7 migration can write', async kind => {
  const fixture = await setup()
  const item = await waiting(fixture)
  fixture.service.close()
  const raw = new DatabaseSync(fixture.config.databasePath!)
  try {
    raw.exec("DROP TABLE work_item_intake_admission; DROP TABLE work_item_intake_evaluation; DROP TABLE work_item_intake; DROP TABLE work_item_continuation; DROP INDEX work_item_dispatch_waiting_due_idx; DROP INDEX work_item_claim_active_item_idx; PRAGMA user_version = 7; UPDATE work_item_schema_meta SET value = '7' WHERE key = 'schema_version';")
    if (kind === 'table') raw.exec('CREATE TABLE sqliteXshadow (value TEXT)')
    else raw.exec("CREATE TRIGGER sqliteXshadow AFTER UPDATE ON work_item_schema_meta BEGIN UPDATE work_item SET title = 'corrupted by foreign trigger'; END")
    expect(raw.prepare("SELECT type FROM sqlite_schema WHERE name = 'sqliteXshadow'").get()).toEqual({ type: kind })
    expect(() => new WorkItemStore(fixture.config.databasePath!)).toThrow(/unexpected schema object/)
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
    expect(raw.prepare('SELECT title FROM work_item WHERE id = ?').get(item.id)).toEqual({ title: item.title })
    expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'work_item_dispatch_waiting_due_idx'").get()).toBeUndefined()
  } finally { raw.close() }
})
