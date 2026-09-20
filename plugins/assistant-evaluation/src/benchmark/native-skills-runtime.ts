/** Native Goal cells for skill reuse. Host orchestration; no second model or Goal loop. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isAbsolute, join } from 'node:path'
import { acceptanceDigest, validateTaskAcceptanceContract, validateTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { NativeAdapterBinding, NativeAdapterFactory, NativeModelConfig } from './native.js'
import type { BenchmarkBudget } from './types.js'
import { benchmarkAssert, benchmarkInteger, benchmarkSnapshot } from './schema.js'
import { createBenchmarkStrategyOwnerRuntime, type BenchmarkStrategyOwnerRuntime } from './strategy-owner.js'
import { installNativeGoalServices, type NativeGoalTask, type NativeGoalsHost } from './native-goal-services.js'
import { installStrategyBenchmarkMeter, type StrategyBenchmarkMeter, type StrategyBenchmarkMeterSnapshot } from './strategy-meter.js'
import { strategyGoalTaskDigests } from './strategy-goal-runtime.js'

export interface NativeSkillScope { principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string }
export interface NativeSkillSelection { scope: NativeSkillScope; ownerRouteId: string; skillName: string; version: number; candidateId?: string }
export interface NativeSkillSnapshot { definition: Readonly<Record<string, unknown>>; definitionDigest: string; sourceDigest: string; version: number; expiresAt: number }
export interface NativeSkillMountBinding {
  protocol: 'assistant-skills/delegated-arm/v1'; planDigest: string; cellId: string; variantId: string; definitionDigest: string; sourceDigest: string
  recipientScopeDigest: string; skillName: string; version: number; expiresAt: number
}
interface NativeSkillsHost {
  inspectOwnerBenchmarkArm(selection: NativeSkillSelection, signal?: AbortSignal): Promise<NativeSkillSnapshot>
  mintBenchmarkArm(input: { selection: NativeSkillSelection; recipient: NativeSkillsHost; recipientScope: NativeSkillScope; recipientOwnerRouteId: string; binding: NativeSkillMountBinding }, signal?: AbortSignal): Promise<unknown>
  mountBenchmarkArm(capability: unknown, binding: NativeSkillMountBinding): Promise<{ bindingDigest: string; dispose(): void }>
  inspect(agent: Agent, runId?: string): unknown
  stageOwnerVerifiedSuccessCandidate(exec: { agent: Agent; signal: AbortSignal }, input: unknown, authority: unknown): Promise<{ id: string; parentVersion: number }>
}
export interface NativeCapturedSkill {
  readonly selection: NativeSkillSelection
  readonly snapshot: NativeSkillSnapshot
  /** Frozen source-run evidence. This records training cost separately from reuse. */
  readonly origin: Readonly<{ model: NativeModelConfig; budget: BenchmarkBudget; execution: NativeSkillGoalOptions['execution']; task: NativeGoalTask; persona: string; result: NativeSkillGoalResult }>
  /** Live source service. Never serialize or substitute definition JSON for this authority. */
  readonly source: NativeSkillsHost
}
export interface NativeSkillGoalOptions {
  cellId: string; workspace: string; stateRoot: string; persona: string; model: NativeModelConfig; budget: BenchmarkBudget
  execution: { modelCalls: number; maxOutputTokensPerCall: number; maxGoalRounds: number }
  task: NativeGoalTask; image: string; dockerPath: string; stepMaxDurationMs: number; factory: NativeAdapterFactory; signal: AbortSignal
  stopTimeoutMs?: number
  /** Configured before the source Goal is created; never renew an accepted receipt. */
  source?: { name: string; description: string; validityMs: number }
  arm?: { captured: NativeCapturedSkill; planDigest: string; variantId: string }
  lifecycle?: (control: NativeSkillGoalControl) => void
}
export interface NativeSkillCapabilityObservation {
  sessionId: string; toolNames: readonly string[]; toolsDigest: string; systemDigest: string
}
export interface NativeSkillGoalResult {
  snapshot: Readonly<Record<string, unknown>>; meter: Readonly<StrategyBenchmarkMeterSnapshot>; capabilities: readonly NativeSkillCapabilityObservation[]
  skillRuns: readonly Readonly<Record<string, unknown>>[]; delegation: NativeSkillMountBinding | null
  toolCalls: readonly { name: string; inputDigest: string; outputDigest: string }[]
}
export interface NativeSkillGoalControl { close(): Promise<void>; snapshot(): { runtimeRoot: string | null; stage: string; meter: Readonly<StrategyBenchmarkMeterSnapshot> | null; result: NativeSkillGoalResult | null; cleanup: 'pending' | 'succeeded' | 'unknown' } }

