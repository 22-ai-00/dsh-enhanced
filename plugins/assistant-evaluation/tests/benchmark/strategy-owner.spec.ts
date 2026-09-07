import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { createBenchmarkStrategyOwnerRuntime, type BenchmarkStrategyOwnerRuntime } from '../../src/benchmark/strategy-owner.js'
import { installStrategyBenchmarkMeter } from '../../src/benchmark/strategy-meter.js'

const roots: string[] = []
const runtimes: BenchmarkStrategyOwnerRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class OwnerAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override providerInfo(provider: string) { return { id: provider, name: 'Local benchmark fixture' } }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, inputModalities: ['text' as const] } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = 'The private benchmark owner received the public task.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function directories() {
  const root = await mkdtemp(join(tmpdir(), 'strategy-owner-')); roots.push(root)
  const workspace = join(root, 'workspace'); const stateRoot = join(root, 'private-state')
  await mkdir(workspace, { mode: 0o700 }); await mkdir(stateRoot, { mode: 0o700 })
  return { workspace, stateRoot }
}

describe('production benchmark owner bootstrap', () => {
  it('binds a private owner, meters the foreground native request, persists JSONL and captures the reply locally', async () => {
    const paths = await directories()
    const runtime = await createBenchmarkStrategyOwnerRuntime({ ctx: new Context(), ...paths, cellId: 'cell-a',
      provider: 'benchmark-fixture', model: 'fixed', maxOutputTokens: 8, persona: 'Common public persona.', policyRules: [], allowedToolNames: [] })
    runtimes.push(runtime)
    const owner = runtime.pairOwner()
    expect(owner.principalVersion).toBe(1)
    const adapter = new OwnerAdapter()
    const meter = installStrategyBenchmarkMeter(runtime.ctx, { signal: new AbortController().signal, modelCalls: 1, maxOutputTokens: 8,
      budget: { durationMs: 5000, inputTokens: 20, outputTokens: 10, toolCalls: 0, costUsdMicros: null },
      model: { provider: 'benchmark-fixture', model: 'fixed', maxOutputTokens: 8, temperature: null, inputLimitMode: 'upper-bound', outputLimitMode: 'provider',
        inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
      binding: { adapter, inputTokenUpperBound: () => 4, dispose() {} } })
    await runtime.installModel(adapter)
    await runtime.sendPublicInbound('Solve the public benchmark task.')
    await runtime.waitForQuiescence()
    const db = new DatabaseSync(join(runtime.runtimeRoot, 'delivery.sqlite'), { readOnly: true })
    const persisted = db.prepare('SELECT status, failure_code FROM inbox_messages').all(); db.close()
    expect(persisted).toEqual([{ status: 'processed', failure_code: null }])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'benchmark-fixture', model: 'fixed', maxTokens: 8, system: 'Common public persona.' })
    expect(adapter.requests[0]!.tools ?? []).toEqual([])
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('Solve the public benchmark task.')
    meter.assertComplete()
    expect(meter.snapshot()).toMatchObject({ modelCalls: 1, inputTokens: 4, outputTokens: 3, heldModelCalls: 0 })
    expect(runtime.outbound).toHaveLength(1)
    const captured = runtime.outbound
    expect(JSON.stringify(captured)).toContain('The private benchmark owner received the public task.')
    expect(() => (captured as unknown[]).pop()).toThrow()
    expect(runtime.ownerScope().owner).toEqual(owner)
    expect((await readdir(runtime.runtimeRoot, { recursive: true })).some(path => path.endsWith('.jsonl'))).toBe(true)
    await expect(runtime.sendPublicInbound('A second task cannot reuse the cell.')).rejects.toThrow()
    await runtime.shutdown()
    expect(await readdir(runtime.runtimeRoot)).not.toHaveLength(0)
  })

  it('rejects reused state and candidate-visible state without deleting either', async () => {
    const paths = await directories()
    const input = { ...paths, cellId: 'same-cell', provider: 'benchmark-fixture', model: 'fixed', maxOutputTokens: 8, persona: '', policyRules: [] }
    const runtime = await createBenchmarkStrategyOwnerRuntime({ ...input, ctx: new Context() }); runtimes.push(runtime)
    await runtime.shutdown()
    await expect(createBenchmarkStrategyOwnerRuntime({ ...input, ctx: new Context() })).rejects.toThrow()
    expect(await readdir(runtime.runtimeRoot)).not.toHaveLength(0)
    await expect(createBenchmarkStrategyOwnerRuntime({ ...input, ctx: new Context(), stateRoot: input.workspace })).rejects.toThrow('distinct')
  })

  it('cancels the real native owner request when the outer meter is disposed and retains its reservation', async () => {
    const paths = await directories()
    const runtime = await createBenchmarkStrategyOwnerRuntime({ ctx: new Context(), ...paths, cellId: 'cancel-cell',
      provider: 'benchmark-fixture', model: 'fixed', maxOutputTokens: 8, persona: '', policyRules: [], allowedToolNames: [] })
    runtimes.push(runtime); runtime.pairOwner()
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve }); let aborted = false
    class BlockingAdapter extends OwnerAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        started()
        await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'fixture' } } }
      }
    }
    const adapter = new BlockingAdapter()
    const meter = installStrategyBenchmarkMeter(runtime.ctx, { signal: new AbortController().signal, modelCalls: 1, maxOutputTokens: 8,
      budget: { durationMs: 5000, inputTokens: 20, outputTokens: 10, toolCalls: 0, costUsdMicros: null },
      model: { provider: 'benchmark-fixture', model: 'fixed', maxOutputTokens: 8, temperature: null,
        inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: 'a'.repeat(64), tokenCounterDigest: 'b'.repeat(64) },
      binding: { adapter, inputTokenUpperBound: () => 4, dispose() {} } })
    await runtime.installModel(adapter); await runtime.sendPublicInbound('Cancellation fixture.')
    const running = runtime.waitForQuiescence().then(() => null, error => error)
    await ready; meter.dispose()
    await running
    expect(aborted).toBe(true)
    expect(meter.snapshot()).toMatchObject({ modelCalls: 0, heldModelCalls: 1, heldInputTokens: 4, heldOutputTokens: 8 })
    expect(() => meter.assertComplete()).toThrow('incomplete')
  })
})
