import type { Context } from '@deepseek-ai/cordis'
import type {
  StoredOutcome,
  TrustedAutomationEvaluationClaims,
  TrustedAutomationEvaluationRegistration,
  TrustedDeliveryEvaluationClaims,
  TrustedDeliveryEvaluationRegistration,
} from '../src/types.ts'
import { TRUSTED_EVALUATION_PRODUCER_PROTOCOL } from '../src/types.ts'

/**
 * Test-only Host producer.  Tests must cross the same opaque, single-use
 * capability boundary as the real Automations service instead of calling the
 * public low-trust append API with a forged `trusted` flag.
 */
export class TrustedAutomationTestProducer {
  readonly generation: string
  registrationAttempts = 0
  registrationDisposals = 0
  private registration: Readonly<TrustedAutomationEvaluationRegistration> | undefined

  constructor(generation = `evaluation-test-automations:${crypto.randomUUID()}`) {
    this.generation = generation
  }

  trustedEvaluationProducerGeneration(): string { return this.generation }
  currentRegistration(): Readonly<TrustedAutomationEvaluationRegistration> | undefined {
    return this.registration
  }

  registerTrustedAutomationEvaluationSink(
    registration: Readonly<TrustedAutomationEvaluationRegistration>,
  ): () => void {
    this.registrationAttempts += 1
    if (registration.protocol !== TRUSTED_EVALUATION_PRODUCER_PROTOCOL
      || registration.producer !== 'assistant-automations'
      || registration.generation !== this.generation
      || !registration.owner.ownsTrustedAutomationEvaluationRegistration(registration)
      || this.registration !== undefined) {
      throw new Error('invalid trusted Automation test registration')
    }
    this.registration = registration
    let active = true
    return () => {
      if (!active) return
      active = false
      this.registrationDisposals += 1
      if (this.registration === registration) this.registration = undefined
    }
  }

  append(claims: TrustedAutomationEvaluationClaims): StoredOutcome {
    const registration = this.registration
    if (registration === undefined) throw new Error('trusted Automation test producer is not bound')
    const capabilityReceipt = registration.issueCapability(claims)
    return registration.append({
      capabilityReceipt,
      automationId: claims.automationId,
      runId: claims.runId,
      idempotencyKey: claims.idempotencyKey,
    })
  }
}

/** Test-only authenticated Delivery producer for exact owner objective replies. */
export class TrustedDeliveryTestProducer {
  readonly generation: string
  registrationAttempts = 0
  registrationDisposals = 0
  private registration: Readonly<TrustedDeliveryEvaluationRegistration> | undefined

  constructor(generation = `evaluation-test-delivery:${crypto.randomUUID()}`) {
    this.generation = generation
  }

  trustedEvaluationProducerGeneration(): string { return this.generation }
  currentRegistration(): Readonly<TrustedDeliveryEvaluationRegistration> | undefined {
    return this.registration
  }

  registerTrustedDeliveryEvaluationSink(
    registration: Readonly<TrustedDeliveryEvaluationRegistration>,
  ): () => void {
    this.registrationAttempts += 1
    if (registration.protocol !== TRUSTED_EVALUATION_PRODUCER_PROTOCOL
      || registration.producer !== 'assistant-delivery'
      || registration.generation !== this.generation
      || !registration.owner.ownsTrustedDeliveryEvaluationRegistration(registration)
      || this.registration !== undefined) {
      throw new Error('invalid trusted Delivery test registration')
    }
    this.registration = registration
    let active = true
    return () => {
      if (!active) return
      active = false
      this.registrationDisposals += 1
      if (this.registration === registration) this.registration = undefined
    }
  }

  append(claims: TrustedDeliveryEvaluationClaims): StoredOutcome {
    const registration = this.registration
    if (registration === undefined) throw new Error('trusted Delivery test producer is not bound')
    const capabilityReceipt = registration.issueCapability(claims)
    return registration.append({
      capabilityReceipt,
      runId: claims.runId,
      outboxId: claims.outboxId,
      chatId: claims.chatId,
      principalId: claims.principalId,
      bindingId: claims.bindingId,
      idempotencyKey: claims.idempotencyKey,
    })
  }
}

export function installTrustedTestProducers(ctx: Context): Readonly<{
  automations: TrustedAutomationTestProducer
  delivery: TrustedDeliveryTestProducer
}> {
  const automations = new TrustedAutomationTestProducer()
  const delivery = new TrustedDeliveryTestProducer()
  ctx.provide('assistantAutomations' as never, automations as never)
  ctx.provide('assistantDelivery' as never, delivery as never)
  return Object.freeze({ automations, delivery })
}
