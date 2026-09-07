import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { developmentCorpus, developmentDataset } from './corpus.js'
import { memoryDevelopmentCorpus, memoryDevelopmentDataset, memoryDevelopmentCorpusV2, memoryDevelopmentDatasetV2 } from './memory-corpus.js'
import { benchmarkReport } from './report.js'
import { benchmarkPlanDigest, benchmarkSchedule, BenchmarkError } from './schema.js'
import { BenchmarkStore } from './store.js'
import { runBenchmark } from './runner.js'
import type { NativeAdapterFactory, NativeBenchmarkConfig } from './native.js'

const runtimePackages = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools'] as const
const help = `dsh-benchmark: public development benchmarks through the native DSH AgentLoop
  corpus [--suite research-v1|memory-v1|memory-v2]
  doctor [--suite research-v1|memory-v1|memory-v2]
  plan --config FILE [--output FILE]
  run --config FILE --adapter ABSOLUTE_MODULE --database FILE [--output FILE]
  report --database FILE --plan ID [--output FILE]

plan never invokes a model. run invokes the explicitly supplied trusted Host adapter.
The adapter module must export createNativeAdapter and match both configured SHA-256 digests.
Outputs are created exclusively (existing files are never overwritten).
No hidden holdout, credentials, or model-provider installation is created by these commands.
`

function options(args: readonly string[], allowed: readonly string[], required: readonly string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!; const value = args[index + 1]
    if (!allowed.includes(key) || result.has(key) || value === undefined || value.startsWith('--') || value.trim() === '') throw new BenchmarkError('invalid or duplicate benchmark argument')
    result.set(key, value)
  }
  if (required.some(key => !result.has(key))) throw new BenchmarkError('missing required benchmark argument; use --help')
  return result
}

async function boundedFile(path: string, limit: number): Promise<{ text: string; digest: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new BenchmarkError('benchmark input must be a bounded regular file')
    const bytes = Buffer.alloc(limit + 1)
    let total = 0
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    const after = await handle.stat()
    if (total > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new BenchmarkError('benchmark input changed while being read')
    const data = bytes.subarray(0, total)
    return { text: data.toString('utf8'), digest: createHash('sha256').update(data).digest('hex') }
  } finally { await handle.close() }
}

async function nativeModule(): Promise<typeof import('./native.js')> {
  try { return await import('./native.js') } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new BenchmarkError('native DSH runtime dependencies are missing; run dsh-benchmark doctor and install the reported host packages')
    }
    throw new BenchmarkError('native benchmark runtime could not be loaded')
  }
}

async function config(path: string): Promise<NativeBenchmarkConfig> {
  const file = await boundedFile(resolve(path), 131_072)
  try { return JSON.parse(file.text) as NativeBenchmarkConfig } catch { throw new BenchmarkError('benchmark config must be valid JSON') }
}

/** Loads only an operator-selected Host module, not code produced by a benchmark candidate. */
async function adapter(path: string, input: NativeBenchmarkConfig): Promise<NativeAdapterFactory> {
  if (!isAbsolute(path)) throw new BenchmarkError('adapter module path must be absolute')
  const captured = await boundedFile(path, 1_048_576)
  if (captured.digest !== input.model.adapterDigest || captured.digest !== input.model.tokenCounterDigest) throw new BenchmarkError('adapter module does not match frozen adapter/token-counter digests')
  // Digest and post-load check detect ordinary replacement; same-UID filesystem attacks and
  // transitive module imports are outside this trusted Host extension boundary.
  const imported: unknown = await import(`${pathToFileURL(path).href}?benchmark=${captured.digest}`)
  if ((await boundedFile(path, 1_048_576)).digest !== captured.digest) throw new BenchmarkError('adapter module changed during import')
  if (!imported || typeof imported !== 'object' || !('createNativeAdapter' in imported) || typeof imported.createNativeAdapter !== 'function') throw new BenchmarkError('adapter module must export createNativeAdapter')
  return imported.createNativeAdapter as NativeAdapterFactory
}

