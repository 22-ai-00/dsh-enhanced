import { Context, Service } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import type {
  DeliveryPresentationUpdate,
  TrustedDeliveryPresentationProducer,
  TrustedDeliveryPresentationRegistration,
} from '../src/types.ts'

const roots: string[] = []
const contexts = new Set<Context>()

type ProducerId = 'assistant-automations' | 'assistant-evolution'

interface PrivatePresentationProducerBinder {
  bindPresentationProducer(
    producerId: ProducerId,
    producer: TrustedDeliveryPresentationProducer,
  ): () => void
}

class PresentationProducerTarget implements TrustedDeliveryPresentationProducer {
  registrationAttempts = 0
  registrationDisposals = 0
  private registration: Readonly<TrustedDeliveryPresentationRegistration> | undefined

  constructor(private readonly producerId: ProducerId, private generation: string) {}

  trustedDeliveryPresentationProducerGeneration(): string {
    return this.generation
  }

  registerTrustedDeliveryPresentationSink(
    registration: Readonly<TrustedDeliveryPresentationRegistration>,
  ): () => void {
    this.registrationAttempts += 1
    if (registration.producer !== this.producerId
      || !registration.owner.ownsTrustedDeliveryPresentationRegistration(registration)) {
      throw new Error('presentation registration is not owned by Delivery')
    }
    if (this.registration !== undefined) throw new Error('presentation registration is already installed')
    this.registration = registration
    let active = true
    return () => {
      if (!active) return
      active = false
      this.registrationDisposals += 1
      if (this.registration === registration) this.registration = undefined
    }
  }

  currentRegistration(): Readonly<TrustedDeliveryPresentationRegistration> | undefined {
    return this.registration
  }

  publish(input: DeliveryPresentationUpdate) {
    if (this.registration === undefined) throw new Error('presentation registration is unavailable')
    return this.registration.publish(input)
  }
}

/** Cordis can proxy a service across sibling scopes; keep capability state in one target. */
class TraceablePresentationProducer extends Service implements TrustedDeliveryPresentationProducer {
  constructor(ctx: Context, producerId: ProducerId, private readonly target: PresentationProducerTarget) {
    super(ctx, producerId === 'assistant-evolution' ? 'assistantEvolution' : 'assistantAutomations')
  }

  trustedDeliveryPresentationProducerGeneration(): string {
    return this.target.trustedDeliveryPresentationProducerGeneration()
  }

  registerTrustedDeliveryPresentationSink(
    registration: Readonly<TrustedDeliveryPresentationRegistration>,
  ): () => void {
    return this.target.registerTrustedDeliveryPresentationSink(registration)
  }
}

function approvalUpdate(revision = 1): DeliveryPresentationUpdate {
  return {
    presentationKey: 'approval-application:policy-capability',
    originalOutboxIdempotencyKey: 'approval-card:policy-capability',
    revision,
    presentation: {
      kind: 'approval-application',
      policyProposalId: 'policy-capability',
      localProposalId: 'local-capability',
      applicationStatus: 'conflicted',
      operation: 'adopt',
      terminalAt: 1_000,
      receiptDigest: 'a'.repeat(64),
    },
  }
}

function incidentUpdate(revision = 1): DeliveryPresentationUpdate {
  const incidentId = `incident-${'b'.repeat(64)}`
  const key = `automation-incident:${incidentId}:g1`
  return {
    presentationKey: key,
    originalOutboxIdempotencyKey: key,
    revision,
    presentation: {
      kind: 'automation-incident',
      incidentId,
      automationId: 'heartbeat:presentation-capability',
      definitionHash: 'c'.repeat(64),
      stage: 'terminal',
      state: 'open',
      failureClass: 'configuration',
      failurePhase: 'host-execution',
      failureCode: 'catalog-mismatch',
      sideEffectState: 'none',
      retryability: 'after-intervention',
      lifecycleGeneration: 1,
      incidentRevision: revision,
      openedAt: 1_000,
      updatedAt: 1_000 + revision,
    },
  }
}

