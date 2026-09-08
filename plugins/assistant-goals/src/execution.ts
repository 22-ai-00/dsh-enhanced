import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { acceptanceDigest, validateTaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalArtifactAdmission, TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import type { AcceptanceHandle, AcceptedExecution, TaskAcceptanceRegistration } from '@dsh-enhanced/assistant-verifier'
import { GoalExecutionStore } from './execution-store.js'
import type { GoalExecutionRun, GoalRecord, GoalScope } from './types.js'

interface ActiveRound {
  agent: Agent
  turn: number
  run: GoalExecutionRun
  handle: AcceptanceHandle
  registration: TaskAcceptanceRegistration
  signal: AbortSignal
  terminal?: SessionEvent<'turn/end'>
  timer: ReturnType<typeof setTimeout>
  removeAbort(): void
  finishing: boolean
  finish?: Promise<void>
  eventWaitPause?: { goalId: string; revision: number; materialized: boolean }
}

/** Observes actual admitted native rounds; never queues prompts or accepts model verdicts. */
export class GoalExecutionRuntime {
  readonly #generation = randomUUID()
  readonly #store: GoalExecutionStore | undefined
  readonly #rounds = new Map<Agent, ActiveRound>()
  readonly #pending = new Set<Promise<void>>()
  readonly #settlements = new WeakMap<Agent, Promise<void>>()
  readonly #revoked = new WeakSet<Agent>()
  #sink: TaskAcceptanceRegistration | undefined
  #active = true

  constructor(
    private readonly ctx: Context,
    path: string | undefined,
    private readonly maxDurationMs: number,
    private readonly current: (agent: Agent) => { scope: GoalScope; record: GoalRecord },
    private readonly outcome?: {
      prepare(agent: Agent, run: GoalExecutionRun): void
      settled(agent: Agent, run: GoalExecutionRun, assertCurrent: () => void): Promise<void>
    },
  ) {
    if (path !== undefined) {
      this.#store = new GoalExecutionStore(path)
      this.#store.recoverIncomplete()
      ctx.on('agent/request', async ({ agent, turn, signal }, next) => {
        if (this.#revoked.has(agent)) throw new Error('assistant-goals: cancelled execution cannot resume')
        if (!this.#isGoalTurn(agent, turn)) return await next()
        try {
          await this.#admit(agent, turn, signal)
          const result = await next()
          this.#assertRound(this.#rounds.get(agent)!)
          return result
        } catch (error) {
          agent.cancel({ kind: 'hook', reason: 'assistant-goals-step-admission-failed' })
          throw error
        }
      })
      ctx.on('tools/pre-execute', async ({ agent }, next) => {
        if (agent !== undefined && this.#revoked.has(agent)) return { kind: 'deny' as const, reason: 'assistant-goals: execution cancelled' }
        const round = agent === undefined ? undefined : this.#rounds.get(agent)
        if (round !== undefined) {
          if (round.eventWaitPause !== undefined) return { kind: 'deny' as const, reason: 'assistant-goals: paused event wait concludes this turn' }
          try { this.#assertRound(round) } catch {
            this.#cancel(round)
            return { kind: 'deny' as const, reason: 'assistant-goals: step authorization changed' }
          }
        }
        return await next()
      })
      ctx.inject(['tools'], tools => tools.tools.guard(execution => {
        if (execution.agent !== undefined && this.#revoked.has(execution.agent)) return 'assistant-goals: execution cancelled'
        const round = execution.agent === undefined ? undefined : this.#rounds.get(execution.agent)
        if (round === undefined) return undefined
        if (round.eventWaitPause !== undefined) return 'assistant-goals: paused event wait concludes this turn'
        try { this.#assertRound(round); return undefined } catch {
          this.#cancel(round)
          return 'assistant-goals: step authorization changed'
        }
      }))
      ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end') return
        for (const round of this.#rounds.values()) {
          if (round.agent.session === session && round.turn === event.data.turn) {
            round.terminal = event
            this.#track(this.#finish(round, event.data.reason?.kind === 'completed'))
          }
        }
      })
      ctx.on('agent/disposed', ({ agent }) => {
        const round = this.#rounds.get(agent)
        if (round !== undefined) this.#track(this.#finish(round, false))
      })
    }
    ctx.effect(() => async () => {
      this.#active = false
      for (const round of this.#rounds.values()) {
        this.#cancel(round)
        this.#track(this.#finish(round, false))
      }
      await this.whenIdle()
      this.#sink = undefined
      this.#store?.close()
    }, 'assistant-goals.executions')
  }

  generation = (): string => {
    if (!this.#active) throw new Error('assistant-goals: inactive execution producer')
    return this.#generation
  }

  register = (registration: TaskAcceptanceRegistration): (() => void) => {
    this.generation()
    const verifier = this.ctx.get('assistantVerifier', false)
    if (registration.protocol !== 'assistant-verifier/host-producer/v1'
      || registration.generation !== this.#generation || this.#sink !== undefined
      || verifier?.ownsTaskAcceptanceRegistration(registration) !== true) {
      throw new Error('assistant-goals: untrusted acceptance registration')
    }
    this.#sink = registration
    return () => {
      if (this.#sink !== registration) return
      this.#sink = undefined
      for (const round of this.#rounds.values()) {
        this.#cancel(round)
        this.#track(this.#finish(round, false))
      }
    }
  }

  inspect = async (input: TaskAcceptanceContract): Promise<AcceptedExecution | null> => {
    this.generation()
    const contract = validateTaskAcceptanceContract(input)
    if (contract.task.kind !== 'goal-step') throw new Error('assistant-goals: foreign task kind')
    const run = this.#store?.getByContract(contract.id)
    if (run?.acceptance?.contractDigest !== contract.digest || run.dispatchedAt === undefined || run.execution === undefined) return null
    if (acceptanceDigest(run.intent.task) !== acceptanceDigest(contract.task)
      || run.intent.objective !== contract.objective
      || run.intent.scope.workspace !== contract.scope.workspace || run.intent.scope.preset !== contract.scope.preset
      || run.intent.scope.principalRecordId !== contract.owner.principalRecordId
      || run.intent.scope.principalVersion !== contract.owner.principalVersion) throw new Error('assistant-goals: execution binding differs')
    return Object.freeze({ ...run.execution, ...run.acceptance, dispatchedAt: run.dispatchedAt, executionRef: run.intent.runId })
  }

  currentArtifactAdmission = (agent: Agent): GoalArtifactAdmission | undefined => {
    const round = this.#rounds.get(agent)
    if (!round || round.finishing || round.run.dispatchedAt === undefined) return undefined
    this.#assertRound(round)
    return Object.freeze({ protocol: 'goal-artifact-admission/v1', ...round.handle, runId: round.run.intent.runId, turn: round.turn })
  }
  artifactSource = async (contract: TaskAcceptanceContract): Promise<AcceptanceHandle | null> => {
    const proof = await this.inspect(contract)
    return proof?.status === 'succeeded' && proof.quiescent ? { contractId: contract.id, contractDigest: contract.digest } : null
  }

  list = (scope: GoalScope, goalId: string): readonly GoalExecutionRun[] => this.#store?.listForGoal(scope, goalId) ?? []
  /** Assembly may precede pre-step; wait only for this Agent's previous terminal round. */
  refresh = async (agent: Agent | undefined, signal?: AbortSignal): Promise<void> => {
    const pending = agent === undefined ? undefined : this.#settlements.get(agent)
    if (pending !== undefined) await this.#bounded(pending, signal ?? new AbortController().signal)
  }
  whenIdle = async (): Promise<void> => { while (this.#pending.size) await Promise.all(this.#pending) }
  health = () => ({ enabled: this.#store !== undefined, verifierConnected: this.#sink !== undefined, activeRounds: this.#rounds.size })
  budgetState = (agent: Agent): { record: GoalRecord; run: GoalExecutionRun; signal: AbortSignal } | undefined => {
    if (this.#revoked.has(agent)) throw new Error('assistant-goals: cancelled execution cannot resume')
    const round = this.#rounds.get(agent)
    if (round === undefined) return undefined
    this.#assertRound(round)
    return { record: this.current(agent).record, run: round.run, signal: round.signal }
  }

  /** Pause only the exact admitted native round; terminal success remains gated on materialization. */
  pauseForEventWait = (agent: Agent, goalId: string, expectedRevision: number): GoalRecord => {
    const round = this.#rounds.get(agent)
    if (round === undefined || round.eventWaitPause !== undefined) throw new Error('assistant-goals: admitted native goal round required')
    this.#assertRound(round)
    const current = this.current(agent).record
    const task = round.run.intent.task.goal
    const native = this.ctx.get('goals')?.get(agent)
    if (current.id !== goalId || task.id !== goalId || task.nativeRevision !== expectedRevision || current.native.revision !== expectedRevision
      || native === undefined || String(native.id) !== task.nativeGoalId || native.revision !== expectedRevision || native.phase !== 'active') {
      throw new Error('assistant-goals: admitted native goal round changed')
    }
    this.ctx.get('goals')!.pause(agent, { id: native.id, revision: expectedRevision })
    const paused = this.current(agent).record
    if (paused.id !== goalId || paused.native.phase !== 'paused' || paused.native.revision !== expectedRevision + 1
      || paused.native.goalId !== task.nativeGoalId || paused.native.sessionId !== task.sessionId) {
      throw new Error('assistant-goals: native event wait pause was not confirmed')
    }
    round.eventWaitPause = { goalId, revision: paused.native.revision, materialized: false }
    return paused
  }

  acceptPausedEventWait = (agent: Agent, goalId: string, revision: number): void => {
    const round = this.#rounds.get(agent)
    const permit = round?.eventWaitPause
    if (round === undefined || permit === undefined || permit.materialized || permit.goalId !== goalId || permit.revision !== revision) {
      throw new Error('assistant-goals: native event wait pause is unavailable')
    }
    this.#assertRound(round)
    permit.materialized = true
  }

  hasAcceptedPausedEventWait = (agent: Agent | undefined): boolean => {
    if (agent === undefined) return false
    const round = this.#rounds.get(agent)
    const permit = round?.eventWaitPause
    if (round === undefined || permit?.materialized !== true) return false
    try { this.#assertRound(round); return true } catch { return false }
  }

  #isGoalTurn(agent: Agent, turn: number): boolean {
    const events = agent.session.snapshotEvents()
    const start = events.findLast(event => event.type === 'turn/start')
    if (start?.type !== 'turn/start' || start.data.turn !== turn
      || events.some(event => event.seq > start.seq && event.type === 'turn/end')) return false
    return events.some(event => event.seq > start.seq && event.type === 'user/message'
      && event.data.source.kind === 'goal' && event.data.source.round > 0)
  }

  async #admit(agent: Agent, turn: number, signal: AbortSignal): Promise<void> {
    const existing = this.#rounds.get(agent)
    if (existing !== undefined) {
      if (existing.turn === turn) {
        if (existing.eventWaitPause !== undefined) throw new Error('assistant-goals: paused event wait concludes this turn')
        if (existing.finishing) throw new Error('assistant-goals: round has already ended')
        this.#assertRound(existing)
        return
      }
      if (existing.finish === undefined) throw new Error('assistant-goals: previous round has not settled')
      await this.#bounded(existing.finish, signal)
    }
    const store = this.#store!
    const registration = this.#sink
    if (!this.#active || registration === undefined) throw new Error('assistant-goals: step verifier unavailable')
    signal.throwIfAborted()
    const { scope, record } = this.current(agent)
    const native = this.ctx.get('goals')?.get(agent)
    const start = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start' && event.data.turn === turn)
    const sources = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && start !== undefined && event.seq > start.seq && event.data.source.kind === 'goal' && event.data.source.round > 0)
    const source = sources.length === 1 && sources[0]?.type === 'user/message' ? sources[0].data.source : undefined
    if (source?.kind !== 'goal' || native === undefined || native.id !== source.goalId || native.revision !== source.revision
      || native.phase !== 'active' || native.roundsStarted !== source.round || record.native.goalId !== String(native.id)
      || record.native.sessionId !== String(agent.session.id)) throw new Error('assistant-goals: native round is not current')
    const runId = `goal-run-${acceptanceDigest([scope, record.id, String(agent.session.id), turn])}`
    const now = Date.now()
    const prepared = store.prepare({ runId, scope, objective: record.definition.objective,
      task: { kind: 'goal-step', ref: runId, goal: { id: record.id, definitionVersion: record.definition.version,
        definitionDigest: record.definition.digest, stepId: `round-${source.round}`, runId,
        sessionId: String(agent.session.id), nativeGoalId: String(native.id), nativeRevision: native.revision } },
      admission: { issuedAt: now, expiresAt: now + this.maxDurationMs, maxGoalRounds: native.maxGoalRounds, round: source.round,
        authorizationDigest: acceptanceDigest({ scope, action: 'execute', resource: { kind: 'goal', id: 'business-context' } }) },
    })
    if (prepared.dispatchedAt !== undefined || prepared.execution !== undefined) throw new Error('assistant-goals: prior dispatch requires reconciliation')
    const handle = registration.prepare({ scope: { workspace: scope.workspace, preset: scope.preset },
      owner: { principalRecordId: scope.principalRecordId, principalVersion: scope.principalVersion },
      task: prepared.intent.task, objective: prepared.intent.objective })
    if (handle === null) throw new Error('assistant-goals: no exact goal-step acceptance profile')
    store.bindAcceptance(runId, handle)
    const round: ActiveRound = { agent, turn, run: store.get(runId)!, handle, registration, signal, finishing: false,
      timer: setTimeout(() => { this.#cancel(round); this.#track(this.#finish(round, false)) }, this.maxDurationMs),
      removeAbort: () => signal.removeEventListener('abort', abort) }
    const abort = () => { this.#cancel(round); this.#track(this.#finish(round, false)) }
    round.timer.unref?.()
    this.#rounds.set(agent, round)
    signal.addEventListener('abort', abort, { once: true })
    try {
      this.#assertRound(round)
      this.outcome?.prepare(agent, round.run)
      if (!await this.#bounded(this.ctx.get('sessions')!.flush(agent.session), signal)) throw new Error('assistant-goals: native round checkpoint failed')
      this.#assertRound(round)
      if (round.finishing) throw new Error('assistant-goals: admission cancelled')
      round.run = store.markDispatched(runId, Date.now())
    } catch (error) {
      this.#cancel(round)
      await this.#finish(round, false)
      throw error
    }
  }

  #assertRound(round: ActiveRound, terminal = false): void {
    if (!this.#active || this.#sink !== round.registration || round.signal.aborted
      || this.#revoked.has(round.agent)
      || Date.now() >= round.run.intent.admission.expiresAt) throw new Error('assistant-goals: step admission expired')
    const { scope, record } = this.current(round.agent)
    const exactRevision = record.native.revision === round.run.intent.task.goal.nativeRevision
    const terminalTransition = terminal && record.native.revision === round.run.intent.task.goal.nativeRevision + 1
      && (record.native.phase === 'complete'
        || (record.native.phase === 'blocked' && record.native.roundsStarted === round.run.intent.admission.maxGoalRounds))
    const eventWaitPause = round.eventWaitPause
    const pausedForEventWait = eventWaitPause !== undefined && eventWaitPause.goalId === record.id
      && record.native.revision === eventWaitPause.revision && record.native.phase === 'paused'
      && (!terminal || eventWaitPause.materialized)
    if (acceptanceDigest(scope) !== acceptanceDigest(round.run.intent.scope)
      || record.id !== round.run.intent.task.goal.id || record.definition.version !== round.run.intent.task.goal.definitionVersion
      || record.definition.digest !== round.run.intent.task.goal.definitionDigest
      || record.native.goalId !== round.run.intent.task.goal.nativeGoalId
      || record.native.sessionId !== round.run.intent.task.goal.sessionId
      || record.native.maxGoalRounds !== round.run.intent.admission.maxGoalRounds
      || !(exactRevision && record.native.phase === 'active' || terminalTransition || pausedForEventWait)) throw new Error('assistant-goals: goal definition or authority changed')
  }

  #cancel(round: ActiveRound): void {
    this.#revoked.add(round.agent)
    try { round.agent.cancel({ kind: 'hook', reason: 'assistant-goals-step-cancelled' }) } catch {}
  }

  #finish(round: ActiveRound, completed: boolean): Promise<void> {
    if (round.finish !== undefined) return round.finish
    round.finishing = true
    round.finish = Promise.resolve().then(() => this.#settle(round, completed))
    this.#settlements.set(round.agent, round.finish)
    void round.finish.finally(() => {
      if (this.#settlements.get(round.agent) === round.finish) this.#settlements.delete(round.agent)
    }).catch(() => {})
    return round.finish
  }

  async #settle(round: ActiveRound, completed: boolean): Promise<void> {
    let succeeded = completed
    try {
      if (succeeded) {
        this.#assertRound(round, true)
        succeeded = await this.#bounded(this.ctx.get('sessions')!.flush(round.agent.session), round.signal)
        this.#assertRound(round, true)
      }
    } catch { succeeded = false }
    if (!succeeded) this.#cancel(round)
    try {
      const saved = this.#store!.get(round.run.intent.runId)!
      if (saved.dispatchedAt !== undefined) {
        this.#store!.finish(saved.intent.runId, { status: succeeded ? 'succeeded' : 'unknown', quiescent: succeeded, completedAt: Date.now() })
      }
    } finally {
      clearTimeout(round.timer)
      round.removeAbort()
      if (this.#rounds.get(round.agent) === round) this.#rounds.delete(round.agent)
    }
    if (this.#active && this.#sink === round.registration) {
      await this.#bounded(round.registration.completed(round.handle), new AbortController().signal)
      const verifier = this.ctx.get('assistantVerifier', false)
      if (this.#active && this.#sink === round.registration && verifier?.ownsTaskAcceptanceRegistration(round.registration)) {
        // One existing bounded reconciliation cycle. Busy queues may still be
        // pending; the context reports that honestly instead of inferring success.
        await this.#bounded(verifier.tick(), new AbortController().signal)
      }
      const saved = this.#store!.get(round.run.intent.runId)!
      if (this.#active && this.outcome !== undefined) {
        await this.#bounded(this.outcome.settled(round.agent, saved, () => this.#assertRound(round, true)), new AbortController().signal)
      }
    }
  }

  #track(promise: Promise<void>): void {
    const guarded = promise.catch(() => { this.ctx.logger.warn('assistant-goals: step reconciliation incomplete') })
    this.#pending.add(guarded)
    void guarded.finally(() => this.#pending.delete(guarded))
  }

  #bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error('assistant-goals: step operation cancelled')) }
      const timer = setTimeout(abort, this.maxDurationMs)
      timer.unref?.()
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    })
  }
}
