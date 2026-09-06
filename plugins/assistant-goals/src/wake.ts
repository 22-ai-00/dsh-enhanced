import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DeliveryGoalWakeInput, AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutorInput,
  HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalWakeStore } from './wake-store.js'
import type { GoalWake, GoalWakeIntent } from './wake-store.js'
import type { GoalRecord, GoalScope } from './types.js'

export interface GoalWakeConfig { ownerRouteId: string; budgetId: string; maxDelayMs?: number; runTimeoutMs?: number }
const owner = 'assistant-goals-wake/v1'
const catalogDigest = acceptanceDigest({ protocol: owner, operation: 'resume-paused-native-goal', version: 1 })
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (a: unknown, b: unknown): boolean => acceptanceDigest(a) === acceptanceDigest(b)
function reject(): never { throw new Error('assistant-goals: wake authority is unavailable, changed or expired') }

export function validateGoalWakeConfig(value: GoalWakeConfig): Required<GoalWakeConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['ownerRouteId', 'budgetId', 'maxDelayMs', 'runTimeoutMs'].includes(key))
    || [value.ownerRouteId, value.budgetId].some(item => typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(item))) reject()
  const config = { ...value, maxDelayMs: value.maxDelayMs ?? 86_400_000, runTimeoutMs: value.runTimeoutMs ?? 60_000 }
  if (!Number.isSafeInteger(config.maxDelayMs) || config.maxDelayMs < 1 || config.maxDelayMs > 31 * 86_400_000
    || !Number.isSafeInteger(config.runTimeoutMs) || config.runTimeoutMs < 1_000 || config.runTimeoutMs > 300_000) reject()
  return Object.freeze(config)
}

