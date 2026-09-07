import { appendFileSync, readFileSync } from 'node:fs'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-enhanced-web-owner-e2e-model'
export const inject = ['llm']

const provider = 'browser-e2e'
const model = 'goal-proof'
const objective = 'Browser owner end-to-end goal'
const goalArguments = JSON.stringify({ objective, max_goal_rounds: 1 })

function appendEvidence(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

class BrowserE2eAdapter extends LlmAdapter {
  #calls

  constructor(calls) {
    super()
    this.#calls = calls
  }

  providerInfo(id) {
    return { id, name: 'Browser E2E deterministic provider' }
  }

  async listModels(id) {
    return [{ provider: id, id: model, name: 'Goal proof model', inputModalities: ['text'] }]
  }

  async resolveModel(id, modelId) {
    return {
      provider: id,
      id: modelId,
      name: 'Goal proof model',
      inputModalities: ['text'],
      context: { contextWindow: 32_768 },
      defaultMaxTokens: 1_024,
    }
  }

  async * stream(options) {
    options.signal?.throwIfAborted()
    const call = ++this.#calls
    if (call > 6) throw new Error('web-owner E2E model exceeded six calls')
    const first = call === 1
    appendEvidence(process.env.DSH_WEB_E2E_MODEL_LOG, {
      call,
      type: first ? 'goal-tool' : 'reply',
      hasGoalTool: options.tools?.some(tool => tool.name === 'goal_create') === true,
    })
    if (first) {
      const id = ToolCallId('browser-e2e-goal-create')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'goal_create', argumentsDelta: goalArguments }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'goal_create', arguments: goalArguments } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = `Browser owner reply ${call}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  const logPath = process.env.DSH_WEB_E2E_MODEL_LOG
  if (typeof logPath !== 'string' || logPath.length === 0) {
    throw new Error('DSH_WEB_E2E_MODEL_LOG must name the temporary E2E evidence file')
  }
  const prior = existsCallCount(logPath)
  const adapter = new BrowserE2eAdapter(prior)
  ctx.effect(() => {
    const release = ctx.llm.registerAdapter([provider], adapter)
    return () => release()
  })
}

function existsCallCount(path) {
  try {
    const entries = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const calls = entries.map(entry => entry.call)
    if (calls.some(call => !Number.isSafeInteger(call) || call < 1) || calls.some((call, index) => call !== index + 1)) {
      throw new Error('DSH_WEB_E2E_MODEL_LOG contains an invalid call sequence')
    }
    return calls.length
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}
