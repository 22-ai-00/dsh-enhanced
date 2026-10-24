import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const continuationSource = {
  kind: 'assistant-delivery',
  form: 'notice',
  summary: 'Resume the interrupted owner task',
} as const

export class RestartContinuationError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'ambiguous' | 'flush-failed' | 'authorization-revoked', message: string) {
    super(message)
    this.name = 'RestartContinuationError'
  }
}

/** The stable identity is stored by Delivery before any native admission. */
export function createRestartContinuation(input: { continuationId: string; text: string }): UserMessage {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(input.continuationId)
    || input.text.trim() === '' || Buffer.byteLength(input.text, 'utf8') > 4_096) {
    throw new RestartContinuationError('invalid', 'invalid restart continuation identity or text')
  }
  const id = MessageId(`dsh-restart-${createHash('sha256').update(input.continuationId).digest('hex')}`)
  return freezeMessage({
    id, role: 'user' as const, content: [{ type: 'text' as const, text: input.text }],
    source: continuationSource,
  })
}

export type RestartContinuationInspection =
  | Readonly<{ kind: 'unseen' | 'pending' | 'ambiguous'; turn?: never; reason?: never }>
  | Readonly<{ kind: 'claimed'; turn: number; reason?: never }>
  | Readonly<{ kind: 'settled'; turn: number; reason: SessionEvent<'turn/end'>['data']['reason']['kind'] }>

function sameMessage(candidate: UserMessage, expected: UserMessage): boolean {
  return JSON.stringify(candidate) === JSON.stringify(expected)
}

/**
 * Inspect the complete native log, not just today's pending projection.  A
 * previously claimed message must never be made pending again after restart.
 */
export function inspectRestartContinuation(agent: Agent, message: UserMessage): RestartContinuationInspection {
  if (message.source.kind !== continuationSource.kind
    || message.source.form !== continuationSource.form
    || message.source.summary !== continuationSource.summary) {
    throw new RestartContinuationError('invalid', 'restart continuation source is not Host-owned')
  }
  const pending = { 'next-turn': [] as UserMessage[], 'next-step': [] as UserMessage[] }
  let seen = false
  let removedWithoutCancellation = false
  let claimedTurn: number | undefined
  let settledReason: SessionEvent<'turn/end'>['data']['reason']['kind'] | undefined
  let openTurn: number | undefined
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'turn/start') openTurn = event.data.turn
    if (event.type === 'agent/inbox/spliced') {
      const target = event.data.target
      const entries = pending[target]
      const start = event.data.start
      const removed = entries.slice(start, start + (event.data.removedCount ?? 0))
      if (removed.some(item => item.id === message.id) && event.data.outcome !== 'canceled') {
        removedWithoutCancellation = true
      }
      for (const inserted of event.data.inserted) {
        if (inserted.id !== message.id) continue
        seen = true
        if (!sameMessage(inserted, message)) {
          throw new RestartContinuationError('conflict', 'restart continuation identity has different native content')
        }
      }
      entries.splice(start, event.data.removedCount ?? 0, ...event.data.inserted)
    }
    if (event.type === 'user/message' && event.data.id === message.id) {
      seen = true
      if (!sameMessage(event.data, message)) {
        throw new RestartContinuationError('conflict', 'restart continuation identity has different entered content')
      }
      if (openTurn === undefined || claimedTurn !== undefined) {
        throw new RestartContinuationError('ambiguous', 'restart continuation has no unique native turn')
      }
      claimedTurn = openTurn
    }
    if (event.type === 'turn/end' && event.data.turn === claimedTurn) {
      settledReason = event.data.reason.kind
    }
  }
  const liveTurn = agent.inbox.nextTurn.filter(item => item.id === message.id)
  const liveStep = agent.inbox.nextStep.filter(item => item.id === message.id)
  if (JSON.stringify(pending['next-turn']) !== JSON.stringify(agent.inbox.nextTurn)
    || JSON.stringify(pending['next-step']) !== JSON.stringify(agent.inbox.nextStep)) {
    throw new RestartContinuationError('ambiguous', 'native Inbox projection differs from its event log')
  }
  if (claimedTurn !== undefined) {
    if (liveTurn.length > 0 || liveStep.length > 0) {
      throw new RestartContinuationError('ambiguous', 'a claimed restart continuation is pending again')
    }
    return settledReason === undefined
      ? { kind: 'claimed', turn: claimedTurn }
      : { kind: 'settled', turn: claimedTurn, reason: settledReason }
  }
  if (removedWithoutCancellation || liveStep.length > 0 || liveTurn.length > 1) return { kind: 'ambiguous' }
  if (liveTurn.length === 1) return { kind: 'pending' }
  return seen ? { kind: 'ambiguous' } : { kind: 'unseen' }
}

