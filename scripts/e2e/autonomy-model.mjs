import { appendFileSync, readFileSync } from 'node:fs'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-enhanced-autonomy-e2e-model'
export const inject = ['llm']

const provider = 'browser-e2e'
const model = 'isolation-proof'
const isolationArguments = JSON.stringify({ grant_id: 'autonomy-web', idempotency_key: 'browser-isolation-proof', command: "printf '42' > answer.txt; cat answer.txt", artifacts: ['answer.txt'], timeout_ms: 20_000 })

function appendEvidence(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

class AutonomyE2eAdapter extends LlmAdapter {
  #calls

  constructor(calls) {
    super()
    this.#calls = calls
  }

  providerInfo(id) {
    return { id, name: 'Autonomy E2E deterministic provider' }
  }

  async listModels(id) {
    return [{ provider: id, id: model, name: 'Isolation proof model', inputModalities: ['text'] }]
  }

  async resolveModel(id, modelId) {
    return {
      provider: id,
      id: modelId,
      name: 'Isolation proof model',
      inputModalities: ['text'],
      context: { contextWindow: 32_768 },
      defaultMaxTokens: 1_024,
    }
  }

  async * stream(options) {
    options.signal?.throwIfAborted()
    const call = ++this.#calls
    if (call > 6) throw new Error('autonomy E2E model exceeded six calls')
    const first = call === 1 || call === 3
    appendEvidence(process.env.DSH_WEB_E2E_MODEL_LOG, {
      call,
      type: first ? 'isolation-tool' : 'reply',
      hasGoalTool: options.tools?.some(tool => tool.name === 'goal_create') === true,
      hasActionTool: options.tools?.some(tool => tool.name === 'action_github_commit') === true,
      hasIsolationTool: options.tools?.some(tool => tool.name === 'isolation_run') === true,
    })
    if (first) {
      const id = ToolCallId(`browser-e2e-isolation-${call}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'isolation_run', argumentsDelta: isolationArguments }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'isolation_run', arguments: isolationArguments } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = `Autonomy reply ${call}`
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
  const adapter = new AutonomyE2eAdapter(prior)
  ctx.effect(() => {
    const release = ctx.llm.registerAdapter([provider], adapter)
    return () => release()
  })
}

function existsCallCount(path) {
  try {
    const entries = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const calls = entries.filter(entry => entry.call).map(entry => entry.call)
    if (calls.some(call => !Number.isSafeInteger(call) || call < 1) || calls.some((call, index) => call !== index + 1)) {
      throw new Error('DSH_WEB_E2E_MODEL_LOG contains an invalid call sequence')
    }
    return calls.length
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}
