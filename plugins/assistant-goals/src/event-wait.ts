import type { Context } from '@deepseek-ai/cordis'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { externalEventDigest, parseExternalEventEnvelope, type ExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import type { GoalExecutionRun, GoalRecord, GoalScope } from './types.js'
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
  claimGoalSource?(claim: GoalSourceClaim): boolean
  retireGoalSource?(claim: GoalSourceClaim): boolean
  canSettleGoalSource?(claim: GoalSourceClaim): boolean
}
type GoalSourceClaim = {
  triggerId: string; scope: GoalScope; goalId: string; definition: { version: number; digest: string }
  native: { sessionId: string; goalId: string; revision: number }; configDigest: string; automationId: string
}
type OpportunityInput = {
  waitId: string; profileId: string; scope: GoalScope; goalId: string; sessionId: string
  definitionDigest: string; objective: string; nativeGoalId: string; nativeRevision: number; ownerRouteId: string
  sourceDigest: string; sourceId: string; event: { id: string; sequence: number; digest: string; occurredAt: number }; expiresAt: number
}
// assistant-proactive is optional, so reuse the complete local authority
// identity instead of coupling this independently installable plugin to it.
type OpportunityDecisionIdentity = PreparationAuthority
type OpportunityEvaluation = { disposition: 'defer' | 'consume' | 'execute'; decision: Readonly<OpportunityDecisionIdentity> }
type OpportunityService = {
  closeWait?(waitId: string, scope: GoalScope, reason: 'expired' | 'cancelled'): void
  evaluate(input: OpportunityInput): OpportunityEvaluation
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
function opportunity(value: unknown): OpportunityService | undefined {
  if (!value || typeof value !== 'object') return undefined
  return typeof (value as Partial<OpportunityService>).evaluate === 'function' ? value as OpportunityService : undefined
}
function bindsOpportunityContext(decision: unknown, input: OpportunityInput): decision is OpportunityDecisionIdentity {
  if (!decision || typeof decision !== 'object') return false
  const candidate = decision as Partial<OpportunityDecisionIdentity>
  return candidate.waitId === input.waitId && candidate.profileId === input.profileId && same(candidate.scope, input.scope)
    && candidate.goalId === input.goalId && candidate.sessionId === input.sessionId
    && candidate.definitionDigest === input.definitionDigest && candidate.objective === input.objective
    && candidate.nativeGoalId === input.nativeGoalId
    && candidate.nativeRevision === input.nativeRevision && candidate.ownerRouteId === input.ownerRouteId
    && candidate.sourceDigest === input.sourceDigest && candidate.sourceId === input.sourceId
    && candidate.expiresAt === input.expiresAt
}
function bindsOpportunityDecision(decision: OpportunityDecisionIdentity, input: OpportunityInput): boolean {
  return decision.eventId === input.event.id && decision.eventSequence === input.event.sequence
    && decision.eventDigest === input.event.digest
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
    private readonly proactive: () => unknown = () => undefined) {
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
    // A dedicated source is claimed before this wait becomes durable. A
    // competing goal therefore cannot leave a recoverable waiting row.
    this.#source?.claimGoalSource?.(this.#claim(intent))
    const wait = this.#store.prepare(intent)
    // Catch events committed after the source snapshot but before the owner checkpoint.
    this.#reconcile(wait)
    return this.#store.get(wait.intent.id)!
  }
  inspect(scope: GoalScope, goalId: string): readonly GoalEventWait[] { return this.#store.list(scope, goalId) }
  /** A fresh durable wait for this exact paused revision, still under source and owner authority. */
  acceptsPausedRecord(record: GoalRecord): boolean {
    if (!this.#live || record.native.phase !== 'paused') return false
    return this.#store.list(record.scope, record.id).some(wait => {
      if (wait.state === 'terminal' || Date.now() >= wait.intent.expiresAt
        || !same(wait.intent.wake.native, record.native)) return false
      try { return this.#sourceCurrent(wait.intent) !== undefined && this.#recordCurrent(wait.intent) !== undefined } catch { return false }
    })
  }
  /** A current, unique persisted wait may settle only its own quiescent native round. */
  acceptsPausedOutcomeSettlement(record: GoalRecord, run: GoalExecutionRun): boolean {
    if (!this.#live || record.native.phase !== 'paused' || run.execution?.status !== 'succeeded' || !run.execution.quiescent) return false
    const waits = this.#store.list(record.scope, record.id).filter(wait => wait.state === 'waiting'
      && Date.now() < wait.intent.expiresAt && same(wait.intent.wake.scope, record.scope)
      && wait.intent.wake.goalId === record.id && same(wait.intent.wake.definition, record.definition)
      && same(wait.intent.wake.native, record.native))
    if (waits.length !== 1) return false
    const wait = waits[0]!
    if (run.intent.task.goal.id !== record.id || run.intent.task.goal.definitionVersion !== record.definition.version
      || run.intent.task.goal.definitionDigest !== record.definition.digest || run.intent.task.goal.sessionId !== record.native.sessionId
      || run.intent.task.goal.nativeGoalId !== record.native.goalId || run.intent.task.goal.nativeRevision + 1 !== record.native.revision
      || run.intent.admission.round !== record.native.roundsStarted || run.intent.admission.maxGoalRounds !== record.native.maxGoalRounds
      || !same(run.intent.scope, record.scope)) return false
    try {
      if (!this.#sourceCurrent(wait.intent) || !this.#recordCurrent(wait.intent)) return false
      this.wake.preflight(record)
      return true
    } catch { return false }
  }
  /** Historical only: a settled wait proves the completed successor round for its parent wake. */
  acceptsHistoricalPausedOutcomeCompletion(record: GoalRecord,
    wake: Readonly<{ sessionId: string; goalId: string; revision: number; roundsStarted: number; maxGoalRounds: number }>, run: GoalExecutionRun): boolean {
    if (!this.#live || record.native.phase !== 'complete' || run.execution?.status !== 'succeeded' || !run.execution.quiescent) return false
    const waits = this.#store.list(record.scope, record.id).filter(wait => wait.state === 'terminal' && wait.reason === 'settled'
      && same(wait.intent.wake.scope, record.scope) && wait.intent.wake.goalId === record.id
      && same(wait.intent.wake.definition, record.definition) && wait.intent.wake.native.sessionId === wake.sessionId
      && wait.intent.wake.native.goalId === wake.goalId && wait.intent.wake.native.maxGoalRounds === wake.maxGoalRounds
      && wait.intent.wake.native.revision === wake.revision + 2 && record.native.revision === wait.intent.wake.native.revision + 1
      && record.native.roundsStarted === wait.intent.wake.native.roundsStarted)
    if (waits.length !== 1) return false
    return run.intent.task.goal.id === record.id && run.intent.task.goal.definitionVersion === record.definition.version
      && run.intent.task.goal.definitionDigest === record.definition.digest && run.intent.task.goal.sessionId === wake.sessionId
      && run.intent.task.goal.nativeGoalId === wake.goalId && run.intent.task.goal.nativeRevision === wake.revision + 1
      && run.intent.admission.round === record.native.roundsStarted && run.intent.admission.maxGoalRounds === wake.maxGoalRounds
      && same(run.intent.scope, record.scope)
  }
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
      || (intent.wake.dependencies === undefined
        ? record.checkpoint.dependencies.length > 0
        : !same(record.checkpoint.dependencyBindings ?? [], intent.wake.dependencies))
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
    let completed: GoalRecord | undefined
    try { completed = this.#recordCurrent(wait.intent, false) } catch (error) {
      if (error instanceof Error && /event wait policy denied/u.test(error.message)) this.#terminal(wait, 'denied')
      else throw error
      return
    }
    if (completed?.native.phase === 'complete' && wait.state !== 'materialized') {
      source.retireGoalSource?.(this.#claim(wait.intent))
      this.#terminal(wait, 'settled')
      return
    }
    if (wait.state === 'materialized') {
      const state = this.wake.inspect(wait.intent.wake.scope, wait.intent.wake.goalId)
        .find(item => item.intent.id === wait.match!.wake.id)?.state
      if (state === 'succeeded' || state === 'unknown' || state === 'denied') { this.#terminal(wait, 'settled'); return }
      if (state === 'dispatched' && completed?.native.phase === 'complete') source.retireGoalSource?.(this.#claim(wait.intent))
      if (state === 'dispatched' && completed?.native.phase === 'complete' && source.canSettleGoalSource?.(this.#claim(wait.intent)) === true) return
    }
    const actual = this.#sourceCurrent(wait.intent)
    if (!actual) { this.#terminal(wait, 'source-changed'); return }
    // Revalidate on recovery too: a legacy or interrupted row must never
    // regain wake authority if another goal owns this dedicated source.
    try { source.claimGoalSource?.(this.#claim(wait.intent)) } catch { this.#terminal(wait, 'denied'); return }
    if (wait.state === 'materialized') {
      const state = this.wake.inspect(wait.intent.wake.scope, wait.intent.wake.goalId)
        .find(item => item.intent.id === wait.match!.wake.id)?.state
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
    if (wait.intent.wake.dependencies === undefined
      ? record.checkpoint.dependencies.length > 0
      : !same(record.checkpoint.dependencyBindings ?? [], wait.intent.wake.dependencies)) {
      this.#terminal(wait, 'invalid-current'); return
    }
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
        const proactive = opportunity(this.proactive())
        if (!proactive) { this.#terminal(wait, 'denied'); return }
        let executable = false
        for (let observed = 0; observed < 32; observed++) {
          const input: OpportunityInput = {
            waitId: wait.intent.id, profileId: wait.intent.opportunityProfile, scope: wait.intent.wake.scope,
            goalId: wait.intent.wake.goalId, sessionId: wait.intent.wake.native.sessionId,
            definitionDigest: wait.intent.wake.definition.digest, objective: record.native.objective,
            nativeGoalId: wait.intent.wake.native.goalId, nativeRevision: wait.intent.wake.native.revision,
            ownerRouteId: wait.intent.wake.ownerRouteId, sourceDigest: wait.intent.source.configDigest,
            sourceId: wait.intent.source.sourceId,
            event: { id: envelope.event.id, sequence: found.sequence, digest: externalEventDigest(envelope), occurredAt: envelope.event.occurredAt },
            expiresAt: wait.intent.expiresAt,
          }
          const evaluation = proactive.evaluate(input)
          if (evaluation.disposition === 'consume') { this.#store.advanceCursor(wait.intent.id, found.sequence); return }
          if (evaluation.disposition === 'execute') {
            if (!bindsOpportunityContext(evaluation.decision, input) || !Number.isSafeInteger(evaluation.decision.eventSequence)
              || evaluation.decision.eventSequence < found.sequence) throw new Error('assistant-goals: opportunity execution does not bind the observed event')
            if (evaluation.decision.eventSequence === found.sequence) {
              if (!bindsOpportunityDecision(evaluation.decision, input)) throw new Error('assistant-goals: opportunity execution does not bind the observed event')
              executable = true; break
            }
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
    if (wait.intent.opportunityProfile !== undefined) opportunity(this.proactive())?.closeWait?.(wait.intent.id, wait.intent.wake.scope, reason === 'expired' ? 'expired' : 'cancelled')
    this.#store.terminal(wait.intent.id, reason)
  }
  #onSourceChanged(): void {
    // This is only a prompt to reconcile; a source notification has no authority itself.
    this.reconcile()
  }
  #claim(intent: GoalEventWaitIntent): GoalSourceClaim {
    const prefix = 'event-triggers:'
    if (!intent.source.sourceId.startsWith(prefix) || intent.source.sourceId.length === prefix.length) fail()
    return { triggerId: intent.source.sourceId.slice(prefix.length), scope: intent.wake.scope, goalId: intent.wake.goalId,
      definition: { version: intent.wake.definition.version, digest: intent.wake.definition.digest },
      native: { sessionId: intent.wake.native.sessionId, goalId: intent.wake.native.goalId, revision: intent.wake.native.revision },
      configDigest: intent.source.configDigest, automationId: intent.source.target.automationId }
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
  assertWakeCurrent(wakeIntent: GoalWakeIntent, phase: 'before-resume' | 'running' | 'terminal' = 'before-resume'): void {
    if (!wakeIntent.id.startsWith('goal-event-wake-')) return
    const waitId = wakeIntent.id.slice('goal-event-wake-'.length)
    const wait = this.#store.get(waitId)
    if (!wait || (wait.state !== 'matched' && wait.state !== 'materialized') || !wait.match || !same(wait.match.wake, wakeIntent)
      || Date.now() >= wakeIntent.expiresAt) fail()
    const record = this.#recordCurrent(wait.intent, false)
    if (!record) fail()
    // Retirement stops new observation/execution, but does not revoke the
    // already dispatched wake's right to settle its exact completed Goal.
    const dispatched = this.wake.inspect(wait.intent.wake.scope, wait.intent.wake.goalId)
      .some(wake => wake.intent.id === wakeIntent.id && wake.state === 'dispatched')
    if (phase === 'terminal' && wait.state === 'materialized' && record.native.phase === 'complete' && dispatched) {
      this.#source?.retireGoalSource?.(this.#claim(wait.intent))
      if (this.#source?.canSettleGoalSource?.(this.#claim(wait.intent)) === true) {
        this.#settleCompletedSuccessor(record, wakeIntent)
        return
      }
    }
    if (!this.#sourceCurrent(wait.intent)) fail()
  }

  /** Settle only the unique, already-current successor wait of a completed dispatched parent wake. */
  #settleCompletedSuccessor(record: GoalRecord, parent: GoalWakeIntent): void {
    const revision = parent.native.revision + 2
    if (record.native.revision !== revision + 1 || record.native.roundsStarted <= parent.native.roundsStarted) return
    const child = this.#store.forNative(record.scope, record.id, {
      sessionId: parent.native.sessionId, goalId: parent.native.goalId, revision,
    })
    if (child?.state !== 'waiting' || !same(child.intent.wake.scope, record.scope)
      || child.intent.wake.goalId !== record.id || !same(child.intent.wake.definition, record.definition)
      || child.intent.wake.native.roundsStarted !== record.native.roundsStarted
      || child.intent.wake.native.maxGoalRounds !== parent.native.maxGoalRounds
      || child.intent.wake.native.sessionId !== record.native.sessionId
      || child.intent.wake.native.goalId !== record.native.goalId
      || Date.now() >= child.intent.expiresAt
      || this.#source?.canSettleGoalSource?.(this.#claim(child.intent)) !== true
      || !this.#recordCurrent(child.intent, false)) return
    this.#reconcile(child)
  }
}
