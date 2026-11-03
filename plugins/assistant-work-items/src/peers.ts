/**
 * Structural peer contracts.
 *
 * Every dependency of this plugin is an optional peer service that the Loader
 * may mount independently, so the shapes are declared structurally here rather
 * than imported from sibling packages at build time. A missing service is a
 * bounded `missing-dependency` failure, never a crash.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AutomationRecord, HostAutomationDefinition, HostAutomationExecutor, HostAutomationExecutorInput, HostAgentExecutionContract, HostAgentExecutionResult, HostAgentAuthorizationFence, ProductionOccurrenceTerminalProjection } from '@dsh-enhanced/assistant-automations'
export type { HostAutomationExecutorInput, HostAgentExecutionContract, HostAgentExecutionResult } from '@dsh-enhanced/assistant-automations'

export type PeerPolicyEffect = 'allow' | 'deny'
export type PeerPolicyInitiator = 'background' | 'external' | 'foreground'
export type PeerPolicySubjectKind = 'agent' | 'background' | 'external'

export interface PeerPolicyRequest {
  readonly subject: Readonly<{ kind: PeerPolicySubjectKind; id: string; workspace?: string; principal?: string }>
  readonly action: string
  readonly resource: Readonly<{ kind: string; id: string }>
  readonly context: Readonly<{ initiator: PeerPolicyInitiator }>
}

export interface PeerPolicyDecision {
  readonly effect: PeerPolicyEffect
  readonly reasonCode: string
  readonly ruleId?: string | undefined
}

/** `assistant-policy` default-deny authorization surface. */
export interface PeerPolicyService {
  authorize(request: PeerPolicyRequest, options?: { idempotencyKey?: string; auditDetails?: unknown }): PeerPolicyDecision
  authorizeAgent?(agent: import('@deepseek-ai/dsh-agent').Agent | undefined, action: string,
    resource: { kind: 'automation'; id: string }, options?: { idempotencyKey?: string }): PeerPolicyDecision
  evaluateAgent?(agent: import('@deepseek-ai/dsh-agent').Agent | undefined, action: string,
    resource: { kind: 'automation'; id: string }): PeerPolicyDecision
  /** Absent on older Policy peers: keep their ordinary approval path. */
  workItemToolPreauthorizationVersion?(): 1
  registerPreauthorizedTool?(
    caller: Context,
    definition: ToolDefinition,
    authorize: (execution: ToolExecution) => boolean,
    options?: { denialReason: string },
  ): () => void
}

/** `assistant-delivery` owner-route receipt (receiptVersion 2). */
export interface PeerOwnerRouteReceipt {
  readonly receiptVersion: number
  readonly authorityId: string
  readonly authorityHash: string
  readonly principalId: string
  readonly principalRecordId: string
  readonly principalVersion: number
  readonly workspace: string
  readonly agentPreset: string
  readonly bindingVersion: number
  readonly generation: number
}

export interface PeerOwnerRouteInspection {
  readonly status: 'active' | 'revoked' | 'unavailable'
  readonly receipt?: PeerOwnerRouteReceipt
  readonly reason?: string
}

/**
 * One owner-authenticated foreground task, as exposed read-only by
 * `assistant-delivery`'s `owner-foreground-source/v1` protocol.
 *
 * This is already-authoritative owner data: the owner submitted the request
 * through their own route, the execution status is recorded by delivery, and
 * the surface is cursor paged. A `failed`/`timed-out` execution is therefore a
 * genuine correction/repair signal, not a fixed developer scenario.
 */
export interface PeerOwnerForegroundExecution {
  readonly dispatchedAt: number
  readonly status: 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'unknown'
  readonly quiescent: boolean
  readonly completedAt: number
  readonly executionRef: string
  readonly modelSelectionState?: 'missing' | 'frozen' | 'inconsistent'
  readonly modelSelection?: Readonly<{ provider: string; model: string; reasoningEffort?: string }>
}

export interface PeerOwnerForegroundTaskSource {
  readonly protocol: string
  readonly inboxId: string
  readonly sourceDigest: string
  readonly completionSequence: number
  readonly authorityId: string
  readonly authorityHash: string
  readonly principalId: string
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly binding: Readonly<{ id: string; version: number; generation: number; sessionId: string }>
  readonly execution: Readonly<PeerOwnerForegroundExecution>
  readonly owner?: Readonly<{ principalRecordId: string; principalVersion: number }>
  readonly termination?: Readonly<{ protocol: 'assistant-delivery/foreground-termination/v1'; producer: string; kind: string;
    causeCode: string; handleDisposed: boolean; effects: 'unknown'; replay: 'forbidden' }>
}

export interface PeerOwnerForegroundTaskSourcePage {
  readonly items: readonly PeerOwnerForegroundTaskSource[]
  readonly nextCursor: unknown
  readonly watermark: number
  readonly hasMore: boolean
}

export interface PeerForegroundSourceScope {
  authorityId: string; principalId: string; workspace: string; agentPreset: string
  expectedOwner: Readonly<{ authorityHash: string; principalRecordId: string; principalVersion: number }>
}

