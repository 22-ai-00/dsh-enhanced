import type { ExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'

/** A stable production cursor for a single configured event trigger. */
export interface EventSourceSnapshot {
  readonly protocol: 'dsh-event-source/v1'
  readonly sourceId: string
  readonly kind: 'file' | 'http-json' | 'webhook'
  readonly version: string
  readonly configDigest: string
  readonly target: Readonly<{ automationId: string }>
  readonly highWaterSequence: number
}

export interface SourceEvent {
  readonly sequence: number
  readonly envelope: Readonly<ExternalEventEnvelope>
}

/** Read-only host surface used by event waiters. It grants no producer authority. */
export interface EventSourceReader {
  sourceSnapshot(triggerId: string): Readonly<EventSourceSnapshot>
  firstEventAfter(
    snapshot: Readonly<EventSourceSnapshot>, afterSequence: number, deadlineAt: number,
  ): Readonly<SourceEvent> | undefined
  subscribeSourceChanges(listener: () => void): () => void
}
