import type { Context } from '@deepseek-ai/cordis'
import {
  RecoveryCompensationError,
  type CompensationCategory,
  type CompensatorDescriptor,
  type CompensatorHandler,
} from './compensation-types.js'

const KIND_PATTERN = /^[a-z][a-z0-9.:_-]{0,127}$/u
const CATEGORIES = new Set<CompensationCategory>([
  'revert',
  'delete',
  'cancel',
  'notify-undo',
  'rollback-state',
  'custom',
])

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0)!
    return point <= 0x1f || point === 0x7f
  })
}

function validateHandler(handler: CompensatorHandler): CompensatorHandler {
  if (typeof handler !== 'object' || handler === null) {
    throw new RecoveryCompensationError('invalid-input', 'compensator handler must be an object')
  }
  if (typeof handler.kind !== 'string' || !KIND_PATTERN.test(handler.kind)) {
    throw new RecoveryCompensationError(
      'invalid-input',
      'compensator kind must match /^[a-z][a-z0-9.:_-]{0,127}$/',
    )
  }
  if (!CATEGORIES.has(handler.category)) {
    throw new RecoveryCompensationError(
      'invalid-input',
      `unsupported compensator category: ${String(handler.category)}`,
    )
  }
  if (typeof handler.compensate !== 'function') {
    throw new RecoveryCompensationError(
      'invalid-input',
      `compensator ${handler.kind} must provide a compensate function`,
    )
  }
  if (handler.capturePreimage !== undefined && typeof handler.capturePreimage !== 'function') {
    throw new RecoveryCompensationError(
      'invalid-input',
      `compensator ${handler.kind} capturePreimage must be a function`,
    )
  }
  if (handler.authorize !== undefined && typeof handler.authorize !== 'function') {
    throw new RecoveryCompensationError(
      'invalid-input',
      `compensator ${handler.kind} authorize must be a function`,
    )
  }
  let description: string | undefined
  if (handler.description !== undefined) {
    if (typeof handler.description !== 'string' || hasControlCharacter(handler.description)) {
      throw new RecoveryCompensationError(
        'invalid-input',
        `compensator ${handler.kind} description must be printable text`,
      )
    }
    const normalized = handler.description.normalize('NFC').trim()
    if (normalized !== '') {
      if (Buffer.byteLength(normalized, 'utf8') > 512) {
        throw new RecoveryCompensationError(
          'invalid-input',
          `compensator ${handler.kind} description exceeds 512 bytes`,
        )
      }
      description = normalized
    }
  }
  return Object.freeze({
    kind: handler.kind,
    category: handler.category,
    ...(description === undefined ? {} : { description }),
    ...(handler.capturePreimage === undefined ? {} : { capturePreimage: handler.capturePreimage }),
    ...(handler.authorize === undefined ? {} : { authorize: handler.authorize }),
    compensate: handler.compensate,
  })
}

export class CompensationRegistry {
  readonly #handlers = new Map<string, CompensatorHandler>()

  register(
    handler: CompensatorHandler,
    options: { readonly replace?: boolean; readonly ownerCtx?: Context } = {},
  ): () => void {
    const entry = validateHandler(handler)
    if (this.#handlers.has(entry.kind) && options.replace !== true) {
      throw new RecoveryCompensationError(
        'handler-conflict',
        `compensator already registered for kind ${entry.kind}`,
      )
    }
    this.#handlers.set(entry.kind, entry)

    let disposed = false
    const unregister = (): void => {
      if (disposed) return
      disposed = true
      if (this.#handlers.get(entry.kind) === entry) {
        this.#handlers.delete(entry.kind)
      }
    }

    if (options.ownerCtx !== undefined) {
      options.ownerCtx.effect(() => () => unregister(), 'assistant-recovery.compensator')
    }

    return unregister
  }

  unregister(kind: string): boolean {
    if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) return false
    return this.#handlers.delete(kind)
  }

  has(kind: string): boolean {
    if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) return false
    return this.#handlers.has(kind)
  }

  get(kind: string): CompensatorHandler | undefined {
    if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) return undefined
    return this.#handlers.get(kind)
  }

  list(): readonly CompensatorDescriptor[] {
    const entries = [...this.#handlers.values()].sort((left, right) => left.kind.localeCompare(right.kind))
    return Object.freeze(entries.map(entry => Object.freeze({
      kind: entry.kind,
      category: entry.category,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      capturesPreimage: entry.capturePreimage !== undefined,
      hasAuthorizer: entry.authorize !== undefined,
    })))
  }

  clear(): void {
    this.#handlers.clear()
  }
}
