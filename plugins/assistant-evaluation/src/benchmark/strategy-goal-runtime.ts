/** Native Goal + isolated artifact assembly. This does not attest a complete comparison. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { join } from 'node:path'
import { acceptanceDigest, type TaskAcceptanceContract, type TaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { NativeAdapterFactory, NativeAdapterBinding, NativeModelConfig } from './native.js'
import type { BenchmarkExecutionRequest } from './runner.js'
import { benchmarkAssert, benchmarkInteger, benchmarkObject, benchmarkSnapshot } from './schema.js'
import { strategyBenchmarkRequestLimits, type StrategyBenchmarkPlan } from './strategy-plan.js'
import { installStrategyBenchmarkMeter, type StrategyBenchmarkMeter } from './strategy-meter.js'
import { StrategyEvidenceStore, strategyEvidenceProtocol, type StrategyEvidenceNative } from './strategy-evidence.js'
import { createBenchmarkStrategyOwnerRuntime, type BenchmarkStrategyOwnerRuntime } from './strategy-owner.js'

export interface StrategyGoalTask {
  objective: string
  publicPrompt: string
  artifactPath: string
  verification: {
    command: string
    cases: readonly { stdin: string; expectedStdout: string; expectedExitCode: number }[]
    maxDurationMs: number
    maxOutputBytes: number
  }
}
export function strategyGoalTaskDigests(value: StrategyGoalTask) {
  const task = benchmarkObject(benchmarkSnapshot(value), ['objective', 'publicPrompt', 'artifactPath', 'verification'])
  for (const key of ['objective', 'publicPrompt', 'artifactPath']) benchmarkAssert(typeof task[key] === 'string' && (task[key] as string).trim() !== '' && Buffer.byteLength(task[key] as string) <= 32768, 'invalid strategy goal task')
  benchmarkAssert((task.objective as string).trim() === task.objective && !/[\p{Cc}]/u.test(task.objective as string), 'invalid strategy goal objective')
  benchmarkAssert(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(task.artifactPath as string) && !(task.artifactPath as string).split('/').some(part => part === '..' || part === '.' || part === ''), 'invalid strategy artifact path')
  const verification = benchmarkObject(task.verification, ['command', 'cases', 'maxDurationMs', 'maxOutputBytes'])
  benchmarkAssert(typeof verification.command === 'string' && verification.command.trim() !== '' && verification.command.length <= 16384, 'invalid verification command')
  benchmarkInteger(verification.maxDurationMs, 1, 300000); benchmarkInteger(verification.maxOutputBytes, 1, 262144)
  benchmarkAssert(Array.isArray(verification.cases) && verification.cases.length > 0 && verification.cases.length <= 32, 'invalid verification cases')
  for (const value of verification.cases) {
    const item = benchmarkObject(value, ['stdin', 'expectedStdout', 'expectedExitCode'])
    for (const key of ['stdin', 'expectedStdout']) benchmarkAssert(typeof item[key] === 'string' && Buffer.byteLength(item[key] as string) <= 32768, 'invalid verification vector')
    benchmarkInteger(item.expectedExitCode, 0, 255)
  }
  return Object.freeze({ inputDigest: acceptanceDigest({ objective: task.objective, publicPrompt: task.publicPrompt }),
    acceptanceDigest: acceptanceDigest({ artifactPath: task.artifactPath, verification }) })
}
export interface StrategyGoalRuntimeOptions {
  plan: StrategyBenchmarkPlan
  request: BenchmarkExecutionRequest
  task: StrategyGoalTask
  workspace: string
  stateRoot: string
  persona: string
  model: NativeModelConfig
  factory: NativeAdapterFactory
  image: string
  dockerPath: string
  stepMaxDurationMs: number
  /** Failure to stop within this window remains unknown; never retry the cell. */
  stopTimeoutMs?: number
}
interface GoalsHost {
  list(agent: Agent): readonly { id: string; native: { sessionId: string; objective: string } }[]
  registerBudgetMeter(input: unknown): () => void
  whenIdle(): Promise<void>
  inspectOwnerGoalExecution(input: { ownerRouteId: string; principalId: string; workspace: string; preset: string; sessionId: string; goalId: string }): Readonly<Record<string, unknown>>
}
type PluginConstructor = new (ctx: Context, config: never) => unknown
const plugin = (ctx: Context, value: unknown, config: unknown = {}) => ctx.plugin(value as PluginConstructor, config as never)

