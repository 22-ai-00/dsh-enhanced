import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import {
  AutomationRunnerAmbiguousError,
  type AutomationRunner,
  type AutomationRunnerInput,
  type AutomationRunnerResult,
} from './coordinator.js'

const usageFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const

function summarize(events: readonly SessionEvent[], signal: AbortSignal): AutomationRunnerResult {
  let output = ''
  const usage: Record<string, number> = { inputTokens: 0, outputTokens: 0 }
  let turnReason: unknown
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.type === 'text' ? block.text : '')
        .join('')
      if (text !== '') output = text
      if (event.data.usage !== undefined) {
        for (const field of usageFields) {
          const amount = event.data.usage[field]
          if (amount !== undefined) usage[field] = (usage[field] ?? 0) + amount
        }
      }
    }
    if (event.type === 'turn/end') turnReason = event.data.reason
  }
  let outcome: AutomationRunnerResult['outcome'] = 'unknown'
  if (signal.aborted) outcome = 'cancelled'
  else if (typeof turnReason === 'object' && turnReason !== null && 'kind' in turnReason) {
    const kind = (turnReason as { kind: string }).kind
    if (kind === 'completed' || kind === 'max-tokens') outcome = 'succeeded'
    else if (kind === 'aborted') outcome = 'cancelled'
    else if (kind === 'blocked' || kind === 'error') outcome = 'failed'
  }
  return { outcome, output, usage }
}

function billedTokens(usage: Readonly<Record<string, unknown>>): number {
  return usageFields.reduce((total, field) => {
    const value = usage[field]
    return total + (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  }, 0)
}

export class DshAutomationRunner implements AutomationRunner {
  constructor(
    private readonly ctx: Context,
    private readonly policy: AssistantPolicyService,
  ) {}

  async run(input: AutomationRunnerInput): Promise<AutomationRunnerResult> {
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    const tools = this.ctx.get('tools')
    if (agents === undefined || sessions === undefined || tools === undefined) {
      throw new Error('assistant-automations: agents, sessions, and tools services are required')
    }
    const allowed = new Set(input.occurrence.dryRun ? [] : input.automation.definition.allowedTools)
    for (const name of allowed) {
      if (tools.get(name) === undefined) {
        throw new Error(`assistant-automations: unknown allowlist tool: ${name}`)
      }
    }
    if (input.signal.aborted) throw new Error('assistant-automations: run was cancelled before Agent creation')

    let reservationId: string | undefined
    if (input.automation.definition.budgetId !== undefined) {
      reservationId = this.policy.reserve({
        budgetId: input.automation.definition.budgetId,
        subject: {
          kind: 'background',
          id: input.automation.id,
          workspace: input.automation.definition.workspace,
          principal: input.automation.definition.principal,
        },
        amount: input.automation.definition.budgetAmount!,
        idempotencyKey: `automation-budget:${input.occurrence.id}`,
      }).reservationId
    }

    let handle: AgentHandle | undefined
    let removeAbort: (() => void) | undefined
    let unbindInitiator: (() => void) | undefined
    let result: AutomationRunnerResult | undefined
    try {
      const globalNames = tools.schemas().map(schema => schema.name)
      const denied = globalNames.filter(name => !allowed.has(name))
      let toolCalls = 0
      handle = await agents.create({
        sessionId: SessionId(input.sessionId),
        meta: {
          cwd: input.automation.definition.workspace,
          agentPreset: input.automation.definition.agentPreset,
        },
        agentOptions: {
          provider: input.automation.definition.provider,
          model: input.automation.definition.model,
          maxTokens: input.automation.definition.maxOutputTokens,
        },
        signal: input.signal,
        setup: (agentCtx) => {
          if (agentCtx.agent === undefined) {
            throw new Error('assistant-automations: unpublished Agent identity is missing during setup')
          }
          unbindInitiator = this.policy.bindInitiator(agentCtx.agent, 'background')
          installModelSelection(agentCtx, {
            current: {
              provider: input.automation.definition.provider,
              model: input.automation.definition.model,
            },
            assembled: undefined,
          })
          if (denied.length > 0) agentCtx.tools.restrict({ deny: denied })
          agentCtx.tools.guard((execution) => {
            if (!allowed.has(execution.name)) return 'assistant-automations: tool is outside the immutable allowlist'
            if (toolCalls >= input.automation.definition.maxToolCalls) {
              return 'assistant-automations: immutable tool-call budget exhausted'
            }
            toolCalls += 1
            return undefined
          })
        },
      })
      const agent = handle.agent
      const abort = () => agent.cancel({ kind: 'hook', reason: 'assistant-automations-signal' })
      input.signal.addEventListener('abort', abort, { once: true })
      removeAbort = () => input.signal.removeEventListener('abort', abort)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: input.automation.definition.prompt }],
        source: {
          kind: 'plugin',
          plugin: '@dsh-enhanced/assistant-automations',
          form: 'notice',
          summary: `Automation: ${input.automation.definition.name}`,
        },
      }))
      await agent.whenIdle()
      result = {
        ...summarize(agent.session.events, input.signal),
        sessionId: input.sessionId,
      }
      await sessions.flush(agent.session)
      if (reservationId !== undefined) {
        this.policy.finalize(
          reservationId,
          Math.min(input.automation.definition.budgetAmount!, billedTokens(result.usage)),
        )
      }
      return result
    } catch (error) {
      if (reservationId !== undefined && handle === undefined) this.policy.release(reservationId)
      if (handle !== undefined) {
        throw new AutomationRunnerAmbiguousError(
          `assistant-automations: Agent execution may have produced side effects: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      throw error
    } finally {
      removeAbort?.()
      unbindInitiator?.()
      await handle?.dispose()
    }
  }
}
