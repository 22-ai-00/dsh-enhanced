import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WorkItemAdmission } from '../src/admission.ts'
import { type Config, normalizeConfig, type NormalizedConfig } from '../src/config.ts'
import { WorkItemDispatch } from '../src/dispatch.ts'
import { WorkItemLedger } from '../src/ledger.ts'
import type {
  PeerAutomationsService,
  PeerDeliveryService,
  PeerOwnerForegroundTaskSource,
  PeerOwnerForegroundTaskSourcePage,
  PeerOwnerRouteReceipt,
  PeerPolicyDecision,
  PeerPolicyRequest,
  PeerPolicyService,
} from '../src/peers.ts'
import { OUTCOME_EVIDENCE_SOURCE } from '../src/outcome.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemAdmitInput, WorkItemRecord, WorkItemReportRecord } from '../src/types.ts'
import { WorkItemError } from '../src/types.ts'
import { WorkItemWorkspace } from '../src/workspace.ts'

const WORKER = 'work-items-worker'
const SOURCE = 'work-items/v1'
const WORKSPACE = '/work/alpha'
const PRESET = 'primary'
const PRINCIPAL = 'owner:me'
const ROUTE = 'route-1'
const roots: string[] = []
const closers: Array<() => void> = []

afterEach(async () => {
  for (const close of closers.splice(0)) close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function signal(overrides: Partial<WorkItemAdmitInput> = {}): WorkItemAdmitInput {
  return {
    kind: 'review',
    externalId: 'ext-1',
    title: 'Review the pull request',
    brief: 'Check the diff for regressions.',
    originBindingId: 'binding-origin-1',
    ...overrides,
  }
}

function receipt(input: {
  authorityId: string
  principalId: string
  workspace: string
  agentPreset: string
}): PeerOwnerRouteReceipt {
  return Object.freeze({
    receiptVersion: 2,
    authorityId: input.authorityId,
    authorityHash: 'sha256:authority',
    principalId: input.principalId,
    principalRecordId: 'principal-1',
    principalVersion: 7,
    workspace: input.workspace,
    agentPreset: input.agentPreset,
    bindingVersion: 3,
    generation: 2,
  })
}

type RouteInput = Parameters<PeerDeliveryService['validateOwnerRoute']>[0]
type EnqueueInput = Parameters<PeerDeliveryService['enqueueBackground']>[0]
type IngestInput = Parameters<PeerAutomationsService['ingestExternal']>[0]

function peerError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function createPolicy() {
  const calls: Array<{ request: PeerPolicyRequest; options: unknown }> = []
  let allow = true
  const service: PeerPolicyService = {
    authorize(request, options) {
      calls.push({ request, options })
      const decision: PeerPolicyDecision = allow
        ? { effect: 'allow', reasonCode: 'rule-allow' }
        : { effect: 'deny', reasonCode: 'default-deny' }
      return decision
    },
  }
  return { service, calls, setAllow(value: boolean) { allow = value } }
}

function createDelivery(options: { invalid?: boolean; failCode?: string } = {}) {
  const validations: RouteInput[] = []
  const enqueues: EnqueueInput[] = []
  let invalid = options.invalid ?? false
  let failCode = options.failCode ?? ''
  const service: PeerDeliveryService = {
    validateOwnerRoute(input) {
      validations.push(input)
      if (invalid) throw peerError('missing-binding')
      return receipt(input)
    },
    enqueueBackground(input) {
      enqueues.push(input)
      if (failCode !== '') return Promise.reject(peerError(failCode))
      return Promise.resolve({ id: `outbox-${String(enqueues.length)}` })
    },
  }
  return {
    service,
    validations,
    enqueues,
    setInvalid(value: boolean) { invalid = value },
    setFailCode(value: string) { failCode = value },
  }
}

/**
 * Mirror the real automation store's occurrence identity.
 *
 * The production intake derives the occurrence from
 * `(automationId, triggerKind, triggerKey)` where the external trigger key is
 * `(sourceId, eventId, occurredAt)`; an existing occurrence is returned as-is
 * regardless of its status, so a completed occurrence is never re-run. The fake
 * must behave the same way or a test can "pass" on an identity that the real
 * peer would silently dedupe into a dead occurrence.
 */
function createAutomations(options: { failCode?: string } = {}) {
  const calls: IngestInput[] = []
  const occurrences = new Map<string, { readonly id: string; readonly automationId: string; readonly eventId: string; readonly occurredAt: number }>()
  let failCode = options.failCode ?? ''
  const service: PeerAutomationsService = {
    ingestExternal(input) {
      calls.push(input)
      if (failCode !== '') throw peerError(failCode)
      const key = `${input.automationId}\0${input.eventId}\0${String(input.occurredAt)}`
      const existing = occurrences.get(key)
      if (existing !== undefined) return existing
      const occurrence = Object.freeze({
        id: `occ-${String(occurrences.size + 1)}`,
        automationId: input.automationId,
        eventId: input.eventId,
        occurredAt: input.occurredAt,
      })
      occurrences.set(key, occurrence)
      return occurrence
    },
  }
  return { service, calls, occurrences, setFailCode(value: string) { failCode = value } }
}

class FakePolicyPeer extends Service {
  readonly spy = createPolicy()
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  get calls(): Array<{ request: PeerPolicyRequest; options: unknown }> { return this.spy.calls }
  authorize(request: PeerPolicyRequest, options?: { idempotencyKey?: string; auditDetails?: unknown }) {
    return this.spy.service.authorize(request, options)
  }
}

class FakeDeliveryPeer extends Service {
  readonly spy = createDelivery()
  constructor(ctx: Context) { super(ctx, 'assistantDelivery') }
  get enqueues(): EnqueueInput[] { return this.spy.enqueues }
  get validations(): RouteInput[] { return this.spy.validations }
  validateOwnerRoute(input: RouteInput) { return this.spy.service.validateOwnerRoute(input) }
  enqueueBackground(input: EnqueueInput) { return this.spy.service.enqueueBackground(input) }
}

class FakeAutomationsPeer extends Service {
  readonly spy = createAutomations()
  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  get calls(): IngestInput[] { return this.spy.calls }
  ingestExternal(input: IngestInput) { return this.spy.service.ingestExternal(input) }
  setFailCode(value: string) { this.spy.setFailCode(value) }
}

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>, exec: unknown): Promise<Record<string, unknown>>
}

