import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantEvaluationError,
  AssistantEvaluationService,
} from '../src/service.ts'
import type {
  TrustedWorkItemEvaluationClaims,
  TrustedWorkItemEvaluationRegistration,
} from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
})

const SCOPE = { workspace: '/work/alpha', preset: 'primary' } as const
const DIGEST = 'a'.repeat(64)

/** The opaque producer capability AssistantEvaluationService discovers on `ctx`. */
interface TrustedWorkItemEvaluationProducer {
  trustedWorkItemProducerGeneration(): string
  registerTrustedWorkItemEvaluationSink(
    registration: Readonly<TrustedWorkItemEvaluationRegistration>,
  ): () => void
}

function claims(overrides: Partial<TrustedWorkItemEvaluationClaims> = {}): TrustedWorkItemEvaluationClaims {
  const itemId = overrides.itemId ?? 'item-1'
  const outcomeRevision = overrides.outcomeRevision ?? 1
  const evidenceState = overrides.evidenceState ?? 'observed'
  return {
    scope: SCOPE,
    itemId,
    outcomeRevision,
    settledBy: 'observed-evidence',
    evidenceState,
    situation: 'work-item:foreground-repair',
    occurredAt: 1_000,
    idempotencyKey: `work-items/${itemId}/${String(outcomeRevision)}/${evidenceState}`,
    digest: DIGEST,
    metrics: { latencyMs: 1_000, retries: 0 },
    objectiveStatus: 'unknown',
    deliveryStatus: 'unknown',
    ...overrides,
  }
}

class WorkItemTestProducer {
  readonly generation: string
  registrationAttempts = 0
  registrationDisposals = 0
  #registration: Readonly<TrustedWorkItemEvaluationRegistration> | undefined

  constructor(generation: string = crypto.randomUUID()) {
    this.generation = generation
  }

  currentRegistration(): Readonly<TrustedWorkItemEvaluationRegistration> | undefined {
    return this.#registration
  }

  trustedWorkItemProducerGeneration(): string {
    return this.generation
  }

  registerTrustedWorkItemEvaluationSink(
    registration: Readonly<TrustedWorkItemEvaluationRegistration>,
  ): () => void {
    this.registrationAttempts += 1
    if (registration.protocol !== 'assistant-work-items/evaluation/v1'
      || registration.generation !== this.generation
      || typeof registration.append !== 'function'
      || registration.owner.ownsTrustedWorkItemEvaluationRegistration(registration) !== true
      || this.#registration !== undefined) {
      throw new Error('invalid trusted work-item test registration')
    }
    this.#registration = registration
    let active = true
    return () => {
      if (!active) return
      active = false
      this.registrationDisposals += 1
      if (this.#registration === registration) this.#registration = undefined
    }
  }

  append(input: Readonly<TrustedWorkItemEvaluationClaims>): Promise<void> {
    const registration = this.#registration
    if (registration === undefined) throw new Error('trusted work-item test producer is not bound')
    return registration.append(input)
  }
}

class TraceableWorkItemProducer extends Service {
  constructor(ctx: Context, private readonly target: WorkItemTestProducer) {
    super(ctx, 'assistantWorkItems')
  }

  trustedWorkItemProducerGeneration(): string {
    return this.target.trustedWorkItemProducerGeneration()
  }

