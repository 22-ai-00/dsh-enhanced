import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ResolvedToolSet, ToolBatchResult, ToolExecutionResult, ToolExecutionToken, ToolsService } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'

/**
 * 0.2.2 replaced the registry's single-call dispatch with a ToolBatch contract.
 * A direct call from plugin code is a one-call batch; the nested root/parent
 * identity the old API accepted no longer exists there — the PTC executor owns
 * nested dispatch attribution, and an unlogged batch commits no root events.
 */
export async function executeSingleTool(tools: ToolsService, input: {
  callId: ToolCallId
  name: string
  arguments: unknown
  signal: AbortSignal
  agent?: Agent
}): Promise<ToolBatchResult> {
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    signal: input.signal,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  })
  if (batch.results[0] === undefined) throw new Error('assistant-skills: tool batch returned no result')
  return batch
}

/**
 * Nested execution from inside an active tool handler uses ToolExecutionPipeline
 * directly (`prepare -> dispatch -> complete`) so `rootCallId`, `parent` token,
 * and `toolSet` are preserved without committing top-level Session batch logs.
 */
export async function executeNestedTool(ctx: Context, input: {
  callId: ToolCallId
  rootCallId: ToolCallId
  parent: ToolExecutionToken
  toolSet?: ResolvedToolSet
  name: string
  arguments: unknown
  agent: Agent
  signal: AbortSignal
}): Promise<ToolExecutionResult> {
  const pipeline = new ToolExecutionPipeline(ctx)
  const prepared = await pipeline.prepare({
    callId: input.callId,
    rootCallId: input.rootCallId,
    parent: input.parent,
    ...(input.toolSet === undefined ? {} : { toolSet: input.toolSet }),
    name: input.name,
    arguments: input.arguments,
    agent: input.agent,
    signal: input.signal,
  })
  const outcome = prepared.kind === 'dispatch'
    ? await pipeline.dispatch(prepared.exec)
    : prepared
  return await pipeline.complete(prepared.exec, outcome)
}
