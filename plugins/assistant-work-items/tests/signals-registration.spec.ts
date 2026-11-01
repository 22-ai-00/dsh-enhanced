import { mkdtemp, rm } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { WorkItemAdmission } from '../src/admission.ts'
import { type Config, normalizeConfig } from '../src/config.ts'
import { WorkItemDispatch } from '../src/dispatch.ts'
import { WorkItemLedger } from '../src/ledger.ts'
import type { PeerDeliveryService, PeerOwnerRouteReceipt, PeerPolicyRequest, PeerPolicyService } from '../src/peers.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import {
  type WorkItemSignalCandidate,
  type WorkItemSignalSource,
  type WorkItemSignalSweep,
  WorkItemSignalIntake,
} from '../src/signals.ts'
import { WorkItemStore } from '../src/store.ts'
import { WorkItemError } from '../src/types.ts'
import { WorkItemWorkspace } from '../src/workspace.ts'

const WORKER = 'work-items-worker'
const SOURCE = 'work-items/v1'
const WORKSPACE = '/work/alpha'
const PRESET = 'primary'
const PRINCIPAL = 'owner:me'
const ROUTE = 'route-1'
const T0 = 1_700_000_000_000
const SIGNAL_SOURCE = 'repository-watch'
const SIGNAL_VERSION = 'repository-watch/v1'
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

/** A source that answers with one scripted page on every sweep. */
function pageSource(page: WorkItemSignalSweep | (() => WorkItemSignalSweep), id = SIGNAL_SOURCE) {
  const inputs: Array<{ now: number; limit: number; cursor: unknown }> = []
  const source: WorkItemSignalSource = {
    id,
    sourceVersion: SIGNAL_VERSION,
    sweep(input) {
      inputs.push({ now: input.now, limit: input.limit, cursor: input.cursor })
      return typeof page === 'function' ? page() : page
    },
  }
  return { source, inputs }
}

function candidate(overrides: Partial<WorkItemSignalCandidate> = {}): WorkItemSignalCandidate {
  return {
    kind: 'review',
    externalId: 'repository-watch:canonical-1',
    title: 'Review the new pull request',
    brief: 'A registered source observed a pull request that needs review.',
    originBindingId: 'binding-watch-1',
    occurredAt: T0 - 60_000,
    disposition: 'failure',
    provenance: {
      source: SIGNAL_SOURCE,
      sourceVersion: SIGNAL_VERSION,
      signalDigest: 'sha256:digest-watch-1',
      observedAt: T0,
      evidence: { pullRequest: 42, repository: '22-ai-00/dsh-enhanced' },
    },
    ...overrides,
  }
}

function baseConfig(root: string, extra: Partial<Config> = {}): Config {
  return {
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
    ...extra,
  }
}

