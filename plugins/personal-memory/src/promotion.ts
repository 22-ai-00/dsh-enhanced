import { randomUUID } from 'node:crypto'
import {
  PREFERENCE_MEMORY_PROMOTION_CONTENT,
  PREFERENCE_MEMORY_PROMOTION_PROTOCOL,
  PREFERENCE_MEMORY_PROMOTION_RENDERER_ID,
  resolveTrustedPreferenceMemoryPromotionProducer,
  validatePreferenceMemoryPromotionCancellationRequest,
  validatePreferenceMemoryPromotionRequest,
  validatePreferenceMemoryPromotionResultAck,
  type PreferenceMemoryPromotionCancellationReceipt,
  type PreferenceMemoryPromotionCancellationRequest,
  type PreferenceMemoryPromotionProducer,
  type PreferenceMemoryPromotionRegistration,
  type PreferenceMemoryPromotionRequest,
  type PreferenceMemoryPromotionResult,
  type PreferenceMemoryPromotionResultAck,
  type PreferenceMemoryPromotionSubmissionReceipt,
  type PreferencePromotionSourceRegistrationOwner,
} from '@dsh-enhanced/assistant-growth-contract'
import type { MemoryMutation, MemoryOwnerNamespace } from './types.js'

export interface PreferencePromotionBridgeHandlers {
  submit(request: Readonly<PreferenceMemoryPromotionRequest>): Readonly<PreferenceMemoryPromotionSubmissionReceipt>
  cancel(
    request: Readonly<PreferenceMemoryPromotionCancellationRequest>,
  ): Readonly<PreferenceMemoryPromotionCancellationReceipt>
  list(limit: number): readonly Readonly<PreferenceMemoryPromotionResult>[]
  acknowledge(ack: Readonly<PreferenceMemoryPromotionResultAck>): void
}

interface PreferenceProducerBinding {
  readonly producer: PreferenceMemoryPromotionProducer
  readonly sourceGeneration: string
  readonly registration: Readonly<PreferenceMemoryPromotionRegistration>
  readonly dispose: () => void
}

function generation(value: unknown): string {
  if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || value === ''
    || Buffer.byteLength(value, 'utf8') > 200) {
    throw new Error('personal-memory: Preference promotion producer generation is invalid')
  }
  return value
}

/** Fixed, content-free request projection. Callers cannot provide Memory prose or trust. */
export function preferencePromotionMutation(
  requestInput: Readonly<PreferenceMemoryPromotionRequest>,
): Readonly<MemoryMutation> {
  const request = validatePreferenceMemoryPromotionRequest(requestInput)
  if (request.rendererId !== PREFERENCE_MEMORY_PROMOTION_RENDERER_ID) {
    throw new Error('personal-memory: Preference promotion renderer is invalid')
  }
  return Object.freeze({
    op: 'add' as const,
    identity: Object.freeze({
      owner: 'user' as const,
      scope: 'workspace' as const,
      workspace: request.scope.workspace,
    }),
    entry: Object.freeze({
      kind: 'preference' as const,
      content: PREFERENCE_MEMORY_PROMOTION_CONTENT,
      sensitivity: 'private' as const,
      trust: 'user-confirmed' as const,
      confidence: request.hypothesis.confidenceBps / 10_000,
      provenance: Object.freeze({
        source: `preference-learning:${PREFERENCE_MEMORY_PROMOTION_RENDERER_ID}`,
        observedAt: request.observedAt,
        uri: `preference://${request.hypothesis.id}/v${request.hypothesis.version}`,
      }),
    }),
  })
}

export function preferencePromotionNamespace(
  requestInput: Readonly<PreferenceMemoryPromotionRequest>,
  principalDigest: string,
): Readonly<MemoryOwnerNamespace> {
  const request = validatePreferenceMemoryPromotionRequest(requestInput)
  return Object.freeze({
    mode: 'delivery' as const,
    principalDigest,
    principalRecordId: request.principalLineage.principalRecordId,
    principalVersion: request.principalLineage.principalVersion,
  })
}

