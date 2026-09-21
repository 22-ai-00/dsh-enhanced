/** Host-only native skill comparison. Execution stays in DSH; judgement stays in the authority. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { CellObservation, HoldoutReceipt, ProspectiveBenchmarkManifest, QualificationBinding, SignedCell } from '@dsh-enhanced/task-acceptance-contract/holdout-authority'
import type { NativeAdapterFactory } from './native.js'
import { createNativeSkillGoalRuntime, type NativeCapturedSkill, type NativeSkillGoalControl, type NativeSkillGoalOptions, type NativeSkillGoalResult } from './native-skills-runtime.js'
import { BenchmarkStore } from './store.js'
import { runBenchmark, type BenchmarkExecutor } from './runner.js'
import { benchmarkReport } from './report.js'
import { benchmarkAssert, benchmarkInteger, benchmarkPlanDigest, benchmarkSchedule, benchmarkSnapshot, parseBenchmarkPlan } from './schema.js'
import type { BenchmarkPlan, BenchmarkResult, BenchmarkVersions } from './types.js'
import { resolveStrategyCapabilitySource } from './strategy-capabilities.js'

export { createNativeSkillGoalRuntime } from './native-skills-runtime.js'
export type { NativeCapturedSkill, NativeSkillGoalOptions, NativeSkillGoalResult } from './native-skills-runtime.js'
export const nativeSkillBenchmarkProtocol = 'dsh-native-skill-benchmark/v1' as const
export interface NativeSkillBenchmarkConfig {
  id: string
  /** Private Host evidence/journal root; never a model workspace. */
  stateRoot: string
  workspaceRoot: string
  persona: string
  model: NativeSkillGoalOptions['model']
  budget: NativeSkillGoalOptions['budget']
  execution: NativeSkillGoalOptions['execution']
  /** Public program specification and separate, provisional native Goal smoke checks. */
  task: NativeSkillGoalOptions['task']
  image: string
  dockerPath: string
  stepMaxDurationMs: number
  stopTimeoutMs?: number
  repeats: number
  seed: number
  expiresAt: number
  authority: { executable: string; args: readonly string[]; publicKey: string; generatorDigest: string }
  verification: { command: string; maxDurationMs: number; maxOutputBytes: number }
}
export interface NativeSkillBenchmarkEvidence {
  protocol: typeof nativeSkillBenchmarkProtocol
  binding: QualificationBinding
  config: NativeSkillBenchmarkConfig
  runtimeDigest: string
  sourceDigest: string
  training: NativeCapturedSkill['origin']
  nativeResults: readonly { cellId: string; value: NativeSkillGoalResult }[]
  manifest: ProspectiveBenchmarkManifest
  plan: BenchmarkPlan
  receipt: HoldoutReceipt
  /** Provisional ledger results: never promoted from an unsigned per-cell response. */
  executionResults: readonly BenchmarkResult[]
  observations: readonly CellObservation[]
}
const bytesDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const same = (left: unknown, right: unknown) => acceptanceCanonicalJson(left) === acceptanceCanonicalJson(right)
const resolverDirectory = dirname(fileURLToPath(import.meta.url))
function trainingDigest(origin: NativeCapturedSkill['origin']): string {
  return acceptanceDigest({ model: acceptanceDigest(origin.model), budget: acceptanceDigest(origin.budget), execution: acceptanceDigest(origin.execution), task: acceptanceDigest(origin.task), persona: acceptanceDigest(origin.persona), result: acceptanceDigest(origin.result) })
}

