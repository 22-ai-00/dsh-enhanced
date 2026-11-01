import { mkdtemp, rm } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { WorkItemAdmission } from '../src/admission.ts'
import { type Config, normalizeConfig } from '../src/config.ts'
import type { PeerDeliveryService, PeerOwnerRouteReceipt, PeerPolicyRequest, PeerPolicyService } from '../src/peers.ts'
import {
  OwnerForegroundFailureSource,
  type WorkItemSignalCandidate,
  type WorkItemSignalSource,
  type WorkItemSignalSweep,
  WorkItemSignalIntake,
} from '../src/signals.ts'
import { WorkItemStore } from '../src/store.ts'
import { WorkItemDispatch } from '../src/dispatch.ts'
import { WorkItemLedger } from '../src/ledger.ts'
import { WorkItemWorkspace } from '../src/workspace.ts'
import { AssistantWorkItemsService } from '../src/service.ts'

const WORKER = 'work-items-worker'
const SOURCE = 'work-items/v1'
const WORKSPACE = '/work/alpha'
const PRESET = 'primary'
const PRINCIPAL = 'owner:me'
const ROUTE = 'route-1'
const T0 = 1_700_000_000_000
const roots: string[] = []
const closers: Array<() => void> = []

afterEach(async () => {
  for (const close of closers.splice(0)) close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function receipt(): PeerOwnerRouteReceipt {
  return Object.freeze({
    receiptVersion: 2,
    authorityId: ROUTE,
    authorityHash: 'sha256:authority',
    principalId: PRINCIPAL,
    principalRecordId: 'principal-1',
    principalVersion: 7,
    workspace: WORKSPACE,
    agentPreset: PRESET,
    bindingVersion: 3,
    generation: 2,
  })
}

function createDelivery(): PeerDeliveryService {
  return {
    validateOwnerRoute: () => receipt(),
    enqueueBackground: () => Promise.resolve({ id: 'outbox-1' }),
  }
}

function createPolicy(): PeerPolicyService {
  return {
    authorize(_request: PeerPolicyRequest) {
      return { effect: 'allow', reasonCode: 'rule-allow' }
    },
  }
}

/** A scripted source: returns queued pages in order and records its inputs. */
function scriptedSource(pages: Array<WorkItemSignalSweep | Error>) {
  const inputs: Array<{ now: number; limit: number; cursor: unknown }> = []
  let index = 0
  const source: WorkItemSignalSource = {
    id: 'test-source',
    sourceVersion: 'test-source/v1',
    sweep(input) {
      inputs.push({ now: input.now, limit: input.limit, cursor: input.cursor })
      const page = pages[Math.min(index, pages.length - 1)]
      index += 1
      if (page instanceof Error) throw page
      return page as WorkItemSignalSweep
    },
  }
  return { source, inputs }
}

function candidate(overrides: Partial<WorkItemSignalCandidate> = {}): WorkItemSignalCandidate {
  return {
    kind: 'review',
    externalId: 'owner-foreground:canonical-1',
    title: 'Repair a failed owner request',
    brief: 'The owner request failed; inspect and repair.',
    originBindingId: 'binding-1',
    occurredAt: T0 - 60_000,
    disposition: 'failure',
    provenance: {
      source: 'test-source',
      sourceVersion: 'test-source/v1',
      signalDigest: 'sha256:digest-1',
      observedAt: T0,
      evidence: { inboxId: 'inbox-1', executionStatus: 'failed', completedAt: T0 - 60_000 },
    },
    ...overrides,
  }
}

async function fixture(options: {
  extra?: Partial<Config>
  delivery?: PeerDeliveryService | undefined
  withDelivery?: () => PeerDeliveryService | undefined
  source?: WorkItemSignalSource
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-signals-'))
  roots.push(root)
  let current = T0
  const now = () => current
  const config = normalizeConfig({
    enabled: true,
    mode: 'active',
    databasePath: join(root, 'state', 'state.sqlite'),
    workRoot: join(root, 'work'),
    intakeSourceId: SOURCE,
    workerAutomationId: WORKER,
    scope: {
      workspace: WORKSPACE,
      preset: PRESET,
      principalId: PRINCIPAL,
      ownerRouteId: ROUTE,
      expiresAt: T0 + 86_400_000,
    },
    admission: {
      allowedKinds: ['review', 'triage'],
      maxOpenItems: 8,
      maxAdmitsPerHour: 4,
      dedupWindowMs: 3_600_000,
      cooldownMs: 0,
      maxBriefBytes: 512,
    },
    ...options.extra,
  }, current)
  const workspace = new WorkItemWorkspace(config.workRoot)
  workspace.prepare()
  const store = new WorkItemStore(config.databasePath, { now })
  const ledger = new WorkItemLedger({ store, workspace, limits: config.limits, now })
  const delivery = options.delivery ?? createDelivery()
  const automations = {
    ingestExternal: () => ({ id: 'occ-1', automationId: WORKER }),
  }
  const admission = new WorkItemAdmission({
    config,
    store,
    ledger,
    workspace,
    policy: createPolicy(),
    delivery,
    now,
  })
  const dispatch = new WorkItemDispatch({ config, store, ledger, automations, delivery, now })
  closers.push(() => store.close())
  const intake = new WorkItemSignalIntake({
    config,
    store,
    admission,
    delivery: options.withDelivery ?? (() => delivery),
    dispatch,
    now,
    ...(options.source === undefined ? {} : { sources: [options.source] }),
  })
  return {
    root,
    config,
    store,
    ledger,
    admission,
    intake,
    now,
    advance(ms: number) { current += ms },
  }
}

describe('automatic signal admission', () => {
  test('is a no-op by default: no source is armed and no sweep runs', async () => {
    const setup = await fixture()
    expect(setup.config.sources.foregroundFailures.enabled).toBe(false)
    expect(setup.intake.armed()).toBe(false)
    expect(setup.intake.sweep(true)).toEqual({ sources: [] })
    expect(setup.store.stats().items).toBe(0)
    expect(setup.store.meta('signal.sweptAt:owner-foreground-failures')).toBeNull()
  })

  test('dedupes by canonical key even when the source text changed', async () => {
    const script = scriptedSource([
      { candidates: [candidate()], cursor: undefined },
      { candidates: [candidate({ title: 'A corrected title', brief: 'Different wording now.' })], cursor: undefined },
    ])
    const setup = await fixture({ source: script.source })
    const first = setup.intake.sweep(true)
    expect(first.sources[0]).toMatchObject({ admitted: 1, duplicates: 0, failed: false })
    const second = setup.intake.sweep(true)
    expect(second.sources[0]).toMatchObject({ admitted: 0, duplicates: 1 })
    expect(setup.store.stats().items).toBe(1)
    const item = setup.store.listItems({ states: ['queued', 'claimed', 'working', 'waiting'] })[0]
    expect(item?.title).toBe('Repair a failed owner request')
  })

  test('records provenance on the durable admission event', async () => {
    const script = scriptedSource([{ candidates: [candidate()], cursor: undefined }])
    const setup = await fixture({ source: script.source })
    setup.intake.sweep(true)
    const item = setup.store.listItems({ states: ['queued', 'claimed', 'working', 'waiting'] })[0]
    expect(item).toBeDefined()
    const events = setup.ledger.detail(item?.id ?? '')?.events ?? []
    const admitted = events.find(event => event.kind === 'admitted')
    expect(admitted).toBeDefined()
    const detail = JSON.parse(admitted?.detail ?? '{}') as Record<string, unknown>
    expect(detail['provenance']).toMatchObject({
      source: 'test-source',
      sourceVersion: 'test-source/v1',
      signalDigest: 'sha256:digest-1',
      observedAt: T0,
      evidence: { inboxId: 'inbox-1', executionStatus: 'failed' },
    })
  })

  test('enforces the cooldown window across dedup windows', async () => {
    const script = scriptedSource([
      { candidates: [candidate()], cursor: undefined },
      { candidates: [candidate({ externalId: 'owner-foreground:canonical-2' })], cursor: undefined },
    ])
    const setup = await fixture({
      source: script.source,
      extra: { admission: { allowedKinds: ['review'], maxOpenItems: 8, maxAdmitsPerHour: 4, dedupWindowMs: 3_600_000, cooldownMs: 7_200_000, maxBriefBytes: 512 } },
    })
    setup.intake.sweep(true)
    setup.advance(3_600_001)
    const second = setup.intake.sweep(true)
    expect(second.sources[0]).toMatchObject({ admitted: 0, rejected: 1 })
    expect(setup.store.stats().items).toBe(1)
  })

  test('bounds admissions per sweep with a finite budget', async () => {
    const candidates = [1, 2, 3, 4, 5].map(index => candidate({ externalId: `owner-foreground:budget-${String(index)}` }))
    const script = scriptedSource([{ candidates, cursor: { sequence: 5 } }])
    const setup = await fixture({
      source: script.source,
      extra: { admission: { allowedKinds: ['review', 'triage'], maxOpenItems: 8, maxAdmitsPerHour: 4, dedupWindowMs: 3_600_000, cooldownMs: 0, maxBriefBytes: 512 }, sources: { foregroundFailures: { enabled: false, kind: 'review', maxAdmitsPerSweep: 2, maxCandidatesPerSweep: 5 } } },
    })
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ scanned: 3, admitted: 2 })
    expect(setup.store.stats().items).toBe(2)
  })

  test('never revives a settled item when the same signal is re-observed', async () => {
    const script = scriptedSource([
      { candidates: [candidate()], cursor: undefined },
      { candidates: [candidate({ occurredAt: T0, title: 'Re-observed failure', provenance: { source: 'test-source', sourceVersion: 'test-source/v1', signalDigest: 'sha256:digest-2', observedAt: T0 } })], cursor: undefined },
    ])
    const setup = await fixture({ source: script.source })
    setup.intake.sweep(true)
    const item = setup.store.listItems({ states: ['queued', 'claimed', 'working', 'waiting'] })[0]
    expect(item).toBeDefined()
    const id = item?.id ?? ''
    setup.ledger.claim({ itemId: id, runId: 'run-1', occurrenceId: 'occ-1' })
    setup.ledger.report({
      itemId: id,
      runId: 'run-1',
      status: 'ready',
      summary: 'Repaired and verified.',
      artifactPaths: [],
      idempotencyKey: 'k-1',
    })
    expect(setup.store.findItemById(id)?.state).toBe('ready')
    setup.advance(3_600_001)
    const second = setup.intake.sweep(true)
    expect(second.sources[0]).toMatchObject({ admitted: 0, fenced: 1 })
    expect(setup.store.stats().items).toBe(1)
    expect(setup.store.findItemById(id)?.state).toBe('ready')
  })

  test('observes a withdrawal for an unknown execution without creating work', async () => {
    const script = scriptedSource([
      { candidates: [candidate({ disposition: 'withdrawn', externalId: 'owner-foreground:cancelled-1' })], cursor: undefined },
    ])
    const setup = await fixture({ source: script.source })
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ admitted: 0, withdrawn: 1, retired: 0, rejected: 0 })
    expect(setup.store.stats().items).toBe(0)
  })

  test('retires the open item a withdrawn revision names and fails its pending wake-up', async () => {
    const script = scriptedSource([
      { candidates: [candidate({ disposition: 'withdrawn' })], cursor: undefined },
    ])
    const setup = await fixture({ source: script.source })
    // Admit directly (not through the intake) so the dispatch is still pending;
    // an intake admission would already have handed the wake-up to automations.
    setup.admission.admit({
      kind: 'review',
      externalId: 'owner-foreground:canonical-1',
      title: 'Repair a failed owner request',
      brief: 'The owner request failed; inspect and repair.',
      originBindingId: 'binding-1',
      provenance: candidate().provenance,
    })
    const item = setup.store.listItems({ states: ['queued'] })[0]
    expect(item).toBeDefined()
    const id = item?.id ?? ''
    expect(setup.store.getDispatch(id)?.state).toBe('pending')
    setup.advance(60_000)
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ admitted: 0, withdrawn: 1, retired: 1, rejected: 0 })
    expect(setup.store.findItemById(id)).toMatchObject({
      state: 'dropped',
      stateReason: 'signal-withdrawn',
      leaseUntil: null,
      leaseRunId: null,
      occurrenceId: null,
    })
    expect(setup.store.getDispatch(id)).toMatchObject({ state: 'failed', reason: 'signal-withdrawn' })
    const withdrawal = setup.store.events(id).find(event => event.kind === 'withdrawn')
    expect(withdrawal).toMatchObject({ actor: 'signal-intake' })
    expect(JSON.parse(withdrawal?.detail ?? '{}')).toEqual({
      stateReason: 'signal-withdrawn',
      previousState: 'queued',
      sourceId: 'test-source',
      externalId: 'owner-foreground:canonical-1',
      observedAt: T0,
    })
    expect(setup.store.stats().openItems).toBe(0)
  })

  test('leaves a settled item untouched when a late withdrawal arrives', async () => {
    const script = scriptedSource([
      { candidates: [candidate()], cursor: undefined },
      { candidates: [candidate({ disposition: 'withdrawn', provenance: { source: 'test-source', sourceVersion: 'test-source/v1', signalDigest: 'sha256:digest-2', observedAt: T0 } })], cursor: undefined },
    ])
    const setup = await fixture({ source: script.source })
    setup.intake.sweep(true)
    const item = setup.store.listItems({ states: ['queued'] })[0]
    const id = item?.id ?? ''
    setup.ledger.claim({ itemId: id, runId: 'run-1', occurrenceId: 'occ-1' })
    setup.ledger.report({ itemId: id, runId: 'run-1', status: 'ready', summary: 'Repaired.', artifactPaths: [], idempotencyKey: 'k-1' })
    const eventsBefore = setup.store.events(id).length
    setup.advance(3_600_001)
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ admitted: 0, withdrawn: 1, retired: 0, rejected: 0 })
    expect(setup.store.findItemById(id)?.state).toBe('ready')
    expect(setup.store.events(id)).toHaveLength(eventsBefore)
  })

  test('releases the active claim when a claimed item is withdrawn, so its run can no longer report', async () => {
    const script = scriptedSource([
      { candidates: [candidate()], cursor: undefined },
      { candidates: [candidate({ disposition: 'withdrawn', provenance: { source: 'test-source', sourceVersion: 'test-source/v1', signalDigest: 'sha256:digest-2', observedAt: T0 } })], cursor: undefined },
    ])
    const setup = await fixture({ source: script.source })
    setup.intake.sweep(true)
    const item = setup.store.listItems({ states: ['queued'] })[0]
    const id = item?.id ?? ''
    const claim = setup.ledger.claim({ itemId: id, runId: 'run-1', occurrenceId: 'occ-1' })
    setup.advance(60_000)
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ withdrawn: 1, retired: 1 })
    expect(setup.store.findItemById(id)?.state).toBe('dropped')
    expect(setup.store.activeClaim(id)).toBeUndefined()
    expect(setup.store.findClaimByRun('run-1')).toMatchObject({ state: 'released', claimId: claim.claim.claimId })
    // The worker's next report fails with the real surfaced code: the claim is
    // released, so `report()` refuses before reaching the item's state.
    let code: string | undefined
    try {
      setup.ledger.report({ itemId: id, runId: 'run-1', status: 'ready', summary: 'Late.', artifactPaths: [], idempotencyKey: 'k-late' })
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('claim-conflict')
  })

  test('retires every open row of one canonical key when the dedup window rolled', async () => {
    const setup = await fixture()
    const input = {
      kind: 'review',
      externalId: 'owner-foreground:canonical-1',
      title: 'Repair a failed owner request',
      brief: 'The owner request failed; inspect and repair.',
      originBindingId: 'binding-1',
      provenance: candidate().provenance,
    }
    setup.admission.admit(input)
    // The dedup window is a freshness bound, so a second admission past it
    // creates another open row for the same canonical identity.
    setup.advance(3_600_001)
    setup.admission.admit(input)
    const open = setup.store.listItems({ states: ['queued', 'claimed', 'working', 'waiting'] })
    expect(open).toHaveLength(2)
    const result = setup.admission.withdraw(input)
    expect(result.outcome).toBe('withdrawn')
    expect(result.items).toHaveLength(2)
    for (const item of result.items) expect(item).toMatchObject({ state: 'dropped', stateReason: 'signal-withdrawn' })
    // No surviving row can be handed to the worker by a later `wakePending()`.
    expect(setup.store.stats().openItems).toBe(0)
    expect(setup.store.listOpenDispatches(10)).toHaveLength(0)
  })

  test('retires a mixed dispatched/pending set without recalling the dispatched wake-up', async () => {
    const setup = await fixture()
    const input = {
      kind: 'review',
      externalId: 'owner-foreground:canonical-1',
      title: 'Repair a failed owner request',
      brief: 'The owner request failed; inspect and repair.',
      originBindingId: 'binding-1',
      provenance: candidate().provenance,
    }
    setup.admission.admit(input)
    const first = setup.store.listItems({ states: ['queued'] })[0]
    const firstId = first?.id ?? ''
    setup.store.markDispatchDispatched(firstId, 'occ-first')
    setup.advance(3_600_001)
    setup.admission.admit(input)
    const open = setup.store.listItems({ states: ['queued'] })
    expect(open).toHaveLength(2)
    const secondId = open.find(item => item.id !== firstId)?.id ?? ''
    expect(setup.store.getDispatch(secondId)?.state).toBe('pending')
    expect(setup.admission.withdraw(input)).toMatchObject({ outcome: 'withdrawn' })
    // The already-delivered occurrence stays; the not-yet-delivered one is failed
    // instead of re-armed, so neither can wake cancelled work.
    expect(setup.store.getDispatch(firstId)).toMatchObject({ state: 'dispatched', occurrenceId: 'occ-first' })
    expect(setup.store.getDispatch(secondId)).toMatchObject({ state: 'failed', reason: 'signal-withdrawn' })
    expect(setup.store.listOpenDispatches(10)).toHaveLength(0)
  })

  test('leaves a wake-up already dispatched to the automation untouched', async () => {
    const setup = await fixture()
    const input = {
      kind: 'review',
      externalId: 'owner-foreground:canonical-1',
      title: 'Repair a failed owner request',
      brief: 'The owner request failed; inspect and repair.',
      originBindingId: 'binding-1',
      provenance: candidate().provenance,
    }
    setup.admission.admit(input)
    const id = setup.store.listItems({ states: ['queued'] })[0]?.id ?? ''
    setup.store.markDispatchDispatched(id, 'occ-1')
    expect(setup.admission.withdraw(input)).toMatchObject({ outcome: 'withdrawn', items: [{ state: 'dropped' }] })
    // Delivery to a running occurrence cannot be recalled; only future work is
    // cancelled, so the dispatched row keeps its occurrence.
    expect(setup.store.getDispatch(id)).toMatchObject({ state: 'dispatched', occurrenceId: 'occ-1' })
  })

  test('keeps repeated withdrawal sweeps idempotent', async () => {
    const withdrawnCandidate = candidate({
      disposition: 'withdrawn',
      provenance: { source: 'test-source', sourceVersion: 'test-source/v1', signalDigest: 'sha256:digest-2', observedAt: T0 },
    })
    const script = scriptedSource([
      { candidates: [candidate()], cursor: undefined },
      { candidates: [withdrawnCandidate], cursor: undefined },
      { candidates: [withdrawnCandidate], cursor: undefined },
    ])
    const setup = await fixture({ source: script.source })
    setup.intake.sweep(true)
    setup.advance(60_000)
    expect(setup.intake.sweep(true).sources[0]).toMatchObject({ withdrawn: 1, retired: 1 })
    const id = setup.store.listItems({ states: ['dropped'] })[0]?.id ?? ''
    const events = setup.store.events(id).length
    expect(setup.intake.sweep(true).sources[0]).toMatchObject({ withdrawn: 1, retired: 0 })
    expect(setup.store.events(id)).toHaveLength(events)
  })

  test('refuses a withdrawal attributed to another source before it can retire work', async () => {
    const script = scriptedSource([
      { candidates: [candidate()], cursor: undefined },
      { candidates: [candidate({ disposition: 'withdrawn', provenance: { source: 'other-source', sourceVersion: 'other-source/v1', signalDigest: 'sha256:digest-2', observedAt: T0 } })], cursor: undefined },
    ])
    const setup = await fixture({ source: script.source })
    setup.intake.sweep(true)
    const item = setup.store.listItems({ states: ['queued'] })[0]
    setup.advance(60_000)
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ withdrawn: 0, retired: 0, rejected: 1 })
    expect(setup.store.findItemById(item?.id ?? '')?.state).toBe('queued')
  })

  test('withdraws through the admission API using canonical identity only', async () => {
    const setup = await fixture()
    const input = {
      kind: 'review',
      externalId: 'owner-foreground:canonical-1',
      title: 'Repair a failed owner request',
      brief: 'The owner request failed; inspect and repair.',
      originBindingId: 'binding-1',
      provenance: candidate().provenance,
    }
    expect(setup.admission.withdraw(input)).toEqual({ outcome: 'absent', items: [] })
    setup.admission.admit(input)
    expect(setup.admission.withdraw(input)).toMatchObject({
      outcome: 'withdrawn',
      items: [{ state: 'dropped', stateReason: 'signal-withdrawn' }],
    })
    // Idempotent: a terminal item is not rewritten and appends no event.
    const id = setup.store.listItems({ states: ['dropped'] })[0]?.id ?? ''
    const events = setup.store.events(id).length
    expect(setup.admission.withdraw(input)).toMatchObject({ outcome: 'settled', items: [{ state: 'dropped' }] })
    expect(setup.store.events(id)).toHaveLength(events)
  })

  test('contains an adapter failure, resets the cursor and keeps claiming safe', async () => {
    const script = scriptedSource([new Error('delivery unavailable')])
    const setup = await fixture({ source: script.source })
    setup.store.setMeta('signal.cursor:test-source', '{"sequence":9}')
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ failed: true, admitted: 0 })
    expect(setup.store.meta('signal.cursor:test-source')).toBe('')
    expect(setup.store.stats().items).toBe(0)
  })

  test('gates repeated sweeps by the persisted interval', async () => {
    const script = scriptedSource([{ candidates: [], cursor: undefined }])
    const setup = await fixture({ source: script.source })
    setup.intake.sweep()
    const notDue = setup.intake.sweep()
    expect(notDue.sources[0]).toMatchObject({ skipped: 'not-due', scanned: 0 })
    const forced = setup.intake.sweep(true)
    expect(forced.sources[0]?.skipped).toBeNull()
    expect(script.inputs).toHaveLength(2)
  })

  test('degrades to a no-op when the optional delivery peer is absent', async () => {
    const setup = await fixture({
      extra: { sources: { foregroundFailures: { enabled: true, kind: 'review' } } },
      withDelivery: () => undefined,
    })
    expect(setup.intake.armed()).toBe(true)
    expect(setup.intake.sweep(true)).toEqual({ sources: [] })
    expect(setup.store.stats().items).toBe(0)
  })

  test('degrades when the delivery peer does not expose the source API', async () => {
    const bare: PeerDeliveryService = {
      validateOwnerRoute: () => receipt(),
      enqueueBackground: () => Promise.resolve({ id: 'outbox-1' }),
    }
    const setup = await fixture({
      extra: { sources: { foregroundFailures: { enabled: true, kind: 'review' } } },
      withDelivery: () => bare,
    })
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({
      source: 'owner-foreground-failures',
      skipped: 'degraded',
      degraded: 'unsupported',
      failed: false,
    })
  })
})