class FakeToolsPeer extends Service {
  readonly registered: RegisteredTool[] = []
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(tool: unknown) { this.registered.push(tool as RegisteredTool) }
}

function workerAgent(occurrenceId: string, automationId = WORKER, mode = 'production'): Agent {
  const execution = Object.freeze({ mode, automationId, occurrenceId })
  return {
    ctx: { get: (name: string) => name === 'assistantAutomationExecution' ? execution : undefined },
  } as unknown as Agent
}

function foregroundAgent(): Agent {
  return { ctx: { get: () => undefined } } as unknown as Agent
}

async function serviceHarness(options: {
  mode?: 'observe' | 'active'
  withAutomations?: boolean
  extra?: Partial<Config>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-service-'))
  roots.push(root)
  const ctx = new Context()
  const policy = new FakePolicyPeer(ctx)
  const delivery = new FakeDeliveryPeer(ctx)
  const tools = new FakeToolsPeer(ctx)
  const automations = options.withAutomations === false ? undefined : new FakeAutomationsPeer(ctx)
  const scope = {
    workspace: WORKSPACE,
    preset: PRESET,
    principalId: PRINCIPAL,
    ownerRouteId: ROUTE,
    expiresAt: Date.now() + 3_600_000,
  }
  const config: Config = {
    enabled: true,
    mode: options.mode ?? 'active',
    databasePath: join(root, 'state', 'state.sqlite'),
    workRoot: join(root, 'work'),
    intakeSourceId: SOURCE,
    workerAutomationId: WORKER,
    scope,
    admission: {
      allowedKinds: ['review', 'triage'],
      maxOpenItems: 2,
      maxAdmitsPerHour: 4,
      dedupWindowMs: 3_600_000,
      cooldownMs: 0,
      maxBriefBytes: 512,
    },
    ...options.extra,
  }
  const service = new AssistantWorkItemsService(ctx, config)
  closers.push(() => service.close())
  return {
    root,
    ctx,
    service,
    policy,
    delivery,
    tools,
    automations,
    config: normalizeConfig(config, Date.now()) as NormalizedConfig,
    signal,
  }
}

async function ledgerHarness(options: {
  mode?: 'observe' | 'active'
  now?: number
  extra?: Partial<Config>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-ledger-'))
  roots.push(root)
  let current = options.now ?? 1_700_000_000_000
  const now = () => current
  const config = normalizeConfig({
    enabled: true,
    mode: options.mode ?? 'active',
    databasePath: join(root, 'state', 'state.sqlite'),
    workRoot: join(root, 'work'),
    intakeSourceId: SOURCE,
    workerAutomationId: WORKER,
    scope: {
      workspace: WORKSPACE,
      preset: PRESET,
      principalId: PRINCIPAL,
      ownerRouteId: ROUTE,
      expiresAt: current + 86_400_000,
    },
    admission: {
      allowedKinds: ['review', 'triage'],
      maxOpenItems: 2,
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
  const policy = createPolicy()
  const delivery = createDelivery()
  const automations = createAutomations()
  const admission = new WorkItemAdmission({
    config,
    store,
    ledger,
    workspace,
    policy: policy.service,
    delivery: delivery.service,
    now,
  })
  const dispatch = new WorkItemDispatch({
    config,
    store,
    ledger,
    automations: automations.service,
    delivery: delivery.service,
    now,
  })
  closers.push(() => store.close())
  return {
    root, config, workspace, store, ledger, admission, dispatch, policy, delivery, automations, now,
    advance(ms: number) { current += ms },
  }
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof WorkItemError ? error.code : `unexpected:${String(error)}`
  }
  return undefined
}

describe('work-item admission gates', () => {
  test('observe mode records the signal locally and calls no peer', async () => {
    const fixture = await ledgerHarness({ mode: 'observe' })
    const result = fixture.admission.admit(signal())
    expect(result.created).toBe(true)
    expect(result.item.state).toBe('dropped')
    expect(result.item.stateReason).toBe('observe-only')
    expect(result.item.observed).toBe(true)
    expect(result.dispatch.state).toBe('failed')
    expect(result.dispatch.reason).toBe('observe-only')
    expect(fixture.store.stats()).toMatchObject({ items: 1, reports: 0, dispatches: 1 })
    expect(fixture.store.countOpenItems()).toBe(0)
    expect(fixture.automations.calls).toHaveLength(0)
    expect(fixture.delivery.enqueues).toHaveLength(0)
    expect(fixture.delivery.validations).toHaveLength(1)
    expect(fixture.policy.calls).toHaveLength(0)
    expect(fixture.store.lastAdmitAt()).not.toBeNull()
  })

  test('replays a duplicate inside the dedup window and admits again after it', async () => {
    const fixture = await ledgerHarness()
    const first = fixture.admission.admit(signal())
    const duplicate = fixture.admission.admit(signal())
    expect(duplicate.created).toBe(false)
    expect(duplicate.item.id).toBe(first.item.id)
    expect(fixture.store.stats().items).toBe(1)
    fixture.advance(3_600_000)
    const later = fixture.admission.admit(signal())
    expect(later.created).toBe(true)
    expect(later.item.id).not.toBe(first.item.id)
    expect(fixture.store.stats().items).toBe(2)
  })

  test('active admission authorizes, then persists a queued item with a pending dispatch', async () => {
    const fixture = await ledgerHarness()
    const result = fixture.admission.admit(signal())
    expect(result.item.state).toBe('queued')
    expect(result.item.observed).toBe(false)
    expect(result.item.workerAutomationId).toBe(WORKER)
    expect(result.item.attempt).toBe(0)
    expect(result.dispatch.state).toBe('pending')
    expect(fixture.policy.calls).toHaveLength(1)
    expect(fixture.policy.calls[0]?.request).toMatchObject({
      subject: { kind: 'background', id: SOURCE, workspace: WORKSPACE, principal: PRINCIPAL },
      action: 'admit',
      resource: { kind: 'automation', id: WORKER },
    })
  })

  test('rejections happen before any durable write', async () => {
    const kindFixture = await ledgerHarness()
    expect(errorCode(() => kindFixture.admission.admit(signal({ kind: 'deploy' })))).toBe('kind-rejected')
    expect(kindFixture.store.stats().items).toBe(0)

    const cooldownFixture = await ledgerHarness({ extra: { admission: { allowedKinds: ['review'], cooldownMs: 60_000 } } })
    cooldownFixture.admission.admit(signal())
    expect(errorCode(() => cooldownFixture.admission.admit(signal({ externalId: 'ext-2' })))).toBe('cooldown')
    expect(cooldownFixture.store.stats().items).toBe(1)

    const rateFixture = await ledgerHarness({ extra: { admission: { allowedKinds: ['review', 'triage'], maxAdmitsPerHour: 1 } } })
    rateFixture.admission.admit(signal())
    expect(errorCode(() => rateFixture.admission.admit(signal({ kind: 'triage' })))).toBe('rate-limited')

    const capacityFixture = await ledgerHarness({ extra: { admission: { allowedKinds: ['review', 'triage'], maxOpenItems: 1 } } })
    capacityFixture.admission.admit(signal())
    expect(errorCode(() => capacityFixture.admission.admit(signal({ kind: 'triage' })))).toBe('capacity')
    expect(capacityFixture.store.stats().items).toBe(1)
  })

  test('policy denies active admission without writing or waking', async () => {
    const fixture = await ledgerHarness()
    fixture.policy.setAllow(false)
    expect(errorCode(() => fixture.admission.admit(signal()))).toBe('source-rejected')
    expect(fixture.store.stats().items).toBe(0)
    expect(fixture.automations.calls).toHaveLength(0)
  })

  test('an invalid owner route writes nothing', async () => {
    const fixture = await ledgerHarness()
    fixture.delivery.setInvalid(true)
    expect(errorCode(() => fixture.admission.admit(signal()))).toBe('owner-route-invalid')
    expect(fixture.store.stats().items).toBe(0)
    expect(fixture.automations.calls).toHaveLength(0)
  })
})

describe('work-item dispatch', () => {
  test('wakes the worker once with the item event and records the occurrence', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    fixture.dispatch.wake(admitted.item)
    expect(fixture.automations.calls).toHaveLength(1)
    expect(fixture.automations.calls[0]).toEqual({
      sourceId: SOURCE,
      automationId: WORKER,
      eventId: admitted.item.id,
      occurredAt: admitted.item.createdAt,
    })
    const dispatch = fixture.store.getDispatch(admitted.item.id)
    expect(dispatch).toMatchObject({ state: 'dispatched', occurrenceId: 'occ-1' })
    fixture.dispatch.wake(admitted.item)
    expect(fixture.automations.calls).toHaveLength(1)
  })

  test('records a policy denial instead of throwing', async () => {
    const fixture = await ledgerHarness()
    fixture.automations.setFailCode('policy-denied')
    const admitted = fixture.admission.admit(signal())
    expect(() => fixture.dispatch.wake(admitted.item)).not.toThrow()
    expect(fixture.store.getDispatch(admitted.item.id)).toMatchObject({ state: 'failed', reason: 'policy-denied' })
  })

  test('an ambiguous wake failure is recorded honestly and retried once on the same identity', async () => {
    const fixture = await ledgerHarness()
    fixture.automations.setFailCode('runtime-conflict')
    const admitted = fixture.admission.admit(signal())
    expect(errorCode(() => fixture.dispatch.wake(admitted.item))).toBe('dispatch-failed')
    expect(fixture.store.getDispatch(admitted.item.id)).toMatchObject({
      state: 'failed',
      reason: 'unknown_after_send',
      wakeAttempts: 1,
      generation: 0,
      eventId: admitted.item.id,
    })
    expect(fixture.store.countDispatchUnknown()).toBe(1)

    // The bounded lazy retry reuses the identical `(eventId, occurredAt)`, so
    // it resolves the occurrence whether or not the first attempt committed.
    fixture.automations.setFailCode('')
    fixture.dispatch.wakePending()
    expect(fixture.store.getDispatch(admitted.item.id)).toMatchObject({
      state: 'dispatched',
      occurrenceId: 'occ-1',
      wakeAttempts: 1,
      generation: 0,
    })
    expect(fixture.store.countDispatchUnknown()).toBe(0)
  })

  test('an unknown wake is retried at most once, then stays failed with its reason', async () => {
    const fixture = await ledgerHarness()
    fixture.automations.setFailCode('runtime-conflict')
    const admitted = fixture.admission.admit(signal())
    expect(errorCode(() => fixture.dispatch.wake(admitted.item))).toBe('dispatch-failed')
    // The first lazy retry re-wakes the same generation and fails again; the
    // sweep itself is best-effort and never throws at the caller.
    expect(fixture.dispatch.wakePending()).toHaveLength(0)
    expect(fixture.store.getDispatch(admitted.item.id)).toMatchObject({
      state: 'failed',
      reason: 'unknown_after_send',
      wakeAttempts: 2,
    })
    expect(fixture.store.countDispatchUnknown()).toBe(1)
    // Bounded: a now-healthy peer cannot make the exhausted row eligible again.
    fixture.automations.setFailCode('')
    expect(fixture.dispatch.wakePending()).toHaveLength(0)
    expect(fixture.automations.calls).toHaveLength(2)
    expect(fixture.store.countDispatchUnknown()).toBe(1)
  })

  test('an ambiguous send stops being reported once its item is withdrawn', async () => {
    const fixture = await ledgerHarness()
    fixture.automations.setFailCode('runtime-conflict')
    const admitted = fixture.admission.admit(signal())
    expect(errorCode(() => fixture.dispatch.wake(admitted.item))).toBe('dispatch-failed')
    expect(fixture.store.countDispatchUnknown()).toBe(1)
    fixture.automations.setFailCode('')
    // The withdrawal settles the item without touching the already-failed
    // dispatch row, which used to keep the counter non-zero forever.
    expect(fixture.store.withdrawByDedupKey(admitted.item.dedupKey).outcome).toBe('withdrawn')
    expect(fixture.store.countDispatchUnknown()).toBe(0)
    expect(fixture.dispatch.wakePending()).toHaveLength(0)
    expect(fixture.automations.calls).toHaveLength(1)
  })

  test('a hard recovery failure still propagates out of the lazy sweep', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    const broken = new WorkItemDispatch({
      config: fixture.config,
      store: fixture.store,
      ledger: fixture.ledger,
      automations: undefined,
      delivery: fixture.delivery.service,
      now: fixture.now,
    })
    // A host missing the automations peer is not a per-row peer failure: the
    // sweep must surface it instead of pretending recovery was attempted.
    expect(errorCode(() => broken.wakePending())).toBe('missing-dependency')
    expect(fixture.store.getDispatch(admitted.item.id)?.state).toBe('pending')
  })

  test('a persisted identity conflict is recorded distinctly instead of hidden', async () => {
    const fixture = await ledgerHarness()
    fixture.automations.setFailCode('idempotency-conflict')
    const admitted = fixture.admission.admit(signal())
    expect(errorCode(() => fixture.dispatch.wake(admitted.item))).toBe('dispatch-failed')
    expect(fixture.store.getDispatch(admitted.item.id)).toMatchObject({
      state: 'failed',
      reason: 'idempotency-conflict',
      generation: 0,
    })
    // It is a hard conflict, not an ambiguous send: never counted as unknown.
    expect(fixture.store.countDispatchUnknown()).toBe(0)
    fixture.automations.setFailCode('')
    expect(fixture.dispatch.wakePending()).toHaveLength(0)
  })

  test('a crash after the peer committed resolves the same occurrence instead of duplicating it', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    // Simulate the peer commit whose local bookkeeping never arrived: the
    // occurrence exists, the dispatch row is still pending.
    const committed = fixture.automations.service.ingestExternal({
      sourceId: SOURCE,
      automationId: WORKER,
      eventId: admitted.item.id,
      occurredAt: admitted.item.createdAt,
    })
    fixture.dispatch.wake(admitted.item)
    expect(fixture.automations.occurrences.size).toBe(1)
    expect(fixture.store.getDispatch(admitted.item.id)).toMatchObject({
      state: 'dispatched',
      occurrenceId: committed.id,
    })
    // A repeated wake of the same generation is the same external event.
    fixture.dispatch.wakePending()
    expect(fixture.automations.occurrences.size).toBe(1)
  })

  test('notifies the owner through delivery with the item binding', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    fixture.dispatch.wake(admitted.item)
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    const report = fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'ready',
      summary: 'Reviewed and merged.',
      artifactPaths: [],
      idempotencyKey: 'report-key-1',
    })
    const item = fixture.store.findItemById(admitted.item.id) as WorkItemRecord
    await expect(fixture.dispatch.notify(item, report.report)).resolves.toBe(true)
    expect(fixture.delivery.enqueues).toHaveLength(1)
    expect(fixture.delivery.enqueues[0]).toMatchObject({
      sourceId: SOURCE,
      workspace: WORKSPACE,
      bindingId: 'binding-origin-1',
      idempotencyKey: report.report.deliveryKey,
      format: 'markdown',
    })
    expect(fixture.delivery.enqueues[0]?.text).toContain(admitted.item.id)
    expect(fixture.delivery.enqueues[0]?.text).toContain('Reviewed and merged.')
    const stored = fixture.store.reports(admitted.item.id)[0]
    expect(stored).toMatchObject({ deliveryState: 'sent', deliveryId: 'outbox-1' })
  })

  test('records a failed owner notification without discarding the report', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    fixture.dispatch.wake(admitted.item)
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    const report = fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'blocked',
      summary: 'Waiting on access.',
      artifactPaths: [],
      idempotencyKey: 'report-key-1',
    })
    fixture.delivery.setFailCode('runtime-conflict')
    const item = fixture.store.findItemById(admitted.item.id) as WorkItemRecord
    await expect(fixture.dispatch.notify(item, report.report)).rejects.toMatchObject({ code: 'dispatch-failed' })
    const stored = fixture.store.reports(admitted.item.id)[0] as WorkItemReportRecord
    expect(stored.deliveryState).toBe('failed')
    expect(fixture.store.reportCount(admitted.item.id)).toBe(1)
  })

  test('skips notification for non-terminal reports', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    fixture.dispatch.wake(admitted.item)
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    const report = fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'progress',
      summary: 'Halfway.',
      artifactPaths: [],
      idempotencyKey: 'report-key-1',
    })
    const item = fixture.store.findItemById(admitted.item.id) as WorkItemRecord
    await expect(fixture.dispatch.notify(item, report.report)).resolves.toBe(false)
    expect(fixture.delivery.enqueues).toHaveLength(0)
  })
})

