import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { chmodSync, mkdtempSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { type Config } from '../src/config.ts'
import { WorkItemEvaluationExporter, workItemEvaluationClaims } from '../src/evaluation.ts'
import { settleOutcomes, type SettlementOptions, type ThreadResolution } from '../src/settlement.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import { type WorkItemSignalCandidate, type WorkItemSignalSource, WorkItemSignalIntake } from '../src/signals.ts'
import { WorkItemStore } from '../src/store.ts'
import type { PeerDeliveryService, PeerPolicyService } from '../src/peers.ts'
import type {
  WorkItemAdmitInput,
  WorkItemFollowRecord,
  WorkItemThreadClosure,
} from '../src/types.ts'
import { WorkItemError } from '../src/types.ts'
import {
  AUTHORITY_HASH,
  admitted,
  BASELINE_SEQUENCE,
  claim,
  deliveryPeer,
  harness,
  type Harness,
  INBOX,
  PRINCIPAL,
  PRESET,
  report,
  ROUTE,
  signal,
  WORKER,
  WORKSPACE,
} from './fixtures.ts'

const roots: string[] = []
const closers: Array<() => void> = []
const contexts: Context[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) close()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const TICKET = (kind: string) => kind === 'ticket'
  ? { source: 'ticket-board', generation: 'gen-1' }
  : kind === 'pull-request'
    ? { source: 'pull-request-board', generation: 'gen-1' }
    : undefined

function followed(overrides: Partial<WorkItemAdmitInput> = {}): WorkItemAdmitInput {
  return signal({
    follows: [
      { kind: 'ticket', ref: 'TICKET-1' },
      { kind: 'pull-request', ref: 'PR-7' },
    ],
    ...overrides,
  })
}

/** A synchronous, read-only resolution port over host-shaped closures. */
function threads(open: (follow: WorkItemFollowRecord) => boolean = () => false) {
  const closures = new Map<string, WorkItemThreadClosure>()
  const calls: WorkItemFollowRecord[] = []
  return {
    closures,
    calls,
    set(ref: string, closure: WorkItemThreadClosure): void { closures.set(ref, closure) },
    open(ref: string): void { closures.delete(ref) },
    port(follow: WorkItemFollowRecord): ThreadResolution {
      calls.push(follow)
      if (open(follow)) return { kind: 'open' }
      const closure = closures.get(follow.ref)
      if (closure === undefined) return { kind: 'open' }
      if (closure.state === 'open') return { kind: 'open' }
      return { kind: 'closed', outcome: closure.outcome, digest: closure.digest }
    },
  }
}

function closedOutcome(outcome: WorkItemThreadClosure['outcome'] = 'succeeded'): WorkItemThreadClosure {
  return { state: 'closed', outcome, digest: `sha256:${outcome}` }
}

function options(fixture: Harness, overrides: Partial<SettlementOptions> = {}): SettlementOptions {
  return {
    store: fixture.store,
    delivery: deliveryPeer(),
    scope: { ownerRouteId: ROUTE, principalId: PRINCIPAL, workspace: WORKSPACE, preset: PRESET },
    sweepIntervalMs: 600_000,
    maxSourcesPerSweep: 25,
    maxPendingPerSweep: 10,
    maxSettlementsPerSweep: 10,
    now: fixture.now,
    ...overrides,
  }
}

async function deferItem(fixture: Harness, itemId: string): Promise<WorkItemFollowRecord[]> {
  claim(fixture, itemId)
  report(fixture, itemId, 'ready')
  const follows = fixture.store.follows(itemId)
  expect(follows).toHaveLength(2)
  return [...follows]
}

function errorCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(WorkItemError)
    return (error as WorkItemError).code
  }
  throw new Error('expected the call to fail')
}

