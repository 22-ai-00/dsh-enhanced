import {
  normalizeCompensationRequest,
  type CompensationLedger,
  type NormalizedCompensationRequest,
} from './compensation-ledger.js'
import type { CompensationRegistry } from './compensation-registry.js'
import {
  RecoveryCompensationError,
  type CompensationExecutionResult,
  type CompensationRecordInput,
  type CompensatorHandler,
  type CompensatorOutcome,
  type ExecuteCompensationOptions,
  type RecoveryCompensationPort,
  type StoredCompensationRecord,
} from './compensation-types.js'

const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 300_000
const DEFAULT_TIMEOUT_MS = 10_000
const RESULT_CODE_PATTERN = /^[a-z0-9][a-z0-9.:_-]{0,63}$/u

function safeTimeoutMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new RecoveryCompensationError(
      'invalid-input',
      `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    )
  }
  return value
}

function toExecutionResult(
  record: StoredCompensationRecord,
  replayed: boolean,
): CompensationExecutionResult {
  if (record.status !== 'succeeded' && record.status !== 'failed' && record.status !== 'unknown') {
    throw new RecoveryCompensationError('invalid-state', `compensation ${record.id} is not settled`)
  }
  if (record.preimageDigest === undefined || record.resultCode === undefined || record.settledAt === undefined) {
    throw new RecoveryCompensationError('invalid-state', `settled compensation ${record.id} is incomplete`)
  }
  return Object.freeze({
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    kind: record.kind,
    status: record.status,
    resultCode: record.resultCode,
    preimageDigest: record.preimageDigest,
    ...(record.receipt === undefined ? {} : { receipt: record.receipt }),
    ...(record.receiptDigest === undefined ? {} : { receiptDigest: record.receiptDigest }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    replayed,
    settledAt: record.settledAt,
  })
}

function abortReasonError(signal: AbortSignal, fallbackMessage: string): RecoveryCompensationError {
  if (signal.reason instanceof RecoveryCompensationError) {
    return signal.reason
  }
  return new RecoveryCompensationError('unauthorized', fallbackMessage)
}

function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReasonError(signal, 'compensation aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReasonError(signal, 'compensation aborted or timed out'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function normalizeOutcome(raw: CompensatorOutcome): {
  readonly status: 'succeeded' | 'failed' | 'unknown'
  readonly resultCode: string
  readonly receipt?: Readonly<Record<string, unknown>>
  readonly reason?: string
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      status: 'unknown',
      resultCode: 'invalid-compensator-outcome',
      reason: 'compensator returned a non-object outcome',
    }
  }
  if (raw.status !== 'succeeded' && raw.status !== 'failed' && raw.status !== 'unknown') {
    return {
      status: 'unknown',
      resultCode: 'invalid-compensator-outcome',
      reason: 'compensator returned an unrecognized status',
    }
  }
  const normalizedCode = typeof raw.resultCode === 'string'
    ? raw.resultCode.normalize('NFC').trim().toLowerCase()
    : ''
  const resultCode = RESULT_CODE_PATTERN.test(normalizedCode)
    ? normalizedCode
    : raw.status === 'succeeded'
      ? 'succeeded'
      : raw.status === 'failed'
        ? 'failed'
        : 'dispatch-unconfirmed-no-replay'

  if (raw.status === 'failed' && raw.sideEffectState === 'possible') {
    return {
      status: 'unknown',
      resultCode,
      ...(raw.receipt === undefined ? {} : { receipt: raw.receipt }),
      reason: raw.reason ?? 'possible-side-effect-after-failure',
    }
  }
  return {
    status: raw.status,
    resultCode,
    ...(raw.receipt === undefined ? {} : { receipt: raw.receipt }),
    ...(raw.reason === undefined ? {} : { reason: raw.reason }),
  }
}

export class CompensationExecutor implements RecoveryCompensationPort {
  readonly #registry: CompensationRegistry
  readonly #ledger: CompensationLedger
  readonly #defaultTimeoutMs: number
  readonly #now: () => number
  readonly #disposeController = new AbortController()
  readonly #pending = new Map<string, { readonly abort: AbortController; readonly done: Promise<CompensationExecutionResult> }>()
  readonly #activeCalls = new Set<Promise<unknown>>()
  #active = true

  constructor(
    registry: CompensationRegistry,
    ledger: CompensationLedger,
    options: { readonly defaultTimeoutMs?: number; readonly now?: () => number } = {},
  ) {
    this.#registry = registry
    this.#ledger = ledger
    this.#defaultTimeoutMs = safeTimeoutMs(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS)
    this.#now = options.now ?? Date.now
  }

  hasCompensator(kind: string): boolean {
    return this.#registry.has(kind)
  }

  async executeCompensation(
    recordInput: CompensationRecordInput,
    options: ExecuteCompensationOptions = {},
  ): Promise<CompensationExecutionResult> {
    const run = this.#executeCompensationImpl(recordInput, options)
    this.#activeCalls.add(run)
    try {
      return await run
    } finally {
      this.#activeCalls.delete(run)
    }
  }

  async #executeCompensationImpl(
    recordInput: CompensationRecordInput,
    options: ExecuteCompensationOptions = {},
  ): Promise<CompensationExecutionResult> {
    if (!this.#active || this.#disposeController.signal.aborted) {
      throw new RecoveryCompensationError('disposed', 'compensation executor is disposed')
    }
    if (options.signal?.aborted) {
      throw new RecoveryCompensationError('unauthorized', 'compensation aborted before dispatch')
    }
    if (typeof recordInput !== 'object' || recordInput === null || Array.isArray(recordInput)) {
      throw new RecoveryCompensationError('invalid-input', 'compensation record must be an object')
    }

    const timeoutMs = safeTimeoutMs(options.timeoutMs ?? recordInput.timeoutMs, this.#defaultTimeoutMs)
    const now = this.#currentTime()
    const defaultExpiresAt = now + timeoutMs

    const registeredHandler = typeof recordInput.kind === 'string'
      ? this.#registry.get(recordInput.kind)
      : undefined
    const category = registeredHandler?.category ?? 'custom'
    const normalized = normalizeCompensationRequest(recordInput, category, defaultExpiresAt)

    const existing = this.#ledger.getStoredByIdempotencyKey(normalized.idempotencyKey)
    if (existing !== undefined) {
      if (existing.requestDigest !== normalized.requestDigest || existing.kind !== normalized.kind) {
        throw new RecoveryCompensationError(
          'idempotency-conflict',
          `compensation idempotencyKey ${normalized.idempotencyKey} conflicts with an existing request`,
        )
      }
      if (existing.status === 'succeeded' || existing.status === 'failed' || existing.status === 'unknown') {
        this.#ledger.recordReplayAudit(existing)
        return toExecutionResult(existing, true)
      }
      const pending = this.#pending.get(existing.id)
      if (pending !== undefined) {
        return await pending.done
      }
      throw new RecoveryCompensationError(
        'invalid-state',
        `compensation ${existing.id} is in non-terminal state ${existing.status} without an active runner`,
      )
    }

    if (registeredHandler === undefined) {
      throw new RecoveryCompensationError(
        'handler-not-registered',
        `no compensator registered for kind ${normalized.kind}`,
      )
    }

    if (normalized.expiresAt <= now) {
      throw new RecoveryCompensationError('expired', 'compensation request is already expired')
    }

    const remaining = Math.max(1, Math.min(timeoutMs, normalized.expiresAt - now))
    const timeoutController = new AbortController()
    const timeoutTimer = setTimeout(() => {
      timeoutController.abort(new RecoveryCompensationError('expired', 'compensation timed out'))
    }, remaining)
    timeoutTimer.unref?.()

    try {
      const initialSignal = AbortSignal.any([
        this.#disposeController.signal,
        timeoutController.signal,
        ...(options.signal === undefined ? [] : [options.signal]),
      ])

      const initialAuthorized = await raceWithSignal(
        this.#checkAuthorization(registeredHandler, normalized, recordInput, options),
        initialSignal,
      )
      if (!initialAuthorized) {
        throw new RecoveryCompensationError('unauthorized', 'compensation authorization denied')
      }

      if (!this.#active || this.#disposeController.signal.aborted) {
        throw new RecoveryCompensationError('disposed', 'compensation executor is disposed')
      }
      if (timeoutController.signal.aborted || this.#currentTime() >= normalized.expiresAt) {
        throw new RecoveryCompensationError('expired', 'compensation request expired before capture')
      }
      if (options.signal?.aborted) {
        throw new RecoveryCompensationError('unauthorized', 'compensation aborted before capture')
      }

      const prepared = this.#ledger.prepareCapturing(normalized)
      if (!prepared.created) {
        const stored = prepared.record
        if (stored.status === 'succeeded' || stored.status === 'failed' || stored.status === 'unknown') {
          this.#ledger.recordReplayAudit(stored)
          return toExecutionResult(stored, true)
        }
        const pending = this.#pending.get(stored.id)
        if (pending !== undefined) {
          clearTimeout(timeoutTimer)
          return await pending.done
        }
        throw new RecoveryCompensationError(
          'invalid-state',
          `compensation ${stored.id} is in non-terminal state ${stored.status} without an active runner`,
        )
      }

      const internalAbort = new AbortController()
      const done = this.#driveCompensation(
        prepared.record,
        normalized,
        recordInput,
        registeredHandler,
        options,
        internalAbort,
        timeoutController,
      )
      this.#pending.set(prepared.record.id, { abort: internalAbort, done })
      try {
        return await done
      } finally {
        this.#pending.delete(prepared.record.id)
      }
    } finally {
      clearTimeout(timeoutTimer)
    }
  }

  async whenIdle(): Promise<void> {
    while (this.#activeCalls.size > 0) {
      await Promise.allSettled(this.#activeCalls)
    }
  }

  async dispose(): Promise<void> {
    this.#active = false
    this.#disposeController.abort(new RecoveryCompensationError('disposed', 'compensation executor disposed'))
    for (const entry of this.#pending.values()) {
      entry.abort.abort(new RecoveryCompensationError('disposed', 'compensation executor disposed'))
    }
    await this.whenIdle()
  }

  async #driveCompensation(
    initialRecord: StoredCompensationRecord,
    normalized: NormalizedCompensationRequest,
    rawInput: CompensationRecordInput,
    handler: CompensatorHandler,
    options: ExecuteCompensationOptions,
    internalAbort: AbortController,
    timeoutController: AbortController,
  ): Promise<CompensationExecutionResult> {
    let record = initialRecord
    let dispatched = false

    const signals = [
      this.#disposeController.signal,
      internalAbort.signal,
      timeoutController.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ]
    const combinedSignal = AbortSignal.any(signals)

    try {
      let capturedPreimage: Readonly<Record<string, unknown>>
      if (handler.capturePreimage !== undefined) {
        try {
          capturedPreimage = await raceWithSignal(
            Promise.resolve(handler.capturePreimage({
              compensationId: record.id,
              idempotencyKey: record.idempotencyKey,
              record,
              signal: combinedSignal,
            })),
            combinedSignal,
          )
        } catch (error) {
          this.#safeDiscardCapturing(record.id, record.version, 'capture-failed')
          if (error instanceof RecoveryCompensationError) throw error
          throw new RecoveryCompensationError(
            'capture-failed',
            `preimage capture failed for ${record.kind}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        if (typeof capturedPreimage !== 'object' || capturedPreimage === null || Array.isArray(capturedPreimage)) {
          this.#safeDiscardCapturing(record.id, record.version, 'capture-failed')
          throw new RecoveryCompensationError('capture-failed', 'capturePreimage must return a plain object')
        }
      } else {
        capturedPreimage = normalized.initialPreimage ?? Object.freeze({})
      }

      if (!this.#active || combinedSignal.aborted || this.#currentTime() >= normalized.expiresAt) {
        this.#safeDiscardCapturing(record.id, record.version, 'capture-aborted')
        throw this.#endedBeforeDispatchError(
          combinedSignal,
          timeoutController,
          normalized.expiresAt,
          'compensation aborted or expired during capture',
        )
      }

      let authorizedDuringCapture: boolean
      try {
        authorizedDuringCapture = await raceWithSignal(
          this.#checkAuthorization(handler, normalized, rawInput, options),
          combinedSignal,
        )
      } catch (error) {
        this.#safeDiscardCapturing(record.id, record.version, 'capture-aborted')
        throw error
      }
      if (!authorizedDuringCapture) {
        this.#safeDiscardCapturing(record.id, record.version, 'unauthorized-before-seal')
        throw new RecoveryCompensationError('unauthorized', 'compensation authorization revoked during capture')
      }
      if (!this.#active || combinedSignal.aborted || this.#currentTime() >= normalized.expiresAt) {
        this.#safeDiscardCapturing(record.id, record.version, 'capture-aborted')
        throw this.#endedBeforeDispatchError(
          combinedSignal,
          timeoutController,
          normalized.expiresAt,
          'compensation aborted or expired during capture',
        )
      }

      try {
        record = this.#ledger.sealPrepared(record.id, record.version, capturedPreimage)
      } catch (error) {
        this.#safeDiscardCapturing(record.id, record.version, 'capture-seal-failed')
        throw error
      }

      let preDispatchAuthorized = false
      if (this.#active && !combinedSignal.aborted && this.#currentTime() < normalized.expiresAt) {
        try {
          preDispatchAuthorized = await raceWithSignal(
            this.#checkAuthorization(handler, normalized, rawInput, options),
            combinedSignal,
          )
        } catch (error) {
          this.#safeAbandonPrepared(record.id, record.version, 'authorization-ended-before-dispatch')
          throw error
        }
      }
      if (!preDispatchAuthorized || !this.#active || combinedSignal.aborted || this.#currentTime() >= normalized.expiresAt) {
        this.#safeAbandonPrepared(record.id, record.version, 'authorization-ended-before-dispatch')
        throw this.#endedBeforeDispatchError(
          combinedSignal,
          timeoutController,
          normalized.expiresAt,
          'compensation authorization ended before dispatch',
        )
      }

      record = this.#ledger.markDispatched(record.id, record.version)
      dispatched = true

      let outcome: {
        readonly status: 'succeeded' | 'failed' | 'unknown'
        readonly resultCode: string
        readonly receipt?: Readonly<Record<string, unknown>>
        readonly reason?: string
      }

      try {
        const rawOutcome = await raceWithSignal(
          Promise.resolve(handler.compensate({
            compensationId: record.id,
            idempotencyKey: record.idempotencyKey,
            record,
            signal: combinedSignal,
          })),
          combinedSignal,
        )
        const postAuth = this.#active
          && !combinedSignal.aborted
          && this.#currentTime() <= normalized.expiresAt
          && await raceWithSignal(
            this.#checkAuthorization(handler, normalized, rawInput, options),
            combinedSignal,
          )
          && this.#active
          && !combinedSignal.aborted
          && this.#currentTime() <= normalized.expiresAt
        if (!postAuth) {
          outcome = {
            status: 'unknown',
            resultCode: 'authorization-ended-after-dispatch',
            reason: 'authorization or signal ended after dispatch',
          }
        } else {
          outcome = normalizeOutcome(rawOutcome)
        }
      } catch (error) {
        outcome = {
          status: 'unknown',
          resultCode: combinedSignal.aborted
            ? 'authorization-ended-after-dispatch'
            : 'dispatch-unconfirmed-no-replay',
          reason: error instanceof Error ? error.message : String(error),
        }
      }

      const settled = this.#ledger.settle(record.id, record.version, outcome)
      return toExecutionResult(settled, false)
    } catch (error) {
      if (!dispatched) {
        if (record.status === 'capturing') {
          this.#safeDiscardCapturing(record.id, record.version, 'capture-failed')
        } else if (record.status === 'prepared') {
          this.#safeAbandonPrepared(record.id, record.version, 'authorization-ended-before-dispatch')
        }
      }
      throw error
    }
  }

  #endedBeforeDispatchError(
    combinedSignal: AbortSignal,
    timeoutController: AbortController,
    expiresAt: number,
    message: string,
  ): RecoveryCompensationError {
    if (this.#disposeController.signal.aborted || !this.#active) {
      return new RecoveryCompensationError('disposed', message)
    }
    if (timeoutController.signal.aborted || this.#currentTime() >= expiresAt) {
      return new RecoveryCompensationError('expired', message)
    }
    if (combinedSignal.aborted) {
      return abortReasonError(combinedSignal, message)
    }
    return new RecoveryCompensationError('unauthorized', message)
  }

  #safeDiscardCapturing(id: string, version: number, reasonCode: string): void {
    try {
      this.#ledger.discardCapturing(id, version, reasonCode)
    } catch {}
  }

  #safeAbandonPrepared(id: string, version: number, reasonCode = 'authorization-ended-before-dispatch'): void {
    try {
      this.#ledger.abandonPrepared(id, version, reasonCode, reasonCode)
    } catch {}
  }

  async #checkAuthorization(
    handler: CompensatorHandler,
    normalized: NormalizedCompensationRequest,
    rawInput: CompensationRecordInput,
    options: ExecuteCompensationOptions,
  ): Promise<boolean> {
    try {
      if (handler.authorize !== undefined) {
        const allowed = await handler.authorize({
          kind: normalized.kind,
          idempotencyKey: normalized.idempotencyKey,
          target: normalized.target,
          ...(rawInput.scope === undefined ? {} : { scope: rawInput.scope }),
        })
        if (!allowed) return false
      }
      if (options.authorize !== undefined) {
        const allowed = await options.authorize()
        if (!allowed) return false
      }
      return true
    } catch {
      return false
    }
  }

  #currentTime(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RecoveryCompensationError('invalid-state', 'compensation executor clock is invalid')
    }
    return now
  }
}