interface GoalSourceSnapshot {
  storedGoal: { id: string; definition: { version: number; digest: string }; nativeAtLastObservation: { sessionId: string; goalId: string; phase: string } }
  executionRuns: readonly { intent: { runId: string }; execution?: { status: 'succeeded' | 'unknown'; quiescent: boolean } }[]
  strategyRecords: readonly { intent: { id: string; parentRunId: string; kind: 'investigate' | 'review' | 'compare' }; outcome?: StrategyEvidenceNative['strategies'][number]['outcome']; children: StrategyEvidenceNative['strategies'][number]['children'] }[]
  outcomeAssessments: StrategyEvidenceNative['outcomeAssessments']
  acceptedTasks: readonly { contract: TaskAcceptanceContract | null; receipt: TaskVerificationReceipt | null }[]
  outcome?: { status: string; assessmentId?: string }
}
function nativeEvidence(source: GoalSourceSnapshot): StrategyEvidenceNative {
  const record = source.storedGoal
  const runs = source.executionRuns.map(run => ({ runId: run.intent.runId, executionStatus: run.execution?.status ?? 'unknown' as const, quiescent: run.execution?.quiescent ?? false }))
  const strategies = source.strategyRecords.map(strategy => ({ strategyId: strategy.intent.id, parentRunId: strategy.intent.parentRunId,
    kind: strategy.intent.kind, outcome: strategy.outcome ?? 'unknown' as const,
    children: strategy.children.map(child => ({ sessionId: child.sessionId, stopReason: child.stopReason, quiescent: child.quiescent })) }))
  const receipts: StrategyEvidenceNative['receipts'][number][] = []
  for (const value of source.acceptedTasks) {
    if (!value.contract || !value.receipt) continue
    const { contract, receipt } = value
    benchmarkAssert(contract.task.kind === 'goal-step' || contract.task.kind === 'goal-outcome', 'unexpected native acceptance kind')
    const runId = contract.task.kind === 'goal-step' ? contract.task.goal.runId : source.outcomeAssessments.find(item => item.contract.id === contract.id)?.triggerRunId
    benchmarkAssert(typeof runId === 'string', 'missing native receipt trigger')
    receipts.push({ runId, taskKind: contract.task.kind, contract, receipt, quiescent: runs.find(run => run.runId === runId)?.quiescent ?? false })
  }
  return { parent: { sessionId: record.nativeAtLastObservation.sessionId, goalId: record.id, nativeGoalId: record.nativeAtLastObservation.goalId,
    definitionVersion: record.definition.version, definitionDigest: record.definition.digest,
    lifecycle: record.nativeAtLastObservation.phase === 'complete' ? 'completed' : 'unknown',
    quiescent: runs.every(run => run.quiescent) && strategies.every(strategy => strategy.outcome !== 'unknown' && strategy.children.every(child => child.quiescent)) },
    runs, strategies, outcomeAssessments: source.outcomeAssessments, receipts,
    selectedOutcomeContractId: source.outcomeAssessments.find(item => item.contract.task.ref === source.outcome?.assessmentId)?.contract.id ?? null }
}

function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('strategy native execution cancelled or timed out'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}

/**
 * Owns one native cell. The model selects tools through the real AgentLoop;
 * the Host never manufactures a tool call, artifact, verifier result or Goal.
 * Outputs are source observations; the comparator must still attest mounted
 * capabilities and persist/validate complete cell evidence before reporting.
 */