describe('followed-thread intake', () => {
  test('persists deduped follows with the source generation resolved at admission', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const admitted = fixture.admission.admit(followed())
    expect(admitted.created).toBe(true)

    const follows = fixture.store.follows(admitted.item.id)
    expect(follows).toHaveLength(2)
    expect(follows.map(follow => follow.position)).toEqual([0, 1])
    expect(follows.map(follow => follow.ref)).toEqual(['TICKET-1', 'PR-7'])
    expect(follows.map(follow => ({ source: follow.source, generation: follow.sourceGeneration, state: follow.state })))
      .toEqual([
        { source: 'ticket-board', generation: 'gen-1', state: 'open' },
        { source: 'pull-request-board', generation: 'gen-1', state: 'open' },
      ])
    expect(fixture.store.countOpenFollows(admitted.item.id)).toBe(2)
    expect(fixture.store.countFollows()).toEqual({ open: 2, closed: 0 })
    expect(fixture.store.openFollowIdentities()).toHaveLength(2)
    expect(fixture.store.openFollowIdentities()).toEqual(expect.arrayContaining([
      { source: 'ticket-board', sourceGeneration: 'gen-1' },
      { source: 'pull-request-board', sourceGeneration: 'gen-1' },
    ]))
  })

  test('rejects a forged follow whose kind has no host-registered source', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    expect(fixture.admission.admit(signal({ follows: [{ kind: 'ticket', ref: 'TICKET-1' }] })).created).toBe(true)
    expect(errorCode(() => fixture.admission.admit(followed({ follows: [{ kind: 'incident', ref: 'INC-1' }] }))))
      .toBe('invalid-input')
    expect(fixture.store.stats().items).toBe(1)
  })

  test('rejects malformed and oversized follow input', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const cases: unknown[] = [
      'ticket',
      [null],
      [{ kind: 'ticket' }],
      [{ kind: 'ticket', ref: '' }],
      [{ kind: 'ticket', ref: 'bad\nref' }],
      [{ kind: 'ticket', ref: 'x'.repeat(1025) }],
      [{ kind: 'ticket', ref: 'TICKET-1', extra: true }],
      Array.from({ length: 9 }, (_, index) => ({ kind: 'ticket', ref: `TICKET-${String(index)}` })),
    ]
    for (const follows of cases) {
      expect(errorCode(() => fixture.admission.admit(signal({ follows: follows as never })))).toBe('invalid-input')
    }
    expect(fixture.store.stats().items).toBe(0)
  })

  test('collapses duplicate follow refs instead of admitting a shadow bound', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const result = fixture.admission.admit(signal({
      follows: [
        { kind: 'ticket', ref: 'TICKET-1' },
        { kind: 'ticket', ref: 'TICKET-1' },
        { kind: 'pull-request', ref: 'PR-7' },
      ],
    }))
    expect(result.created).toBe(true)
    expect(fixture.store.follows(result.item.id).map(follow => [follow.kind, follow.ref]))
      .toEqual([['ticket', 'TICKET-1'], ['pull-request', 'PR-7']])
    expect(fixture.store.follows(result.item.id).map(follow => follow.position)).toEqual([0, 1])
  })

  test('carries follows from an automation signal candidate into admission', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const candidate: WorkItemSignalCandidate = {
      kind: 'review',
      externalId: 'ext-signal-1',
      title: 'Repair the failed execution',
      brief: 'Inspect and repair what the owner reported.',
      originBindingId: 'binding-origin-1',
      disposition: 'failure',
      occurredAt: fixture.now(),
      provenance: {
        source: 'owner-foreground-failures',
        sourceVersion: 'assistant-work-items/owner-foreground-failures/v1',
        signalDigest: 'sha256:signal',
        observedAt: fixture.now(),
        evidence: { inboxId: INBOX, executionStatus: 'failed', completionSequence: BASELINE_SEQUENCE, authorityHash: AUTHORITY_HASH },
      },
      follows: [{ kind: 'ticket', ref: 'TICKET-9' }],
    }
    let pages = 0
    const source: WorkItemSignalSource = {
      id: 'owner-foreground-failures',
      sourceVersion: 'v1',
      sweep: () => {
        pages += 1
        return pages === 1 ? { candidates: [candidate], cursor: 'next' } : { candidates: [], cursor: null }
      },
    }
    const intake = new WorkItemSignalIntake({
      config: fixture.config,
      store: fixture.store,
      admission: fixture.admission,
      now: fixture.now,
      sources: [source],
    })
    const sweep = intake.sweep(true)
    expect(sweep.sources[0]?.admitted).toBe(1)
    const item = fixture.store.listItems({ limit: 10 })[0]
    expect(item).toBeDefined()
    expect(fixture.store.follows(item!.id).map(follow => follow.ref)).toEqual(['TICKET-9'])
  })
})

describe('terminal reports while a followed thread is open', () => {
  test('parks the item in waiting with no outcome row and keeps it claimable', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const item = await admitted(fixture, followed())
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')

    const parked = fixture.store.findItemById(item.id)
    expect(parked).toMatchObject({ state: 'waiting', stateReason: 'following-thread', lastReportStatus: 'ready' })
    expect(parked?.observed).toBe(false)
    expect(fixture.store.latestOutcome(item.id)).toBeUndefined()
    expect(fixture.store.reports(item.id)).toHaveLength(1)

    // A waiting item is claimable: a resumed occurrence may keep working while
    // the followed thread stays open, and the deferral must survive that claim.
    const resumed = claim(fixture, item.id, 'occ-resume-1')
    expect(resumed.item.state).toBe('claimed')
    expect(fixture.store.latestOutcome(item.id)).toBeUndefined()
    expect(fixture.store.follows(item.id).every(follow => follow.state === 'open')).toBe(true)
  })

  test('does not settle a closure observed before the terminal report', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const item = await admitted(fixture, followed())
    const port = threads()
    port.set('TICKET-1', closedOutcome())
    port.set('PR-7', closedOutcome('failed'))

    // Nothing to settle yet: the item has no terminal report.
    const early = settleOutcomes(options(fixture, { threads: port.port }), true)
    expect(early.report).toMatchObject({ settled: 0, closedByThread: 0 })

    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    expect(fixture.store.findItemById(item.id)?.state).toBe('waiting')
    expect(fixture.store.latestOutcome(item.id)).toBeUndefined()
    expect(port.calls).toHaveLength(0)
  })

  test('leaves the ordinary settlement path untouched when nothing is followed', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const item = await admitted(fixture)
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    expect(fixture.store.findItemById(item.id)?.state).toBe('ready')
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'pending', settledBy: 'report-ready' })
  })
})

