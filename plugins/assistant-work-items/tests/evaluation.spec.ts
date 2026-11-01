import { describe, expect, test, vi } from 'vitest'
import {
  WORK_ITEM_EVALUATION_MAX_ATTEMPTS,
  WORK_ITEM_EVALUATION_PROTOCOL,
  WorkItemEvaluationExporter,
  workItemEvaluationIdempotencyKey,
  workItemEvaluationSituation,
  type WorkItemEvaluationClaims,
  type WorkItemEvaluationRegistration,
} from '../src/evaluation.ts'
import { OUTCOME_EVIDENCE_SOURCE } from '../src/outcome.ts'
import type { PeerDeliveryService, PeerOwnerForegroundTaskSource, PeerOwnerForegroundTaskSourcePage } from '../src/peers.ts'
import { settleOutcomes, type SettlementOptions } from '../src/settlement.ts'
import {
  AUTHORITY_HASH,
  BASELINE_SEQUENCE,
  deliveryPeer,
  harness,
  INBOX,
  PRINCIPAL,
  PRESET,
  readyItem,
  ROUTE,
  WORKSPACE,
  type Harness,
} from './fixtures.ts'

function source(overrides: Partial<PeerOwnerForegroundTaskSource> = {}): PeerOwnerForegroundTaskSource {
  return {
    protocol: OUTCOME_EVIDENCE_SOURCE,
    inboxId: INBOX,
    sourceDigest: 'sha256:digest',
    completionSequence: BASELINE_SEQUENCE + 1,
    authorityId: ROUTE,
    authorityHash: AUTHORITY_HASH,
    principalId: PRINCIPAL,
    scope: { workspace: WORKSPACE, preset: PRESET },
    binding: { id: 'binding-1', version: 3, generation: 2, sessionId: 'session-1' },
    execution: { dispatchedAt: 1_700_000_000_000, status: 'succeeded', quiescent: true, completedAt: 1_700_000_100_000, executionRef: 'exec-1' },
    ...overrides,
  }
}

function page(overrides: Partial<PeerOwnerForegroundTaskSourcePage> = {}): PeerOwnerForegroundTaskSourcePage {
  return { items: [], nextCursor: null, watermark: 0, hasMore: false, ...overrides }
}

function settlementOptions(fixture: Harness, delivery: PeerDeliveryService): SettlementOptions {
  return {
    store: fixture.store,
    delivery,
    scope: { ownerRouteId: ROUTE, principalId: PRINCIPAL, workspace: WORKSPACE, preset: PRESET },
    sweepIntervalMs: 600_000,
    maxSourcesPerSweep: 25,
    maxPendingPerSweep: 10,
    maxSettlementsPerSweep: 10,
    now: fixture.now,
  }
}

function observedSettlement(fixture: Harness, item: { id: string }): void {
  void item
  const delivery = deliveryPeer({
    listOwnerForegroundTaskSources: () => page({ items: [source()] }),
  })
  const result = settleOutcomes(settlementOptions(fixture, delivery), true)
  expect(result.report).toMatchObject({ settled: 1, failed: false })
}

interface SinkHarness {
  readonly registration: WorkItemEvaluationRegistration
  readonly claims: WorkItemEvaluationClaims[]
  readonly appends: number
}

function registrationOwner(owns: boolean): WorkItemEvaluationRegistration['owner'] {
  return {
    ownsTrustedAutomationEvaluationRegistration: () => false,
    ownsTrustedDeliveryEvaluationRegistration: () => false,
    ownsTrustedVerifierEvaluationRegistration: () => false,
    ownsTrustedWorkItemEvaluationRegistration: () => owns,
  }
}

function sink(
  generation: string,
  overrides: { append?: (claims: Readonly<WorkItemEvaluationClaims>) => Promise<void> } = {},
): SinkHarness {
  const claims: WorkItemEvaluationClaims[] = []
  const state = { appends: 0 }
  const registration = Object.freeze({
    protocol: WORK_ITEM_EVALUATION_PROTOCOL as typeof WORK_ITEM_EVALUATION_PROTOCOL,
    generation,
    owner: registrationOwner(true),
    append: async (incoming: Readonly<WorkItemEvaluationClaims>) => {
      state.appends += 1
      if (overrides.append !== undefined) return overrides.append(incoming)
      claims.push(incoming as WorkItemEvaluationClaims)
    },
  })
  return {
    registration,
    claims,
    get appends() { return state.appends },
  }
}

/** Let a fire-and-forget registration pass settle before the next assertion. */
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

function exporter(fixture: Harness, overrides: Partial<{
  scope: () => { workspace: string; preset: string } | null
  enabled: () => boolean
}> = {}): WorkItemEvaluationExporter {
  return new WorkItemEvaluationExporter({
    store: () => fixture.store,
    scope: () => ({ workspace: WORKSPACE, preset: PRESET }),
    enabled: () => true,
    now: fixture.now,
    ...overrides,
  })
}

