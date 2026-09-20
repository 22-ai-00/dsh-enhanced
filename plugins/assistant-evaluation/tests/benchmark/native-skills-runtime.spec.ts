import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { createNativeSkillGoalRuntime, type NativeSkillGoalOptions } from '../../src/benchmark/native-skills-runtime.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const task = { objective: 'Create a shell program that adds two integers from stdin.', publicPrompt: 'Create a shell program that adds two integers from stdin. Use goal_create with that exact objective and at most 2 rounds. Export answer.sh with isolation grant benchmark-work.', artifactPath: 'answer.sh',
  verification: { command: 'sh artifact < input', cases: [{ stdin: '19 23', expectedStdout: '42', expectedExitCode: 0 }], maxDurationMs: 5000, maxOutputBytes: 4096 } }
const model = { provider: 'skill-fixture', model: 'fixed', maxOutputTokens: 128, temperature: null,
  inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) }
async function options(cellId: string): Promise<Omit<NativeSkillGoalOptions, 'factory'>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-skill-cell-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), stateRoot = join(root, 'state')
  await mkdir(workspace, { mode: 0o700 }); await mkdir(stateRoot, { mode: 0o700 })
  return { cellId, workspace, stateRoot, task, model, persona: 'Solve the requested task through the native Goal and allowed tools.',
    budget: { durationMs: 100000, inputTokens: 1000, outputTokens: 2048, toolCalls: 12, costUsdMicros: null }, execution: { modelCalls: 16, maxOutputTokensPerCall: 128, maxGoalRounds: 2 },
    image: process.env.DSH_ISOLATION_TEST_IMAGE ?? `sha256:${'0'.repeat(64)}`, dockerPath: '/usr/bin/docker', stepMaxDurationMs: 25000, signal: new AbortController().signal }
}
class Adapter extends LlmAdapter {
  calls = 0; ran = false
  constructor(readonly ctx: Context, readonly reuse: boolean) { super() }
  override providerInfo(id: string) { return { id, name: id } }
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text' as const] } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    expect(JSON.stringify(options.messages)).not.toContain('19 23')
    const agent = this.ctx.agents.currentInitiator()!
    const native = (this.ctx.get('goals' as never) as unknown as { get(agent: unknown): { roundsStarted: number } | undefined }).get(agent)
    const business = this.ctx.get('assistantGoals' as never) as unknown as { list(agent: unknown): { id: string }[] }
    let name: string | undefined; let args: object = {}
    if (!native) { name = 'goal_create'; args = { objective: task.objective, max_goal_rounds: 2 } }
    else if (native.roundsStarted > 0 && !this.ran) {
      this.ran = true
      if (this.reuse) { name = 'skill_run'; args = { goal_id: business.list(agent)[0]!.id, name: 'add-integers', version: 1, inputs_json: '{}', invocation_id: 'one-reuse' } }
      else { name = 'isolation_run'; args = { grant_id: 'benchmark-work', idempotency_key: 'source-artifact', command: 'cp source answer.sh', files: [{ path: 'source', content: 'read a b; printf "%s" "$((a + b))"' }], artifacts: ['answer.sh'], timeout_ms: 15000 } }
    }
    if (name) {
      const id = ToolCallId(`call-${this.calls}`), json = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
    } else {
      const text = 'The program is ready for independent checks.'
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: name ? 'tool-calls' : 'stop' } }
  }
}
const factory = (reuse: boolean): NativeSkillGoalOptions['factory'] => (_model, { ctx }) => ({ adapter: new Adapter(ctx, reuse), inputTokenUpperBound: () => 10, dispose() {} })
const rawService = <T>(value: T): T => (value as T & { [key: symbol]: T })[Symbol.for('cordis.original')] ?? value

test.skipIf(!process.env.DSH_ISOLATION_TEST_IMAGE)('captures an independently achieved native source and reuses its exact skill in a fresh Goal', async () => {
  const source = await createNativeSkillGoalRuntime({ ...await options('source'), factory: factory(false), source: { name: 'add-integers', description: 'Create a reusable integer addition program.', validityMs: 600000 } })
  cleanups.push(source.close)
  const first = await source.execute()
  expect(first.snapshot).toMatchObject({ outcome: { status: 'achieved' } })
  expect(first.capabilities.every(value => !value.toolNames.includes('skill_run'))).toBe(true)
  const captured = await source.captureVerifiedSkill()
  expect(captured.selection).toMatchObject({ version: 1, skillName: 'add-integers' })
  expect(captured.selection.candidateId).toBeTypeOf('string')
  expect(captured.origin.model).toEqual(model)
  expect(captured.origin.result).toEqual(first)
  const candidate = await createNativeSkillGoalRuntime({ ...await options('candidate'), factory: factory(true), arm: { captured, planDigest: 'c'.repeat(64), variantId: 'candidate' } })
  cleanups.push(candidate.close)
  const second = await candidate.execute()
  expect(second.snapshot).toMatchObject({ outcome: { status: 'achieved' } })
  expect(second.capabilities.every(value => value.toolNames.includes('skill_run'))).toBe(true)
  expect(second.skillRuns).toHaveLength(1)
  expect(second.skillRuns[0]).toMatchObject({ state: 'succeeded', delegationDigest: acceptanceDigest(second.delegation) })
  expect(second.meter.inputTokens).toBeGreaterThan(0)
  expect(second.delegation!.sourceDigest).toBe(captured.snapshot.sourceDigest)
  expect(candidate.readAcceptedArtifact().content).toBe(source.readAcceptedArtifact().content)
  expect(second.toolCalls.map(call => call.name)).toContain('isolation_run')
  await candidate.close(); await source.close()
  expect(candidate.snapshot().cleanup).toBe('succeeded')
  expect(source.snapshot().cleanup).toBe('succeeded')
}, 120000)