describe('settlement bounded by followed-thread closure', () => {
  test('an open follow keeps the item waiting across passes and never settles it', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const item = await admitted(fixture, followed())
    await deferItem(fixture, item.id)
    const port = threads(() => true)

    for (let pass = 0; pass < 2; pass += 1) {
      const result = settleOutcomes(options(fixture, { threads: port.port }), true)
      expect(result.report).toMatchObject({ deferred: 1, closedByThread: 0, settled: 0, expired: 0 })
    }
    expect(fixture.store.findItemById(item.id)?.state).toBe('waiting')
    expect(fixture.store.latestOutcome(item.id)).toBeUndefined()
    expect(fixture.store.countOpenFollows(item.id)).toBe(2)
  })

  test('settles exactly once when every follow closed, with closure evidence', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const item = await admitted(fixture, followed())
    const follows = await deferItem(fixture, item.id)
    const port = threads()
    port.set('TICKET-1', closedOutcome())
    port.set('PR-7', closedOutcome())

    const result = settleOutcomes(options(fixture, { threads: port.port }), true)
    expect(result.report).toMatchObject({ deferred: 0, closedByThread: 1, settled: 0, followDegraded: null })

    const outcome = fixture.store.latestOutcome(item.id)
    expect(outcome).toMatchObject({
      revision: 1,
      settledBy: 'closed-by-thread',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      evidenceState: 'unverified',
      evidenceReason: 'closed-by-thread',
      evidence: null,
      deadlineAt: null,
    })
    expect(fixture.store.findItemById(item.id)).toMatchObject({ state: 'ready', observed: false })

    // The closure records the source digest on the follow row, not on the
    // outcome ledger, and it never upgrades objective achievement.
    const stored = fixture.store.follows(item.id)
    expect(stored.map(follow => ({ state: follow.state, digest: follow.digest })))
      .toEqual([
        { state: 'closed', digest: 'sha256:succeeded' },
        { state: 'closed', digest: 'sha256:succeeded' },
      ])
    expect(stored.every(follow => follow.closedAt !== null)).toBe(true)
    expect(follows).toHaveLength(stored.length)

    // A further pass cannot double-settle and never re-resolves closed follows.
    const again = settleOutcomes(options(fixture, { threads: port.port }), true)
    expect(again.report).toMatchObject({ deferred: 0, closedByThread: 0 })
    expect(fixture.store.listOutcomes({ limit: 10 })).toHaveLength(1)
  })

  test('duplicate and out-of-order closures produce exactly one revision', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const item = await admitted(fixture, followed())
    await deferItem(fixture, item.id)
    const [first] = fixture.store.follows(item.id)
    expect(first).toBeDefined()

    const once = fixture.store.closeFollow(item.id, first!.position, closedOutcome('succeeded'), fixture.now())
    expect(once).toMatchObject({ state: 'closed', outcome: 'succeeded' })
    const duplicate = fixture.store.closeFollow(item.id, first!.position, closedOutcome('failed'), fixture.now())
    expect(duplicate).toBeUndefined()
    expect(fixture.store.follows(item.id)[0]).toMatchObject({ outcome: 'succeeded', digest: 'sha256:succeeded' })
    // One follow closed, one still open: the forced pass must not settle early.
    const early = settleOutcomes(options(fixture, { threads: () => ({ kind: 'open' }) }), true)
    expect(early.report).toMatchObject({ deferred: 1, closedByThread: 0 })
    expect(fixture.store.latestOutcome(item.id)).toBeUndefined()

    fixture.store.closeFollow(item.id, first!.position + 1, closedOutcome('cancelled'), fixture.now())
    const settled = settleOutcomes(options(fixture, { threads: () => ({ kind: 'open' }) }), true)
    expect(settled.report).toMatchObject({ deferred: 0, closedByThread: 1 })
    expect(fixture.store.listOutcomes({ limit: 10 })).toHaveLength(1)

    const late = settleOutcomes(options(fixture, {
      threads: () => ({ kind: 'closed', outcome: 'failed', digest: 'sha256:late' }),
    }), true)
    expect(late.report).toMatchObject({ deferred: 0, closedByThread: 0 })
    expect(fixture.store.follows(item.id).map(follow => follow.outcome)).toEqual(['succeeded', 'cancelled'])
  })

  test('honours the configured settlement budget across deferred items', async () => {
    const fixture = await harness({ settlement: { maxSettlementsPerSweep: 1 } }, { threadSource: TICKET })
    const first = await admitted(fixture, followed({ externalId: 'ext-a' }))
    const second = await admitted(fixture, followed({ externalId: 'ext-b' }))
    await deferItem(fixture, first.id)
    await deferItem(fixture, second.id)
    const port = threads()
    for (const follow of [...fixture.store.follows(first.id), ...fixture.store.follows(second.id)]) {
      port.set(follow.ref, closedOutcome())
    }

    const one = settleOutcomes(options(fixture, { threads: port.port, maxSettlementsPerSweep: 1 }), true)
    expect(one.report.closedByThread).toBe(1)
    expect(fixture.store.listOutcomes({ limit: 10 })).toHaveLength(1)

    const two = settleOutcomes(options(fixture, { threads: port.port, maxSettlementsPerSweep: 1 }), true)
    expect(two.report.closedByThread).toBe(1)
    expect(fixture.store.listOutcomes({ limit: 10 })).toHaveLength(2)
    expect(fixture.store.findItemById(first.id)?.observed).toBe(false)
    expect(fixture.store.findItemById(second.id)?.observed).toBe(false)
  })

  test('keeps the item waiting and reports degradation when the source cannot resolve', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const item = await admitted(fixture, followed())
    await deferItem(fixture, item.id)
    const warn: string[] = []

    const missing = settleOutcomes(options(fixture, {
      threads: () => ({ kind: 'unresolved', reason: 'source-missing' }),
      warn: message => warn.push(message),
    }), true)
    expect(missing.report).toMatchObject({ deferred: 1, closedByThread: 0, followDegraded: 'source-missing' })
    expect(fixture.store.findItemById(item.id)?.state).toBe('waiting')
    expect(fixture.store.latestOutcome(item.id)).toBeUndefined()

    const throwing = settleOutcomes(options(fixture, {
      threads: () => { throw new Error('resolver exploded') },
      warn: message => warn.push(message),
    }), true)
    expect(throwing.report).toMatchObject({ deferred: 1, followDegraded: 'resolver-failed' })
    expect(warn.length).toBeGreaterThanOrEqual(1)
    expect(fixture.store.findItemById(item.id)?.state).toBe('waiting')
    expect(fixture.store.latestOutcome(item.id)).toBeUndefined()
  })

  test('does not settle on a timer: only an explicit sweep observes the closure', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const item = await admitted(fixture, followed())
    await deferItem(fixture, item.id)
    const port = threads()
    port.set('TICKET-1', closedOutcome())
    port.set('PR-7', closedOutcome())

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fixture.store.latestOutcome(item.id)).toBeUndefined()
    expect(fixture.store.findItemById(item.id)?.state).toBe('waiting')

    const explicit = settleOutcomes(options(fixture, { threads: port.port }), true)
    expect(explicit.report.closedByThread).toBe(1)
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ settledBy: 'closed-by-thread' })
  })
})

