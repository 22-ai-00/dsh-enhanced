import type { Context } from '@deepseek-ai/cordis'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { externalEventDigest, parseExternalEventEnvelope, type ExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import type { GoalRecord, GoalScope } from './types.js'
import type { GoalWakeIntent } from './wake-store.js'
import type { GoalWakeRuntime } from './wake.js'
import { GoalEventWaitStore, type GoalEventSourceSnapshot, type GoalEventWait, type GoalEventWaitIntent } from './event-wait-store.js'

export interface PreparationAuthority {
  waitId: string; profileId: string; scope: GoalScope; goalId: string; sessionId: string
  definitionDigest: string; objective: string; nativeGoalId: string; nativeRevision: number; ownerRouteId: string
  sourceDigest: string; sourceId: string; eventId: string; eventSequence: number; eventDigest: string; expiresAt: number
}
type SourceEvent = { sequence: number; envelope: Readonly<ExternalEventEnvelope> }
type SourceReader = {
  sourceSnapshot(triggerId: string): Readonly<GoalEventSourceSnapshot>
  firstEventAfter(snapshot: Readonly<GoalEventSourceSnapshot>, afterSequence: number, deadlineAt: number): Readonly<SourceEvent> | undefined
  subscribeSourceChanges(listener: () => void): () => void
}
type OpportunityEvaluation = { disposition: 'defer' | 'consume' | 'execute'; decision: { eventSequence: number } }
type OpportunityService = {
  closeWait?(waitId: string, scope: GoalScope, reason: 'expired' | 'cancelled'): void
  evaluate(input: { waitId: string; profileId: string; scope: GoalScope; goalId: string; sessionId: string; definitionDigest: string; objective: string; nativeGoalId: string; nativeRevision: number; ownerRouteId: string; sourceDigest: string; sourceId: string; event: { id: string; sequence: number; digest: string; occurredAt: number }; expiresAt: number }): OpportunityEvaluation
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
    private readonly current: (intent: GoalEventWaitIntent) => GoalRecord | undefined,
    private readonly proactive: () => OpportunityService | undefined = () => undefined) {
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
    ctx.effect(() => {
      // Reconciliation only revisits already owner-authorized waits. It never creates
      // a wait or changes an event into wake authority without the frozen intent.
      const timer = setInterval(() => { this.reconcile() }, 1_000)
      timer.unref?.()
      return () => { clearInterval(timer); this.#live = false; this.#unsubscribe?.(); this.#store.close() }
    }, 'assistant-goals.event-waits')
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
    if ((wait.state === 'waiting' || wait.state === 'matched') && now >= (wait.match?.wake.expiresAt ?? wait.intent.expiresAt)) { this.#terminal(wait, 'expired'); return }
    const source = this.#source
    if (!source) return // service loss is recoverable; no timer or implicit authority is created.
    const actual = this.#sourceCurrent(wait.intent)
    if (!actual) { this.#terminal(wait, 'source-changed'); return }
    if (wait.state === 'materialized') {
      const state = this.wake.inspect(wait.intent.wake.scope, wait.intent.wake.goalId)
        .find(item => item.intent.id === wait.match!.wake.id)?.state
      if (state === 'succeeded' || state === 'unknown' || state === 'denied') { this.#terminal(wait, 'settled'); return }
      // GoalWake owns the native phase transition while a dispatch is in flight.
      // In particular, complete is observed before its settle/finish CAS.
      if (state === 'dispatched') return
    }
    let record: GoalRecord | undefined
    try { record = this.#recordCurrent(wait.intent, wait.state !== 'materialized') } catch (error) {
      if (error instanceof Error && /event wait policy denied/u.test(error.message)) this.#terminal(wait, 'denied')
      else throw error
      return
    }
    if (!record || (wait.state === 'materialized' && ['blocked', 'complete', 'cleared'].includes(record.native.phase))) { this.#terminal(wait, 'invalid-current'); return }
    if (wait.state === 'waiting') {
      this.wake.preflight(record)
      let found = source.firstEventAfter(wait.intent.source, this.#store.cursor(wait.intent.id), wait.intent.expiresAt)
      if (!found) return
      let envelope = parseExternalEventEnvelope(found.envelope)
      const valid = (candidate: SourceEvent, value: ExternalEventEnvelope): boolean => Number.isSafeInteger(candidate.sequence) && candidate.sequence > wait.intent.source.highWaterSequence
        && value.source.id === wait.intent.source.sourceId && value.source.kind === wait.intent.source.kind
        && value.source.version === wait.intent.source.version && value.source.configDigest === wait.intent.source.configDigest
        && value.target.automationId === wait.intent.source.target.automationId
      if (!valid(found, envelope)) return
      if (wait.intent.opportunityProfile !== undefined) {
        const proactive = this.proactive()
        if (!proactive) { this.#terminal(wait, 'denied'); return }
        let executable = false
        for (let observed = 0; observed < 32; observed++) {
          const evaluation = proactive.evaluate({
            waitId: wait.intent.id, profileId: wait.intent.opportunityProfile, scope: wait.intent.wake.scope,
            goalId: wait.intent.wake.goalId, sessionId: wait.intent.wake.native.sessionId,
            definitionDigest: wait.intent.wake.definition.digest, objective: record.native.objective,
            nativeGoalId: wait.intent.wake.native.goalId, nativeRevision: wait.intent.wake.native.revision,
            ownerRouteId: wait.intent.wake.ownerRouteId, sourceDigest: wait.intent.source.configDigest,
            sourceId: wait.intent.source.sourceId,
            event: { id: envelope.event.id, sequence: found.sequence, digest: externalEventDigest(envelope), occurredAt: envelope.event.occurredAt },
            expiresAt: wait.intent.expiresAt,
          })
          if (evaluation.disposition === 'consume') { this.#store.advanceCursor(wait.intent.id, found.sequence); return }
          if (evaluation.disposition === 'execute') {
            if (!Number.isSafeInteger(evaluation.decision.eventSequence) || evaluation.decision.eventSequence < found.sequence) throw new Error('assistant-goals: opportunity execution does not bind the observed event')
            if (evaluation.decision.eventSequence === found.sequence) { executable = true; break }
          }
          if (evaluation.disposition !== 'defer' && evaluation.disposition !== 'execute') throw new Error('assistant-goals: invalid opportunity evaluation')
          const next = source.firstEventAfter(wait.intent.source, found.sequence, wait.intent.expiresAt)
          if (!next) return
          const nextEnvelope = parseExternalEventEnvelope(next.envelope)
          if (!valid(next, nextEnvelope)) return
          found = next; envelope = nextEnvelope
          continue
        }
        // A full deferred page intentionally keeps the durable cursor unchanged.
        // The next source hint revalidates the same bounded evidence before it can wake.
        if (!executable) return
      }
      const at = now
      const expiresAt = Math.min(wait.intent.expiresAt, at + wait.intent.runTimeoutMs)
      if (expiresAt - at < 1_000) { this.#terminal(wait, 'expired'); return }
      const wake: GoalWakeIntent = { ...wait.intent.wake, id: `goal-event-wake-${wait.intent.id}`, at, expiresAt }
      // Commit the exact wake before scheduling it; restart can only retry this identity.
      wait = this.#store.match(wait.intent.id, { sequence: found.sequence, envelope, wake })
    }
    if (wait.state === 'matched') {
      this.wake.materialize(wait.match!.wake)
      this.#store.materialized(wait.intent.id)
    }
  }
  #terminal(wait: GoalEventWait, reason: NonNullable<GoalEventWait['reason']>): void {
    if (wait.intent.opportunityProfile !== undefined) this.proactive()?.closeWait?.(wait.intent.id, wait.intent.wake.scope, reason === 'expired' ? 'expired' : 'cancelled')
    this.#store.terminal(wait.intent.id, reason)
  }
  #onSourceChanged(): void {
    // This is only a prompt to reconcile; a source notification has no authority itself.
    this.reconcile()
  }
  /** Read-only authority for preparing an artifact while the original goal stays paused. */
  assertPreparationCurrent(input: PreparationAuthority): void {
    const wait = this.#store.get(input.waitId)
    if (!this.#live || !wait || wait.state !== 'waiting' || Date.now() >= wait.intent.expiresAt
      || wait.intent.opportunityProfile !== input.profileId || !same(wait.intent.wake.scope, input.scope)
      || wait.intent.wake.goalId !== input.goalId || wait.intent.wake.native.sessionId !== input.sessionId
      || wait.intent.wake.native.goalId !== input.nativeGoalId || wait.intent.wake.native.revision !== input.nativeRevision
      || wait.intent.wake.definition.digest !== input.definitionDigest || wait.intent.wake.ownerRouteId !== input.ownerRouteId
      || wait.intent.source.sourceId !== input.sourceId || wait.intent.source.configDigest !== input.sourceDigest
      || wait.intent.expiresAt !== input.expiresAt || !Number.isSafeInteger(input.eventSequence)
      || input.eventSequence <= wait.intent.source.highWaterSequence || !this.#sourceCurrent(wait.intent)) fail()
    const record = this.#recordCurrent(wait.intent)
    if (!record || record.native.objective !== input.objective) fail()
    this.wake.preflight(record)
    const source = this.#source?.firstEventAfter(wait.intent.source, input.eventSequence - 1, input.expiresAt)
    if (!source || source.sequence !== input.eventSequence || source.envelope.event.id !== input.eventId
      || externalEventDigest(source.envelope) !== input.eventDigest) fail()
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
