import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { externalEventDigest, type ExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { normalizeConfig, type Config } from '../src/config.ts'
import { eventEnvelopeDigest, parseEventFollowRef } from '../src/event-follow.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import { WorkItemStore } from '../src/store.ts'
import type { PeerPolicyService } from '../src/peers.ts'
import { WorkItemError } from '../src/types.ts'
import { deliveryPeer, PRESET, PRINCIPAL, ROUTE, signal, WORKER, WORKSPACE } from './fixtures.ts'

// ---------------------------------------------------------------------------
// Fixture Event Triggers store: the same read contract and fencing as the real
// service (cursor floor, enabled + config digest check, owner scope match).
// ---------------------------------------------------------------------------

const OWNER = Object.freeze({ principalId: PRINCIPAL, principalRecordId: 'principal-1', principalVersion: 7 as number, workspace: WORKSPACE, preset: PRESET })
const VERSION = 'event-triggers/test'
const hex = (value: string) => createHash('sha256').update(value).digest('hex')

interface FakeTrigger { id: string; enabled: boolean; configDigest: string; automationId: string; owner: typeof OWNER }
interface FakeEvent { sequence: number; triggerId: string; configDigest: string; envelope: Readonly<ExternalEventEnvelope> }
interface FakeState { triggers: Map<string, FakeTrigger>; events: FakeEvent[]; sequence: number; reads: number }

function fakeState(): FakeState {
  const state: FakeState = { triggers: new Map(), events: [], sequence: 0, reads: 0 }
  state.triggers.set('deploy-hook', { id: 'deploy-hook', enabled: true, configDigest: hex('config-1'), automationId: 'deploy-automation', owner: OWNER })
  state.triggers.set('other', { id: 'other', enabled: true, configDigest: hex('other-1'), automationId: 'other-automation', owner: OWNER })
  // Unrelated traffic advances the single global store sequence.
  state.sequence = 3
  return state
}

function envelope(trigger: FakeTrigger, eventId: string, receivedAt: number): Readonly<ExternalEventEnvelope> {
  const sourceId = `event-triggers:${trigger.id}`
  return Object.freeze({
    protocol: 'dsh-external-event/v1' as const,
    source: Object.freeze({ id: sourceId, kind: 'webhook' as const, version: VERSION, configDigest: trigger.configDigest }),
    event: Object.freeze({ id: eventId, occurredAt: receivedAt - 10, receivedAt }),
    observation: Object.freeze({ digest: hex(eventId), revision: 'r1', timeBasis: 'source-signed' as const }),
    trust: Object.freeze({ method: 'hmac-sha256' as const, content: 'untrusted' as const }),
    target: Object.freeze({ automationId: trigger.automationId }),
    deduplicationKey: `${sourceId}:${eventId}`,
  })
}

function arrive(state: FakeState, triggerId: string, eventId: string, receivedAt = Date.now()): FakeEvent {
  const trigger = state.triggers.get(triggerId)!
  state.sequence += 1
  const event = { sequence: state.sequence, triggerId, configDigest: trigger.configDigest, envelope: envelope(trigger, eventId, receivedAt) }
  state.events.push(event)
  return event
}

class FakeEventTriggers extends Service {
  constructor(ctx: Context, private readonly state: FakeState) { super(ctx, 'eventTriggers' as never) }

  inspectOwnerSources(scope: typeof OWNER) {
    return Object.freeze([...this.state.triggers.values()].filter(trigger => trigger.enabled
      && trigger.owner.principalId === scope.principalId && trigger.owner.principalRecordId === scope.principalRecordId
      && trigger.owner.principalVersion === scope.principalVersion && trigger.owner.workspace === scope.workspace
      && trigger.owner.preset === scope.preset)
      .map(trigger => Object.freeze({ triggerId: trigger.id, automationId: trigger.automationId, kind: 'webhook', expiresAt: Date.now() + 3_600_000 })))
  }

  sourceSnapshot(triggerId: string) {
    const trigger = this.live(triggerId)
    return Object.freeze({
      protocol: 'dsh-event-source/v1' as const, sourceId: `event-triggers:${trigger.id}`, kind: 'webhook', version: VERSION,
      configDigest: trigger.configDigest, target: Object.freeze({ automationId: trigger.automationId }), highWaterSequence: this.state.sequence,
    })
  }

  firstEventAfter(snapshot: ReturnType<FakeEventTriggers['sourceSnapshot']>, afterSequence: number, deadlineAt: number) {
    this.state.reads += 1
    if (!Number.isSafeInteger(afterSequence) || afterSequence < snapshot.highWaterSequence) throw new Error('source-changed: cursor is invalid')
    const trigger = this.live(snapshot.sourceId.slice('event-triggers:'.length))
    if (snapshot.configDigest !== trigger.configDigest || snapshot.version !== VERSION) throw new Error('source-changed: configuration changed')
    const hit = this.state.events.find(event => event.triggerId === trigger.id && event.sequence > afterSequence
      && event.configDigest === trigger.configDigest && event.envelope.event.receivedAt <= deadlineAt)
    return hit === undefined ? undefined : Object.freeze({ sequence: hit.sequence, envelope: hit.envelope })
  }

  private live(triggerId: string): FakeTrigger {
    const trigger = this.state.triggers.get(triggerId)
    if (trigger === undefined || !trigger.enabled) throw new Error('source-changed: event source is no longer configured or enabled')
    return trigger
  }
}

// ---------------------------------------------------------------------------
// Service harness
// ---------------------------------------------------------------------------

const roots: string[] = []
const closers: Array<() => void> = []
afterEach(async () => {
  for (const close of closers.splice(0)) close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FakeToolsPeer extends Service {
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(): void {}
}

class FakeAutomationsPeer extends Service {
  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  ingestExternal(input: { automationId: string; eventId: string; occurredAt: number }) {
    return Object.freeze({ id: 'occ-1', automationId: input.automationId, eventId: input.eventId, occurredAt: input.occurredAt })
  }
}

function workerAgent(occurrenceId: string): Agent {
  const execution = Object.freeze({ mode: 'production', automationId: WORKER, occurrenceId })
  return { ctx: { get: (name: string) => name === 'assistantAutomationExecution' ? execution : undefined } } as unknown as Agent
}

function config(root: string, follows: boolean | undefined): Config {
  return {
    enabled: true, mode: 'active',
    databasePath: join(root, 'state', 'state.sqlite'), workRoot: join(root, 'work'),
    intakeSourceId: 'work-items/v1', workerAutomationId: WORKER,
    scope: { workspace: WORKSPACE, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: ROUTE, expiresAt: Date.now() + 3_600_000 },
    admission: { allowedKinds: ['review'], maxOpenItems: 8, maxAdmitsPerHour: 16, dedupWindowMs: 3_600_000, cooldownMs: 0, maxBriefBytes: 512 },
    ...(follows === undefined ? {} : { follows: { eventTriggers: { enabled: follows } } }),
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 10))

interface Fixture {
  readonly root: string
  readonly state: FakeState
  readonly ctx: Context
  readonly service: AssistantWorkItemsService
  /** Re-provide Event Triggers, as a config reload of that plugin does. */
  reload(): Promise<void>
  reopen(): Promise<void>
}

async function fixture(options: { follows?: boolean | undefined; eventTriggers?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'work-items-event-follow-'))
  roots.push(root)
  const state = fakeState()
  const build = () => {
    const ctx = new Context()
    ctx.provide('assistantPolicy' as never, { authorize: () => ({ effect: 'allow', reasonCode: 'rule-allow' }) } satisfies PeerPolicyService as never)
    ctx.provide('assistantDelivery' as never, deliveryPeer() as never)
    new FakeToolsPeer(ctx)
    new FakeAutomationsPeer(ctx)
    let fork = options.eventTriggers === false ? undefined : ctx.plugin({ name: 'fake-event-triggers', apply: (child: Context) => { new FakeEventTriggers(child, state) } })
    const service = new AssistantWorkItemsService(ctx, config(root, 'follows' in options ? options.follows : true))
    closers.push(() => service.close())
    return { ctx, service, reload: async () => {
      await fork?.dispose()
      await flush()
      fork = ctx.plugin({ name: 'fake-event-triggers', apply: (child: Context) => { new FakeEventTriggers(child, state) } })
      await flush()
    } }
  }
  let current = build()
  await flush()
  const result: Fixture = {
    root, state, get ctx() { return current.ctx },
    get service() { return current.service },
    reload: () => current.reload(),
    reopen: async () => { current.service.close(); current = build(); await flush() },
  }
  return result
}

function readStore(root: string): WorkItemStore {
  const store = new WorkItemStore(join(root, 'state', 'state.sqlite'))
  closers.push(() => store.close())
  return store
}

function errorCode(run: () => unknown): string {
  try { run() } catch (error) {
    expect(error).toBeInstanceOf(WorkItemError)
    return (error as WorkItemError).code
  }
  throw new Error('expected a WorkItemError')
}

async function admitAndReport(fx: Fixture, ref: string) {
  const admitted = fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref }] }))
  fx.service.claim(workerAgent('occ-1'))
  await fx.service.report(workerAgent('occ-1'), { status: 'ready', summary: 'done', idempotencyKey: 'idem-1' })
  return admitted
}