// ---------------------------------------------------------------------------
// Service-level host seams: registration lifecycle, generation fencing, health.
// ---------------------------------------------------------------------------

function fakePolicy(): PeerPolicyService {
  return { authorize: () => ({ effect: 'allow', reasonCode: 'rule-allow' }) }
}

function fakeDelivery(): PeerDeliveryService {
  return deliveryPeer()
}

class FakeToolsPeer extends Service {
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(): void {}
}

/** Deterministic occurrence identity; matches the worker agent id below. */
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

interface ServiceHarness {
  readonly root: string
  readonly service: AssistantWorkItemsService
  readonly now: () => number
}

function serviceConfig(root: string): Config {
  return {
    enabled: true,
    mode: 'active',
    databasePath: join(root, 'state', 'state.sqlite'),
    workRoot: join(root, 'work'),
    intakeSourceId: 'work-items/v1',
    workerAutomationId: WORKER,
    scope: {
      workspace: WORKSPACE,
      preset: PRESET,
      principalId: PRINCIPAL,
      ownerRouteId: ROUTE,
      expiresAt: Date.now() + 3_600_000,
    },
    admission: {
      allowedKinds: ['review', 'triage'],
      maxOpenItems: 8,
      maxAdmitsPerHour: 16,
      dedupWindowMs: 3_600_000,
      cooldownMs: 0,
      maxBriefBytes: 512,
    },
  }
}

function openService(root: string): AssistantWorkItemsService {
  const ctx = new Context()
  ctx.provide('assistantPolicy' as never, fakePolicy() as never)
  ctx.provide('assistantDelivery' as never, fakeDelivery() as never)
  new FakeToolsPeer(ctx)
  new FakeAutomationsPeer(ctx)
  const service = new AssistantWorkItemsService(ctx, serviceConfig(root))
  closers.push(() => service.close())
  return service
}

async function serviceHarness(): Promise<ServiceHarness> {
  const root = await mkdtemp(join(tmpdir(), 'work-items-follows-service-'))
  roots.push(root)
  return { root, service: openService(root), now: () => Date.now() }
}

/** Read the durable item through a second connection while the service owns its own. */
function readStore(harness: ServiceHarness): WorkItemStore {
  const store = new WorkItemStore(join(harness.root, 'state', 'state.sqlite'))
  closers.push(() => store.close())
  return store
}

