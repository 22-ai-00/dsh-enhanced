import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantPolicyService, PolicyBudgetConfig } from '@dsh-enhanced/assistant-policy'
import { resolveLlmRouteCapability } from '@dsh-enhanced/llm-route-capabilities'
import {
  HostAutomationExecutorRegistry,
  HostExecutorRegistryError,
} from './host-executors.js'
import {
  AutomationRunnerAmbiguousError,
  AutomationRunnerFailureError,
  type AutomationRunner,
  type AutomationRunnerInput,
  type AutomationRunnerResult,
} from './coordinator.js'
import type {
  AutomationBudgetSettlementState,
  AutomationExecutionContext,
  AutomationExecutionDiagnostic,
  AutomationFailureClass,
  AutomationFailurePhase,
  AutomationPromptSubmissionState,
  AutomationSideEffectState,
  HostAutomationDefinition,
} from './types.js'

interface AutomationGuidanceInjector {
  injectAutomationGuidance(agent: Agent, execution: AutomationExecutionContext): void
}
import { isHostAutomationDefinition } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantAutomationExecution: AutomationExecutionContext
  }
}

const usageFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const

function summarize(events: readonly SessionEvent[], signal: AbortSignal): AutomationRunnerResult & { turnKind?: string } {
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
  const turnKind = typeof turnReason === 'object' && turnReason !== null && 'kind' in turnReason
    ? String((turnReason as { kind: unknown }).kind)
    : undefined
  return { outcome, output, usage, ...(turnKind === undefined ? {} : { turnKind }) }
}

function stableFailureCode(error: unknown, phase: AutomationFailurePhase): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(code)) return code
  }
  const defaults: Partial<Record<AutomationFailurePhase, string>> = {
    preflight: 'preflight-failed',
    'artifact-write': 'artifact-write-failed',
    'budget-reservation': 'budget-reservation-failed',
    'preset-resolution': 'preset-resolution-failed',
    'agent-creation': 'agent-creation-failed',
    'agent-disposal': 'agent-disposal-failed',
    'agent-setup': 'agent-setup-failed',
    'prompt-submission': 'prompt-submission-failed',
    'model-execution': 'model-execution-failed',
    'session-flush': 'session-flush-failed',
    'budget-settlement': 'budget-settlement-failed',
  }
  return defaults[phase] ?? 'runner-failed'
}

function failureClass(phase: AutomationFailurePhase, signal: AbortSignal, error: unknown): AutomationFailureClass {
  if (signal.aborted) return 'cancelled'
  if (phase === 'budget-reservation' || phase === 'budget-settlement') return 'budget'
  if (typeof error === 'object' && error !== null && 'name' in error
    && (error.name === 'AssistantPolicyError' || error.name === 'PolicyLedgerError')) return 'policy'
  if (phase === 'preflight' || phase === 'preset-resolution' || phase === 'agent-setup') return 'configuration'
  if (phase === 'agent-creation' || phase === 'agent-disposal' || phase === 'session-flush') return 'infrastructure'
  if (phase === 'prompt-submission' || phase === 'model-execution') return 'provider'
  return 'unknown'
}

function diagnostic(input: {
  failureClass: AutomationFailureClass
  failurePhase: AutomationFailurePhase
  failureCode: string
  promptSubmissionState: AutomationPromptSubmissionState
  sideEffectState: AutomationSideEffectState
  budgetSettlementState: AutomationBudgetSettlementState
}): AutomationExecutionDiagnostic {
  return Object.freeze({
    schemaVersion: 1,
    ...input,
    retryability: input.failureClass === 'none'
      ? input.sideEffectState === 'none' ? 'safe' : 'unsafe'
      : input.sideEffectState === 'possible' || input.sideEffectState === 'unknown'
        ? 'unsafe'
        : input.failureClass === 'configuration' || input.failureClass === 'policy' || input.failureClass === 'budget'
          ? 'after-intervention'
          : 'safe',
  })
}

export class AutomationBudgetReplayError extends AutomationRunnerFailureError {
  readonly code = 'automation-budget-reservation-replayed' as const

