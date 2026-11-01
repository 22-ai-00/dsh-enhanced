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
      extra: { admission: { allowedKinds: ['review', 'triage'], maxOpenItems: 8, maxAdmitsPerHour: 4, dedupWindowMs: 3_600_000, cooldownMs: 0, maxBriefBytes: 512 }, sources: { foregroundFailures: { enabled: true, kind: 'review', maxAdmitsPerSweep: 2, maxCandidatesPerSweep: 5 } } },
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

  test('observes withdrawn signals but never admits them', async () => {
    const script = scriptedSource([
      { candidates: [candidate({ disposition: 'withdrawn', externalId: 'owner-foreground:cancelled-1' })], cursor: undefined },
    ])
    const setup = await fixture({ source: script.source })
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ admitted: 0, withdrawn: 1 })
    expect(setup.store.stats().items).toBe(0)
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
