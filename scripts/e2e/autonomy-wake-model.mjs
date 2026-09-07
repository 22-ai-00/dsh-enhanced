import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-enhanced-autonomy-wake-e2e-model'
export const inject = ['llm', 'agents', 'assistantGoals', 'assistantDelivery']
export const objective = 'Schedule a verified shell program that reads two integers and prints their sum'
export const preparation = 'Prepare this session for a scheduled calculation'
const provider = 'browser-e2e'; const model = 'scheduled-goal-proof'
function records() {
  const path = process.env.DSH_WEB_E2E_MODEL_LOG
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function goalContext(value) {
  if (typeof value === 'string') {
    const text = /<business-goal-data>\s*([\s\S]*?)\s*<\/business-goal-data>/.exec(value)?.[1]
    if (text) return JSON.parse(text.replaceAll('&#123;', '{').replaceAll('&#125;', '}').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'))
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) { const found = goalContext(item); if (found) return found }
  }
}
class WakeAdapter extends LlmAdapter {
  constructor(ctx) { super(); this.ctx = ctx }
  providerInfo(id) { return { id, name: 'Deterministic persisted wake fixture' } }
  async listModels(id) { return [{ provider: id, id: model, name: model, inputModalities: ['text'] }] }
  async resolveModel(id, modelId) { return { provider: id, id: modelId, name: model, inputModalities: ['text'], context: { contextWindow: 32768 }, defaultMaxTokens: 1024 } }
  async * stream(options) {
    options.signal?.throwIfAborted()
    const call = records().length + 1
    if (call > 6) throw new Error('persisted wake fixture exceeded six calls across all processes')
    const agent = this.ctx.agents.currentInitiator()
    const human = agent !== undefined && this.ctx.assistantDelivery.currentPreferenceTurn(agent) !== undefined
    let tool; let args
    if (call === 2) { tool = 'goal_create'; args = { objective, max_goal_rounds: 1 } }
    if (call === 3) {
      const goal = goalContext([options.system, options.messages])
      if (!goal?.id || goal.native.phase !== 'active' || goal.native.roundsStarted !== 0) throw new Error('fresh owner goal context was not delivered before scheduling')
      tool = 'goal_schedule'; args = { goal_id: goal.id, expected_revision: goal.native.revision, wake_at: Date.now() + 15000 }
    }
    if (call === 5) {
      if (human) throw new Error('scheduled wake forged a human turn')
      tool = 'isolation_run'
      args = { grant_id: 'autonomy-web', idempotency_key: 'scheduled-artifact',
        command: process.env.DSH_WAKE_TEST_MODE === 'interrupt' ? 'sleep 30; cp source answer.sh' : 'cp source answer.sh',
        files: [{ path: 'source', content: 'read a b; printf "%s" "$((a + b))"' }], artifacts: ['answer.sh'], timeout_ms: 45000 }
    }
    if (call <= 4 && !human || call >= 5 && human) throw new Error('unexpected execution initiator across restart')
    const context = JSON.stringify([options.system, options.messages])
    const secretObserved = ['expectedStdout', 'expectedExitCode', '19 23', '-8 5'].some(value => context.includes(value))
    if (secretObserved) throw new Error('private verification inputs reached the model')
    appendFileSync(process.env.DSH_WEB_E2E_MODEL_LOG, `${JSON.stringify({ call, pid: process.pid, sessionId: String(agent?.session.id), human, tool: tool ?? null, secretObserved })}\n`, { mode: 0o600 })
    if (tool) {
      const id = ToolCallId(`scheduled-goal-${call}`); const argumentsText = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: argumentsText } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = `Scheduled goal reply ${call}`
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
    if (execution.name === 'goal_schedule') {
      const args = execution.arguments
      const authorize = argumentsValue => ctx.assistantGoals.preauthorizeSchedule({ ...execution, arguments: argumentsValue })
      if (!authorize(args) || !authorize(args) || authorize({ ...args, expected_revision: args.expected_revision + 1 })
        || authorize({ ...args, goal_id: 'foreign-goal' }) || authorize({ ...args, wake_at: 0 })
        || authorize({ ...args, wake_at: Date.now() + 86400000 }) || authorize({ ...args, extra: true })
        || authorize({ goal_id: args.goal_id, expected_revision: args.expected_revision })
        || ctx.assistantGoals.preauthorizeSchedule({ ...execution, signal: AbortSignal.abort() })) throw new Error('exact scheduled-goal preauthorization failed its negative checks')
    }
    return await next()
  })
  ctx.effect(() => ctx.llm.registerAdapter([provider], new WakeAdapter(ctx)))
  ctx.effect(() => ctx.assistantGoals.registerBudgetMeter({ id: 'scheduled-fixture-meter', provider, model,
    inputTokenUpperBound: () => 12, inputUsdMicrosPerMillionTokens: 0, outputUsdMicrosPerMillionTokens: 0 }))
}