/** Fixed deployed modules, re-read before each cell; no caller-supplied runtime digest. */
export function nativeSkillRuntimeIdentity(provider: string): string {
  const names = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query',
    '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-goal-round-driver', '@dsh-enhanced/assistant-evaluation', '@dsh-enhanced/assistant-delivery',
    '@dsh-enhanced/assistant-policy', '@dsh-enhanced/assistant-goals', '@dsh-enhanced/assistant-skills', '@dsh-enhanced/assistant-isolation', '@dsh-enhanced/assistant-verifier']
  if (provider === 'super-relay') names.push('@dsh-enhanced/assistant-super-relay-budget', '@deepseek-ai/dsh-credentials')
  if (provider === 'deepseek-goal-metered') names.push('@dsh-enhanced/assistant-deepseek-budget', '@deepseek-ai/dsh-credentials')
  const require = createRequire(import.meta.url)
  return acceptanceDigest(names.map(packageName => {
    const moduleResolverDirectory = packageName === '@deepseek-ai/dsh-credentials'
      ? dirname(require.resolve(provider === 'super-relay' ? '@dsh-enhanced/assistant-super-relay-budget' : '@dsh-enhanced/assistant-deepseek-budget')) : resolverDirectory
    const moduleRequire = createRequire(join(moduleResolverDirectory, 'native-skill-resolver.cjs'))
    let root = dirname(realpathSync(moduleRequire.resolve(packageName)))
    while (!existsSync(join(root, 'package.json')) || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== packageName) {
      benchmarkAssert(dirname(root) !== root, 'native skill runtime package root missing'); root = dirname(root)
    }
    const files: string[] = []
    const walk = (directory: string): void => {
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`
        benchmarkAssert(!entry.isSymbolicLink(), 'native skill runtime has a linked source')
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile() && /\.(?:js|json)$/u.test(entry.name)) files.push(path)
      }
    }
    walk('lib')
    return resolveStrategyCapabilitySource({ resolverDirectory: moduleResolverDirectory, module: { packageName, files: files.sort() } }).digest
  }))
}
function separate(left: string, right: string): void {
  for (const [a, b] of [[left, right], [right, left]]) {
    const path = relative(a!, b!)
    benchmarkAssert(path !== '' && (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)), 'native skill private state overlaps a workspace')
  }
}
function privateRoot(path: string): void {
  benchmarkAssert(isAbsolute(path) && resolve(path) === path && path !== '/', 'native skill root must be canonical and absolute')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  benchmarkAssert(realpathSync(path) === path && stat.isDirectory() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(), 'native skill root must be private and owned')
}
/** Immutable receipts, not a second execution or acceptance state machine. */
function save(root: string, name: string, value: unknown): void {
  privateRoot(root)
  // Aggregate many separately canonicalized/signed cells without applying one contract's 4096-node limit to the entire run.
  const text = JSON.stringify(value), path = join(root, `${name}.json`)
  benchmarkAssert(Buffer.byteLength(text) <= 32 * 1024 * 1024, 'native skill evidence exceeds bound')
  if (existsSync(path)) {
    const stat = lstatSync(path)
    benchmarkAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && readFileSync(path, 'utf8') === text, 'native skill evidence conflict')
    return
  }
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

export function nativeSkillJournalPlan(config: NativeSkillBenchmarkConfig, binding: QualificationBinding, manifest: ProspectiveBenchmarkManifest, runtimeDigest: string): Readonly<BenchmarkPlan> {
  const versions = (candidate: boolean): BenchmarkVersions => ({ model: acceptanceDigest(config.model), prompt: acceptanceDigest({ persona: config.persona, task: config.task }),
    skills: candidate ? binding.candidateDigest : binding.baselineDigest,
    tools: acceptanceDigest({ protocol: nativeSkillBenchmarkProtocol, candidate, tools: ['goal_create', 'goal_context', 'goal_checkpoint', 'isolation_run', ...(candidate ? ['skill_run', 'skill_status'] : [])] }),
    policy: acceptanceDigest({ protocol: nativeSkillBenchmarkProtocol, candidate, runtimeDigest }), runtime: acceptanceDigest({ runtimeDigest, binding, execution: config.execution, image: config.image, dockerPath: config.dockerPath }) })
  const plan = parseBenchmarkPlan({ schemaVersion: 1, id: config.id, comparison: 'capability', dataset: { id: `prospective-${manifest.begin.datasetDigest.slice(0, 24)}`, version: '1', digest: manifest.begin.datasetDigest, split: 'holdout' },
    cases: manifest.cases.map(value => ({ id: value.id, domain: 'code', inputDigest: value.inputDigest, acceptanceDigest: value.acceptanceDigest })),
    variants: [false, true].map(candidate => ({ id: candidate ? 'candidate' : 'baseline', role: candidate ? 'candidate' : 'baseline', versions: versions(candidate), features: { memory: false, planning: false, review: false, growth: candidate } })),
    budget: config.budget, repeats: config.repeats, seed: config.seed })
  const cells = benchmarkSchedule(plan)
  benchmarkAssert(cells.length === manifest.cells.length && cells.every((cell, index) => {
    const signed = manifest.cells[index]!
    return signed.caseId === cell.caseId && signed.repeat === cell.repeat + 1 && signed.armDigest === (cell.variantId === 'candidate' ? binding.candidateDigest : binding.baselineDigest)
  }), 'authority and benchmark cell schedules disagree')
  return plan
}

/** Recheck final signatures and exact per-cell observations before exposing any quality result. */
export async function nativeSkillBenchmarkReport(evidence: NativeSkillBenchmarkEvidence, publicKey: string, generatorDigest: string) {
  const authorityModule = '@dsh-enhanced/assistant-skills/holdout-authority', qualificationModule = '@dsh-enhanced/assistant-skills/holdout-qualification'
  const { verifyProspectiveBenchmarkManifest } = await import(authorityModule)
  const { verifyHoldoutReceipt } = await import(qualificationModule)
  benchmarkAssert(evidence.protocol === nativeSkillBenchmarkProtocol && verifyProspectiveBenchmarkManifest(evidence.manifest, evidence.binding, publicKey, generatorDigest), 'native skill manifest signature or freeze binding rejected')
  const seen = new Map(evidence.observations.map(value => [value.cellId, value.armDigest]))
  benchmarkAssert(seen.size === evidence.observations.length && verifyHoldoutReceipt(evidence.receipt, evidence.manifest.begin, seen, publicKey), 'native skill final receipt rejected')
  benchmarkAssert(evidence.binding.budgetDigest === acceptanceDigest({ config: evidence.config, sourceDigest: evidence.sourceDigest, runtimeDigest: evidence.runtimeDigest, trainingDigest: trainingDigest(evidence.training) })
    && same(evidence.plan, nativeSkillJournalPlan(evidence.config, evidence.binding, evidence.manifest, evidence.runtimeDigest)), 'native skill report frozen configuration drift')
  const schedule = benchmarkSchedule(evidence.plan)
  benchmarkAssert(schedule.length === evidence.manifest.cells.length && evidence.plan.dataset.digest === evidence.manifest.begin.datasetDigest, 'native skill report plan drift')
  const observations = new Map(evidence.observations.map(value => [value.cellId, value]))
  benchmarkAssert(evidence.receipt.cellVerdicts.every((verdict, index) => {
    const planned = evidence.manifest.cells[index], cell = schedule[index], observation = observations.get(verdict.cellId)
    return planned && cell && same(planned, { cellId: verdict.cellId, armDigest: verdict.armDigest, caseId: verdict.caseId, kind: verdict.kind, repeat: verdict.repeat })
      && cell.caseId === verdict.caseId && cell.repeat + 1 === verdict.repeat
      && verdict.armDigest === (cell.variantId === 'candidate' ? evidence.binding.candidateDigest : evidence.binding.baselineDigest)
      && (observation ? verdict.observationDigest === acceptanceDigest(observation) : verdict.verdict === 'unknown' && verdict.observationDigest === undefined)
  }), 'native skill receipt observation or cell mapping drift')
  benchmarkAssert(evidence.receipt.observationDigest === acceptanceDigest(evidence.receipt.cellVerdicts.map(value => ({ cellId: value.cellId, observationDigest: value.observationDigest ?? null, verdict: value.verdict }))), 'native skill receipt aggregate drift')
  const results = evidence.executionResults.map(result => {
    const index = schedule.findIndex(cell => cell.id === result.cell.id)
    benchmarkAssert(index >= 0 && result.verdict === 'unknown', 'native skill ledger must remain provisional')
    if (result.status === 'completed') {
      const native = evidence.nativeResults.find(value => value.cellId === result.cell.id)?.value
      const observation = observations.get(evidence.manifest.cells[index]!.cellId)
      benchmarkAssert(native && observation && result.evidenceDigest === acceptanceDigest({ native, observation }) && observation.quiescent && observation.status !== 'unknown', 'native skill execution evidence drift')
      benchmarkAssert(['inputTokens', 'outputTokens', 'costUsdMicros', 'toolCalls'].every(key => result.metrics[key as keyof typeof result.metrics] === native.meter[key as keyof typeof native.meter]), 'native skill metrics drift')
    }
    return { ...result, verdict: result.status === 'completed' ? evidence.receipt.cellVerdicts[index]!.verdict : 'unknown' as const }
  })
  const report = benchmarkReport(evidence.plan, results)
  return { ...report, complete: report.complete && evidence.receipt.complete && results.every(value => value.status === 'completed' && value.verdict !== 'unknown') }
}

/** Caller keeps the genuine source runtime alive through the last cell. */
export async function runNativeSkillBenchmark(input: NativeSkillBenchmarkConfig, captured: NativeCapturedSkill, factory: NativeAdapterFactory, signal: AbortSignal) {
  const config = benchmarkSnapshot(input)
  signal.throwIfAborted(); benchmarkInteger(config.repeats, 2, 4); benchmarkInteger(config.seed, 0, 0xffffffff)
  benchmarkInteger(config.expiresAt, Date.now() + 1, captured.snapshot.expiresAt)
  benchmarkAssert(same({ model: config.model, budget: config.budget, execution: config.execution, persona: config.persona, task: config.task },
    { model: captured.origin.model, budget: captured.origin.budget, execution: captured.origin.execution, persona: captured.origin.persona, task: captured.origin.task }), 'native skill source and comparison contract drift')
  benchmarkInteger(config.verification.maxDurationMs, 1, 300000); benchmarkInteger(config.verification.maxOutputBytes, 1, 262144)
  benchmarkAssert(typeof config.verification.command === 'string' && config.verification.command.length > 0 && config.verification.command.length <= 16384, 'native skill verifier command invalid')
  benchmarkAssert(config.model.observationMode !== 'observed-call-count', 'native skill comparison requires measured tokens')
  benchmarkAssert(config.budget.toolCalls <= 32 && config.verification.maxDurationMs < config.budget.durationMs, 'native skill holdout bounds exceed cell budget')
  privateRoot(config.stateRoot); privateRoot(config.workspaceRoot); privateRoot(join(config.stateRoot, 'runtimes'))
  separate(config.stateRoot, config.workspaceRoot); separate(config.stateRoot, captured.selection.scope.workspace)
  const runtimeDigest = nativeSkillRuntimeIdentity(config.model.provider)
  const current = await captured.source.inspectOwnerBenchmarkArm(captured.selection, signal)
  benchmarkAssert(same(current, captured.snapshot), 'captured native skill source changed')
  const binding: QualificationBinding = { scopeDigest: acceptanceDigest(captured.selection.scope), baselineDigest: acceptanceDigest({ protocol: nativeSkillBenchmarkProtocol, skill: null }),
    candidateDigest: captured.snapshot.definitionDigest, budgetDigest: acceptanceDigest({ config, sourceDigest: captured.snapshot.sourceDigest, runtimeDigest, trainingDigest: trainingDigest(captured.origin) }), expiresAt: config.expiresAt, repeats: config.repeats }
  // Existing authority durably freezes this binding before generating any private task.
  const skillsModule = '@dsh-enhanced/assistant-skills', authorityModule = '@dsh-enhanced/assistant-skills/holdout-authority', isolationModule = '@dsh-enhanced/assistant-isolation'
  const { openHoldoutProcess } = await import(skillsModule)
  const { verifyProspectiveBenchmarkManifest, verifyHoldoutSignature } = await import(authorityModule)
  const { IsolatedVerifierRunner } = await import(isolationModule)
  const lifetime = new AbortController(), active = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(Math.min(2147483647, config.expiresAt - Date.now()))])
  save(config.stateRoot, 'admission', { protocol: nativeSkillBenchmarkProtocol, config, binding, runtimeDigest, source: { selection: captured.selection, snapshot: captured.snapshot, origin: captured.origin } })
  const authority = await openHoldoutProcess(config.authority, active)
  let store: BenchmarkStore | undefined, verifier: { run(key: string, artifact: string, stdin: string, signal: AbortSignal): Promise<{ status: string; quiescent: boolean; stdout: string; exitCode?: number }>; close(): Promise<void> } | undefined
  let control: NativeSkillGoalControl | undefined, pending: Promise<unknown> | undefined
  const observations: CellObservation[] = []
  const runtimeResults: Array<{ cellId: string; value: NativeSkillGoalResult }> = []
  try {
    const begin = await authority.transport.request('begin', binding, active)
    const manifest = await authority.transport.request('manifest', undefined, active) as ProspectiveBenchmarkManifest
    benchmarkAssert(verifyProspectiveBenchmarkManifest(manifest, binding, config.authority.publicKey, config.authority.generatorDigest) && same(begin, manifest.begin), 'prospective manifest or begin rejected')
    benchmarkAssert(manifest.begin.limits.maxToolCalls === config.budget.toolCalls && manifest.begin.limits.maxOutputBytes === config.verification.maxOutputBytes, 'authority limits differ from frozen budget')
    const plan = nativeSkillJournalPlan(config, binding, manifest, runtimeDigest), planDigest = benchmarkPlanDigest(plan), schedule = benchmarkSchedule(plan)
    save(config.stateRoot, 'manifest', { binding, manifest, plan, runtimeDigest })
    store = new BenchmarkStore(join(config.stateRoot, 'benchmark.sqlite')); store.create(plan)
    benchmarkAssert(store.status(plan.id).runningCell === null && store.results(plan.id).length === 0, 'native skill benchmark cannot re-dispatch an existing run')
    verifier = new IsolatedVerifierRunner({ stateRoot: join(config.stateRoot, 'verification'), image: config.image, dockerPath: config.dockerPath, authorityDigest: acceptanceDigest(binding),
      command: config.verification.command, expiresAt: config.expiresAt, maxRuns: schedule.length, maxTotalDurationMs: schedule.length * config.verification.maxDurationMs,
      maxDurationMs: config.verification.maxDurationMs, maxOutputBytes: config.verification.maxOutputBytes })
    const executor: BenchmarkExecutor = { execute(request) {
      pending = (async () => {
        active.throwIfAborted(); benchmarkAssert(nativeSkillRuntimeIdentity(config.model.provider) === runtimeDigest, 'native skill deployed runtime changed')
        const index = schedule.findIndex(cell => cell.id === request.cell.id), expected = manifest.cells[index]!
        const signed = await authority.transport.request('next', undefined, request.signal) as SignedCell
        benchmarkAssert(signed && verifyHoldoutSignature(signed, config.authority.publicKey) && signed.sessionId === manifest.begin.sessionId && signed.planDigest === manifest.begin.planDigest
          && signed.cellId === expected.cellId && signed.armDigest === expected.armDigest && typeof signed.stdin === 'string' && bytesDigest(signed.stdin) === request.task.inputDigest, 'native skill signed input drift')
        const workspace = join(config.workspaceRoot, request.cell.id); privateRoot(workspace)
        const runtime = await createNativeSkillGoalRuntime({ cellId: request.cell.id, workspace, stateRoot: join(config.stateRoot, 'runtimes'), persona: config.persona, model: config.model,
          budget: config.budget, execution: config.execution, task: config.task, image: config.image, dockerPath: config.dockerPath, stepMaxDurationMs: config.stepMaxDurationMs,
          ...(config.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: config.stopTimeoutMs }), factory, signal: request.signal, lifecycle(value) { control = value },
          ...(request.cell.variantId === 'candidate' ? { arm: { captured, planDigest, variantId: 'candidate' } } : {}) })
        let value: NativeSkillGoalResult, artifact: { content: string; sha256: string }
        try { value = await runtime.execute(); artifact = runtime.readAcceptedArtifact() } finally { await runtime.close() }
        benchmarkAssert(runtime.snapshot().cleanup === 'succeeded', 'native skill cell did not quiesce')
        const observed = await verifier!.run(`${manifest.begin.sessionId}:${signed.cellId}`, artifact.content, signed.stdin, request.signal)
        const observation: CellObservation = { cellId: signed.cellId, armDigest: signed.armDigest, stdout: observed.stdout, exitCode: observed.exitCode ?? null, quiescent: observed.quiescent,
          status: observed.status === 'succeeded' ? 'completed' : observed.status === 'failed' ? 'failed' : 'unknown', artifactDigest: artifact.sha256, toolCalls: value.toolCalls }
        save(config.stateRoot, `cell-${request.cell.id}`, { native: value, observation, artifactDigest: artifact.sha256 })
        observations.push(observation); runtimeResults.push({ cellId: request.cell.id, value })
        await authority.transport.request('record', observation, request.signal)
        // Unsigned record responses never become quality evidence. Only finish can do that.
        return { versions: request.variant.versions, inputDigest: request.task.inputDigest, acceptanceDigest: request.task.acceptanceDigest, verdict: 'unknown' as const,
          metrics: { inputTokens: value.meter.inputTokens, outputTokens: value.meter.outputTokens, costUsdMicros: value.meter.costUsdMicros, toolCalls: value.meter.toolCalls, rework: null, interventions: null, latencyMs: null },
          evidenceDigest: acceptanceDigest({ native: value, observation }), quiescent: observed.quiescent && observation.status !== 'unknown' }
      })()
      return pending as ReturnType<BenchmarkExecutor['execute']>
    } }
    const executionResults = await runBenchmark(store, plan, executor, active)
    // runBenchmark may stop waiting after a deadline; drain that exact cell before authority finish.
    if (control) await control.close()
    if (pending) await pending.catch(() => {})
    const receipt = await authority.transport.request('finish', undefined, active) as HoldoutReceipt
    const evidence: NativeSkillBenchmarkEvidence = { protocol: nativeSkillBenchmarkProtocol, binding, config, runtimeDigest, sourceDigest: captured.snapshot.sourceDigest, training: captured.origin, nativeResults: runtimeResults, manifest, plan, receipt, executionResults, observations }
    const report = await nativeSkillBenchmarkReport(evidence, config.authority.publicKey, config.authority.generatorDigest)
    save(config.stateRoot, 'completion', evidence)
    return { report, receipt, plan, training: captured.origin.result.meter, reuse: runtimeResults.filter(value => value.value.skillRuns.some(run => run.state === 'succeeded' && run.delegationDigest === acceptanceDigest(value.value.delegation))).map(value => value.cellId), promotionAuthorized: false as const }
  } finally {
    lifetime.abort()
    const closed = await Promise.allSettled([control?.close(), verifier?.close(), authority.close()])
    store?.close()
    benchmarkAssert(closed.every(value => value.status === 'fulfilled'), 'native skill comparison cleanup unconfirmed')
  }
}