  registerTrustedWorkItemEvaluationSink(
    registration: Readonly<TrustedWorkItemEvaluationRegistration>,
  ): () => void {
    return this.target.registerTrustedWorkItemEvaluationSink(registration)
  }
}

async function provideWorkItems(ctx: Context, target: WorkItemTestProducer) {
  const fiber = ctx.plugin(producerCtx => {
    new TraceableWorkItemProducer(producerCtx, target)
  })
  await fiber
  return fiber
}

async function settleCordis(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

function setup(producer: WorkItemTestProducer) {
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('assistantWorkItems' as never, producer as never)
  const service = new AssistantEvaluationService(ctx, {
    databasePath: ':memory:',
    projectionIntervalMs: 0,
  }, { now: () => 1_000 })
  return { ctx, service, producer }
}

describe('trusted work-item Evaluation producer', () => {
  test('projects one observed settlement as a trusted, objective-neutral outcome', async () => {
    const { service, producer } = setup(new WorkItemTestProducer())
    await producer.append(claims())
    const stored = service.query({ scope: SCOPE, limit: 10 })
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      scope: SCOPE,
      situation: 'work-item:foreground-repair',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      deliveryStatus: 'unknown',
      trust: 'trusted',
      source: { kind: 'system', id: 'assistant-work-items' },
      evaluator: { id: 'assistant-work-items', version: 'settlement-v1' },
      evidence: [
        { kind: 'work-item', ref: 'item-1' },
        { kind: 'work-item-outcome', ref: 'item-1#1', digest: DIGEST },
      ],
      metrics: { latencyMs: 1_000, retries: 0 },
      occurredAt: 1_000,
      idempotencyKey: 'work-items/item-1/1/observed',
    })
    expect(service.health()).toMatchObject({ trustedOutcomes: 1, selfReportedOutcomes: 0 })
  })

  test('keeps unverified and not-applicable settlements execution-unknown', async () => {
    const { service, producer } = setup(new WorkItemTestProducer())
    await producer.append(claims({ evidenceState: 'unverified' }))
    await producer.append(claims({ itemId: 'item-2', evidenceState: 'not-applicable' }))
    const stored = service.query({ scope: SCOPE, limit: 10 })
    expect(stored).toHaveLength(2)
    for (const outcome of stored) {
      expect(outcome).toMatchObject({
        executionStatus: 'unknown',
        objectiveStatus: 'unknown',
        deliveryStatus: 'unknown',
        trust: 'trusted',
        evaluator: { id: 'assistant-work-items', version: 'unverified-v1' },
      })
    }
  })

  test('carries a thread-closure settlement verbatim and keeps it unverified', async () => {
    const { service, producer } = setup(new WorkItemTestProducer())
    await producer.append(claims({ settledBy: 'closed-by-thread', evidenceState: 'unverified' }))
    const stored = service.query({ scope: SCOPE, limit: 10 })
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      executionStatus: 'unknown',
      objectiveStatus: 'unknown',
      deliveryStatus: 'unknown',
      trust: 'trusted',
      evaluator: { id: 'assistant-work-items', version: 'unverified-v1' },
    })
  })

  test('replays an identical settlement without a second outcome', async () => {
    const { service, producer } = setup(new WorkItemTestProducer())
    await producer.append(claims())
    await producer.append(claims())
    expect(service.query({ scope: SCOPE, limit: 10 })).toHaveLength(1)
  })

  test('rejects reuse of one settlement identity with changed content', async () => {
    const { service, producer } = setup(new WorkItemTestProducer())
    await producer.append(claims())
    await expect(producer.append(claims({ digest: 'b'.repeat(64) })))
      .rejects.toMatchObject({ code: 'idempotency-conflict' })
    expect(service.query({ scope: SCOPE, limit: 10 })).toHaveLength(1)
  })

  test('rejects forged claims that try to widen what a work item can assert', async () => {
    const { service, producer } = setup(new WorkItemTestProducer())
    const registration = producer.currentRegistration()!
    const assertForbidden = async (forged: unknown): Promise<void> => {
      await expect(registration.append(forged as never))
        .rejects.toBeInstanceOf(AssistantEvaluationError)
    }
    // The registration type is incapable of these, so the runtime must re-prove it.
    await expect(registration.append({ ...claims(), objectiveStatus: 'achieved' } as never))
      .rejects.toThrow(/cannot assert an objective/)
    await expect(registration.append({ ...claims(), deliveryStatus: 'delivered' } as never))
      .rejects.toThrow(/cannot assert an objective/)
    await expect(registration.append({ ...claims(), evidenceState: 'pending' } as never))
      .rejects.toThrow(/settlement is invalid/)
    await expect(registration.append({ ...claims(), outcomeRevision: 0 } as never))
      .rejects.toThrow(/settlement is invalid/)
    await expect(registration.append({ ...claims(), settledBy: 'made-up-reason' } as never))
      .rejects.toThrow(/settlement is invalid/)
    await expect(registration.append({ ...claims(), idempotencyKey: 'work-items/forged' } as never))
      .rejects.toThrow(/identity is not deterministic/)
    await expect(registration.append({ ...claims(), occurredAt: 2_000 } as never))
      .rejects.toThrow(/occurrence is invalid/)
    await assertForbidden(claims({ idempotencyKey: 'work-items/item-1/1/unverified' }))
    expect(service.query({ scope: SCOPE, limit: 10 })).toHaveLength(0)
  })

  test('keeps the public append seam closed to trusted claims', () => {
    const { service } = setup(new WorkItemTestProducer())
    expect(() => service.append({
      scope: SCOPE,
      situation: 'work-item:foreground-repair',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      deliveryStatus: 'unknown',
      source: { kind: 'system', id: 'forged' },
      trust: 'trusted',
      evidence: [],
      metrics: {},
      occurredAt: 1_000,
      idempotencyKey: 'forged/trusted',
      evaluator: { id: 'forged', version: 'v1' },
    })).toThrow(/registered Host producer capability/)
  })

  test('owns only the registration it built and never a foreign producer capability', async () => {
    const { service, producer } = setup(new WorkItemTestProducer())
    const registration = producer.currentRegistration()!
    expect(service.ownsTrustedWorkItemEvaluationRegistration(registration)).toBe(true)
    expect(service.ownsTrustedVerifierEvaluationRegistration(registration as never)).toBe(false)
    expect(service.ownsTrustedAutomationEvaluationRegistration(registration as never)).toBe(false)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(registration as never)).toBe(false)
    expect(service.ownsTrustedWorkItemEvaluationRegistration({
      ...registration,
      protocol: 'assistant-verifier/evaluation/v1',
    } as never)).toBe(false)
    await producer.append(claims())
    expect(service.query({ scope: SCOPE, limit: 10 })).toHaveLength(1)
  })

  test('ignores a foreign producer published under the work-item service name', async () => {
    const ctx = new Context(); contexts.push(ctx)
    let registrations = 0
    ctx.provide('assistantWorkItems' as never, {
      trustedVerificationProducerGeneration: () => 'verifier-generation',
      registerTrustedVerifierEvaluationSink() {
        registrations += 1
        return () => {}
      },
    } as never)
    const service = new AssistantEvaluationService(ctx, {
      databasePath: ':memory:',
      projectionIntervalMs: 0,
    })
    await settleCordis()
    expect(registrations).toBe(0)
    expect(service.query({ scope: SCOPE, limit: 10 })).toHaveLength(0)
  })

  test('unloads the sink with its producer and rebinds a new generation', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const first = new WorkItemTestProducer('work-item-generation:1')
    const firstFiber = await provideWorkItems(ctx, first)
    const service = new AssistantEvaluationService(ctx, {
      databasePath: ':memory:',
      projectionIntervalMs: 0,
    }, { now: () => 1_000 })
    await settleCordis()
    const current = ctx.get('assistantWorkItems' as never) as unknown as TrustedWorkItemEvaluationProducer
    const sibling = ctx.extend().get('assistantWorkItems' as never) as unknown as TrustedWorkItemEvaluationProducer
    expect(first.registrationAttempts).toBe(1)
    const firstRegistration = first.currentRegistration()!
    await first.append(claims({ itemId: 'first' }))

    const binder = service as unknown as {
      bindWorkItemsProducer(producer: TrustedWorkItemEvaluationProducer): () => void
    }
    const disposer = binder.bindWorkItemsProducer(current)
    expect(binder.bindWorkItemsProducer(sibling)).toBe(disposer)
    expect(first.registrationAttempts).toBe(1)

    await firstFiber.dispose()
    await settleCordis()
    expect(first.currentRegistration()).toBeUndefined()
    expect(first.registrationDisposals).toBe(1)
    expect(service.ownsTrustedWorkItemEvaluationRegistration(firstRegistration)).toBe(false)
    await expect(firstRegistration.append(claims({ itemId: 'stale' })))
      .rejects.toThrow(/stale work-item Evaluation producer capability/)
    disposer()
    expect(first.registrationDisposals).toBe(1)

    const next = new WorkItemTestProducer('work-item-generation:2')
    await provideWorkItems(ctx, next)
    await vi.waitFor(() => expect(next.currentRegistration()).toBeDefined())
    expect(next.registrationAttempts).toBe(1)
    await next.append(claims({ itemId: 'second' }))
    expect(service.query({ scope: SCOPE, limit: 10 })).toHaveLength(2)
  })

  test('a failed replacement keeps the previous binding live and disposes the failed one', async () => {
    const first = new WorkItemTestProducer('work-item-generation:live')
    const { service } = setup(first)
    const liveRegistration = first.currentRegistration()!
    let rejected: Readonly<TrustedWorkItemEvaluationRegistration> | undefined
    const failing: TrustedWorkItemEvaluationProducer = {
      trustedWorkItemProducerGeneration: () => 'work-item-generation:rejected',
      registerTrustedWorkItemEvaluationSink(registration) {
        rejected = registration
        throw new Error('work-item replacement failed')
      },
    }
    const binder = service as unknown as {
      bindWorkItemsProducer(producer: TrustedWorkItemEvaluationProducer): () => void
    }
    expect(() => binder.bindWorkItemsProducer(failing)).toThrow('work-item replacement failed')
    expect(first.currentRegistration()).toBe(liveRegistration)
    expect(service.ownsTrustedWorkItemEvaluationRegistration(liveRegistration)).toBe(true)
    expect(service.ownsTrustedWorkItemEvaluationRegistration(rejected!)).toBe(false)
    await expect(rejected!.append(claims({ itemId: 'failed-bind' })))
      .rejects.toThrow(/stale work-item Evaluation producer capability/)
    await first.append(claims({ itemId: 'preserved' }))
    expect(service.query({ scope: SCOPE, limit: 10 })).toHaveLength(1)
  })

  test('a first work-item binding rejected by its producer leaves no active registration', async () => {
    const ctx = new Context(); contexts.push(ctx)
    let rejected: Readonly<TrustedWorkItemEvaluationRegistration> | undefined
    ctx.provide('assistantWorkItems' as never, {
      trustedWorkItemProducerGeneration: () => 'work-item-generation:first-rejected',
      registerTrustedWorkItemEvaluationSink(registration: Readonly<TrustedWorkItemEvaluationRegistration>) {
        rejected = registration
        throw new Error('work-item first bind failed')
      },
    } as never)
    expect(() => new AssistantEvaluationService(ctx, {
      databasePath: ':memory:',
      projectionIntervalMs: 0,
    })).toThrow('work-item first bind failed')
    expect(rejected).toBeDefined()
    // The rejected registration belongs to no owner, so it cannot append.
    await expect(rejected!.append(claims()))
      .rejects.toThrow(/stale work-item Evaluation producer capability/)
  })
})
