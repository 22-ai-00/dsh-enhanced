import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
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
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'goal-wake-runtime-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [{ id: 'allow-wake-reconcile', effect: 'allow', subject: { kind: 'background', id: owner, workspace: root }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } }] })
  const resumeScheduledGoal = vi.fn(async () => ({ outcome: 'denied' as const, dispatched: false, quiescent: false }))
  ctx.provide('assistantDelivery' as never, { validateOwnerRoute: () => ({ principalRecordId: 'owner-row', principalVersion: 1 }), resumeScheduledGoal } as never)
  const automationPath = join(root, 'automations.sqlite')
  await ctx.plugin(AssistantAutomationsService, { databasePath: automationPath, runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0, allowUnbudgetedExecution: true })
  const value = record(root); const wakePath = join(root, 'wakes.sqlite')
  const runtime = new GoalWakeRuntime(ctx, wakePath, { ownerRouteId: 'local/owner', budgetId: 'goal-budget/owner', maxDelayMs: 86_400_000, runTimeoutMs: 60_000 }, (scope, goalId) => acceptanceDigest(scope) === acceptanceDigest(value.scope) && goalId === value.id ? value : undefined, () => true)
  return { ctx, root, runtime, value, wakePath, automationPath, resumeScheduledGoal }
}

describe('durable goal wake scheduling protocol', () => {
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
})