describe('work-item ledger lifecycle', () => {
  test('claim is CAS-protected, replayable and lease-reclaimed', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    const first = fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    expect(first.replayed).toBe(false)
    expect(first.item).toMatchObject({ state: 'claimed', attempt: 1 })
    const replay = fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    expect(replay.replayed).toBe(true)
    expect(errorCode(() => fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-2', occurrenceId: 'occ-1' })))
      .toBe('claim-conflict')
    fixture.advance(fixture.config.limits.leaseMs + 1)
    fixture.ledger.recover()
    expect(fixture.store.findItemById(admitted.item.id)).toMatchObject({ state: 'queued', stateReason: 'lease-expired' })
    const second = fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-2', occurrenceId: 'occ-1' })
    expect(second.item).toMatchObject({ state: 'claimed', attempt: 2 })
  })

  test('exhausted attempts block the item instead of reclaiming it again', async () => {
    const fixture = await ledgerHarness({ extra: { limits: { maxAttempts: 1, leaseMs: 30_000 } } })
    const admitted = fixture.admission.admit(signal())
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    fixture.advance(30_001)
    fixture.ledger.recover()
    expect(fixture.store.findItemById(admitted.item.id)).toMatchObject({ state: 'blocked', stateReason: 'retry-exhausted' })
  })

  test('reports are idempotent by key and require a claim', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    expect(errorCode(() => fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'ready',
      summary: 'done',
      artifactPaths: [],
      idempotencyKey: 'key-1',
    }))).toBe('claim-conflict')
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    const first = fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'progress',
      summary: 'working',
      artifactPaths: [],
      idempotencyKey: 'key-1',
    })
    expect(first.replayed).toBe(false)
    expect(first.report.revision).toBe(1)
    const replay = fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'progress',
      summary: 'working',
      artifactPaths: [],
      idempotencyKey: 'key-1',
    })
    expect(replay.replayed).toBe(true)
    expect(replay.report.revision).toBe(1)
    expect(fixture.store.reportCount(admitted.item.id)).toBe(1)
    expect(fixture.store.events(admitted.item.id).filter(event => event.kind === 'reported')).toHaveLength(1)
    const second = fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'ready',
      summary: 'done',
      artifactPaths: [],
      idempotencyKey: 'key-2',
    })
    expect(second.report.revision).toBe(2)
    expect(fixture.store.reportCount(admitted.item.id)).toBe(2)
    expect(fixture.store.findItemById(admitted.item.id)).toMatchObject({ state: 'ready', lastReportStatus: 'ready' })
  })

  test('an unclaimed run cannot report', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    expect(errorCode(() => fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'other-run',
      status: 'ready',
      summary: 'done',
      artifactPaths: [],
      idempotencyKey: 'key-1',
    }))).toBe('claim-conflict')
  })

  test('a claim replay never resurrects an expired lease', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    const first = fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    fixture.advance(fixture.config.limits.leaseMs + 1)
    expect(errorCode(() => fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'progress',
      summary: 'too late',
      artifactPaths: [],
      idempotencyKey: 'late-key',
    }))).toBe('claim-expired')
    const reclaimed = fixture.ledger.recover()
    expect(reclaimed.requeued).toContain(admitted.item.id)
    expect(fixture.store.findClaimByRun('run-1')).toMatchObject({ claimId: first.claim.claimId, state: 'expired' })
    expect(fixture.store.events(admitted.item.id).map(event => event.kind)).toContain('claim-expired')
    const second = fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    expect(second.replayed).toBe(false)
    expect(second.claim.claimId).not.toBe(first.claim.claimId)
    expect(second.item).toMatchObject({ state: 'claimed', attempt: 2 })
  })

  test('claiming an exhausted item commits blocked before failing', async () => {
    const fixture = await ledgerHarness({ extra: { limits: { maxAttempts: 1, leaseMs: 30_000 } } })
    const admitted = fixture.admission.admit(signal())
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'waiting',
      summary: 'needs input',
      artifactPaths: [],
      idempotencyKey: 'waiting-key',
    })
    expect(fixture.store.findItemById(admitted.item.id)).toMatchObject({ state: 'waiting', attempt: 1 })
    expect(errorCode(() => fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-2', occurrenceId: 'occ-1' })))
      .toBe('retry-exhausted')
    expect(fixture.store.findItemById(admitted.item.id)).toMatchObject({ state: 'blocked', stateReason: 'retry-exhausted' })
    expect(fixture.store.countOpenItems()).toBe(0)
    expect(fixture.store.events(admitted.item.id).map(event => event.kind)).toContain('blocked')
  })

  test('report idempotency is scoped to the claim', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    const first = fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'progress',
      summary: 'same text',
      artifactPaths: [],
      idempotencyKey: 'shared-key',
    })
    expect(first.report.revision).toBe(1)
    fixture.advance(fixture.config.limits.leaseMs + 1)
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-2', occurrenceId: 'occ-1' })
    const second = fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-2',
      status: 'progress',
      summary: 'same text',
      artifactPaths: [],
      idempotencyKey: 'shared-key',
    })
    expect(second.replayed).toBe(false)
    expect(second.report.revision).toBe(2)
    expect(fixture.store.reportCount(admitted.item.id)).toBe(2)
    const other = fixture.admission.admit(signal({ externalId: 'ext-2' }))
    fixture.ledger.claim({ itemId: other.item.id, runId: 'run-3', occurrenceId: 'occ-2' })
    const isolated = fixture.ledger.report({
      itemId: other.item.id,
      runId: 'run-3',
      status: 'progress',
      summary: 'same text',
      artifactPaths: [],
      idempotencyKey: 'shared-key',
    })
    expect(isolated.replayed).toBe(false)
    expect(isolated.report.revision).toBe(1)
  })

  test('lease recovery re-arms a NEW dispatch generation that really re-runs the worker', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    fixture.dispatch.wake(admitted.item)
    expect(fixture.automations.calls).toHaveLength(1)
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    fixture.advance(fixture.config.limits.leaseMs + 1)
    expect(fixture.ledger.recover().requeued).toContain(admitted.item.id)
    const rearmed = fixture.store.getDispatch(admitted.item.id)
    expect(rearmed).toMatchObject({ state: 'pending', reason: 'lease-expired', generation: 1 })
    expect(rearmed?.eventId).toBe(`${admitted.item.id}#1`)
    expect(rearmed?.occurredAt).toBe(fixture.now())
    fixture.dispatch.wakePending()
    expect(fixture.automations.calls).toHaveLength(2)
    expect(fixture.automations.calls[1]).toEqual({
      sourceId: SOURCE,
      automationId: WORKER,
      eventId: `${admitted.item.id}#1`,
      occurredAt: fixture.now(),
    })
    expect(fixture.store.getDispatch(admitted.item.id)).toMatchObject({
      state: 'dispatched',
      occurrenceId: 'occ-2',
      generation: 1,
    })
    // The new occurrence is a real run: it can claim the item.
    const claim = fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-2', occurrenceId: 'occ-2' })
    expect(claim.item.state).toBe('claimed')
  })

  test('a waiting report schedules one delayed resume and never wakes it early', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    fixture.dispatch.wake(admitted.item)
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'waiting',
      summary: 'Waiting on the upstream review.',
      artifactPaths: [],
      idempotencyKey: 'waiting-key-1',
    })
    const resume = fixture.store.getDispatch(admitted.item.id)
    expect(resume).toMatchObject({ state: 'pending', reason: 'waiting-resume', generation: 1 })
    expect(resume?.occurredAt).toBe(fixture.now() + fixture.config.limits.waitingResumeMs)
    // Not due yet: the lazy sweep must not wake it early.
    expect(fixture.dispatch.wakePending()).toHaveLength(0)
    expect(fixture.automations.calls).toHaveLength(1)
    fixture.advance(fixture.config.limits.waitingResumeMs)
    fixture.dispatch.wakePending()
    expect(fixture.automations.calls).toHaveLength(2)
    expect(fixture.store.getDispatch(admitted.item.id)).toMatchObject({
      state: 'dispatched',
      occurrenceId: 'occ-2',
      generation: 1,
    })
  })

  test('a waiting resume is bounded by the attempt budget', async () => {
    const fixture = await ledgerHarness({ extra: { limits: { maxAttempts: 1, waitingResumeMs: 60_000 } } })
    const admitted = fixture.admission.admit(signal())
    fixture.dispatch.wake(admitted.item)
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    fixture.ledger.report({
      itemId: admitted.item.id,
      runId: 'run-1',
      status: 'waiting',
      summary: 'Waiting again.',
      artifactPaths: [],
      idempotencyKey: 'waiting-key-bounded',
    })
    // The attempt budget is spent, so no further generation is armed.
    expect(fixture.store.getDispatch(admitted.item.id)).toMatchObject({
      state: 'dispatched',
      generation: 0,
    })
    expect(fixture.dispatch.wakePending()).toHaveLength(0)
  })
})