describe('thread source registration', () => {
  test('refuses malformed and duplicate registrations, and a disposer frees the source', async () => {
    const fixture = await serviceHarness()
    const service = fixture.service
    const registration = { source: 'ticket', generation: 'gen-1', resolve: () => undefined }

    expect(errorCode(() => service.registerThreadSource('ticket-board' as never))).toBe('invalid-input')
    expect(errorCode(() => service.registerThreadSource([] as never))).toBe('invalid-input')
    expect(errorCode(() => service.registerThreadSource({ ...registration, source: 'Ticket_Board' }))).toBe('invalid-input')
    expect(errorCode(() => service.registerThreadSource({ ...registration, generation: '' } as never))).toBe('invalid-input')
    expect(errorCode(() => service.registerThreadSource({ source: 'ticket', generation: 'gen-1' } as never))).toBe('invalid-input')
    expect(errorCode(() => service.registerThreadSource({ ...registration, extra: true } as never))).toBe('invalid-input')

    const dispose = service.registerThreadSource(registration)
    expect(typeof dispose).toBe('function')
    expect(errorCode(() => service.registerThreadSource({ ...registration, generation: 'gen-2' }))).toBe('invalid-input')
    dispose()
    const replacement = service.registerThreadSource({ ...registration, generation: 'gen-2' })
    expect(typeof replacement).toBe('function')
  })

  test('refuses registration after the service closes', async () => {
    const fixture = await serviceHarness()
    fixture.service.close()
    expect(errorCode(() => fixture.service.registerThreadSource({
      source: 'ticket-board', generation: 'gen-1', resolve: () => undefined,
    }))).toBe('disabled')
  })

  test('a stale registration generation is unresolved, never closed', async () => {
    const fixture = await serviceHarness()
    fixture.service.registerThreadSource({ source: 'ticket', generation: 'gen-1', resolve: () => closedOutcome() })
    fixture.service.registerThreadSource({ source: 'pull-request', generation: 'gen-1', resolve: () => closedOutcome() })
    const admitted = fixture.service.admit(followed())
    fixture.service.claim(workerAgent('occ-1'))
    await fixture.service.report(workerAgent('occ-1'), { status: 'ready', summary: 'done', idempotencyKey: 'idem-1' })

    // The host re-registered its source with a new generation after admission.
    fixture.service.close()
    const reopened = openService(fixture.root)
    reopened.registerThreadSource({ source: 'ticket', generation: 'gen-2', resolve: () => closedOutcome() })
    reopened.registerThreadSource({ source: 'pull-request', generation: 'gen-2', resolve: () => closedOutcome() })

    const result = reopened.settleOutcomes(true)
    expect(result).toMatchObject({ deferred: 1, closedByThread: 0, followDegraded: 'generation-mismatch' })
    const store = readStore(fixture)
    expect(store.findItemById(admitted.item.id)?.state).toBe('waiting')
    expect(store.latestOutcome(admitted.item.id)).toBeUndefined()
    expect(reopened.health().follows).toMatchObject({ open: 2, closed: 0, unresolved: 2, degraded: 'generation-mismatch' })
  })

  test('a missing registration after admission degrades the follow without closing it', async () => {
    const fixture = await serviceHarness()
    const dispose = fixture.service.registerThreadSource({
      source: 'ticket', generation: 'gen-1', resolve: () => closedOutcome(),
    })
    const disposePull = fixture.service.registerThreadSource({
      source: 'pull-request', generation: 'gen-1', resolve: () => closedOutcome(),
    })
    const admitted = fixture.service.admit(followed())
    fixture.service.claim(workerAgent('occ-1'))
    await fixture.service.report(workerAgent('occ-1'), { status: 'ready', summary: 'done', idempotencyKey: 'idem-1' })
    dispose()
    disposePull()

    const result = fixture.service.settleOutcomes(true)
    expect(result).toMatchObject({ deferred: 1, closedByThread: 0, followDegraded: 'source-missing' })
    const store = readStore(fixture)
    expect(store.findItemById(admitted.item.id)?.state).toBe('waiting')
    expect(store.latestOutcome(admitted.item.id)).toBeUndefined()
    expect(fixture.service.health().follows).toMatchObject({ open: 2, closed: 0, unresolved: 2, degraded: 'source-missing' })
  })

  test('settles through the service once the registered source reports every follow closed', async () => {
    const fixture = await serviceHarness()
    const closures = new Map<string, WorkItemThreadClosure>()
    fixture.service.registerThreadSource({
      source: 'ticket',
      generation: 'gen-1',
      resolve: ref => closures.get(ref),
    })
    fixture.service.registerThreadSource({
      source: 'pull-request',
      generation: 'gen-1',
      resolve: ref => closures.get(ref),
    })
    const admitted = fixture.service.admit(followed())
    fixture.service.claim(workerAgent('occ-1'))
    await fixture.service.report(workerAgent('occ-1'), { status: 'ready', summary: 'done', idempotencyKey: 'idem-1' })

    // No closure yet: an explicit sweep must park the item honestly.
    expect(fixture.service.settleOutcomes(true)).toMatchObject({ deferred: 1, closedByThread: 0 })
    closures.set('TICKET-1', closedOutcome())
    closures.set('PR-7', closedOutcome())
    expect(fixture.service.settleOutcomes(true)).toMatchObject({ deferred: 0, closedByThread: 1 })

    const store = readStore(fixture)
    expect(store.latestOutcome(admitted.item.id)).toMatchObject({
      settledBy: 'closed-by-thread',
      objectiveStatus: 'unknown',
      evidenceState: 'unverified',
    })
    expect(store.findItemById(admitted.item.id)?.state).toBe('ready')
    expect(fixture.service.health().follows).toMatchObject({ open: 0, closed: 2, unresolved: 0, degraded: null })
  })

  test('never settles a deferred item underneath a worker that re-claimed it', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const item = await admitted(fixture, followed())
    await deferItem(fixture, item.id)
    const port = threads(() => true)

    // The parked item is claimable, so a second worker may pick it up. Closing the
    // threads now must not retire the item under that running worker's lease.
    fixture.ledger.claim({ itemId: item.id, runId: 'occ-2', occurrenceId: 'occ-2' })
    port.set('TICKET-1', closedOutcome())
    port.set('PR-7', closedOutcome())
    const result = settleOutcomes(options(fixture, { threads: port.port }), true)
    expect(result.report).toMatchObject({ deferred: 0, closedByThread: 0 })

    expect(fixture.store.findItemById(item.id)?.state).toBe('claimed')
    expect(fixture.store.latestOutcome(item.id)).toBeUndefined()
    expect(fixture.store.itemsAwaitingThreadClosure(10)).toHaveLength(0)
  })
})