  constructor(readonly reservationStatus: 'finalized' | 'released' | 'reserved') {
    super(
      `assistant-automations: budget reservation replay is ${reservationStatus}; refusing duplicate execution`,
      diagnostic({
        failureClass: 'budget',
        failurePhase: 'budget-reservation',
        failureCode: 'automation-budget-reservation-replayed',
        promptSubmissionState: reservationStatus === 'released' ? 'not-submitted' : 'unknown',
        sideEffectState: reservationStatus === 'released' ? 'none' : 'unknown',
        budgetSettlementState: reservationStatus,
      }),
    )
    this.name = 'AutomationBudgetReplayError'
  }
}

export const AUTOMATION_RUN_BUDGET_METRIC = 'automation-runs'
const RECOVERY_HOST_EXECUTOR_ID = 'assistant-recovery'

/**
 * Bind a Host reservation to the exact immutable execution snapshot.  The
 * digest avoids delimiter collisions in caller-controlled ids while keeping
 * the Policy ledger key bounded and content-free.
 */
function hostBudgetIdempotencyKey(
  input: AutomationRunnerInput,
  immutableDefinitionHash: string,
  budgetId: string,
): string {
  const digest = createHash('sha256').update(JSON.stringify([
    'assistant-automations-host-budget/v1',
    input.automation.id,
    input.occurrence.id,
    immutableDefinitionHash,
    AUTOMATION_RUN_BUDGET_METRIC,
    budgetId,
  ])).digest('hex')
  return `automation-budget:host:v1:${digest}`
}

function exactHostRunnerInput(input: AutomationRunnerInput): boolean {
  return input.occurrence.automationId === input.automation.id
    && input.task.automationId === input.automation.id
    && input.task.occurrenceId === input.occurrence.id
    && input.task.status === 'running'
    && Number.isSafeInteger(input.task.attemptCount)
    && input.task.attemptCount >= 1
}