describe('work-item store projection', () => {
  test('reads owner generation from its persisted column', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    expect(fixture.store.findItemById(admitted.item.id)?.owner.generation).toBe(2)
  })

  test('reopens a version 1 database and keeps its claims', async () => {
    const fixture = await ledgerHarness()
    const admitted = fixture.admission.admit(signal())
    fixture.ledger.claim({ itemId: admitted.item.id, runId: 'run-1', occurrenceId: 'occ-1' })
    fixture.store.close()
    // Downgrade the claim table to the previous on-disk shape, then reopen.
    const raw = new DatabaseSync(fixture.config.databasePath)
    raw.exec(`
      ALTER TABLE work_item_claim RENAME TO work_item_claim_v2;
      CREATE TABLE work_item_claim (
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL UNIQUE, occurrence_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'released', 'expired')),
        leased_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(item_id, run_id)
      ) STRICT;
      INSERT INTO work_item_claim(item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at)
        SELECT item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at FROM work_item_claim_v2;
      DROP TABLE work_item_claim_v2;
      DROP TABLE work_item_outcome;
      ALTER TABLE work_item_dispatch RENAME TO work_item_dispatch_v4;
      CREATE TABLE work_item_dispatch (
        item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE RESTRICT,
        automation_id TEXT NOT NULL, event_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'dispatched', 'failed')),
        occurrence_id TEXT, reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(automation_id, event_id)
      ) STRICT;
      INSERT INTO work_item_dispatch(item_id, automation_id, event_id, occurred_at, state, occurrence_id, reason, created_at, updated_at)
        SELECT item_id, automation_id, event_id, occurred_at, state, occurrence_id, reason, created_at, updated_at FROM work_item_dispatch_v4;
      DROP TABLE work_item_dispatch_v4;
      UPDATE work_item_schema_meta SET value = '1' WHERE key = 'schema_version';
      PRAGMA user_version = 1;
    `)
    raw.close()
    const reopened = new WorkItemStore(fixture.config.databasePath, { now: fixture.now })
    closers.push(() => reopened.close())
    expect(reopened.findClaimByRun('run-1')).toMatchObject({ claimId: 1, itemId: admitted.item.id, state: 'active' })
    expect(reopened.findItemById(admitted.item.id)).toMatchObject({ state: 'claimed', owner: { generation: 2 } })
    expect(reopened.stats()).toMatchObject({ items: 1, schemaVersion: 4, outcomes: 0, pendingOutcomes: 0 })
  })
})

