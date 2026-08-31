import type {
  HostAutomationExecutionSpec,
  HostAutomationExecutor,
  HostAutomationExecutorDescriptor,
  HostAutomationExecutorInput,
  HostAutomationExecutorResult,
} from './types.js'

export type { HostAutomationExecutor } from './types.js'

export type HostExecutorRegistryErrorCode =
  | 'duplicate-descriptor'
  | 'invalid-descriptor'
  | 'invalid-result'
  | 'stale-registration'

export class HostExecutorRegistryError extends Error {
  constructor(readonly code: HostExecutorRegistryErrorCode, message: string) {
    super(message)
    this.name = 'HostExecutorRegistryError'
  }
}

interface Registration {
  readonly executor: HostAutomationExecutor
  readonly descriptor: Readonly<HostAutomationExecutorDescriptor>
  readonly token: symbol
  readonly lifecycle: AbortController
}

export type HostExecutorProof =
  | Readonly<{
      available: false
      reasonCode:
        | 'host-executor-acceptance-conflict'
        | 'host-executor-acceptance-failed'
        | 'host-executor-contract-rejected'
        | 'host-executor-unavailable'
    }>
  | Readonly<{
      available: true
      descriptor: Readonly<HostAutomationExecutorDescriptor>
      registrationToken: symbol
      lifecycleSignal: AbortSignal
    }>

const digestPattern = /^[a-f0-9]{64}$/u
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const resultCodePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u

function normalizedDescriptor(value: HostAutomationExecutorDescriptor): Readonly<HostAutomationExecutorDescriptor> {
  if (typeof value !== 'object' || value === null
    || !identifierPattern.test(value.executorId)
    || !Number.isSafeInteger(value.contractVersion) || value.contractVersion < 1 || value.contractVersion > 1_000_000
    || !digestPattern.test(value.catalogDigest)) {
    throw new HostExecutorRegistryError('invalid-descriptor', 'Host executor descriptor is invalid')
  }
  return Object.freeze({
    executorId: value.executorId,
    contractVersion: value.contractVersion,
    catalogDigest: value.catalogDigest,
  })
}

function descriptorKey(value: HostAutomationExecutorDescriptor): string {
  return `${value.executorId}\0${value.contractVersion}\0${value.catalogDigest}`
}

function descriptorMatches(
  descriptor: HostAutomationExecutorDescriptor,
  spec: HostAutomationExecutionSpec,
): boolean {
  return descriptor.executorId === spec.executorId
    && descriptor.contractVersion === spec.executorContractVersion
    && descriptor.catalogDigest === spec.catalogDigest
}

export function validateHostExecutorResult(value: HostAutomationExecutorResult): Readonly<HostAutomationExecutorResult> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostExecutorRegistryError('invalid-result', 'Host executor result must be an object')
  }
  const input = value as unknown as Record<string, unknown>
  const allowed = new Set([
    'outcome', 'failureClass', 'failurePhase', 'failureCode', 'sideEffectState', 'retryability',
  ])
  const outcome = input['outcome']
  const failureClass = input['failureClass']
  const failurePhase = input['failurePhase']
  const failureCode = input['failureCode']
  const sideEffectState = input['sideEffectState']
  const retryability = input['retryability']
  const classes = new Set([
    'none', 'budget', 'cancelled', 'configuration', 'execution', 'infrastructure',
    'policy', 'provider', 'timeout', 'unknown',
  ])
  const phases = new Set([
    'none', 'artifact-write', 'agent-creation', 'agent-disposal', 'agent-setup',
    'budget-reservation', 'budget-settlement', 'executor-availability', 'host-execution',
    'model-execution', 'preflight', 'preset-resolution', 'prompt-submission',
    'recovery', 'session-flush', 'terminal-commit', 'unknown',
  ])
  if (Object.keys(input).some(key => !allowed.has(key))
    || (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'unknown')
    || !classes.has(failureClass as string)
    || !phases.has(failurePhase as string)
    || typeof failureCode !== 'string' || !resultCodePattern.test(failureCode)
    || (sideEffectState !== 'none' && sideEffectState !== 'possible' && sideEffectState !== 'unknown')
    || (retryability !== 'safe' && retryability !== 'unsafe' && retryability !== 'after-intervention')) {
    throw new HostExecutorRegistryError('invalid-result', 'Host executor result is invalid')
  }
  const noneTuple = failureClass === 'none' && failurePhase === 'none' && failureCode === 'none'
  const partialNone = failureClass === 'none' || failurePhase === 'none' || failureCode === 'none'
  const interventionClass = failureClass === 'configuration' || failureClass === 'policy' || failureClass === 'budget'
  if ((outcome === 'succeeded') !== noneTuple
    || (!noneTuple && partialNone)
    || (sideEffectState !== 'none' && retryability !== 'unsafe')
    || (sideEffectState === 'none' && outcome === 'succeeded' && retryability !== 'safe')
    || (sideEffectState === 'none' && interventionClass && retryability !== 'after-intervention')) {
    throw new HostExecutorRegistryError('invalid-result', 'Host executor result contradicts its terminal state')
  }
  return Object.freeze({
    outcome,
    failureClass,
    failurePhase,
    failureCode,
    sideEffectState,
    retryability,
  } as HostAutomationExecutorResult)
}