describe('trusted work-item Evaluation export', () => {
  test('exports exactly one observed settlement and never a pending window', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const outbox = exporter(fixture)
    const target = sink(outbox.generation)
    outbox.registerTrustedWorkItemEvaluationSink(target.registration)
    await flush()
    await outbox.drain()
    // The `ready` report left a pending window; exporting it would publish a
    // revision that later evidence can contradict.
    expect(target.claims).toHaveLength(0)
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'pending', evaluationState: 'pending' })

    observedSettlement(fixture, item)
    await outbox.drain()
    expect(target.claims).toHaveLength(1)
    const [claims] = target.claims
    expect(claims).toMatchObject({
      scope: { workspace: WORKSPACE, preset: PRESET },
      itemId: item.id,
      outcomeRevision: 2,
      settledBy: 'observed-evidence',
      evidenceState: 'observed',
      situation: workItemEvaluationSituation('review'),
      objectiveStatus: 'unknown',
      deliveryStatus: 'unknown',
    })
    expect(claims!.idempotencyKey).toBe(workItemEvaluationIdempotencyKey(item.id, 2, 'observed'))
    expect(claims!.metrics.latencyMs).toBeGreaterThanOrEqual(0)
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      evaluationState: 'exported',
      evaluationDigest: claims!.digest,
      evaluationAttempts: 0,
    })
    expect(fixture.store.stats()).toMatchObject({ evaluationPending: 0, evaluationExported: 1, evaluationSkipped: 0 })
  })

  test('derives the situation from the admitted kind instead of a fixed string', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture, { kind: 'triage' })
    observedSettlement(fixture, item)
    const outbox = exporter(fixture)
    const target = sink(outbox.generation)
    outbox.registerTrustedWorkItemEvaluationSink(target.registration)
    await outbox.drain()
    expect(target.claims[0]!.situation).toBe('work-item:triage')
  })

  test('publishes deterministic identity for a replayed store revision', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    observedSettlement(fixture, item)
    const outcome = fixture.store.latestOutcome(item.id)!
    const first = workItemEvaluationIdempotencyKey(outcome.itemId, outcome.revision, 'observed')
    expect(workItemEvaluationIdempotencyKey(outcome.itemId, outcome.revision, 'observed')).toBe(first)
    expect(first).toBe(`work-items/${item.id}/2/observed`)
  })

  test('leaves a failed append pending with a capped attempt count and visible degradation', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const warn = vi.fn<(message: string) => void>()
    const outbox = new WorkItemEvaluationExporter({
      store: () => fixture.store,
      scope: () => ({ workspace: WORKSPACE, preset: PRESET }),
      enabled: () => true,
      now: fixture.now,
      warn,
    })
    const target = sink(outbox.generation, { append: () => Promise.reject(new Error('evaluation offline')) })
    outbox.registerTrustedWorkItemEvaluationSink(target.registration)
    await flush()
    observedSettlement(fixture, item)
    await outbox.drain()
    expect(outbox.degraded).toBe('evaluation offline')
    expect(warn).toHaveBeenCalled()
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evaluationState: 'pending', evaluationAttempts: 1 })
    for (let attempt = 2; attempt <= WORK_ITEM_EVALUATION_MAX_ATTEMPTS; attempt += 1) {
      await outbox.drain()
      expect(fixture.store.latestOutcome(item.id)).toMatchObject({
        evaluationState: 'pending',
        evaluationAttempts: attempt,
      })
    }
    // Capped: the row is not hammered forever and stays visible as degraded.
    await outbox.drain()
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      evaluationState: 'pending',
      evaluationAttempts: WORK_ITEM_EVALUATION_MAX_ATTEMPTS,
    })
    expect(outbox.degraded).toBe('export-attempts-exhausted')
  })

  test('marks settled revisions skipped when this deployment has no exact scope', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const outbox = exporter(fixture, { scope: () => null })
    const target = sink(outbox.generation)
    outbox.registerTrustedWorkItemEvaluationSink(target.registration)
    await flush()
    observedSettlement(fixture, item)
    await outbox.drain()
    expect(target.claims).toHaveLength(0)
    expect(outbox.degraded).toBe('owner-route-unavailable')
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evaluationState: 'skipped', evaluationDigest: null })
    expect(fixture.store.stats()).toMatchObject({ evaluationPending: 0, evaluationExported: 0, evaluationSkipped: 1 })
  })

  test('observe mode exports nothing and leaves the outbox untouched', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    observedSettlement(fixture, item)
    const outbox = exporter(fixture, { enabled: () => false })
    const target = sink(outbox.generation)
    outbox.registerTrustedWorkItemEvaluationSink(target.registration)
    await outbox.drain()
    expect(target.claims).toHaveLength(0)
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evaluationState: 'pending' })
  })

  test('validates protocol, generation, ownership, and single registration', async () => {
    const fixture = await harness()
    const outbox = exporter(fixture)
    const valid = sink(outbox.generation)
    expect(() => outbox.registerTrustedWorkItemEvaluationSink({
      ...valid.registration,
      protocol: 'assistant-work-items/evaluation/v0' as never,
    })).toThrow(/protocol/)
    expect(() => outbox.registerTrustedWorkItemEvaluationSink({
      ...valid.registration,
      generation: 'stale-generation',
    })).toThrow(/generation/)
    expect(() => outbox.registerTrustedWorkItemEvaluationSink({
      ...valid.registration,
      owner: registrationOwner(false),
    })).toThrow(/owned/)
    outbox.registerTrustedWorkItemEvaluationSink(valid.registration)
    expect(() => outbox.registerTrustedWorkItemEvaluationSink(valid.registration)).toThrow(/already registered/)
  })

  test('a withdrawn sink stops receiving and a stale disposer is a no-op', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const outbox = exporter(fixture)
    const first = sink(outbox.generation)
    const dispose = outbox.registerTrustedWorkItemEvaluationSink(first.registration)
    const second = sink(outbox.generation)
    dispose()
    expect(() => outbox.registerTrustedWorkItemEvaluationSink(second.registration)).not.toThrow()
    // The first disposer already ran; it must not clear the newer registration.
    dispose()
    expect(outbox.connected).toBe(true)
    observedSettlement(fixture, item)
    await outbox.drain()
    expect(first.claims).toHaveLength(0)
    expect(second.claims).toHaveLength(1)
  })

  test('serializes concurrent drains without double exporting', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    observedSettlement(fixture, item)
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const outbox = exporter(fixture)
    const target = sink(outbox.generation, {
      append: async () => { await gate },
    })
    outbox.registerTrustedWorkItemEvaluationSink(target.registration)
    const first = outbox.drain()
    const second = outbox.drain()
    expect(second).not.toBe(first)
    release!()
    await first
    await second
    expect(target.appends).toBe(1)
  })

  test('an exhausted revision does not starve a newer settlement behind it', async () => {
    const fixture = await harness()
    const first = await readyItem(fixture)
    let fail = true
    const outbox = exporter(fixture)
    const target = sink(outbox.generation, {
      append: async () => {
        if (fail) throw new Error('evaluation offline')
      },
    })
    outbox.registerTrustedWorkItemEvaluationSink(target.registration)
    await flush()
    observedSettlement(fixture, first)
    for (let attempt = 0; attempt < WORK_ITEM_EVALUATION_MAX_ATTEMPTS; attempt += 1) await outbox.drain()
    expect(fixture.store.latestOutcome(first.id)).toMatchObject({
      evaluationState: 'pending',
      evaluationAttempts: WORK_ITEM_EVALUATION_MAX_ATTEMPTS,
    })

    const second = await readyItem(fixture)
    observedSettlement(fixture, second)
    fail = false
    await outbox.drain()
    // The stale row keeps its bounded attempt count but releases its sweep slot,
    // so newer evidence still reaches the trusted lane.
    expect(target.appends).toBe(WORK_ITEM_EVALUATION_MAX_ATTEMPTS + 1)
    expect(fixture.store.latestOutcome(first.id)).toMatchObject({
      evaluationState: 'pending',
      evaluationAttempts: WORK_ITEM_EVALUATION_MAX_ATTEMPTS,
    })
    expect(fixture.store.latestOutcome(second.id)).toMatchObject({ evaluationState: 'exported' })
  })

  test('a store fault during a pass is degraded health, not a rejected drain', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    observedSettlement(fixture, item)
    const outbox = exporter(fixture)
    const target = sink(outbox.generation)
    const spy = vi.spyOn(fixture.store, 'findItemById').mockImplementation(() => {
      throw new Error('ledger read failed')
    })
    try {
      outbox.registerTrustedWorkItemEvaluationSink(target.registration)
      await flush()
      await expect(outbox.drain()).resolves.toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    expect(target.claims).toHaveLength(0)
    expect(outbox.degraded).toBe('ledger read failed')
    await outbox.drain()
    expect(target.claims).toHaveLength(1)
  })

  test('a work-item claim cannot express an objective upgrade', () => {
    const claims: WorkItemEvaluationClaims = {
      scope: { workspace: WORKSPACE, preset: PRESET },
      itemId: 'item-1',
      outcomeRevision: 2,
      settledBy: 'observed-evidence',
      evidenceState: 'observed',
      situation: 'work-item:review',
      occurredAt: 1,
      idempotencyKey: 'work-items/item-1/2/observed',
      digest: '0'.repeat(64),
      metrics: {},
      objectiveStatus: 'unknown',
      deliveryStatus: 'unknown',
    }
    const accepted: WorkItemEvaluationClaims = claims
    expect(accepted.objectiveStatus).toBe('unknown')
    // @ts-expect-error - the claim type is incapable of asserting an objective
    const upgraded: WorkItemEvaluationClaims = { ...claims, objectiveStatus: 'achieved' }
    void upgraded
  })
})