describe('work-item workspace artifacts', () => {
  test('rejects an artifact path through a symlink that escapes the work root', async () => {
    const fixture = await ledgerHarness()
    const itemId = 'test-item-1'
    const itemDirectory = fixture.workspace.ensureDirectory(itemId)
    const outside = join(fixture.root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'artifact.txt'), 'evidence')
    await symlink(outside, join(itemDirectory, 'escape'), 'dir')
    const item = { id: itemId, scope: { workspace: WORKSPACE } } as unknown as WorkItemRecord
    expect(errorCode(() => fixture.workspace.validateArtifacts(item, [join(itemDirectory, 'escape', 'artifact.txt')])))
      .toBe('invalid-input')
  })

  test('accepts an artifact inside the item scratch directory', async () => {
    const fixture = await ledgerHarness()
    const itemDirectory = fixture.workspace.ensureDirectory('test-item-2')
    await writeFile(join(itemDirectory, 'artifact.txt'), 'evidence')
    const item = { id: 'test-item-2', scope: { workspace: WORKSPACE } } as unknown as WorkItemRecord
    expect(fixture.workspace.validateArtifacts(item, [join(itemDirectory, 'artifact.txt')]))
      .toEqual([join(itemDirectory, 'artifact.txt')])
  })
})

describe('work-item service identity and tools', () => {
  test('health reflects an active worker and owner route', async () => {
    const fixture = await serviceHarness()
    expect(fixture.service.mode).toBe('active')
    expect(fixture.service.health()).toMatchObject({
      enabled: true,
      openItems: 0,
      workerConnected: true,
      ownerRouteValid: true,
    })
    fixture.service.admit(signal())
    expect(fixture.service.health()).toMatchObject({ openItems: 1 })
    expect(fixture.service.health().lastAdmitAt).not.toBeNull()
  })

  test('observe mode never wakes the worker or notifies the owner', async () => {
    const fixture = await serviceHarness({ mode: 'observe', withAutomations: false })
    const admitted = fixture.service.admit(signal())
    expect(admitted.item.state).toBe('dropped')
    expect(fixture.automations).toBeUndefined()
    expect(fixture.delivery.enqueues).toHaveLength(0)
    expect(fixture.service.health()).toMatchObject({ openItems: 0, workerConnected: false, ownerRouteValid: true })
    expect(() => fixture.service.claim(workerAgent('occ-1'))).toThrowError(
      expect.objectContaining({ code: 'observe-mode' }),
    )
  })

  test('claim and report end to end through the frozen automation identity', async () => {
    const fixture = await serviceHarness()
    fixture.service.admit(signal())
    expect(fixture.automations?.calls).toHaveLength(1)
    const claim = fixture.service.claim(workerAgent('occ-1'))
    expect(claim).toMatchObject({ itemId: expect.stringMatching(/^wi-/), runId: 'occ-1', attempt: 1, replayed: false })
    const report = await fixture.service.report(workerAgent('occ-1'), {
      status: 'ready',
      summary: 'Reviewed and merged.',
      idempotencyKey: 'report-key-1',
    })
    expect(report).toMatchObject({ revision: 1, status: 'ready', state: 'ready', delivery: 'sent', notified: true })
    expect(fixture.delivery.enqueues).toHaveLength(1)
    const replay = await fixture.service.report(workerAgent('occ-1'), {
      status: 'ready',
      summary: 'Reviewed and merged.',
      idempotencyKey: 'report-key-1',
    })
    expect(replay).toMatchObject({ revision: 1, replayed: true, notified: false })
    expect(fixture.delivery.enqueues).toHaveLength(1)
    const status = fixture.service.status(workerAgent('occ-1'))
    expect(status.reports).toHaveLength(1)
    expect(status.openItems).toBe(0)
  })

  test('claim lazily retries an unknown dispatch before resolving its occurrence', async () => {
    const fixture = await serviceHarness()
    fixture.automations?.setFailCode('runtime-conflict')
    const admitted = fixture.service.admit(signal())
    expect(admitted.dispatch).toMatchObject({ state: 'failed', reason: 'unknown_after_send' })
    expect(fixture.service.health().dispatchUnknown).toBe(1)
    fixture.automations?.setFailCode('')
    expect(errorCode(() => fixture.service.claim(workerAgent('occ-1')))).toBeUndefined()
    expect(fixture.service.health().dispatchUnknown).toBe(0)
    expect(fixture.service.health().lastDispatchAt).not.toBeNull()
  })

  test('a waiting report resumes through the claim sweep only once it is due', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.now()
      const fixture = await serviceHarness({ extra: { limits: { waitingResumeMs: 60_000 } } })
      fixture.service.admit(signal())
      fixture.service.claim(workerAgent('occ-1'))
      await fixture.service.report(workerAgent('occ-1'), {
        status: 'waiting',
        summary: 'Waiting on the upstream review.',
        idempotencyKey: 'waiting-e2e',
      })
      expect(fixture.automations?.calls).toHaveLength(1)
      // Halfway through the delay the sweep is still a no-op.
      vi.setSystemTime(start + 30_000)
      expect(errorCode(() => fixture.service.claim(workerAgent('occ-unknown')))).toBe('not-found')
      expect(fixture.automations?.calls).toHaveLength(1)
      // Once due, the ordinary claim traffic re-dispatches a fresh occurrence.
      vi.setSystemTime(start + 60_000)
      expect(errorCode(() => fixture.service.claim(workerAgent('occ-unknown')))).toBe('not-found')
      expect(fixture.automations?.calls).toHaveLength(2)
      expect(fixture.service.claim(workerAgent('occ-2'))).toMatchObject({ attempt: 2, replayed: false })
    } finally {
      vi.useRealTimers()
    }
  })

  test('rejects foreground, preview, foreign and unknown identities', async () => {
    const fixture = await serviceHarness()
    fixture.service.admit(signal())
    expect(errorCode(() => fixture.service.claim(undefined))).toBe('identity-mismatch')
    expect(errorCode(() => fixture.service.claim(foregroundAgent()))).toBe('identity-mismatch')
    expect(errorCode(() => fixture.service.claim(workerAgent('occ-1', WORKER, 'preview')))).toBe('identity-mismatch')
    expect(errorCode(() => fixture.service.claim(workerAgent('occ-1', 'another-worker')))).toBe('identity-mismatch')
    expect(errorCode(() => fixture.service.claim(workerAgent('occ-unknown')))).toBe('not-found')
    expect(fixture.service.claim(workerAgent('occ-1')).itemId).toMatch(/^wi-/)
    expect(errorCode(() => fixture.service.claim(workerAgent('occ-1')))).toBeUndefined()
    expect(errorCode(() => fixture.service.report(workerAgent('occ-1'), {
      status: 'progress',
      summary: 'working',
      idempotencyKey: 'key-1',
    }))).toBeUndefined()
  })

  test('registers the three model tools and executes claim and report', async () => {
    const fixture = await serviceHarness()
    fixture.service.admit(signal())
    const tools = fixture.tools.registered
    expect(tools.map(tool => tool.name)).toEqual(['work_item_claim', 'work_item_report', 'work_item_status'])
    // Settlement stays host-only: no model tool can observe or settle outcomes.
    expect(tools).toHaveLength(3)
    expect(tools.map(tool => tool.name).filter(name => /outcome|settle/.test(name))).toEqual([])
    const claimTool = tools[0] as RegisteredTool
    const claimed = await claimTool.execute({}, { agent: workerAgent('occ-1'), callId: 'call-1', rootCallId: 'root-1' })
    expect(claimed).toMatchObject({ itemId: expect.stringMatching(/^wi-/), runId: 'occ-1', attempt: 1 })
    const reportTool = tools[1] as RegisteredTool
    const reported = await reportTool.execute(
      { status: 'ready', summary: 'Reviewed and merged.' },
      { agent: workerAgent('occ-1'), callId: 'call-2', rootCallId: 'root-2' },
    )
    expect(reported).toMatchObject({ revision: 1, status: 'ready', notified: true, delivery: 'sent' })
    expect(fixture.delivery.enqueues).toHaveLength(1)
    const statusTool = tools[2] as RegisteredTool
    const status = await statusTool.execute({}, { agent: workerAgent('occ-1'), callId: 'call-3', rootCallId: 'root-3' })
    expect(status).toMatchObject({ itemId: claimed['itemId'], state: 'ready', openItems: 0 })
  })
})

