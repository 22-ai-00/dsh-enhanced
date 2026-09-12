import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertGoalDependenciesAchieved } from '../src/dependency.ts'
import { GoalWakeRuntime } from '../src/wake.ts'
import type { GoalRecord } from '../src/types.ts'
import { GoalWakeStore, type GoalWakeIntent } from '../src/wake-store.ts'

const contexts: Context[] = []; const roots: string[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const owner = 'assistant-goals-wake/v1'

function record(root: string): GoalRecord {
  const objective = 'resume a paused goal'; const scope = { principalId: 'lark/bot/tenant/owner', principalRecordId: 'owner-row', principalVersion: 1, workspace: root, preset: 'primary' }
  return { id: 'business-goal-a', scope, originalObjective: objective, definition: { version: 1, digest: acceptanceDigest({ objective }), objective }, native: { sessionId: 'session-a', goalId: 'native-goal-a', revision: 2, objective, phase: 'paused', roundsStarted: 1, maxGoalRounds: 3, updatedAt: 1 }, checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: 1, updatedAt: 1 }
}
function dependencyRecord(root: string): GoalRecord {
  const objective = 'produce the verified prerequisite'; const value = record(root)
  return { ...value, id: 'dependency-a', originalObjective: objective, definition: { version: 1, digest: acceptanceDigest({ objective }), objective },
    native: { ...value.native, sessionId: 'dependency-session-a', goalId: 'dependency-native-a', objective, phase: 'complete', maxGoalRounds: 1 } }
}
function intent(value: GoalRecord): GoalWakeIntent {
  return { id: `wake-${acceptanceDigest([value.scope, value.id, value.definition, value.native, value.checkpoint.dependencyBindings ?? []])}`, scope: value.scope, goalId: value.id, definition: value.definition, native: value.native, dependencies: value.checkpoint.dependencyBindings ?? [], attestation: { scope: { workspace: value.scope.workspace, preset: value.scope.preset }, principalId: value.scope.principalId, principalLineage: { principalRecordId: value.scope.principalRecordId, principalVersion: value.scope.principalVersion }, bindingId: 'binding-a', bindingVersion: 1, bindingGeneration: 1, sessionId: value.native.sessionId }, at: Date.now() + 60_000, expiresAt: Date.now() + 120_000, ownerRouteId: 'local/owner', budgetId: 'goal-budget/owner' }
}
type DependencyState = 'achieved' | 'stale' | 'cleared' | 'unavailable'
function assertDependencyState(value: GoalRecord, state: DependencyState): void {
  const dependency = dependencyRecord(value.scope.workspace)
  const current = state === 'stale'
    ? { ...dependency, definition: { version: 2, digest: acceptanceDigest({ objective: 'changed prerequisite' }), objective: 'changed prerequisite' } }
    : state === 'cleared' ? { ...dependency, native: { ...dependency.native, phase: 'cleared' as const } } : dependency
  assertGoalDependenciesAchieved(value, { get: (_scope, goalId) => goalId === dependency.id ? current : undefined,
    outcome: () => state === 'unavailable' ? { status: 'unavailable', definitionVersion: 1 }
      : { status: 'achieved', definitionVersion: 1, nativeCompletion: 'complete' } })
}
async function harness(withSettlementCapability = true, pauseAgain = false, dependencyOptions: { revokeBeforeDispatch?: boolean; revokeBeforeSettlement?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'goal-wake-runtime-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), budgets: [{ id: 'goal-budget/owner', metric: 'automation-runs', limit: 10, periodMs: Number.MAX_SAFE_INTEGER, scope: 'global' }], rules: [{ id: 'allow-wake-reconcile', effect: 'allow', subject: { kind: 'background', id: owner, workspace: root }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } }] })
  let value = record(root); let provedOutcome: { assessmentId: string; runId: string; objectiveStatus: 'achieved' | 'not-achieved' } | undefined; let settleCalls = 0; let acceptPause = false; let revokeOnSettle = false; let dependencyState: DependencyState = 'achieved'; let dependencyChecks = 0
  const resumeScheduledGoal = vi.fn(async (input: { beforeResume(agent: Agent): void; settle(agent: Agent, signal: AbortSignal): Promise<void> }) => {
    const agent = { session: { id: value.native.sessionId } } as Agent
    if (dependencyOptions.revokeBeforeDispatch) dependencyState = 'unavailable'
    input.beforeResume(agent)
    value = { ...value, native: { ...value.native, phase: pauseAgain ? 'paused' : 'blocked', revision: value.native.revision + 2, roundsStarted: pauseAgain ? value.native.roundsStarted + 1 : value.native.maxGoalRounds } }
    if (dependencyOptions.revokeBeforeSettlement) dependencyState = 'unavailable'
    await input.settle(agent, new AbortController().signal)
    return { outcome: 'succeeded' as const, dispatched: true, quiescent: true }
  })
  ctx.provide('assistantDelivery' as never, { validateOwnerRoute: () => ({ principalRecordId: 'owner-row', principalVersion: 1 }), resumeScheduledGoal,
    ...(withSettlementCapability ? { goalWakeSettlementVersion: () => 1 } : {}) } as never)
  const automationPath = join(root, 'automations.sqlite')
  await ctx.plugin(AssistantAutomationsService, { databasePath: automationPath, runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0, allowUnbudgetedExecution: true })
  const wakePath = join(root, 'wakes.sqlite')
  const outcomeFeedbackTarget = vi.fn((_intent: GoalWakeIntent, current: GoalRecord, outcome: NonNullable<typeof provedOutcome>) => ({ locator: { assessmentId: outcome.assessmentId }, capability: Object.freeze({}), proof: { goal: { phase: current.native.phase }, runId: outcome.runId, receipt: { objectiveStatus: outcome.objectiveStatus } } }) as never)
  const runtime = new GoalWakeRuntime(ctx, wakePath, { ownerRouteId: 'local/owner', budgetId: 'goal-budget/owner', maxDelayMs: 86_400_000, runTimeoutMs: 60_000 }, (scope, goalId) => acceptanceDigest(scope) === acceptanceDigest(value.scope) && goalId === value.id ? value : undefined, () => true,
    async (_agent, signal) => {
      signal.throwIfAborted(); settleCalls += 1
      if (revokeOnSettle) acceptPause = false
      if (!pauseAgain) value = { ...value, native: { ...value.native, phase: 'complete', revision: value.native.revision + 1 } }
    }, () => provedOutcome, () => {}, current => acceptPause && current === value, () => {
      dependencyChecks += 1
      assertDependencyState(value, dependencyState)
    }, () => true, outcomeFeedbackTarget)
  return { ctx, root, runtime, get value() { return value }, wakePath, automationPath, resumeScheduledGoal,
    proveCompletion(value: boolean) { provedOutcome = value ? { assessmentId: 'assessment-current', runId: 'run-current', objectiveStatus: 'achieved' } : undefined },
    proveOutcome(value: typeof provedOutcome) { provedOutcome = value }, get settleCalls() { return settleCalls },
    acceptPause(value: boolean) { acceptPause = value }, revokeOnSettle() { revokeOnSettle = true },
    outcomeFeedbackTarget,
    get dependencyChecks() { return dependencyChecks }, blockDependencies(state: Exclude<DependencyState, 'achieved'> = 'unavailable') { dependencyState = state },
    addDependency() {
      const current = dependencyRecord(root)
      const dependency = { goalId: current.id, definitionVersion: current.definition.version, definitionDigest: current.definition.digest }
      value = { ...value, checkpoint: { ...value.checkpoint, dependencies: [dependency.goalId], dependencyBindings: [dependency] } }
    } }
}

async function executeWake(f: Awaited<ReturnType<typeof harness>>, scheduled?: ReturnType<GoalWakeRuntime['materialize']>) {
  const wake = scheduled ?? f.runtime.materialize({ ...intent(f.value), at: Date.now() - 10, expiresAt: Date.now() + 10_000 })
  const registry = (f.ctx.assistantAutomations as unknown as { hostExecutors: { prove(input: unknown): unknown; execute(proof: unknown, input: unknown): Promise<{ outcome: string }> } }).hostExecutors
  const catalogDigest = acceptanceDigest({ protocol: owner, operation: 'resume-paused-native-goal', version: 1 })
  const execution = { kind: 'host', executorId: owner, executorContractVersion: 1, runbookId: 'resume-paused-native-goal', runbookVersion: 1,
    catalogDigest, targetScope: { workspace: wake.intent.scope.workspace, preset: wake.intent.scope.preset }, scopeDigest: '0'.repeat(64), ownerRouteId: wake.intent.ownerRouteId, activationNonce: wake.intent.id }
  return await registry.execute(registry.prove(execution), { occurrenceId: 'wake-occurrence', automationId: wake.intent.id, definitionHash: wake.definitionHash!,
    executionMode: 'production', targetScope: { workspace: wake.intent.scope.workspace, preset: wake.intent.scope.preset }, principal: wake.intent.scope.principalId,
    ownerRouteId: wake.intent.ownerRouteId, activationNonce: wake.intent.id, catalogDigest, signal: new AbortController().signal })
}

function wakeDefinition(value: GoalWakeIntent) {
  const catalogDigest = acceptanceDigest({ protocol: owner, operation: 'resume-paused-native-goal', version: 1 })
  return { name: 'Scheduled business goal', schedule: { kind: 'at' as const, at: new Date(value.at).toISOString() },
    workspace: value.scope.workspace, agentPreset: value.scope.preset, timeoutMs: value.expiresAt - value.at,
    misfire: { kind: 'latest' as const }, overlap: 'skip' as const, retrySafety: 'never' as const, maxRetries: 0,
    principal: value.scope.principalId, budgetId: value.budgetId, budgetAmount: 1,
    execution: { kind: 'host' as const, executorId: owner, executorContractVersion: 1, runbookId: 'resume-paused-native-goal',
      runbookVersion: 1, catalogDigest, targetScope: { workspace: value.scope.workspace, preset: value.scope.preset },
      scopeDigest: '0'.repeat(64), ownerRouteId: value.ownerRouteId, activationNonce: value.id } }
}

async function restartHarness(state: 'prepared' | 'scheduled', blocker: 'verifier' | 'outcome' | undefined, dependencyState: DependencyState = 'achieved') {
  const root = await mkdtemp(join(tmpdir(), 'goal-wake-reconcile-')); roots.push(root)
  const wakePath = join(root, 'wakes.sqlite')
  const value = record(root)
  const current = dependencyRecord(root)
  const dependency = { goalId: current.id, definitionVersion: current.definition.version, definitionDigest: current.definition.digest }
  const bound = { ...value, checkpoint: { ...value.checkpoint, dependencies: [dependency.goalId], dependencyBindings: [dependency] } }
  const pending = { ...intent(bound), at: Date.now() + 60_000, expiresAt: Date.now() + 120_000 }
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), budgets: [{ id: 'goal-budget/owner', metric: 'automation-runs', limit: 10, periodMs: Number.MAX_SAFE_INTEGER, scope: 'global' }], rules: [{ id: 'allow', effect: 'allow', subject: { kind: 'background', id: owner, workspace: root }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } }] })
  const resumeScheduledGoal = vi.fn()
  ctx.provide('assistantDelivery' as never, { validateOwnerRoute: () => ({ principalRecordId: 'owner-row', principalVersion: 1 }), goalWakeSettlementVersion: () => 1, resumeScheduledGoal } as never)
  await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0, allowUnbudgetedExecution: true })
  const seed = new GoalWakeStore(wakePath)
  seed.prepare(pending)
  if (state === 'scheduled') {
    const definition = wakeDefinition(pending)
    const paused = ctx.assistantAutomations.reconcileSystem({ owner, automationId: pending.id, idempotencyKey: `prepare:${pending.id}`, desiredStatus: 'paused', definition })
    seed.scheduled(pending.id, createHash('sha256').update(JSON.stringify(paused.definition)).digest('hex'))
  }
  seed.close()
  let verifierReady = blocker !== 'verifier'; let outcomeReady = blocker !== 'outcome'
  const runtime = new GoalWakeRuntime(ctx, wakePath, { ownerRouteId: 'local/owner', budgetId: 'goal-budget/owner', maxDelayMs: 86_400_000, runTimeoutMs: 60_000 }, () => bound, () => verifierReady, async () => {}, () => undefined, () => {}, () => false, () => assertDependencyState(bound, dependencyState), () => outcomeReady)
  await new Promise<void>(resolve => setImmediate(resolve))
  return { bound, dependency, pending, ctx, runtime, resumeScheduledGoal, restore() { verifierReady = true; outcomeReady = true } }
}