const original = Symbol.for('cordis.original')
const raw = <T>(value: T): T => (value as T & { [original]?: T })?.[original] ?? value
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('native skill cell cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort() }
  })
}
const plugin = (ctx: Context, value: unknown, config: unknown = {}) => ctx.plugin(value as new (ctx: Context, config: never) => unknown, config as never)

function validateNativeSkillGoalOptions(input: NativeSkillGoalOptions): void {
  const route = (value: unknown): boolean => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)
  const digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
  benchmarkAssert(typeof input.cellId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.cellId), 'invalid native skill cell id')
  benchmarkAssert(typeof input.workspace === 'string' && isAbsolute(input.workspace) && typeof input.stateRoot === 'string' && isAbsolute(input.stateRoot), 'native skill workspace and state root must be absolute')
  benchmarkAssert(typeof input.persona === 'string' && Buffer.byteLength(input.persona) <= 32768 && typeof input.factory === 'function', 'invalid native skill runtime input')
  benchmarkInteger(input.budget.durationMs, 1, 86_400_000)
  for (const value of [input.budget.inputTokens, input.budget.outputTokens, input.budget.toolCalls]) benchmarkInteger(value, 0, 1_000_000_000)
  if (input.budget.costUsdMicros !== null) benchmarkInteger(input.budget.costUsdMicros, 0, 1_000_000_000)
  benchmarkAssert(route(input.model.provider) && route(input.model.model), 'invalid native skill model route')
  benchmarkAssert(input.model.temperature === null || (typeof input.model.temperature === 'number' && Number.isFinite(input.model.temperature) && input.model.temperature >= 0 && input.model.temperature <= 2), 'invalid native skill temperature')
  benchmarkAssert(input.model.inputLimitMode === undefined || input.model.inputLimitMode === 'upper-bound', 'native skills requires an input upper bound')
  benchmarkAssert(input.model.outputLimitMode === undefined || input.model.outputLimitMode === 'provider', 'native skills requires a provider output limit')
  benchmarkAssert(input.model.observationMode === undefined || input.model.observationMode === 'enforced-upper-bound-provider-output', 'native skills requires enforced output observation')
  benchmarkInteger(input.model.maxOutputTokens, 1, input.budget.outputTokens)
  benchmarkAssert(digest(input.model.adapterDigest) && digest(input.model.tokenCounterDigest), 'invalid native skill model digest')
  const rates = [input.model.inputUsdMicrosPerMillionTokens, input.model.outputUsdMicrosPerMillionTokens, input.model.cacheReadUsdMicrosPerMillionTokens, input.model.cacheWriteUsdMicrosPerMillionTokens]
  benchmarkAssert((rates[0] === null) === (rates[1] === null), 'native skill token rates must be paired')
  for (const rate of rates) if (rate !== undefined && rate !== null) benchmarkInteger(rate, 0, 1_000_000_000)
  if (input.budget.costUsdMicros !== null) benchmarkAssert(rates.every(rate => rate !== null && rate !== undefined), 'priced native skills requires all token rates')
  benchmarkInteger(input.execution.modelCalls, 1, 10000); benchmarkInteger(input.execution.maxGoalRounds, 1, 32)
  benchmarkInteger(input.execution.maxOutputTokensPerCall, 1, input.budget.outputTokens)
  benchmarkInteger(input.stepMaxDurationMs, 1000, 300000)
  benchmarkAssert(/^sha256:[a-f0-9]{64}$/u.test(input.image) && typeof input.dockerPath === 'string' && isAbsolute(input.dockerPath), 'immutable image and absolute Docker path required')
  benchmarkAssert(input.stepMaxDurationMs * 3 < input.budget.durationMs && input.task.verification.maxDurationMs * input.task.verification.cases.length < input.stepMaxDurationMs, 'native skill verification exceeds budget')
}

