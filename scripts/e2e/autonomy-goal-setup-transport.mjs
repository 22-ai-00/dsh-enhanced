import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-enhanced-autonomy-goal-setup-test-transport'
export const inject = ['llm', 'assistantGoals']

// This disposable Host fixture replaces only the paid HTTP response.  The
// installed DeepSeek adapter, serializer, budget meter, Goal runtime, verifier
// and isolation runner remain the production implementations.
const endpoint = 'https://api.deepseek.com/chat/completions'
function goalContext(value) {
  const text = typeof value === 'string' ? /<business-goal-data>\s*([\s\S]*?)\s*<\/business-goal-data>/.exec(value)?.[1] : undefined
  if (text) return JSON.parse(text.replaceAll('&#123;', '{').replaceAll('&#125;', '}').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'))
  if (value && typeof value === 'object') for (const child of Object.values(value)) { const found = goalContext(child); if (found) return found }
}

const objective = 'Create a shell program that reads two integers and prints their sum'

function callsSoFar() {
  const path = process.env.DSH_WEB_E2E_MODEL_LOG
  return path && existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length : 0
}

function installMock() {
  if (process.env.DSH_AUTONOMY_GOAL_SETUP_TEST !== '1') throw new Error('goal setup test transport requires explicit test mode')
  const previous = globalThis.fetch
  const mocked = async (url, init) => {
    if (String(url) !== endpoint) {
      if (String(url).includes('deepseek.com')) throw new Error('Unexpected DeepSeek test destination')
      return await previous(url, init)
    }
    const body = JSON.parse(String(init?.body))
    if (init?.redirect !== 'error' || body.stream !== false || body.model !== 'deepseek-v4-flash' || body.max_tokens !== 1024) {
      throw new Error('production wire request violated the bounded goal-setup route')
    }
    const call = callsSoFar() + 1
    const strategy = process.env.DSH_AUTONOMY_GOAL_SETUP_STRATEGY === '1'
    const context = JSON.stringify(body.messages)
    // This is the actual child prompt serialized onto the production HTTP
    // route. It avoids database/state shortcuts and also proves tools vanish.
    const strategyChild = context.includes('Return analysis only. Do not claim verification or take actions.')
    if (call > (strategy ? 11 : 8)) throw new Error('goal setup test exceeded its bounded model request count')
    if (strategyChild) {
      if (!strategy || (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0))) throw new Error('native strategy child wire request was not no-tools')
      appendFileSync(process.env.DSH_WEB_E2E_MODEL_LOG, `${JSON.stringify({ call, pid: process.pid, strategyChild: true, model: body.model, outputLimit: body.max_tokens,
        redirect: init.redirect, transport: 'mock-provider-response', secretObserved: false })}\n`, { mode: 0o600 })
      const message = { role: 'assistant', content: `Native strategy advice ${call}.`, reasoning_content: 'Independent analysis.' }
      return new Response(JSON.stringify({ id: `goal-setup-response-${call}`, object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 9, completion_tokens: 8, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 2 } },
      }), { headers: { 'content-type': 'application/json' } })
    }
    let tool; let args
    // Call one is only the foreground preparation which creates the persisted
    // Web session. The following calls prove that the CLI, rather than this
    // test, admitted the native Goal and its verifier configuration.
    if (call === 2) { tool = 'goal_create'; args = { objective, max_goal_rounds: 3 } }
    if (strategy && call === 5) { tool = 'goal_strategy'; args = { kind: 'compare', question: 'Compare two implementation approaches.' } }
    if (call === 3) {
      const goal = goalContext(body.messages)
      if (!goal?.id || goal.native.phase !== 'active' || goal.native.roundsStarted !== 0) throw new Error('fresh goal context missing before scheduled restart')
      tool = 'goal_schedule'; args = { goal_id: goal.id, expected_revision: goal.native.revision, wake_at: Date.now() + 15000 }
    }
    if (call === (strategy ? 8 : 5) || call === (strategy ? 10 : 7)) {
      tool = 'isolation_run'
      args = { grant_id: 'autonomy-web', idempotency_key: `goal-setup-artifact-${call}`, command: 'cp source answer.sh',
        files: [{ path: 'source', content: call === (strategy ? 8 : 5) ? 'printf wrong' : 'read a b; printf "%s" "$((a + b))"' }], artifacts: ['answer.sh'], timeout_ms: 20000 }
    }
    const feedbackObserved = context.includes('isolated-unexpected-stdout')
    const secretObserved = ['expectedStdout', 'expectedExitCode', '19 23', '-8 5'].some(value => context.includes(value))
    appendFileSync(process.env.DSH_WEB_E2E_MODEL_LOG, `${JSON.stringify({ call, pid: process.pid, tool: tool ?? null, model: body.model, outputLimit: body.max_tokens,
      redirect: init.redirect, transport: 'mock-provider-response', feedbackObserved, secretObserved })}\n`, { mode: 0o600 })
    if (call === (strategy ? 10 : 7) && !feedbackObserved) throw new Error('native continuation did not receive independent verifier feedback')
    if (secretObserved) throw new Error('private verifier vectors leaked into the production wire projection')
    const message = { role: 'assistant', content: tool ? null : `Goal setup reply ${call}`, reasoning_content: 'Continue the current task.' }
    if (tool) message.tool_calls = [{ id: `goal-setup-fixture-${call}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }]
    return new Response(JSON.stringify({ id: `goal-setup-response-${call}`, object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 12, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 9, completion_tokens: 8, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 2 } },
    }), { headers: { 'content-type': 'application/json' } })
  }
  globalThis.fetch = mocked
  return () => { if (globalThis.fetch === mocked) globalThis.fetch = previous }
}

const restore = process.env.DSH_AUTONOMY_GOAL_SETUP_TEST === '1' ? installMock() : undefined
export function apply(ctx) {
  if (!restore) throw new Error('goal setup test transport was not enabled')
  ctx.effect(() => restore)
  // Only the initial ordinary foreground model is a fixture. It cannot create
  // or run a Goal; admission later selects the shipped production DeepSeek route.
  class PreparationAdapter extends LlmAdapter {
    providerInfo(id) { return { id, name: 'Preparation-only fixture' } }
    async listModels(provider) { return [{ provider, id: 'prepare', name: 'prepare', inputModalities: ['text'] }] }
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], defaultMaxTokens: 1024 } }
    async *stream() {
      if (callsSoFar() !== 0) throw new Error('preparation fixture can reply only once')
      appendFileSync(process.env.DSH_WEB_E2E_MODEL_LOG, `${JSON.stringify({ call: 1, transport: 'preparation-only-fixture', secretObserved: false })}\n`, { mode: 0o600 })
      const block = { type: 'text', text: 'Goal setup reply 1' }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: block.text }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['goal-setup-preparation'], new PreparationAdapter()))
}
