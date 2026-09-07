// Operator-selected adapter for public development benchmarks; never loaded by a candidate.
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { CodingSubscriptionAdapter, Config } from '@dsh-enhanced/coding-subscription-provider'
import { createAgentLoopRequestAttestor } from '@dsh-enhanced/llm-route-capabilities'

export function createNativeAdapter(model, { ctx, workspace }) {
  if (model.provider !== 'codex-subscription' || model.temperature !== null
    || model.inputLimitMode !== 'estimate' || model.outputLimitMode !== 'observed') {
    throw new Error('Codex benchmark requires explicit estimate/observed limits and no temperature')
  }
  const config = Config({
    cwd: workspace, timeoutMs: 110_000,
    codex: { enabled: true, models: [model.model], transport: 'direct-responses', directModel: model.model },
    claude: { enabled: false }, cursor: { enabled: false }, grok: { enabled: false },
  })
  class TracedAdapter extends CodingSubscriptionAdapter {
    async *stream(options) {
      let output = ''; let usage; let finish
      const input = JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools })
      try {
        for await (const chunk of super.stream(options)) {
          if (chunk.type === 'text-delta') output += chunk.text
          if (chunk.type === 'usage') usage = chunk.usage
          if (chunk.type === 'finish') finish = chunk.reason.kind
          yield chunk
        }
      } finally {
        // Opt-in operator trace contains public benchmark inputs/output, never credentials.
        // It is separate from the immutable benchmark result and is not an oracle input.
        if (process.env.DSH_BENCHMARK_TRACE) appendFileSync(process.env.DSH_BENCHMARK_TRACE, `${JSON.stringify({
          sessionId: options.sessionId, model: options.model,
          inputSha256: createHash('sha256').update(input).digest('hex'),
          input, output, usage, finish,
        })}\n`, { mode: 0o600 })
      }
    }
  }
  const adapter = new TracedAdapter(config, {
    liveSessions: ctx.sessions,
    requestAttestor: createAgentLoopRequestAttestor(ctx.agents, ['codex-subscription']),
  })
  return {
    adapter,
    // Deliberately an estimate. This is neither a tokenizer nor a guaranteed upper bound.
    inputTokenEstimate: options => Math.ceil(Buffer.byteLength(JSON.stringify({
      system: options.system, messages: options.messages, tools: options.tools,
    }), 'utf8') / 2) + 2_048,
    dispose: () => adapter.shutdown(),
  }
}