async function settleCordis(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

async function provideProducer(
  ctx: Context,
  producerId: ProducerId,
  generation: string,
) {
  const producer = new PresentationProducerTarget(producerId, generation)
  const fiber = ctx.plugin(producerCtx => {
    new TraceablePresentationProducer(producerCtx, producerId, producer)
  })
  await fiber
  return { fiber, producer }
}

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => {
    await ctx.fiber.restart()
    contexts.delete(ctx)
  }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('trusted Delivery presentation producers', () => {
  test('binds exact scoped publishers across proxy, failure, replacement, and unload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-presentation-producer-'))
    roots.push(root)
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite') })

    // The test producer is installed before Delivery to cover the explicit
    // current-service bind path as well as Cordis's later injection path.
    const { fiber: evolutionFiber, producer: evolution } = await provideProducer(
      ctx, 'assistant-evolution', 'evolution-presentation:1',
    )
    const { fiber: automationsFiber, producer: automations } = await provideProducer(
      ctx, 'assistant-automations', 'automations-presentation:1',
    )
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
    })
    await settleCordis()

    const service = ctx.assistantDelivery
    const evolutionRegistration = evolution.currentRegistration()!
    const automationRegistration = automations.currentRegistration()!
    expect(evolutionRegistration).toBeDefined()
    expect(automationRegistration).toBeDefined()
    expect(evolution.registrationAttempts).toBe(1)
    expect(automations.registrationAttempts).toBe(1)
    expect(service.ownsTrustedDeliveryPresentationRegistration(evolutionRegistration)).toBe(true)
    expect(service.ownsTrustedDeliveryPresentationRegistration(automationRegistration)).toBe(true)
    expect(service.ownsTrustedDeliveryPresentationRegistration({ ...evolutionRegistration })).toBe(false)
    expect((service as unknown as { publishDeliveryPresentation?: unknown }).publishDeliveryPresentation)
      .toBeUndefined()

    // Cordis exposes sibling proxies for one producer service. The per-instance
    // generation lets Delivery deduplicate them without issuing a second closure.
    const currentEvolution = ctx.get('assistantEvolution' as never) as unknown as TrustedDeliveryPresentationProducer
    const siblingEvolution = ctx.extend().get('assistantEvolution' as never) as unknown as TrustedDeliveryPresentationProducer
    const currentAutomations = ctx.get('assistantAutomations' as never) as unknown as TrustedDeliveryPresentationProducer
    const siblingAutomations = ctx.extend().get('assistantAutomations' as never) as unknown as TrustedDeliveryPresentationProducer
    expect(currentEvolution).not.toBe(siblingEvolution)
    expect(currentAutomations).not.toBe(siblingAutomations)
    const binder = service as unknown as PrivatePresentationProducerBinder
    const evolutionDisposer = binder.bindPresentationProducer('assistant-evolution', currentEvolution)
    expect(binder.bindPresentationProducer('assistant-evolution', siblingEvolution)).toBe(evolutionDisposer)
    const automationDisposer = binder.bindPresentationProducer('assistant-automations', currentAutomations)
    expect(binder.bindPresentationProducer('assistant-automations', siblingAutomations)).toBe(automationDisposer)
    expect(evolution.registrationAttempts).toBe(1)
    expect(automations.registrationAttempts).toBe(1)

    expect(evolution.publish(approvalUpdate())).toMatchObject({ status: 'pending' })
    expect(automations.publish(incidentUpdate())).toMatchObject({ status: 'pending' })
    expect(() => evolution.publish(incidentUpdate(2))).toThrow(/exact durable provider message/iu)
    expect(() => automations.publish(approvalUpdate(2))).toThrow(/exact durable provider message/iu)

    let failedEvolutionRegistration: Readonly<TrustedDeliveryPresentationRegistration> | undefined
    let failedAutomationRegistration: Readonly<TrustedDeliveryPresentationRegistration> | undefined
    const failingEvolution: TrustedDeliveryPresentationProducer = {
      trustedDeliveryPresentationProducerGeneration: () => 'evolution-presentation:rejected',
      registerTrustedDeliveryPresentationSink(registration) {
        failedEvolutionRegistration = registration
        throw new Error('Evolution replacement rejected')
      },
    }
    const failingAutomations: TrustedDeliveryPresentationProducer = {
      trustedDeliveryPresentationProducerGeneration: () => 'automations-presentation:rejected',
      registerTrustedDeliveryPresentationSink(registration) {
        failedAutomationRegistration = registration
        throw new Error('Automations replacement rejected')
      },
    }
    expect(() => binder.bindPresentationProducer('assistant-evolution', failingEvolution))
      .toThrow('Evolution replacement rejected')
    expect(() => binder.bindPresentationProducer('assistant-automations', failingAutomations))
      .toThrow('Automations replacement rejected')
    expect(evolution.currentRegistration()).toBe(evolutionRegistration)
    expect(automations.currentRegistration()).toBe(automationRegistration)
    expect(service.ownsTrustedDeliveryPresentationRegistration(failedEvolutionRegistration!)).toBe(false)
    expect(service.ownsTrustedDeliveryPresentationRegistration(failedAutomationRegistration!)).toBe(false)
    expect(() => failedEvolutionRegistration!.publish(approvalUpdate(2))).toThrow(/stale trusted presentation/iu)
    expect(() => failedAutomationRegistration!.publish(incidentUpdate(2))).toThrow(/stale trusted presentation/iu)

    await evolutionFiber.dispose()
    await automationsFiber.dispose()
    await settleCordis()
    expect(evolution.currentRegistration()).toBeUndefined()
    expect(automations.currentRegistration()).toBeUndefined()
    expect(evolution.registrationDisposals).toBe(1)
    expect(automations.registrationDisposals).toBe(1)
    expect(service.ownsTrustedDeliveryPresentationRegistration(evolutionRegistration)).toBe(false)
    expect(service.ownsTrustedDeliveryPresentationRegistration(automationRegistration)).toBe(false)
    expect(() => evolutionRegistration.publish(approvalUpdate(2))).toThrow(/stale trusted presentation/iu)
    expect(() => automationRegistration.publish(incidentUpdate(2))).toThrow(/stale trusted presentation/iu)
    evolutionDisposer()
    automationDisposer()
    expect(evolution.registrationDisposals).toBe(1)
    expect(automations.registrationDisposals).toBe(1)

    const { fiber: nextEvolutionFiber, producer: nextEvolution } = await provideProducer(
      ctx, 'assistant-evolution', 'evolution-presentation:accepted',
    )
    const { fiber: nextAutomationsFiber, producer: nextAutomations } = await provideProducer(
      ctx, 'assistant-automations', 'automations-presentation:accepted',
    )
    await vi.waitFor(() => {
      expect(nextEvolution.currentRegistration()).toBeDefined()
      expect(nextAutomations.currentRegistration()).toBeDefined()
    })
    const nextEvolutionRegistration = nextEvolution.currentRegistration()!
    const nextAutomationRegistration = nextAutomations.currentRegistration()!
    expect(nextEvolution.registrationAttempts).toBe(1)
    expect(nextAutomations.registrationAttempts).toBe(1)

    // An accepted new generation revokes the old sink only after registration
    // succeeds, so there is never a window with two live publishers.
    const replacementEvolution = new PresentationProducerTarget(
      'assistant-evolution', 'evolution-presentation:replacement',
    )
    const replacementAutomations = new PresentationProducerTarget(
      'assistant-automations', 'automations-presentation:replacement',
    )
    const disposeReplacementEvolution = binder.bindPresentationProducer(
      'assistant-evolution', replacementEvolution,
    )
    const disposeReplacementAutomations = binder.bindPresentationProducer(
      'assistant-automations', replacementAutomations,
    )
    expect(nextEvolution.currentRegistration()).toBeUndefined()
    expect(nextAutomations.currentRegistration()).toBeUndefined()
    expect(service.ownsTrustedDeliveryPresentationRegistration(nextEvolutionRegistration)).toBe(false)
    expect(service.ownsTrustedDeliveryPresentationRegistration(nextAutomationRegistration)).toBe(false)
    expect(() => nextEvolutionRegistration.publish(approvalUpdate(3))).toThrow(/stale trusted presentation/iu)
    expect(() => nextAutomationRegistration.publish(incidentUpdate(3))).toThrow(/stale trusted presentation/iu)
    expect(replacementEvolution.publish(approvalUpdate(3))).toMatchObject({ status: 'pending' })
    expect(replacementAutomations.publish(incidentUpdate(3))).toMatchObject({ status: 'pending' })

    disposeReplacementEvolution()
    disposeReplacementAutomations()
    expect(replacementEvolution.currentRegistration()).toBeUndefined()
    expect(replacementAutomations.currentRegistration()).toBeUndefined()
    expect(replacementEvolution.registrationDisposals).toBe(1)
    expect(replacementAutomations.registrationDisposals).toBe(1)
    await nextEvolutionFiber.dispose()
    await nextAutomationsFiber.dispose()
  })
})