function isAuthorizedRecoveryResume(
  input: AutomationRunnerInput,
  definition: HostAutomationDefinition,
): boolean {
  return input.task.attemptCount > 1
    && input.task.attemptCount <= definition.maxRetries + 1
    && definition.retrySafety === 'idempotent'
    && definition.execution.executorId === RECOVERY_HOST_EXECUTOR_ID
}

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
    const definition = input.automation.definition
    if (isHostAutomationDefinition(definition)) {
      throw new AutomationRunnerFailureError(
        'assistant-automations: Host definitions require a registered Host executor',
        diagnostic({
          failureClass: 'configuration', failurePhase: 'executor-availability',
          failureCode: 'host-executor-router-missing', promptSubmissionState: 'not-applicable',
          sideEffectState: 'none', budgetSettlementState: definition.budgetId === undefined
            ? 'not-required'
            : 'not-reserved',
        }),
      )
    }
    const budgetId = definition.budgetId
    let reservationId: string | undefined
    let reservationSettled = false
    let handle: AgentHandle | undefined
    let agentCreationSubmitted = false
    let followupSubmitted = false
    let removeAbort: (() => void) | undefined
    let toolCalls = 0
    let phase: AutomationFailurePhase = 'preflight'
    let promptSubmissionState: AutomationPromptSubmissionState = 'not-submitted'
    let sideEffectState: AutomationSideEffectState = 'none'
    let budgetSettlementState: AutomationBudgetSettlementState = budgetId === undefined
      ? 'not-required'
      : 'not-reserved'
    try {
      const agents = this.ctx.get('agents')
      const sessions = this.ctx.get('sessions')
      const tools = this.ctx.get('tools')
      const llm = this.ctx.get('llm')
      if (agents === undefined || sessions === undefined || tools === undefined || llm === undefined) {
        throw new Error('assistant-automations: agents, sessions, and tools services are required')
      }
      const allowed = new Set(input.occurrence.dryRun ? [] : definition.allowedTools)
      if (input.signal.aborted) throw new Error('assistant-automations: run was cancelled before Agent creation')
      phase = 'budget-reservation'
      if (budgetId === undefined && !this.allowUnbudgetedExecution) {
        throw new Error('assistant-automations: a configured budget is required for unattended execution')
      }
      if (budgetId !== undefined) assertAutomationRunBudget(this.policy, budgetId)
      const agentPresets = this.ctx.get('agentPresets') as Pick<AgentPresets, 'mount' | 'resolve'> | undefined
      phase = 'preset-resolution'
      const presetId = agentPresets === undefined
        ? definition.agentPreset
        : (await agentPresets.resolve(definition.agentPreset)).id

      if (budgetId !== undefined) {
        phase = 'budget-reservation'
        const reservation = this.policy.reserve({
          budgetId,
          subject: {
            kind: 'background',
            id: input.automation.id,
            workspace: definition.workspace,
            principal: definition.principal,
          },
          amount: definition.budgetAmount!,
          idempotencyKey: [
            'automation-budget', input.automation.id, input.occurrence.id, AUTOMATION_RUN_BUDGET_METRIC, budgetId,
          ].join(':'),
        })
        if (reservation.replayed || reservation.status !== 'reserved') {
          throw new AutomationBudgetReplayError(reservation.status)
        }
        reservationId = reservation.reservationId
        budgetSettlementState = 'reserved'
      }

      phase = 'preflight'
      const globalNames = tools.schemas().map(schema => schema.name)
      const execution = Object.freeze({
        mode: input.occurrence.dryRun ? 'preview' : 'production',
        automationId: input.automation.id,
        occurrenceId: input.occurrence.id,
      } satisfies AutomationExecutionContext)
      phase = 'agent-creation'
      agentCreationSubmitted = true
      handle = await agents.create({
        sessionId: SessionId(input.sessionId),
        meta: {
          cwd: definition.workspace,
          agentPreset: presetId,
        },
        agentOptions: {
          provider: definition.provider,
          model: definition.model,
          maxTokens: definition.maxOutputTokens,
        },
        signal: input.signal,
        setup: async (agentCtx) => {
          phase = 'agent-setup'
          if (agentCtx.agent === undefined) {
            throw new Error('assistant-automations: unpublished Agent identity is missing during setup')
          }
          if (agentCtx.agent.session.header.cwd !== definition.workspace
            || agentCtx.agent.session.header.agentPreset !== presetId) {
            throw new Error('assistant-automations: background Agent identity does not match the immutable definition')
          }
          agentCtx.provide('assistantAutomationExecution', execution)
          const unbindInitiator = this.policy.bindInitiator(agentCtx.agent, 'background')
          agentCtx.effect(() => unbindInitiator, 'assistant-automations.background-initiator')
          const delivery = this.ctx.get('assistantDelivery') as
            | Pick<AssistantDeliveryService, 'bindAgentApprovalRoute'>
            | undefined
          // Approval delegation is independent from ordinary run-result
          // delivery. Legacy definitions retain their historical route.
          const bindingId = definition.approvalBindingId ?? definition.deliveryBindingId
          if (bindingId !== undefined && typeof delivery?.bindAgentApprovalRoute === 'function') {
            const unbindApproval = delivery.bindAgentApprovalRoute(agentCtx.agent, { bindingId })
            agentCtx.effect(() => unbindApproval, 'assistant-automations.approval-route')
          }
          installModelSelection(agentCtx, {
            current: {
              provider: definition.provider,
              model: definition.model,
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
            definition.provider,
            definition.model,
            presetId,
            finalSchemas.length,
          )
          agentCtx.tools.guard((execution) => {
            if (!allowed.has(execution.name)) return 'assistant-automations: tool is outside the immutable allowlist'
            if (toolCalls >= definition.maxToolCalls) {
              return 'assistant-automations: immutable tool-call budget exhausted'
            }
            toolCalls += 1
            return undefined
          })
        },
      })
      sideEffectState = 'possible'
      const agent = handle.agent
      const evolution = this.ctx.get('assistantEvolution' as never) as
        | AutomationGuidanceInjector
        | undefined
      if (execution.mode === 'production'
        && typeof evolution?.injectAutomationGuidance === 'function') {
        evolution.injectAutomationGuidance(agent, execution)
      }
      const abort = () => agent.cancel({ kind: 'hook', reason: 'assistant-automations-signal' })
      input.signal.addEventListener('abort', abort, { once: true })
      removeAbort = () => input.signal.removeEventListener('abort', abort)
      phase = 'prompt-submission'
      promptSubmissionState = 'unknown'
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: definition.prompt }],
        source: {
          kind: 'plugin',
          plugin: '@dsh-enhanced/assistant-automations',
          form: 'notice',
          summary: `Automation: ${definition.name}`,
        },
      }))
      promptSubmissionState = 'submitted'
      followupSubmitted = true
      phase = 'model-execution'
      await agent.whenIdle()
      const summary = summarize(agent.session.events, input.signal)
      sideEffectState = 'possible'
      phase = 'session-flush'
      await sessions.flush(agent.session)
      if (reservationId !== undefined) {
        phase = 'budget-settlement'
        this.policy.finalize(reservationId, definition.budgetAmount!)
        reservationSettled = true
        budgetSettlementState = 'finalized'
      }
      const classified = summary.outcome === 'succeeded'
        ? { failureClass: 'none' as const, failurePhase: 'none' as const, failureCode: 'none' }
        : summary.outcome === 'cancelled'
          ? { failureClass: 'cancelled' as const, failurePhase: 'model-execution' as const, failureCode: 'agent-turn-cancelled' }
          : summary.outcome === 'unknown'
            ? { failureClass: 'execution' as const, failurePhase: 'model-execution' as const, failureCode: 'agent-turn-unknown' }
            : {
                failureClass: 'execution' as const,
                failurePhase: 'model-execution' as const,
                failureCode: summary.turnKind === 'blocked' ? 'agent-turn-blocked' : 'agent-turn-failed',
              }
      const completed: AutomationRunnerResult = {
        outcome: summary.outcome,
        output: summary.output,
        usage: { ...summary.usage, toolCalls },
        sessionId: input.sessionId,
        diagnostic: diagnostic({
          ...classified,
          promptSubmissionState,
          sideEffectState,
          budgetSettlementState,
        }),
      }
      removeAbort?.()
      removeAbort = undefined
      phase = 'agent-disposal'
      await handle?.dispose()
      handle = undefined
      return completed
    } catch (error) {
      if (error instanceof AutomationBudgetReplayError) throw error
      let caught = error
      if (reservationId !== undefined && !reservationSettled) {
        try {
          if (!agentCreationSubmitted) {
            this.policy.release(reservationId)
            budgetSettlementState = 'released'
          } else {
            this.policy.finalize(reservationId, definition.budgetAmount!)
            budgetSettlementState = 'finalized'
          }
          reservationSettled = true
        } catch (settlementError) {
          phase = 'budget-settlement'
          budgetSettlementState = 'unknown'
          sideEffectState = agentCreationSubmitted
            ? 'possible'
            : promptSubmissionState === 'not-submitted' ? 'none' : 'unknown'
          caught = new AutomationRunnerAmbiguousError(
            `assistant-automations: conservative budget settlement failed: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`,
            {
              cause: settlementError,
              diagnostic: diagnostic({
                failureClass: 'budget',
                failurePhase: 'budget-settlement',
                failureCode: stableFailureCode(settlementError, 'budget-settlement'),
                promptSubmissionState,
                sideEffectState,
                budgetSettlementState,
              }),
            },
          )
        }
      }
      if (caught instanceof AutomationRunnerAmbiguousError) throw caught
      sideEffectState = agentCreationSubmitted
        ? 'possible'
        : promptSubmissionState === 'not-submitted' ? 'none' : 'unknown'
      const receipt = diagnostic({
        failureClass: failureClass(phase, input.signal, caught),
        failurePhase: phase,
        failureCode: stableFailureCode(caught, phase),
        promptSubmissionState,
        sideEffectState,
        budgetSettlementState,
      })
      if (followupSubmitted || promptSubmissionState !== 'not-submitted') {
        throw new AutomationRunnerAmbiguousError(
          `assistant-automations: Agent execution may have produced side effects: ${caught instanceof Error ? caught.message : String(caught)}`,
          { cause: caught, diagnostic: receipt },
        )
      }
      throw new AutomationRunnerFailureError(
        caught instanceof Error ? caught.message : String(caught),
        receipt,
        { cause: caught },
      )
    } finally {
      removeAbort?.()
      try {
        await handle?.dispose()
      } catch {
        // Preserve the original typed failure; cleanup is secondary evidence.
      }
    }
  }
}

