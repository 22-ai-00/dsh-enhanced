import { symbols } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { NormalizedConfig } from './config.js'
import type { PeerDeliveryService, PeerOwnerRouteReceipt, PeerPolicyService } from './peers.js'
import type { WorkItemStore } from './store.js'
import { WorkItemError } from './types.js'

export type OwnerWorkItemExecution = Pick<ToolExecution, 'agent' | 'callId' | 'name' | 'arguments' | 'signal'>
export type OwnerStoreScope = Parameters<WorkItemStore['listOwnerItems']>[0]
export interface WorkItemOwnerAccessDependencies {
  config: NormalizedConfig
  store: () => WorkItemStore | undefined
  delivery: () => PeerDeliveryService | undefined
  policy: () => PeerPolicyService | undefined
  access?: WorkItemOwnerAccess
}
// Shared across read and continuation entrypoints, including separate access instances.
const busy = new WeakSet<object>()
const peerIdentity = (value: object | undefined): unknown => value === undefined ? undefined : (value as Record<symbol, unknown>)[symbols.original] ?? value
export function ownerArgumentsOf(value: unknown, allowed: readonly string[], label = 'owner recall'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new WorkItemError('invalid-input', `${label} requires plain arguments`)
  const output: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new WorkItemError('invalid-input', `unknown ${label} argument`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined || !['number', 'string'].includes(typeof descriptor.value)) throw new WorkItemError('invalid-input', `invalid ${label} argument`)
    output[key] = descriptor.value
  }
  return Object.freeze(output)
}
export interface WorkItemOwnerAccessContext {
  store: WorkItemStore
  owner: Readonly<OwnerStoreScope>
  route: Readonly<PeerOwnerRouteReceipt>
  delivery: PeerDeliveryService
  assertCurrent: () => void
}

/** Exact current native-call authority shared by owner reads and continuation.
 * No cached proof grants later execution; every downstream boundary rechecks. */
