import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, test, vi } from 'vitest'
import { AssistantGoalsService } from '../plugins/assistant-goals/lib/index.js'
import DeepSeekBudget, { Config, DEEPSEEK_PROVIDER, DeepSeekGoalMeteredAdapter } from '../plugins/assistant-deepseek-budget/lib/index.js'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AssistantGoalsService, { databasePath: ':memory:', verifyNativeRounds: true,
    executionBudget: { modelCalls: 2, toolCalls: 1, inputTokens: 3000000, outputTokens: 30, durationMs: 5000, maxOutputTokensPerCall: 9 } })
  return ctx
}

test('real LLM and Goals services register together and revoke already prepared calls on unload', async () => {
  const ctx = await harness()
  const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be reached'))
  try {
    const disabled = await ctx.plugin(DeepSeekBudget, {})
    expect(ctx.assistantGoals.health().registeredBudgetMeters).toBe(0)
    expect(ctx.llm.listProviders()).toHaveLength(0)
    await disabled.dispose()
    const enabled = await ctx.plugin(DeepSeekBudget, { enabled: true })
    expect(ctx.assistantGoals.health().registeredBudgetMeters).toBe(2)
    expect(ctx.llm.listProviders().map(item => item.id)).toEqual([DEEPSEEK_PROVIDER])
    const prepared = await ctx.llm.prepareCall({ provider: DEEPSEEK_PROVIDER, model: 'deepseek-v4-flash', maxTokens: 9 })
    await enabled.dispose()
    expect(ctx.assistantGoals.health().registeredBudgetMeters).toBe(0)
    expect(ctx.llm.listProviders()).toHaveLength(0)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Do not dispatch' }] })] })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(transport).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose(); transport.mockRestore() }
})

test.each(['second-meter', 'provider'] as const)('failed %s registration rolls back only this plugin’s meters', async conflict => {
  const ctx = await harness()
  const existing = new DeepSeekGoalMeteredAdapter(Config())
  try {
    if (conflict === 'provider') ctx.llm.registerAdapter([DEEPSEEK_PROVIDER], existing)
    else ctx.assistantGoals.registerBudgetMeter({ id: 'previous-pro-meter', provider: DEEPSEEK_PROVIDER, model: 'deepseek-v4-pro',
      inputTokenUpperBound: () => 2097152, inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null })
    await expect(ctx.plugin(DeepSeekBudget, { enabled: true })).rejects.toThrow()
    expect(ctx.assistantGoals.health().registeredBudgetMeters).toBe(conflict === 'provider' ? 0 : 1)
    expect(ctx.llm.listProviders()).toHaveLength(conflict === 'provider' ? 1 : 0)
  } finally { existing.shutdown(); await ctx.fiber.dispose() }
})