// ---------------------------------------------------------------------------
// End-to-end: the concrete delivery adapter inside a real service claim path.
// ---------------------------------------------------------------------------

class FakePolicyPeer extends Service {
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorize() { return { effect: 'allow' as const, reasonCode: 'rule-allow' } }
}

class InspectDeliveryPeer extends Service {
  readonly calls: Array<unknown> = []
  constructor(ctx: Context) { super(ctx, 'assistantDelivery') }
  validateOwnerRoute() { return receipt() }
  enqueueBackground() { return { id: 'outbox-1' } }
  listOwnerForegroundTaskSources(input: unknown) {
    this.calls.push(input)
    return {
      items: [{
        protocol: 'assistant-delivery/owner-foreground-source/v1',
        inboxId: 'inbox-failed-1',
        sourceDigest: 'sha256:source-digest-1',
        completionSequence: 4,
        authorityId: ROUTE,
        authorityHash: 'sha256:authority',
        principalId: PRINCIPAL,
        scope: { workspace: WORKSPACE, preset: PRESET },
        binding: { id: 'binding-failed-1', version: 3, generation: 2, sessionId: 'session-1' },
        execution: {
          dispatchedAt: T0 - 120_000,
          status: 'failed' as const,
          quiescent: true,
          completedAt: T0 - 60_000,
          executionRef: 'exec-1',
        },
      }],
      nextCursor: { sequence: 4 },
      watermark: 4,
      hasMore: false,
    }
  }
}

