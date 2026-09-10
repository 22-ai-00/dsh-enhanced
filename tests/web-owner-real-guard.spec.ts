import { describe, expect, test, vi } from 'vitest'

const { createRunGuard, isExperimentToolAllowed, isEventExperimentToolAllowed, experimentToolNames, objective } = await import('../scripts/e2e/web-owner-real-guard.mjs')
const { templateRenderCanaryTask } = await import('../scripts/e2e/real-canary-helpers.mjs')
const { templateCanaryFixedToolAllowed, templateCanaryForbiddenTool } = await import('../scripts/e2e/web-owner-real-canary-guard.mjs')

describe('real-model browser experiment guard', () => {
  test('allows owner event arming but forbids immediate handoff and arbitrary triggers', () => {
    const args = { goal_id: 'goal-test', expected_revision: 1, trigger_id: 'file', expires_at: Date.now() + 60_000 }
    expect(isEventExperimentToolAllowed('goal_wait_event', args, '/workspace')).toBe(true)
    expect(isEventExperimentToolAllowed('goal_wait_event', { ...args, trigger_id: 'other' }, '/workspace')).toBe(false)
    expect(isEventExperimentToolAllowed('goal_wait_event', { ...args, expires_at: 1 }, '/workspace')).toBe(false)
    expect(isEventExperimentToolAllowed('goal_create', { objective, max_goal_rounds: 2, start_native_rounds: false }, '/workspace')).toBe(true)
    expect(isEventExperimentToolAllowed('goal_create', { objective, max_goal_rounds: 2, start_native_rounds: true }, '/workspace')).toBe(false)
    expect(experimentToolNames(false, true, true, false)).toContain('goal_wait_event')
    expect(experimentToolNames(false, true, true, true)).toEqual([])
    expect(experimentToolNames(true, true, true, false)).toEqual(['read', 'write', 'edit', 'get_goal'])
  })
  test('restoring prior experiment dispatch count does not reset the call limit', async () => {
    const guard = createRunGuard({ record: () => {}, initialCalls: 10 })
    const next = vi.fn()
    try {
      await expect(guard.stream({ provider: 'codex-subscription', model: 'default' }, { cancel: vi.fn() }, next).next()).rejects.toThrow('limit rejected')
      expect(next).not.toHaveBeenCalled()
    } finally { guard.stop() }
  })
  test('exposes artifact tools only in the native goal round and never exposes shell', () => {
    expect(experimentToolNames(false)).toEqual(['goal_create'])
    expect(experimentToolNames(false, true)).toEqual([])
    expect(experimentToolNames(true)).toEqual(['read', 'write', 'edit', 'get_goal'])
  })
  test('permits only the explicitly selected existing provider', async () => {
    const records: unknown[] = []
    const guard = createRunGuard({ provider: 'super-relay', record: (entry: unknown) => records.push(entry) })
    const agent = { cancel: vi.fn() }
    const next = vi.fn(async function* () {
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    try {
      await expect(guard.stream({ provider: 'codex-subscription', model: 'default' }, agent, next).next()).rejects.toThrow('route')
      expect(next).not.toHaveBeenCalled()
      for await (const _chunk of guard.stream({ provider: 'super-relay', model: 'selected-model' }, agent, next)) { /* drain */ }
      expect(records).toEqual([
        { event: 'dispatch', call: 1, provider: 'super-relay', model: 'selected-model' },
        { event: 'settled', call: 1, drained: true, finish: 'stop', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      ])
    } finally { guard.stop() }
  })
  test('limits tools to the exact goal and artifact without shell or escalation approval', () => {
    expect(isExperimentToolAllowed('goal_create', { objective, max_goal_rounds: 2, start_native_rounds: true }, '/workspace')).toBe(true)
    expect(isExperimentToolAllowed('goal_create', { objective, max_goal_rounds: 3 }, '/workspace')).toBe(false)
    expect(isExperimentToolAllowed('write', { file_path: 'summarize.mjs', content: 'code' }, '/workspace')).toBe(true)
    expect(isExperimentToolAllowed('write', { file_path: '../summarize.mjs', content: 'code' }, '/workspace')).toBe(false)
    expect(isExperimentToolAllowed('write', { file_path: 'summarize.mjs', content: 'code', sandbox_permissions: 'require_escalated' }, '/workspace')).toBe(false)
    expect(isExperimentToolAllowed('todo_write', { todos: [] }, '/workspace')).toBe(false)
    expect(isExperimentToolAllowed('bash', { command: 'echo unsafe' }, '/workspace')).toBe(false)
    expect(isExperimentToolAllowed('update_goal', { status: 'complete' }, '/workspace')).toBe(false)
  })

  test('keeps the template canary negative control executable, semantic, and single-sourced', async () => {
    const args = { goal_id: 'negative-goal', name: 'template-render', version: 2,
      inputs_json: JSON.stringify(templateRenderCanaryTask.negativeInputs), invocation_id: 'negative-control-v2' }
    expect(templateCanaryFixedToolAllowed('skill_run', args, 'negative-run')).toBe(true)
    expect(templateCanaryFixedToolAllowed('skill_run', { ...args, inputs_json: JSON.stringify({ implementation: `${templateRenderCanaryTask.negativeInputs.implementation} ` }) }, 'negative-run')).toBe(false)
    expect(templateCanaryForbiddenTool('bash')).toBe(true)
    expect(templateCanaryForbiddenTool('skill_activate')).toBe(true)
    expect(templateCanaryForbiddenTool('skill_activate_watched')).toBe(true)
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { spawnSync } = await import('node:child_process')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = await mkdtemp(join(tmpdir(), 'template-negative-'))
    try {
      const artifact = join(directory, templateRenderCanaryTask.artifactPath)
      await writeFile(artifact, templateRenderCanaryTask.negativeInputs.implementation)
      const results = templateRenderCanaryTask.strictCriteria.map(item => spawnSync(process.execPath, [artifact], { input: item.stdin, encoding: 'utf8' }))
      expect(results.every(result => result.status === 0)).toBe(true)
      expect(results.some((result, index) => result.stdout !== templateRenderCanaryTask.strictCriteria[index].expectedStdout)).toBe(true)
      expect(results.some((result, index) => result.stdout === templateRenderCanaryTask.strictCriteria[index].expectedStdout)).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test('records intent before dispatch and refuses the next call without dispatching it', async () => {
    const records: unknown[] = []
    const guard = createRunGuard({ record: (entry: unknown) => records.push(entry), maxCalls: 1 })
    const agent = { cancel: vi.fn() }
    const next = vi.fn(async function* () {
      expect(records).toEqual([{ event: 'dispatch', call: 1, provider: 'codex-subscription', model: 'test-model' }])
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const request = { provider: 'codex-subscription', model: 'test-model' }
    try {
      for await (const _chunk of guard.stream(request, agent, next)) { /* drain */ }
      await expect(guard.stream(request, agent, next).next()).rejects.toThrow('limit rejected')
      expect(next).toHaveBeenCalledTimes(1)
      expect(agent.cancel).toHaveBeenCalledOnce()
      expect(records[1]).toEqual({ event: 'settled', call: 1, drained: true, finish: 'stop', usage: null })
    } finally { guard.stop() }
  })

  test('stops a hung provider read without fabricating a settled usage or waiting forever', async () => {
    const records: unknown[] = []
    const guard = createRunGuard({ record: (entry: unknown) => records.push(entry) })
    const agent = { cancel: vi.fn() }
    const request = { provider: 'codex-subscription', model: 'test-model' }
    const next = vi.fn(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: () => Promise.resolve({ done: true }) }) }))
    const pending = guard.stream(request, agent, next).next()
    guard.stop()
    await expect(pending).rejects.toThrow('experiment stopped')
    expect(agent.cancel).toHaveBeenCalledOnce()
    expect(records[1]).toEqual({ event: 'settled', call: 1, drained: false, finish: null, usage: null })
  })

  test('uses one absolute experiment deadline across completed and subsequent calls', async () => {
    vi.useFakeTimers()
    const guard = createRunGuard({ record: () => {}, durationMs: 100 })
    const agent = { cancel: vi.fn() }
    const request = { provider: 'codex-subscription', model: 'test-model' }
    const completed = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })
    try {
      for await (const _chunk of guard.stream(request, agent, completed)) { /* drain */ }
      await vi.advanceTimersByTimeAsync(90)
      const hung = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) })
      const result = expect(guard.stream(request, agent, hung).next()).rejects.toThrow('deadline')
      await vi.advanceTimersByTimeAsync(10)
      await result
      expect(agent.cancel).toHaveBeenCalledOnce()
      await expect(guard.stream(request, agent, completed).next()).rejects.toThrow('limit rejected')
      expect(completed).toHaveBeenCalledTimes(1)
    } finally { guard.stop(); vi.useRealTimers() }
  })
})
