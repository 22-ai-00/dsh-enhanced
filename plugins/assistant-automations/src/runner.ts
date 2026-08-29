import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantPolicyService, PolicyBudgetConfig } from '@dsh-enhanced/assistant-policy'
import { resolveLlmRouteCapability } from '@dsh-enhanced/llm-route-capabilities'
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
  // Seeded empty, not zeroed: execution evidence must distinguish a provider
  // that reported zero from one that never supplied usage at all.
  const usage: Record<string, number> = {}
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

export class AutomationBudgetReplayError extends Error {
  readonly code = 'automation-budget-reservation-replayed' as const

  constructor(readonly reservationStatus: 'finalized' | 'released' | 'reserved') {
    super(`assistant-automations: budget reservation replay is ${reservationStatus}; refusing duplicate execution`)
    this.name = 'AutomationBudgetReplayError'
  }
}

export const AUTOMATION_RUN_BUDGET_METRIC = 'automation-runs'

/** Prove the configured Policy budget uses the fixed per-run unit before reservation. */
export function assertAutomationRunBudget(
  policy: Pick<AssistantPolicyService, 'getBudgetConfig'>,
  budgetId: string,
): Readonly<PolicyBudgetConfig> {
  const budget = policy.getBudgetConfig(budgetId)
  if (budget === undefined) {
    throw new Error(`assistant-automations: budget is not configured: ${budgetId}`)
  }
  if (budget.id !== budgetId || budget.metric !== AUTOMATION_RUN_BUDGET_METRIC) {
    throw new Error(
      `assistant-automations: budget ${budgetId} must use ${AUTOMATION_RUN_BUDGET_METRIC}, got ${budget.metric}`,
    )
  }
  return budget
}

export interface DshAutomationRunnerOptions {
  /** Explicit escape hatch for deployments whose unattended routes have no configured Policy budget. */
  readonly allowUnbudgetedExecution?: boolean
}

function requireAdapterToolCallProtocol(
  llm: LlmRuntime,
  provider: string,
  model: string,
  presetId: string,
  toolCount: number,
): void {
  if (toolCount === 0) return
  if (resolveLlmRouteCapability(llm, provider, model)?.toolCalls === 'none') {
    throw new Error(
      `assistant-automations: adapter ${provider}/${model} declares no DSH tool-call protocol for preset ${presetId}`,
    )
  }
}

export class DshAutomationRunner implements AutomationRunner {
  private readonly allowUnbudgetedExecution: boolean

  constructor(
    private readonly ctx: Context,
    private readonly policy: AssistantPolicyService,
    options: DshAutomationRunnerOptions = {},
  ) {
    this.allowUnbudgetedExecution = options.allowUnbudgetedExecution ?? false
  }

