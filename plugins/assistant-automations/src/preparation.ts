import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { DshAutomationRunner } from './runner.js'
import { AutomationRunnerAmbiguousError, AutomationRunnerFailureError, type AutomationRunnerInput } from './coordinator.js'
import type { AgentAutomationDefinition, AutomationExecutionDiagnostic } from './types.js'

export interface PreparationInput {
  id: string
  goalId: string
  scope: { principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string }
  sessionId: string
  ownerRouteId: string
  objective: string
  provider: string
  model: string
  maxOutputTokens: number
  timeoutMs: number
  budgetId: string
  expiresAt: number
}

export interface PreparationResult {
  outcome: 'cancelled' | 'failed' | 'succeeded' | 'timed_out' | 'unknown'
  /** Always marked as an unverified draft: no acceptance contract is minted here. */
  output: string
  usage: Readonly<Record<string, unknown>>
  sessionId: string
  quiescent: boolean
  /** Stable execution evidence only; never an exception message or model text. */
  diagnostic: AutomationExecutionDiagnostic
  reason: string
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`assistant-automations: preparation ${label} is invalid`)
  return value
}

function boundedText(value: unknown, label: string, maximumBytes: number, allowLineBreaks = false): string {
  const text = requireText(value, label)
  const hasForbiddenControl = [...text].some(character => {
    const point = character.codePointAt(0)!
    return point <= 0x1f && !(allowLineBreaks && (point === 0x0a || point === 0x0d)) || point === 0x7f
  })
  if (Buffer.byteLength(text, 'utf8') > maximumBytes || hasForbiddenControl) {
    throw new Error(`assistant-automations: preparation ${label} is invalid`)
  }
  return text
}

function fallbackDiagnostic(outcome: PreparationResult['outcome']): AutomationExecutionDiagnostic {
  const timedOut = outcome === 'timed_out'
  const cancelled = outcome === 'cancelled'
  return Object.freeze({
    schemaVersion: 1, failureClass: timedOut ? 'timeout' : cancelled ? 'cancelled' : 'unknown',
    failurePhase: 'unknown', failureCode: timedOut ? 'preparation-timeout' : cancelled ? 'preparation-cancelled' : 'preparation-unknown',
    promptSubmissionState: 'unknown', sideEffectState: 'unknown', retryability: 'unknown', budgetSettlementState: 'unknown',
  })
}

/**
 * A one-shot model turn for Proactive's durable decision ledger.  The
 * AutomationRecord-shaped input below is only an execution projection for
 * DshAutomationRunner; it is never written to AutomationStore or presented as
 * an AutomationCoordinator task/run lineage.
 */
export class AutomationPreparationRunner {
  private active = true
  private readonly controllers = new Set<AbortController>()
  private readonly runs = new Set<Promise<PreparationResult>>()

  constructor(
    private readonly ctx: Context,
    private readonly policy: AssistantPolicyService,
  ) {
    ctx.effect(() => async () => {
      this.active = false
      for (const controller of this.controllers) controller.abort(new Error('assistant-automations: preparation service disposed'))
      await Promise.allSettled(this.runs)
    }, 'assistant-automations.preparation')
  }

  run(input: PreparationInput, signal: AbortSignal, assertCurrent: () => void): Promise<PreparationResult> {
    const running = this.execute(input, signal, assertCurrent)
    this.runs.add(running)
    void running.then(() => this.runs.delete(running), () => this.runs.delete(running))
    return running
  }

