import { describe, expect, test, vi } from 'vitest'
import type { PeerDeliveryService, PeerOwnerForegroundTaskSource, PeerOwnerForegroundTaskSourcePage } from '../src/peers.ts'
import { settleOutcomes, type SettlementOptions } from '../src/settlement.ts'
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
  signal,
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

function listing(items: readonly PeerOwnerForegroundTaskSource[], overrides: Partial<PeerOwnerForegroundTaskSourcePage> = {}) {
  const list = vi.fn<NonNullable<PeerDeliveryService['listOwnerForegroundTaskSources']>>(() => page({ items, ...overrides }))
  return { list, delivery: deliveryPeer({ listOwnerForegroundTaskSources: list }) }
}

describe('bounded outcome settlement', () => {
  test('skips a pass inside the sweep interval unless the host forces it', async () => {
    const fixture = await harness()
    await readyItem(fixture)
    const first = settleOutcomes(options(fixture))
    expect(first.report).toMatchObject({ skipped: null, scanned: 1 })
    fixture.advance(1_000)
    const skipped = settleOutcomes(options(fixture))
    expect(skipped.report.skipped).toBe('not-due')
    expect(skipped.report.scanned).toBe(0)
    expect(settleOutcomes(options(fixture), true).report.skipped).toBeNull()
  })

  test('reports no-pending when no window is open', async () => {
    const fixture = await harness()
    const result = settleOutcomes(options(fixture))
    expect(result.report).toMatchObject({ skipped: 'no-pending', scanned: 0, settled: 0, expired: 0 })
    expect(result.observedItemIds).toEqual([])
  })

  test('a missing or unconfigured delivery peer degrades without throwing', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const { validateOwnerRoute, enqueueBackground } = deliveryPeer()
    const barePeer: PeerDeliveryService = { validateOwnerRoute, enqueueBackground }
    for (const delivery of [undefined, barePeer]) {
      const result = settleOutcomes(options(fixture, { delivery }), true)
      expect(result.report).toMatchObject({ degraded: 'missing-dependency', failed: false, scanned: 1, settled: 0 })
      expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'pending' })
    }
    const noScope = settleOutcomes(options(fixture, { scope: null }), true)
    expect(noScope.report.degraded).toBe('missing-dependency')
  })

  test('a revoked owner route degrades and warns but leaves the window pending', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const warn = vi.fn<(message: string) => void>()
    const delivery = deliveryPeer({
      validateOwnerRoute: () => { throw new Error('route revoked') },
      listOwnerForegroundTaskSources: () => page({ items: [source()] }),
    })
    const result = settleOutcomes(options(fixture, { delivery, warn }), true)
    expect(result.report).toMatchObject({ degraded: 'owner-route-unavailable', failed: false, settled: 0 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'pending' })
  })

  test('a throwing delivery page fails the pass, clears the cursor and keeps the window', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    fixture.store.setMeta('settlement.cursor', '{"at":9}')
    const warn = vi.fn<(message: string) => void>()
    const delivery = deliveryPeer({
      listOwnerForegroundTaskSources: () => { throw new Error('peer offline') },
    })
    const result = settleOutcomes(options(fixture, { delivery, warn }), true)
    expect(result.report).toMatchObject({ degraded: null, failed: true, scanned: 1, settled: 0, expired: 0 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(fixture.store.meta('settlement.cursor')).toBeNull()
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'pending' })
  })

  test('matching authenticated evidence appends an observed revision without claiming success', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const { list, delivery } = listing([source()])
    const result = settleOutcomes(options(fixture, { delivery }), true)
    expect(result.report).toMatchObject({ degraded: null, failed: false, scanned: 1, settled: 1, expired: 0 })
    expect(result.observedItemIds).toEqual([item.id])
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      authorityId: ROUTE,
      principalId: PRINCIPAL,
      workspace: WORKSPACE,
      agentPreset: PRESET,
      expectedOwner: expect.objectContaining({ authorityHash: AUTHORITY_HASH }),
    }))
    const latest = fixture.store.latestOutcome(item.id)
    expect(latest).toMatchObject({
      revision: 2,
      settledBy: 'observed-evidence',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      trust: 'external-receipt',
      evidenceState: 'observed',
      inboxId: INBOX,
      baselineSequence: BASELINE_SEQUENCE,
      deadlineAt: null,
    })
    expect(fixture.store.pendingOutcomes(10)).toHaveLength(0)
  })

  test('a receipt for the original failed execution is not evidence', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const { delivery } = listing([source({ completionSequence: BASELINE_SEQUENCE })])
    const result = settleOutcomes(options(fixture, { delivery }), true)
    expect(result.report).toMatchObject({ settled: 0, expired: 0, scanned: 1 })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'pending' })
  })

  test('keeps the highest completion sequence per inbox', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const { delivery } = listing([
      source({ completionSequence: BASELINE_SEQUENCE + 1, sourceDigest: 'sha256:old' }),
      source({ completionSequence: BASELINE_SEQUENCE + 5, sourceDigest: 'sha256:new' }),
    ])
    settleOutcomes(options(fixture, { delivery }), true)
    expect(fixture.store.latestOutcome(item.id)?.evidence).toMatchObject({ sourceDigest: 'sha256:new', completionSequence: BASELINE_SEQUENCE + 5 })
  })

  test('a healthy silence expires the window as unverified, never as success', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const { delivery } = listing([])
    fixture.advance(SETTLE_WINDOW + 1)
    const result = settleOutcomes(options(fixture, { delivery }), true)
    expect(result.report).toMatchObject({ settled: 0, expired: 1, degraded: null, failed: false })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      revision: 2,
      settledBy: 'window-expired',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      evidenceState: 'unverified',
      evidenceReason: 'window-expired',
      deadlineAt: null,
    })
    expect(fixture.store.stats()).toMatchObject({ pendingOutcomes: 0, unverifiedOutcomes: 1 })
  })

  test('a degraded channel records why the window closed', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    fixture.advance(SETTLE_WINDOW + 1)
    const result = settleOutcomes(options(fixture, { delivery: undefined }), true)
    expect(result.report).toMatchObject({ degraded: 'missing-dependency', expired: 1 })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      evidenceState: 'unverified',
      evidenceReason: 'channel-unavailable',
    })
  })

  test('budgets bound scanned windows, fetched sources and appends', async () => {
    const fixture = await harness()
    for (let index = 0; index < 3; index += 1) {
      await readyItem(fixture, {
        externalId: `ext-${index}`,
        provenance: {
          ...signal().provenance!,
          signalDigest: `sha256:signal-${index}`,
        },
      })
    }
    const { list, delivery } = listing([source()], { hasMore: false })
    const bounded = settleOutcomes(options(fixture, { delivery, maxPendingPerSweep: 2, maxSettlementsPerSweep: 1, maxSourcesPerSweep: 7 }), true)
    expect(bounded.report).toMatchObject({ scanned: 2, settled: 1, expired: 0 })
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }))
    expect(fixture.store.stats()).toMatchObject({ pendingOutcomes: 2 })
  })

  test('persists and clears the delivery cursor across passes', async () => {
    const fixture = await harness()
    await readyItem(fixture)
    const first = listing([], { hasMore: true, nextCursor: { at: 42 } })
    settleOutcomes(options(fixture, { delivery: first.delivery }), true)
    expect(JSON.parse(fixture.store.meta('settlement.cursor') ?? 'null')).toEqual({ at: 42 })

    const second = listing([], { hasMore: false })
    fixture.advance(600_001)
    settleOutcomes(options(fixture, { delivery: second.delivery }), true)
    expect(second.list).toHaveBeenCalledWith(expect.objectContaining({ after: { at: 42 } }))
    expect(fixture.store.meta('settlement.cursor')).toBeNull()

    // `hasMore` without a next cursor restarts from the top and stores nothing.
    const dangling = listing([], { hasMore: true, nextCursor: null })
    settleOutcomes(options(fixture, { delivery: dangling.delivery }), true)
    expect(dangling.list).toHaveBeenCalledWith(expect.not.objectContaining({ after: expect.anything() }))
    expect(fixture.store.meta('settlement.cursor')).toBeNull()
  })

  test('expires strictly after the deadline, never exactly on it', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const { delivery } = listing([])
    const deadline = fixture.store.latestOutcome(item.id)?.deadlineAt
    expect(deadline).not.toBeNull()
    fixture.advance((deadline as number) - fixture.now())
    const atBoundary = settleOutcomes(options(fixture, { delivery }), true)
    expect(atBoundary.report).toMatchObject({ settled: 0, expired: 0, scanned: 1 })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'pending' })
    fixture.advance(1)
    const afterBoundary = settleOutcomes(options(fixture, { delivery }), true)
    expect(afterBoundary.report).toMatchObject({ settled: 0, expired: 1 })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceReason: 'window-expired' })
  })

  test('a failed page read still expires overdue windows as channel-unavailable', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const delivery = deliveryPeer({
      listOwnerForegroundTaskSources: () => { throw new Error('peer offline') },
    })
    fixture.advance(SETTLE_WINDOW + 1)
    const result = settleOutcomes(options(fixture, { delivery }), true)
    expect(result.report).toMatchObject({ failed: true, degraded: null, expired: 1, settled: 0 })
    // Terminal by design: a transient read failure can close an overdue window.
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      evidenceState: 'unverified',
      evidenceReason: 'channel-unavailable',
      deadlineAt: null,
    })
  })

  test('a foreign inbox id is never evidence for this item', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const { delivery } = listing([source({ inboxId: 'inbox-2', completionSequence: BASELINE_SEQUENCE + 9 })])
    const result = settleOutcomes(options(fixture, { delivery }), true)
    expect(result.report).toMatchObject({ settled: 0, expired: 0, scanned: 1 })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'pending' })
  })

  test('a receipt minted under a different authority hash leaves the window pending', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    // The receipt and source agree with each other, but neither matches the
    // hash admitted when the window opened: not evidence.
    const rotatedReceipt = deliveryPeer({
      validateOwnerRoute: input => ({ ...deliveryPeer().validateOwnerRoute(input), authorityHash: 'sha256:rotated' }),
      listOwnerForegroundTaskSources: () => page({ items: [source({ authorityHash: 'sha256:rotated' })] }),
    })
    const rotated = settleOutcomes(options(fixture, { delivery: rotatedReceipt }), true)
    expect(rotated.report).toMatchObject({ settled: 0, expired: 0, scanned: 1 })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'pending' })

    // A source whose hash disagrees with the validating receipt is also refused.
    const { delivery } = listing([source({ authorityHash: 'sha256:other' })])
    const mismatched = settleOutcomes(options(fixture, { delivery }), true)
    expect(mismatched.report.settled).toBe(0)
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({ evidenceState: 'pending' })
  })

  test('oversized evidence observes the receipt but records evidence-too-large', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const { delivery } = listing([source({ sourceDigest: `sha256:${'x'.repeat(3_000)}` })])
    const result = settleOutcomes(options(fixture, { delivery }), true)
    expect(result.report).toMatchObject({ settled: 1, expired: 0 })
    expect(fixture.store.latestOutcome(item.id)).toMatchObject({
      revision: 2,
      evidenceState: 'unverified',
      evidenceReason: 'evidence-too-large',
      evidence: null,
    })
  })

  test('settlement appends evidence but never admits, wakes or notifies', async () => {
    const fixture = await harness()
    const item = await readyItem(fixture)
    const enqueue = vi.fn(() => ({ id: 'outbox-1' }))
    const { delivery } = listing([source()])
    const before = fixture.store.stats()
    const result = settleOutcomes(options(fixture, { delivery: { ...delivery, enqueueBackground: enqueue } }), true)
    expect(result.report.settled).toBe(1)
    expect(enqueue).not.toHaveBeenCalled()
    const after = fixture.store.stats()
    expect(after.items).toBe(before.items)
    expect(after.openItems).toBe(before.openItems)
    expect(after.dispatches).toBe(before.dispatches)
    expect(fixture.store.findItemById(item.id)?.state).toBe('ready')
    expect(fixture.store.events(item.id).map(event => event.kind)).toEqual(['admitted', 'claimed', 'reported'])
  })
})