export interface HostAutomationRunnerOptions {
  readonly allowUnbudgetedExecution?: boolean
}

/** Executes immutable Host contracts without creating an Agent or model turn. */
export class HostAutomationRunner implements AutomationRunner {
  private readonly allowUnbudgetedExecution: boolean

  constructor(
    private readonly registry: HostAutomationExecutorRegistry,
    private readonly policy: AssistantPolicyService,
    options: HostAutomationRunnerOptions = {},
  ) {
    this.allowUnbudgetedExecution = options.allowUnbudgetedExecution ?? false
  }

  async run(input: AutomationRunnerInput): Promise<AutomationRunnerResult> {
    const definition = input.automation.definition
    if (!isHostAutomationDefinition(definition)) {
      throw new AutomationRunnerFailureError(
        'assistant-automations: Agent definition reached the Host runner',
        Object.freeze({
          schemaVersion: 1, failureClass: 'configuration', failurePhase: 'preflight',
          failureCode: 'host-runner-surface-mismatch', promptSubmissionState: 'not-applicable',
          sideEffectState: 'none', retryability: 'after-intervention',
          budgetSettlementState: 'not-required',
        }),
      )
    }
    const budgetSettlementStateBeforeReservation: AutomationBudgetSettlementState =
      definition.budgetId === undefined ? 'not-required' : 'not-reserved'
    if (!exactHostRunnerInput(input)) {
      throw new AutomationRunnerFailureError(
        'assistant-automations: Host runner input identity is not exact',
        this.hostDiagnostic(definition, {
          failureClass: 'configuration', failurePhase: 'preflight',
          failureCode: 'host-runner-identity-mismatch', sideEffectState: 'none',
          retryability: 'after-intervention',
          budgetSettlementState: budgetSettlementStateBeforeReservation,
        }),
      )
    }
    const retryAttempt = input.task.attemptCount > 1
    const authorizedRecoveryResume = isAuthorizedRecoveryResume(input, definition)
    if (retryAttempt && !authorizedRecoveryResume) {
      throw new AutomationRunnerFailureError(
        'assistant-automations: Host retry is not an exact idempotent Recovery resume',
        this.hostDiagnostic(definition, {
          failureClass: 'configuration', failurePhase: 'preflight',
          failureCode: 'host-recovery-resume-not-authorized', sideEffectState: 'none',
          retryability: 'after-intervention',
          budgetSettlementState: budgetSettlementStateBeforeReservation,
        }),
      )
    }
    const proof = this.registry.prove(definition.execution)
    if (!proof.available) {
      throw new AutomationRunnerFailureError(
        'assistant-automations: exact Host executor is unavailable',
        this.hostDiagnostic(definition, {
          failureClass: 'configuration', failurePhase: 'executor-availability',
          failureCode: proof.reasonCode, sideEffectState: 'none', retryability: 'after-intervention',
          budgetSettlementState: definition.budgetId === undefined ? 'not-required' : 'not-reserved',
        }),
      )
    }

    const budgetId = definition.budgetId
    const immutableDefinitionHash = definitionHash(definition)
    let reservationId: string | undefined
    let budgetSettlementState: AutomationBudgetSettlementState = budgetId === undefined
      ? 'not-required'
      : 'not-reserved'
    let replayedFinalizedRecoveryBudget = false
    let executionStarted = false
    try {
      if (budgetId === undefined && !this.allowUnbudgetedExecution) {
        throw new AutomationRunnerFailureError(
          'assistant-automations: a configured budget is required for unattended Host execution',
          this.hostDiagnostic(definition, {
            failureClass: 'budget', failurePhase: 'budget-reservation',
            failureCode: 'automation-budget-required', sideEffectState: 'none',
            retryability: 'after-intervention', budgetSettlementState,
          }),
        )
      }
      if (budgetId !== undefined) {
        assertAutomationRunBudget(this.policy, budgetId)
        const reservation = this.policy.reserve({
          budgetId,
          subject: {
            kind: 'background', id: input.automation.id,
            workspace: definition.workspace, principal: definition.principal,
          },
          amount: definition.budgetAmount!,
          idempotencyKey: hostBudgetIdempotencyKey(input, immutableDefinitionHash, budgetId),
        })
        if (reservation.status === 'finalized'
          && reservation.replayed
          && authorizedRecoveryResume) {
          // Recovery owns an idempotent, durable operation ledger. A crash can
          // happen after that operation and its exact budget were finalized but
          // before Automations committed the terminal run. Invoke the exact
          // executor again only to read/replay its durable terminal result; the
          // already-finalized reservation must never be settled a second time.
          replayedFinalizedRecoveryBudget = true
          budgetSettlementState = 'finalized'
        } else if (reservation.status !== 'reserved') {
          const uncertain = reservation.status !== 'released'
          throw new AutomationRunnerFailureError(
            'assistant-automations: Host budget reservation was replayed',
            this.hostDiagnostic(definition, {
              failureClass: 'budget', failurePhase: 'budget-reservation',
              failureCode: 'automation-budget-reservation-replayed',
              sideEffectState: uncertain ? 'unknown' : 'none',
              retryability: uncertain ? 'unsafe' : 'after-intervention',
              budgetSettlementState: reservation.status,
            }),
          )
        } else {
          reservationId = reservation.reservationId
          budgetSettlementState = 'reserved'
        }
        if (!replayedFinalizedRecoveryBudget && reservation.replayed && !authorizedRecoveryResume) {
          // A replay on the first attempt is concurrent/duplicate execution,
          // not crash recovery. Keep the original reservation untouched.
          reservationId = undefined
          throw new AutomationRunnerFailureError(
            'assistant-automations: Host budget reservation was replayed outside Recovery resume',
            this.hostDiagnostic(definition, {
              failureClass: 'budget', failurePhase: 'budget-reservation',
              failureCode: 'automation-budget-reservation-replayed',
              sideEffectState: 'unknown', retryability: 'unsafe',
              budgetSettlementState: 'reserved',
            }),
          )
        }
        if (!replayedFinalizedRecoveryBudget && !reservation.replayed && authorizedRecoveryResume) {
          // A recovered attempt must see the exact prior reservation. A fresh
          // receipt proves the immutable definition/key changed (or no prior
          // execution reached the budget boundary), so it cannot resume this
          // occurrence. Release only the newly created reservation.
          try {
            const released = this.policy.release(reservation.reservationId)
            if (released.status !== 'released') {
              throw new Error('assistant-automations: fresh Recovery retry reservation was not released')
            }
            budgetSettlementState = 'released'
            reservationId = undefined
          } catch (error) {
            budgetSettlementState = 'unknown'
            reservationId = undefined
            throw new AutomationRunnerAmbiguousError(
              'assistant-automations: fresh Recovery retry reservation could not be released',
              {
                cause: error,
                diagnostic: this.hostDiagnostic(definition, {
                  failureClass: 'budget', failurePhase: 'budget-settlement',
                  failureCode: 'budget-settlement-failed', sideEffectState: 'unknown',
                  retryability: 'unsafe', budgetSettlementState,
                }),
              },
            )
          }
          throw new AutomationRunnerFailureError(
            'assistant-automations: Recovery resume did not replay the exact immutable budget key',
            this.hostDiagnostic(definition, {
              failureClass: 'budget', failurePhase: 'budget-reservation',
              failureCode: 'host-recovery-resume-key-mismatch', sideEffectState: 'none',
              retryability: 'after-intervention', budgetSettlementState,
            }),
          )
        }
      }

      // Availability is proved again after claim and immediately before any
      // Host execution. The reservation above is the only intervening effect.
      const exactProof = this.registry.prove(definition.execution)
      if (!exactProof.available
        || !proof.available
        || exactProof.registrationToken !== proof.registrationToken) {
        throw new HostExecutorRegistryError(
          'stale-registration',
          'Host executor changed between availability proof and execution',
        )
      }
      executionStarted = true
      const hostResult = await this.registry.execute(exactProof, {
        occurrenceId: input.occurrence.id,
        automationId: input.automation.id,
        definitionHash: immutableDefinitionHash,
        executionMode: input.occurrence.dryRun ? 'preview' : 'production',
        targetScope: definition.execution.targetScope,
        principal: definition.principal,
        ownerRouteId: definition.execution.ownerRouteId,
        activationNonce: definition.execution.activationNonce,
        catalogDigest: definition.execution.catalogDigest,
        signal: input.signal,
      })
      if (reservationId !== undefined) {
        this.policy.finalize(reservationId, definition.budgetAmount!)
        budgetSettlementState = 'finalized'
      }
      // Reserving/finalizing a durable budget is itself an external effect.
      const sideEffectState: AutomationSideEffectState = reservationId === undefined
        && !replayedFinalizedRecoveryBudget
        ? hostResult.sideEffectState
        : 'possible'
      const retryability = sideEffectState === 'none' ? hostResult.retryability : 'unsafe'
      return {
        outcome: hostResult.outcome,
        output: `Host execution terminal code: ${hostResult.failureCode}`,
        usage: {},
        diagnostic: Object.freeze({
          schemaVersion: 1,
          failureClass: hostResult.failureClass,
          failurePhase: hostResult.failurePhase,
          failureCode: hostResult.failureCode,
          promptSubmissionState: 'not-applicable',
          sideEffectState,
          retryability,
          budgetSettlementState,
        }),
      }
    } catch (error) {
      if (error instanceof AutomationRunnerFailureError || error instanceof AutomationRunnerAmbiguousError) throw error
      let settlementFailed = false
      if (reservationId !== undefined && budgetSettlementState === 'reserved') {
        try {
          // Once the registry invocation boundary may have been crossed, settle
          // conservatively so a crash/retry cannot obtain a second occurrence cap.
          if (executionStarted) {
            this.policy.finalize(reservationId, definition.budgetAmount!)
            budgetSettlementState = 'finalized'
          } else {
            this.policy.release(reservationId)
            budgetSettlementState = 'released'
          }
        } catch {
          settlementFailed = true
          budgetSettlementState = 'unknown'
        }
      }
      const sideEffectState: AutomationSideEffectState = executionStarted || settlementFailed
        ? 'unknown'
        : budgetSettlementState === 'released' || budgetSettlementState === 'not-required'
          ? 'none'
          : 'unknown'
      const receipt = this.hostDiagnostic(definition, {
        failureClass: settlementFailed ? 'budget' : 'infrastructure',
        failurePhase: settlementFailed ? 'budget-settlement' : 'host-execution',
        failureCode: settlementFailed
          ? 'budget-settlement-failed'
          : error instanceof HostExecutorRegistryError ? error.code : 'host-executor-failed',
        sideEffectState,
        retryability: sideEffectState === 'none' ? 'safe' : 'unsafe',
        budgetSettlementState,
      })
      if (sideEffectState !== 'none') {
        throw new AutomationRunnerAmbiguousError(
          'assistant-automations: Host execution may have produced external effects',
          { cause: error, diagnostic: receipt },
        )
      }
      throw new AutomationRunnerFailureError(
        'assistant-automations: Host execution failed before external effects',
        receipt,
        { cause: error },
      )
    }
  }

  private hostDiagnostic(
    _definition: HostAutomationDefinition,
    value: Omit<AutomationExecutionDiagnostic, 'schemaVersion' | 'promptSubmissionState'>,
  ): AutomationExecutionDiagnostic {
    return Object.freeze({ schemaVersion: 1, promptSubmissionState: 'not-applicable', ...value })
  }
}

/** Preserves the legacy Agent runner while routing Host definitions explicitly. */
export class RoutedAutomationRunner implements AutomationRunner {
  constructor(
    private readonly agent: AutomationRunner,
    private readonly host: AutomationRunner,
  ) {}

  run(input: AutomationRunnerInput): Promise<AutomationRunnerResult> {
    return isHostAutomationDefinition(input.automation.definition)
      ? this.host.run(input)
      : this.agent.run(input)
  }
}

function definitionHash(definition: HostAutomationDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex')
}
