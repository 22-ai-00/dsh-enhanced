import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutorInput, HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import { activatePluginPlan, probePluginPlan } from './cli.js'
import { controlPlaneDigest, type ControlPlaneStore } from './store.js'
import type { PluginControlTrustConfig } from './trust.js'
import type { PluginActivationPlan } from './types.js'

const OWNER = 'plugin-control-plane-adoption-coordinator'
const EXECUTOR = 'plugin-control-plane-adoption-coordinator-v1'
const CATALOG = controlPlaneDigest({ executor: EXECUTOR, version: 1, operation: 'advance-adoption-handoff' })
const AWAITING = new Set<PluginActivationPlan['status']>([
  'awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow',
  'awaiting-canary', 'awaiting-soak', 'awaiting-health',
])

export interface AdoptionCoordinatorConfig {
  coordinatorId: string
  scope: { workspace: string; preset: string; principalId: string; ownerRouteId: string }
  timeoutMs: number
  budgetId: string
  budgetAmount: number
}

export function validateAdoptionCoordinatorConfig(value: unknown): asserts value is AdoptionCoordinatorConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('plugin-control-plane: invalid adoption coordinator configuration')
  const config = value as Record<string, unknown>
  const scope = config.scope as Record<string, unknown>
  const exact = (record: unknown, keys: readonly string[]) => typeof record === 'object' && record !== null && !Array.isArray(record)
    && Object.keys(record).sort().join(',') === [...keys].sort().join(',')
  const text = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 4096
    && item.normalize('NFC').trim() === item && !/[\p{Cc}]/u.test(item)
  if (!exact(config, ['coordinatorId', 'scope', 'timeoutMs', 'budgetId', 'budgetAmount']) || !exact(scope, ['workspace', 'preset', 'principalId', 'ownerRouteId'])
    || !text(config.coordinatorId) || typeof config.coordinatorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(config.coordinatorId)
    || !Object.values(scope).every(text) || typeof scope.workspace !== 'string' || !isAbsolute(scope.workspace)
    || resolve(scope.workspace) !== scope.workspace || !Number.isSafeInteger(config.timeoutMs) || typeof config.timeoutMs !== 'number'
    || config.timeoutMs < 1_000 || config.timeoutMs > 300_000 || !text(config.budgetId)
    || typeof config.budgetId !== 'string' || config.budgetId.length > 128
    || !Number.isSafeInteger(config.budgetAmount) || typeof config.budgetAmount !== 'number'
    || config.budgetAmount < 1 || config.budgetAmount > 10_000_000) {
    throw new Error('plugin-control-plane: invalid adoption coordinator configuration')
  }
}

function terminal(plan: PluginActivationPlan): boolean { return plan.status === 'activated' || plan.status === 'rolled-back' }
function exposed(plan: PluginActivationPlan): boolean { return plan.status === 'staging' || plan.status === 'commit-pending' || AWAITING.has(plan.status) }

/**
 * Advance an already signed source handoff only through Host attestation.
 * This Host deliberately leaves `commit-pending` for the target Host.
 */
