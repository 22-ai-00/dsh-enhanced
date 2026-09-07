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
import { GoalWakeRuntime } from '../src/wake.ts'
import type { GoalRecord } from '../src/types.ts'
import type { GoalWakeIntent } from '../src/wake-store.ts'

const contexts: Context[] = []; const roots: string[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const owner = 'assistant-goals-wake/v1'

function record(root: string): GoalRecord {
  const objective = 'resume a paused goal'; const scope = { principalId: 'lark/bot/tenant/owner', principalRecordId: 'owner-row', principalVersion: 1, workspace: root, preset: 'primary' }
  return { id: 'business-goal-a', scope, originalObjective: objective, definition: { version: 1, digest: acceptanceDigest({ objective }), objective }, native: { sessionId: 'session-a', goalId: 'native-goal-a', revision: 2, objective, phase: 'paused', roundsStarted: 1, maxGoalRounds: 3, updatedAt: 1 }, checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: 1, updatedAt: 1 }
}
function intent(value: GoalRecord): GoalWakeIntent {
  return { id: `wake-${acceptanceDigest([value.scope, value.id, value.definition, value.native])}`, scope: value.scope, goalId: value.id, definition: value.definition, native: value.native, attestation: { scope: { workspace: value.scope.workspace, preset: value.scope.preset }, principalId: value.scope.principalId, principalLineage: { principalRecordId: value.scope.principalRecordId, principalVersion: value.scope.principalVersion }, bindingId: 'binding-a', bindingVersion: 1, bindingGeneration: 1, sessionId: value.native.sessionId }, at: Date.now() + 60_000, expiresAt: Date.now() + 120_000, ownerRouteId: 'local/owner', budgetId: 'goal-budget/owner' }
}
async function harness(withSettlementCapability = true) {
  const root = await mkdtemp(join(tmpdir(), 'goal-wake-runtime-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), budgets: [{ id: 'goal-budget/owner', metric: 'automation-runs', limit: 10, periodMs: Number.MAX_SAFE_INTEGER, scope: 'global' }], rules: [{ id: 'allow-wake-reconcile', effect: 'allow', subject: { kind: 'background', id: owner, workspace: root }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } }] })
  let value = record(root); let proveCompletion = false; let settleCalls = 0
  const resumeScheduledGoal = vi.fn(async (input: { beforeResume(agent: Agent): void; settle(agent: Agent, signal: AbortSignal): Promise<void> }) => {
    const agent = { session: { id: value.native.sessionId } } as Agent
    input.beforeResume(agent)
    value = { ...value, native: { ...value.native, phase: 'blocked', revision: value.native.revision + 2, roundsStarted: value.native.maxGoalRounds } }
    await input.settle(agent, new AbortController().signal)
    return { outcome: 'succeeded' as const, dispatched: true, quiescent: true }
  })
  ctx.provide('assistantDelivery' as never, { validateOwnerRoute: () => ({ principalRecordId: 'owner-row', principalVersion: 1 }), resumeScheduledGoal,
    ...(withSettlementCapability ? { goalWakeSettlementVersion: () => 1 } : {}) } as never)
  const automationPath = join(root, 'automations.sqlite')
  await ctx.plugin(AssistantAutomationsService, { databasePath: automationPath, runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0, allowUnbudgetedExecution: true })
  const wakePath = join(root, 'wakes.sqlite')
  const runtime = new GoalWakeRuntime(ctx, wakePath, { ownerRouteId: 'local/owner', budgetId: 'goal-budget/owner', maxDelayMs: 86_400_000, runTimeoutMs: 60_000 }, (scope, goalId) => acceptanceDigest(scope) === acceptanceDigest(value.scope) && goalId === value.id ? value : undefined, () => true,
    async (_agent, signal) => {
      signal.throwIfAborted(); settleCalls += 1
      value = { ...value, native: { ...value.native, phase: 'complete', revision: value.native.revision + 1 } }
    }, () => proveCompletion)
  return { ctx, root, runtime, get value() { return value }, wakePath, automationPath, resumeScheduledGoal,
    proveCompletion(value: boolean) { proveCompletion = value }, get settleCalls() { return settleCalls } }
}

describe('durable goal wake scheduling protocol', () => {
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
    const execute = async (f: Awaited<ReturnType<typeof harness>>) => {
      const wake = f.runtime.materialize({ ...intent(f.value), at: Date.now() - 10, expiresAt: Date.now() + 10_000 })
      const registry = (f.ctx.assistantAutomations as unknown as { hostExecutors: { prove(input: unknown): unknown; execute(proof: unknown, input: unknown): Promise<{ outcome: string }> } }).hostExecutors
      const catalogDigest = acceptanceDigest({ protocol: owner, operation: 'resume-paused-native-goal', version: 1 })
      const execution = { kind: 'host', executorId: owner, executorContractVersion: 1, runbookId: 'resume-paused-native-goal', runbookVersion: 1,
        catalogDigest, targetScope: { workspace: wake.intent.scope.workspace, preset: wake.intent.scope.preset }, scopeDigest: '0'.repeat(64), ownerRouteId: wake.intent.ownerRouteId, activationNonce: wake.intent.id }
      const proof = registry.prove(execution)
      return await registry.execute(proof, { occurrenceId: 'wake-occurrence', automationId: wake.intent.id, definitionHash: wake.definitionHash!,
        executionMode: 'production', targetScope: { workspace: wake.intent.scope.workspace, preset: wake.intent.scope.preset }, principal: wake.intent.scope.principalId,
        ownerRouteId: wake.intent.ownerRouteId, activationNonce: wake.intent.id, catalogDigest, signal: new AbortController().signal })
    }
    const denied = await harness()
    await expect(execute(denied)).resolves.toMatchObject({ outcome: 'unknown' })
    expect(denied.settleCalls).toBe(1)
    expect(denied.runtime.inspect(denied.value.scope, denied.value.id)).toMatchObject([{ state: 'unknown' }])

    const accepted = await harness(); accepted.proveCompletion(true)
    await expect(execute(accepted)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(accepted.settleCalls).toBe(1)
    expect(accepted.runtime.inspect(accepted.value.scope, accepted.value.id)).toMatchObject([{ state: 'succeeded' }])
  })
})