export async function createStrategyGoalRuntime(input: StrategyGoalRuntimeOptions) {
  const { workspace, stateRoot, persona, image, dockerPath, factory } = input
  const signal = input.request.signal
  const cellId = input.request.cell.id
  const limits = strategyBenchmarkRequestLimits(input.plan, input.request)
  const task = benchmarkSnapshot(input.task)
  const digests = strategyGoalTaskDigests(task)
  benchmarkAssert(digests.inputDigest === input.request.task.inputDigest && digests.acceptanceDigest === input.request.task.acceptanceDigest, 'strategy task differs from frozen case')
  const model = benchmarkSnapshot(input.model)
  benchmarkAssert(acceptanceDigest(model) === input.request.variant.versions.model, 'strategy model differs from frozen route')
  benchmarkAssert(/^sha256:[a-f0-9]{64}$/u.test(image) && dockerPath.startsWith('/'), 'immutable local image and absolute Docker path required')
  const stopTimeoutMs = input.stopTimeoutMs ?? 10000
  benchmarkInteger(stopTimeoutMs, 1000, 30000)
  const stepDuration = input.stepMaxDurationMs
  benchmarkInteger(stepDuration, 1000, 300000)
  benchmarkAssert(limits.maxGoalRounds <= 32 && task.verification.maxDurationMs * task.verification.cases.length < stepDuration
    && stepDuration * 3 < input.request.budget.durationMs, 'strategy verification does not fit the execution window')
  const plan = benchmarkSnapshot(input.plan)
  const request = benchmarkSnapshot({ planId: input.request.planId, dataset: input.request.dataset, cell: input.request.cell, task: input.request.task, variant: input.request.variant, budget: input.request.budget })
  const budget = request.budget
  const enabled = input.request.variant.id === 'adaptive-strategy'
  const ctx = new Context()
  const preset = 'benchmark'
  const subject = { kind: 'agent' as const, id: preset, workspace }
  const goalActions = ['create', 'observe', 'inspect', 'focus', 'checkpoint', 'snapshot', 'execute', ...(enabled ? ['delegate'] : [])]
  const toolNames = ['goal_create', 'goal_context', 'goal_checkpoint', 'isolation_run', ...(enabled ? ['goal_strategy'] : [])]
  let owner: BenchmarkStrategyOwnerRuntime | undefined
  let binding: NativeAdapterBinding | undefined
  let meter: StrategyBenchmarkMeter | undefined
  let goal: { id: string; sessionId: string } | undefined
  let executed = false
  let closed = false
  let closeFlight: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closeFlight) return closeFlight
    closed = true
    meter?.dispose()
    const cleanup = (async () => {
      const results = await Promise.allSettled([
        owner?.shutdown() ?? ctx.fiber.dispose(), Promise.resolve().then(() => binding?.dispose()),
      ])
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'strategy runtime cleanup failed')
    })()
    closeFlight = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('strategy runtime stop is unknown: cleanup deadline exceeded')), stopTimeoutMs)
      cleanup.then(() => { clearTimeout(timer); resolve() }, error => { clearTimeout(timer); reject(error) })
    })
    return closeFlight
  }
  try {
    owner = await createBenchmarkStrategyOwnerRuntime({ ctx, workspace, stateRoot,
      cellId, provider: model.provider, model: model.model, maxOutputTokens: limits.maxOutputTokensPerCall,
      persona, allowedToolNames: toolNames, goalContinuationTimeoutMs: Math.min(300000, budget.durationMs),
      policyRules: [{ id: 'benchmark-goal', effect: 'allow', subject, actions: goalActions, resource: { kind: 'goal', id: 'business-context' }, context: { initiators: ['external'] } },
        ...[...toolNames, 'isolation:benchmark-work'].map(id => ({ id: `allow-${id.replace(':', '-')}`, effect: 'allow' as const, subject,
          actions: ['execute'], resource: { kind: 'tool' as const, id }, context: { initiators: ['external' as const] } }))] })
    // Literal package names with dynamic loading keep service declarations out of
    // the Evaluation ↔ Goals/Verifier/Delivery bootstrap dependency cycle.
    const names = ['@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-goal-round-driver', '@deepseek-ai/dsh-subagent',
      '@dsh-enhanced/assistant-goals', '@dsh-enhanced/assistant-isolation', '@dsh-enhanced/assistant-verifier']
    const [native, tools, driver, subagents, goalsModule, isolationModule, verifierModule] = await Promise.all(names.map(name => import(name)))
    await plugin(ctx, native.default)
    await plugin(ctx, { inject: tools.inject, apply: tools.apply })
    await plugin(ctx, { inject: driver.inject, apply: driver.apply })
    await plugin(ctx, subagents.SubagentRuntime)
    await plugin(ctx, goalsModule.default, { databasePath: join(owner.runtimeRoot, 'goals.sqlite'), verifyNativeRounds: true, verifyGoalOutcome: true,
      preauthorizedCreateMaxRounds: limits.maxGoalRounds, stepMaxDurationMs: stepDuration,
      ...(enabled ? { strategy: { maxDurationMs: Math.min(stepDuration, 30000) } } : {}),
      executionBudget: { ...budget, costUsdMicros: budget.costUsdMicros ?? undefined, modelCalls: limits.modelCalls, maxOutputTokensPerCall: limits.maxOutputTokensPerCall } })
    const goals = ctx.get('assistantGoals' as never) as unknown as GoalsHost
    benchmarkAssert(typeof goals?.inspectOwnerGoalExecution === 'function', 'upgrade Goals: owner execution snapshot API required')
    const lineage = owner.pairOwner()
    const principalId = owner.principalId
    const ownerRouteId = owner.ownerRouteId
    const expiresAt = Date.now() + budget.durationMs
    await plugin(ctx, isolationModule.default, { stateRoot: join(owner.runtimeRoot, 'isolation'), image, dockerPath,
      limits: { maxDurationMs: Math.min(stepDuration, 300000) }, grants: [{ id: 'benchmark-work', revision: 1,
        principalDigest: isolationModule.isolationPrincipalDigest(principalId), ...lineage, workspace: owner.workspace, agentPreset: preset,
        expiresAt, maxRuns: Math.max(1, budget.toolCalls), maxTotalDurationMs: budget.durationMs }] })
    const authority = { kind: 'isolated-runner', id: 'benchmark-verification', stateRoot: join(owner.runtimeRoot, 'verification-jobs'),
      image, dockerPath, command: task.verification.command, expiresAt,
      maxRuns: Math.min(10000, (limits.maxGoalRounds * 2 + 2) * task.verification.cases.length), maxTotalDurationMs: budget.durationMs,
      maxDurationMs: task.verification.maxDurationMs, maxOutputBytes: task.verification.maxOutputBytes,
      testSets: [{ id: 'cases', cases: task.verification.cases }] }
    const compiled = verifierModule.createVerifierAuthorities({ authorities: [authority] })[0]
    await plugin(ctx, verifierModule.AssistantVerifierService, { databasePath: join(owner.runtimeRoot, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: false,
      authorities: [authority], profiles: ['goal-step', 'goal-outcome'].map(taskKind => ({ id: `benchmark-${taskKind}`, version: 1, taskKind,
        objective: task.objective, scope: { workspace: owner!.workspace, preset }, owner: lineage, validityMs: budget.durationMs,
        bounds: { maxDurationMs: stepDuration, maxEvidenceBytes: 8192 }, criteria: [{ id: 'artifact-behavior', kind: 'isolated-process-behavior',
          authority: { id: compiled.id, digest: compiled.digest }, artifactPath: task.artifactPath, testSetId: 'cases' }] })) })
    binding = await factory(model, { ctx, workspace: owner.workspace })
    signal.throwIfAborted()
    meter = installStrategyBenchmarkMeter(ctx, { budget, modelCalls: limits.modelCalls, maxOutputTokens: limits.maxOutputTokensPerCall,
      model, binding, signal })
    goals.registerBudgetMeter({ id: 'benchmark-model', provider: model.provider, model: model.model, inputTokenUpperBound: binding.inputTokenUpperBound?.bind(binding),
      inputUsdMicrosPerMillionTokens: model.inputUsdMicrosPerMillionTokens, outputUsdMicrosPerMillionTokens: model.outputUsdMicrosPerMillionTokens,
      cacheReadUsdMicrosPerMillionTokens: model.cacheReadUsdMicrosPerMillionTokens, cacheWriteUsdMicrosPerMillionTokens: model.cacheWriteUsdMicrosPerMillionTokens })
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: limits.maxOutputTokensPerCall,
      ...(model.temperature === null ? {} : { temperature: model.temperature }) }))
    ctx.on('tools/result', execution => {
      if (execution.name !== 'goal_create' || !execution.agent) return
      const records = goals.list(execution.agent).filter(record => record.native.sessionId === String(execution.agent!.session.id) && record.native.objective === task.objective)
      if (records.length === 1) goal = { id: records[0]!.id, sessionId: records[0]!.native.sessionId }
    })
    await owner.installModel(binding.adapter)
    const runtime = owner
    const accounting = meter
    return Object.freeze({ runtimeRoot: owner.runtimeRoot, close, snapshotMeter: () => accounting.snapshot(),
      async execute() {
        benchmarkAssert(!executed && !closed, 'strategy runtime may execute only once')
        executed = true
        let result: { snapshot: Readonly<Record<string, unknown>>; meter: ReturnType<StrategyBenchmarkMeter['snapshot']>; outbound: BenchmarkStrategyOwnerRuntime['outbound'] }
        try {
          signal.throwIfAborted()
          await untilAbort(runtime.sendPublicInbound(task.publicPrompt), accounting.signal)
          await untilAbort(runtime.waitForQuiescence(goals), accounting.signal)
          accounting.assertComplete()
          benchmarkAssert(goal !== undefined, 'model did not create the exact admitted Goal')
          const snapshot = goals.inspectOwnerGoalExecution({ ownerRouteId, principalId,
            workspace: runtime.workspace, preset, sessionId: goal.sessionId, goalId: goal.id })
          result = { snapshot, meter: accounting.snapshot(), outbound: runtime.outbound }
        } finally { await close() }
        const native = nativeEvidence(result.snapshot as unknown as GoalSourceSnapshot)
        const status = (result.snapshot as unknown as GoalSourceSnapshot).outcome?.status
        const verdict = status === 'achieved' || status === 'not-achieved' ? status : 'unknown'
        const store = new StrategyEvidenceStore({ stateDirectory: stateRoot, candidateWorkspace: workspace })
        const evidence = store.write({ protocol: strategyEvidenceProtocol, version: 1, plan, request,
          input: { digest: digests.inputDigest }, acceptance: { digest: digests.acceptanceDigest, verdict }, versions: request.variant.versions,
          meter: result.meter, native, outcome: { status: verdict === 'unknown' ? 'unknown' : 'completed', verdict, quiescent: native.parent.quiescent } })
        return Object.freeze({ ...result, evidence })
      },
    })
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'strategy runtime setup failed') }
    throw error
  }
}