export async function createNativeSkillGoalRuntime(input: NativeSkillGoalOptions) {
  benchmarkAssert(!(input.source && input.arm), 'source capture and delegated arm cannot share a cell')
  strategyGoalTaskDigests(input.task)
  validateNativeSkillGoalOptions(input)
  benchmarkAssert(input.model.maxOutputTokens === input.execution.maxOutputTokensPerCall && input.model.observationMode !== 'observed-call-count', 'native skills requires the same enforced token contract')
  const stopTimeoutMs = input.stopTimeoutMs ?? 10000; benchmarkInteger(stopTimeoutMs, 1000, 30000)
  if (input.source) benchmarkInteger(input.source.validityMs, 1000, 86400000)
  const captured = input.arm?.captured
  const frozen = benchmarkSnapshot({ cellId: input.cellId, persona: input.persona, model: input.model, budget: input.budget, execution: input.execution,
    task: input.task, image: input.image, dockerPath: input.dockerPath, stepMaxDurationMs: input.stepMaxDurationMs,
    source: input.source ?? null, arm: input.arm ? { planDigest: input.arm.planDigest, variantId: input.arm.variantId, selection: captured!.selection, snapshot: captured!.snapshot } : null })
  if (captured) benchmarkAssert(acceptanceDigest({ model: captured.origin.model, budget: captured.origin.budget, execution: captured.origin.execution, task: captured.origin.task, persona: captured.origin.persona })
    === acceptanceDigest({ model: frozen.model, budget: frozen.budget, execution: frozen.execution, task: frozen.task, persona: frozen.persona }), 'delegated native skill must reuse the source supplier and execution contract')
  const ctx = new Context(), lifetime = new AbortController(), execution = new AbortController()
  const signal = AbortSignal.any([input.signal, lifetime.signal, execution.signal])
  const deadline = setTimeout(() => execution.abort(new Error('native skill cell deadline')), input.budget.durationMs); deadline.unref?.()
  let owner: BenchmarkStrategyOwnerRuntime | undefined, goals: NativeGoalsHost | undefined, skills: NativeSkillsHost | undefined
  let adapter: NativeAdapterBinding | undefined, meter: StrategyBenchmarkMeter | undefined, mount: { bindingDigest: string; dispose(): void } | undefined
  let factoryPending: Promise<unknown> | undefined, mountPending: Promise<void> | undefined, disposeAdapterFlight: Promise<void> | undefined, disposeMountFlight: Promise<void> | undefined, closeFlight: Promise<void> | undefined
  let stage = 'setup', cleanup: 'pending' | 'succeeded' | 'unknown' = 'pending', stopped = false, started = false, setupSettled = false
  let goal: { id: string; sessionId: string } | undefined, delegation: NativeSkillMountBinding | null = null, result: NativeSkillGoalResult | null = null
  let captureFlight: Promise<NativeCapturedSkill> | undefined
  let mountDelegated: (() => Promise<void>) | undefined
  const capabilities: NativeSkillCapabilityObservation[] = [], skillRuns: Readonly<Record<string, unknown>>[] = []
  const toolCalls: { name: string; inputDigest: string; outputDigest: string }[] = []
  const live = () => { signal.throwIfAborted(); benchmarkAssert(!stopped, 'native skill runtime closed') }
  const disposeAdapter = (value?: NativeAdapterBinding) => disposeAdapterFlight ??= Promise.resolve().then(() => value?.dispose())
  const disposeMount = (value?: { dispose(): void }) => disposeMountFlight ??= Promise.resolve().then(() => value?.dispose())
  const snapshot = () => ({ runtimeRoot: owner?.runtimeRoot ?? null, stage, meter: meter?.snapshot() ?? null, result, cleanup })
  const close = (): Promise<void> => {
    if (closeFlight) return closeFlight
    stopped = true; stage = 'cleanup'; clearTimeout(deadline); lifetime.abort(); meter?.dispose()
    // Factory, delegated mount, and capture can all outlive the foreground
    // operation. Drain each one so a late resource is disposed before a
    // successful close is reported.
    const drainedCapture = captureFlight?.catch(error => {
      if (signal.aborted && error === signal.reason) return
      throw error
    }) ?? Promise.resolve()
    const work = Promise.allSettled([owner?.shutdown() ?? ctx.fiber.dispose(), ...(adapter ? [disposeAdapter(adapter)] : []), ...(mount ? [disposeMount(mount)] : []), factoryPending ?? Promise.resolve(), mountPending ?? Promise.resolve(), drainedCapture]).then(async values => {
      await Promise.resolve()
      const failed = values.filter((value): value is PromiseRejectedResult => value.status === 'rejected')
      if (!setupSettled || failed.length) throw new AggregateError(failed.map(value => value.reason), 'native skill runtime did not quiesce')
    })
    closeFlight = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup = 'unknown'; reject(new Error('native skill shutdown deadline')) }, stopTimeoutMs)
      work.then(() => { clearTimeout(timer); if (cleanup === 'unknown') return; cleanup = 'succeeded'; stage = 'closed'; resolve() }, error => { clearTimeout(timer); cleanup = 'unknown'; reject(error) })
    })
    return closeFlight
  }
  try {
    input.lifecycle?.({ close, snapshot })
    const tools = ['goal_create', 'goal_context', 'goal_checkpoint', 'isolation_run', ...(captured ? ['skill_status', 'skill_run'] : [])]
    const subject = { kind: 'agent' as const, id: 'benchmark', workspace: input.workspace }
    owner = await createBenchmarkStrategyOwnerRuntime({ ctx, workspace: input.workspace, stateRoot: input.stateRoot, cellId: frozen.cellId,
      provider: frozen.model.provider, model: frozen.model.model, maxOutputTokens: frozen.execution.maxOutputTokensPerCall, persona: frozen.persona,
      allowedToolNames: tools, goalContinuationTimeoutMs: Math.min(300000, frozen.budget.durationMs), policyRules: [
        { id: 'native-skills-goal', effect: 'allow', subject, actions: ['create', 'observe', 'inspect', 'focus', 'checkpoint', 'snapshot', 'execute'], resource: { kind: 'goal', id: 'business-context' }, context: { initiators: ['external'] } },
        ...[...tools, 'isolation:benchmark-work'].map(id => ({ id: `allow-${id.replace(':', '-')}`, effect: 'allow' as const, subject, actions: ['execute'], resource: { kind: 'tool' as const, id }, context: { initiators: ['external' as const] } })),
        ...(captured || frozen.source ? [
          { id: 'native-skills-use', effect: 'allow' as const, subject, actions: ['inspect', 'run', ...(frozen.source ? ['draft'] : [])], resource: { kind: 'evolution' as const, id: 'verified-workflows' }, context: { initiators: ['external' as const] } },
          { id: 'native-skills-compare', effect: 'allow' as const, subject: { kind: 'background' as const, id: 'dsh-enhanced-assistant-skills', workspace: input.workspace }, actions: ['compare'], resource: { kind: 'evolution' as const, id: 'verified-workflows' }, context: { initiators: ['background' as const] } },
          ...(frozen.source ? [{ id: 'native-skills-capture', effect: 'allow' as const, subject, actions: ['draft'], resource: { kind: 'evolution' as const, id: 'verified-workflows' }, context: { initiators: ['background' as const] } }] : []),
        ] : []),
      ] })
    if (stopped || signal.aborted) await owner.shutdown()
    live()
    const services = await installNativeGoalServices({ ctx, owner, model: frozen.model, budget: frozen.budget, limits: { ...frozen.execution, observationMode: 'enforced-upper-bound-provider-output' },
      task: frozen.task, image: frozen.image, dockerPath: frozen.dockerPath, stepMaxDurationMs: frozen.stepMaxDurationMs, enabledStrategy: false, assertLive: live,
      ...(frozen.source ? { acceptanceValidityMs: frozen.source.validityMs } : {}) })
    goals = services.goals
    if (captured || frozen.source) {
      const skillsPackage = '@dsh-enhanced/assistant-skills', queryPackage = '@deepseek-ai/dsh-session-query'
      const skillsModule = await import(skillsPackage); live()
      await plugin(ctx, skillsModule.default, { databasePath: join(owner.runtimeRoot, 'skills.sqlite'), allowedTools: ['isolation_run'], maxDurationMs: Math.min(300000, frozen.budget.durationMs), candidateTtlMs: frozen.source?.validityMs ?? frozen.budget.durationMs }); live()
      skills = ctx.get('assistantSkills' as never) as unknown as NativeSkillsHost
      if (frozen.source) {
        // The upstream service's concrete exact-read/observeSession contract is
        // used here; no search methods or model-visible query tools are mounted.
        const query = await import(queryPackage); await plugin(ctx, query.SessionQueryEngine); live()
      }
      if (captured) mountDelegated = async () => {
        const recipient = owner!.ownerScope(), scope: NativeSkillScope = { principalId: recipient.principalId, ...recipient.owner, workspace: recipient.workspace, preset: recipient.preset }
        delegation = { protocol: 'assistant-skills/delegated-arm/v1', planDigest: frozen.arm!.planDigest, cellId: frozen.cellId, variantId: frozen.arm!.variantId,
          definitionDigest: frozen.arm!.snapshot.definitionDigest, sourceDigest: frozen.arm!.snapshot.sourceDigest, recipientScopeDigest: acceptanceDigest(scope),
          skillName: frozen.arm!.selection.skillName, version: frozen.arm!.snapshot.version, expiresAt: Math.min(frozen.arm!.snapshot.expiresAt, Date.now() + Math.min(300000, frozen.budget.durationMs)) }
        const pending = (async () => {
          const capability = await captured.source.mintBenchmarkArm({ selection: frozen.arm!.selection, recipient: skills!, recipientScope: scope, recipientOwnerRouteId: owner!.ownerRouteId, binding: delegation }, signal)
          return skills!.mountBenchmarkArm(capability, delegation)
        })()
        mountPending = pending.then(async value => {
          if (stopped || signal.aborted) await disposeMount(value)
          else mount = value
        })
        await bounded(mountPending, signal); live()
      }
    }
    const pending = Promise.resolve().then(() => input.factory(frozen.model, { ctx, workspace: owner!.workspace }))
    factoryPending = pending.then(async value => { if (stopped || signal.aborted) await disposeAdapter(value) }, () => {})
    adapter = await bounded(pending, signal); live()
    meter = installStrategyBenchmarkMeter(ctx, { budget: frozen.budget, modelCalls: frozen.execution.modelCalls, maxOutputTokens: frozen.execution.maxOutputTokensPerCall, model: frozen.model, binding: adapter, signal })
    goals.registerBudgetMeter({ id: 'benchmark-model', provider: frozen.model.provider, model: frozen.model.model, inputTokenUpperBound: adapter.inputTokenUpperBound?.bind(adapter),
      inputUsdMicrosPerMillionTokens: frozen.model.inputUsdMicrosPerMillionTokens, outputUsdMicrosPerMillionTokens: frozen.model.outputUsdMicrosPerMillionTokens,
      cacheReadUsdMicrosPerMillionTokens: frozen.model.cacheReadUsdMicrosPerMillionTokens, cacheWriteUsdMicrosPerMillionTokens: frozen.model.cacheWriteUsdMicrosPerMillionTokens })
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: frozen.execution.maxOutputTokensPerCall, ...(frozen.model.temperature === null ? {} : { temperature: frozen.model.temperature }) }))
    ctx.on('llm/stream', async function* (options, next) {
      const agent = ctx.agents.currentInitiator(); benchmarkAssert(agent !== undefined, 'native skill request has no Agent')
      const names = (options.tools ?? []).map(tool => tool.name).sort()
      benchmarkAssert(names.every(name => tools.includes(name)) && (captured ? names.includes('skill_run') && names.includes('skill_status') : !names.some(name => name.startsWith('skill'))), `native skill tool surface drift: ${names.join(',')}`)
      capabilities.push({ sessionId: String(agent.session.id), toolNames: names, toolsDigest: acceptanceDigest(options.tools ?? []), systemDigest: acceptanceDigest(options.system ?? '') })
      yield* next()
    })
    ctx.on('tools/result', (execution, value) => {
      if (!execution.agent) return
      toolCalls.push({ name: execution.name, inputDigest: acceptanceDigest(execution.arguments), outputDigest: acceptanceDigest(value) })
      if (execution.name === 'goal_create') {
        const matches = goals!.list(execution.agent).filter(value => value.native.sessionId === String(execution.agent!.session.id) && value.native.objective === frozen.task.objective)
        if (matches.length === 1) goal = { id: matches[0]!.id, sessionId: matches[0]!.native.sessionId }
      }
      if (execution.name === 'skill_run' && skills) {
        if (value && !value.isError && value.value && typeof value.value === 'object' && 'context' in value.value && typeof value.value.context === 'string') {
          const parsed: unknown = JSON.parse(value.value.context)
          if (parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'string') {
            const run = raw(skills).inspect(execution.agent, parsed.id)
            if (run && typeof run === 'object') skillRuns.push(benchmarkSnapshot(run as Readonly<Record<string, unknown>>))
          }
        }
      }
    })
    await owner.installModel(adapter.adapter); live(); setupSettled = true
    const runtime = owner, accounting = meter
    return { close, snapshot, runtimeRoot: runtime.runtimeRoot,
      async execute(): Promise<NativeSkillGoalResult> {
        benchmarkAssert(!started && !stopped, 'native skill cell can execute only once'); started = true; stage = 'executing'
        try {
          await bounded(runtime.sendPublicInbound(frozen.task.publicPrompt), accounting.signal)
          if (mountDelegated) await bounded(mountDelegated(), accounting.signal)
          await bounded(runtime.waitForQuiescence(goals), accounting.signal)
          accounting.assertComplete(); benchmarkAssert(goal !== undefined, 'model did not create the requested Goal')
          result = benchmarkSnapshot({ snapshot: goals!.inspectOwnerGoalExecution({ ownerRouteId: runtime.ownerRouteId, principalId: runtime.principalId, workspace: runtime.workspace, preset: 'benchmark', sessionId: goal.sessionId, goalId: goal.id }),
            meter: accounting.snapshot(), capabilities, skillRuns, delegation, toolCalls })
          stage = 'observed'; clearTimeout(deadline); accounting.dispose()
          return result
        } catch (error) { try { await close() } catch {} throw error }
      },
      readAcceptedArtifact(): { content: string; sha256: string; contractId: string } {
        benchmarkAssert(result !== null && !stopped && !input.signal.aborted, 'live observed runtime required for artifact readback')
        runtime.ownerScope()
        const outcome = result.snapshot.outcome as { assessmentId?: string } | undefined
        const assessments = result.snapshot.outcomeAssessments as { contract: { task: { ref: string } }; triggerRunId: string | null }[]
        const selected = assessments.find(value => value.contract.task.ref === outcome?.assessmentId)
        benchmarkAssert(selected?.triggerRunId !== undefined && selected.triggerRunId !== null, 'independent outcome artifact run unavailable')
        const tasks = result.snapshot.acceptedTasks as { contract: unknown; receipt: unknown }[]
        const task = tasks.find(value => (value.contract as { task?: { kind?: string; ref?: string } } | null)?.task?.kind === 'goal-step'
          && (value.contract as { task: { ref: string } }).task.ref === selected.triggerRunId)
        benchmarkAssert(task !== undefined, 'independent step artifact contract unavailable')
        const contract = validateTaskAcceptanceContract(task.contract)
        validateTaskVerificationReceipt(contract, task.receipt)
        const isolation = ctx.get('assistantIsolation' as never) as unknown as { readAcceptedArtifact(contract: unknown, path: string): { content: string; sha256: string } }
        const artifact = isolation.readAcceptedArtifact(contract, frozen.task.artifactPath)
        runtime.ownerScope()
        return { content: artifact.content, sha256: artifact.sha256, contractId: contract.id }
      },
      captureVerifiedSkill(): Promise<NativeCapturedSkill> {
        return captureFlight ??= (async () => {
        benchmarkAssert(frozen.source !== null && skills !== undefined && result !== null && goal !== undefined && !stopped && !input.signal.aborted, 'live accepted source runtime required')
        benchmarkAssert((result.snapshot.outcome as { status?: string } | undefined)?.status === 'achieved', 'source Goal is not independently achieved')
        const lineage = runtime.ownerScope(), scope: NativeSkillScope = { principalId: lineage.principalId, ...lineage.owner, workspace: lineage.workspace, preset: lineage.preset }
        const captureSignal = AbortSignal.any([input.signal, lifetime.signal, AbortSignal.timeout(10000)])
        const assertCurrent = () => { captureSignal.throwIfAborted(); benchmarkAssert(!stopped && acceptanceDigest(runtime.ownerScope()) === acceptanceDigest(lineage), 'source capture owner changed') }
        // Delivery disposes the original foreground Agent at completion. Use
        // the existing growth-deposit contract from an inert, owned background
        // Agent. No prompt, native Goal, model request or invented trace is made.
        const handle = await ctx.agents.create({ sessionId: SessionId(`skill-capture-${acceptanceDigest([scope, frozen.cellId]).slice(0, 40)}`),
          meta: { cwd: scope.workspace, agentPreset: scope.preset }, signal: captureSignal,
          agentOptions: { provider: frozen.model.provider, model: frozen.model.model, maxTokens: frozen.execution.maxOutputTokensPerCall },
          setup(agentCtx: Agent['ctx'], preparedAgent?: Agent) {
            assertCurrent()
            const agent = preparedAgent ?? agentCtx.agent
            benchmarkAssert(agent !== undefined, 'capture Agent unavailable')
            agentCtx.effect(() => raw(ctx.assistantPolicy).bindInitiator(agent, 'background', scope.principalId))
            agentCtx.tools.restrict({ allow: [] })
          } })
        let candidate: { id: string; parentVersion: number }
        try {
          assertCurrent()
          candidate = await raw(skills).stageOwnerVerifiedSuccessCandidate({ agent: handle.agent, signal: captureSignal }, { ownerRouteId: runtime.ownerRouteId, successLocators: [{ sessionId: goal.sessionId, goalId: goal.id }], minimumOccurrences: 1, name: frozen.source.name, description: frozen.source.description },
            { id: `benchmark-source-${frozen.cellId}`, scope, ownerRouteId: runtime.ownerRouteId, expiresAt: Date.now() + 10000, assertCurrent })
          assertCurrent()
        } finally { await handle.dispose() }
        const selection: NativeSkillSelection = { scope, ownerRouteId: runtime.ownerRouteId, skillName: frozen.source.name, version: candidate.parentVersion + 1, candidateId: candidate.id }
        const snapshot = await skills.inspectOwnerBenchmarkArm(selection, captureSignal)
        return Object.freeze({ source: skills, selection, snapshot, origin: Object.freeze({ model: frozen.model, budget: frozen.budget, execution: frozen.execution,
          task: frozen.task, persona: frozen.persona, result }) })
        })()
      },
    }
  } catch (error) { setupSettled = true; try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'native skill setup failed') }; throw error }
}
