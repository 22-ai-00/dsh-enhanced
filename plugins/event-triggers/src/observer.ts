import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AssistantAutomationsService,
  HostAutomationExecutionSpec,
  HostAutomationExecutorInput,
  HostAutomationExecutorResult,
} from '@dsh-enhanced/assistant-automations'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { OwnerRouteValidationReceipt } from '@dsh-enhanced/assistant-delivery'
import type { GoalSourceClaim, EventTriggerStore } from './store.js'
import type { ObserverLifetime } from './config.js'

export interface EventObserverConfig {
  workspace: string
  preset: string
  principalId: string
  principalRecordId: string
  principalVersion: number
  ownerRouteId: string
  expiresAt: number
  budgetId: string
}

export const EVENT_OBSERVER_EXECUTOR = 'event-triggers-observer/v1' as const
const RUNBOOK_ID = 'observe-persisted-event-source' as const
const RUNBOOK_VERSION = 1 as const
const SYSTEM_OWNER = EVENT_OBSERVER_EXECUTOR
const FUTURE_AT = '2099-01-01T00:00:00.000Z'

type Binding = Readonly<{
  triggerId: string
  automationId: string
  configDigest: string
  owner: EventObserverConfig
  lifetime: ObserverLifetime
}>

type GoalLifecycle = Readonly<{ scope: GoalSourceClaim['scope']; id: string; definition: { version: number; digest: string }; native: { sessionId: string; goalId: string; revision: number; phase: string } }>
type GoalLifecycleReader = { inspectGoalLifecycle(input: { scope: GoalSourceClaim['scope']; goalId: string }): GoalLifecycle | undefined }

