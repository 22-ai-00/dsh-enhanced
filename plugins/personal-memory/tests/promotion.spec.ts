import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import {
  PREFERENCE_MEMORY_PROMOTION_CONTENT,
  PREFERENCE_MEMORY_PROMOTION_PROTOCOL,
  PREFERENCE_MEMORY_PROMOTION_RENDERER_ID,
  brandPreferenceMemoryPromotionProducer,
  unbrandPreferenceMemoryPromotionProducer,
  withPreferenceMemoryPromotionCancellationDigest,
  withPreferenceMemoryPromotionCancellationReceiptDigest,
  withPreferenceMemoryPromotionRequestDigest,
  type PreferenceMemoryPromotionProducer,
  type PreferenceMemoryPromotionRegistration,
  type PreferenceMemoryPromotionRequest,
} from '@dsh-enhanced/assistant-growth-contract'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryProposalManager } from '../src/proposals.ts'
import { PreferenceMemoryPromotionBridge, preferencePromotionMutation } from '../src/promotion.ts'
import {
  memoryPrincipalDigest,
  MemoryStore,
  type MemoryStoreError,
} from '../src/store.ts'
import type {
  MemoryMutation,
  MemoryOwnerNamespace,
  MemoryProposalInput,
  StoredMemoryPromotionResult,
} from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []
const stores = new Set<MemoryStore>()
const principal = 'lark/main/tenant/owner'
const scope = Object.freeze({ workspace: '/work/alpha', preset: 'primary' })
const namespace: MemoryOwnerNamespace = Object.freeze({
  mode: 'delivery',
  principalDigest: memoryPrincipalDigest(principal),
  principalRecordId: 'principal-row-owner',
  principalVersion: 1,
})
const dispatch = Object.freeze({
  routeVersion: 2 as const,
  sourceId: 'dsh-enhanced-personal-memory',
  bindingId: 'binding-owner',
  bindingVersion: 1,
  bindingGeneration: 1,
  workspace: scope.workspace,
  principal,
  principalRecordId: namespace.mode === 'delivery' ? namespace.principalRecordId : '',
  principalVersion: namespace.mode === 'delivery' ? namespace.principalVersion : 0,
})