async function ensureNewOutput(path: string | undefined): Promise<void> {
  if (path === undefined) return
  try { await lstat(resolve(path)) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  throw new BenchmarkError('output path already exists; choose a new output file')
}

export interface BenchmarkCliOutput { stdout(text: string): void }

/** Returns an exit status; errors are intentionally reduced to non-sensitive diagnostics by the bin. */
export async function benchmarkCli(argv: readonly string[], io: BenchmarkCliOutput, signal?: AbortSignal): Promise<number> {
  const command = argv[0]
  if (command === undefined || command === '--help' || command === 'help') { io.stdout(help); return 0 }
  let result: unknown
  let output: string | undefined
  let exitCode = 0
  if (command === 'corpus') {
    const args = options(argv.slice(1), ['--suite'], [])
    const suite = args.get('--suite') ?? 'research-v1'
    if (!['research-v1', 'memory-v1', 'memory-v2'].includes(suite)) throw new BenchmarkError('invalid native suite')
    result = { dataset: suite === 'memory-v2' ? memoryDevelopmentDatasetV2 : suite === 'memory-v1' ? memoryDevelopmentDataset : developmentDataset, tasks: (suite === 'memory-v2' ? memoryDevelopmentCorpusV2 : suite === 'memory-v1' ? memoryDevelopmentCorpus : developmentCorpus).map(task => ({ id: task.id, domain: task.domain, objective: task.objective })) }
  } else if (command === 'doctor') {
    const args = options(argv.slice(1), ['--suite'], [])
    const suite = args.get('--suite') ?? 'research-v1'
    if (!['research-v1', 'memory-v1', 'memory-v2'].includes(suite)) throw new BenchmarkError('invalid native suite')
    const require = createRequire(import.meta.url)
    const names = [...runtimePackages, ...(suite !== 'research-v1' ? ['@dsh-enhanced/personal-memory', '@dsh-enhanced/assistant-policy'] : [])]
    const packages = names.map(name => {
      try { require.resolve(name); return { name, available: true } } catch { return { name, available: false } }
    })
    result = { ready: packages.every(entry => entry.available), packages, next: 'Configure a trusted adapter, model token counter and per-cell budget. A ready runtime does not prove model access.' }
    exitCode = packages.every(entry => entry.available) ? 0 : 2
  } else if (command === 'plan' || command === 'run') {
    const fields = options(argv.slice(1), ['--config', '--adapter', '--database', '--output'], command === 'run' ? ['--config', '--adapter', '--database'] : ['--config'])
    if (command === 'plan' && (fields.has('--adapter') || fields.has('--database'))) throw new BenchmarkError('plan accepts only --config and --output')
    output = fields.get('--output')
    await ensureNewOutput(output)
    const input = await config(fields.get('--config')!)
    const native = await nativeModule()
    const plan = native.nativeBenchmarkPlan(input)
    if (command === 'plan') {
      result = { plan, planDigest: benchmarkPlanDigest(plan), plannedCells: benchmarkSchedule(plan).length,
        maximumCostUsdMicros: plan.budget.costUsdMicros === null ? null : (BigInt(benchmarkSchedule(plan).length) * BigInt(plan.budget.costUsdMicros)).toString(),
        inputLimitMode: input.model.inputLimitMode ?? 'upper-bound', outputLimitMode: input.model.outputLimitMode ?? 'provider',
        maximumInputTokens: input.model.inputLimitMode === 'estimate' ? null : benchmarkSchedule(plan).length * plan.budget.inputTokens,
        maximumOutputTokens: input.model.outputLimitMode === 'observed' ? null : benchmarkSchedule(plan).length * plan.budget.outputTokens,
        observedInputTokenLimit: benchmarkSchedule(plan).length * plan.budget.inputTokens,
        observedOutputTokenLimit: benchmarkSchedule(plan).length * plan.budget.outputTokens }
    } else {
      const store = new BenchmarkStore(resolve(fields.get('--database')!))
      try {
        // Validate/freeze the plan before loading the Host adapter (which may initialize credentials).
        store.create(plan)
        const factory = await adapter(fields.get('--adapter')!, input)
        await runBenchmark(store, plan, native.createNativeBenchmarkExecutor(input, factory), signal)
        const report = benchmarkReport(plan, store.results(plan.id))
        result = report
        exitCode = report.complete && report.variants.every(variant => variant.unknown === 0) ? 0 : 2
      } finally { store.close() }
    }
  } else if (command === 'report') {
    const fields = options(argv.slice(1), ['--database', '--plan', '--output'], ['--database', '--plan'])
    output = fields.get('--output'); await ensureNewOutput(output)
    // Reporting must not silently create an empty database when the path is wrong.
    const database = resolve(fields.get('--database')!)
    if (!(await lstat(database)).isFile()) throw new BenchmarkError('report requires an existing regular database')
    const store = new BenchmarkStore(database)
    try { result = benchmarkReport(store.plan(fields.get('--plan')!), store.results(fields.get('--plan')!)) } finally { store.close() }
  } else throw new BenchmarkError('unknown benchmark command; use --help')
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (output === undefined) io.stdout(text)
  else { const path = resolve(output); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, text, { flag: 'wx', mode: 0o600 }) }
  return exitCode
}
