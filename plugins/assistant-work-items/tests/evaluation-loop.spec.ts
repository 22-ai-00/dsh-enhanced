import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantEvaluationService, canonicalEvaluationHostScope } from '@dsh-enhanced/assistant-evaluation'
import { WorkItemEvaluationExporter } from '../src/evaluation.ts'
import { settleOutcomes, type SettlementOptions } from '../src/settlement.ts'
import type { PeerDeliveryService, PeerOwnerForegroundTaskSource, PeerOwnerForegroundTaskSourcePage } from '../src/peers.ts'
import { OUTCOME_EVIDENCE_SOURCE } from '../src/outcome.ts'
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
  SETTLE_WINDOW,
  WORKSPACE,
  type Harness,
} from './fixtures.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
})

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

/** Witness the settled item's execution as observed evidence. */
function observedSettlement(fixture: Harness): void {
  const delivery = deliveryPeer({
    listOwnerForegroundTaskSources: () => page({ items: [source()] }),
  })
  const result = settleOutcomes(settlementOptions(fixture, delivery), true)
  expect(result.report).toMatchObject({ settled: 1, failed: false })
}

function exporter(fixture: Harness, overrides: Partial<{ enabled: () => boolean }> = {}): WorkItemEvaluationExporter {
  return new WorkItemEvaluationExporter({
    store: () => fixture.store,
    scope: () => ({ workspace: WORKSPACE, preset: PRESET }),
    enabled: overrides.enabled ?? (() => true),
    now: fixture.now,
  })
}

async function settleCordis(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

function evaluation(ctx: Context): AssistantEvaluationService {
  return new AssistantEvaluationService(ctx, { databasePath: ':memory:', projectionIntervalMs: 0 })
}

describe('work items → Evaluation cross-plugin loop', () => {
  test('projects one settled owner-foreground outcome as a trusted, objective-neutral row', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const outbox = exporter(fixture)
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('assistantWorkItems' as never, outbox as never)
    const service = evaluation(ctx)
    await settleCordis()

    observedSettlement(fixture)
    await outbox.drain()

    const rows = service.query({ scope: { workspace: WORKSPACE, preset: PRESET }, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      situation: 'work-item:review',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      deliveryStatus: 'unknown',
      source: { kind: 'system', id: 'assistant-work-items' },
      trust: 'trusted',
      evaluator: { id: 'assistant-work-items', version: 'settlement-v1' },
    })
    expect(rows[0]!.evidence).toEqual([
      { kind: 'work-item', ref: item.id },
      { kind: 'work-item-outcome', ref: `${item.id}#2`, digest: fixture.store.latestOutcome(item.id)!.evaluationDigest },
    ])
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evaluationState: 'exported' })
    expect(fixture.store.stats()).toMatchObject({ evaluationPending: 0, evaluationExported: 1 })

    // The task view keeps the work-item outcome objective-neutral and independent
    // (no automation-run ref), and the projection outbox holds exactly one item.
    const tasks = service.queryTasks({ scope: { workspace: WORKSPACE, preset: PRESET }, limit: 10 })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      situation: 'work-item:review',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      deliveryStatus: 'unknown',
      trust: 'trusted',
    })
    expect(service.peekPendingProjection({
      scope: canonicalEvaluationHostScope({ workspace: WORKSPACE, preset: PRESET }),
    })).toMatchObject({ evaluationId: rows[0]!.id, attemptCount: 0 })

    // A replayed drain with no new settled revision must not append twice.
    await outbox.drain()
    expect(fixture.store.stats()).toMatchObject({ evaluationExported: 1 })
    expect(service.query({ scope: { workspace: WORKSPACE, preset: PRESET }, limit: 10 })).toHaveLength(1)
  })

  test('leaves an unwitnessed settlement pending and exports it when the sink attaches', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const outbox = exporter(fixture)
    observedSettlement(fixture)
    await outbox.drain()
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      evaluationState: 'pending',
      evaluationAttempts: 0,
    })

    const ctx = new Context(); contexts.push(ctx)
    const service = evaluation(ctx)
    await settleCordis()
    expect(service.query({ scope: { workspace: WORKSPACE, preset: PRESET }, limit: 10 })).toHaveLength(0)

    ctx.provide('assistantWorkItems' as never, outbox as never)
    await settleCordis()
    await outbox.drain()

    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evaluationState: 'exported' })
    const rows = service.query({ scope: { workspace: WORKSPACE, preset: PRESET }, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      objectiveStatus: 'unknown',
      deliveryStatus: 'unknown',
      trust: 'trusted',
    })
  })

  test('never exports while intake is observing, so Evaluation holds no trusted row', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const outbox = exporter(fixture, { enabled: () => false })
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('assistantWorkItems' as never, outbox as never)
    const service = evaluation(ctx)
    await settleCordis()

    observedSettlement(fixture)
    await outbox.drain()

    expect(service.query({ scope: { workspace: WORKSPACE, preset: PRESET }, limit: 10 })).toHaveLength(0)
    expect(fixture.store.stats()).toMatchObject({ evaluationPending: 1, evaluationExported: 0 })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evaluationState: 'pending' })
  })

  test('reports unverified settlements as unknown execution evidence, never as an objective', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    // A healthy but silent witness channel closes the window as `unverified`:
    // the execution status is known, the outcome itself was never observed.
    const delivery = deliveryPeer({ listOwnerForegroundTaskSources: () => page() })
    fixture.advance(SETTLE_WINDOW + 1)
    const result = settleOutcomes(settlementOptions(fixture, delivery), true)
    expect(result.report).toMatchObject({ settled: 0, expired: 1, degraded: null })
    const outbox = exporter(fixture)
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('assistantWorkItems' as never, outbox as never)
    const service = evaluation(ctx)
    await settleCordis()
    await outbox.drain()

    const rows = service.query({ scope: { workspace: WORKSPACE, preset: PRESET }, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      executionStatus: 'unknown',
      objectiveStatus: 'unknown',
      deliveryStatus: 'unknown',
      evaluator: { id: 'assistant-work-items', version: 'unverified-v1' },
    })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'unverified', evaluationState: 'exported' })
  })
})
