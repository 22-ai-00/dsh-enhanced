import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'

export interface CreationModel { provider: string; model: string; reasoningEffort?: string }
interface NativeInput {
  sessionId: string
  owner: { workspace: string; agentPreset: string; principalId: string }
  model: CreationModel
  maxInputBytes: number
  maxOutputTokens: number
  prompt: string
  data: unknown
  signal: AbortSignal
  assertCurrent(): void
}

/** Exactly one fresh, tool-free native Agent turn with a frozen supplier and budget. */
export async function runNativeCreationTurn(ctx: Context, input: NativeInput): Promise<{ value: unknown; outputDigest: string; outputTokens: number; sessionId: string }> {
  const { signal, model, owner, prompt, sessionId } = input
  const data = JSON.stringify(input.data)
  if (Buffer.byteLength(prompt) + Buffer.byteLength(data) > input.maxInputBytes) throw new Error('creation review input exceeds byte limit')
  const nativeModel = { provider: model.provider, model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) }
  const agents = ctx.get('agents'), sessions = ctx.get('sessions')
  const raw = ctx.get('assistantPolicy') as AssistantPolicyService & { [key: symbol]: AssistantPolicyService | undefined }
  const policy = raw?.[Symbol.for('cordis.original')] ?? raw
  if (!agents || !sessions || !policy) throw new Error('creation review native services unavailable')
  let handle: AgentHandle | undefined, calls = 0, chunksBytes = 0, violated = false
  try {
    input.assertCurrent(); signal.throwIfAborted()
    handle = await agents.create({ sessionId: SessionId(sessionId),
      meta: { cwd: owner.workspace, agentPreset: owner.agentPreset },
      agentOptions: { ...nativeModel, maxTokens: input.maxOutputTokens }, signal,
      setup: async (agentCtx, preparedAgent?: Agent) => {
        const agent = preparedAgent
        if (!agent || agent.session.header.cwd !== owner.workspace
          || agent.session.header.agentPreset !== owner.agentPreset) throw new Error('creation review Agent identity changed')
        input.assertCurrent(); signal.throwIfAborted()
        if (agent.session.snapshotEvents().some(event => event.type === 'assistant/message' || event.type === 'turn/end')) {
          throw new Error('creation review session is not fresh')
        }
        agentCtx.effect(() => policy.bindInitiator(agent, 'background', owner.principalId), 'creation-review.initiator')
        agentCtx.effect(() => installModelSelection(agentCtx, { current: nativeModel, assembled: undefined }), 'creation-review.model')
        agentCtx.tools.restrict({ allow: [] })
        if (agentCtx.tools.schemas(agent).length !== 0) throw new Error('creation review tools are not empty')
        agentCtx.tools.guard(() => {
          violated = true; agent.cancel({ kind: 'hook', reason: 'creation-review-tool-rejected' })
          throw new Error('creation review tools forbidden')
        })
        agentCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
          const assembly = await next()
          if (context.agent !== agent) return assembly
          return { sections: [{ name: 'creation-review', text: prompt }], contexts: [], tools: [], variables: {} }
        })
        agentCtx.on('llm/stream', async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
          if (options.sessionId !== agent.session.id) { yield* next(); return }
          input.assertCurrent(); signal.throwIfAborted()
          if (calls !== 0 || options.provider !== model.provider || options.model !== model.model
            || options.reasoningEffort !== model.reasoningEffort || options.maxTokens !== input.maxOutputTokens
            || (options.tools?.length ?? 0) !== 0 || agentCtx.tools.schemas(agent).length !== 0
            || options.system !== undefined || options.messages.length !== 2 || options.messages[0]?.role !== 'system'
            || growthObjectDigest(options.messages[0].content) !== growthObjectDigest([{ type: 'text', text: prompt }])
            || options.messages[1]?.role !== 'user' || growthObjectDigest(options.messages[1].content) !== growthObjectDigest([{ type: 'text', text: data }])
            || Buffer.byteLength(JSON.stringify(options.messages)) > input.maxInputBytes) {
            violated = true; agent.cancel({ kind: 'hook', reason: 'creation-review-contract-changed' })
            throw new Error('creation review model contract changed')
          }
          calls++
          for await (const chunk of next()) {
            signal.throwIfAborted()
            chunksBytes += Buffer.byteLength(JSON.stringify(chunk))
            if (chunksBytes > Math.max(65_536, input.maxOutputTokens * 128)
              || chunk.type === 'tool-call-delta' || chunk.type === 'block-start' && chunk.blockType === 'tool-call'
              || chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
              violated = true; agent.cancel({ kind: 'hook', reason: 'creation-review-output-rejected' })
              throw new Error('creation review output contract changed')
            }
            yield chunk
          }
          signal.throwIfAborted(); input.assertCurrent()
        })
      },
    })
    const agent = handle.agent
    const abort = () => agent.cancel({ kind: 'hook', reason: 'creation-review-cancelled' })
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: data }],
        source: { kind: 'plugin', plugin: '@dsh-enhanced/assistant-verifier', form: 'notice', summary: 'Independent creation verification' } }))
      await agent.whenIdle()
      signal.throwIfAborted(); input.assertCurrent()
      const events = agent.session.snapshotEvents() as readonly { type: string; data: Record<string, unknown> }[]
      const messages = events.filter(event => event.type === 'assistant/message')
      const ends = events.filter(event => event.type === 'turn/end')
      if (violated || calls !== 1 || messages.length !== 1 || ends.length !== 1
        || (ends[0]!.data.reason as { kind?: string })?.kind !== 'completed') throw new Error('creation review did not complete exactly one turn')
      const usage = messages[0]!.data.usage as { inputTokens?: number; outputTokens?: number } | undefined
      if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens! < 0
        || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens! < 0 || usage.outputTokens! > input.maxOutputTokens) {
        throw new Error('creation review usage missing or over budget')
      }
      const content = (messages[0]!.data.message as { content?: { type: string; text?: string }[] })?.content
      if (!Array.isArray(content) || content.some(block => !['text', 'reasoning'].includes(block.type))) throw new Error('creation review has nontext output')
      const output = content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (!output || Buffer.byteLength(output) > 32_768) throw new Error('creation review output too large or missing')
      const value: unknown = JSON.parse(output)
      await sessions.flush(agent.session)
      signal.throwIfAborted(); input.assertCurrent()
      return { value, outputDigest: growthObjectDigest(value), outputTokens: usage.outputTokens!, sessionId }
    } finally { signal.removeEventListener('abort', abort) }
  } finally { await handle?.dispose(); signal.throwIfAborted(); input.assertCurrent() }
}