class FakeAutomationsPeer extends Service {
  readonly calls: Array<Record<string, unknown>> = []
  next = 0
  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  ingestExternal(input: Record<string, unknown>) {
    this.calls.push(input)
    this.next += 1
    return { id: `occ-${String(this.next)}`, automationId: WORKER }
  }
}

class FakeToolsPeer extends Service {
  readonly registered: unknown[] = []
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(tool: unknown) { this.registered.push(tool) }
}

function workerAgent(occurrenceId: string): Agent {
  const execution = Object.freeze({ mode: 'production', automationId: WORKER, occurrenceId })
  return { ctx: { get: (name: string) => name === 'assistantAutomationExecution' ? execution : undefined } } as unknown as Agent
}

test('admits a genuine delivery failure during claim without disturbing the claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-signals-service-'))
  roots.push(root)
  const ctx = new Context()
  new FakePolicyPeer(ctx)
  const delivery = new InspectDeliveryPeer(ctx)
  const automations = new FakeAutomationsPeer(ctx)
  const tools = new FakeToolsPeer(ctx)
  const config: Config = {
    enabled: true,
    mode: 'active',
    databasePath: join(root, 'state', 'state.sqlite'),
    workRoot: join(root, 'work'),
    intakeSourceId: SOURCE,
    workerAutomationId: WORKER,
    scope: {
      workspace: WORKSPACE,
      preset: PRESET,
      principalId: PRINCIPAL,
      ownerRouteId: ROUTE,
      expiresAt: Date.now() + 86_400_000,
    },
    admission: {
      allowedKinds: ['review', 'triage'],
      maxOpenItems: 8,
      maxAdmitsPerHour: 4,
      dedupWindowMs: 3_600_000,
      cooldownMs: 0,
      maxBriefBytes: 512,
    },
    sources: { foregroundFailures: { enabled: true, kind: 'review' } },
  }
  const service = new AssistantWorkItemsService(ctx, config)
  closers.push(() => service.close())
  // Tool registration runs through the Cordis `inject` callback.
  await Promise.resolve()

  // A pre-existing item owns occurrence `occ-1`.
  service.admit({
    kind: 'review',
    externalId: 'ext-origin-1',
    title: 'Review the pull request',
    brief: 'Check the diff for regressions.',
    originBindingId: 'binding-origin-1',
  })
  expect(automations.calls).toHaveLength(1)
  expect(tools.registered).toHaveLength(3)

  // Claiming occurrence `occ-1` sweeps first, admits the real delivery failure,
  // and then still returns the claim for `occ-1`.
  const claim = service.claim(workerAgent('occ-1'))
  expect(claim).toMatchObject({ runId: 'occ-1', attempt: 1 })
  expect(delivery.calls).toHaveLength(1)
  expect(automations.calls).toHaveLength(2)

  const admitted = service.status(workerAgent('occ-2')).item
  expect(admitted).toMatchObject({
    kind: 'review',
    title: 'Repair a failed owner request',
    externalId: expect.stringMatching(/^owner-foreground:[a-f0-9]{64}$/),
    originBindingId: 'binding-failed-1',
  })
  expect(admitted.brief).toContain('inbox-failed-1')
  expect(service.status(workerAgent('occ-2')).openItems).toBe(2)
})

