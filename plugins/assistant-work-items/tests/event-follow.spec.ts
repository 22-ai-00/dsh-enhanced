import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { externalEventDigest, type ExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { normalizeConfig, type Config } from '../src/config.ts'
import { eventEnvelopeDigest, eventFollowGeneration, parseEventFollowRef } from '../src/event-follow.ts'
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

interface FakeTrigger { id: string; enabled: boolean; configDigest: string; automationId: string; owner: typeof OWNER; expiresAt?: number }
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
    // Like the real service, an expired observer drops out of owner discovery.
    return Object.freeze([...this.state.triggers.values()].filter(trigger => trigger.enabled
      && (trigger.expiresAt === undefined || trigger.expiresAt > Date.now())
      && trigger.owner.principalId === scope.principalId && trigger.owner.principalRecordId === scope.principalRecordId
      && trigger.owner.principalVersion === scope.principalVersion && trigger.owner.workspace === scope.workspace
      && trigger.owner.preset === scope.preset)
      .map(trigger => Object.freeze({ triggerId: trigger.id, automationId: trigger.automationId, kind: 'webhook', expiresAt: trigger.expiresAt ?? Date.now() + 3_600_000 })))
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
    return Object.freeze({ id: `occ-${input.eventId}`, automationId: input.automationId, eventId: input.eventId, occurredAt: input.occurredAt })
  }
}

function workerAgent(occurrenceId: string): Agent {
  const execution = Object.freeze({ mode: 'production', automationId: WORKER, occurrenceId })
  return { ctx: { get: (name: string) => name === 'assistantAutomationExecution' ? execution : undefined } } as unknown as Agent
}

function config(root: string, follows: boolean | undefined, acceptHeadRef?: boolean): Config {
  return {
    enabled: true, mode: 'active',
    databasePath: join(root, 'state', 'state.sqlite'), workRoot: join(root, 'work'),
    intakeSourceId: 'work-items/v1', workerAutomationId: WORKER,
    scope: { workspace: WORKSPACE, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: ROUTE, expiresAt: Date.now() + 3_600_000 },
    admission: { allowedKinds: ['review'], maxOpenItems: 8, maxAdmitsPerHour: 16, dedupWindowMs: 3_600_000, cooldownMs: 0, maxBriefBytes: 512 },
    ...(follows === undefined ? {} : { follows: { eventTriggers: { enabled: follows, ...(acceptHeadRef === undefined ? {} : { acceptHeadRef }) } } }),
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

async function fixture(options: { follows?: boolean | undefined; eventTriggers?: boolean; acceptHeadRef?: boolean } = {}): Promise<Fixture> {
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
    const service = new AssistantWorkItemsService(ctx, config(root, 'follows' in options ? options.follows : true, options.acceptHeadRef))
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

/** Ref for a trigger at a cursor (default: current high water) under its live config digest. */
function refFor(state: FakeState, triggerId: string, afterSequence = state.sequence, digest = state.triggers.get(triggerId)!.configDigest): string {
  return `${triggerId}@${afterSequence}@${digest}`
}

async function admitAndReport(fx: Fixture, ref: string) {
  const admitted = fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref }] }))
  await flush()
  const occurrenceId = readStore(fx.root).getDispatch(admitted.item.id)?.occurrenceId
  if (!occurrenceId) throw new Error('dispatch has no occurrence')
  const worker = workerAgent(occurrenceId)
  fx.service.claim(worker)
  await fx.service.report(worker, { status: 'ready', summary: 'done', idempotencyKey: `idem-${occurrenceId}` })
  return admitted
}

// ---------------------------------------------------------------------------

