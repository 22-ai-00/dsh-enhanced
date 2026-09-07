import { appendFileSync } from 'node:fs'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-enhanced-autonomy-goal-e2e-model'
export const inject = ['llm', 'assistantGoals']
const provider = 'browser-e2e'
const model = 'isolated-goal-proof'
export const objective = 'Create a shell program that reads two integers and prints their sum'

class GoalAdapter extends LlmAdapter {
  #calls = 0
  providerInfo(id) { return { id, name: 'Deterministic isolated goal fixture' } }
  async listModels(id) { return [{ provider: id, id: model, name: model, inputModalities: ['text'] }] }
  async resolveModel(id, modelId) { return { provider: id, id: modelId, name: model, inputModalities: ['text'], context: { contextWindow: 32768 }, defaultMaxTokens: 1024 } }
  async * stream(options) {
    options.signal?.throwIfAborted()
    const call = ++this.#calls
    if (call > 8) throw new Error('isolated goal fixture exceeded eight calls')
    let tool; let args
    if (call === 1) { tool = 'goal_create'; args = { objective, max_goal_rounds: 3 } }
    // First native round is deliberately wrong. The next round must receive
    // independent failure feedback before this fixture supplies its correction.
    if (call === 3 || call === 5) {
      tool = 'isolation_run'
      args = { grant_id: 'autonomy-web', idempotency_key: `goal-artifact-${call}`,
        command: 'cp source answer.sh', files: [{ path: 'source', content: call === 3 ? 'printf wrong' : 'read a b; printf "%s" "$((a + b))"' }],
        artifacts: ['answer.sh'], timeout_ms: 20000 }
    }
    const context = JSON.stringify([options.system, options.messages])
    const feedbackObserved = context.includes('isolated-unexpected-stdout')
    const secretObserved = context.includes('expectedStdout') || context.includes('expectedExitCode') || context.includes('19 23') || context.includes('-8 5')
    appendFileSync(process.env.DSH_WEB_E2E_MODEL_LOG, `${JSON.stringify({ call, tool: tool ?? null,
      hasGoalTool: options.tools?.some(entry => entry.name === 'goal_create') === true,
      hasIsolationTool: options.tools?.some(entry => entry.name === 'isolation_run') === true,
      feedbackObserved, secretObserved })}\n`, { mode: 0o600 })
    if (call === 5 && !feedbackObserved) throw new Error('native continuation did not receive independent failure feedback')
    if (tool) {
      const id = ToolCallId(`isolated-goal-${call}`); const argumentsText = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: argumentsText } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = `Isolated goal reply ${call}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
export function apply(ctx) {
  ctx.on('tools/execute', async (execution, next) => {
    if (execution.name === 'goal_create') {
      const preauthorize = args => ctx.assistantGoals.preauthorizeCreate({ ...execution, arguments: args })
      const args = execution.arguments
      if (!preauthorize(args) || preauthorize({ ...args, max_goal_rounds: 4 })
        || preauthorize({ ...args, objective: 'unapproved objective' }) || preauthorize({ ...args, extra: true })
        || ctx.assistantGoals.preauthorizeCreate({ ...execution, signal: AbortSignal.abort() })) {
        throw new Error('finite exact-goal preauthorization checks failed')
      }
    }
    return await next()
  })
  ctx.effect(() => ctx.llm.registerAdapter([provider], new GoalAdapter()))
  // Exact fixture route only. This does not attest production tokenizer/pricing.
  ctx.effect(() => ctx.assistantGoals.registerBudgetMeter({ id: 'fixture-meter', provider, model,
    inputTokenUpperBound: () => 12, inputUsdMicrosPerMillionTokens: 0, outputUsdMicrosPerMillionTokens: 0 }))
}