test('rejects an invalid budget before starting an adapter factory', async () => {
  let factoryCalls = 0
  const input = await options('invalid-budget')
  await expect(createNativeSkillGoalRuntime({ ...input, budget: { ...input.budget, outputTokens: 0 }, factory: () => {
    factoryCalls++
    throw new Error('factory must not run')
  } })).rejects.toThrow('invalid benchmark integer')
  expect(factoryCalls).toBe(0)
})

test('preserves a capture admission failure without treating it as a cleanup failure', async () => {
  const source = await createNativeSkillGoalRuntime({ ...await options('capture-without-result'), factory: factory(false),
    source: { name: 'add-integers', description: 'Create an integer addition program.', validityMs: 600000 } })
  cleanups.push(source.close)
  await expect(source.captureVerifiedSkill()).rejects.toThrow('live accepted source runtime required')
  await expect(source.close()).resolves.toBeUndefined()
  expect(source.snapshot().cleanup).toBe('succeeded')
  expect(source.snapshot().meter?.modelCalls).toBe(0)
})

test.skipIf(!process.env.DSH_ISOLATION_TEST_IMAGE).each(['rejected', 'creation-failed', 'disposer-failed', 'late'] as const)('settles actual capture resources independently of the %s operation', async mode => {
  let context!: Context
  const source = await createNativeSkillGoalRuntime({ ...await options(`capture-${mode}`), stopTimeoutMs: 1000,
    factory: (selected, environment) => { context = environment.ctx; return factory(false)(selected, environment) },
    source: { name: 'add-integers', description: 'Create an integer addition program.', validityMs: 600000 } })
  cleanups.push(() => source.close().catch(() => {}))
  expect((await source.execute()).snapshot).toMatchObject({ outcome: { status: 'achieved' } })
  const calls = source.snapshot().meter!.modelCalls
  const skills = rawService(context.get('assistantSkills' as never)) as unknown as { stageOwnerVerifiedSuccessCandidate(): Promise<never> }
  const rejected = new Error('source evidence rejected')
  let started!: () => void, release!: () => void
  const begun = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  skills.stageOwnerVerifiedSuccessCandidate = async () => {
    started()
    if (mode === 'late') await held
    throw rejected
  }
  let captureId: string | undefined
  context.on('agent/created', ({ agent }) => { if (String(agent.session.id).startsWith('skill-capture-')) captureId = String(agent.id) })
  const registry = rawService(context.agents)
  if (mode === 'disposer-failed' || mode === 'creation-failed') {
    const create = registry.create
    registry.create = async function (options) {
      const handle = await create.call(this, options)
      if (mode === 'creation-failed') { await handle.dispose(); throw new Error('capture creation rejected') }
      return { ...handle, dispose: async () => { await handle.dispose(); throw new Error('capture disposer rejected') } }
    }
  }
  const capture = source.captureVerifiedSkill()
  // Observe immediately so deliberate delayed failures cannot become unhandled rejections.
  const captureFailure = capture.catch(error => error)
  if (mode !== 'creation-failed') await begun
  if (mode === 'late') {
    await expect(source.close()).rejects.toThrow('shutdown deadline')
    expect(source.snapshot().cleanup).toBe('unknown')
    release()
  }
  const failure = await captureFailure
  expect(captureId).toBeTypeOf('string')
  if (mode === 'disposer-failed') expect(failure.message).toBe('capture disposer rejected')
  else if (mode === 'creation-failed') expect(failure.message).toBe('capture creation rejected')
  else expect(failure).toBe(rejected)
  expect(registry.get(captureId as never)).toBeUndefined()
  if (mode === 'rejected') {
    await expect(source.close()).resolves.toBeUndefined()
    expect(source.snapshot().cleanup).toBe('succeeded')
  } else {
    await expect(source.close()).rejects.toThrow()
    expect(source.snapshot().cleanup).toBe('unknown')
  }
  expect(source.snapshot().meter!.modelCalls).toBe(calls)
}, 120000)

test('records unknown cleanup and disposes a factory binding that arrives after cancellation', async () => {
  const abort = new AbortController()
  let control: Parameters<NonNullable<NativeSkillGoalOptions['lifecycle']>>[0] | undefined
  let factoryStarted!: () => void
  const started = new Promise<void>(resolve => { factoryStarted = resolve })
  let release!: () => void
  const late = new Promise<void>(resolve => { release = resolve })
  let disposed = 0
  let streams = 0
  class LateAdapter extends LlmAdapter {
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { streams++; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  const setup = createNativeSkillGoalRuntime({ ...await options('late-factory'), signal: abort.signal, stopTimeoutMs: 1000,
    factory: async () => { factoryStarted(); await late; return { adapter: new LateAdapter(), inputTokenUpperBound: () => 1, dispose: () => { disposed++ } } },
    lifecycle: value => { control = value } })
  expect(control?.snapshot()).toMatchObject({ stage: 'setup', runtimeRoot: null, meter: null, result: null, cleanup: 'pending' })
  await started
  abort.abort()
  await expect(control!.close()).rejects.toThrow('native skill shutdown deadline')
  expect(control?.snapshot()).toMatchObject({ stage: 'cleanup', cleanup: 'unknown' })
  release()
  await expect(setup).rejects.toThrow('native skill setup failed')
  expect(disposed).toBe(1)
  expect(streams).toBe(0)
  await expect(control!.close()).rejects.toThrow('native skill shutdown deadline')
})