export interface RestartContinuationAdmission {
  /** Recheck the original Inbox owner, current binding, cancellation and frozen budget. */
  authorize(): void | Promise<void>
  /** Must be the live Session persistence service's awaited flush, not a model self-rating. */
  flush(): Promise<boolean>
  /** Synchronous Host commit after flush and authorization, while the native wake remains parked. */
  onAdmitted?(): void
  signal?: AbortSignal
}

/**
 * The caller must install its model/tool dispatch fences before invoking this.
 * Native maintenance keeps the wake parked until Session persistence confirms
 * the splice.  Failure cancels that wake and requires the caller to dispose the
 * Agent handle before attempting another admission.
 */
export async function admitRestartContinuation(
  agent: Agent,
  message: UserMessage,
  admission: RestartContinuationAdmission,
): Promise<RestartContinuationInspection> {
  const check = async (): Promise<void> => {
    if (admission.signal?.aborted) {
      throw new RestartContinuationError('authorization-revoked', 'restart continuation was cancelled')
    }
    await admission.authorize()
    if (admission.signal?.aborted) {
      throw new RestartContinuationError('authorization-revoked', 'restart continuation was cancelled')
    }
  }
  return agent.runMaintenance(async signal => {
    let wakeParked = false
    try {
      await check()
      if (signal.aborted) throw new RestartContinuationError('authorization-revoked', 'native maintenance was cancelled')
      const state = inspectRestartContinuation(agent, message)
      if (state.kind === 'claimed' || state.kind === 'settled') return state
      if (state.kind === 'ambiguous') {
        throw new RestartContinuationError('ambiguous', 'restart continuation history cannot prove a safe admission')
      }
      if (agent.inbox.nextStep.length > 0
        || agent.inbox.nextTurn.some(item => item.id !== message.id)) {
        throw new RestartContinuationError('ambiguous', 'another native input is pending before restart continuation')
      }
      if (state.kind === 'pending' && !agent.inbox.remove(message.id)) {
        throw new RestartContinuationError('ambiguous', 'restart continuation pending identity changed')
      }
      // Native followup may append before throwing. Suppress its wake even when
      // its caller never receives a successful return.
      wakeParked = true
      agent.followup(message)
      let flushed: boolean
      try { flushed = await admission.flush() }
      catch (error) {
        throw new RestartContinuationError('flush-failed', `restart continuation flush failed: ${String(error)}`)
      }
      if (!flushed) throw new RestartContinuationError('flush-failed', 'restart continuation flush was not confirmed')
      await check()
      if (signal.aborted) throw new RestartContinuationError('authorization-revoked', 'native maintenance was cancelled')
      admission.onAdmitted?.()
      return { kind: 'pending' } as const
    } catch (error) {
      // A disposed cancellation suppresses runMaintenance's latched wake.  The
      // caller still owns the awaitable handle teardown; this cannot establish
      // quiescence for any already dispatched external action.
      if (wakeParked) {
        try { agent.cancel({ kind: 'disposed' }, { keepInbox: true }) }
        catch { /* The caller still owns the handle's mandatory teardown. */ }
      }
      throw error
    }
  })
}
