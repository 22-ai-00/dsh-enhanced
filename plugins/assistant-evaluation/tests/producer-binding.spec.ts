import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantEvaluationService,
  type TrustedAutomationEvaluationProducer,
  type TrustedDeliveryEvaluationProducer,
} from '../src/service.ts'
import type {
  TrustedAutomationEvaluationClaims,
  TrustedAutomationEvaluationRegistration,
  TrustedDeliveryEvaluationClaims,
  TrustedDeliveryEvaluationRegistration,
} from '../src/types.ts'
import {
  TrustedAutomationTestProducer,
  TrustedDeliveryTestProducer,
  installTrustedTestProducers,
} from './trusted-producer-fixture.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
})

class TraceableAutomationProducer extends Service {
  constructor(ctx: Context, private readonly target: TrustedAutomationTestProducer) {
    super(ctx, 'assistantAutomations')
  }

  trustedEvaluationProducerGeneration(): string {
    return this.target.trustedEvaluationProducerGeneration()
  }

  registerTrustedAutomationEvaluationSink(
    registration: Readonly<TrustedAutomationEvaluationRegistration>,
  ): () => void {
    return this.target.registerTrustedAutomationEvaluationSink(registration)
  }
}

class TraceableDeliveryProducer extends Service {
  constructor(ctx: Context, private readonly target: TrustedDeliveryTestProducer) {
    super(ctx, 'assistantDelivery')
  }

  trustedEvaluationProducerGeneration(): string {
    return this.target.trustedEvaluationProducerGeneration()
  }

  registerTrustedDeliveryEvaluationSink(
    registration: Readonly<TrustedDeliveryEvaluationRegistration>,
  ): () => void {
    return this.target.registerTrustedDeliveryEvaluationSink(registration)
  }
}

async function provideAutomation(
  ctx: Context,
  target: TrustedAutomationTestProducer,
) {
  const fiber = ctx.plugin(producerCtx => {
    new TraceableAutomationProducer(producerCtx, target)
  })
  await fiber
  return fiber
}

async function provideDelivery(
  ctx: Context,
  target: TrustedDeliveryTestProducer,
) {
  const fiber = ctx.plugin(producerCtx => {
    new TraceableDeliveryProducer(producerCtx, target)
  })
  await fiber
  return fiber
}

function automationClaims(key: string): TrustedAutomationEvaluationClaims {
  return {
    scope: { workspace: '/work/alpha', preset: 'primary' },
    automationId: 'binding-lifecycle',
    situation: 'automation:binding-lifecycle',
    runId: `run:${key}`,
    executionMode: 'production',
    executionStatus: 'succeeded',
    objectiveStatus: 'achieved',
    deliveryStatus: 'not-required',
    metrics: {},
    occurredAt: 1_000,
    idempotencyKey: `automation:${key}`,
    evaluatorVersion: 'terminal-v1',
  }
}

function deliveryClaims(key: string): TrustedDeliveryEvaluationClaims {
  return {
    scope: { workspace: '/work/alpha', preset: 'primary' },
    situation: 'automation:binding-lifecycle',
    runId: `run:${key}`,
    outboxId: `outbox:${key}`,
    chatId: 'chat:owner',
    principalId: 'owner:lark:123',
    bindingId: 'binding:owner',
    objectiveStatus: 'achieved',
    occurredAt: 1_001,
    idempotencyKey: `delivery:${key}`,
  }
}

interface PrivateProducerBinder {
  bindAutomationProducer(producer: TrustedAutomationEvaluationProducer): () => void
  bindDeliveryProducer(producer: TrustedDeliveryEvaluationProducer): () => void
}