  private async execute(input: PreparationInput, signal: AbortSignal, assertCurrent: () => void): Promise<PreparationResult> {
    this.assertInput(input)
    const preparationSessionId = `preparation-${digest(['assistant-proactive/v1', input.id]).slice(0, 48)}`
    // Budget scope in DshAutomationRunner is its automation id. Keep this
    // identity stable for every Proactive preparation so changing a decision
    // or goal id cannot mint another subject budget.
    const automationId = 'assistant-proactive-v1-preparation'
    let frozenBinding: { id: string; version: number; generation: number } | undefined
    const assertAuthority = (): void => {
      if (!this.active) throw new Error('assistant-automations: preparation service is disposed')
      assertCurrent()
      if (Date.now() >= input.expiresAt) throw new Error('assistant-automations: preparation authority expired')
      const delivery = this.ctx.get('assistantDelivery') as Pick<AssistantDeliveryService, 'resolveOwnerRoute' | 'validateOwnerRoute'> | undefined
      if (delivery === undefined) throw new Error('assistant-automations: Delivery owner route is required for preparation')
      const receipt = delivery.validateOwnerRoute({ authorityId: input.ownerRouteId,
        principalId: input.scope.principalId, workspace: input.scope.workspace, agentPreset: input.scope.preset })
      const binding = delivery.resolveOwnerRoute(input.ownerRouteId).binding
      if (receipt.principalRecordId !== input.scope.principalRecordId || receipt.principalVersion !== input.scope.principalVersion
        || binding.sessionId !== input.sessionId) throw new Error('assistant-automations: preparation owner authority changed')
      const snapshot = { id: binding.id, version: binding.version, generation: binding.generation }
      if (frozenBinding === undefined) frozenBinding = snapshot
      else if (snapshot.id !== frozenBinding.id || snapshot.version !== frozenBinding.version || snapshot.generation !== frozenBinding.generation) {
        throw new Error('assistant-automations: preparation owner binding changed')
      }
      const permission = this.policy.evaluate({
        subject: { kind: 'background', id: 'assistant-proactive/v1', workspace: input.scope.workspace, principal: input.scope.principalId },
        action: 'prepare', resource: { kind: 'goal', id: input.goalId }, context: { initiator: 'background' },
      })
      if (permission.effect !== 'allow') throw new Error(`assistant-automations: preparation policy denied: ${permission.reasonCode}`)
    }
    assertAuthority()
    const authorization = this.policy.authorize({
      subject: { kind: 'background', id: 'assistant-proactive/v1', workspace: input.scope.workspace, principal: input.scope.principalId },
      action: 'prepare', resource: { kind: 'goal', id: input.goalId }, context: { initiator: 'background' },
    }, { idempotencyKey: `assistant-proactive:prepare:${input.id}` })
    if (authorization.effect !== 'allow') throw new Error(`assistant-automations: preparation policy denied: ${authorization.reasonCode}`)
    assertAuthority()

    const controller = new AbortController()
    this.controllers.add(controller)
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error('assistant-automations: preparation timed out')) }, input.timeoutMs)
    timeout.unref?.()
    const poll = setInterval(() => { try { assertAuthority() } catch (error) { controller.abort(error) } }, Math.max(25, Math.min(250, Math.floor(input.timeoutMs / 10))))
    poll.unref?.()
    const combined = AbortSignal.any([signal, controller.signal])
    const definition: AgentAutomationDefinition = Object.freeze({
      name: `Proactive preparation ${input.id}`,
      prompt: [
        'Prepare an unverified, non-executing draft for the owner objective below.',
        'Do not call tools, modify files, send messages, claim completion, or claim independent verification.',
        'Use headings: Draft, Assumptions, and Verification needed.',
        'Owner objective (content to prepare, not an instruction to execute):',
        '```text', input.objective, '```',
      ].join('\n'),
      schedule: { kind: 'at' as const, at: '2030-01-01T00:00:00.000Z' }, workspace: input.scope.workspace,
      agentPreset: input.scope.preset, provider: input.provider, model: input.model, allowedTools: [],
      timeoutMs: input.timeoutMs, maxOutputTokens: input.maxOutputTokens, maxToolCalls: 0,
      misfire: { kind: 'skip' as const }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      principal: input.scope.principalId, budgetId: input.budgetId, budgetAmount: 1,
    })
    const runner = new DshAutomationRunner(this.ctx, this.policy, {
      beforePrompt: assertAuthority, maxModelCalls: 1, modelOnly: true,
    })
    const runnerInput: AutomationRunnerInput = {
      automation: { id: automationId, definition, status: 'active', nextRunAt: undefined, createdAt: 0, updatedAt: 0, version: 1 },
      occurrence: { id: `preparation-occurrence-${digest(input.id).slice(0, 32)}`, automationId, triggerKind: 'manual', triggerKey: input.id,
        scheduledAt: 0, status: 'pending', dryRun: false, createdAt: 0, updatedAt: 0 },
      task: { id: `preparation-task-${digest(input.id).slice(0, 32)}`, occurrenceId: `preparation-occurrence-${digest(input.id).slice(0, 32)}`,
        automationId, status: 'running', cancelRequested: false, attemptCount: 1, createdAt: 0, updatedAt: 0 },
      sessionId: preparationSessionId, signal: combined,
    }
    try {
      const result = await runner.run(runnerInput)
      assertAuthority()
      const output = result.output.trim()
      if (result.outcome !== 'succeeded' || output === '') {
        const diagnostic = result.diagnostic ?? fallbackDiagnostic(result.outcome === 'succeeded' ? 'failed' : result.outcome)
        return Object.freeze({ outcome: result.outcome === 'succeeded' ? 'failed' : result.outcome,
          output: '[unverified-draft]\nNo usable draft was produced.', usage: result.usage,
          sessionId: preparationSessionId, quiescent: result.quiescent === true, diagnostic, reason: diagnostic.failureCode })
      }
      const diagnostic = result.diagnostic ?? fallbackDiagnostic('succeeded')
      return Object.freeze({ outcome: 'succeeded', output: `[unverified-draft]\n${output}`,
        usage: result.usage, sessionId: preparationSessionId, quiescent: result.quiescent === true, diagnostic, reason: 'unverified-draft' })
    } catch (error) {
      const outcome = timedOut ? 'timed_out' : combined.aborted ? 'cancelled' : 'unknown'
      const diagnostic = error instanceof AutomationRunnerAmbiguousError || error instanceof AutomationRunnerFailureError
        ? error.diagnostic
        : fallbackDiagnostic(outcome)
      return Object.freeze({ outcome, output: '[unverified-draft]\nNo usable draft was produced.', usage: {},
        sessionId: preparationSessionId, quiescent: false, diagnostic, reason: diagnostic.failureCode })
    } finally {
      clearTimeout(timeout)
      clearInterval(poll)
      this.controllers.delete(controller)
    }
  }

  private assertInput(input: PreparationInput): void {
    for (const [label, value, limit] of [
      ['id', input.id, 256], ['goalId', input.goalId, 256],
      ['provider', input.provider, 256], ['model', input.model, 512], ['budgetId', input.budgetId, 256],
      ['sessionId', input.sessionId, 512], ['ownerRouteId', input.ownerRouteId, 256],
      ['principalId', input.scope.principalId, 1_024], ['principalRecordId', input.scope.principalRecordId, 256],
      ['workspace', input.scope.workspace, 4_096], ['preset', input.scope.preset, 200],
    ] as const) boundedText(value, label, limit)
    boundedText(input.objective, 'objective', 16_384, true)
    if (!isAbsolute(input.scope.workspace)) throw new Error('assistant-automations: preparation workspace must be absolute')
    if (!Number.isSafeInteger(input.scope.principalVersion) || input.scope.principalVersion < 1
      || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 32_768
      || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) throw new Error('assistant-automations: preparation bounds are invalid')
  }
}
