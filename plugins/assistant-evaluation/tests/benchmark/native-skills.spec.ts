import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createNativeSkillGoalRuntime, runNativeSkillBenchmark, nativeSkillBenchmarkReport, type NativeSkillBenchmarkConfig, type NativeSkillBenchmarkEvidence } from '../../src/benchmark/native-skills.js'
import type { NativeAdapterFactory } from '../../src/benchmark/native.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const program = `const fs=require('fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(x.template.replace(/\\{\\{([a-z][a-z0-9_]*)\\}\\}/g,(p,k)=>Object.hasOwn(x.values,k)?x.values[k]:p)+'\\n');`
const task = { objective: 'Build a literal, non-recursive template renderer.', publicPrompt: 'Build a literal, non-recursive template renderer. Read a JSON object containing template and values from stdin. Replace known {{ascii_key}} placeholders once, preserve unknown placeholders, append newline. Export answer.js using isolation grant benchmark-work; run in a native Goal.', artifactPath: 'answer.js',
  verification: { command: 'node artifact < input', cases: [{ stdin: '{"template":"{{name}} {{missing}}","values":{"name":"smoke"}}', expectedStdout: 'smoke {{missing}}\n', expectedExitCode: 0 }], maxDurationMs: 5000, maxOutputBytes: 4096 } }
const model = { provider: 'skill-fixture', model: 'fixed', maxOutputTokens: 128, temperature: null, inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) }
class Adapter extends LlmAdapter {
  calls = 0; ran = false
  constructor(readonly ctx: Context, readonly messages: string[]) { super() }
  override providerInfo(id: string) { return { id, name: id } }
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text' as const] } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++; this.messages.push(JSON.stringify(options.messages))
    const agent = this.ctx.agents.currentInitiator()!
    const native = (this.ctx.get('goals' as never) as unknown as { get(agent: unknown): { roundsStarted: number } | undefined }).get(agent)
    const business = this.ctx.get('assistantGoals' as never) as unknown as { list(agent: unknown): { id: string }[] }
    let name: string | undefined, args: object = {}
    if (!native) { name = 'goal_create'; args = { objective: task.objective, max_goal_rounds: 2 } }
    else if (native.roundsStarted > 0 && !this.ran) {
      this.ran = true
      if (options.tools?.some(value => value.name === 'skill_run')) { name = 'skill_run'; args = { goal_id: business.list(agent)[0]!.id, name: 'render-template', version: 1, inputs_json: '{}', invocation_id: 'reuse' } }
      else { name = 'isolation_run'; args = { grant_id: 'benchmark-work', idempotency_key: 'artifact', command: 'cp source answer.js', files: [{ path: 'source', content: program }], artifacts: ['answer.js'], timeout_ms: 15000 } }
    }
    if (name) {
      const id = ToolCallId(`call-${this.calls}`), json = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }; yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
    } else { const text = 'Ready for independent verification.'; yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }; yield { type: 'finish', reason: { kind: name ? 'tool-calls' : 'stop' } }
  }
}

test.skipIf(!process.env.DSH_ISOLATION_TEST_IMAGE)('runs native baseline/candidate Goals against after-freeze signed tasks and rechecks final evidence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-skill-benchmark-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const sourceWorkspace = join(root, 'source-workspace'); await mkdir(sourceWorkspace, { mode: 0o700 }); await mkdir(join(root, 'source-state'), { mode: 0o700 })
  const authorityRoot = join(root, 'authority'); await mkdir(authorityRoot, { mode: 0o700 })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  await writeFile(join(authorityRoot, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const authorityConfig = join(authorityRoot, 'config.json'), cli = resolve('../assistant-skills/lib/holdout-cli.js')
  await writeFile(authorityConfig, JSON.stringify({ prospective: { generator: 'template-render/v1' }, privateKeyPath: join(authorityRoot, 'key.pem'), statePath: join(authorityRoot, 'state.sqlite'), limits: { maxToolCalls: 12, maxOutputBytes: 4096 } }), { mode: 0o600 })
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--inspect-config', authorityConfig])
  const pins = JSON.parse(stdout) as { generatorDigest: string }
  const common = { task, model, persona: 'Solve the public program specification using a native Goal and the allowed tools.', budget: { durationMs: 100000, inputTokens: 1000, outputTokens: 2048, toolCalls: 12, costUsdMicros: null },
    execution: { modelCalls: 16, maxOutputTokensPerCall: 128, maxGoalRounds: 2 }, image: process.env.DSH_ISOLATION_TEST_IMAGE!, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 25000 }
  const messages: string[] = [], factory: NativeAdapterFactory = (_model, { ctx }) => ({ adapter: new Adapter(ctx, messages), inputTokenUpperBound: () => 10, dispose() {} })
  const signal = new AbortController().signal
  const source = await createNativeSkillGoalRuntime({ ...common, cellId: 'source', workspace: sourceWorkspace, stateRoot: join(root, 'source-state'), factory, signal, source: { name: 'render-template', description: 'Render literal template placeholders.', validityMs: 600000 } })
  cleanups.push(source.close); await source.execute(); const captured = await source.captureVerifiedSkill()
  const config: NativeSkillBenchmarkConfig = { ...common, id: 'native-template-reuse', stateRoot: join(root, 'comparison'), workspaceRoot: join(root, 'cells'), repeats: 2, seed: 7, expiresAt: Date.now() + 300000,
    authority: { executable: process.execPath, args: [cli, '--config', authorityConfig], publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest: pins.generatorDigest }, verification: { command: 'node artifact < input', maxDurationMs: 5000, maxOutputBytes: 4096 } }
  const result = await runNativeSkillBenchmark(config, captured, factory, signal)
  expect(result.report.complete).toBe(true); expect(result.receipt.complete).toBe(true)
  expect(result.report.variants.map(value => value.achieved)).toEqual([6, 6]); expect(result.reuse).toHaveLength(6)
  expect(result.report.comparisons[0]).toMatchObject({ wins: 0, losses: 0, ties: 6, successRateDelta: 0 })
  expect(result.training.inputTokens).toBeGreaterThan(0)
  expect(result.promotionAuthorized).toBe(false)
  expect(messages.join('\n')).not.toContain(authorityRoot)
  expect(messages.join('\n')).not.toContain(task.verification.cases[0]!.stdin)
  expect(messages.join('\n')).not.toMatch(/r-[a-f0-9]{16}/u)
  const evidence = JSON.parse(await readFile(join(config.stateRoot, 'completion.json'), 'utf8')) as NativeSkillBenchmarkEvidence
  expect(evidence.executionResults.every(value => value.verdict === 'unknown')).toBe(true)
  expect(await nativeSkillBenchmarkReport(evidence, config.authority.publicKey, pins.generatorDigest)).toEqual(result.report)
  const tampered = { ...structuredClone(evidence), observations: evidence.observations.map((value, index) => index === 0 ? { ...value, stdout: 'invented' } : value) }
  await expect(nativeSkillBenchmarkReport(tampered, config.authority.publicKey, pins.generatorDigest)).rejects.toThrow('observation')
  const wrongMetrics = structuredClone(evidence); wrongMetrics.executionResults[0]!.metrics.inputTokens = 0
  await expect(nativeSkillBenchmarkReport(wrongMetrics, config.authority.publicKey, pins.generatorDigest)).rejects.toThrow('metrics')
  const wrongBudget = structuredClone(evidence); wrongBudget.plan.budget.outputTokens++
  await expect(nativeSkillBenchmarkReport(wrongBudget, config.authority.publicKey, pins.generatorDigest)).rejects.toThrow('configuration')
  const wrongTraining = structuredClone(evidence); wrongTraining.training.result.meter = { ...wrongTraining.training.result.meter, inputTokens: 0 }
  await expect(nativeSkillBenchmarkReport(wrongTraining, config.authority.publicKey, pins.generatorDigest)).rejects.toThrow('configuration')
  const uncertain = structuredClone(evidence)
  uncertain.executionResults[0]!.status = 'unknown'; uncertain.executionResults[0]!.reason = 'adapter-error'
  const uncertainReport = await nativeSkillBenchmarkReport(uncertain, config.authority.publicKey, pins.generatorDigest)
  expect(uncertainReport.complete).toBe(false)
  expect(uncertainReport.comparisons[0]!.successRateDelta).toBeNull()
  const calls = messages.length
  await expect(runNativeSkillBenchmark(config, captured, factory, signal)).rejects.toThrow()
  expect(messages).toHaveLength(calls)
  expect(acceptanceDigest(result.plan)).toBe(result.report.planDigest)
}, 180000)