describe('follow health', () => {
  test('reports bounded counts without exposing refs or digests', async () => {
    const fixture = await serviceHarness()
    expect(fixture.service.health().follows).toEqual({ open: 0, closed: 0, unresolved: 0, degraded: null })
    const dispose = fixture.service.registerThreadSource({
      source: 'ticket', generation: 'gen-1', resolve: () => closedOutcome(),
    })
    const admitted = fixture.service.admit(signal({ follows: [{ kind: 'ticket', ref: 'TICKET-1' }] }))
    expect(fixture.service.health().follows).toEqual({ open: 1, closed: 0, unresolved: 0, degraded: null })
    expect(JSON.stringify(fixture.service.health().follows)).not.toContain('TICKET-1')
    dispose()
    expect(fixture.service.health().follows).toEqual({ open: 1, closed: 0, unresolved: 1, degraded: 'source-missing' })
    const store = readStore(fixture)
    expect(store.follows(admitted.item.id)[0]?.ref).toBe('TICKET-1')
  })

  test('stops counting follows of an item that was withdrawn', async () => {
    const fixture = await serviceHarness()
    const dispose = fixture.service.registerThreadSource({
      source: 'ticket', generation: 'gen-1', resolve: () => undefined,
    })
    const admitted = fixture.service.admit(signal({ follows: [{ kind: 'ticket', ref: 'TICKET-1' }] }))
    expect(fixture.service.health().follows).toEqual({ open: 1, closed: 0, unresolved: 0, degraded: null })

    // Withdrawal retires the item; its follow row can never close, so it must not
    // surface as a live gap after the source registration is also removed.
    const store = readStore(fixture)
    expect(store.withdrawByDedupKey(admitted.item.dedupKey).outcome).toBe('withdrawn')
    dispose()
    expect(store.countFollows()).toEqual({ open: 0, closed: 0 })
    expect(store.listOpenFollows(10)).toHaveLength(0)
    expect(fixture.service.health().follows).toEqual({ open: 0, closed: 0, unresolved: 0, degraded: null })
  })
})

// ---------------------------------------------------------------------------
// Schema: pure additive follow table and frozen v5 -> v6 / v6 -> v7 upgrades.
// ---------------------------------------------------------------------------

const LEGACY_DDL = `
CREATE TABLE work_item (
  id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL, dedup_bucket INTEGER NOT NULL,
  source_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
  title TEXT NOT NULL, brief TEXT NOT NULL, brief_truncated INTEGER NOT NULL CHECK(brief_truncated IN (0, 1)),
  origin_binding_id TEXT NOT NULL, acceptance_ref TEXT,
  workspace TEXT NOT NULL, agent_preset TEXT NOT NULL,
  principal_id TEXT NOT NULL, principal_record_id TEXT NOT NULL, principal_version INTEGER NOT NULL,
  binding_version INTEGER NOT NULL, owner_generation INTEGER NOT NULL, owner_route_id TEXT NOT NULL,
  scope_expires_at INTEGER NOT NULL,
  worker_automation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'claimed', 'working', 'waiting', 'ready', 'blocked', 'failed', 'dropped')),
  state_reason TEXT,
  attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
  lease_until INTEGER, lease_run_id TEXT, occurrence_id TEXT,
  work_dir TEXT NOT NULL,
  last_report_status TEXT CHECK(last_report_status IN ('progress', 'waiting', 'ready', 'blocked', 'failed')),
  observed INTEGER NOT NULL CHECK(observed IN (0, 1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(dedup_key, dedup_bucket)
) STRICT;
CREATE TABLE work_item_event (
  item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
  detail TEXT, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, sequence)
) STRICT, WITHOUT ROWID;
CREATE TABLE work_item_report (
  item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('progress', 'waiting', 'ready', 'blocked', 'failed')),
  summary TEXT NOT NULL, truncated INTEGER NOT NULL CHECK(truncated IN (0, 1)),
  artifact_paths TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  delivery_key TEXT NOT NULL UNIQUE,
  delivery_state TEXT CHECK(delivery_state IN ('pending', 'sent', 'failed', 'unknown')),
  delivery_id TEXT, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, revision)
) STRICT;
CREATE TABLE work_item_claim (
  claim_id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'released', 'expired')),
  leased_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX work_item_claim_run_idx ON work_item_claim(run_id);
CREATE TABLE work_item_dispatch (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE RESTRICT,
  automation_id TEXT NOT NULL, event_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'dispatched', 'failed')),
  occurrence_id TEXT, reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  wake_attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(automation_id, event_id)
) STRICT;
CREATE TABLE work_item_outcome (
  item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  settled_by TEXT NOT NULL CHECK(settled_by IN ('report-ready', 'report-blocked', 'report-failed', 'withdrawn', 'retry-exhausted', 'observed-evidence', 'window-expired')),
  execution_status TEXT NOT NULL CHECK(execution_status IN ('succeeded', 'failed', 'timed-out', 'cancelled', 'unknown')),
  objective_status TEXT NOT NULL CHECK(objective_status IN ('achieved', 'partial', 'not-achieved', 'unknown')),
  trust TEXT NOT NULL CHECK(trust IN ('agent-self-report', 'external-receipt', 'deterministic-check')),
  evidence_state TEXT NOT NULL CHECK(evidence_state IN ('pending', 'observed', 'unverified', 'not-applicable')),
  evidence_reason TEXT CHECK(evidence_reason IN ('no-independent-source', 'evidence-too-large', 'window-expired', 'channel-unavailable')),
  evidence TEXT, baseline_sequence INTEGER, inbox_id TEXT, authority_hash TEXT, deadline_at INTEGER,
  settled_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
  evaluation_state TEXT NOT NULL DEFAULT 'pending' CHECK(evaluation_state IN ('pending', 'exported', 'skipped')),
  evaluation_digest TEXT, evaluation_recorded_at INTEGER, evaluation_attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(item_id, revision)
) STRICT, WITHOUT ROWID;
CREATE INDEX work_item_outcome_pending_idx ON work_item_outcome(evidence_state, deadline_at);
CREATE INDEX work_item_outcome_evaluation_idx ON work_item_outcome(evaluation_state, evidence_state);
CREATE TABLE work_item_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
`