// ---------------------------------------------------------------------------

describe('event-triggers follow source', () => {
  test('an authenticated event after the admitted cursor closes the follow and settles exactly once', async () => {
    const fx = await fixture()
    const admitted = await admitAndReport(fx, 'deploy-hook@3')
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0 })

    // An event on another owner trigger does not close this follow.
    arrive(fx.state, 'other', 'evt-other')
    expect(fx.service.settleOutcomes(true)).toMatchObject({ closedByThread: 0 })
    const event = arrive(fx.state, 'deploy-hook', 'evt-1')
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 0, closedByThread: 1 })
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 0, closedByThread: 0 })

    const store = readStore(fx.root)
    expect(store.outcomes(admitted.item.id)).toHaveLength(1)
    expect(store.latestOutcome(admitted.item.id)).toMatchObject({ settledBy: 'closed-by-thread', objectiveStatus: 'unknown', evidenceState: 'unverified' })
    expect(store.follows(admitted.item.id)[0]).toMatchObject({
      kind: 'event-triggers', source: 'event-triggers', state: 'closed', outcome: 'unknown', digest: externalEventDigest(event.envelope),
    })
    expect(fx.service.health().follows).toMatchObject({ open: 0, closed: 1, unresolved: 0, degraded: null })
  })

  test('an Event Triggers config change degrades to generation-mismatch and the follow stays open', async () => {
    const fx = await fixture()
    const admitted = await admitAndReport(fx, 'deploy-hook@3')
    fx.state.triggers.get('deploy-hook')!.configDigest = hex('config-2')
    await fx.reload()
    arrive(fx.state, 'deploy-hook', 'evt-1')

    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0, followDegraded: 'generation-mismatch' })
    const store = readStore(fx.root)
    expect(store.latestOutcome(admitted.item.id)).toBeUndefined()
    expect(store.follows(admitted.item.id)[0]).toMatchObject({ state: 'open', outcome: null })
    expect(fx.service.health().follows).toMatchObject({ open: 1, unresolved: 1, degraded: 'generation-mismatch' })
  })

  test('a config change seen before the source is re-provided fails closed instead of closing', async () => {
    const fx = await fixture()
    const admitted = await admitAndReport(fx, 'deploy-hook@3')
    fx.state.triggers.get('deploy-hook')!.configDigest = hex('config-2')
    arrive(fx.state, 'deploy-hook', 'evt-1')
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0, followDegraded: 'resolver-failed' })
    expect(readStore(fx.root).latestOutcome(admitted.item.id)).toBeUndefined()
  })

  test('a disabled trigger leaves the follow unresolved', async () => {
    const fx = await fixture()
    const admitted = await admitAndReport(fx, 'deploy-hook@3')
    arrive(fx.state, 'deploy-hook', 'evt-1')
    fx.state.triggers.get('deploy-hook')!.enabled = false

    // Without and with a re-provide, a disabled source never closes the follow.
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0, followDegraded: 'resolver-failed' })
    await fx.reload()
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0, followDegraded: 'generation-mismatch' })
    expect(readStore(fx.root).latestOutcome(admitted.item.id)).toBeUndefined()
    expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: 'deploy-hook@4' }] })))).toBe('invalid-input')
  })

  test('admission rejects a forged low, a future, a foreign or a malformed cursor before any write', async () => {
    const fx = await fixture()
    arrive(fx.state, 'deploy-hook', 'evt-old')
    // High water is now 4; evt-old at sequence 4 already exists.
    for (const ref of ['deploy-hook@3', 'deploy-hook@0', 'deploy-hook@5', 'missing@4', 'deploy-hook', 'Deploy-Hook@4', 'deploy-hook@04']) {
      expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref }] })))).toBe('invalid-input')
    }
    fx.state.triggers.set('foreign', { ...fx.state.triggers.get('deploy-hook')!, id: 'foreign', owner: { ...OWNER, principalVersion: 8 } })
    expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: 'foreign@4' }] })))).toBe('invalid-input')
    const store = readStore(fx.root)
    expect(store.countFollows()).toEqual({ open: 0, closed: 0 })

    // The exact current high water admits, and the old event never closes it.
    const admitted = await admitAndReport(fx, 'deploy-hook@4')
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0 })
    expect(store.follows(admitted.item.id)[0]).toMatchObject({ state: 'open' })
  })

  test('restart is idempotent: the same generation re-registers and settles once', async () => {
    const fx = await fixture()
    const admitted = await admitAndReport(fx, 'deploy-hook@3')
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0 })
    await fx.reopen()
    expect(fx.service.health().follows).toMatchObject({ open: 1, unresolved: 0, degraded: null })
    arrive(fx.state, 'deploy-hook', 'evt-1')
    expect(fx.service.settleOutcomes(true)).toMatchObject({ closedByThread: 1 })
    await fx.reopen()
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 0, closedByThread: 0 })
    expect(readStore(fx.root).outcomes(admitted.item.id)).toHaveLength(1)
  })

  test('flag off registers nothing and never reads Event Triggers', async () => {
    for (const follows of [undefined, false]) {
      const fx = await fixture({ follows: follows as boolean | undefined })
      if (follows === undefined) {
        // Absent config keeps the prior normalized shape exactly.
        expect('follows' in normalizeConfig(config(fx.root, undefined))).toBe(false)
      }
      expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: 'deploy-hook@3' }] })))).toBe('invalid-input')
      // Hosts may still register their own source under that name.
      const dispose = fx.service.registerThreadSource({ source: 'event-triggers', generation: 'host', resolve: () => undefined })
      dispose()
      expect(fx.state.reads).toBe(0)
    }
  })

  test('without the Event Triggers service the source stays unregistered', async () => {
    const fx = await fixture({ eventTriggers: false })
    expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: 'deploy-hook@3' }] })))).toBe('invalid-input')
  })
})

