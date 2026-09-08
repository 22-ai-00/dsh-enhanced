/** Serial Host executor for real Goal cells; journal cancellation owns the total deadline. */
import { mkdirSync, mkdtempSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { NativeAdapterFactory, NativeModelConfig } from './native.js'
import { emptyBenchmarkMetrics, type BenchmarkExecutionRequest, type BenchmarkExecutor } from './runner.js'
import { benchmarkAssert, benchmarkSnapshot } from './schema.js'
import { StrategyEvidenceStore, strategyFailureProtocol, strategyCellProtocol } from './strategy-evidence.js'
import { createStrategyGoalRuntime, strategyGoalTaskDigests, type StrategyGoalRuntimeControl, type StrategyGoalTask } from './strategy-goal-runtime.js'
import { parseStrategyBenchmarkPlan, strategyBenchmarkCapabilityVersions, strategyBenchmarkJournalPlan, strategyBenchmarkProtocol, strategyBenchmarkRequestLimits, type StrategyBenchmarkPlan } from './strategy-plan.js'
import { createFixedStrategyCapabilityExpectation, StrategyCapabilityRuntimeHost, assertStrategyCapabilityRuntime, type StrategyCapabilityRuntimeObservation } from './strategy-capabilities.js'
import { parseStrategyBenchmarkConfig, type StrategyBenchmarkConfig } from './strategy-config.js'
import { strategyDevelopmentCases, strategyDevelopmentDataset } from './strategy-corpus.js'
import type { BenchmarkMetrics, BenchmarkObservation, BenchmarkResult } from './types.js'

export interface StrategyBenchmarkExecutorOptions {
  plan: StrategyBenchmarkPlan
  tasks: Readonly<Record<string, StrategyGoalTask>>
  persona: string
  model: NativeModelConfig
  factory: NativeAdapterFactory
  /** Both directories must be private, canonical and outside one another. Retained for audit. */
  workspaceDirectory: string
  stateDirectory: string
  image: string
  dockerPath: string
  stepMaxDurationMs: number
  stopTimeoutMs?: number
}

function privateRoot(path: string): string {
  benchmarkAssert(isAbsolute(path), 'strategy root must be absolute')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  benchmarkAssert(realpathSync(path) === path && stat.isDirectory() && !stat.isSymbolicLink()
    && (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid()), 'strategy root must be canonical and private')
  return path
}
const contains = (a: string, b: string): boolean => { const path = relative(a, b); return path === '' || path !== '..' && !path.startsWith('../') && !isAbsolute(path) }
const same = (a: unknown, b: unknown): boolean => acceptanceCanonicalJson(a) === acceptanceCanonicalJson(b)
const resolverDirectory = fileURLToPath(new URL('.', import.meta.url))
const noSkills = acceptanceDigest('strategy-no-skills-v1')
function actualCapabilities(input: Pick<StrategyBenchmarkExecutorOptions, 'persona' | 'model' | 'image' | 'dockerPath' | 'stepMaxDurationMs' | 'stopTimeoutMs'>) {
  const expectation = createFixedStrategyCapabilityExpectation({ resolverDirectory, persona: input.persona, modelProvider: input.model.provider })
  const runtimeCommitment = { source: expectation.capabilities.common.runtime, sourceIdentityDigest: acceptanceDigest(expectation.sourceIdentity), image: input.image, dockerPath: input.dockerPath,
    stepMaxDurationMs: input.stepMaxDurationMs, stopTimeoutMs: input.stopTimeoutMs ?? 10000 }
  return { expectation, runtimeCommitment, capabilities: { ...expectation.capabilities, common: { ...expectation.capabilities.common, runtime: acceptanceDigest(runtimeCommitment) } } }
}

/** Freeze actual resolved runtime content/configuration before loading the trusted adapter. */
export function createStrategyBenchmarkPlan(value: StrategyBenchmarkConfig): Readonly<StrategyBenchmarkPlan> {
  const config = parseStrategyBenchmarkConfig(value)
  const { capabilities } = actualCapabilities(config)
  return parseStrategyBenchmarkPlan({ schemaVersion: 1, protocol: strategyBenchmarkProtocol, capabilities, execution: config.execution,
    benchmark: { schemaVersion: 1, id: config.id, comparison: 'capability', dataset: strategyDevelopmentDataset,
      cases: strategyDevelopmentCases().filter(task => config.cases.includes(task.id)), budget: config.budget, repeats: config.repeats, seed: config.seed,
      variants: [false, true].map(enabled => ({ id: enabled ? 'adaptive-strategy' : 'direct', role: enabled ? 'candidate' : 'baseline',
        features: { memory: false, planning: false, review: false, growth: false },
        versions: { model: acceptanceDigest(config.model), skills: noSkills, ...strategyBenchmarkCapabilityVersions(capabilities, enabled) } })) } })
}

/** The journal's failed result remains unknown even if late cleanup subsequently succeeds. */
export function createStrategyBenchmarkExecutor(input: StrategyBenchmarkExecutorOptions): BenchmarkExecutor {
  const plan = parseStrategyBenchmarkPlan(input.plan)
  const tasks = benchmarkSnapshot(input.tasks)
  const model = benchmarkSnapshot(input.model)
  const { persona, factory, image, dockerPath, stepMaxDurationMs, stopTimeoutMs } = input
  benchmarkAssert(typeof persona === 'string' && typeof factory === 'function', 'invalid strategy executor configuration')
  const { expectation, capabilities, runtimeCommitment } = actualCapabilities(input)
  benchmarkAssert(same(plan.capabilities, capabilities), 'strategy installed capabilities differ from plan')
  const journal = strategyBenchmarkJournalPlan(plan)
  benchmarkAssert(journal.variants.every(variant => variant.versions.model === acceptanceDigest(model) && variant.versions.skills === noSkills
    && Object.values(variant.features).every(flag => flag === false)), 'strategy executor cannot implement declared model, skills or extra features')
  benchmarkAssert(Object.keys(tasks).length === journal.cases.length, 'strategy task set differs')
  for (const task of journal.cases) {
    benchmarkAssert(Object.hasOwn(tasks, task.id), 'missing strategy task')
    const digests = strategyGoalTaskDigests(tasks[task.id]!)
    benchmarkAssert(digests.inputDigest === task.inputDigest && digests.acceptanceDigest === task.acceptanceDigest, 'strategy task digest differs')
  }
  const workspaceRoot = privateRoot(input.workspaceDirectory)
  const stateRoot = privateRoot(input.stateDirectory)
  benchmarkAssert(!contains(workspaceRoot, stateRoot) && !contains(stateRoot, workspaceRoot), 'strategy state and workspaces must be separate')
  type Capture = { sessionId: string; kind: 'parent' | 'child'; observation: StrategyCapabilityRuntimeObservation | null }
  type Attempt = { request: BenchmarkExecutionRequest; workspace: string; evidence: StrategyEvidenceStore; control?: StrategyGoalRuntimeControl; failure?: BenchmarkObservation; finished: boolean; captures: Capture[] }
  let active: Attempt | undefined
  const attempted = new Set<string>()
  return Object.freeze({
    async execute(request: BenchmarkExecutionRequest): Promise<BenchmarkObservation> {
      strategyBenchmarkRequestLimits(plan, request)
      benchmarkAssert(!attempted.has(request.cell.id) && (active === undefined || active.finished && active.failure === undefined), 'strategy execution is single-use and serial')
      attempted.add(request.cell.id)
      const workspace = mkdtempSync(join(workspaceRoot, 'cell-'))
      const attempt: Attempt = { request, workspace, evidence: new StrategyEvidenceStore({ stateDirectory: stateRoot, candidateWorkspace: workspace }), finished: false, captures: [] }
      active = attempt
      const guardedFactory: NativeAdapterFactory = async (selected, environment) => {
        const binding = await factory(selected, environment)
        try {
          request.signal.throwIfAborted()
          const { ctx } = environment
          ctx.on('llm/stream', async function* (options, next) {
            request.signal.throwIfAborted()
            const agent = ctx.agents.currentInitiator()
            benchmarkAssert(agent !== undefined, 'strategy request has no native agent')
            const sessionId = String(agent.session.id)
            if (agent.session.header.origin === 'subagent') {
              benchmarkAssert((options.tools?.length ?? 0) === 0, 'strategy child must have no tools')
              attempt.captures.push({ sessionId, kind: 'child', observation: null })
            } else {
              const host = StrategyCapabilityRuntimeHost.fromMountedContext(ctx as unknown as Parameters<typeof StrategyCapabilityRuntimeHost.fromMountedContext>[0])
              host.captureParentRequest({ system: options.system ?? '', tools: (options.tools ?? []).map(tool => ({ ...tool, output: null })) })
              const policyRequest = { subject: { kind: 'agent', id: 'benchmark', workspace }, action: 'execute', context: { initiator: 'external' } }
              host.capturePolicyRequests({ common: { ...policyRequest, resource: { kind: 'tool', id: 'goal_create' } },
                strategy: { ...policyRequest, resource: { kind: 'tool', id: 'goal_strategy' } } })
              const observation = assertStrategyCapabilityRuntime(expectation, host, request.variant.id === 'adaptive-strategy', agent)
              attempt.captures.push({ sessionId, kind: 'parent', observation })
            }
            yield* next()
          })
          return binding
        } catch (error) { await binding.dispose(); throw error }
      }
      const runtime = await createStrategyGoalRuntime({ plan, request, task: tasks[request.cell.caseId]!, persona, model, factory: guardedFactory,
        workspace, stateRoot, image, dockerPath, stepMaxDurationMs, ...(stopTimeoutMs === undefined ? {} : { stopTimeoutMs }),
        lifecycle: control => { attempt.control = control },
      })
      const result = await runtime.execute()
      benchmarkAssert(!request.signal.aborted && attempt.failure === undefined, 'strategy cell was already cancelled')
      const saved = attempt.evidence.read(plan, request.cell, result.evidence.digest)
      const meter = saved.meter
      benchmarkAssert(saved.outcome.status === 'completed' && saved.outcome.verdict !== 'unknown' && saved.outcome.quiescent, 'strategy cell outcome remains unknown')
      const metrics: BenchmarkMetrics = { inputTokens: meter.inputTokens, outputTokens: meter.outputTokens, costUsdMicros: meter.costUsdMicros,
        toolCalls: meter.toolCalls, rework: null, interventions: null, latencyMs: null }
      // The compact native object has no run dispatch timestamps. Its list order
      // cannot prove that a new round started after independent failure.
      const { signal: _signal, ...bound } = request
      const envelope = attempt.evidence.writeCell({ protocol: strategyCellProtocol, version: 1, plan, request: bound,
        nativeEvidenceDigest: result.evidence.digest, capabilities: { sourceIdentity: expectation.sourceIdentity, runtimeCommitment, requests: attempt.captures } })
      attempt.evidence.readCell(plan, request.cell, envelope.digest)
      attempt.finished = true
      return Object.freeze({ versions: saved.versions, inputDigest: saved.input.digest, acceptanceDigest: saved.acceptance.digest,
        verdict: saved.outcome.verdict, metrics, evidenceDigest: envelope.digest, quiescent: saved.outcome.quiescent })
    },
    failure(request: BenchmarkExecutionRequest, reason: Exclude<BenchmarkResult['reason'], 'verified'>): BenchmarkObservation | undefined {
      const attempt = active
      if (attempt === undefined || !same(attempt.request.cell, request.cell) || attempt.request !== request) return undefined
      if (attempt.failure !== undefined) return attempt.failure
      const snapshot = attempt.control?.snapshot() ?? { runtimeRoot: null, stage: 'setup' as const, cleanup: 'pending' as const, meter: null, goalSnapshot: null, lastGoalObservation: null, failureStage: null }
      const { signal: _signal, ...bound } = request
      const saved = attempt.evidence.writeFailure({ protocol: strategyFailureProtocol, version: 1, plan, request: bound, reason, observedAt: Date.now(), snapshot })
      const verified = attempt.evidence.readFailure(plan, request.cell, saved.digest)
      const meter = verified.snapshot.meter
      const metrics = emptyBenchmarkMetrics()
      if (meter !== null) {
        metrics.toolCalls = meter.toolCalls
        if (meter.heldModelCalls === 0) { metrics.inputTokens = meter.inputTokens; metrics.outputTokens = meter.outputTokens; metrics.costUsdMicros = meter.costUsdMicros }
      }
      attempt.failure = Object.freeze({ versions: request.variant.versions, inputDigest: request.task.inputDigest, acceptanceDigest: request.task.acceptanceDigest,
        verdict: 'unknown', metrics, evidenceDigest: saved.digest, quiescent: false })
      // Do not await an uncooperative provider or upgrade the persisted failure snapshot.
      void attempt.control?.close().catch(() => {})
      return attempt.failure
    },
  })
}

/** Reopen every referenced object before presenting strategy statistics. Missing crash evidence remains unknown. */
export function verifyStrategyBenchmarkResults(plan: StrategyBenchmarkPlan, results: readonly BenchmarkResult[], stateDirectory: string, workspaceDirectory: string): void {
  if (results.length === 0) return
  if (results.every(result => result.status === 'unknown' && result.evidenceDigest === null)) return
  const evidence = new StrategyEvidenceStore({ stateDirectory, candidateWorkspace: workspaceDirectory, createDirectories: false })
  for (const result of results) {
    if (result.status === 'unknown') {
      if (result.evidenceDigest === null) continue
      const failure = evidence.readFailure(plan, result.cell, result.evidenceDigest)
      benchmarkAssert(result.verdict === 'unknown' && failure.reason === result.reason, 'strategy failure result drift')
    } else {
      benchmarkAssert(result.evidenceDigest !== null, 'strategy cell evidence is missing')
      const cell = evidence.readCell(plan, result.cell, result.evidenceDigest)
      const native = evidence.read(plan, result.cell, cell.nativeEvidenceDigest)
      benchmarkAssert(result.verdict === native.outcome.verdict && native.outcome.quiescent
        && result.metrics.inputTokens === native.meter.inputTokens && result.metrics.outputTokens === native.meter.outputTokens
        && result.metrics.costUsdMicros === native.meter.costUsdMicros && result.metrics.toolCalls === native.meter.toolCalls,
      'strategy result differs from detailed evidence')
    }
  }
}