/** A literal version 5 database: no follow table, old outcome CHECK lists. */
function v5Database(): { path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'work-items-v5-'))
  chmodSync(root, 0o700)
  const path = join(root, 'v5.sqlite')
  const raw = new DatabaseSync(path)
  chmodSync(path, 0o600)
  raw.exec(LEGACY_DDL)
  raw.exec(`INSERT INTO work_item(id, dedup_key, dedup_bucket, source_id, kind, external_id, title, brief, brief_truncated,
      origin_binding_id, acceptance_ref, workspace, agent_preset, principal_id, principal_record_id, principal_version,
      binding_version, owner_generation, owner_route_id, scope_expires_at, worker_automation_id, state, state_reason,
      attempt, max_attempts, lease_until, lease_run_id, occurrence_id, work_dir, last_report_status, observed,
      created_at, updated_at)
    VALUES ('item-legacy', 'dedup-legacy', 0, 'work-items/v1', 'review', 'ext-legacy', 'Legacy item', 'Legacy brief', 0,
      'binding-origin-1', NULL, '/work/alpha', 'primary', 'owner:me', 'principal-1', 7,
      3, 2, 'route-1', 1700086400000, 'work-items-worker', 'blocked', NULL,
      1, 3, NULL, NULL, NULL, '/work/alpha/item-legacy', 'blocked', 1,
      1700000000000, 1700000000000);
    INSERT INTO work_item_report(item_id, revision, status, summary, truncated, artifact_paths, idempotency_key,
      delivery_key, delivery_state, delivery_id, recorded_at)
    VALUES ('item-legacy', 1, 'blocked', 'Legacy report', 0, '[]', 'legacy-idem', 'legacy-delivery', 'sent', 'outbox-legacy', 1700000000000);
    INSERT INTO work_item_claim(item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at)
    VALUES ('item-legacy', 'run-legacy', 'occ-legacy', 'active', 1700086400000, 1700000000000, 1700000000000);
    INSERT INTO work_item_dispatch(item_id, automation_id, event_id, occurred_at, state, occurrence_id, reason, created_at, updated_at, generation, wake_attempts)
    VALUES ('item-legacy', 'work-items-worker', 'item-legacy', 1700000000000, 'dispatched', 'occ-legacy', NULL, 1700000000000, 1700000000000, 2, 1);
    INSERT INTO work_item_outcome(item_id, revision, settled_by, execution_status, objective_status, trust,
      evidence_state, evidence_reason, evidence, baseline_sequence, inbox_id, authority_hash, deadline_at, settled_at, recorded_at,
      evaluation_state, evaluation_digest, evaluation_recorded_at, evaluation_attempts)
    VALUES ('item-legacy', 2, 'observed-evidence', 'succeeded', 'unknown', 'external-receipt',
      'observed', NULL, NULL, 5, 'inbox-1', 'sha256:authority', NULL, 1700000001000, 1700000001000,
      'exported', 'sha256:exported', 1700000002000, 1);
    INSERT INTO work_item_schema_meta(key, value) VALUES ('schema_version', '5');
    PRAGMA user_version = 5;`)
  raw.close()
  return { path, root }
}