test('gives one execution one identity across its failure and withdrawal revisions', async () => {
  const setup = await fixture()
  let status: 'failed' | 'cancelled' = 'failed'
  const delivery: PeerDeliveryService = {
    validateOwnerRoute: () => receipt(),
    enqueueBackground: () => Promise.resolve({ id: 'outbox-1' }),
    listOwnerForegroundTaskSources: () => ({
      items: [{
        protocol: 'assistant-delivery/owner-foreground-source/v1',
        inboxId: 'inbox-1',
        sourceDigest: 'sha256:digest-1',
        completionSequence: 4,
        authorityId: ROUTE,
        authorityHash: 'sha256:authority',
        principalId: PRINCIPAL,
        scope: { workspace: WORKSPACE, preset: PRESET },
        binding: { id: 'binding-1', version: 3, generation: 2, sessionId: 'session-1' },
        execution: { dispatchedAt: T0 - 120_000, status, quiescent: true, completedAt: T0 - 60_000, executionRef: 'exec-1' },
      }],
      nextCursor: undefined,
      watermark: 4,
      hasMore: false,
    }),
  }
  const source = new OwnerForegroundFailureSource(setup.config, delivery)
  const failed = source.sweep({ now: T0, limit: 10, cursor: undefined }).candidates[0]
  status = 'cancelled'
  const withdrawn = source.sweep({ now: T0, limit: 10, cursor: undefined }).candidates[0]
  expect(failed?.disposition).toBe('failure')
  expect(withdrawn?.disposition).toBe('withdrawn')
  expect(withdrawn?.externalId).toBe(failed?.externalId)
  expect(withdrawn?.externalId).toMatch(/^owner-foreground:[a-f0-9]{64}$/)
  expect(failed?.title).toBe('Repair a failed owner request')
  expect(withdrawn?.title).toBe('Repair a cancelled owner request')
})
