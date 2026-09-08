import type { Context } from '@deepseek-ai/cordis'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { parseExternalEventEnvelope, type ExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import type { GoalRecord, GoalScope } from './types.js'
import type { GoalWakeIntent } from './wake-store.js'
import type { GoalWakeRuntime } from './wake.js'
import { GoalEventWaitStore, type GoalEventSourceSnapshot, type GoalEventWait, type GoalEventWaitIntent } from './event-wait-store.js'

type SourceEvent = { sequence: number; envelope: Readonly<ExternalEventEnvelope> }
type SourceReader = {
  sourceSnapshot(triggerId: string): Readonly<GoalEventSourceSnapshot>
  firstEventAfter(snapshot: Readonly<GoalEventSourceSnapshot>, afterSequence: number, deadlineAt: number): Readonly<SourceEvent> | undefined
  subscribeSourceChanges(listener: () => void): () => void
}
const same = (a: unknown, b: unknown) => acceptanceDigest(a) === acceptanceDigest(b)
function fail(): never { throw new Error('assistant-goals: event wait authority is unavailable, changed or expired') }
const snapshotSame = (a: GoalEventSourceSnapshot, b: GoalEventSourceSnapshot) => same(
  { ...a, highWaterSequence: 0 }, { ...b, highWaterSequence: 0 },
)
function reader(value: unknown): SourceReader | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<SourceReader>
  return typeof candidate.sourceSnapshot === 'function' && typeof candidate.firstEventAfter === 'function' && typeof candidate.subscribeSourceChanges === 'function' ? candidate as SourceReader : undefined
}