describe('outcome settlement end to end', () => {
  const SCOPE = { workspace: WORKSPACE, preset: PRESET, principalId: PRINCIPAL }

  function settlementProvenance() {
    return {
      source: 'owner-foreground-failures',
      sourceVersion: 'assistant-work-items/owner-foreground-failures/v1',
      signalDigest: 'sha256:signal',
      observedAt: 1_700_000_000_000,
      evidence: { inboxId: 'inbox-1', executionStatus: 'failed', completionSequence: 4, authorityHash: 'sha256:authority' },
    }
  }

  function pageWith(items: readonly PeerOwnerForegroundTaskSource[]): PeerOwnerForegroundTaskSourcePage {
    return { items, nextCursor: null, watermark: 0, hasMore: false }
  }

  test('a ready report leaves a pending window until the delivery peer observes the repaired execution', async () => {
    const fixture = await serviceHarness()
    const admitted = fixture.service.admit(signal({ provenance: settlementProvenance() }))
    expect(admitted.item.state).toBe('queued')
    fixture.service.claim(workerAgent('occ-1'))
    await fixture.service.report(workerAgent('occ-1'), {
      status: 'ready',
      summary: 'Repaired the execution.',
      idempotencyKey: 'ready-key-1',
    })
    const pending = fixture.service.status(workerAgent('occ-1')).outcome
    expect(pending?.outcome).toMatchObject({
      revision: 1,
      settledBy: 'report-ready',
      objectiveStatus: 'unknown',
      evidenceState: 'pending',
      inboxId: 'inbox-1',
      baselineSequence: 4,
    })
    expect(fixture.service.health().settlement).toMatchObject({ pending: 1, observed: 0, unverified: 0 })

    const peer: PeerDeliveryService = fixture.delivery
    peer.listOwnerForegroundTaskSources = () => pageWith([{
      protocol: OUTCOME_EVIDENCE_SOURCE,
      inboxId: 'inbox-1',
      sourceDigest: 'sha256:digest',
      completionSequence: 5,
      authorityId: ROUTE,
      authorityHash: 'sha256:authority',
      principalId: PRINCIPAL,
      scope: SCOPE,
      binding: { id: 'binding-1', version: 3, generation: 2, sessionId: 'session-1' },
      execution: { dispatchedAt: 1_700_000_000_000, status: 'succeeded', quiescent: true, completedAt: 1_700_000_100_000, executionRef: 'exec-1' },
    }])
    const report = fixture.service.settleOutcomes(true)
    expect(report).toMatchObject({ skipped: null, degraded: null, failed: false, scanned: 1, settled: 1, expired: 0 })
    const observed = fixture.service.status(workerAgent('occ-1')).outcome
    expect(observed?.outcome).toMatchObject({
      revision: 2,
      settledBy: 'observed-evidence',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      trust: 'external-receipt',
      evidenceState: 'observed',
    })
    expect(fixture.service.outcomes()).toHaveLength(1)
    expect(fixture.service.health().settlement).toMatchObject({ pending: 0, observed: 1, unverified: 0 })
  })

  test('a missing dependency fails the pass as degraded, never as a silent success', async () => {
    const fixture = await serviceHarness()
    const missing = vi.spyOn(WorkItemStore.prototype, 'pendingOutcomes').mockImplementation(() => {
      throw new WorkItemError('missing-dependency', 'assistantDelivery is required to settle outcomes')
    })
    try {
      expect(fixture.service.settleOutcomes(true)).toMatchObject({
        skipped: null,
        degraded: 'missing-dependency',
        failed: true,
        scanned: 0,
        settled: 0,
        expired: 0,
        observedItemIds: [],
      })
    } finally {
      missing.mockRestore()
    }
    const broken = vi.spyOn(WorkItemStore.prototype, 'pendingOutcomes').mockImplementation(() => {
      throw new Error('database is locked')
    })
    try {
      expect(fixture.service.settleOutcomes(true)).toMatchObject({ skipped: null, degraded: null, failed: true })
    } finally {
      broken.mockRestore()
    }
  })

  test('a window that closes on a healthy but silent channel ends unverified, not successful', async () => {
    const realNow = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(realNow)
    try {
      const fixture = await serviceHarness()
      fixture.service.admit(signal({ provenance: settlementProvenance() }))
      fixture.service.claim(workerAgent('occ-1'))
      await fixture.service.report(workerAgent('occ-1'), {
        status: 'ready',
        summary: 'Repaired the execution.',
        idempotencyKey: 'ready-key-2',
      })
      const peer: PeerDeliveryService = fixture.delivery
      peer.listOwnerForegroundTaskSources = () => pageWith([])
      vi.setSystemTime(realNow + 604_800_000 + 60_000)
      const report = fixture.service.settleOutcomes(true)
      expect(report).toMatchObject({ degraded: null, failed: false, settled: 0, expired: 1 })
      expect(fixture.service.status(workerAgent('occ-1')).outcome?.outcome).toMatchObject({
        revision: 2,
        settledBy: 'window-expired',
        evidenceState: 'unverified',
        evidenceReason: 'window-expired',
        objectiveStatus: 'unknown',
      })
      expect(fixture.service.health().settlement).toMatchObject({ pending: 0, observed: 0, unverified: 1 })
    } finally {
      vi.useRealTimers()
    }
  })
})