describe('event-triggers follow source', () => {
  test('an authenticated event after the admitted cursor closes the follow and settles exactly once', async () => {
    const fx = await fixture()
    const admitted = await admitAndReport(fx, refFor(fx.state, 'deploy-hook'))
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

  test('a config edit of one trigger degrades only that trigger\'s follows, with or without re-provide', async () => {
    const fx = await fixture()
    const onA = await admitAndReport(fx, refFor(fx.state, 'deploy-hook'))
    const onOther = await admitAndReport(fx, refFor(fx.state, 'other'))
    const generation = readStore(fx.root).follows(onA.item.id)[0]!.sourceGeneration
    fx.state.triggers.get('deploy-hook')!.configDigest = hex('config-2')
    arrive(fx.state, 'deploy-hook', 'evt-a')
    arrive(fx.state, 'other', 'evt-other')

    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 1, followDegraded: 'resolver-failed' })
    await fx.reload()
    // The generation is owner-only, so a re-provide never strands follows.
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0, followDegraded: 'resolver-failed' })
    const store = readStore(fx.root)
    expect(store.latestOutcome(onA.item.id)).toBeUndefined()
    expect(store.follows(onA.item.id)[0]).toMatchObject({ state: 'open', outcome: null })
    expect(store.latestOutcome(onOther.item.id)).toMatchObject({ settledBy: 'closed-by-thread' })
    expect(fx.service.health().follows).toMatchObject({ open: 1, closed: 1, degraded: 'resolver-failed' })

    // New admissions use the new digest; the old digest is refused.
    expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: refFor(fx.state, 'deploy-hook', fx.state.sequence, hex('config-1')) }] })))).toBe('invalid-input')
    const fresh = fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: refFor(fx.state, 'deploy-hook') }] }))
    expect(readStore(fx.root).follows(fresh.item.id)[0]!.sourceGeneration).toBe(generation)
  })

  test('observer expiry of an unrelated trigger affects neither other follows nor new admissions', async () => {
    const fx = await fixture()
    const onA = await admitAndReport(fx, refFor(fx.state, 'deploy-hook'))
    const onOther = await admitAndReport(fx, refFor(fx.state, 'other'))
    fx.state.triggers.get('other')!.expiresAt = Date.now() - 1
    await fx.reload()

    // Admission for a still-current trigger keeps working.
    const fresh = fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: refFor(fx.state, 'deploy-hook') }] }))
    expect(fresh.created).toBe(true)
    expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: refFor(fx.state, 'other') }] })))).toBe('invalid-input')

    arrive(fx.state, 'deploy-hook', 'evt-a')
    arrive(fx.state, 'other', 'evt-other')
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 1, followDegraded: 'resolver-failed' })
    const store = readStore(fx.root)
    expect(store.latestOutcome(onA.item.id)).toMatchObject({ settledBy: 'closed-by-thread' })
    expect(store.latestOutcome(onOther.item.id)).toBeUndefined()
    expect(store.follows(onOther.item.id)[0]).toMatchObject({ state: 'open' })
  })

  test('a disabled trigger leaves the follow unresolved', async () => {
    const fx = await fixture()
    const admitted = await admitAndReport(fx, refFor(fx.state, 'deploy-hook'))
    arrive(fx.state, 'deploy-hook', 'evt-1')
    fx.state.triggers.get('deploy-hook')!.enabled = false

    // Without and with a re-provide, a disabled source never closes the follow.
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0, followDegraded: 'resolver-failed' })
    await fx.reload()
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0, followDegraded: 'resolver-failed' })
    expect(readStore(fx.root).latestOutcome(admitted.item.id)).toBeUndefined()
    expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: `deploy-hook@4@${hex('config-1')}` }] })))).toBe('invalid-input')
  })

  test('retrying an admitted signal after new events returns the duplicate, not invalid-input', async () => {
    const fx = await fixture()
    const input = signal({ follows: [{ kind: 'event-triggers', ref: refFor(fx.state, 'deploy-hook') }] })
    const first = fx.service.admit(input)
    arrive(fx.state, 'deploy-hook', 'evt-1')
    // The cursor is now below the high water, yet the replay is answered first.
    const retry = fx.service.admit(input)
    expect(retry).toMatchObject({ created: false, reason: 'duplicate' })
    expect(retry.item.id).toBe(first.item.id)
    expect(readStore(fx.root).countFollows()).toEqual({ open: 1, closed: 0 })
  })

  test('admission rejects a forged low, a future, a foreign or a malformed cursor before any write', async () => {
    const fx = await fixture()
    arrive(fx.state, 'deploy-hook', 'evt-old')
    const digest = hex('config-1')
    // High water is now 4; evt-old at sequence 4 already exists.
    for (const ref of [`deploy-hook@3@${digest}`, `deploy-hook@0@${digest}`, `deploy-hook@5@${digest}`, `missing@4@${digest}`,
      `deploy-hook@4@${hex('stale')}`, 'deploy-hook@4', 'deploy-hook', `Deploy-Hook@4@${digest}`, `deploy-hook@04@${digest}`]) {
      expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref }] })))).toBe('invalid-input')
    }
    fx.state.triggers.set('foreign', { ...fx.state.triggers.get('deploy-hook')!, id: 'foreign', owner: { ...OWNER, principalVersion: 8 } })
    expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: `foreign@4@${digest}` }] })))).toBe('invalid-input')
    const store = readStore(fx.root)
    expect(store.countFollows()).toEqual({ open: 0, closed: 0 })

    // The exact current high water admits, and the old event never closes it.
    const admitted = await admitAndReport(fx, `deploy-hook@4@${digest}`)
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0 })
    expect(store.follows(admitted.item.id)[0]).toMatchObject({ state: 'open' })
  })

  test('restart is idempotent: the same generation re-registers and settles once', async () => {
    const fx = await fixture()
    const admitted = await admitAndReport(fx, refFor(fx.state, 'deploy-hook'))
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
      expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: refFor(fx.state, 'deploy-hook') }] })))).toBe('invalid-input')
      // Hosts may still register their own source under that name.
      const dispose = fx.service.registerThreadSource({ source: 'event-triggers', generation: 'host', resolve: () => undefined })
      dispose()
      expect(fx.state.reads).toBe(0)
    }
  })

  test('without the Event Triggers service the source stays unregistered', async () => {
    const fx = await fixture({ eventTriggers: false })
    expect(errorCode(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: refFor(fx.state, 'deploy-hook') }] })))).toBe('invalid-input')
  })
})