async function fixture(options: { extra?: Partial<Config> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-registration-'))
  roots.push(root)
  const config = normalizeConfig(baseConfig(root, options.extra), T0)
  let now = T0
  const workspace = new WorkItemWorkspace(config.workRoot)
  workspace.prepare()
  const store = new WorkItemStore(config.databasePath, { now: () => now })
  const ledger = new WorkItemLedger({ store, workspace, limits: config.limits, now: () => now })
  const delivery = createDelivery()
  const admission = new WorkItemAdmission({
    config,
    store,
    ledger,
    workspace,
    policy: createPolicy(),
    delivery,
    now: () => now,
  })
  const automations = { ingestExternal: () => ({ id: 'occ-1', automationId: WORKER }) }
  const dispatch = new WorkItemDispatch({ config, store, ledger, automations, delivery, now: () => now })
  closers.push(() => store.close())
  const intake = new WorkItemSignalIntake({ config, store, admission, delivery: () => delivery, dispatch, now: () => now })
  const advance = (ms: number): void => {
    now += ms
  }
  return { root, config, store, ledger, intake, advance }
}

class FakePolicyPeer extends Service {
  constructor(ctx: Context) {
    super(ctx, 'assistantPolicies')
  }
  authorize(_request: PeerPolicyRequest) {
    return { effect: 'allow', reasonCode: 'rule-allow' }
  }
}

class FakeDeliveryPeer extends Service {
  readonly calls: Array<Record<string, unknown>> = []
  constructor(ctx: Context) {
    super(ctx, 'assistantDelivery')
  }
  validateOwnerRoute() {
    return receipt()
  }
  enqueueBackground(input: Record<string, unknown>) {
    this.calls.push(input)
    return Promise.resolve({ id: `outbox-${String(this.calls.length)}` })
  }
}

class FakeAutomationsPeer extends Service {
  readonly calls: Array<Record<string, unknown>> = []
  constructor(ctx: Context) {
    super(ctx, 'assistantAutomations')
  }
  ingestExternal(input: Record<string, unknown>) {
    this.calls.push(input)
    return { id: `occ-${String(this.calls.length)}`, automationId: WORKER }
  }
}

function serviceFixture(config: Config) {
  const ctx = new Context()
  new FakePolicyPeer(ctx)
  new FakeDeliveryPeer(ctx)
  new FakeAutomationsPeer(ctx)
  const service = new AssistantWorkItemsService(ctx, config)
  closers.push(() => service.close())
  return service
}

describe('public signal source registration', () => {
  test('arms an intake with no built-in adapter and admits a registered candidate', async () => {
    const setup = await fixture()
    const page = pageSource({ candidates: [candidate()], cursor: undefined })
    expect(setup.config.sources.foregroundFailures.enabled).toBe(false)
    expect(setup.intake.armed()).toBe(false)

    setup.intake.register({ source: page.source })
    expect(setup.intake.armed()).toBe(true)
    expect(setup.intake.sources()).toEqual([SIGNAL_SOURCE])

    const report = setup.intake.sweep(true)
    expect(report.sources).toHaveLength(1)
    expect(report.sources[0]).toMatchObject({ source: SIGNAL_SOURCE, skipped: null, admitted: 1, failed: false })
    expect(setup.store.stats().items).toBe(1)
    const item = setup.store.listItems({ states: ['queued', 'claimed', 'working', 'waiting'] })[0]
    expect(item).toMatchObject({ kind: 'review', externalId: 'repository-watch:canonical-1', title: 'Review the new pull request' })
    const events = setup.ledger.detail(item?.id ?? '')?.events ?? []
    expect(events.find(event => event.kind === 'admitted')).toBeDefined()
  })

  test('defaults a registration budget to the configured sweep budget', async () => {
    const setup = await fixture()
    const candidates = [1, 2, 3, 4, 5].map(index => candidate({ externalId: `repository-watch:default-${String(index)}` }))
    const page = pageSource({ candidates, cursor: { sequence: 5 } })
    setup.intake.register({ source: page.source })
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ scanned: 3, admitted: 2 })
    expect(page.inputs[0]?.limit).toBe(10)
    expect(setup.store.stats().items).toBe(2)
  })

  test('honors per-registration budgets over the configured defaults', async () => {
    const setup = await fixture()
    const candidates = [1, 2, 3, 4].map(index => candidate({ externalId: `repository-watch:budget-${String(index)}` }))
    const page = pageSource({ candidates, cursor: undefined })
    setup.intake.register({ source: page.source, maxCandidatesPerSweep: 2, maxAdmitsPerSweep: 1 })
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ scanned: 2, admitted: 1 })
    expect(page.inputs[0]?.limit).toBe(2)
    expect(setup.store.stats().items).toBe(1)
  })

  test('stops sweeping a source as soon as its registration is disposed', async () => {
    const setup = await fixture()
    const page = pageSource({ candidates: [candidate()], cursor: undefined })
    const dispose = setup.intake.register({ source: page.source })
    expect(setup.intake.armed()).toBe(true)

    dispose()
    dispose()
    expect(setup.intake.armed()).toBe(false)
    expect(setup.intake.sources()).toEqual([])
    expect(setup.intake.sweep(true)).toEqual({ sources: [] })
    expect(setup.store.stats().items).toBe(0)
  })

  test('rejects a duplicate or malformed registration without disturbing the first', async () => {
    const setup = await fixture()
    const first = pageSource({ candidates: [], cursor: undefined })
    setup.intake.register({ source: first.source })

    const duplicate = pageSource({ candidates: [], cursor: undefined })
    expect(() => setup.intake.register({ source: duplicate.source })).toThrow(WorkItemError)
    expect(() => setup.intake.register({ source: duplicate.source })).toThrow(/already registered/)

    const badId = pageSource({ candidates: [], cursor: undefined }, 'Repository_Watch')
    expect(() => setup.intake.register({ source: badId.source })).toThrow(/lower-kebab-case/)

    const noVersion = { ...pageSource({ candidates: [], cursor: undefined }, 'other-source').source, sourceVersion: '' }
    expect(() => setup.intake.register({ source: noVersion })).toThrow(/sourceVersion/)

    const badInterval = pageSource({ candidates: [], cursor: undefined }, 'interval-source')
    expect(() => setup.intake.register({ source: badInterval.source, intervalMs: 0 })).toThrow(/intervalMs/)

    const badBudget = pageSource({ candidates: [], cursor: undefined }, 'budget-source')
    expect(() => setup.intake.register({ source: badBudget.source, maxAdmitsPerSweep: -1 })).toThrow(/maxAdmitsPerSweep/)

    expect(setup.intake.sources()).toEqual([SIGNAL_SOURCE])
    expect(setup.intake.sweep(true).sources).toHaveLength(1)
  })

  test('a stale disposer cannot unregister a newer registration with the same id', async () => {
    const setup = await fixture()
    const first = pageSource({ candidates: [], cursor: undefined })
    const stale = setup.intake.register({ source: first.source })
    stale()
    const replacement = pageSource({ candidates: [candidate()], cursor: undefined })
    setup.intake.register({ source: replacement.source })

    stale()
    expect(setup.intake.sources()).toEqual([SIGNAL_SOURCE])
    expect(setup.intake.sweep(true).sources[0]).toMatchObject({ source: SIGNAL_SOURCE, scanned: 1, admitted: 1 })
  })

  test('honors a per-registration interval instead of the configured default', async () => {
    const setup = await fixture()
    const page = pageSource({ candidates: [], cursor: undefined })
    setup.intake.register({ source: page.source, intervalMs: 60_000 })
    expect(setup.intake.sweep(true).sources[0]).toMatchObject({ skipped: null })

    expect(setup.intake.sweep().sources[0]).toMatchObject({ skipped: 'not-due' })
    setup.advance(59_999)
    expect(setup.intake.sweep().sources[0]).toMatchObject({ skipped: 'not-due' })
    setup.advance(1)
    expect(setup.intake.sweep().sources[0]).toMatchObject({ skipped: null })
    expect(page.inputs).toHaveLength(2)
  })

  test('rejects an id that admission provenance would refuse, and a missing registration', async () => {
    const setup = await fixture()
    const digitLeading = pageSource({ candidates: [], cursor: undefined }, '123-source')
    expect(() => setup.intake.register({ source: digitLeading.source })).toThrow(/lower-kebab-case/)
    const tooLong = pageSource({ candidates: [], cursor: undefined }, `a${'b'.repeat(64)}`)
    expect(() => setup.intake.register({ source: tooLong.source })).toThrow(/lower-kebab-case/)
    expect(() => setup.intake.register(null as never)).toThrow(WorkItemError)
    expect(setup.intake.sources()).toEqual([])
  })

  test('drops a candidate that speaks for another source', async () => {
    const setup = await fixture()
    const page = pageSource({
      candidates: [candidate({ provenance: { ...candidate().provenance, source: 'another-source' } })],
      cursor: undefined,
    })
    setup.intake.register({ source: page.source })
    const report = setup.intake.sweep(true)
    expect(report.sources[0]).toMatchObject({ scanned: 1, admitted: 0, rejected: 1 })
    expect(setup.store.stats().items).toBe(0)
  })

  test('unregisters by id and reports whether the source existed', async () => {
    const setup = await fixture()
    setup.intake.register({ source: pageSource({ candidates: [], cursor: undefined }).source })
    expect(setup.intake.unregister(SIGNAL_SOURCE)).toBe(true)
    expect(setup.intake.unregister(SIGNAL_SOURCE)).toBe(false)
    expect(setup.intake.armed()).toBe(false)
  })

  test('lets a registration shadow the built-in adapter instead of double sweeping', async () => {
    const setup = await fixture({ extra: { sources: { foregroundFailures: { enabled: true, kind: 'review' } } } })
    const replacement = pageSource({ candidates: [], cursor: undefined }, 'owner-foreground-failures')
    setup.intake.register({ source: replacement.source })
    const report = setup.intake.sweep(true)
    expect(report.sources.map(entry => entry.source)).toEqual(['owner-foreground-failures'])
    expect(replacement.inputs).toHaveLength(1)
  })

  test('registers and releases a source through the public service API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-registration-service-'))
    roots.push(root)
    const service = serviceFixture(baseConfig(root))
    const page = pageSource({ candidates: [], cursor: { sequence: 1 } })
    const dispose = service.registerSignalSource({ source: page.source })
    const first = service.sweepSignals(true)
    expect(first.sources.map(entry => entry.source)).toEqual([SIGNAL_SOURCE])

    dispose()
    expect(service.sweepSignals(true)).toEqual({ sources: [] })
    expect(page.inputs).toHaveLength(1)
  })

  test('fails closed when the intake is disabled or disposed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-registration-closed-'))
    roots.push(root)
    const disabled = serviceFixture(baseConfig(root, { enabled: false }))
    expect(() => disabled.registerSignalSource({ source: pageSource({ candidates: [], cursor: undefined }).source })).toThrow(/disabled/)

    const enabled = serviceFixture(baseConfig(join(root, 'enabled')))
    enabled.close()
    expect(() => enabled.registerSignalSource({ source: pageSource({ candidates: [], cursor: undefined }).source })).toThrow(/disposed/)
  })
})
