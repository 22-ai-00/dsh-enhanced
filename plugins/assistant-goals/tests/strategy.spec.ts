import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantGoalsService } from '../src/service.ts'
import { validateGoalStrategyConfig, validateGoalStrategyInput } from '../src/strategy.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.restart()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('goal strategy admission boundaries', () => {
  it('accepts only bounded, known configuration and freezes the resolved values', () => {
    const resolved = validateGoalStrategyConfig({ maxDurationMs: 300_000, maxPromptBytes: 65_536, maxOutputBytes: 256, maxRunsPerGoal: 32 })
    expect(resolved).toMatchObject({ maxDurationMs: 300_000, maxPromptBytes: 65_536, maxOutputBytes: 256, maxRunsPerGoal: 32 })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(() => validateGoalStrategyConfig({ maxDurationMs: 999 })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ maxRunsPerGoal: 33 })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ unexpected: true } as never)).toThrow(/invalid strategy configuration/)
  })

  it('rejects inherited or oversized strategy input instead of treating it as plain JSON', () => {
    const inherited = Object.assign(Object.create({}), { kind: 'review', question: 'check this' })
    const accepted = validateGoalStrategyInput({ kind: 'compare', question: 'compare independently', context: 'bounded context' })
    expect(accepted).toMatchObject({ kind: 'compare', question: 'compare independently' })
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(() => validateGoalStrategyInput(inherited)).toThrow(/invalid strategy input/)
    expect(() => validateGoalStrategyInput({ kind: 'review', question: 'x', extra: 'not admitted' })).toThrow(/invalid strategy input/)
    expect(() => validateGoalStrategyInput({ kind: 'investigate', question: '字'.repeat(21_846) })).toThrow(/invalid strategy input/)
  })

  it('keeps strategy disabled by default and rejects non-durable or unverified strategy construction before a sidecar exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goal-strategy-config-')); roots.push(root)
    const path = join(root, 'goals.sqlite')
    const disabled = new Context(); contexts.push(disabled)
    const service = new AssistantGoalsService(disabled, { databasePath: path })
    expect(service.strategyEnabled).toBe(false)
    expect(existsSync(`${path}.strategies`)).toBe(false)

    const noBudget = new Context(); contexts.push(noBudget)
    expect(() => new AssistantGoalsService(noBudget, { databasePath: join(root, 'no-budget.sqlite'), verifyNativeRounds: true, strategy: {} })).toThrow(/strategy requires durable verified execution and budgets/)
    expect(existsSync(join(root, 'no-budget.sqlite.strategies'))).toBe(false)

    const unverified = new Context(); contexts.push(unverified)
    expect(() => new AssistantGoalsService(unverified, { databasePath: join(root, 'unverified.sqlite'), strategy: {},
      executionBudget: { modelCalls: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, durationMs: 1_000, maxOutputTokensPerCall: 1 } })).toThrow(/execution budget requires verified native rounds/)
    expect(existsSync(join(root, 'unverified.sqlite.strategies'))).toBe(false)

    const memory = new Context(); contexts.push(memory)
    expect(() => new AssistantGoalsService(memory, { databasePath: ':memory:', verifyNativeRounds: true, strategy: {},
      executionBudget: { modelCalls: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, durationMs: 1_000, maxOutputTokensPerCall: 1 } })).toThrow(/strategy requires durable verified execution and budgets/)
  })
})
