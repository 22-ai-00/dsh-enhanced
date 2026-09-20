import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'

export const replyReplayBlockContract = 'assistant-delivery/reply-replay-block/v1' as const

export class ReplyReplayBlockedError extends Error {
  readonly code = 'reply-replay-blocked' as const

  constructor(readonly operationId: string) {
    super(`Delivery reply is permanently blocked for replay operation ${operationId}`)
    this.name = 'ReplyReplayBlockedError'
  }
}

export interface ReplyReplayBlockedAttempt {
  readonly sequence: number
  readonly operationId: string
  readonly inputDigest: string
  readonly observedAt: number
  readonly blocked: true
}

export interface ReplyReplayBlockSnapshot {
  readonly contract: typeof replyReplayBlockContract
  readonly operationId: string
  readonly maximumAttempts: number
  readonly expiresAt: number
  readonly status: 'active' | 'closed' | 'expired' | 'attempt-limit' | 'owner-unloaded'
  readonly invalidated: boolean
  readonly attempts: readonly ReplyReplayBlockedAttempt[]
}

export interface ReplyReplayBlockHandle {
  readonly contract: typeof replyReplayBlockContract
  snapshot(): ReplyReplayBlockSnapshot
  close(): void
}

export interface ReplyReplayBlockConfig {
  readonly operationId: string
  readonly maximumAttempts: number
  readonly expiresAt: number
}

export interface ReplyReplayInput {
  readonly idempotencyKey: string
  readonly text: string
  readonly format?: 'markdown' | 'model-picker' | 'permission-picker' | 'plain'
  readonly modelPicker?: unknown
  readonly permissionPicker?: unknown
  readonly replyToEventId?: string
}

interface BlockRecord {
  readonly operationId: string
  readonly maximumAttempts: number
  readonly expiresAt: number
  readonly attempts: ReplyReplayBlockedAttempt[]
  status: ReplyReplayBlockSnapshot['status']
  invalidated: boolean
}

const blocks = new WeakMap<Agent, BlockRecord>()
const maximumReplayAttempts = 1_000
const maximumReplayLifetimeMs = 24 * 60 * 60 * 1_000

function validOperationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value)
}

function validate(agent: Agent, config: ReplyReplayBlockConfig): void {
  if (typeof agent !== 'object' || agent === null || typeof agent.ctx?.effect !== 'function') {
    throw new TypeError('reply replay block requires a live Agent Context')
  }
  if (!validOperationId(config.operationId)) throw new TypeError('reply replay block operationId is invalid')
  if (!Number.isInteger(config.maximumAttempts) || config.maximumAttempts < 1
    || config.maximumAttempts > maximumReplayAttempts) {
    throw new RangeError(`reply replay block maximumAttempts must be an integer between 1 and ${maximumReplayAttempts}`)
  }
  if (!Number.isSafeInteger(config.expiresAt) || config.expiresAt <= Date.now()
    || config.expiresAt > Date.now() + maximumReplayLifetimeMs) {
    throw new RangeError(`reply replay block expiresAt must be within ${maximumReplayLifetimeMs}ms of now`)
  }
}

function refresh(record: BlockRecord): void {
  if (record.status === 'active' && Date.now() >= record.expiresAt) record.status = 'expired'
  if (record.status === 'active' && record.attempts.length >= record.maximumAttempts) record.status = 'attempt-limit'
}

function snapshot(record: BlockRecord): ReplyReplayBlockSnapshot {
  refresh(record)
  const attempts = record.attempts.map(attempt => Object.freeze({ ...attempt }))
  return Object.freeze({
    contract: replyReplayBlockContract,
    operationId: record.operationId,
    maximumAttempts: record.maximumAttempts,
    expiresAt: record.expiresAt,
    status: record.status,
    invalidated: record.invalidated,
    attempts: Object.freeze(attempts),
  })
}

/** Stable digest of the exact Delivery reply input observed at the fence. */
export function replyReplayInputDigest(input: ReplyReplayInput): string {
  return createHash('sha256').update(acceptanceCanonicalJson({
    idempotencyKey: input.idempotencyKey,
    text: input.text,
    format: input.format ?? null,
    modelPicker: input.modelPicker ?? null,
    permissionPicker: input.permissionPicker ?? null,
    replyToEventId: input.replyToEventId ?? null,
  })).digest('hex')
}

/**
 * Permanently fences Delivery replies for one exact Agent object. The WeakMap
 * tombstone intentionally survives handle close, expiry, attempt exhaustion,
 * and agent Context disposal so a later call never falls back to delivery.
 */
export function blockAgentRepliesForReplay(agent: Agent, config: ReplyReplayBlockConfig): ReplyReplayBlockHandle {
  validate(agent, config)
  if (blocks.has(agent)) throw new Error('reply replay block is already registered for this Agent')
  const record: BlockRecord = {
    operationId: config.operationId,
    maximumAttempts: config.maximumAttempts,
    expiresAt: config.expiresAt,
    attempts: [],
    status: 'active',
    invalidated: false,
  }
  blocks.set(agent, record)
  try {
    agent.ctx.effect(() => () => {
      if (record.status === 'active') record.status = 'owner-unloaded'
    }, 'assistant-delivery.reply-replay-block')
  } catch (error) {
    blocks.delete(agent)
    throw error
  }
  return Object.freeze({
    contract: replyReplayBlockContract,
    snapshot: () => snapshot(record),
    close: () => { if (record.status === 'active') record.status = 'closed' },
  })
}

/** Called by the Service before binding lookup, Policy, adapter selection, or Outbox mutation. */
export function assertReplyReplayAllowed(agent: Agent | undefined, input: ReplyReplayInput): void {
  if (agent === undefined) return
  const record = blocks.get(agent)
  if (record === undefined) return
  refresh(record)
  if (record.status === 'active') {
    record.attempts.push(Object.freeze({
      sequence: record.attempts.length + 1,
      operationId: record.operationId,
      inputDigest: replyReplayInputDigest(input),
      observedAt: Date.now(),
      blocked: true,
    }))
    if (record.attempts.length >= record.maximumAttempts) record.status = 'attempt-limit'
  } else record.invalidated = true
  throw new ReplyReplayBlockedError(record.operationId)
}