afterEach(async () => {
  for (const store of stores) store.close()
  stores.clear()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function promotionMutation(observedAt: number): MemoryMutation {
  return Object.freeze({
    op: 'add' as const,
    identity: Object.freeze({
      owner: 'user' as const,
      scope: 'workspace' as const,
      workspace: scope.workspace,
    }),
    entry: Object.freeze({
      kind: 'preference' as const,
      content: PREFERENCE_MEMORY_PROMOTION_CONTENT,
      sensitivity: 'private' as const,
      trust: 'user-confirmed' as const,
      confidence: 1,
      provenance: Object.freeze({
        source: 'preference-learning:memory.retention.long-term/v1',
        observedAt,
      }),
    }),
  })
}

function promotionInput(index: number, observedAt: number): MemoryProposalInput {
  return Object.freeze({
    idempotencyKey: `preference-memory-promotion:${index}`,
    requester: 'preference-learning',
    principal,
    namespace,
    dispatch,
    ttlMs: 60_000,
    notAfter: observedAt + 60_000,
    promotion: Object.freeze({
      promotionId: `promotion-${index}`,
      promotionGeneration: 1,
      requestDigest: index.toString(16).padStart(64, '0'),
      scope,
      ownerGeneration: 1,
    }),
    mutation: promotionMutation(observedAt),
  })
}

function wireRequest(index = 1): Readonly<PreferenceMemoryPromotionRequest> {
  return withPreferenceMemoryPromotionRequestDigest({
    contractVersion: 1 as const,
    promotionId: `promotion-wire-${index}`,
    promotionGeneration: 1,
    idempotencyKey: `preference-memory-wire:${index}`,
    scope,
    principalId: principal,
    principalLineage: Object.freeze({
      principalRecordId: 'principal-row-owner',
      principalVersion: 1,
    }),
    ownerGeneration: 1,
    hypothesis: Object.freeze({
      id: `preference-hypothesis-${index}`,
      key: 'memory.retention' as const,
      value: 'long-term' as const,
      version: 2,
      confidenceBps: 8_500,
      contradictionBps: 500,
      supportingSignals: 3,
      distinctSignalSources: 2,
      evidenceMass: 3,
    }),
    rendererId: PREFERENCE_MEMORY_PROMOTION_RENDERER_ID,
    observedAt: 100_000,
    deadlineAt: 160_000,
  })
}

async function harness(options: {
  now?: number
  validatePromotionOwner?: ConstructorParameters<typeof MemoryProposalManager>[2]
} = {}) {
  let now = options.now ?? 100_000
  const root = await mkdtemp(join(tmpdir(), 'personal-memory-promotion-'))
  const memoryPath = join(root, 'memory.sqlite')
  const policyPath = join(root, 'policy.sqlite')
  const ctx = new Context()
  const store = new MemoryStore({ path: memoryPath, now: () => now })
  const policy = new AssistantPolicyService(ctx, { databasePath: policyPath, rules: [] }, { now: () => now })
  roots.push(root)
  contexts.push(ctx)
  stores.add(store)
  return {
    ctx,
    memoryPath,
    policy,
    store,
    manager: new MemoryProposalManager(
      store,
      policy,
      options.validatePromotionOwner ?? (() => 'current'),
    ),
    setNow(value: number) { now = value },
  }
}

function assertNoRecordFields(result: StoredMemoryPromotionResult): void {
  expect(result).not.toHaveProperty('memoryRecordId')
  expect(result).not.toHaveProperty('memoryRecordVersion')
  expect(result).not.toHaveProperty('memoryRecordDigest')
}

describe('preference Memory promotion durability', () => {
  test('binds a forwarding proxy to its canonical producer without exposing the registration', () => {
    let registration: Readonly<PreferenceMemoryPromotionRegistration> | undefined
    let intercepted: Readonly<PreferenceMemoryPromotionRegistration> | undefined
    const producer: PreferenceMemoryPromotionProducer = {
      trustedMemoryPromotionProducerGeneration: () => 'preference-generation:canonical',
      registerTrustedMemoryPromotionResultSink(value) {
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }
    brandPreferenceMemoryPromotionProducer(producer)
    const proxy = new Proxy(producer, {
      get(target, property, receiver) {
        if (property === 'registerTrustedMemoryPromotionResultSink') {
          return (value: Readonly<PreferenceMemoryPromotionRegistration>) => {
            intercepted = value
            return () => {}
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const bridge = new PreferenceMemoryPromotionBridge({
      submit: () => { throw new Error('not called') },
      cancel: () => { throw new Error('not called') },
      list: () => [],
      acknowledge() {},
    })

    const dispose = bridge.bind(proxy)
    expect(dispose).toBeTypeOf('function')
    expect(registration).toBeDefined()
    expect(intercepted).toBeUndefined()

    unbrandPreferenceMemoryPromotionProducer(producer)
    expect(bridge.bind(proxy)).toBeUndefined()
    expect(() => registration!.listTerminalResults(1))
      .toThrow(/stale Preference promotion capability/iu)
    dispose?.()
    bridge.dispose()
  })

  test('mints one exact owned registration and revokes copied or stale capabilities', () => {
    let registration: Readonly<PreferenceMemoryPromotionRegistration> | undefined
    let generation = 'preference-generation:1'
    let unregisterCalls = 0
    const producer: PreferenceMemoryPromotionProducer = {
      trustedMemoryPromotionProducerGeneration: () => generation,
      registerTrustedMemoryPromotionResultSink(value) {
        if (!value.owner.ownsPreferencePromotionSourceRegistration(value)) {
          throw new Error('registration must be owned by Personal Memory')
        }
        registration = value
        return () => {
          unregisterCalls += 1
          if (registration === value) registration = undefined
        }
      },
    }
    const bridge = new PreferenceMemoryPromotionBridge({
      submit: request => Object.freeze({
        contractVersion: 1,
        promotionId: request.promotionId,
        promotionGeneration: request.promotionGeneration,
        requestDigest: request.requestDigest,
        outcome: 'accepted',
        memoryProposalId: 'memory-proposal-1',
        receiptDigest: 'a'.repeat(64),
      }),
      cancel: request => Object.freeze({
        contractVersion: 1,
        promotionId: request.promotionId,
        promotionGeneration: request.promotionGeneration,
        requestDigest: request.requestDigest,
        cancellationDigest: request.cancellationDigest,
        outcome: 'cancelled',
        receiptDigest: 'b'.repeat(64),
      }),
      list: () => [],
      acknowledge() {},
    }, value => value === producer ? producer : undefined)

    const dispose = bridge.bind(producer)!
    const exact = registration!
    expect(exact).toMatchObject({
      protocol: PREFERENCE_MEMORY_PROMOTION_PROTOCOL,
      producer: 'personal-memory',
      sourceGeneration: generation,
    })
    expect(bridge.ownsPreferencePromotionSourceRegistration(exact)).toBe(true)
    expect(bridge.ownsPreferencePromotionSourceRegistration({ ...exact })).toBe(false)
    expect(bridge.bind(producer)).toBe(dispose)

    generation = 'preference-generation:2'
    expect(() => exact.listTerminalResults(1)).toThrow(/stale Preference promotion capability/iu)
    dispose()
    dispose()
    expect(unregisterCalls).toBe(1)
    expect(bridge.ownsPreferencePromotionSourceRegistration(exact)).toBe(false)
    bridge.dispose()
  })

  test('derives the only allowed fixed renderer without accepting caller-controlled Memory authority', () => {
    const request = wireRequest()

    expect(preferencePromotionMutation(request)).toEqual({
      op: 'add',
      identity: { owner: 'user', scope: 'workspace', workspace: scope.workspace },
      entry: {
        kind: 'preference',
        content: PREFERENCE_MEMORY_PROMOTION_CONTENT,
        sensitivity: 'private',
        trust: 'user-confirmed',
        confidence: 0.85,
        provenance: {
          source: `preference-learning:${PREFERENCE_MEMORY_PROMOTION_RENDERER_ID}`,
          observedAt: request.observedAt,
          uri: `preference://${request.hypothesis.id}/v${request.hypothesis.version}`,
        },
      },
    })
    expect(() => preferencePromotionMutation({
      ...request,
      rendererId: 'caller-controlled-renderer',
    } as never)).toThrow(/renderer|contract/iu)
    expect(() => preferencePromotionMutation({
      ...request,
      hypothesis: { ...request.hypothesis, key: 'response.structure' },
    } as never)).toThrow(/allowlist/iu)
  })

  test('stays pending until approval commits the fixed rendered record, then exposes confirmed', async () => {
    const fixture = await harness()
    const input = promotionInput(1, 100_000)

    const submitted = fixture.manager.propose(input)

    expect(submitted).toMatchObject({ status: 'pending', version: 1, replayed: false })
    expect(submitted.mutation).toEqual(promotionMutation(100_000))
    expect(fixture.store.list(namespace, input.mutation.identity)).toEqual([])
    expect(fixture.store.listPendingPromotionResults(10)).toEqual([])

    const committed = fixture.manager.decide({
      proposalId: submitted.proposalId,
      principal,
      expectedVersion: submitted.version,
      decision: 'approved',
      reason: 'owner explicitly confirmed durable retention',
    })

    expect(committed.record).toMatchObject({
      namespace,
      owner: 'user',
      scope: 'workspace',
      workspace: scope.workspace,
      kind: 'preference',
      content: PREFERENCE_MEMORY_PROMOTION_CONTENT,
      sensitivity: 'private',
      trust: 'user-confirmed',
      confidence: 1,
    })
    const [terminal] = fixture.store.listPendingPromotionResults(10)
    expect(terminal).toMatchObject({
      contractVersion: 1,
      ...input.promotion,
      namespace,
      resultVersion: 1,
      status: 'confirmed',
      memoryProposalId: submitted.proposalId,
      memoryProposalVersion: committed.version,
      memoryRecordId: committed.record!.id,
      memoryRecordVersion: committed.record!.version,
      memoryRecordDigest: committed.record!.contentHash,
      state: 'pending',
      attemptCount: 0,
    })
    expect(terminal?.receiptDigest).toMatch(/^[0-9a-f]{64}$/u)
  })

  test.each([
    ['rejected', 'rejected'],
    ['expired', 'expired'],
    ['conflicted', 'conflicted'],
  ] as const)('projects %s distinctly without creating a Memory record', async (kind, expectedStatus) => {
    const fixture = await harness()
    const input = promotionInput(kind === 'rejected' ? 2 : kind === 'expired' ? 3 : 4, 100_000)
    const pending = fixture.manager.propose(input)

    if (kind === 'rejected') {
      fixture.manager.decide({
        proposalId: pending.proposalId, principal, expectedVersion: pending.version,
        decision: 'rejected', reason: 'owner rejected promotion',
      })
    } else if (kind === 'expired') {
      fixture.setNow(input.notAfter!)
      fixture.manager.decide({
        proposalId: pending.proposalId, principal, expectedVersion: pending.version,
        decision: 'approved', reason: 'too late',
      })
    } else {
      fixture.store.settleProposal({ proposalId: pending.proposalId, policyStatus: 'conflicted' })
    }

    expect(fixture.store.list(namespace, input.mutation.identity)).toEqual([])
    const [terminal] = fixture.store.listPendingPromotionResults(10)
    expect(terminal).toMatchObject({
      ...input.promotion,
      status: expectedStatus,
      memoryProposalId: pending.proposalId,
      state: 'pending',
    })
    assertNoRecordFields(terminal!)
  })

  test('fences an old binding generation before an approved proposal can write Memory', async () => {
    let currentGeneration = 1
    const fixture = await harness({
      validatePromotionOwner(proposal) {
        return proposal.promotion?.ownerGeneration === currentGeneration
          ? 'current'
          : 'stale-owner'
      },
    })
    const input = promotionInput(5, 100_000)
    const pending = fixture.manager.propose(input)

    currentGeneration = 3
    const settled = fixture.manager.decide({
      proposalId: pending.proposalId,
      principal,
      expectedVersion: pending.version,
      decision: 'approved',
      reason: 'approval raced owner rotation',
    })

    expect(settled).toMatchObject({ status: 'conflicted' })
    expect(settled).not.toHaveProperty('record')
    expect(fixture.store.list(namespace, input.mutation.identity)).toEqual([])
    const [terminal] = fixture.store.listPendingPromotionResults(10)
    expect(terminal).toMatchObject({
      ...input.promotion,
      namespace,
      status: 'stale-owner',
      state: 'pending',
    })
    assertNoRecordFields(terminal!)
  })

  test('persists unacknowledged results across retry and restart, then completes one exact ACK', async () => {
    const fixture = await harness()
    const input = promotionInput(6, 100_000)
    const pending = fixture.manager.propose(input)
    fixture.manager.decide({
      proposalId: pending.proposalId, principal, expectedVersion: pending.version,
      decision: 'approved', reason: 'confirmed',
    })
    const first = fixture.store.listPendingPromotionResults(10)[0]!

    fixture.setNow(100_100)
    expect(fixture.store.deferPromotionResult(first, 'result acknowledgement lost')).toBe(true)
    const retried = fixture.store.listPendingPromotionResults(10)[0]!
    expect(retried).toMatchObject({
      promotionId: first.promotionId,
      promotionGeneration: first.promotionGeneration,
      resultVersion: first.resultVersion,
      receiptDigest: first.receiptDigest,
      attemptCount: 1,
      state: 'pending',
    })
    expect(() => fixture.store.completePromotionResult(first))
      .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'version-conflict' }))
    expect(() => fixture.store.completePromotionResult({
      ...retried, receiptDigest: 'f'.repeat(64),
    })).toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'version-conflict' }))

    fixture.store.close()
    const reopened = new MemoryStore({ path: fixture.memoryPath, now: () => 100_200 })
    stores.add(reopened)
    const recovered = reopened.listPendingPromotionResults(10)[0]!
    expect(recovered).toEqual(retried)
    expect(reopened.completePromotionResult(recovered)).toBe(true)
    expect(reopened.listPendingPromotionResults(10)).toEqual([])
    const completed = reopened.getPromotionResult(
      recovered.promotionId, recovered.promotionGeneration, recovered.resultVersion,
    )!
    expect(completed).toMatchObject({ state: 'completed', attemptCount: 1 })
    expect(reopened.completePromotionResult(completed)).toBe(false)
    expect(reopened.list(namespace, input.mutation.identity)).toHaveLength(1)
  })

  test('durably compensates an exact confirmed promotion before ACK and never removes changed records', async () => {
    const fixture = await harness()
    const input = promotionInput(60, 100_000)
    const pending = fixture.manager.propose(input)
    const committed = fixture.manager.decide({
      proposalId: pending.proposalId, principal, expectedVersion: pending.version,
      decision: 'approved', reason: 'confirmed before acknowledgement loss',
    })
    const terminal = fixture.store.listPendingPromotionResults(10)[0]!
    expect(committed.record).toBeDefined()
    expect(fixture.store.list(namespace, input.mutation.identity)).toHaveLength(1)
    const cancellation = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const,
      promotionId: input.promotion!.promotionId,
      promotionGeneration: input.promotion!.promotionGeneration,
      requestDigest: input.promotion!.requestDigest,
      principalLineage: {
        principalRecordId: namespace.mode === 'delivery' ? namespace.principalRecordId : '',
        principalVersion: namespace.mode === 'delivery' ? namespace.principalVersion : 0,
      },
      ownerGeneration: input.promotion!.ownerGeneration,
      reason: 'forget' as const,
      occurredAt: 100_001,
    })
    const legacyReceipt = withPreferenceMemoryPromotionCancellationReceiptDigest({
      contractVersion: 1 as const, promotionId: cancellation.promotionId,
      promotionGeneration: cancellation.promotionGeneration, requestDigest: cancellation.requestDigest,
      cancellationDigest: cancellation.cancellationDigest, outcome: 'already-confirmed' as const,
    })
    const wrongDigest = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const, promotionId: input.promotion!.promotionId,
      promotionGeneration: input.promotion!.promotionGeneration, requestDigest: 'f'.repeat(64),
      principalLineage: cancellation.principalLineage,
      ownerGeneration: input.promotion!.ownerGeneration, reason: 'forget' as const, occurredAt: 100_001,
    })
    expect(() => fixture.store.cancelPromotionBeforeOrAfterSubmit(wrongDigest))
      .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'idempotency-conflict' }))
    expect(fixture.store.get(namespace, input.mutation.identity, committed.record!.id))
      .toMatchObject({ status: 'active', version: 1 })
    const legacy = new DatabaseSync(fixture.memoryPath)
    legacy.prepare(`
      INSERT INTO memory_promotion_cancellations(
        promotion_id, promotion_generation, request_digest, principal_record_id, principal_version,
        owner_generation, cancellation_digest, reason, occurred_at, receipt_digest, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cancellation.promotionId, cancellation.promotionGeneration, cancellation.requestDigest,
      cancellation.principalLineage.principalRecordId, cancellation.principalLineage.principalVersion,
      cancellation.ownerGeneration, cancellation.cancellationDigest, cancellation.reason,
      cancellation.occurredAt, legacyReceipt.receiptDigest, 100_001, 100_001,
    )
    legacy.close()

    expect(fixture.store.cancelPromotionBeforeOrAfterSubmit(cancellation))
      .toMatchObject({ outcome: 'cancelled', receipt: { outcome: 'cancelled' } })
    expect(fixture.store.get(namespace, input.mutation.identity, committed.record!.id)).toBeUndefined()
    expect(fixture.store.search({
      context: { workspace: scope.workspace, agentPreset: scope.preset, namespace },
      query: 'long-term',
    })).toEqual([])
    expect(fixture.store.listPendingPromotionResults(10)).toEqual([terminal])

    fixture.store.close()
    const reopened = new MemoryStore({ path: fixture.memoryPath, now: () => 100_002 })
    stores.add(reopened)
    expect(reopened.cancelPromotionBeforeOrAfterSubmit(cancellation))
      .toMatchObject({ outcome: 'replayed', receipt: { outcome: 'replayed' } })
    expect(reopened.get(namespace, input.mutation.identity, committed.record!.id)).toBeUndefined()
    expect(reopened.list(namespace, input.mutation.identity, { includeRemoved: true }))
      .toEqual([expect.objectContaining({ id: committed.record!.id, status: 'removed', version: 2 })])
    expect(reopened.completePromotionResult(reopened.listPendingPromotionResults(10)[0]!)).toBe(true)
    expect(reopened.cancelPromotionBeforeOrAfterSubmit(cancellation))
      .toMatchObject({ outcome: 'replayed', receipt: { outcome: 'replayed' } })
    expect(reopened.list(namespace, input.mutation.identity)).toEqual([])

    const other = promotionInput(61, 100_000)
    const reopenedManager = new MemoryProposalManager(reopened, fixture.policy, () => 'current')
    const otherPending = reopenedManager.propose(other)
    const otherCommitted = reopenedManager.decide({
      proposalId: otherPending.proposalId, principal, expectedVersion: otherPending.version,
      decision: 'approved', reason: 'confirmed then independently changed',
    })
    if (other.mutation.op !== 'add') throw new Error('expected promotion add mutation')
    reopened.applyApprovedMutation({
      op: 'replace', idempotencyKey: 'promotion-record-changed-after-confirm', namespace,
      identity: other.mutation.identity, id: otherCommitted.record!.id,
      expectedVersion: otherCommitted.record!.version, entry: {
        ...other.mutation.entry, content: 'owner changed this record after promotion',
      },
    })
    const wrongGeneration = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const, promotionId: other.promotion!.promotionId,
      promotionGeneration: other.promotion!.promotionGeneration + 1,
      requestDigest: other.promotion!.requestDigest, principalLineage: cancellation.principalLineage,
      ownerGeneration: other.promotion!.ownerGeneration, reason: 'forget' as const, occurredAt: 100_003,
    })
    expect(reopened.cancelPromotionBeforeOrAfterSubmit(wrongGeneration).outcome).toBe('cancelled')
    expect(reopened.get(namespace, other.mutation.identity, otherCommitted.record!.id)).toBeDefined()
    const exactChanged = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const, promotionId: other.promotion!.promotionId,
      promotionGeneration: other.promotion!.promotionGeneration,
      requestDigest: other.promotion!.requestDigest, principalLineage: cancellation.principalLineage,
      ownerGeneration: other.promotion!.ownerGeneration, reason: 'forget' as const, occurredAt: 100_003,
    })
    expect(() => reopened.cancelPromotionBeforeOrAfterSubmit(exactChanged))
      .toThrowError(expect.objectContaining<Partial<MemoryStoreError>>({ code: 'version-conflict' }))
    expect(reopened.get(namespace, other.mutation.identity, otherCommitted.record!.id))
      .toMatchObject({ status: 'active', version: 2 })
  })

  test('keeps a confirmed record for a supersede cancellation', async () => {
    const fixture = await harness()
    const input = promotionInput(62, 100_000)
    const pending = fixture.manager.propose(input)
    const committed = fixture.manager.decide({
      proposalId: pending.proposalId, principal, expectedVersion: pending.version,
      decision: 'approved', reason: 'confirmed before stale supersede request',
    })
    const cancellation = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const, promotionId: input.promotion!.promotionId,
      promotionGeneration: input.promotion!.promotionGeneration,
      requestDigest: input.promotion!.requestDigest, principalLineage: {
        principalRecordId: namespace.mode === 'delivery' ? namespace.principalRecordId : '',
        principalVersion: namespace.mode === 'delivery' ? namespace.principalVersion : 0,
      },
      ownerGeneration: input.promotion!.ownerGeneration, reason: 'superseded' as const, occurredAt: 100_001,
    })

    expect(fixture.store.cancelPromotionBeforeOrAfterSubmit(cancellation))
      .toMatchObject({ outcome: 'already-confirmed', receipt: { outcome: 'already-confirmed' } })
    expect(fixture.store.get(namespace, input.mutation.identity, committed.record!.id))
      .toMatchObject({ status: 'active', version: 1 })

    const forget = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const, promotionId: input.promotion!.promotionId,
      promotionGeneration: input.promotion!.promotionGeneration, requestDigest: input.promotion!.requestDigest,
      principalLineage: cancellation.principalLineage, ownerGeneration: input.promotion!.ownerGeneration,
      reason: 'forget' as const, occurredAt: 100_002,
    })
    expect(fixture.store.cancelPromotionBeforeOrAfterSubmit(forget))
      .toMatchObject({ outcome: 'cancelled', receipt: { outcome: 'cancelled' } })
    expect(fixture.store.get(namespace, input.mutation.identity, committed.record!.id)).toBeUndefined()
  })

  test('replays terminal settlement without changing the durable result receipt', async () => {
    const fixture = await harness()
    const input = promotionInput(7, 100_000)
    const pending = fixture.manager.propose(input)
    const committed = fixture.manager.decide({
      proposalId: pending.proposalId, principal, expectedVersion: pending.version,
      decision: 'approved', reason: 'confirmed',
    })
    const first = fixture.store.listPendingPromotionResults(10)[0]!

    fixture.setNow(100_500)
    expect(fixture.store.settleProposal({
      proposalId: pending.proposalId,
      policyStatus: 'approved',
      policyVersion: committed.version,
    })).toMatchObject({ replayed: true, record: { id: committed.record!.id } })
    expect(fixture.store.listPendingPromotionResults(10)).toEqual([first])
    expect(fixture.store.list(namespace, input.mutation.identity)).toHaveLength(1)
  })

  test('persists cancellation before submit and blocks a delayed submit across connections and restart', async () => {
    const fixture = await harness()
    const request = wireRequest(8)
    const cancellation = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const,
      promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration,
      requestDigest: request.requestDigest,
      principalLineage: request.principalLineage,
      ownerGeneration: request.ownerGeneration,
      reason: 'forget' as const,
      occurredAt: 100_001,
    })

    const first = fixture.store.cancelPromotionBeforeOrAfterSubmit(cancellation)
    expect(first).toMatchObject({ outcome: 'cancelled', receipt: { outcome: 'cancelled' } })
    const peer = new MemoryStore({ path: fixture.memoryPath, now: () => 100_002 })
    stores.add(peer)
    expect(peer.cancelPromotionBeforeOrAfterSubmit(cancellation))
      .toMatchObject({ outcome: 'replayed', receipt: { outcome: 'replayed' } })

    const delayed = {
      ...promotionInput(8, 100_000),
      idempotencyKey: request.idempotencyKey,
      promotion: {
        promotionId: request.promotionId,
        promotionGeneration: request.promotionGeneration,
        requestDigest: request.requestDigest,
        scope: request.scope,
        ownerGeneration: request.ownerGeneration,
      },
    }
    expect(() => new MemoryProposalManager(peer, fixture.policy).propose(delayed))
      .toThrowError(expect.objectContaining({ receipt: expect.objectContaining({ outcome: 'replayed' }) }))
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])
    expect(peer.listPendingProposals(10)).toEqual([])
    expect(peer.listPendingPromotionResults(10)).toEqual([])

    peer.close()
    const reopened = new MemoryStore({ path: fixture.memoryPath, now: () => 100_003 })
    stores.add(reopened)
    expect(() => new MemoryProposalManager(reopened, fixture.policy).propose(delayed))
      .toThrowError(expect.objectContaining({ receipt: expect.objectContaining({ outcome: 'replayed' }) }))
    expect(reopened.list(namespace, delayed.mutation.identity)).toEqual([])
  })
})
