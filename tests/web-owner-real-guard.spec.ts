import { describe, expect, test, vi } from 'vitest'

const { createRunGuard, isExperimentToolAllowed, objective } = await import('../scripts/e2e/web-owner-real-guard.mjs')

describe('real-model browser experiment guard', () => {
  test('limits tools to the exact goal and artifact without shell or escalation approval', () => {
    expect(isExperimentToolAllowed('goal_create', { objective, max_goal_rounds: 2 }, '/workspace')).toBe(true)
    expect(isExperimentToolAllowed('goal_create', { objective, max_goal_rounds: 3 }, '/workspace')).toBe(false)
    expect(isExperimentToolAllowed('write', { file_path: 'summarize.mjs', content: 'code' }, '/workspace')).toBe(true)
    expect(isExperimentToolAllowed('write', { file_path: '../summarize.mjs', content: 'code' }, '/workspace')).toBe(false)
    expect(isExperimentToolAllowed('write', { file_path: 'summarize.mjs', content: 'code', sandbox_permissions: 'require_escalated' }, '/workspace')).toBe(false)
    expect(isExperimentToolAllowed('bash', { command: 'echo unsafe' }, '/workspace')).toBe(false)
    expect(isExperimentToolAllowed('update_goal', { status: 'complete' }, '/workspace')).toBe(false)
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