  async run(input: AutomationRunnerInput): Promise<AutomationRunnerResult> {
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    const tools = this.ctx.get('tools')
    const llm = this.ctx.get('llm')
    if (agents === undefined || sessions === undefined || tools === undefined || llm === undefined) {
      throw new Error('assistant-automations: agents, sessions, and tools services are required')
    }
    const allowed = new Set(input.occurrence.dryRun ? [] : input.automation.definition.allowedTools)
    if (input.signal.aborted) throw new Error('assistant-automations: run was cancelled before Agent creation')
    const budgetId = input.automation.definition.budgetId
    if (budgetId === undefined && !this.allowUnbudgetedExecution) {
      throw new Error('assistant-automations: a configured budget is required for unattended execution')
    }
    if (budgetId !== undefined) assertAutomationRunBudget(this.policy, budgetId)
    const agentPresets = this.ctx.get('agentPresets') as Pick<AgentPresets, 'mount' | 'resolve'> | undefined
    const presetId = agentPresets === undefined
      ? input.automation.definition.agentPreset
      : (await agentPresets.resolve(input.automation.definition.agentPreset)).id

    let reservationId: string | undefined
    let reservationSettled = false
    if (budgetId !== undefined) {
      const reservation = this.policy.reserve({
        budgetId,
        subject: {
          kind: 'background',
          id: input.automation.id,
          workspace: input.automation.definition.workspace,
          principal: input.automation.definition.principal,
        },
        amount: input.automation.definition.budgetAmount!,
        idempotencyKey: [
          'automation-budget', input.automation.id, input.occurrence.id, AUTOMATION_RUN_BUDGET_METRIC, budgetId,
        ].join(':'),
      })
      if (reservation.replayed || reservation.status !== 'reserved') {
        throw new AutomationBudgetReplayError(reservation.status)
      }
      reservationId = reservation.reservationId
    }

    let handle: AgentHandle | undefined
    let agentCreationSubmitted = false
    let followupSubmitted = false
    let removeAbort: (() => void) | undefined
    let result: AutomationRunnerResult | undefined
    try {
      const globalNames = tools.schemas().map(schema => schema.name)
      let toolCalls = 0
      agentCreationSubmitted = true
      handle = await agents.create({
        sessionId: SessionId(input.sessionId),
        meta: {
          cwd: input.automation.definition.workspace,
          agentPreset: presetId,
        },
        agentOptions: {
          provider: input.automation.definition.provider,
          model: input.automation.definition.model,
          maxTokens: input.automation.definition.maxOutputTokens,
        },
        signal: input.signal,
        setup: async (agentCtx) => {
          if (agentCtx.agent === undefined) {
            throw new Error('assistant-automations: unpublished Agent identity is missing during setup')
          }
          if (agentCtx.agent.session.header.cwd !== input.automation.definition.workspace
            || agentCtx.agent.session.header.agentPreset !== presetId) {
            throw new Error('assistant-automations: background Agent identity does not match the immutable definition')
          }
          const unbindInitiator = this.policy.bindInitiator(agentCtx.agent, 'background')
          agentCtx.effect(() => unbindInitiator, 'assistant-automations.background-initiator')
          const delivery = this.ctx.get('assistantDelivery') as
            | Pick<AssistantDeliveryService, 'bindAgentApprovalRoute'>
            | undefined
          const bindingId = input.automation.definition.deliveryBindingId
          if (bindingId !== undefined && typeof delivery?.bindAgentApprovalRoute === 'function') {
            const unbindApproval = delivery.bindAgentApprovalRoute(agentCtx.agent, { bindingId })
            agentCtx.effect(() => unbindApproval, 'assistant-automations.approval-route')
          }
          installModelSelection(agentCtx, {
            current: {
              provider: input.automation.definition.provider,
              model: input.automation.definition.model,
            },
            assembled: undefined,
          })
          await agentPresets?.mount(agentCtx, presetId)
          const mountedNames = agentCtx.tools.schemas(agentCtx.agent).map(schema => schema.name)
          for (const name of allowed) {
            if (!mountedNames.includes(name)) {
              throw new Error(`assistant-automations: unknown allowlist tool after preset mount: ${name}`)
            }
          }
          const denied = globalNames.filter(name => !allowed.has(name))
          if (denied.length > 0) agentCtx.tools.restrict({ deny: denied })
          const finalSchemas = agentCtx.tools.schemas(agentCtx.agent)
          const outsideAllowlist = finalSchemas.map(schema => schema.name).filter(name => !allowed.has(name))
          if (outsideAllowlist.length > 0) {
            throw new Error(
              `assistant-automations: preset ${presetId} exposes tools outside the immutable allowlist: ${outsideAllowlist.join(', ')}`,
            )
          }
          requireAdapterToolCallProtocol(
            llm,
            input.automation.definition.provider,
            input.automation.definition.model,
            presetId,
            finalSchemas.length,
          )
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
      followupSubmitted = true
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
        this.policy.finalize(reservationId, input.automation.definition.budgetAmount!)
        reservationSettled = true
      }
      return result
    } catch (error) {
      let caught = error
      if (reservationId !== undefined && !reservationSettled) {
        try {
          if (!agentCreationSubmitted) this.policy.release(reservationId)
          else this.policy.finalize(reservationId, input.automation.definition.budgetAmount!)
          reservationSettled = true
        } catch (settlementError) {
          caught = new AutomationRunnerAmbiguousError(
            `assistant-automations: conservative budget settlement failed: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`,
            { cause: settlementError },
          )
        }
      }
      if (caught instanceof AutomationBudgetReplayError) {
        throw caught
      }
      if (followupSubmitted) {
        throw new AutomationRunnerAmbiguousError(
          `assistant-automations: Agent execution may have produced side effects: ${caught instanceof Error ? caught.message : String(caught)}`,
          { cause: caught },
        )
      }
      throw caught
    } finally {
      removeAbort?.()
      await handle?.dispose()
    }
  }
}