describe('durable goal wake scheduling protocol', () => {
  it('permits an exactly achieved dependency through preflight and every wake fence', async () => {
    const f = await harness(); f.addDependency(); f.proveCompletion(true)
    expect(() => f.runtime.preflight(f.value)).not.toThrow()
    await expect(executeWake(f)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(f.resumeScheduledGoal).toHaveBeenCalledOnce()
    expect(f.settleCalls).toBe(1)
    expect(f.dependencyChecks).toBeGreaterThanOrEqual(4)
  })

  it('rechecks dependencies after scheduling and immediately before Delivery dispatch', async () => {
    const f = await harness(true, false, { revokeBeforeDispatch: true }); f.addDependency()
    expect(() => f.runtime.preflight(f.value)).not.toThrow()
    await expect(executeWake(f)).resolves.toMatchObject({ outcome: 'failed', sideEffectState: 'none' })
    expect(f.resumeScheduledGoal).toHaveBeenCalledOnce()
    expect(f.settleCalls).toBe(0)
    expect(f.runtime.inspect(f.value.scope, f.value.id)).toMatchObject([{ state: 'denied' }])
  })

  it('does not persist a wake when dependency authority is lost after preflight', async () => {
    const f = await harness(); f.addDependency()
    expect(() => f.runtime.preflight(f.value)).not.toThrow()
    f.blockDependencies()
    expect(() => f.runtime.materialize(intent(f.value))).toThrow('wake authority is unavailable')
    expect(f.runtime.inspect(f.value.scope, f.value.id)).toEqual([])
  })

  it('denies a legacy dependency-free wake when the parent later gains dependencies', async () => {
    const f = await harness()
    const { dependencies: _dependencies, ...legacy } = intent(f.value)
    const scheduled = f.runtime.materialize({ ...legacy, at: Date.now() - 10, expiresAt: Date.now() + 10_000 })
    f.addDependency()
    await expect(executeWake(f, scheduled)).resolves.toMatchObject({ outcome: 'failed', sideEffectState: 'none' })
    expect(f.resumeScheduledGoal).not.toHaveBeenCalled()
    expect(f.runtime.inspect(f.value.scope, f.value.id)).toMatchObject([{ state: 'denied' }])
  })

  it('rechecks dependencies after dispatch and immediately before settlement', async () => {
    const f = await harness(true, false, { revokeBeforeSettlement: true }); f.addDependency()
    await expect(executeWake(f)).resolves.toMatchObject({ outcome: 'unknown', sideEffectState: 'unknown' })
    expect(f.resumeScheduledGoal).toHaveBeenCalledOnce()
    expect(f.settleCalls).toBe(0)
    expect(f.runtime.inspect(f.value.scope, f.value.id)).toMatchObject([{ state: 'unknown' }])
  })

  it.each(['accepted', 'unproved', 'revoked-during-settlement'] as const)('settles a resumed round waiting again only with exact durable authority: %s', async scenario => {
    const f = await harness(true, true)
    f.acceptPause(scenario !== 'unproved')
    if (scenario === 'revoked-during-settlement') f.revokeOnSettle()
    await expect(executeWake(f)).resolves.toMatchObject({ outcome: scenario === 'accepted' ? 'succeeded' : 'unknown' })
    expect(f.value.native.phase).toBe('paused')
    expect(f.settleCalls).toBe(scenario === 'unproved' ? 0 : 1)
    expect(f.runtime.inspect(f.value.scope, f.value.id)).toMatchObject([{ state: scenario === 'accepted' ? 'succeeded' : 'unknown' }])
  })
  it('rejects a Delivery runtime without the settlement capability before any wake is written', async () => {
    const supported = await harness()
    expect(() => supported.runtime.preflight(supported.value)).not.toThrow()
    const f = await harness(false)
    expect(() => f.runtime.preflight(f.value)).toThrow('wake authority is unavailable')
    expect(f.runtime.inspect(f.value.scope, f.value.id)).toEqual([])
    expect(f.resumeScheduledGoal).not.toHaveBeenCalled()
  })

  it('leaves the real paused reconciliation unclaimable on a second Automations connection', async () => {
    const f = await harness(); await Promise.resolve(); expect(f.runtime.health().connected).toBe(true); let secondClaim: unknown = 'not-observed'
    const module = await import('../../assistant-automations/lib/store.js')
    const other = new (module as { AutomationStore: new (options: { path: string }) => { acquireDuty(input: { ownerId: string; now: number; leaseMs: number }): { fencingToken: number }; materializeDue(input: unknown): unknown[]; claimNextTask(input: unknown): unknown; close(): void } }).AutomationStore({ path: f.automationPath })
    const automations = f.ctx.assistantAutomations
    const original = automations.reconcileSystem.bind(automations)
    vi.spyOn(automations, 'reconcileSystem').mockImplementation(input => {
      const result = original(input)
      if (input.desiredStatus === 'paused') {
        // This is a second SQLite connection, opened only after the real paused
        // reconciliation commits and before GoalWakeStore.scheduled runs.
        const duty = other.acquireDuty({ ownerId: 'second-observer', now: Date.now(), leaseMs: 1_000 })
        const available = { automationId: input.automationId, definitionHash: createHash('sha256').update(JSON.stringify(result.definition)).digest('hex'), available: true, reasonCode: 'host-executor-available' }
        expect(other.materializeDue({ now: Date.now(), misfireGraceMs: 60_000, maxCatchUp: 10, hostAvailability: [{ ...available, stage: 'materialize' }] })).toEqual([])
        secondClaim = other.claimNextTask({ ownerId: 'second-observer', fencingToken: duty.fencingToken, now: Date.now(), leaseMs: 1_000, hostAvailability: [{ ...available, stage: 'claim' }] })
      }
      return result
    })
    const value = { ...intent(f.value), at: Date.now() - 10 }
    try { expect(f.runtime.materialize(value)).toMatchObject({ state: 'scheduled' }); expect(secondClaim).toBeUndefined() } finally { other.close() }
    const automation = f.ctx.assistantAutomations.inspectSystemOwned({ owner, automationId: value.id })
    expect(automation.automationStatus).toBe('active')
    expect(f.resumeScheduledGoal).not.toHaveBeenCalled()
  })

  it('survives an activate acknowledgement replay without creating another wake identity', async () => {
    const f = await harness(); const value = intent(f.value); const first = f.runtime.materialize(value); const second = f.runtime.materialize(value)
    expect(second).toEqual(first)
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner, automationId: first.intent.id }).definitionHash).toBe(first.definitionHash)
  })

  it.each([
    ['prepared', 'verifier'], ['prepared', 'outcome'], ['scheduled', 'verifier'], ['scheduled', 'outcome'],
  ] as const)('reconciles a dependency-bound %s wake after restart when %s readiness recovers', async (state, blocker) => {
    const f = await restartHarness(state, blocker)
    expect(f.runtime.health().connected).toBe(true)
    expect(f.runtime.inspect(f.bound.scope, f.bound.id)).toMatchObject([{ state, intent: { dependencies: [f.dependency] } }])
    if (state === 'scheduled') expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner, automationId: f.pending.id }).automationStatus).toBe('paused')
    expect(f.resumeScheduledGoal).not.toHaveBeenCalled()

    f.restore(); await f.runtime.reconcile()

    expect(f.runtime.inspect(f.bound.scope, f.bound.id)).toMatchObject([{ state: 'scheduled', intent: { dependencies: [f.dependency] } }])
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner, automationId: f.pending.id }).automationStatus).toBe('active')
    expect(f.resumeScheduledGoal).not.toHaveBeenCalled()
  })

  it.each([
    ['prepared', 'stale'], ['prepared', 'cleared'], ['prepared', 'unavailable'],
    ['scheduled', 'stale'], ['scheduled', 'cleared'], ['scheduled', 'unavailable'],
  ] as const)('denies a restarted %s wake without Delivery when its dependency is %s', async (wakeState, dependencyState) => {
    const f = await restartHarness(wakeState, undefined, dependencyState)
    expect(f.runtime.inspect(f.bound.scope, f.bound.id)).toMatchObject([{ state: 'denied', intent: { dependencies: [f.dependency] } }])
    if (wakeState === 'scheduled') expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner, automationId: f.pending.id }).automationStatus).toBe('paused')
    expect(f.resumeScheduledGoal).not.toHaveBeenCalled()
  })

  it('reconciles a real expired running Automations task to denied before Delivery dispatch CAS', async () => {
    const f = await harness(); const now = Date.now()
    const scheduled = { ...intent(f.value), at: now - 10, expiresAt: now + 10_000 }
    const wake = f.runtime.materialize(scheduled)
    const store = (f.ctx.assistantAutomations as unknown as { store: {
      materializeDue(input: unknown): unknown[]; acquireDuty(input: unknown): { fencingToken: number }
      claimNextTask(input: unknown): { id: string } | undefined; startTask(input: unknown): unknown
      recoverExpiredTasks(input: unknown): Array<{ status: string }>
    } }).store
    store.materializeDue({ now, misfireGraceMs: 60_000, maxCatchUp: 10, hostAvailability: [{ automationId: wake.intent.id, definitionHash: wake.definitionHash, stage: 'materialize', available: true, reasonCode: 'host-executor-available' }] })
    const duty = store.acquireDuty({ ownerId: 'recovery-test', now, leaseMs: 1_000 })
    const task = store.claimNextTask({ ownerId: 'recovery-test', fencingToken: duty.fencingToken, now, leaseMs: 10, hostAvailability: [{ automationId: wake.intent.id, definitionHash: wake.definitionHash, stage: 'claim', available: true, reasonCode: 'host-executor-available' }] })
    expect(task).toBeDefined()
    store.startTask({ taskId: task!.id, ownerId: 'recovery-test', fencingToken: duty.fencingToken, now: now + 1, leaseMs: 10, sessionId: 'crash-before-goal-cas' })
    expect(store.recoverExpiredTasks({ now: now + 20 })).toMatchObject([{ status: 'unknown' }])
    const actual = f.ctx.assistantAutomations.inspectSystemOwned({ owner, automationId: wake.intent.id })
    const terminal = actual.latestTerminalRuns.production!
    expect(terminal.status).toBe('unknown')
    const inspect = vi.spyOn(f.ctx.assistantAutomations, 'inspectSystemOwned')
    for (const changed of [
      { ...actual, definitionHash: 'f'.repeat(64) },
      { ...actual, latestTerminalRuns: { production: undefined, preview: terminal } },
      { ...actual, latestTerminalRuns: { production: { ...terminal, immutableContext: { state: 'unavailable' } } } },
    ]) {
      inspect.mockReturnValue(changed as typeof actual)
      expect(f.runtime.inspect(f.value.scope, f.value.id)[0]).toMatchObject({ state: 'scheduled' })
    }
    inspect.mockRestore()
    expect(f.runtime.inspect(f.value.scope, f.value.id).find(item => item.intent.id === wake.intent.id)).toMatchObject({ state: 'denied' })
    expect(f.resumeScheduledGoal).not.toHaveBeenCalled()
  })

  it('accepts the final blocked-to-complete revision only after an exact verified completion proof', async () => {
    const denied = await harness()
    await expect(executeWake(denied)).resolves.toMatchObject({ outcome: 'unknown' })
    expect(denied.settleCalls).toBe(1)
    expect(denied.runtime.inspect(denied.value.scope, denied.value.id)).toMatchObject([{ state: 'unknown' }])

    const accepted = await harness(); accepted.proveCompletion(true)
    await expect(executeWake(accepted)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(accepted.settleCalls).toBe(1)
    expect(accepted.runtime.inspect(accepted.value.scope, accepted.value.id)).toMatchObject([{ state: 'succeeded' }])
  })

  it('exposes the latest exact outcome feedback target only during terminal verified settlement', async () => {
    const f = await harness(); f.proveCompletion(true)
    let resolve!: () => unknown
    f.resumeScheduledGoal.mockImplementationOnce(async input => {
      const wakeInput = input as typeof input & { resolveOutcomeFeedbackTarget(): unknown }
      resolve = wakeInput.resolveOutcomeFeedbackTarget
      expect(() => resolve()).toThrow('wake authority is unavailable')
      const agent = { session: { id: f.value.native.sessionId } } as Agent
      wakeInput.beforeResume(agent)
      expect(() => resolve()).toThrow('wake authority is unavailable')
      const current = f.value
      Object.assign(current.native, { phase: 'blocked', revision: current.native.revision + 2, roundsStarted: current.native.maxGoalRounds })
      await wakeInput.settle(agent, new AbortController().signal)
      expect(resolve()).toMatchObject({ locator: { assessmentId: 'assessment-current' }, proof: { goal: { phase: 'complete' }, runId: 'run-current' } })
      return { outcome: 'succeeded' as const, dispatched: true, quiescent: true }
    })
    await expect(executeWake(f)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(f.outcomeFeedbackTarget).toHaveBeenCalledOnce()
    expect(f.outcomeFeedbackTarget).toHaveBeenCalledWith(expect.objectContaining({ goalId: f.value.id }), expect.objectContaining({ native: expect.objectContaining({ phase: 'complete' }) }),
      { assessmentId: 'assessment-current', runId: 'run-current', objectiveStatus: 'achieved' })
    expect(() => resolve()).toThrow('wake authority is unavailable')
  })

  it('does not publish an older successful assessment when this wake has no exact terminal outcome', async () => {
    const f = await harness()
    f.resumeScheduledGoal.mockImplementationOnce(async input => {
      const wakeInput = input as typeof input & { resolveOutcomeFeedbackTarget(): unknown }
      const agent = { session: { id: f.value.native.sessionId } } as Agent
      wakeInput.beforeResume(agent)
      const current = f.value
      Object.assign(current.native, { phase: 'blocked', revision: current.native.revision + 2, roundsStarted: current.native.maxGoalRounds })
      await wakeInput.settle(agent, new AbortController().signal)
      expect(() => wakeInput.resolveOutcomeFeedbackTarget()).toThrow('wake authority is unavailable')
      return { outcome: 'succeeded' as const, dispatched: true, quiescent: true }
    })
    await expect(executeWake(f)).resolves.toMatchObject({ outcome: 'unknown' })
    expect(f.outcomeFeedbackTarget).not.toHaveBeenCalled()
  })
})