describe('event-triggers follow @head alias', () => {
  test('an event between the caller\'s snapshot read and admission no longer fails @head', async () => {
    const fx = await fixture({ acceptHeadRef: true })
    // The caller reads the high water, then unrelated traffic lands first.
    const seen = refFor(fx.state, 'deploy-hook')
    const early = arrive(fx.state, 'other', 'evt-between')
    expect(errorCode(() => fx.service.admit(signal({ externalId: 'explicit', follows: [{ kind: 'event-triggers', ref: seen }] })))).toBe('invalid-input')
    const admitted = await admitAndReport(fx, 'deploy-hook@head')
    const follow = readStore(fx.root).follows(admitted.item.id)[0]!
    // Pinned to the admission-time high water, never the alias.
    expect(follow.ref).toBe(`deploy-hook@${early.sequence}@${hex('config-1')}`)
    expect(parseEventFollowRef(follow.ref)?.afterSequence).toBe(fx.state.sequence)
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0 })
    const event = arrive(fx.state, 'deploy-hook', 'evt-1')
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 0, closedByThread: 1 })
    expect(readStore(fx.root).follows(admitted.item.id)[0]).toMatchObject({ state: 'closed', digest: externalEventDigest(event.envelope) })
  })

  test('an event on the followed trigger before admission does not close an @head follow', async () => {
    const fx = await fixture({ acceptHeadRef: true })
    arrive(fx.state, 'deploy-hook', 'evt-before')
    const admitted = await admitAndReport(fx, 'deploy-hook@head')
    expect(readStore(fx.root).follows(admitted.item.id)[0]!.ref).toBe(refFor(fx.state, 'deploy-hook'))
    expect(fx.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0 })
  })

  test('unknown, foreign, disabled or malformed @head refs fail exactly like three-part refs', async () => {
    const fx = await fixture({ acceptHeadRef: true })
    fx.state.triggers.set('foreign', { ...fx.state.triggers.get('deploy-hook')!, id: 'foreign', owner: { ...OWNER, principalVersion: 8 } })
    fx.state.triggers.set('off', { ...fx.state.triggers.get('deploy-hook')!, id: 'off', enabled: false })
    for (const ref of ['missing@head', 'foreign@head', 'off@head', 'Deploy-Hook@head', 'deploy-hook@HEAD', 'deploy-hook@head@head', '@head']) {
      const admit = () => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref }] }))
      expect(errorCode(admit)).toBe('invalid-input')
      expect(admit).toThrow(/not admissible for source event-triggers/)
    }
    // A stale or forged explicit ref is still refused with the alias enabled.
    const before = fx.state.sequence
    arrive(fx.state, 'deploy-hook', 'evt-old')
    for (const ref of [refFor(fx.state, 'deploy-hook', before), refFor(fx.state, 'deploy-hook', fx.state.sequence + 1), refFor(fx.state, 'deploy-hook', fx.state.sequence, hex('stale'))]) {
      expect(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref }] }))).toThrow(/not admissible for source event-triggers/)
    }
    expect(readStore(fx.root).countFollows()).toEqual({ open: 0, closed: 0 })
    // The exact current explicit ref still admits unchanged.
    const explicit = fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: refFor(fx.state, 'deploy-hook') }] }))
    expect(readStore(fx.root).follows(explicit.item.id)[0]!.ref).toBe(refFor(fx.state, 'deploy-hook'))
  })

  test('replaying an @head admission returns the same item and canonical ref', async () => {
    const fx = await fixture({ acceptHeadRef: true })
    const input = signal({ follows: [{ kind: 'event-triggers', ref: 'deploy-hook@head' }] })
    const first = fx.service.admit(input)
    const canonicalRef = readStore(fx.root).follows(first.item.id)[0]!.ref
    expect(canonicalRef).toBe(refFor(fx.state, 'deploy-hook'))
    arrive(fx.state, 'deploy-hook', 'evt-1')
    const retry = fx.service.admit(input)
    expect(retry).toMatchObject({ created: false, reason: 'duplicate' })
    expect(retry.item.id).toBe(first.item.id)
    expect(readStore(fx.root).follows(first.item.id).map(follow => follow.ref)).toEqual([canonicalRef])
    expect(readStore(fx.root).countFollows()).toEqual({ open: 1, closed: 0 })
  })

  test('@head and its explicit canonical ref collapse into one follow', async () => {
    const fx = await fixture({ acceptHeadRef: true })
    const admitted = fx.service.admit(signal({ follows: [
      { kind: 'event-triggers', ref: 'deploy-hook@head' }, { kind: 'event-triggers', ref: refFor(fx.state, 'deploy-hook') },
      { kind: 'event-triggers', ref: 'other@head' },
    ] }))
    expect(readStore(fx.root).follows(admitted.item.id).map(follow => follow.ref)).toEqual([refFor(fx.state, 'deploy-hook'), refFor(fx.state, 'other')])
  })

  test('flag off rejects @head as an invalid ref', async () => {
    for (const acceptHeadRef of [undefined, false]) {
      const fx = await fixture(acceptHeadRef === undefined ? {} : { acceptHeadRef })
      expect(() => fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: 'deploy-hook@head' }] }))).toThrow(/not admissible for source event-triggers/)
      expect(readStore(fx.root).countFollows()).toEqual({ open: 0, closed: 0 })
      // The canonical three-part ref is unaffected.
      expect(fx.service.admit(signal({ follows: [{ kind: 'event-triggers', ref: refFor(fx.state, 'deploy-hook') }] })).created).toBe(true)
    }
  })

  test('canonicalize is an optional registration key and must be a function', async () => {
    const fx = await fixture({ follows: false })
    expect(errorCode(() => fx.service.registerThreadSource({ source: 'ticket', generation: 'g', resolve: () => undefined, canonicalize: 1 } as never))).toBe('invalid-input')
    const dispose = fx.service.registerThreadSource({ source: 'ticket', generation: 'g', resolve: () => undefined,
      canonicalize: ref => ref === 'latest' ? 'T-9' : ref === 'boom' ? (() => { throw new Error('boom') })() : ref === 'none' ? undefined : ref,
      validate: ref => ref.startsWith('T-') })
    const admitted = fx.service.admit(signal({ follows: [{ kind: 'ticket', ref: 'latest' }] }))
    expect(readStore(fx.root).follows(admitted.item.id).map(follow => follow.ref)).toEqual(['T-9'])
    for (const ref of ['boom', 'none', 'X-1']) {
      expect(errorCode(() => fx.service.admit(signal({ externalId: `ext-${ref}`, follows: [{ kind: 'ticket', ref }] })))).toBe('invalid-input')
    }
    dispose()
  })
})