/** One durable at job per owner-authorized intent; Automations owns all scheduling. */
export class GoalWakeRuntime {
  readonly #store: GoalWakeStore
  readonly #capabilities = new Set<DeliveryGoalWakeInput>()
  readonly #lifecycle = new AbortController()
  #automations: AssistantAutomationsService | undefined
  #live = true
  #failures = 0
  constructor(private readonly ctx: Context, path: string, readonly config: Required<GoalWakeConfig>,
    private readonly record: (scope: GoalScope, goalId: string, agent?: Agent) => GoalRecord | undefined,
    private readonly ready: () => boolean) {
    this.#store = new GoalWakeStore(path)
    ctx.inject(['assistantAutomations', 'assistantDelivery', 'assistantPolicy'], runtime => {
      const automations = runtime.assistantAutomations
      this.#automations = automations
      const dispose = automations.registerHostExecutor({
        descriptor: { executorId: owner, contractVersion: 1, catalogDigest },
        accepts: spec => spec.executorId === owner && spec.executorContractVersion === 1
          && spec.catalogDigest === catalogDigest && spec.runbookId === 'resume-paused-native-goal'
          && spec.runbookVersion === 1,
        execute: input => this.#execute(input),
      })
      for (const wake of this.#store.listPending()) {
        try { this.materialize(wake.intent) } catch { this.#failures++ }
      }
      return () => { dispose(); if (this.#automations === automations) this.#automations = undefined }
    })
    ctx.effect(() => () => {
      this.#live = false
      this.#lifecycle.abort()
      this.#store.close()
    }, 'assistant-goals.wakes')
  }
  owns = (input: DeliveryGoalWakeInput): boolean => this.#live && this.#automations !== undefined && this.#capabilities.has(input)
  health = () => ({ enabled: true, connected: this.#automations !== undefined, reconciliationFailures: this.#failures })
  inspect = (scope: GoalScope, goalId: string): readonly GoalWake[] => this.#store.listForGoal(scope, goalId).map(wake => this.#reconcileTerminal(wake))
  #reconcileTerminal(wake: GoalWake): GoalWake {
    if (wake.state !== 'scheduled' || wake.definitionHash === undefined || this.#automations === undefined) return wake
    const actual = this.#automations.inspectSystemOwned({ owner, automationId: wake.intent.id })
    const terminal = actual.latestTerminalRuns.production
    if (actual.definitionHash === wake.definitionHash && terminal?.executionMode === 'production'
      && terminal.immutableContext.state === 'verified' && terminal.immutableContext.definitionHash === wake.definitionHash
      && terminal.immutableContext.scope.workspace === wake.intent.scope.workspace
      && terminal.immutableContext.scope.agentPreset === wake.intent.scope.preset) {
      // The scheduler may have stopped after claim but before our CAS. This is
      // proof that no native wake was submitted, not proof its budget was refunded.
      return this.#store.finish(wake.intent.id, 'denied', Date.now())
    }
    return wake
  }
  preflight(record: GoalRecord): void {
    if (!this.#live || !this.ready() || this.#automations === undefined) reject()
    const policy = this.ctx.get('assistantPolicy')
    if (policy?.getBudgetConfig(this.config.budgetId)?.metric !== 'automation-runs') reject()
    this.#route(record.scope, this.config.ownerRouteId)
  }
  #route(scope: GoalScope, routeId: string): void {
    const receipt = this.ctx.get('assistantDelivery')?.validateOwnerRoute({ authorityId: routeId,
      principalId: scope.principalId, workspace: scope.workspace, agentPreset: scope.preset })
    if (receipt?.principalRecordId !== scope.principalRecordId || receipt.principalVersion !== scope.principalVersion) reject()
  }
  #current(intent: GoalWakeIntent, phase: 'before-resume' | 'running' | 'terminal', agent?: Agent): GoalRecord {
    if (!this.#live || !this.ready() || Date.now() >= intent.expiresAt) reject()
    const record = this.record(intent.scope, intent.goalId, agent)
    if (record === undefined || !same(record.scope, intent.scope) || !same(record.definition, intent.definition)
      || record.native.sessionId !== intent.native.sessionId || record.native.goalId !== intent.native.goalId
      || record.native.maxGoalRounds !== intent.native.maxGoalRounds) reject()
    const native = record.native
    const before = native.phase === 'paused' && native.revision === intent.native.revision
      && native.roundsStarted === intent.native.roundsStarted
    const running = native.phase === 'active' && native.revision === intent.native.revision + 1
    const terminal = (native.phase === 'complete' || native.phase === 'blocked')
      && native.revision === intent.native.revision + 2
    if (!(phase === 'before-resume' ? before : running || phase === 'terminal' && terminal)) reject()
    this.#route(intent.scope, intent.ownerRouteId)
    return record
  }
  materialize(intent: GoalWakeIntent): GoalWake {
    const automations = this.#automations
    if (automations === undefined || !this.#live) reject()
    const wake = this.#store.prepare(intent)
    if (wake.state !== 'prepared' && wake.state !== 'scheduled') return wake
    if (Date.now() >= intent.expiresAt) return this.#store.finish(intent.id, 'denied', Date.now())
    const definition: HostAutomationDefinition = {
      name: 'Scheduled business goal', schedule: { kind: 'at', at: new Date(intent.at).toISOString() },
      workspace: intent.scope.workspace, agentPreset: intent.scope.preset,
      timeoutMs: intent.expiresAt - intent.at, misfire: { kind: 'latest' }, overlap: 'skip',
      retrySafety: 'never', maxRetries: 0, principal: intent.scope.principalId,
      budgetId: intent.budgetId, budgetAmount: 1,
      execution: { kind: 'host', executorId: owner, executorContractVersion: 1,
        runbookId: 'resume-paused-native-goal', runbookVersion: 1, catalogDigest,
        targetScope: { workspace: intent.scope.workspace, preset: intent.scope.preset },
        scopeDigest: '0'.repeat(64), ownerRouteId: intent.ownerRouteId, activationNonce: intent.id },
    }
    // Publish paused first: no coordinator may claim the at occurrence until
    // the exact definition binding is committed in the Goals database.
    const result = automations.reconcileSystem({ owner, automationId: intent.id,
      idempotencyKey: `prepare:${intent.id}`, desiredStatus: 'paused', definition })
    const definitionHash = hash(result.definition)
    this.#store.scheduled(intent.id, definitionHash)
    automations.reconcileSystem({ owner, automationId: intent.id,
      idempotencyKey: `activate:${intent.id}`, desiredStatus: 'active', definition })
    const actual = automations.inspectSystemOwned({ owner, automationId: intent.id })
    if (actual.definitionHash !== definitionHash) reject()
    return this.#reconcileTerminal(this.#store.get(intent.id)!)
  }
  #result(outcome: 'succeeded' | 'failed' | 'unknown', code: string, dispatched: boolean): HostAutomationExecutorResult {
    return outcome === 'succeeded'
      ? { outcome, failureClass: 'none', failurePhase: 'none', failureCode: 'none', sideEffectState: 'possible', retryability: 'unsafe' }
      : { outcome, failureClass: dispatched ? 'unknown' : 'policy', failurePhase: 'host-execution', failureCode: code,
        sideEffectState: dispatched ? 'unknown' : 'none', retryability: dispatched ? 'unsafe' : 'after-intervention' }
  }
  async #execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    const wake = this.#store.get(input.activationNonce)
    if (!this.#live || wake === undefined || input.executionMode !== 'production'
      || wake.intent.id !== input.automationId || wake.definitionHash !== input.definitionHash
      || input.catalogDigest !== catalogDigest || !same(input.targetScope, { workspace: wake.intent.scope.workspace, preset: wake.intent.scope.preset })
      || input.principal !== wake.intent.scope.principalId || input.ownerRouteId !== wake.intent.ownerRouteId) {
      return this.#result('failed', 'goal-wake-identity-denied', false)
    }
    if (wake.state !== 'scheduled') return this.#result('unknown', 'goal-wake-prior-state', true)
    const intent = wake.intent
    let dispatched = false
    const signal = AbortSignal.any([input.signal, this.#lifecycle.signal])
    const capability: DeliveryGoalWakeInput = Object.freeze({ attestation: intent.attestation,
      native: { goalId: intent.native.goalId, revision: intent.native.revision }, deadlineAt: intent.expiresAt, signal,
      assertCurrent: (agent: Agent, phase: 'before-resume' | 'running' | 'terminal') => {
        signal.throwIfAborted()
        this.#current(intent, phase, agent)
        const current = this.#store.get(intent.id)
        if (dispatched ? current?.state !== 'dispatched' || current.occurrenceId !== input.occurrenceId
          : current?.state !== 'scheduled') reject()
      },
      beforeResume: (agent: Agent) => {
        signal.throwIfAborted()
        this.#current(intent, 'before-resume', agent)
        this.#store.dispatch(intent.id, input.occurrenceId, Date.now())
        dispatched = true
      },
    })
    this.#capabilities.add(capability)
    try {
      signal.throwIfAborted()
      this.#current(intent, 'before-resume')
      const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
      if (delivery === undefined) reject()
      const result = await delivery.resumeScheduledGoal(capability)
      if (result.dispatched !== dispatched) throw new Error('assistant-goals: wake dispatch disagreement')
      const succeeded = result.outcome === 'succeeded' && result.quiescent && dispatched && !signal.aborted
      if (succeeded) this.#current(intent, 'terminal')
      this.#store.finish(intent.id, succeeded ? 'succeeded' : dispatched ? 'unknown' : 'denied', Date.now())
      return this.#result(succeeded ? 'succeeded' : dispatched ? 'unknown' : 'failed', `goal-wake-${result.outcome}`, dispatched)
    } catch {
      if (this.#live) this.#store.finish(intent.id, dispatched ? 'unknown' : 'denied', Date.now())
      return this.#result(dispatched ? 'unknown' : 'failed', 'goal-wake-execution-unconfirmed', dispatched)
    } finally { this.#capabilities.delete(capability) }
  }
}