function digest(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input)
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`
    const record = input as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function scopeDigest(owner: EventObserverConfig): string {
  return digest([resolve(owner.workspace), owner.preset])
}
const sameScope = (left: GoalSourceClaim['scope'], right: GoalSourceClaim['scope']) => left.principalId === right.principalId
  && left.principalRecordId === right.principalRecordId && left.principalVersion === right.principalVersion
  && resolve(left.workspace) === resolve(right.workspace) && left.preset === right.preset

function catalogDigest(): string {
  return digest({ executor: EVENT_OBSERVER_EXECUTOR, contractVersion: 1, runbook: RUNBOOK_ID, version: RUNBOOK_VERSION })
}

const CATALOG_DIGEST = catalogDigest()

/**
 * Binds the existing durable event source to a finite, owner-authorized Host
 * automation. It never reads an event body and never enters a model lane.
 */
export class EventSourceObservers {
  private readonly bindings = new Map<string, Binding>()
  private readonly receipts = new Map<string, Readonly<OwnerRouteValidationReceipt>>()
  private readonly definitionHashes = new Map<string, string>()
  private automations: AssistantAutomationsService | undefined
  private policy: AssistantPolicyService | undefined
  private delivery: AssistantDeliveryService | undefined
  private unregister: (() => void) | undefined
  private injection: { dispose(): Promise<void> } | undefined
  private active = true

  constructor(private readonly ctx: Context, bindings: readonly Binding[], private readonly store: EventTriggerStore) {
    const automationIds = new Set<string>()
    for (const binding of bindings) {
      if (this.bindings.has(binding.triggerId)) throw new Error(`event-triggers: duplicate observer trigger ${binding.triggerId}`)
      if (automationIds.has(binding.automationId)) throw new Error(`event-triggers: duplicate observer automation ${binding.automationId}`)
      automationIds.add(binding.automationId)
      this.bindings.set(binding.triggerId, Object.freeze({ ...binding, lifetime: binding.lifetime, owner: Object.freeze({ ...binding.owner }) }))
    }
    const activate = (runtime: Context): (() => void) | undefined => {
      if (!this.active) return
      this.unregister?.()
      this.automations = runtime.get('assistantAutomations') as AssistantAutomationsService | undefined
      this.policy = runtime.get('assistantPolicy') as AssistantPolicyService | undefined
      this.delivery = runtime.get('assistantDelivery') as AssistantDeliveryService | undefined
      if (this.automations === undefined || this.policy === undefined
        || (this.bindings.size > 0 && this.delivery === undefined)) return
      if (this.bindings.size > 0) this.unregister = this.automations.registerHostExecutor({
        descriptor: Object.freeze({ executorId: EVENT_OBSERVER_EXECUTOR, contractVersion: 1, catalogDigest: CATALOG_DIGEST }),
        accepts: spec => this.accepts(spec),
        execute: input => this.execute(input),
      })
      if (this.bindings.size > 0 || typeof this.automations.listSystemOwned === 'function') this.reconcile()
      return () => { this.unregister?.(); this.unregister = undefined; this.automations = undefined; this.policy = undefined; this.delivery = undefined }
    }
    const dependencies = this.bindings.size === 0
      ? ['assistantAutomations', 'assistantPolicy']
      : ['assistantAutomations', 'assistantPolicy', 'assistantDelivery']
    this.injection = ctx.inject(dependencies as never, activate)
    activate(ctx)
    ctx.effect(() => () => {
      this.active = false
      this.unregister?.()
      this.unregister = undefined
      void this.injection?.dispose()
    }, 'event-triggers.observer')
  }

  assertCurrent = (triggerId: string): void => {
    const binding = this.bindings.get(triggerId)
    if (binding === undefined) return
    if (!this.assertGoalClaimCurrent(binding)) throw new Error('event-triggers: observer goal binding is retired or changed')
    const receipt = this.assertBinding(binding), automations = this.requireAutomations()
    const activation = automations.inspectSystemOwnedActivation({ owner: SYSTEM_OWNER, automationId: binding.automationId })
    const current = automations.inspectSystemOwned({ owner: SYSTEM_OWNER, automationId: binding.automationId })
    if (!activation || current.automationStatus !== 'active' || activation.definitionHash !== this.definitionHashes.get(triggerId)
      || activation.activationNonce !== this.activationNonce(binding, receipt) || activation.ownerRouteId !== binding.owner.ownerRouteId) {
      this.pauseCurrent(binding.automationId, 'source-changed')
      throw new Error('event-triggers: observer source is paused or changed')
    }
  }

  claimGoalSource(input: GoalSourceClaim): boolean {
    const binding = this.bindings.get(input.triggerId)
    if (binding === undefined || binding.lifetime === 'shared') return false
    if (!this.claimMatches(binding, input)) throw new Error('event-triggers: observer goal binding does not match source configuration')
    this.assertBinding(binding)
    this.store.claimGoalSource(input)
    return true
  }

  retireGoalSource(input: GoalSourceClaim): boolean {
    const binding = this.bindings.get(input.triggerId)
    if (binding === undefined || binding.lifetime === 'shared') return false
    if (!this.claimMatches(binding, input) || !this.trustedComplete(input)) throw new Error('event-triggers: observer goal completion is not trusted')
    this.store.retireGoalSource(input)
    this.pauseCurrent(binding.automationId, 'goal-complete')
    return true
  }

  /** Read-only terminal settlement guard for an already retired dedicated source. */
  canSettleGoalSource(input: GoalSourceClaim): boolean {
    try {
      const binding = this.bindings.get(input.triggerId)
      if (binding === undefined || binding.lifetime !== 'goal' || !this.claimMatches(binding, input)) return false
      const claim = this.store.goalSourceClaim(input.triggerId)
      if (claim === undefined || claim.retiredAt === undefined || !this.sameClaimIdentity(claim, input)) return false
      this.assertBinding(binding)
      return this.trustedComplete(input)
    } catch { return false }
  }

  private accepts(spec: HostAutomationExecutionSpec): boolean {
    return spec.kind === 'host'
      && spec.executorId === EVENT_OBSERVER_EXECUTOR
      && spec.executorContractVersion === 1
      && spec.runbookId === RUNBOOK_ID
      && spec.runbookVersion === RUNBOOK_VERSION
      && spec.catalogDigest === CATALOG_DIGEST
      && spec.scopeDigest === digest([resolve(spec.targetScope.workspace), spec.targetScope.preset])
  }

  private activationNonce(binding: Binding, receipt: Readonly<OwnerRouteValidationReceipt>): string {
    return digest({ contract: EVENT_OBSERVER_EXECUTOR, triggerId: binding.triggerId, automationId: binding.automationId,
      configDigest: binding.configDigest, owner: binding.owner, route: receipt })
  }

  private definition(binding: Binding, receipt: Readonly<OwnerRouteValidationReceipt>) {
    const owner = binding.owner
    return Object.freeze({
      name: `Observe event source: ${binding.triggerId}`,
      schedule: Object.freeze({ kind: 'at' as const, at: FUTURE_AT }),
      workspace: resolve(owner.workspace), agentPreset: owner.preset, timeoutMs: 30_000,
      misfire: Object.freeze({ kind: 'latest' as const }), overlap: 'skip' as const,
      retrySafety: 'never' as const, maxRetries: 0, principal: owner.principalId,
      budgetId: owner.budgetId, budgetAmount: 1,
      execution: Object.freeze({ kind: 'host' as const, executorId: EVENT_OBSERVER_EXECUTOR,
        executorContractVersion: 1, runbookId: RUNBOOK_ID, runbookVersion: RUNBOOK_VERSION,
        catalogDigest: CATALOG_DIGEST, targetScope: Object.freeze({ workspace: resolve(owner.workspace), preset: owner.preset }),
        scopeDigest: scopeDigest(owner), ownerRouteId: owner.ownerRouteId, activationNonce: this.activationNonce(binding, receipt) }),
    })
  }

  private reconcile(): void {
    const automations = this.requireAutomations()
    const desired = new Set([...this.bindings.values()].map(binding => binding.automationId))
    const inventory = automations.listSystemOwned({ owner: SYSTEM_OWNER, limit: 1_000 })
    if (inventory.length === 1_000) throw new Error('event-triggers: observer inventory reached safe reconciliation bound')
    for (const current of inventory) {
      if (desired.has(current.automationId) || current.automationStatus !== 'active') continue
      this.pause(current.automationId, current.definitionHash, current.definitionVersion, 'remove')
    }
    for (const binding of this.bindings.values()) {
      if (!this.assertGoalClaimCurrent(binding)) continue
      let receipt: Readonly<OwnerRouteValidationReceipt>
      try {
        receipt = this.assertBinding(binding)
        this.receipts.set(binding.triggerId, receipt)
      } catch {
        this.pauseCurrent(binding.automationId, 'unattested')
        continue
      }
      const definition = this.definition(binding, receipt)
      const existing = automations.inspectSystemOwnedActivation({ owner: SYSTEM_OWNER, automationId: binding.automationId })
      // A restart must prove the route receipt already sealed in the durable
      // definition before it can keep or reactivate that source.
      if (existing !== undefined && (existing.ownerRouteId !== binding.owner.ownerRouteId
        || existing.activationNonce !== definition.execution.activationNonce)) {
        this.pauseCurrent(binding.automationId, 'persistent-route-mismatch')
        continue
      }
      const bindingIdentity = binding.lifetime === 'shared'
        ? { triggerId: binding.triggerId, automationId: binding.automationId, configDigest: binding.configDigest, owner: binding.owner }
        : binding
      const reconciled = automations.reconcileSystem({ owner: SYSTEM_OWNER, automationId: binding.automationId,
        idempotencyKey: `event-observer:v1:${digest({ binding: bindingIdentity, definition })}`, desiredStatus: 'active', definition })
      // Reconcile returns the original normalized definition on idempotent
      // replay, including after another controller changes the current row.
      this.definitionHashes.set(binding.triggerId, createHash('sha256').update(JSON.stringify(reconciled.definition)).digest('hex'))
    }
  }

  private execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    try {
      if (!this.active || input.signal.aborted || input.executionMode !== 'production') throw new Error('inactive')
      const binding = [...this.bindings.values()].find(value => value.automationId === input.automationId)
      if (binding === undefined) throw new Error('unknown automation')
      const receipt = this.assertBinding(binding)
      this.receipts.set(binding.triggerId, receipt)
      const definition = this.definition(binding, receipt)
      const activation = this.requireAutomations().inspectSystemOwnedActivation({ owner: SYSTEM_OWNER, automationId: binding.automationId })
      const health = this.requireAutomations().inspectSystemOwned({ owner: SYSTEM_OWNER, automationId: binding.automationId })
      if (activation === undefined || health.automationStatus !== 'active'
        || activation.definitionHash !== this.definitionHashes.get(binding.triggerId)
        || activation.definitionHash !== input.definitionHash || activation.ownerRouteId !== binding.owner.ownerRouteId
        || activation.activationNonce !== definition.execution.activationNonce
        || input.definitionHash !== health.definitionHash
        || input.principal !== binding.owner.principalId || input.ownerRouteId !== binding.owner.ownerRouteId
        || input.activationNonce !== definition.execution.activationNonce
        || input.targetScope.workspace !== definition.execution.targetScope.workspace
        || input.targetScope.preset !== definition.execution.targetScope.preset) throw new Error('stale definition')
      return Promise.resolve(Object.freeze({ outcome: 'succeeded' as const, failureClass: 'none' as const,
        failurePhase: 'none' as const, failureCode: 'none', sideEffectState: 'none' as const, retryability: 'safe' as const }))
    } catch {
      return Promise.resolve(Object.freeze({ outcome: 'failed' as const, failureClass: 'policy' as const,
        failurePhase: 'host-execution' as const, failureCode: 'observer-authority', sideEffectState: 'none' as const,
        retryability: 'after-intervention' as const }))
    }
  }

  private assertBinding(binding: Binding): Readonly<OwnerRouteValidationReceipt> {
    if (!this.active) throw new Error('event-triggers: observer disposed')
    if (Date.now() >= binding.owner.expiresAt) {
      this.pauseCurrent(binding.automationId, 'expired')
      throw new Error('event-triggers: observer authorization expired')
    }
    const receipt = this.routeReceipt(binding)
    if (receipt.principalRecordId !== binding.owner.principalRecordId || receipt.principalVersion !== binding.owner.principalVersion
      || receipt.principalId !== binding.owner.principalId || receipt.workspace !== resolve(binding.owner.workspace)
      || receipt.agentPreset !== binding.owner.preset) {
      this.pauseCurrent(binding.automationId, 'route-changed')
      throw new Error('event-triggers: observer owner route changed')
    }
    const frozen = this.receipts.get(binding.triggerId)
    if (frozen !== undefined && (receipt.authorityHash !== frozen.authorityHash || receipt.bindingVersion !== frozen.bindingVersion
      || receipt.generation !== frozen.generation)) {
      this.pauseCurrent(binding.automationId, 'route-rebound')
      throw new Error('event-triggers: observer owner route changed')
    }
    const decision = this.requirePolicy().evaluate({
      subject: { kind: 'background', id: SYSTEM_OWNER, workspace: resolve(binding.owner.workspace), principal: binding.owner.principalId },
      action: 'observe', resource: { kind: 'automation', id: binding.automationId }, context: { initiator: 'background' },
    })
    if (decision.effect !== 'allow') throw new Error('event-triggers: observer policy denied')
    return receipt
  }

  private claimMatches(binding: Binding, input: GoalSourceClaim): boolean {
    const owner = binding.owner
    return input.automationId === binding.automationId && input.configDigest === binding.configDigest
      && input.scope.principalId === owner.principalId && input.scope.principalRecordId === owner.principalRecordId
      && input.scope.principalVersion === owner.principalVersion && resolve(input.scope.workspace) === resolve(owner.workspace)
      && input.scope.preset === owner.preset
  }

  private trustedComplete(input: GoalSourceClaim): boolean {
    const goal = this.goalReader()?.inspectGoalLifecycle({ scope: input.scope, goalId: input.goalId })
    return goal !== undefined && sameScope(goal.scope, input.scope) && goal.id === input.goalId
      && goal.definition.version === input.definition.version && goal.definition.digest === input.definition.digest
      && goal.native.sessionId === input.native.sessionId && goal.native.goalId === input.native.goalId
      && goal.native.revision >= input.native.revision && goal.native.phase === 'complete'
  }

  private sameClaimIdentity(claim: GoalSourceClaim, input: GoalSourceClaim): boolean {
    return sameScope(claim.scope, input.scope) && claim.goalId === input.goalId
      && claim.definition.version === input.definition.version && claim.definition.digest === input.definition.digest
      && claim.native.sessionId === input.native.sessionId && claim.native.goalId === input.native.goalId
      && input.native.revision >= claim.native.revision && claim.configDigest === input.configDigest
      && claim.automationId === input.automationId
  }

  private assertGoalClaimCurrent(binding: Binding): boolean {
    if (binding.lifetime === 'shared') return true
    const claim = this.store.goalSourceClaim(binding.triggerId)
    if (!claim) return true
    if (claim.retiredAt !== undefined || !this.claimMatches(binding, claim)) { this.pauseCurrent(binding.automationId, 'goal-binding-changed'); return false }
    const goal = this.goalReader()?.inspectGoalLifecycle({ scope: claim.scope, goalId: claim.goalId })
    if (!goal || !sameScope(goal.scope, claim.scope) || goal.id !== claim.goalId
      || goal.definition.version !== claim.definition.version || goal.definition.digest !== claim.definition.digest
      || goal.native.sessionId !== claim.native.sessionId || goal.native.goalId !== claim.native.goalId
      || goal.native.revision < claim.native.revision) { this.pauseCurrent(binding.automationId, 'goal-binding-changed'); return false }
    if (goal.native.phase === 'complete') { this.store.retireGoalSource(claim); this.pauseCurrent(binding.automationId, 'goal-complete'); return false }
    return true
  }

  private goalReader(): GoalLifecycleReader | undefined {
    return this.ctx.get('assistantGoals', false) as GoalLifecycleReader | undefined
  }

  private routeReceipt(binding: Binding) {
    return this.requireDelivery().validateOwnerRoute({ authorityId: binding.owner.ownerRouteId,
      principalId: binding.owner.principalId, workspace: resolve(binding.owner.workspace), agentPreset: binding.owner.preset })
  }

  private pauseCurrent(automationId: string, reason: string): void {
    try {
      const current = this.requireAutomations().inspectSystemOwned({ owner: SYSTEM_OWNER, automationId })
      if (current.automationStatus === 'active') this.pause(automationId, current.definitionHash, current.definitionVersion, reason)
    } catch { /* best effort: never rewrite a row we cannot prove is ours */ }
  }

  private pause(automationId: string, definitionHash: string, expectedVersion: number, reason: string): void {
    this.requireAutomations().pauseSystemOwned({ owner: SYSTEM_OWNER, automationId, definitionHash, expectedVersion,
      operationId: `event-observer:${reason}:v1:${digest({ automationId, definitionHash, expectedVersion })}` })
  }

  private requireAutomations(): AssistantAutomationsService {
    if (this.automations === undefined) throw new Error('event-triggers: observer dependencies are unavailable')
    return this.automations
  }
  private requirePolicy(): AssistantPolicyService {
    if (this.policy === undefined) throw new Error('event-triggers: observer dependencies are unavailable')
    return this.policy
  }
  private requireDelivery(): AssistantDeliveryService {
    if (this.delivery === undefined) throw new Error('event-triggers: observer dependencies are unavailable')
    return this.delivery
  }
}