describe('event-triggers follow config and helpers', () => {
  test('validates follows config and requires an enabled scoped intake', () => {
    const root = '/tmp/work-items-event-follow-config'
    expect(normalizeConfig(config(root, true)).follows).toEqual({ eventTriggers: true })
    expect(normalizeConfig(config(root, false)).follows).toBeUndefined()
    expect(normalizeConfig(config(root, true, false)).follows).toEqual({ eventTriggers: true })
    expect(normalizeConfig(config(root, true, true)).follows).toEqual({ eventTriggers: true, eventTriggersAcceptHeadRef: true })
    expect(normalizeConfig(config(root, false, true)).follows).toBeUndefined()
    const bad = (follows: unknown, overrides: Partial<Config> = {}) => errorCode(() => normalizeConfig({ ...config(root, undefined), ...overrides, follows } as Config))
    expect(bad({ eventTriggers: { enabled: 'yes' } })).toBe('invalid-input')
    expect(bad({ eventTriggers: { enabled: true, acceptHeadRef: 'yes' } })).toBe('invalid-input')
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
    const digest = hex('config-1')
    expect(parseEventFollowRef(`deploy-hook@12@${digest}`)).toEqual({ triggerId: 'deploy-hook', afterSequence: 12, configDigest: digest })
    for (const ref of ['deploy-hook@12', `deploy-hook@@${digest}`, `@1@${digest}`, `deploy-hook@-1@${digest}`, `deploy-hook@1.5@${digest}`,
      `deploy-hook@99999999999999999@${digest}`, `deploy-hook@1@${digest.toUpperCase()}`, `deploy-hook@1@${digest.slice(1)}`, `a@1@2@${digest}`]) {
      expect(parseEventFollowRef(ref)).toBeUndefined()
    }
  })

  test('the generation depends on the owner identity only', () => {
    const base = eventFollowGeneration(OWNER)
    expect(base).toMatch(/^event-triggers\/v1\/[a-f0-9]{64}$/)
    expect(eventFollowGeneration({ ...OWNER })).toBe(base)
    for (const change of [{ principalRecordId: 'principal-2' }, { principalVersion: 8 }, { workspace: '/work/beta' }, { preset: 'other' }]) {
      expect(eventFollowGeneration({ ...OWNER, ...change })).not.toBe(base)
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