describe('followed-thread persistence across schema upgrades', () => {
  test('creates the follow table in a fresh database and enforces its invariants', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const raw = new DatabaseSync(fixture.config.databasePath)
    try {
      const version = raw.prepare('PRAGMA user_version').get() as Record<string, unknown>
      expect(Number(version['user_version'])).toBe(10)
      const columns = (raw.prepare('PRAGMA table_info(work_item_follow)').all() as Array<Record<string, unknown>>)
        .map(row => String(row['name']))
      expect(columns).toEqual([
        'item_id', 'position', 'kind', 'ref', 'state', 'outcome', 'digest',
        'source', 'source_generation', 'opened_at', 'closed_at',
      ])
      const meta = raw.prepare("SELECT value FROM work_item_schema_meta WHERE key = 'schema_version'").get() as Record<string, unknown>
      expect(meta['value']).toBe('10')
      const index = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'work_item_follow_state_idx'").get()
      expect(index).toBeDefined()
    } finally {
      raw.close()
    }

    const item = await admitted(fixture, followed())
    const [follow] = fixture.store.follows(item.id)
    const rawWrite = new DatabaseSync(fixture.config.databasePath)
    try {
      rawWrite.exec('PRAGMA foreign_keys = OFF;')
      // A closed follow must carry outcome, digest and closed_at together.
      expect(() => rawWrite.exec(`INSERT INTO work_item_follow VALUES
        ('missing-item', 0, 'ticket', 'T-1', 'closed', NULL, NULL, 'src', 'gen', 1, 2)`)).toThrow()
      // An open follow must not carry closure fields.
      expect(() => rawWrite.exec(`INSERT INTO work_item_follow VALUES
        ('missing-item', 1, 'ticket', 'T-2', 'open', 'succeeded', 'sha256:x', 'src', 'gen', 1, 2)`)).toThrow()
      rawWrite.exec(`INSERT INTO work_item_follow VALUES
        ('missing-item', 2, 'ticket', 'T-3', 'closed', 'succeeded', 'sha256:x', 'src', 'gen', 1, 2)`)
    } finally {
      rawWrite.close()
    }
    void follow
  })

  test('migrates a literal version 5 database without rewriting rows', async () => {
    const fixture = v5Database()
    roots.push(fixture.root)
    const store = new WorkItemStore(fixture.path, { now: () => 1_700_000_000_000 })
    closers.push(() => store.close())

    // The pre-existing revision survives verbatim, including its Evaluation
    // projection columns; the old CHECK lists merely widened.
    expect(store.latestOutcome('item-legacy')).toMatchObject({
      revision: 2,
      settledBy: 'observed-evidence',
      evidenceState: 'observed',
      evaluationState: 'exported',
      evaluationDigest: 'sha256:exported',
      evaluationAttempts: 1,
    })
    expect(store.stats().follows).toBe(0)
    expect(store.findItemById('item-legacy')?.state).toBe('blocked')

    // The widened CHECK lists accept the new closure reason on the very same
    // table, and the append-only ledger keeps the earlier revision untouched.
    store.close()
    const write = new DatabaseSync(fixture.path)
    try {
      write.exec(`INSERT INTO work_item_outcome(item_id, revision, settled_by, execution_status, objective_status, trust,
          evidence_state, evidence_reason, evidence, baseline_sequence, inbox_id, authority_hash, deadline_at, settled_at, recorded_at)
        VALUES ('item-legacy', 3, 'closed-by-thread', 'succeeded', 'unknown', 'agent-self-report',
          'unverified', 'closed-by-thread', NULL, NULL, NULL, NULL, NULL, 1700000003000, 1700000003000)`)
    } finally {
      write.close()
    }
    const upgraded = new WorkItemStore(fixture.path, { now: () => 1_700_000_000_000 })
    closers.push(() => upgraded.close())
    expect(upgraded.latestOutcome('item-legacy')).toMatchObject({
      revision: 3,
      settledBy: 'closed-by-thread',
      evidenceState: 'unverified',
      evaluationState: 'pending',
    })
    expect(upgraded.outcomes('item-legacy')).toHaveLength(2)
    upgraded.close()

    const raw = new DatabaseSync(fixture.path)
    try {
      const version = raw.prepare('PRAGMA user_version').get() as Record<string, unknown>
      expect(Number(version['user_version'])).toBe(10)
      const tables = (raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as Array<Record<string, unknown>>)
        .map(row => String(row['name']))
      expect(tables).toEqual([
        'work_item', 'work_item_claim', 'work_item_continuation', 'work_item_dispatch', 'work_item_event',
        'work_item_follow', 'work_item_intake', 'work_item_outcome', 'work_item_report', 'work_item_schema_meta',
      ])
      const indexes = (raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as Array<Record<string, unknown>>)
        .map(row => String(row['name']))
      expect(indexes).toEqual([
        'work_item_claim_active_item_idx',
        'work_item_claim_run_idx',
        'work_item_dispatch_waiting_due_idx',
        'work_item_follow_state_idx',
        'work_item_intake_content_idx',
        'work_item_outcome_evaluation_idx',
        'work_item_outcome_pending_idx',
      ])
    } finally {
      raw.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Trusted Evaluation export: a closure-settled revision still exports.
// ---------------------------------------------------------------------------

async function settleCordis(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('closure settlement on the trusted Evaluation lane', () => {
  test('exports a closure-settled revision as trusted and objective-neutral', async () => {
    const fixture = await harness({}, { threadSource: TICKET })
    const item = await admitted(fixture, followed())
    await deferItem(fixture, item.id)
    const port = threads()
    port.set('TICKET-1', closedOutcome())
    port.set('PR-7', closedOutcome('failed'))
    const settled = settleOutcomes(options(fixture, { threads: port.port }), true)
    expect(settled.report.closedByThread).toBe(1)

    // Protocol v1 carries the precise reason: the export lane must not alias a
    // thread closure to a window expiry, because the two are different facts.
    const outcome = fixture.store.latestOutcome(item.id)
    expect(outcome).toBeDefined()
    expect(workItemEvaluationClaims(
      outcome!,
      { workspace: WORKSPACE, preset: PRESET },
      fixture.store.findItemById(item.id),
    )).toMatchObject({ settledBy: 'closed-by-thread', evidenceState: 'unverified' })

    const outbox = new WorkItemEvaluationExporter({
      store: () => fixture.store,
      scope: () => ({ workspace: WORKSPACE, preset: PRESET }),
      enabled: () => true,
      now: fixture.now,
    })
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('assistantWorkItems' as never, outbox as never)
    const evaluation = new AssistantEvaluationService(ctx, { databasePath: ':memory:', projectionIntervalMs: 0 })
    await settleCordis()
    await outbox.drain()

    const rows = evaluation.query({ scope: { workspace: WORKSPACE, preset: PRESET }, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      situation: 'work-item:review',
      executionStatus: 'unknown',
      objectiveStatus: 'unknown',
      deliveryStatus: 'unknown',
      source: { kind: 'system', id: 'assistant-work-items' },
      trust: 'trusted',
      evaluator: { id: 'assistant-work-items', version: 'unverified-v1' },
    })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      settledBy: 'closed-by-thread',
      evidenceState: 'unverified',
      evaluationState: 'exported',
    })
    expect(fixture.store.stats()).toMatchObject({ evaluationPending: 0, evaluationExported: 1 })
  })
})