describe('event-triggers follow config and helpers', () => {
  test('validates follows config and requires an enabled scoped intake', () => {
    const root = '/tmp/work-items-event-follow-config'
    expect(normalizeConfig(config(root, true)).follows).toEqual({ eventTriggers: true })
    expect(normalizeConfig(config(root, false)).follows).toBeUndefined()
    const bad = (follows: unknown, overrides: Partial<Config> = {}) => errorCode(() => normalizeConfig({ ...config(root, undefined), ...overrides, follows } as Config))
    expect(bad({ eventTriggers: { enabled: 'yes' } })).toBe('invalid-input')
    expect(bad({ eventTriggers: { enabled: true, extra: 1 } })).toBe('invalid-input')
    expect(bad({ other: {} })).toBe('invalid-input')
    expect(bad([])).toBe('invalid-input')
    expect(bad({ eventTriggers: { enabled: true } }, { enabled: false })).toBe('invalid-input')
    expect(bad({ eventTriggers: { enabled: true } }, { mode: 'observe', scope: undefined } as unknown as Partial<Config>)).toBe('invalid-input')
  })

  test('the local envelope digest matches externalEventDigest', () => {
    const trigger = fakeState().triggers.get('deploy-hook')!
    const value = envelope(trigger, 'evt-1', 1_700_000_000_000)
    expect(eventEnvelopeDigest(value)).toBe(externalEventDigest(value))
  })

  test('parses only canonical refs', () => {
    expect(parseEventFollowRef('deploy-hook@12')).toEqual({ triggerId: 'deploy-hook', afterSequence: 12 })
    for (const ref of ['deploy-hook@', '@1', 'deploy-hook@-1', 'deploy-hook@1.5', 'deploy-hook@99999999999999999', 'a@1@2']) {
      expect(parseEventFollowRef(ref)).toBeUndefined()
    }
  })

  test('validate is an optional registration key and must be a function', async () => {
    const fx = await fixture({ follows: false })
    expect(errorCode(() => fx.service.registerThreadSource({ source: 'ticket', generation: 'g', resolve: () => undefined, validate: 1 } as never))).toBe('invalid-input')
    const dispose = fx.service.registerThreadSource({ source: 'ticket', generation: 'g', resolve: () => undefined, validate: ref => ref === 'T-1' })
    expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'ticket', ref: 'T-2' }] })))).toBe('invalid-input')
    expect(fx.service.admit(signal({ follows: [{ kind: 'ticket', ref: 'T-1' }] })).item.id).toBeTypeOf('string')
    dispose()
    fx.service.registerThreadSource({ source: 'ticket', generation: 'g', resolve: () => undefined, validate: () => { throw new Error('boom') } })
    expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'ticket', ref: 'T-3' }] })))).toBe('invalid-input')
  })
})
