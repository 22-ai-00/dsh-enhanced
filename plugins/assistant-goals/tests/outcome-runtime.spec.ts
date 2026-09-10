import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type { TaskAcceptanceProducer, TaskAcceptanceRegistration } from '@dsh-enhanced/assistant-verifier'
import { GoalOutcomeRuntime } from '../src/outcome.ts'
import type { GoalOutcomeView } from '../src/outcome.ts'
import { GoalOutcomeStore } from '../src/outcome-store.ts'
import { assertGoalDependenciesAchieved } from '../src/dependency.ts'
import type { GoalExecutionRun, GoalRecord } from '../src/types.ts'

const dependency = { goalId: 'dependency-a', definitionVersion: 1, definitionDigest: acceptanceDigest({ objective: 'dependency' }) }

const roots: string[] = []
const contexts: Context[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const context of contexts.splice(0)) await context.fiber.restart()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class GoalsBridge implements TaskAcceptanceProducer {
  readonly generation = randomUUID()
  runtime!: GoalOutcomeRuntime
  registration: TaskAcceptanceRegistration | undefined
  trustedAcceptanceProducerGeneration = () => this.generation
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration) {
    const dispose = this.runtime.register(registration)
    this.registration = registration
    return () => { dispose(); if (this.registration === registration) this.registration = undefined }
  }
  inspectAcceptedExecution = (contract: TaskAcceptanceContract) => this.runtime.inspect(contract)
}

async function proofServer(ready: () => boolean = () => true): Promise<string> {
  const server = createServer((_request, response) => { response.statusCode = ready() ? 200 : 503; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: 'proof', state: { ready: true } })) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server)
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing proof server address')
  return `http://127.0.0.1:${address.port}/objects/{id}`
}