/** One page of the current authenticated human turn, tied to its real tool call. */
export interface PeerOwnerForegroundToolInput {
  readonly protocol: 'assistant-delivery/foreground-tool-input/v1'
  readonly attestation: Readonly<{
    protocol: 'assistant-delivery/foreground-tool-call/v1'
    task: { protocol: 'assistant-delivery/foreground-task/v1'; inboxId: string; sessionId: string;
      scope: { workspace: string; preset: string }; owner: { principalRecordId: string; principalVersion: number };
      binding: { id: string; version: number; generation: number }; dispatchedAt: number }
    turn: number
    call: { id: string; toolName: string; eventSeq: number; eventDigest: string; argumentsDigest: string }
  }>
  readonly sourceDigest: string
  readonly modelSelectionState: 'missing' | 'frozen' | 'inconsistent'
  readonly modelSelection?: Readonly<{ provider: string; model: string; reasoningEffort?: string }>
  readonly input: Readonly<{ text: string; fullTextDigest: string; fullBytes: number; returnedBytes: number; offset: number; nextOffset?: number }>
}

/** `assistant-delivery` surfaces used by this plugin. */
export interface PeerDeliveryService {
  validateOwnerAgentForRoute?(agent: import('@deepseek-ai/dsh-agent').Agent, authorityId: string): Readonly<PeerOwnerRouteReceipt> | undefined
  inspectOwnerForegroundToolCall?(input: Readonly<{ agent: import('@deepseek-ai/dsh-agent').Agent; authorityId: string;
    callId: string; toolName: string; argumentsJson: string }>): unknown
  readOwnerForegroundToolInput?(input: Readonly<{ agent: import('@deepseek-ai/dsh-agent').Agent; authorityId: string;
    callId: string; toolName: string; argumentsJson: string; offset?: number; maxBytes?: number }>): Readonly<PeerOwnerForegroundToolInput> | undefined
  validateOwnerRoute(input: {
    authorityId: string
    principalId: string
    workspace: string
    agentPreset: string
  }): Readonly<PeerOwnerRouteReceipt>
  inspectOwnerRouteState?(input: {
    authorityId: string
    principalId: string
    workspace: string
    agentPreset: string
  }): PeerOwnerRouteInspection
  /**
   * Read-only, owner-authenticated page of foreground task sources.
   *
   * Optional: older delivery versions do not expose it, and a missing method
   * degenerates the automatic source to a no-op instead of failing activation.
   */
  listOwnerForegroundTaskSources?(input: {
    authorityId: string
    principalId: string
    workspace: string
    agentPreset: string
    expectedOwner: Readonly<{ authorityHash: string; principalRecordId: string; principalVersion: number }>
    after?: unknown
    limit?: number
  }): Readonly<PeerOwnerForegroundTaskSourcePage>
  inspectOwnerForegroundTaskSource?(input: PeerForegroundSourceScope & { inboxId: string }): Readonly<PeerOwnerForegroundTaskSource> | undefined
  readOwnerForegroundTaskInput?(input: PeerForegroundSourceScope & { inboxId: string; expectedSourceDigest: string; offset?: number; maxBytes?: number }): Readonly<{
    source: PeerOwnerForegroundTaskSource; sourceDigest: string; contentDigest: string;
    input: { text: string; fullTextDigest: string; fullBytes: number; returnedBytes: number; offset: number; nextOffset?: number }
  }> | undefined
  enqueueBackground(input: {
    sourceId: string
    workspace: string
    bindingId: string
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'plain'
    metadata?: Readonly<Record<string, string>>
  }): { readonly id: string } | Promise<{ readonly id: string }>
}

/** `assistant-automations` external-event intake. */
export interface PeerAutomationsService {
  inspectProductionOccurrence?(input: { automationId: string; occurrenceId: string; workspace: string; agentPreset: string }): ProductionOccurrenceTerminalProjection | undefined
  hostAgentAuthorizationVersion?(): 1
  runAgentForHostExecution?(input: HostAutomationExecutorInput, contract: HostAgentExecutionContract, authorization?: HostAgentAuthorizationFence): Promise<Readonly<HostAgentExecutionResult>>
  registerHostExecutor?(executor: HostAutomationExecutor): () => void
  reconcileSystem?(input: { owner: string; automationId: string; idempotencyKey: string; definition: HostAutomationDefinition; desiredStatus: 'active' }): AutomationRecord
  inspectSystemOwned?(input: { owner: string; automationId: string }): { owner: string; automationId: string; automationStatus: string; definitionHash: string; definitionVersion: number; latestTerminalRuns?: { production?: { occurrenceId?: string; status: string; executionMode: string; diagnostic: { budgetSettlementState: string }; immutableContext: { state: 'unknown' } | { state: 'verified'; definitionHash: string; definitionVersion: number; scope: { workspace: string; agentPreset: string } } } } }
  inspectSystemOwnedActivation?(input: { owner: string; automationId: string }): Readonly<{ definitionHash: string; activationNonce: string; ownerRouteId: string }> | undefined
  /** Native scheduler lifecycle notification; absent on older peers. */
  onSchedulerWake?(listener: () => void): () => void
  ingestExternal(input: {
    sourceId: string
    automationId: string
    eventId: string
    occurredAt: number
    envelope?: unknown
  }): { readonly id: string; readonly automationId: string }
}