export class WorkItemOwnerAccess {
  constructor(private readonly dependencies: WorkItemOwnerAccessDependencies) {}
  withOwner<T>(execution: OwnerWorkItemExecution, args: Record<string, unknown>, allowed: readonly string[],
    action: 'inspect-work-items' | 'continue-work-items', consume: boolean, callback: (context: WorkItemOwnerAccessContext) => T): T {
    const { config } = this.dependencies, scope = config.scope, continuing = action === 'continue-work-items'
    const label = continuing ? 'owner continuation' : 'owner recall'
    function fail(message: string): never { throw new WorkItemError('identity-mismatch', `${label} ${message}`) }
    const automationId = continuing ? config.ownerContinuation?.automationId : config.workerAutomationId
    if (!config.ownerRecall || !config.enabled || config.mode !== 'active' || !scope || !config.workerAutomationId || !automationId
      || continuing && !config.ownerContinuation) fail('is disabled')
    if (continuing ? execution.name !== 'work_item_continue' : !['work_item_list', 'work_item_recall'].includes(execution.name)) fail('tool identity mismatch')
    if (acceptanceCanonicalJson(args) !== acceptanceCanonicalJson(ownerArgumentsOf(execution.arguments, allowed, label))) fail('arguments do not match the actual call')
    const agent = execution.agent
    if (!agent || busy.has(agent)) fail('requires a non-reentrant foreground caller')
    busy.add(agent)
    try {
      const delivery = this.dependencies.delivery(), policy = this.dependencies.policy(), store = this.dependencies.store()
      if (!delivery?.validateOwnerAgentForRoute || !delivery.inspectOwnerForegroundToolCall || !policy?.authorizeAgent || !policy.evaluateAgent || !store || store.closed) fail('peers unavailable')
      if (typeof execution.callId !== 'string' || execution.callId.length === 0 || execution.callId.length > 512) fail('requires actual call identity')
      const expiresAt = continuing ? Math.min(scope.expiresAt, config.ownerContinuation!.expiresAt) : scope.expiresAt
      const argumentsJson = JSON.stringify(ownerArgumentsOf(execution.arguments, allowed, label)), name = execution.name, callId = execution.callId, signal = execution.signal
      const deliveryIdentity = peerIdentity(delivery), policyIdentity = peerIdentity(policy)
      const observe = () => {
        if (execution.agent !== agent || execution.signal !== signal || execution.name !== name || execution.callId !== callId
          || JSON.stringify(ownerArgumentsOf(execution.arguments, allowed, label)) !== argumentsJson
          || peerIdentity(this.dependencies.delivery()) !== deliveryIdentity || peerIdentity(this.dependencies.policy()) !== policyIdentity || this.dependencies.store() !== store
          || store.closed || signal.aborted || Date.now() >= expiresAt) fail('authority changed')
        const route = delivery.validateOwnerAgentForRoute!(agent, scope.ownerRouteId)
        if (!route || route.receiptVersion !== 2 || route.authorityId !== scope.ownerRouteId || route.principalId !== scope.principalId
          || route.workspace !== scope.workspace || route.agentPreset !== scope.preset || typeof route.authorityHash !== 'string' || !route.authorityHash || !route.principalRecordId
          || !Number.isSafeInteger(route.principalVersion) || route.principalVersion < 1 || !Number.isSafeInteger(route.generation) || route.generation < 1
          || !Number.isSafeInteger(route.bindingVersion) || route.bindingVersion < 1) fail('requires the current exact owner')
        const proof = delivery.inspectOwnerForegroundToolCall!({ agent, authorityId: scope.ownerRouteId, callId: String(execution.callId), toolName: execution.name, argumentsJson })
        if (!proof || typeof proof !== 'object' || (proof as { protocol?: unknown }).protocol !== 'assistant-delivery/foreground-tool-call/v1') fail('requires an actual human foreground tool call')
        return { route: { receiptVersion: route.receiptVersion, authorityId: route.authorityId, authorityHash: route.authorityHash,
          principalId: route.principalId, principalRecordId: route.principalRecordId, principalVersion: route.principalVersion,
          workspace: route.workspace, agentPreset: route.agentPreset, bindingVersion: route.bindingVersion, generation: route.generation }, proof: acceptanceDigest(proof) }
      }
      const initial = observe(), identity = acceptanceDigest(initial)
      const current = () => { if (acceptanceDigest(observe()) !== identity) fail('owner/call changed') }
      const resource = Object.freeze({ kind: 'automation' as const, id: automationId })
      const evaluate = () => {
        current(); const decision = policy.evaluateAgent!(agent, action, resource); current()
        if (decision?.effect !== 'allow') fail(continuing ? 'permission denied' : 'read permission denied')
      }
      evaluate()
      if (consume) {
        const decision = policy.authorizeAgent!(agent, action, resource, { idempotencyKey: `${continuing ? 'work-items-owner-continue' : 'work-items-owner-read'}:${acceptanceDigest({ owner: initial.route, sessionId: String(agent.session.id), callId: execution.callId, name: execution.name, args })}` })
        current(); if (decision?.effect !== 'allow') fail(continuing ? 'permission denied' : 'read permission denied')
      }
      evaluate()
      const owner: OwnerStoreScope = { principalId: initial.route.principalId, principalRecordId: initial.route.principalRecordId,
        principalVersion: initial.route.principalVersion, workspace: scope.workspace, preset: scope.preset, ownerRouteId: scope.ownerRouteId,
        workerAutomationId: config.workerAutomationId, ...(config.ownerContinuation ? { continuationAutomationId: config.ownerContinuation.automationId } : {}),
        generation: initial.route.generation, bindingVersion: initial.route.bindingVersion }
      const result = callback({ store, owner: Object.freeze(owner), route: Object.freeze(initial.route), delivery, assertCurrent: evaluate })
      evaluate(); return result
    } finally { busy.delete(agent) }
  }
}
