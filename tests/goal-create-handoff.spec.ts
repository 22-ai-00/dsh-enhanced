import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '../plugins/assistant-goals/node_modules/@deepseek-ai/cordis'
import { ToolCallId } from '../plugins/assistant-goals/node_modules/@deepseek-ai/dsh-llm'
import ToolRuntime from '../plugins/assistant-goals/node_modules/@deepseek-ai/dsh-tools'
import SystemPrompt from '../plugins/assistant-goals/node_modules/@deepseek-ai/dsh-system-prompt'
import { registerGoalTools } from '../plugins/assistant-goals/src/tools.ts'
import type { AssistantGoalsService } from '../plugins/assistant-goals/src/service.ts'

const signal = new AbortController().signal
const contexts: Context[] = []

async function tools(create: (objective: string, rounds?: number) => unknown) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  registerGoalTools(ctx, {
    strategyEnabled: false, preauthorizedScheduleEnabled: false, eventWaitsEnabled: false,
    preauthorizedCreateEnabled: false, create: (_agent, objective, rounds) => create(objective, rounds),
    describe: value => `record:${String(value)}`,
  } as unknown as AssistantGoalsService)
  let call = 0
  return (arguments_: unknown) => ctx.tools.execute({
    signal, callId: ToolCallId(`goal-create-${++call}`), name: 'goal_create', arguments: arguments_,
  })
}

afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('goal_create native-round handoff', () => {
  test('concludes only a successful explicit handoff through the real tool runtime', async () => {
    const call = await tools(() => ({ id: 'goal-1' }))
    const result = await call({ objective: 'handoff', max_goal_rounds: 2, start_native_rounds: true })
    expect(result).toMatchObject({ isError: false, concludesTurn: true })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('concludes the owner request turn') }])
  })

  test('leaves the owner turn open by default and when false', async () => {
    const call = await tools(() => ({ id: 'goal-1' }))
    for (const arguments_ of [{ objective: 'default' }, { objective: 'explicit false', start_native_rounds: false }]) {
      const result = await call(arguments_)
      expect(result).toMatchObject({ isError: false })
      expect(result.concludesTurn).toBeUndefined()
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('still in the owner request turn') }])
    }
  })

  test('does not conclude when creation fails', async () => {
    const call = await tools(() => { throw new Error('creation rejected') })
    const result = await call({ objective: 'failure', start_native_rounds: true })
    expect(result).toMatchObject({ isError: true })
    expect(result.concludesTurn).toBeUndefined()
  })
})