/** Converts one post-snapshot event observation into one owner-bound GoalWake. */
export class GoalEventWaitRuntime {
  readonly #store: GoalEventWaitStore
  #source: SourceReader | undefined
  #unsubscribe: (() => void) | undefined
  #live = true
  #failures = 0
  #cursor = ''
  constructor(ctx: Context, path: string, private readonly wake: GoalWakeRuntime,
    private readonly current: (intent: GoalEventWaitIntent) => GoalRecord | undefined) {
    this.#store = new GoalEventWaitStore(path)
    // Do not import EventTriggers: goals remains installable without that optional plugin.
    ;(ctx as unknown as { inject(keys: readonly string[], callback: (runtime: unknown) => () => void): void }).inject(['eventTriggers'], runtime => {
      const candidate = reader((runtime as { eventTriggers?: unknown }).eventTriggers)
      if (!candidate) return () => {}
      this.#source = candidate
      this.#unsubscribe = candidate.subscribeSourceChanges(() => { this.#onSourceChanged() })
      this.reconcile()
      return () => { this.#unsubscribe?.(); this.#unsubscribe = undefined; if (this.#source === candidate) this.#source = undefined }
    })
    ctx.effect(() => () => { this.#live = false; this.#unsubscribe?.(); this.#store.close() }, 'assistant-goals.event-waits')
  }
  snapshot(triggerId: string): GoalEventSourceSnapshot {
    const source = this.#source
    if (!this.#live || !source) fail()
    return source.sourceSnapshot(triggerId)
  }
  prepare(intent: GoalEventWaitIntent): GoalEventWait {
    if (!this.#live) fail()
    const wait = this.#store.prepare(intent)
    // Catch events committed after the source snapshot but before the owner checkpoint.
    this.#reconcile(wait)
    return this.#store.get(wait.intent.id)!
  }
  inspect(scope: GoalScope, goalId: string): readonly GoalEventWait[] { return this.#store.list(scope, goalId) }
  health = () => ({ enabled: true, connected: this.#source !== undefined, reconciliationFailures: this.#failures })
  reconcile(): void {
    if (!this.#live) return
    // Bounded pages prevent corrupt or unusually old rows from starving later owners.
    let waits = this.#store.pending(this.#cursor, 32)
    if (waits.length === 0 && this.#cursor !== '') { this.#cursor = ''; waits = this.#store.pending('', 32) }
    for (const wait of waits) {
      this.#cursor = wait.intent.id
      try { this.#reconcile(wait) } catch { this.#failures++ }
    }
  }
  #recordCurrent(intent: GoalEventWaitIntent, requirePaused = true): GoalRecord | undefined {
    const record = this.current(intent)
    if (!record || !same(record.scope, intent.wake.scope) || !same(record.definition, intent.wake.definition)
      || record.native.sessionId !== intent.wake.native.sessionId || record.native.goalId !== intent.wake.native.goalId
      || record.native.maxGoalRounds !== intent.wake.native.maxGoalRounds
      || requirePaused && (!same(record.native, intent.wake.native) || record.native.phase !== 'paused')) return undefined
    return record
  }
  #sourceCurrent(intent: GoalEventWaitIntent): GoalEventSourceSnapshot | undefined {
    const source = this.#source
    if (!source) return undefined
    const prefix = 'event-triggers:'
    if (!intent.source.sourceId.startsWith(prefix) || intent.source.sourceId.length === prefix.length) return undefined
    try { const actual = source.sourceSnapshot(intent.source.sourceId.slice(prefix.length)); return snapshotSame(actual, intent.source) ? actual : undefined } catch { return undefined }
  }
  #reconcile(wait: GoalEventWait): void {
    if (wait.state === 'terminal') return
    const now = Date.now()
    if ((wait.state === 'waiting' || wait.state === 'matched') && now >= (wait.match?.wake.expiresAt ?? wait.intent.expiresAt)) { this.#store.terminal(wait.intent.id, 'expired'); return }
    const source = this.#source
    if (!source) return // service loss is recoverable; no timer or implicit authority is created.
    const actual = this.#sourceCurrent(wait.intent)
    if (!actual) { this.#store.terminal(wait.intent.id, 'source-changed'); return }
    if (wait.state === 'materialized') {
      const state = this.wake.inspect(wait.intent.wake.scope, wait.intent.wake.goalId)
        .find(item => item.intent.id === wait.match!.wake.id)?.state
      if (state === 'succeeded' || state === 'unknown' || state === 'denied') { this.#store.terminal(wait.intent.id, 'settled'); return }
      // GoalWake owns the native phase transition while a dispatch is in flight.
      // In particular, complete is observed before its settle/finish CAS.
      if (state === 'dispatched') return
    }
    let record: GoalRecord | undefined
    try { record = this.#recordCurrent(wait.intent, wait.state !== 'materialized') } catch (error) {
      if (error instanceof Error && /event wait policy denied/u.test(error.message)) this.#store.terminal(wait.intent.id, 'denied')
      else throw error
      return
    }
    if (!record || (wait.state === 'materialized' && ['blocked', 'complete', 'cleared'].includes(record.native.phase))) { this.#store.terminal(wait.intent.id, 'invalid-current'); return }
    if (wait.state === 'waiting') {
      this.wake.preflight(record)
      const found = source.firstEventAfter(wait.intent.source, wait.intent.source.highWaterSequence, wait.intent.expiresAt)
      if (!found) return
      const envelope = parseExternalEventEnvelope(found.envelope)
      if (!Number.isSafeInteger(found.sequence) || found.sequence <= wait.intent.source.highWaterSequence
        || envelope.source.id !== wait.intent.source.sourceId || envelope.source.kind !== wait.intent.source.kind
        || envelope.source.version !== wait.intent.source.version || envelope.source.configDigest !== wait.intent.source.configDigest
        || envelope.target.automationId !== wait.intent.source.target.automationId) return
      const at = now
      const expiresAt = Math.min(wait.intent.expiresAt, at + wait.intent.runTimeoutMs)
      if (expiresAt - at < 1_000) { this.#store.terminal(wait.intent.id, 'expired'); return }
      const wake: GoalWakeIntent = { ...wait.intent.wake, id: `goal-event-wake-${wait.intent.id}`, at, expiresAt }
      // Commit the exact wake before scheduling it; restart can only retry this identity.
      wait = this.#store.match(wait.intent.id, { sequence: found.sequence, envelope, wake })
    }
    if (wait.state === 'matched') {
      this.wake.materialize(wait.match!.wake)
      this.#store.materialized(wait.intent.id)
    }
  }
  #onSourceChanged(): void {
    // This is only a prompt to reconcile; a source notification has no authority itself.
    this.reconcile()
  }
  /** Called by GoalWakeRuntime before native resume. Scheduled wakes remain unaffected. */
  assertWakeCurrent(wakeIntent: GoalWakeIntent): void {
    if (!wakeIntent.id.startsWith('goal-event-wake-')) return
    const waitId = wakeIntent.id.slice('goal-event-wake-'.length)
    const wait = this.#store.get(waitId)
    if (!wait || (wait.state !== 'matched' && wait.state !== 'materialized') || !wait.match || !same(wait.match.wake, wakeIntent)
      || Date.now() >= wakeIntent.expiresAt || !this.#sourceCurrent(wait.intent) || !this.#recordCurrent(wait.intent, false)) fail()
  }
}