/**
 * One private, process-local registration per exact Preference producer
 * generation. Every callback rechecks both object identity and generation.
 */
export class PreferenceMemoryPromotionBridge implements PreferencePromotionSourceRegistrationOwner {
  readonly #sinkGeneration = `personal-memory-promotion:${randomUUID()}`
  readonly #activeRegistrations = new WeakSet<object>()
  #binding: PreferenceProducerBinding | undefined
  #active = true

  constructor(
    private readonly handlers: PreferencePromotionBridgeHandlers,
    resolveProducer?: (value: unknown) => PreferenceMemoryPromotionProducer | undefined,
  ) {
    this.#resolveProducer = resolveProducer ?? resolveTrustedPreferenceMemoryPromotionProducer
  }

  readonly #resolveProducer: (value: unknown) => PreferenceMemoryPromotionProducer | undefined

  ownsPreferencePromotionSourceRegistration(
    registration: Readonly<PreferenceMemoryPromotionRegistration>,
  ): boolean {
    return this.#active && this.#activeRegistrations.has(registration)
  }

  bind(value: unknown): (() => void) | undefined {
    const producer = this.#resolveProducer(value)
    if (producer === undefined) return undefined
    const sourceGeneration = generation(producer.trustedMemoryPromotionProducerGeneration())
    const current = this.#binding
    if (current !== undefined && current.producer === producer
      && current.sourceGeneration === sourceGeneration) {
      return current.dispose
    }

    let live = true
    let unregister: (() => void) | undefined
    let binding!: PreferenceProducerBinding
    let registration!: Readonly<PreferenceMemoryPromotionRegistration>
    const assertCurrent = (): void => {
      if (!live || !this.#active || this.#binding !== binding
        || !this.#activeRegistrations.has(registration)
        || this.#resolveProducer(producer) !== producer
        || generation(producer.trustedMemoryPromotionProducerGeneration()) !== sourceGeneration) {
        throw new Error('personal-memory: stale Preference promotion capability')
      }
    }
    registration = Object.freeze({
      protocol: PREFERENCE_MEMORY_PROMOTION_PROTOCOL,
      producer: 'personal-memory' as const,
      sourceGeneration,
      sinkGeneration: this.#sinkGeneration,
      owner: this,
      propose: (input: Readonly<PreferenceMemoryPromotionRequest>) => {
        assertCurrent()
        return this.handlers.submit(validatePreferenceMemoryPromotionRequest(input))
      },
      cancelPromotion: (input: Readonly<PreferenceMemoryPromotionCancellationRequest>) => {
        assertCurrent()
        return this.handlers.cancel(validatePreferenceMemoryPromotionCancellationRequest(input))
      },
      listTerminalResults: (limit: number) => {
        assertCurrent()
        return this.handlers.list(limit)
      },
      acknowledgeTerminalResult: (input: Readonly<PreferenceMemoryPromotionResultAck>) => {
        assertCurrent()
        this.handlers.acknowledge(validatePreferenceMemoryPromotionResultAck(input))
      },
    })
    this.#activeRegistrations.add(registration)
    const dispose = () => {
      if (!live) return
      live = false
      this.#activeRegistrations.delete(registration)
      if (this.#binding === binding) this.#binding = undefined
      unregister?.()
    }
    binding = Object.freeze({ producer, sourceGeneration, registration, dispose })
    const previous = this.#binding
    this.#binding = binding
    try {
      unregister = producer.registerTrustedMemoryPromotionResultSink(registration)
      if (typeof unregister !== 'function'
        || generation(producer.trustedMemoryPromotionProducerGeneration()) !== sourceGeneration) {
        throw new Error('personal-memory: Preference promotion registration failed')
      }
    } catch (error) {
      live = false
      this.#activeRegistrations.delete(registration)
      if (this.#binding === binding) this.#binding = previous
      throw error
    }
    previous?.dispose()
    return dispose
  }

  dispose(): void {
    if (!this.#active) return
    this.#active = false
    this.#binding?.dispose()
    this.#binding = undefined
  }
}