export async function coordinateAdoptionHandoff(options: {
  store: ControlPlaneStore
  trust: PluginControlTrustConfig
  planId: string
  signal?: AbortSignal
  assertCurrent?: () => void | Promise<void>
}): Promise<PluginActivationPlan> {
  const current = async (): Promise<void> => {
    options.signal?.throwIfAborted()
    await options.assertCurrent?.()
    options.signal?.throwIfAborted()
  }
  const finishRollback = async (plan: PluginActivationPlan): Promise<PluginActivationPlan> => {
    if (plan.status !== 'rollback-pending' || plan.activation === undefined) return plan
    const rollback = plan
    const activation = rollback.activation
    if (activation === undefined) return rollback
    if (activation.rollbackProfileRestored) {
      await current()
      return probePluginPlan({ store: options.store, trust: options.trust, planId: rollback.id,
        expectedRevision: rollback.revision, expectedFence: activation.fence, deferCommit: true, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    }
    await current()
    let restored = await activatePluginPlan({ store: options.store, trust: options.trust, planId: rollback.id,
      expectedRevision: rollback.revision, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    if (restored.status === 'rollback-pending' && restored.activation?.rollbackProfileRestored) {
      await current()
      restored = await probePluginPlan({ store: options.store, trust: options.trust, planId: restored.id,
        expectedRevision: restored.revision, expectedFence: restored.activation.fence, deferCommit: true, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    }
    return restored
  }
  const recoverExpired = async (plan: PluginActivationPlan): Promise<PluginActivationPlan> => {
    if (plan.status === 'rollback-pending') return finishRollback(plan)
    if (!exposed(plan) || plan.activation === undefined) return plan
    await current()
    const rollback = options.store.requestActivationRollback({ planId: plan.id, expectedRevision: plan.revision,
      fence: plan.activation.fence, failureCode: 'adoption-handoff-expired' })
    return finishRollback(rollback)
  }

  for (let phase = 0; phase < 16; phase++) {
    await current()
    let plan = options.store.getPlan(options.planId)
    if (terminal(plan)) return plan
    if (plan.status === 'rollback-pending') return finishRollback(plan)
    try { options.store.assertAdoptionHandoff(plan.id) } catch (error) {
      // The Store's rollback admission rejects a claimed unknown Host dispatch.
      // Propagating that conflict preserves the durable no-replay barrier.
      const handoff = options.store.getAdoptionHandoff(plan.id), terms = plan.dossier.handoff
      if (handoff !== undefined && terms !== undefined && handoff.planDigest === plan.digest && handoff.coordinatorId === terms.coordinatorId
        && (handoff.revokedAt !== undefined || handoff.expiresAt <= Date.now())) return recoverExpired(plan)
      throw error
    }
    await current()
    const before = { status: plan.status, revision: plan.revision, fence: plan.activation?.fence }
    if (plan.status === 'approved' || plan.status === 'staging') {
      options.store.assertAdoptionHandoff(plan.id)
      plan = await activatePluginPlan({ store: options.store, trust: options.trust, planId: plan.id,
        expectedRevision: plan.revision, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    } else if (AWAITING.has(plan.status)) {
      if (plan.activation === undefined) throw new Error('plugin-control-plane: adoption plan awaiting Host attestation has no fence')
      options.store.assertAdoptionHandoff(plan.id)
      plan = await probePluginPlan({ store: options.store, trust: options.trust, planId: plan.id,
        expectedRevision: plan.revision, expectedFence: plan.activation.fence, deferCommit: true, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    } else if (plan.status === 'commit-pending') {
      return plan
    } else return plan
    await current()
    if (plan.status === 'commit-pending' || terminal(plan)
      || (plan.status === before.status && plan.revision === before.revision && plan.activation?.fence === before.fence)) return plan
  }
  return options.store.getPlan(options.planId)
}

type Automations = Pick<AssistantAutomationsService, 'registerHostExecutor' | 'reconcileSystem' | 'inspectSystemOwnedActivation'>
type Handoff = { planId: string; planDigest: string; coordinatorId: string; createdAt: number; expiresAt: number; revokedAt?: number }

/** Native Automations cron coordinator. It owns no private scheduler or final commit. */
export class AdoptionCoordinatorRuntime {
  private readonly abort = new AbortController()
  private readonly flights = new Set<Promise<unknown>>()
  private readonly generation = randomUUID()
  private readonly activationNonce: string
  private readonly automationId: string
  private active = false
  private cursor = 0
  private unregister?: () => void
  private closing?: Promise<void>
  private lastError: string | null = null
  constructor(private readonly options: { config: AdoptionCoordinatorConfig; store: ControlPlaneStore; trust: PluginControlTrustConfig; automations: Automations; assertCurrent: () => void }) {
    validateAdoptionCoordinatorConfig(options.config)
    const identity = controlPlaneDigest({ coordinatorId: options.config.coordinatorId, scope: options.config.scope })
    this.automationId = `adoption-coordinator-${identity.slice(0, 40)}`
    this.activationNonce = controlPlaneDigest({ identity, generation: this.generation })
  }

  start(): void {
    if (this.active) return
    this.unregister = this.options.automations.registerHostExecutor({
      descriptor: { executorId: EXECUTOR, contractVersion: 1, catalogDigest: CATALOG },
      accepts: spec => spec.executorId === EXECUTOR && spec.executorContractVersion === 1 && spec.catalogDigest === CATALOG
        && spec.runbookId === 'coordinate' && spec.runbookVersion === 1,
      execute: input => this.track(this.execute(input)),
    })
    try {
      this.active = true
      this.options.automations.reconcileSystem({ owner: OWNER, automationId: this.automationId,
        idempotencyKey: `${this.automationId}:${this.generation}:active`, desiredStatus: 'active', definition: this.definition() })
    } catch (error) {
      this.active = false
      try { this.unregister?.() } catch { /* preserve registration failure */ }
      throw error
    }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.active = false
      try {
        const registration = this.options.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: this.automationId })
        if (registration?.activationNonce === this.activationNonce) this.options.automations.reconcileSystem({ owner: OWNER,
          automationId: this.automationId, idempotencyKey: `${this.automationId}:${this.generation}:pause`, desiredStatus: 'paused', definition: this.definition() })
      } finally {
        this.abort.abort()
        try { this.unregister?.() } finally {
          await Promise.allSettled(this.flights)
          this.options.store.close()
        }
      }
    })()
  }

  health = () => ({ connected: this.active, lastError: this.lastError })

  private track<T>(flight: Promise<T>): Promise<T> {
    this.flights.add(flight)
    void flight.finally(() => this.flights.delete(flight)).catch(() => {})
    return flight
  }
  private current(signal?: AbortSignal): void {
    this.abort.signal.throwIfAborted(); signal?.throwIfAborted()
    if (!this.active) throw new Error('adoption coordinator unavailable')
    this.options.assertCurrent()
  }
  private definition(): HostAutomationDefinition {
    const { scope, timeoutMs, budgetId, budgetAmount } = this.options.config
    return { name: 'Coordinate plugin adoption handoffs', schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      workspace: scope.workspace, agentPreset: scope.preset, timeoutMs, misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      principal: scope.principalId, budgetId, budgetAmount, execution: { kind: 'host', executorId: EXECUTOR, executorContractVersion: 1, runbookId: 'coordinate', runbookVersion: 1,
        catalogDigest: CATALOG, targetScope: { workspace: scope.workspace, preset: scope.preset }, scopeDigest: controlPlaneDigest([scope.workspace, scope.preset]),
        ownerRouteId: scope.ownerRouteId, activationNonce: this.activationNonce } }
  }
  private handoffs(): readonly Handoff[] {
    return this.options.store.listAdoptionHandoffs(this.options.config.coordinatorId, 100) as readonly Handoff[]
  }
  private async execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    const failure = (unknown: boolean): HostAutomationExecutorResult => ({ outcome: unknown ? 'unknown' : 'failed', failureClass: unknown ? 'unknown' : 'configuration',
      failurePhase: 'host-execution', failureCode: 'adoption-coordinator-rejected', sideEffectState: unknown ? 'unknown' : 'none', retryability: unknown ? 'unsafe' : 'after-intervention' })
    let began = false
    try {
      this.current(input.signal)
      const { scope } = this.options.config
      const registration = this.options.automations.inspectSystemOwnedActivation({ owner: OWNER, automationId: this.automationId })
      if (input.executionMode !== 'production' || input.automationId !== this.automationId || input.activationNonce !== this.activationNonce
        || input.catalogDigest !== CATALOG || input.definitionHash !== registration?.definitionHash || registration.activationNonce !== this.activationNonce
        || input.ownerRouteId !== scope.ownerRouteId || input.principal !== scope.principalId || input.targetScope.workspace !== scope.workspace || input.targetScope.preset !== scope.preset) {
        throw new Error('adoption coordinator dispatch changed')
      }
      const signal = AbortSignal.any([this.abort.signal, input.signal, AbortSignal.timeout(this.options.config.timeoutMs)])
      this.current(signal)
      const handoffs = this.handoffs()
      if (handoffs.length) {
        const handoff = handoffs[this.cursor++ % handoffs.length]!
        began = true
        await coordinateAdoptionHandoff({ store: this.options.store, trust: this.options.trust, planId: handoff.planId, signal,
          assertCurrent: () => this.current(signal) })
        this.current(signal)
      }
      this.lastError = null
      return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none', sideEffectState: 'possible', retryability: 'unsafe' }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message.slice(0, 200) : 'adoption coordinator failed'
      return failure(began || this.abort.signal.aborted || input.signal.aborted)
    }
  }
}
