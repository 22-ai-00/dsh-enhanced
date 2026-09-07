import { appendFileSync } from 'node:fs'

export const name = 'dsh-enhanced-autonomy-deepseek-test-transport'
export const inject = ['llm', 'assistantGoals']
const endpoint = 'https://api.deepseek.com/chat/completions'
const objective = 'Create a shell program that reads two integers and prints their sum'

// Disposable test Host only: use the real adapter, serializer, model metadata,
// and meter. Replace only the paid provider response, never the Goal runtime.
function installMock() {
  if (process.env.DSH_AUTONOMY_DEEPSEEK_TEST !== '1') throw new Error('DeepSeek test transport requires explicit test mode')
  const previous = globalThis.fetch
  let calls = 0
  const mocked = async (url, init) => {
    if (String(url) !== endpoint) {
      if (String(url).includes('deepseek.com')) throw new Error('Unexpected DeepSeek test destination')
      return await previous(url, init)
    }
    const body = JSON.parse(String(init?.body))
    if (init?.redirect !== 'error' || body.stream !== false || body.model !== 'deepseek-v4-flash' || body.max_tokens !== 1024) throw new Error('Production wire request violated the bounded test route')
    const call = ++calls
    if (call > 8) throw new Error('DeepSeek test exceeded eight requests')
    let tool; let args
    if (call === 1) { tool = 'goal_create'; args = { objective, max_goal_rounds: 3 } }
    if (call === 3 || call === 5) {
      tool = 'isolation_run'
      args = { grant_id: 'autonomy-web', idempotency_key: `goal-artifact-${call}`, command: 'cp source answer.sh',
        files: [{ path: 'source', content: call === 3 ? 'printf wrong' : 'read a b; printf "%s" "$((a + b))"' }], artifacts: ['answer.sh'], timeout_ms: 20000 }
    }
    const text = JSON.stringify(body.messages)
    const feedbackObserved = text.includes('isolated-unexpected-stdout')
    const secretObserved = text.includes('expectedStdout') || text.includes('expectedExitCode') || text.includes('19 23') || text.includes('-8 5')
    appendFileSync(process.env.DSH_WEB_E2E_MODEL_LOG, `${JSON.stringify({ call, tool: tool ?? null, feedbackObserved, secretObserved,
      model: body.model, outputLimit: body.max_tokens, redirect: init.redirect, transport: 'mock-provider-response' })}\n`, { mode: 0o600 })
    if (call === 5 && !feedbackObserved) throw new Error('Real adapter did not serialize independent failure feedback')
    if (secretObserved) throw new Error('Private verifier vectors leaked into production wire projection')
    const message = { role: 'assistant', content: tool ? null : `Isolated goal reply ${call}`, reasoning_content: 'Continue the current task.' }
    if (tool) message.tool_calls = [{ id: `deepseek-fixture-${call}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }]
    return new Response(JSON.stringify({ id: `deepseek-response-${call}`, object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 12, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 9, completion_tokens: 8, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 2 } },
    }), { headers: { 'content-type': 'application/json' } })
  }
  globalThis.fetch = mocked
  return () => { if (globalThis.fetch === mocked) globalThis.fetch = previous }
}

// Node preloads this module before adapters capture fetch in the disposable Host.
const restore = process.env.DSH_AUTONOMY_DEEPSEEK_TEST === '1' ? installMock() : undefined
export function apply(ctx) {
  if (!restore) throw new Error('DeepSeek test transport was not enabled')
  ctx.effect(() => restore)
}