function record(root: string, revision = 1): GoalRecord {
  const objective = 'Confirm the independent target state'
  return {
    id: 'goal-a', scope: { principalId: 'owner-a', principalRecordId: 'owner-row', principalVersion: 1, workspace: root, preset: 'primary' },
    originalObjective: objective, definition: { version: 1, digest: acceptanceDigest({ objective }), objective },
    native: { sessionId: 'session-a', goalId: 'native-a', revision, objective, phase: 'active', roundsStarted: 1, maxGoalRounds: 3, updatedAt: 1 },
    checkpoint: { nextStep: 'Verify target', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: 1, updatedAt: 1,
  }
}
function dependent(value: GoalRecord): GoalRecord {
  return { ...value, checkpoint: { ...value.checkpoint, dependencies: [dependency.goalId], dependencyBindings: [dependency] } }
}
function dependencyRecord(root: string): GoalRecord {
  const objective = 'dependency'
  const value = record(root)
  return { ...value, id: dependency.goalId, originalObjective: objective,
    definition: { version: dependency.definitionVersion, digest: dependency.definitionDigest, objective },
    native: { ...value.native, sessionId: 'dependency-session', goalId: 'dependency-native', objective, phase: 'complete' } }
}
function run(value: GoalRecord, now: number): GoalExecutionRun {
  const runId = 'run-a'
  const task = { kind: 'goal-step' as const, ref: runId, goal: { id: value.id, definitionVersion: value.definition.version, definitionDigest: value.definition.digest,
    stepId: 'step-a', runId, sessionId: value.native.sessionId, nativeGoalId: value.native.goalId, nativeRevision: value.native.revision } }
  const scope = value.scope
  return { intent: { runId, scope, objective: value.definition.objective, dependencies: value.checkpoint.dependencyBindings ?? [], task,
    admission: { issuedAt: now, expiresAt: now + 30_000, maxGoalRounds: value.native.maxGoalRounds, round: 1,
      authorizationDigest: acceptanceDigest({ scope, action: 'execute', resource: { kind: 'goal', id: 'business-context' } }) } } }
}

async function runtimeHarness(paths: { verifier: string; outcome: string }, current: () => GoalRecord, runs: () => readonly GoalExecutionRun[], ready: () => boolean = () => true,
  assertDependencies: (record: GoalRecord) => void = parent => {
    if (parent.checkpoint.dependencies.length > 0) throw new Error('unexpected dependency')
  }) {
  const url = await proofServer(ready)
  const authorityInput = { kind: 'readback' as const, id: 'target', urlTemplate: url, objectIdPointer: '/id', timeoutMs: 1_000, maxResponseBytes: 1_024, allowHttpLoopback: true }
  const [authority] = createVerifierAuthorities({ authorities: [authorityInput] }); if (authority === undefined) throw new Error('missing readback authority')
  const ctx = new Context(); contexts.push(ctx)
  const bridge = new GoalsBridge(); ctx.provide('assistantGoals' as never, bridge as never)
  const runtime = new GoalOutcomeRuntime(ctx, paths.outcome, () => current(), () => runs(), 60_000, assertDependencies)
  bridge.runtime = runtime
  const value = current()
  const verifier = new AssistantVerifierService(ctx, { databasePath: paths.verifier, tickIntervalMs: 0, requireAcceptance: true, authorities: [authorityInput], profiles: [{
    id: 'whole-goal', version: 1, scope: { workspace: value.scope.workspace, preset: value.scope.preset }, owner: { principalRecordId: value.scope.principalRecordId, principalVersion: value.scope.principalVersion },
    taskKind: 'goal-outcome', objective: value.definition.objective, validityMs: 60_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
    criteria: [{ id: 'target-ready', kind: 'target-readback', authority: { id: authority.id, digest: authority.digest }, objectId: 'proof', expected: [{ pointer: '/state/ready', value: true }] }],
  }] })
  return { ctx, runtime, verifier, bridge }
}

describe('GoalOutcomeRuntime durable crash recovery', () => {
  it.each(['active', 'paused'] as const)('late verification nudge completes only an eligible live goal (%s)', async phase => {
    const root = await mkdtemp(join(tmpdir(), 'goal-outcome-late-receipt-')); roots.push(root)
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock)
    let current = record(root); const initial = run(current, clock), agent = {} as Agent
    let nativeRuns: readonly GoalExecutionRun[] = [], ready = false, completions = 0
    const f = await runtimeHarness({ verifier: join(root, 'verifier.sqlite'), outcome: join(root, 'outcome.sqlite') }, () => current, () => nativeRuns, () => ready)
    f.ctx.provide('goals' as never, { get: () => ({ id: current.native.goalId, revision: current.native.revision }), complete: () => {
      completions++; current = { ...current, native: { ...current.native, phase: 'complete', revision: current.native.revision + 1 } }
    } } as never)
    f.runtime.bind(current); f.runtime.prepare(agent, initial)
    const durable = { ...initial, dispatchedAt: clock, execution: { status: 'succeeded' as const, quiescent: true, completedAt: clock } }
    nativeRuns = [durable]
    await f.runtime.settled(agent, durable, () => {})
    expect(f.runtime.view(current).status).toBe('unknown'); expect(completions).toBe(0)
    if (phase === 'paused') current = { ...current, native: { ...current.native, phase: 'paused', revision: current.native.revision + 1 } }
    ready = true; clock += 5_001
    await f.verifier.tick(); await new Promise<void>(resolve => setImmediate(resolve))
    expect(completions).toBe(phase === 'active' ? 1 : 0)
    await f.verifier.tick(); expect(completions).toBe(phase === 'active' ? 1 : 0)
  })

  it.each(['stale', 'cleared', 'unavailable', 'achieved'] as const)('late verification revalidates an exact %s dependency immediately before completion', async state => {
    const root = await mkdtemp(join(tmpdir(), 'goal-outcome-late-dependency-')); roots.push(root)
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock)
    let current = dependent(record(root)); const initial = run(current, clock), agent = {} as Agent
    let nativeRuns: readonly GoalExecutionRun[] = [], ready = false, completions = 0
    const exactDependency = dependencyRecord(root)
    const staleObjective = 'changed dependency'
    let dependencyCurrent = exactDependency
    let dependencyOutcome: GoalOutcomeView = { status: 'achieved', definitionVersion: dependency.definitionVersion, nativeCompletion: 'complete' }
    const assertDependencies = (parent: GoalRecord) => assertGoalDependenciesAchieved(parent, {
      get: (_scope, goalId) => goalId === dependency.goalId ? dependencyCurrent : undefined,
      outcome: () => dependencyOutcome as GoalOutcomeView,
    })
    const f = await runtimeHarness({ verifier: join(root, 'verifier.sqlite'), outcome: join(root, 'outcome.sqlite') },
      () => current, () => nativeRuns, () => ready, assertDependencies)
    f.ctx.provide('goals' as never, { get: () => ({ id: current.native.goalId, revision: current.native.revision }), complete: () => {
      completions += 1; current = { ...current, native: { ...current.native, phase: 'complete', revision: current.native.revision + 1 } }
    } } as never)
    f.runtime.bind(current); f.runtime.prepare(agent, initial)
    const durable = { ...initial, dispatchedAt: clock, execution: { status: 'succeeded' as const, quiescent: true, completedAt: clock } }
    nativeRuns = [durable]
    await f.runtime.settled(agent, durable, () => {})
    expect(completions).toBe(0)
    if (state === 'stale') dependencyCurrent = { ...exactDependency, definition: { version: 2, digest: acceptanceDigest({ objective: staleObjective }), objective: staleObjective } }
    if (state === 'cleared') dependencyCurrent = { ...exactDependency, native: { ...exactDependency.native, phase: 'cleared' } }
    if (state === 'unavailable') dependencyOutcome = { status: 'unavailable', definitionVersion: dependency.definitionVersion }
    ready = true; clock += 5_001
    await f.verifier.tick(); await new Promise<void>(resolve => setImmediate(resolve))
    expect(completions).toBe(state === 'achieved' ? 1 : 0)
  })

  it('downgrades a sidecar-only success to durable verifier unknown after a reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goal-outcome-runtime-')); roots.push(root)
    const paths = { verifier: join(root, 'verifier.sqlite'), outcome: join(root, 'outcomes.sqlite') }
    let current = record(root); const now = Date.now(); const initial = run(current, now); const agent = {} as Agent
    const first = await runtimeHarness(paths, () => current, () => [])
    first.runtime.bind(current); first.runtime.prepare(agent, initial)
    const sidecar = new GoalOutcomeStore(paths.outcome)
    const assessment = sidecar.list(current.scope, current.id)[0]!; sidecar.finish(assessment.contract.task.ref, { status: 'succeeded', quiescent: true, completedAt: Date.now() }); sidecar.close()
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)

    const restarted = await runtimeHarness(paths, () => current, () => [])
    const direct = await restarted.runtime.inspect(assessment.contract)
    expect(direct).toMatchObject({ status: 'unknown', quiescent: false })
    await restarted.verifier.tick()
    expect(restarted.verifier.inspectAcceptedTask(assessment.contract.id)).toMatchObject({ execution: { status: 'unknown', quiescent: false }, receipt: { objectiveStatus: 'unknown' } })
  })

  it('settles a disposed Agent pending assessment as unknown without waiting for a Host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goal-outcome-runtime-disposed-')); roots.push(root)
    const paths = { verifier: join(root, 'verifier.sqlite'), outcome: join(root, 'outcomes.sqlite') }
    const current = record(root); const agent = {} as Agent
    const fixture = await runtimeHarness(paths, () => current, () => [])
    fixture.runtime.bind(current); fixture.runtime.prepare(agent, run(current, Date.now()))
    const store = new GoalOutcomeStore(paths.outcome)
    const assessment = store.list(current.scope, current.id)[0]!
    store.close()
    fixture.ctx.emit('agent/disposed', { agent } as never)
    expect(await fixture.runtime.inspect(assessment.contract)).toMatchObject({ status: 'unknown', quiescent: false })
    await fixture.verifier.tick()
    expect(fixture.verifier.inspectAcceptedTask(assessment.contract.id)).toMatchObject({ execution: { status: 'unknown' }, receipt: { objectiveStatus: 'unknown' } })
  })

  it.each(['next-round', 'disposed'] as const)('does not accept late evidence after the native %s fence changes', async change => {
    const root = await mkdtemp(join(tmpdir(), 'goal-outcome-runtime-late-')); roots.push(root)
    const paths = { verifier: join(root, 'verifier.sqlite'), outcome: join(root, 'outcomes.sqlite') }
    let current = record(root)
    const initial = run(current, Date.now()); const agent = {} as Agent
    let nativeRuns: readonly GoalExecutionRun[] = []
    const fixture = await runtimeHarness(paths, () => current, () => nativeRuns)
    fixture.runtime.bind(current); fixture.runtime.prepare(agent, initial)
    const sidecar = new GoalOutcomeStore(paths.outcome)
    const assessment = sidecar.list(current.scope, current.id)[0]!
    sidecar.close()
    const durable = { ...initial, dispatchedAt: initial.intent.admission.issuedAt,
      execution: { status: 'succeeded' as const, quiescent: true, completedAt: Date.now() } }
    nativeRuns = [durable]
    let checks = 0
    const settlement = fixture.runtime.settled(agent, durable, () => {
      checks += 1
      if (checks === 3) {
        if (change === 'next-round') current = { ...current, native: { ...current.native, roundsStarted: current.native.roundsStarted + 1 } }
        else fixture.ctx.emit('agent/disposed', { agent } as never)
      }
    })
    if (change === 'next-round') await expect(settlement).rejects.toThrow('assessment round changed')
    else await settlement
    expect(fixture.verifier.inspectAcceptedTask(assessment.contract.id)).toMatchObject({ receipt: { objectiveStatus: 'unknown' } })
    expect(await fixture.runtime.inspect(assessment.contract)).toMatchObject({ status: 'unknown', quiescent: false })
  })

  it('preserves an achieved receipt across reload and completes only the exact current native goal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goal-outcome-runtime-')); roots.push(root)
    const paths = { verifier: join(root, 'verifier.sqlite'), outcome: join(root, 'outcomes.sqlite') }
    let current = dependent(record(root)); const now = Date.now(); const initial = run(current, now); const agent = {} as Agent
    // The native round projection is deliberately narrow: the durable parts under
    // test are the real outcome sidecar and Verifier databases, while this Host
    // supplies only its already-settled native execution evidence.
    let nativeRuns: readonly GoalExecutionRun[] = []
    const first = await runtimeHarness(paths, () => current, () => nativeRuns)
    first.runtime.bind(current); first.runtime.prepare(agent, initial)
    const durable = { ...initial, dispatchedAt: now, execution: { status: 'succeeded' as const, quiescent: true, completedAt: now + 1 } }
    nativeRuns = [durable]
    await first.runtime.settled(agent, durable, () => {})
    expect(first.runtime.view(current)).toMatchObject({ status: 'achieved', nativeCompletion: 'pending' })
    await first.ctx.fiber.restart(); contexts.splice(contexts.indexOf(first.ctx), 1)

    let dependencyCurrent: GoalRecord | undefined = dependencyRecord(root)
    let dependencyOutcome: GoalOutcomeView | undefined = { status: 'achieved', definitionVersion: dependency.definitionVersion, nativeCompletion: 'complete' }
    const second = await runtimeHarness(paths, () => current, () => nativeRuns, () => true, parent => {
      assertGoalDependenciesAchieved(parent, { get: (_scope, goalId) => goalId === dependency.goalId ? dependencyCurrent : undefined, outcome: () => dependencyOutcome })
    })
    let completeCalls = 0; let beforeNativeRead: (() => void) | undefined
    second.ctx.provide('goals' as never, { get: () => {
      beforeNativeRead?.(); beforeNativeRead = undefined
      return { id: current.native.goalId, revision: current.native.revision }
    }, complete: (_agent: Agent, input: { id: string; revision: number }) => {
      if (input.id !== current.native.goalId || input.revision !== current.native.revision) throw new Error('stale native completion')
      completeCalls += 1; current = { ...current, native: { ...current.native, phase: 'complete', revision: current.native.revision + 1 } }
    } } as never)
    expect(second.runtime.view(current)).toMatchObject({ status: 'achieved', nativeCompletion: 'pending' })
    current = { ...current, scope: { ...current.scope, principalId: 'foreign', principalRecordId: 'foreign-row' } }
    expect(second.runtime.reconcileCompletion(agent)).toBe(false)
    current = { ...dependent(record(root)), definition: { version: 2, objective: 'changed definition', digest: acceptanceDigest({ objective: 'changed definition' }) } }
    expect(second.runtime.reconcileCompletion(agent)).toBe(false)
    current = dependent(record(root, 2))
    expect(second.runtime.reconcileCompletion(agent)).toBe(false)
    current = { ...dependent(record(root)), native: { ...record(root).native, roundsStarted: 3 } }
    expect(second.runtime.reconcileCompletion(agent)).toBe(false)
    current = dependent(record(root))
    beforeNativeRead = () => { current = { ...current, checkpoint: { ...current.checkpoint, dependencyBindings: [{ ...dependency, definitionDigest: 'changed-binding' }] } } }
    expect(second.runtime.reconcileCompletion(agent)).toBe(false)
    current = dependent(record(root))
    const { dependencyBindings: _binding, ...legacyCheckpoint } = current.checkpoint
    current = { ...current, checkpoint: legacyCheckpoint }
    expect(second.runtime.reconcileCompletion(agent)).toBe(false)
    current = dependent(record(root))
    const { dependencies: _dependencies, ...legacyIntent } = durable.intent
    nativeRuns = [{ ...durable, intent: legacyIntent }]
    expect(second.runtime.reconcileCompletion(agent)).toBe(false)
    nativeRuns = [durable]
    const staleObjective = 'changed dependency'
    dependencyCurrent = { ...dependencyRecord(root), definition: { version: 2, digest: acceptanceDigest({ objective: staleObjective }), objective: staleObjective } }
    expect(second.runtime.reconcileCompletion(agent)).toBe(false)
    dependencyCurrent = { ...dependencyRecord(root), native: { ...dependencyRecord(root).native, phase: 'cleared' } }
    expect(second.runtime.reconcileCompletion(agent)).toBe(false)
    dependencyCurrent = dependencyRecord(root); dependencyOutcome = { status: 'unavailable', definitionVersion: dependency.definitionVersion }
    expect(second.runtime.reconcileCompletion(agent)).toBe(false)
    dependencyOutcome = { status: 'achieved', definitionVersion: dependency.definitionVersion, nativeCompletion: 'complete' }
    expect(second.runtime.reconcileCompletion(agent)).toBe(true)
    expect(completeCalls).toBe(1)
  })
})