async function settleCordis(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('trusted producer binding lifecycle', () => {
  test('publishes a transactional candidate for synchronous outbox drain during registration', async () => {
    const ctx = new Context(); contexts.push(ctx)
    let automationRegistration: Readonly<TrustedAutomationEvaluationRegistration> | undefined
    let deliveryRegistration: Readonly<TrustedDeliveryEvaluationRegistration> | undefined
    const automation: TrustedAutomationEvaluationProducer = {
      trustedEvaluationProducerGeneration: () => 'automation-generation:reentrant',
      registerTrustedAutomationEvaluationSink(registration) {
        automationRegistration = registration
        const claims = automationClaims('reentrant')
        const capabilityReceipt = registration.issueCapability(claims)
        registration.append({
          capabilityReceipt,
          automationId: claims.automationId,
          runId: claims.runId,
          idempotencyKey: claims.idempotencyKey,
        })
        return () => {
          if (automationRegistration === registration) automationRegistration = undefined
        }
      },
    }
    const delivery: TrustedDeliveryEvaluationProducer = {
      trustedEvaluationProducerGeneration: () => 'delivery-generation:reentrant',
      registerTrustedDeliveryEvaluationSink(registration) {
        deliveryRegistration = registration
        const claims = deliveryClaims('reentrant')
        const capabilityReceipt = registration.issueCapability(claims)
        registration.append({
          capabilityReceipt,
          runId: claims.runId,
          outboxId: claims.outboxId,
          chatId: claims.chatId,
          principalId: claims.principalId,
          bindingId: claims.bindingId,
          idempotencyKey: claims.idempotencyKey,
        })
        return () => {
          if (deliveryRegistration === registration) deliveryRegistration = undefined
        }
      },
    }
    ctx.provide('assistantAutomations' as never, automation as never)
    ctx.provide('assistantDelivery' as never, delivery as never)

    const service = new AssistantEvaluationService(ctx, {
      databasePath: ':memory:',
      projectionIntervalMs: 0,
    })
    await settleCordis()

    expect(service.query({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      situation: 'automation:binding-lifecycle',
      limit: 10,
    })).toHaveLength(2)
    expect(service.ownsTrustedAutomationEvaluationRegistration(automationRegistration!)).toBe(true)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(deliveryRegistration!)).toBe(true)
  })

  test('deduplicates current and injected traceable wrappers, unloads, and binds new generations', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const firstAutomation = new TrustedAutomationTestProducer('automation-generation:1')
    const firstDelivery = new TrustedDeliveryTestProducer('delivery-generation:1')
    const automationFiber = await provideAutomation(ctx, firstAutomation)
    const deliveryFiber = await provideDelivery(ctx, firstDelivery)
    const currentAutomation = ctx.get('assistantAutomations' as never) as unknown as TrustedAutomationEvaluationProducer
    const siblingAutomation = ctx.extend().get('assistantAutomations' as never) as unknown as TrustedAutomationEvaluationProducer
    const currentDelivery = ctx.get('assistantDelivery' as never) as unknown as TrustedDeliveryEvaluationProducer
    const siblingDelivery = ctx.extend().get('assistantDelivery' as never) as unknown as TrustedDeliveryEvaluationProducer
    expect(currentAutomation).not.toBe(siblingAutomation)
    expect(currentDelivery).not.toBe(siblingDelivery)

    const service = new AssistantEvaluationService(ctx, {
      databasePath: ':memory:',
      projectionIntervalMs: 0,
    })
    await settleCordis()

    expect(firstAutomation.registrationAttempts).toBe(1)
    expect(firstDelivery.registrationAttempts).toBe(1)
    const firstAutomationRegistration = firstAutomation.currentRegistration()!
    const firstDeliveryRegistration = firstDelivery.currentRegistration()!
    expect(service.ownsTrustedAutomationEvaluationRegistration(firstAutomationRegistration)).toBe(true)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(firstDeliveryRegistration)).toBe(true)
    expect(firstAutomation.append(automationClaims('first'))).toMatchObject({ trust: 'trusted' })
    expect(firstDelivery.append(deliveryClaims('first'))).toMatchObject({ trust: 'trusted' })

    const binder = service as unknown as PrivateProducerBinder
    const automationDisposer = binder.bindAutomationProducer(currentAutomation)
    expect(binder.bindAutomationProducer(siblingAutomation)).toBe(automationDisposer)
    const deliveryDisposer = binder.bindDeliveryProducer(currentDelivery)
    expect(binder.bindDeliveryProducer(siblingDelivery)).toBe(deliveryDisposer)
    expect(firstAutomation.registrationAttempts).toBe(1)
    expect(firstDelivery.registrationAttempts).toBe(1)

    await automationFiber.dispose()
    await deliveryFiber.dispose()
    await settleCordis()
    expect(firstAutomation.currentRegistration()).toBeUndefined()
    expect(firstDelivery.currentRegistration()).toBeUndefined()
    expect(firstAutomation.registrationDisposals).toBe(1)
    expect(firstDelivery.registrationDisposals).toBe(1)
    expect(service.ownsTrustedAutomationEvaluationRegistration(firstAutomationRegistration)).toBe(false)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(firstDeliveryRegistration)).toBe(false)
    expect(() => firstAutomationRegistration.issueCapability(automationClaims('stale')))
      .toThrow(/stale automation/iu)
    expect(() => firstDeliveryRegistration.issueCapability(deliveryClaims('stale')))
      .toThrow(/stale delivery/iu)
    automationDisposer()
    deliveryDisposer()
    expect(firstAutomation.registrationDisposals).toBe(1)
    expect(firstDelivery.registrationDisposals).toBe(1)

    const nextAutomation = new TrustedAutomationTestProducer('automation-generation:2')
    const nextDelivery = new TrustedDeliveryTestProducer('delivery-generation:2')
    await provideAutomation(ctx, nextAutomation)
    await provideDelivery(ctx, nextDelivery)
    await vi.waitFor(() => {
      expect(nextAutomation.currentRegistration()).toBeDefined()
      expect(nextDelivery.currentRegistration()).toBeDefined()
    })
    expect(nextAutomation.registrationAttempts).toBe(1)
    expect(nextDelivery.registrationAttempts).toBe(1)
    expect(nextAutomation.append(automationClaims('second'))).toMatchObject({ trust: 'trusted' })
    expect(nextDelivery.append(deliveryClaims('second'))).toMatchObject({ trust: 'trusted' })
  })

  test('a failed new-generation bind preserves both previous live bindings', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const { automations, delivery } = installTrustedTestProducers(ctx)
    const service = new AssistantEvaluationService(ctx, {
      databasePath: ':memory:',
      projectionIntervalMs: 0,
    })
    await settleCordis()
    const automationRegistration = automations.currentRegistration()!
    const deliveryRegistration = delivery.currentRegistration()!
    let failedAutomationRegistration: Readonly<TrustedAutomationEvaluationRegistration> | undefined
    let failedDeliveryRegistration: Readonly<TrustedDeliveryEvaluationRegistration> | undefined
    const failingAutomation: TrustedAutomationEvaluationProducer = {
      trustedEvaluationProducerGeneration: () => 'automation-generation:rejected',
      registerTrustedAutomationEvaluationSink(registration) {
        failedAutomationRegistration = registration
        throw new Error('automation replacement failed')
      },
    }
    const failingDelivery: TrustedDeliveryEvaluationProducer = {
      trustedEvaluationProducerGeneration: () => 'delivery-generation:rejected',
      registerTrustedDeliveryEvaluationSink(registration) {
        failedDeliveryRegistration = registration
        throw new Error('delivery replacement failed')
      },
    }
    const binder = service as unknown as PrivateProducerBinder

    expect(() => binder.bindAutomationProducer(failingAutomation))
      .toThrow('automation replacement failed')
    expect(() => binder.bindDeliveryProducer(failingDelivery))
      .toThrow('delivery replacement failed')
    expect(automations.currentRegistration()).toBe(automationRegistration)
    expect(delivery.currentRegistration()).toBe(deliveryRegistration)
    expect(service.ownsTrustedAutomationEvaluationRegistration(automationRegistration)).toBe(true)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(deliveryRegistration)).toBe(true)
    expect(service.ownsTrustedAutomationEvaluationRegistration(failedAutomationRegistration!)).toBe(false)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(failedDeliveryRegistration!)).toBe(false)
    expect(() => failedAutomationRegistration!.issueCapability(automationClaims('failed-bind')))
      .toThrow(/stale automation/iu)
    expect(() => failedDeliveryRegistration!.issueCapability(deliveryClaims('failed-bind')))
      .toThrow(/stale delivery/iu)
    expect(automations.append(automationClaims('preserved'))).toMatchObject({ trust: 'trusted' })
    expect(delivery.append(deliveryClaims('preserved'))).toMatchObject({ trust: 'trusted' })

    const nextAutomation = new TrustedAutomationTestProducer('automation-generation:accepted')
    const nextDelivery = new TrustedDeliveryTestProducer('delivery-generation:accepted')
    const disposeAutomation = binder.bindAutomationProducer(nextAutomation)
    const disposeDelivery = binder.bindDeliveryProducer(nextDelivery)
    const nextAutomationRegistration = nextAutomation.currentRegistration()!
    const nextDeliveryRegistration = nextDelivery.currentRegistration()!
    expect(automations.currentRegistration()).toBeUndefined()
    expect(delivery.currentRegistration()).toBeUndefined()
    expect(service.ownsTrustedAutomationEvaluationRegistration(automationRegistration)).toBe(false)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(deliveryRegistration)).toBe(false)
    expect(service.ownsTrustedAutomationEvaluationRegistration(nextAutomationRegistration)).toBe(true)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(nextDeliveryRegistration)).toBe(true)
    expect(nextAutomation.append(automationClaims('replacement'))).toMatchObject({ trust: 'trusted' })
    expect(nextDelivery.append(deliveryClaims('replacement'))).toMatchObject({ trust: 'trusted' })

    disposeAutomation()
    disposeAutomation()
    disposeDelivery()
    disposeDelivery()
    expect(nextAutomation.currentRegistration()).toBeUndefined()
    expect(nextDelivery.currentRegistration()).toBeUndefined()
    expect(nextAutomation.registrationDisposals).toBe(1)
    expect(nextDelivery.registrationDisposals).toBe(1)
    expect(service.ownsTrustedAutomationEvaluationRegistration(nextAutomationRegistration)).toBe(false)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(nextDeliveryRegistration)).toBe(false)
  })
})
