import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GoalBudgetRuntime, validateGoalBudgetConfig } from '../src/budget.ts'
import type { GoalRecord, GoalExecutionRun } from '../src/types.ts'

type StreamHook = (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
type RequestHook = (input: { agent: Agent }, next: () => Promise<GenerateOptions>) => Promise<GenerateOptions>
type ToolHook = (input: { agent: Agent; signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>
const contexts: Array<{ dispose(): void }> = []
const temporaryDirectories: string[] = []
afterEach(async () => { contexts.splice(0).forEach(context => context.dispose()); vi.useRealTimers(); await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

function complete(withUsage = false): AsyncIterable<StreamChunk> {
  return (async function* () {
    if (withUsage) yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  })()
}
async function consume(stream: AsyncIterable<StreamChunk>): Promise<void> { for await (const _chunk of stream) {} }

function fixture(path = ':memory:', modelCalls = 2, toolCalls = 1, createdAt = Date.now()) {
  const hooks = new Map<string, Function>()
  const signal = new AbortController()
  const agent = { id: 'agent-a', options: { provider: 'unrelated', model: 'unrelated' }, session: { snapshotEvents: () => [] }, cancel: vi.fn() } as unknown as Agent
  const record = { id: 'goal-a', scope: { principalId: 'owner', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/workspace', preset: 'default' }, createdAt, native: { objective: 'objective' } } as unknown as GoalRecord
  const run = { intent: { runId: 'run-a', admission: { expiresAt: Date.now() + 60_000 } } } as unknown as GoalExecutionRun
  let cleanup: (() => void) | undefined
  const ctx = {
    on(name: string, listener: Function) { hooks.set(name, listener) },
    effect(callback: () => () => void) { cleanup = callback() },
    get(name: string) { return name === 'agents' ? { currentInitiator: () => agent, get: (id: string) => id === agent.id ? agent : undefined } : undefined },
  } as unknown as Context
  const runtime = new GoalBudgetRuntime(ctx, path, { mode: 'calls', routes: [{ provider: 'relay', model: 'auto_model/alwaysday1' }], modelCalls, toolCalls, durationMs: 60_000, maxOutputTokensPerCall: 16 }, () => ({ record, run, signal: signal.signal }))
  const result = { runtime, record, agent, signal, stream: hooks.get('llm/stream') as StreamHook, request: hooks.get('agent/request') as RequestHook, tool: hooks.get('tools/execute') as ToolHook, dispose: () => cleanup?.() }
  contexts.push(result)
  return result
}
const options = (model = 'auto_model/alwaysday1'): GenerateOptions => ({ provider: 'relay', model, messages: [], maxTokens: 16 })

describe('calls-only goal budget runtime', () => {
  it('normalizes explicit tokens mode to the legacy strict token configuration and rejects an unknown mode', () => {
    const legacy = { modelCalls: 1, toolCalls: 0, inputTokens: 2, outputTokens: 3, durationMs: 1, maxOutputTokensPerCall: 1 }
    expect(validateGoalBudgetConfig({ ...legacy, mode: 'tokens' })).toEqual(validateGoalBudgetConfig(legacy))
    expect(() => validateGoalBudgetConfig({ ...legacy, mode: 'unknown' } as never)).toThrow('execution budget')
  })

  it('admits an exact slash route without a meter, caps the provider hint, and accepts a finished stream without usage', async () => {
    const value = fixture()
    await expect(value.request({ agent: value.agent }, async () => ({ ...options(), maxTokens: 99 }))).resolves.toMatchObject({ maxTokens: 16 })
    await expect(consume(value.stream(options('auto_model/alwaysday1'), () => complete()))).resolves.toBeUndefined()
    expect(value.runtime.inspect(value.record)).toMatchObject({ modelCalls: 1, heldCalls: 0, inputTokens: null, outputTokens: null, costUsdMicros: null, limits: { mode: 'calls', routes: [{ provider: 'relay', model: 'auto_model/alwaysday1' }] } })
    expect(value.runtime.hasMeter({ provider: 'relay', model: 'auto_model/alwaysday1' })).toBe(true)
  })

  it('rejects a non-allowlisted route before downstream dispatch and retains the independent call allowance', async () => {
    const value = fixture()
    let dispatched = false
    await expect(consume(value.stream(options('other/model'), () => { dispatched = true; return complete() }))).rejects.toThrow('execution budget')
    expect(dispatched).toBe(false)
    await expect(consume(value.stream(options(), () => complete()))).resolves.toBeUndefined()
    expect(value.runtime.inspect(value.record)).toMatchObject({ modelCalls: 1, heldCalls: 0 })
  })

  it('retains a failed dispatched call across reopen and rejects the retry before downstream dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'goal-budget-runtime-')); temporaryDirectories.push(directory)
    const path = join(directory, 'budget.sqlite')
    const first = fixture(path, 1)
    await expect(consume(first.stream(options(), () => { throw new Error('transport failed') }))).rejects.toThrow('transport failed')
    expect(first.runtime.inspect(first.record)).toMatchObject({ modelCalls: 1, heldCalls: 1, inputTokens: null })
    first.dispose(); contexts.splice(contexts.indexOf(first), 1)
    const second = fixture(path, 1, 1, first.record.createdAt)
    let dispatched = false
    await expect(consume(second.stream(options(), () => { dispatched = true; return complete() }))).rejects.toThrow()
    expect(dispatched).toBe(false)
    expect(second.runtime.inspect(second.record)).toMatchObject({ modelCalls: 1, heldCalls: 1 })
  })

  it('counts failed tool execution and prevents the next tool body from starting', async () => {
    const value = fixture(':memory:', 1, 1)
    await expect(value.tool({ agent: value.agent, signal: new AbortController().signal }, async () => { throw new Error('tool failed') })).rejects.toThrow('tool failed')
    let ran = false
    await expect(value.tool({ agent: value.agent, signal: new AbortController().signal }, async () => { ran = true })).rejects.toThrow()
    expect(ran).toBe(false)
    expect(value.runtime.inspect(value.record)).toMatchObject({ toolCalls: 1 })
  })

  it('cancels the native agent at its finite lifetime and rejects a later dispatch before downstream work', async () => {
    vi.useFakeTimers()
    const value = fixture()
    await value.request({ agent: value.agent }, async () => options())
    await vi.advanceTimersByTimeAsync(60_001)
    expect(value.agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'assistant-goals-budget-expired' })
    let dispatched = false
    await expect(consume(value.stream(options(), () => { dispatched = true; return complete() }))).rejects.toThrow('execution budget')
    expect(dispatched).toBe(false)
  })
})