/** Process-local registry. Durable definitions store descriptors, never callbacks. */
export class HostAutomationExecutorRegistry {
  private readonly registrations = new Map<string, Registration>()

  register(executor: HostAutomationExecutor): () => void {
    if (typeof executor !== 'object' || executor === null
      || typeof executor.accepts !== 'function' || typeof executor.execute !== 'function') {
      throw new HostExecutorRegistryError('invalid-descriptor', 'Host executor implementation is invalid')
    }
    const descriptor = normalizedDescriptor(executor.descriptor)
    const key = descriptorKey(descriptor)
    if (this.registrations.has(key)) {
      throw new HostExecutorRegistryError('duplicate-descriptor', 'Host executor descriptor is already registered')
    }
    const registration: Registration = {
      executor,
      descriptor,
      token: Symbol(`host-executor:${descriptor.executorId}:${descriptor.contractVersion}`),
      lifecycle: new AbortController(),
    }
    this.registrations.set(key, registration)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.registrations.get(key) !== registration) return
      this.registrations.delete(key)
      registration.lifecycle.abort('host-executor-unloaded')
    }
  }

  prove(spec: HostAutomationExecutionSpec): HostExecutorProof {
    const accepted: Registration[] = []
    for (const registration of this.registrations.values()) {
      try {
        if (registration.executor.accepts(spec)) accepted.push(registration)
      } catch {
        return Object.freeze({ available: false, reasonCode: 'host-executor-acceptance-failed' })
      }
    }
    if (accepted.length > 1) {
      return Object.freeze({ available: false, reasonCode: 'host-executor-acceptance-conflict' })
    }
    if (accepted.length === 1) {
      const registration = accepted[0]!
      if (!descriptorMatches(registration.descriptor, spec)) {
        return Object.freeze({ available: false, reasonCode: 'host-executor-acceptance-conflict' })
      }
      return Object.freeze({
        available: true,
        descriptor: registration.descriptor,
        registrationToken: registration.token,
        lifecycleSignal: registration.lifecycle.signal,
      })
    }
    const exact = this.registrations.get(descriptorKey({
      executorId: spec.executorId,
      contractVersion: spec.executorContractVersion,
      catalogDigest: spec.catalogDigest,
    }))
    return Object.freeze({
      available: false,
      reasonCode: exact === undefined ? 'host-executor-unavailable' : 'host-executor-contract-rejected',
    })
  }

  async execute(
    proof: HostExecutorProof,
    input: HostAutomationExecutorInput,
  ): Promise<Readonly<HostAutomationExecutorResult>> {
    if (!proof.available) {
      throw new HostExecutorRegistryError('stale-registration', 'Host executor availability was not proven')
    }
    const registration = this.registrations.get(descriptorKey(proof.descriptor))
    if (registration === undefined || registration.token !== proof.registrationToken
      || registration.lifecycle.signal.aborted || proof.lifecycleSignal !== registration.lifecycle.signal
      || input.catalogDigest !== registration.descriptor.catalogDigest) {
      throw new HostExecutorRegistryError('stale-registration', 'Host executor registration is no longer exact')
    }
    const signal = AbortSignal.any([input.signal, registration.lifecycle.signal])
    const execution = Promise.resolve().then(() => registration.executor.execute({ ...input, signal }))
    const settled = execution.then(
      result => ({ kind: 'result' as const, result }),
      error => ({ kind: 'error' as const, error }),
    )
    const unloaded = new Promise<{ kind: 'unloaded' }>(resolve => {
      if (registration.lifecycle.signal.aborted) resolve({ kind: 'unloaded' })
      else registration.lifecycle.signal.addEventListener(
        'abort', () => resolve({ kind: 'unloaded' }), { once: true },
      )
    })
    const result = await Promise.race([settled, unloaded])
    void settled.then(() => {})
    if (result.kind === 'unloaded') {
      throw new HostExecutorRegistryError('stale-registration', 'Host executor unloaded during execution')
    }
    if (result.kind === 'error') throw result.error
    return validateHostExecutorResult(result.result)
  }
}
