import { mkdirSync, lstatSync, realpathSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalScope } from '@dsh-enhanced/assistant-goals'
import type { IsolatedVerifierRunner } from '@dsh-enhanced/assistant-isolation'
import type { BenchmarkObservation, BenchmarkPlan } from '@dsh-enhanced/assistant-evaluation/benchmark'
import type { SkillDefinition } from './definition.js'
import { instantiate } from './definition.js'
import { replaySkill } from './replay.js'

export interface SkillComparisonProfile {
  id: string
  version: number
  scope: GoalScope
  stateRoot: string
  image: string
  dockerPath: string
  command: string
  artifactPath: string
  expiresAt: number
  maxComparisons: number
  repeats: number
  cellDurationMs: number
  verificationDurationMs: number
  maxToolCalls: number
  maxBytes: number
  maxOutputBytes: number
  minimumEvaluationGain: number
  cases: readonly {
    id: string
    kind: 'replay' | 'evaluation' | 'regression'
    inputs: Readonly<Record<string, unknown>>
    files: readonly { path: string; content: string }[]
    stdin: string
    expectedStdout: string
    expectedExitCode: number
  }[]
}
function integer(value: unknown, min: number, max: number): boolean { return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max }
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(value) }
function inside(parent: string, child: string): boolean { const path = relative(parent, child); return !path || !path.startsWith('..') && !isAbsolute(path) }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
export function validateComparisonProfiles(value: unknown): readonly SkillComparisonProfile[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('assistant-skills: invalid comparison profiles')
  const ids = new Set<string>()
  const result = value.map(raw => {
    if (!plain(raw)) throw new Error('assistant-skills: invalid comparison profile')
    const p = JSON.parse(JSON.stringify(raw)) as SkillComparisonProfile
    if (!safeId(p.id) || ids.has(p.id) || !integer(p.version, 1, 1000000) || !plain(p.scope)
      || !['principalId', 'principalRecordId', 'workspace', 'preset'].every(key => typeof (p.scope as unknown as Record<string, unknown>)[key] === 'string' && String((p.scope as unknown as Record<string, unknown>)[key]).length > 0)
      || !integer(p.scope.principalVersion, 1, 1000000000) || !isAbsolute(p.scope.workspace)
      || typeof p.stateRoot !== 'string' || !isAbsolute(p.stateRoot) || inside(p.scope.workspace, p.stateRoot) || inside(p.stateRoot, p.scope.workspace)
      || typeof p.image !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(p.image) || typeof p.dockerPath !== 'string' || !isAbsolute(p.dockerPath)
      || typeof p.command !== 'string' || !p.command || p.command.length > 16384
      || typeof p.artifactPath !== 'string' || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(p.artifactPath) || p.artifactPath.split('/').some(part => part === '.' || part === '..')
      || !integer(p.expiresAt, 1, Number.MAX_SAFE_INTEGER) || !integer(p.maxComparisons, 1, 100) || !integer(p.repeats, 2, 4)
      || !integer(p.cellDurationMs, 1000, 300000) || !integer(p.verificationDurationMs, 1, 300000) || p.verificationDurationMs >= p.cellDurationMs
      || !integer(p.maxToolCalls, 1, 32) || !integer(p.maxBytes, 1, 262144) || !integer(p.maxOutputBytes, 1, 262144)
      || typeof p.minimumEvaluationGain !== 'number' || !Number.isFinite(p.minimumEvaluationGain) || p.minimumEvaluationGain <= 0 || p.minimumEvaluationGain > 1
      || !Array.isArray(p.cases) || p.cases.length < 3 || p.cases.length > 12) throw new Error('assistant-skills: invalid comparison profile')
    const caseIds = new Set<string>()
    for (const entry of p.cases) {
      if (!plain(entry) || !safeId(entry.id) || caseIds.has(entry.id) || typeof entry.kind !== 'string' || !['replay', 'evaluation', 'regression'].includes(entry.kind)
        || !plain(entry.inputs) || !Array.isArray(entry.files) || entry.files.length > 64
        || entry.files.some(file => !plain(file) || typeof file.path !== 'string' || typeof file.content !== 'string')
        || typeof entry.stdin !== 'string' || typeof entry.expectedStdout !== 'string' || !integer(entry.expectedExitCode, 0, 255)
        || Buffer.byteLength(JSON.stringify(entry)) > p.maxBytes) throw new Error('assistant-skills: invalid comparison case')
      caseIds.add(entry.id)
    }
    if (!['replay', 'evaluation', 'regression'].every(kind => p.cases.some(entry => entry.kind === kind))
      || p.maxComparisons * p.cases.length * p.repeats * 2 * p.verificationDurationMs > 86400000) throw new Error('assistant-skills: incomplete or unbounded comparison suite')
    ids.add(p.id); return p
  })
  return result
}
function privateRoot(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('assistant-skills: comparison requires a private owned root')
}
const require = createRequire(import.meta.url)
const codeDigest = acceptanceDigest([readFileSync(new URL(import.meta.url), 'utf8'), readFileSync(new URL(import.meta.url.endsWith('.ts') ? './replay.ts' : './replay.js', import.meta.url), 'utf8')])
function runtimeDigest(): string {
  const packages = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-tool-fs', '@dsh-enhanced/assistant-isolation', '@dsh-enhanced/assistant-evaluation']
  return acceptanceDigest({ protocol: 'assistant-skills/comparison/v1', codeDigest, packages: Object.fromEntries(packages.map(name => [name, (require(`${name}/package.json`) as { version: string }).version])) })
}
/** Host coordinator: fixed native file-tool replay, separate isolated artifact execution, Host-side judge. */
export class SkillComparator {
  readonly #profile: SkillComparisonProfile
  readonly #runner: Promise<IsolatedVerifierRunner>
  readonly #pending = new Set<Promise<unknown>>()
  readonly #abort = new AbortController()
  readonly #runtime: string
  constructor(profile: SkillComparisonProfile) {
    this.#profile = validateComparisonProfiles([profile])[0]!
    privateRoot(this.#profile.stateRoot)
    this.#runtime = runtimeDigest()
    const p = this.#profile, count = p.maxComparisons * p.cases.length * p.repeats * 2
    this.#runner = import('@dsh-enhanced/assistant-isolation').then(({ IsolatedVerifierRunner }) => new IsolatedVerifierRunner({ stateRoot: join(p.stateRoot, 'verification'), image: p.image, dockerPath: p.dockerPath,
      authorityDigest: acceptanceDigest(p), command: p.command, expiresAt: p.expiresAt, maxRuns: count,
      maxTotalDurationMs: count * p.verificationDurationMs, maxDurationMs: p.verificationDurationMs, maxOutputBytes: p.maxOutputBytes }))
    void this.#runner.catch(() => {})
  }
  async compare(id: string, baseline: SkillDefinition, candidate: SkillDefinition, signal: AbortSignal, authorize: () => void) {
    const p = this.#profile
    const { BenchmarkStore, benchmarkReport, parseBenchmarkPlan, runBenchmark } = await import('@dsh-enhanced/assistant-evaluation/benchmark')
    const runner = await this.#runner
    // Clone definitions and materialize every parameter set before any execution.
    const arms = JSON.parse(JSON.stringify({ baseline, candidate })) as { baseline: SkillDefinition; candidate: SkillDefinition }
    for (const arm of Object.values(arms)) for (const entry of p.cases) {
      const definition = instantiate(arm, entry.inputs)
      if (definition.steps.length > p.maxToolCalls || definition.steps.some(step => !['read', 'write', 'edit'].includes(step.toolName))) throw new Error('assistant-skills: incomparable tool trace')
    }
    const local = new AbortController(), combined = AbortSignal.any([signal, this.#abort.signal, local.signal])
    const revalidate = () => { combined.throwIfAborted(); if (Date.now() >= p.expiresAt) throw new Error('assistant-skills: comparison expired'); authorize() }
    const root = join(p.stateRoot, id)
    privateRoot(root)
    const common = { model: acceptanceDigest('no-model-fixed-tool-replay'), prompt: acceptanceDigest('no-prompt'), tools: acceptanceDigest(['read', 'write', 'edit']), policy: acceptanceDigest({ maxBytes: p.maxBytes, maxToolCalls: p.maxToolCalls, offline: true }), runtime: this.#runtime }
    const plan: BenchmarkPlan = parseBenchmarkPlan({ schemaVersion: 1, id,
      dataset: { id: p.id, version: String(p.version), digest: acceptanceDigest(p), split: 'development' }, comparison: 'capability',
      cases: p.cases.map(entry => ({ id: entry.id, domain: 'code', inputDigest: acceptanceDigest({ inputs: entry.inputs, files: entry.files, stdin: entry.stdin }), acceptanceDigest: acceptanceDigest({ command: p.command, artifactPath: p.artifactPath, expectedStdout: entry.expectedStdout, expectedExitCode: entry.expectedExitCode }) })),
      variants: (['baseline', 'candidate'] as const).map(role => ({ id: role, role, versions: { ...common, skills: acceptanceDigest(arms[role]) }, features: { memory: false, planning: false, review: false, growth: false } })),
      budget: { durationMs: p.cellDurationMs, toolCalls: p.maxToolCalls, inputTokens: 0, outputTokens: 0, costUsdMicros: 0 }, repeats: p.repeats, seed: 0 })
    const store = new BenchmarkStore(join(root, 'benchmark.sqlite'))
    const cells: { id: string; artifactDigest: string; jobId: string; verdict: string; quiescent: boolean; toolCalls: number }[] = []
    const active = new Set<Promise<BenchmarkObservation>>()
    const timer = setInterval(() => { try { revalidate() } catch { local.abort() } }, 100); timer.unref()
    const operation = (async () => {
      try {
        const results = await runBenchmark(store, plan, { execute: request => {
          const execute = (async (): Promise<BenchmarkObservation> => {
            revalidate()
            const entry = p.cases.find(value => value.id === request.cell.caseId)!
            const arm = arms[request.variant.id as keyof typeof arms]
            const cellSignal = AbortSignal.any([combined, request.signal])
            const replay = await replaySkill({ definition: arm, inputs: entry.inputs, files: entry.files, artifactPath: p.artifactPath, stateRoot: root,
              maxToolCalls: p.maxToolCalls, maxBytes: p.maxBytes, signal: cellSignal, authorize: revalidate })
            revalidate()
            const observed = await runner.run(`${id}:${request.cell.id}`, replay.artifact, entry.stdin, cellSignal)
            revalidate()
            const verdict = !observed.quiescent || observed.status === 'unknown' || observed.status === 'cancelled' || observed.status === 'timed-out' ? 'unknown'
              : observed.exitCode !== undefined && observed.exitCode === entry.expectedExitCode && observed.stdout === entry.expectedStdout ? 'achieved' : 'not-achieved'
            const evidence = { id: request.cell.id, artifactDigest: acceptanceDigest(replay.artifact), jobId: observed.jobId, verdict, quiescent: observed.quiescent, toolCalls: replay.toolCalls }
            cells.push(evidence)
            return { versions: { ...common, skills: acceptanceDigest(arm) }, inputDigest: request.task.inputDigest, acceptanceDigest: request.task.acceptanceDigest,
              verdict, metrics: { inputTokens: 0, outputTokens: 0, costUsdMicros: 0, toolCalls: replay.toolCalls, rework: 0, interventions: 0, latencyMs: null },
              evidenceDigest: acceptanceDigest({ evidence, steps: replay.steps, observed }), quiescent: observed.quiescent }
          })()
          active.add(execute); void execute.finally(() => active.delete(execute)).catch(() => {})
          return execute
        } }, combined)
        // Benchmark timeout does not establish teardown. Retain ownership until every worker settles.
        local.abort(); await Promise.allSettled(active)
        const report = benchmarkReport(plan, results)
        const complete = report.complete && results.every(result => result.status === 'completed' && result.verdict !== 'unknown')
        const selected = (kind: string, role: string) => results.filter(result => result.cell.variantId === role && p.cases.some(entry => entry.id === result.cell.caseId && entry.kind === kind))
        const rate = (kind: string, role: string) => { const values = selected(kind, role); return values.length ? values.filter(value => value.verdict === 'achieved').length / values.length : 0 }
        const evaluationGain = complete ? rate('evaluation', 'candidate') - rate('evaluation', 'baseline') : null
        return { protocol: 'assistant-skills/comparison/v1', profileId: p.id, profileDigest: acceptanceDigest(p), baselineDigest: acceptanceDigest(baseline), candidateDigest: acceptanceDigest(candidate),
          report, cells, quality: { candidateChecksPassed: complete && results.filter(result => result.cell.variantId === 'candidate').every(result => result.verdict === 'achieved'),
            evaluationGain, evaluationGainObserved: evaluationGain !== null && evaluationGain >= p.minimumEvaluationGain,
            criticalRegressionsPassed: complete && selected('regression', 'candidate').every(result => result.verdict === 'achieved'), heldoutIndependence: 'unproven' },
          promotionAuthorized: false, execution: 'native-file-tools-and-isolated-artifact', modelCalls: 0 }
      } finally { clearInterval(timer); local.abort(); await Promise.allSettled(active); store.close() }
    })()
    this.#pending.add(operation)
    try { return await operation } finally { this.#pending.delete(operation) }
  }
  async close(): Promise<void> { this.#abort.abort(); await Promise.allSettled(this.#pending); await (await this.#runner).close() }
}
