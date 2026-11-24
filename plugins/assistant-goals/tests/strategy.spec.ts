import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantGoalsService, Config as GoalsConfig, type Config as GoalsConfigType } from '../src/service.ts'
import {
  validateGoalStrategyConfig,
  validateGoalStrategyInput,
  type GoalStrategyConfig,
  type GoalStrategyConfigInput,
  type GoalStrategyInput,
} from '../src/strategy.ts'

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
    expect(() => validateGoalStrategyConfig({ maxDurationMs: null as never })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ maxPromptBytes: null as never })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ maxOutputBytes: null as never })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ maxRunsPerGoal: null as never })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ autoRoute: null as never })).toThrow(/invalid strategy configuration/)
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

  it('validates WP06 experiment, subagent, and costBenefit configuration and rejects forbidden tools', () => {
    const defaults = validateGoalStrategyConfig({})
    expect(defaults).toMatchObject({
      autoRoute: true,
      experiment: { enabled: true, maxToolCalls: 4, maxModelCalls: 3, workspaceWriteAllowed: false },
      subagent: { enabled: true, maxToolCalls: 8, maxModelCalls: 5, workspaceWriteAllowed: false },
      costBenefit: { minNetBenefit: 0.25, minRemainingParentCalls: 1, maxAdviceRepetitions: 2 },
    })
    expect(Object.isFrozen(defaults.experiment)).toBe(true)
    expect(Object.isFrozen(defaults.costBenefit)).toBe(true)

    const custom = validateGoalStrategyConfig({
      autoRoute: false,
      experiment: { allowedTools: ['read', 'isolation_run'], maxToolCalls: 2, maxModelCalls: 2 },
      costBenefit: { minNetBenefit: 0.5, minRemainingParentCalls: 2, maxAdviceRepetitions: 3 },
    })
    expect(custom.autoRoute).toBe(false)
    expect(custom.experiment.allowedTools).toEqual(['read', 'isolation_run'])
    expect(custom.costBenefit.minNetBenefit).toBe(0.5)

    for (const badTool of ['run_code', 'goal_strategy', 'goal_create', 'goal_control', 'goal_schedule', 'goal_wait_event', 'goal_checkpoint', 'goal_context', 'create_goal', 'update_goal', 'get_goal']) {
      expect(() => validateGoalStrategyConfig({ experiment: { allowedTools: [badTool] } })).toThrow(/invalid strategy configuration/)
      expect(() => validateGoalStrategyConfig({ subagent: { allowedTools: [badTool] } })).toThrow(/invalid strategy configuration/)
    }
    for (const writeTool of ['write', 'write_file', 'edit_file', 'delete_file', 'create_file', 'remove_file', 'action_shell_exec', 'action_github_commit', 'action_github_create_pr']) {
      expect(() => validateGoalStrategyConfig({ experiment: { allowedTools: [writeTool], workspaceWriteAllowed: false } })).toThrow(/invalid strategy configuration/)
      expect(() => validateGoalStrategyConfig({ subagent: { allowedTools: [writeTool], workspaceWriteAllowed: false } })).toThrow(/invalid strategy configuration/)
    }
    expect(() => validateGoalStrategyConfig({ experiment: { unexpected: true } as never })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ costBenefit: { maxAdviceRepetitions: 0 } })).toThrow(/invalid strategy configuration/)
  })

  it('validates WP06 auto, experiment, subagent, tools, and hint inputs safely', () => {
    const autoInput = validateGoalStrategyInput({ kind: 'auto', question: 'Route cleanly', failure_hint: 'tool-failure', difficulty_hint: 'moderate' })
    expect(autoInput).toMatchObject({ kind: 'auto', question: 'Route cleanly', failure_hint: 'tool-failure', difficulty_hint: 'moderate' })
    const expInput = validateGoalStrategyInput({ kind: 'experiment', question: 'Probe file', tools: ['read', 'read', 'grep'] })
    expect(expInput.tools).toEqual(['read', 'grep'])

    expect(() => validateGoalStrategyInput({ kind: 'experiment', question: 'Probe', tools: ['run_code'] })).toThrow(/invalid strategy input/)
    expect(() => validateGoalStrategyInput({ kind: 'subagent', question: 'Probe', tools: ['goal_strategy'] })).toThrow(/invalid strategy input/)
    expect(() => validateGoalStrategyInput({ kind: 'experiment', question: 'Probe', tools: ['create_goal'] })).toThrow(/invalid strategy input/)
    expect(() => validateGoalStrategyInput({ kind: 'experiment', question: 'Probe', tools: ['update_goal'] })).toThrow(/invalid strategy input/)
    expect(() => validateGoalStrategyInput({ kind: 'auto', question: 'Probe', failure_hint: 'other' })).toThrow(/invalid strategy input/)
    expect(() => validateGoalStrategyInput({ kind: 'direct', question: 'Probe' })).toThrow(/invalid strategy input/)
  })

  it('rejects getters, setters, symbols, and non-enumerable properties without invoking getters (TOCTOU protection)', () => {
    let toolsRead = 0
    const toolsGetter = vi.fn(() => (++toolsRead <= 5 ? ['read'] : ['run_code']))
    const kindGetter = vi.fn(() => 'review')
    const arrayItemGetter = vi.fn(() => 'read')

    const toctouToolsInput = { kind: 'experiment', question: 'probe' }
    Object.defineProperty(toctouToolsInput, 'tools', { enumerable: true, get: toolsGetter })
    expect(() => validateGoalStrategyInput(toctouToolsInput)).toThrow(/invalid strategy input/)
    expect(toolsGetter).not.toHaveBeenCalled()

    const toctouKindInput = { question: 'probe' }
    Object.defineProperty(toctouKindInput, 'kind', { enumerable: true, get: kindGetter })
    expect(() => validateGoalStrategyInput(toctouKindInput)).toThrow(/invalid strategy input/)
    expect(kindGetter).not.toHaveBeenCalled()

    const getterToolsArray: string[] = []
    Object.defineProperty(getterToolsArray, '0', { enumerable: true, get: arrayItemGetter })
    expect(() => validateGoalStrategyInput({ kind: 'experiment', question: 'probe', tools: getterToolsArray })).toThrow(/invalid strategy input/)
    expect(arrayItemGetter).not.toHaveBeenCalled()

    expect(() => validateGoalStrategyInput({ kind: 'review', question: 'probe', [Symbol('hidden')]: true })).toThrow(/invalid strategy input/)
    const nonEnum = { kind: 'review', question: 'probe' }
    Object.defineProperty(nonEnum, 'context', { enumerable: false, value: 'hidden' })
    expect(() => validateGoalStrategyInput(nonEnum)).toThrow(/invalid strategy input/)

    const cfgGetter = vi.fn(() => 10_000)
    const badCfg = {}
    Object.defineProperty(badCfg, 'maxDurationMs', { enumerable: true, get: cfgGetter })
    expect(() => validateGoalStrategyConfig(badCfg)).toThrow(/invalid strategy configuration/)
    expect(cfgGetter).not.toHaveBeenCalled()

    const nestedExp = {}
    Object.defineProperty(nestedExp, 'maxToolCalls', { enumerable: true, get: cfgGetter })
    expect(() => validateGoalStrategyConfig({ experiment: nestedExp as never })).toThrow(/invalid strategy configuration/)
    expect(cfgGetter).not.toHaveBeenCalled()

    const cfgArray: string[] = []
    Object.defineProperty(cfgArray, '0', { enumerable: true, get: arrayItemGetter })
    expect(() => validateGoalStrategyConfig({ experiment: { allowedTools: cfgArray } })).toThrow(/invalid strategy configuration/)
    expect(arrayItemGetter).not.toHaveBeenCalled()
  })

  it('accepts Partial/Readonly GoalStrategyConfig, readonly string[], and explicit undefined under exactOptionalPropertyTypes without aliasing', () => {
    const baseResolved: Readonly<GoalStrategyConfig> = validateGoalStrategyConfig({})
    const partialStrategy: Partial<GoalStrategyConfig> = { maxRunsPerGoal: 2 }
    const fullPartialStrategy: Partial<GoalStrategyConfig> = baseResolved
    const roTools = ['read', 'grep'] as const
    const frozenTools: readonly string[] = Object.freeze(['read', 'isolation_run'])

    const fromPartial = validateGoalStrategyConfig(partialStrategy)
    const fromFullPartial = validateGoalStrategyConfig(fullPartialStrategy)
    const fromReadonly = validateGoalStrategyConfig(baseResolved)
    const fromReadonlyTools = validateGoalStrategyConfig({
      experiment: { allowedTools: roTools },
      subagent: { allowedTools: frozenTools },
    })

    expect(fromPartial.maxRunsPerGoal).toBe(2)
    expect(fromFullPartial).toEqual(baseResolved)
    expect(fromReadonly).toEqual(baseResolved)
    expect(fromReadonlyTools.experiment.allowedTools).toEqual(['read', 'grep'])
    expect(fromReadonlyTools.subagent.allowedTools).toEqual(['read', 'isolation_run'])

    // Distinct frozen objects/arrays prevent YAML anchor/alias generation (e.g. *a1)
    expect(baseResolved.experiment).not.toBe(baseResolved.subagent)
    expect(baseResolved.experiment.allowedTools).not.toBe(baseResolved.subagent.allowedTools)
    expect(Object.isFrozen(baseResolved.experiment.allowedTools)).toBe(true)
    expect(Object.isFrozen(baseResolved.subagent.allowedTools)).toBe(true)
    expect(fromReadonly.experiment).not.toBe(baseResolved.experiment)
    expect(fromReadonly.experiment.allowedTools).not.toBe(baseResolved.experiment.allowedTools)
    expect(fromReadonly.subagent).not.toBe(baseResolved.subagent)
    expect(fromReadonly.subagent.allowedTools).not.toBe(baseResolved.subagent.allowedTools)
    expect(fromReadonly.costBenefit).not.toBe(baseResolved.costBenefit)

    // Explicit undefined on top-level and nested fields falls back to defaults
    const explicitUndefinedConfig: GoalStrategyConfigInput = {
      maxDurationMs: undefined,
      maxPromptBytes: undefined,
      maxOutputBytes: undefined,
      maxRunsPerGoal: undefined,
      autoRoute: undefined,
      experiment: {
        enabled: undefined,
        allowedTools: undefined,
        maxToolCalls: undefined,
        maxModelCalls: undefined,
        workspaceWriteAllowed: undefined,
      },
      subagent: {
        enabled: undefined,
        allowedTools: undefined,
        maxToolCalls: undefined,
        maxModelCalls: undefined,
        workspaceWriteAllowed: undefined,
      },
      costBenefit: {
        minNetBenefit: undefined,
        minRemainingParentCalls: undefined,
        maxAdviceRepetitions: undefined,
      },
    }
    const resolvedUndefined = validateGoalStrategyConfig(explicitUndefinedConfig)
    expect(resolvedUndefined).toEqual(baseResolved)
    expect(resolvedUndefined.experiment).not.toBe(resolvedUndefined.subagent)
    expect(resolvedUndefined.experiment.allowedTools).not.toBe(resolvedUndefined.subagent.allowedTools)

    const topUndefinedSubobjects = validateGoalStrategyConfig({
      experiment: undefined,
      subagent: undefined,
      costBenefit: undefined,
    })
    expect(topUndefinedSubobjects).toEqual(baseResolved)
    expect(topUndefinedSubobjects.experiment.allowedTools).not.toBe(topUndefinedSubobjects.subagent.allowedTools)

    const explicitUndefinedInput: GoalStrategyInput = {
      kind: 'auto',
      question: 'route with optional undefined properties',
      context: undefined,
      tools: undefined,
      failure_hint: undefined,
      difficulty_hint: undefined,
    }
    expect(validateGoalStrategyInput(explicitUndefinedInput)).toEqual({
      kind: 'auto',
      question: 'route with optional undefined properties',
    })

    // Null and unknown nested fields remain strictly rejected
    expect(() => validateGoalStrategyConfig({ experiment: { enabled: null as never } })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ experiment: { allowedTools: null as never } })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ experiment: { maxToolCalls: null as never } })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ experiment: { maxModelCalls: null as never } })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ experiment: { workspaceWriteAllowed: null as never } })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ subagent: { allowedTools: null as never } })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ costBenefit: { minNetBenefit: null as never } })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ costBenefit: { minRemainingParentCalls: null as never } })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ costBenefit: { maxAdviceRepetitions: null as never } })).toThrow(/invalid strategy configuration/)
    expect(() => validateGoalStrategyConfig({ costBenefit: { extra: 1 } as never })).toThrow(/invalid strategy configuration/)

    // Schemastery Config validates both resolved strategy output and partial readonly inputs
    const parsedFromResolved = GoalsConfig({ strategy: baseResolved })
    expect(parsedFromResolved.strategy).toEqual(baseResolved)
    expect(GoalsConfig({ strategy: {} }).strategy).toEqual(validateGoalStrategyConfig({}))

    const parsedWithUndefined = GoalsConfig({ strategy: undefined })
    expect(parsedWithUndefined.strategy).toBeUndefined()
    const svcCfg: GoalsConfigType = { strategy: undefined }
    expect(GoalsConfig(svcCfg).strategy).toBeUndefined()
    const maybeStrategy = undefined as GoalStrategyConfigInput | undefined
    expect(GoalsConfig({ strategy: maybeStrategy }).strategy).toBeUndefined()
    const definedMaybeStrategy = { maxRunsPerGoal: 3 } as GoalStrategyConfigInput | undefined
    expect(GoalsConfig({ strategy: definedMaybeStrategy }).strategy?.maxRunsPerGoal).toBe(3)

    const parsedFromPartial = GoalsConfig({
      strategy: {
        maxRunsPerGoal: 2,
        experiment: { allowedTools: frozenTools },
        subagent: { allowedTools: roTools },
      },
    })
    expect(parsedFromPartial.strategy?.maxRunsPerGoal).toBe(2)
    expect(parsedFromPartial.strategy?.experiment?.allowedTools).toEqual(['read', 'isolation_run'])
    expect(parsedFromPartial.strategy?.subagent?.allowedTools).toEqual(['read', 'grep'])
  })
})
