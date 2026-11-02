import { symbols } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { NormalizedConfig } from './config.js'
import { truncateUtf8 } from './config.js'
import type { PeerDeliveryService, PeerPolicyService } from './peers.js'
import type { WorkItemStore } from './store.js'
import { WorkItemError, type WorkItemRecord, type WorkItemResumeReport } from './types.js'

export interface OwnerWorkItemListInput { after?: string; limit?: number }
export interface OwnerWorkItemRecallInput { item_id: string; report_revision?: number; offset?: number; max_bytes?: number }
export type OwnerWorkItemExecution = Pick<ToolExecution, 'agent' | 'callId' | 'name' | 'arguments' | 'signal'>
export interface OwnerWorkItemSummary {
  itemId: string; kind: string; title: string; state: string; stateReason: string | null;
  lastReport?: WorkItemResumeReport; attempt: number; maxAttempts: number; lastReportStatus: string | null; observed: boolean; createdAt: number; updatedAt: number
}
type StoreOwner = Parameters<WorkItemStore['listOwnerItems']>[0]
/** Cordis associates a fresh consumer-context proxy on each get(). Compare
 * its public original-provider identity while continuing to call the proxy. */
function peerIdentity(value: object | undefined): unknown {
  return value === undefined ? undefined : (value as Record<symbol, unknown>)[symbols.original] ?? value
}
function fail(message: string): never { throw new WorkItemError('identity-mismatch', message) }
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new WorkItemError('invalid-input', 'invalid owner recall byte/count window')
  return value
}
function argumentsOf(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new WorkItemError('invalid-input', 'owner recall requires plain arguments')
  const output: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new WorkItemError('invalid-input', 'unknown owner recall argument')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined
      || !['number', 'string'].includes(typeof descriptor.value)) throw new WorkItemError('invalid-input', 'invalid owner recall argument')
    output[key] = descriptor.value
  }
  return Object.freeze(output)
}
function summary(item: WorkItemRecord): Readonly<OwnerWorkItemSummary> {
  return Object.freeze({ itemId: item.id, kind: item.kind, title: truncateUtf8(item.title, 256).value,
    state: item.state, stateReason: item.stateReason === null ? null : truncateUtf8(item.stateReason, 128).value,
    attempt: item.attempt, maxAttempts: item.maxAttempts, lastReportStatus: item.lastReportStatus,
    observed: item.observed, createdAt: item.createdAt, updatedAt: item.updatedAt })
}

/** Separate foreground read capability. It never admits, recovers, claims or dispatches. */
export class WorkItemOwnerRecall {
  readonly #busy = new WeakSet<object>()
  constructor(private readonly dependencies: {
    config: NormalizedConfig; store: () => WorkItemStore | undefined;
    delivery: () => PeerDeliveryService | undefined; policy: () => PeerPolicyService | undefined;
  }) {}

  #arguments(execution: OwnerWorkItemExecution, input: unknown, name: string): Record<string, unknown> {
    if (execution.name !== name) fail('owner recall tool identity mismatch')
    const allowed = name === 'work_item_list' ? ['after', 'limit'] : ['item_id', 'report_revision', 'offset', 'max_bytes']
    const args = argumentsOf(input, allowed)
    if (acceptanceCanonicalJson(args) !== acceptanceCanonicalJson(argumentsOf(execution.arguments, allowed))) fail('owner recall arguments do not match the actual call')
    return args
  }

  #withOwner<T>(execution: OwnerWorkItemExecution, args: Record<string, unknown>, consume: boolean,
    read: (store: WorkItemStore, owner: StoreOwner) => T): T {
    const { config } = this.dependencies, scope = config.scope
    if (!config.ownerRecall || !config.enabled || config.mode !== 'active' || !scope || !config.workerAutomationId) fail('owner recall is disabled')
    const agent = execution.agent
    if (!agent || this.#busy.has(agent)) fail('owner recall requires a non-reentrant foreground caller')
    this.#busy.add(agent)
    try {
      const delivery = this.dependencies.delivery(), policy = this.dependencies.policy(), store = this.dependencies.store()
      if (!delivery?.validateOwnerAgentForRoute || !delivery.inspectOwnerForegroundToolCall
        || !policy?.authorizeAgent || !policy.evaluateAgent || !store || store.closed) fail('owner recall peers unavailable')
      if (typeof execution.callId !== 'string' || execution.callId.length === 0 || execution.callId.length > 512) fail('owner recall requires actual call identity')
      const rawArguments = argumentsOf(execution.arguments, execution.name === 'work_item_list' ? ['after', 'limit'] : ['item_id', 'report_revision', 'offset', 'max_bytes'])
      const argumentsJson = JSON.stringify(rawArguments), name = execution.name, callId = execution.callId, signal = execution.signal
      const deliveryIdentity = peerIdentity(delivery), policyIdentity = peerIdentity(policy)
      const observe = () => {
        if (execution.agent !== agent || execution.signal !== signal || execution.name !== name || execution.callId !== callId
          || JSON.stringify(argumentsOf(execution.arguments, name === 'work_item_list' ? ['after', 'limit'] : ['item_id', 'report_revision', 'offset', 'max_bytes'])) !== argumentsJson
          || peerIdentity(this.dependencies.delivery()) !== deliveryIdentity || peerIdentity(this.dependencies.policy()) !== policyIdentity || this.dependencies.store() !== store
          || store.closed || signal.aborted || Date.now() >= scope.expiresAt) fail('owner recall authority changed')
        const route = delivery.validateOwnerAgentForRoute!(agent, scope.ownerRouteId)
        if (!route || route.receiptVersion !== 2 || route.authorityId !== scope.ownerRouteId
          || route.principalId !== scope.principalId || route.workspace !== scope.workspace || route.agentPreset !== scope.preset
          || typeof route.authorityHash !== 'string' || !route.authorityHash || !route.principalRecordId
          || !Number.isSafeInteger(route.principalVersion) || route.principalVersion < 1
          || !Number.isSafeInteger(route.generation) || route.generation < 1
          || !Number.isSafeInteger(route.bindingVersion) || route.bindingVersion < 1) fail('owner recall requires the current exact owner')
        const proof = delivery.inspectOwnerForegroundToolCall!({ agent, authorityId: scope.ownerRouteId,
          callId: String(execution.callId), toolName: execution.name, argumentsJson })
        if (!proof || typeof proof !== 'object' || (proof as { protocol?: unknown }).protocol !== 'assistant-delivery/foreground-tool-call/v1') fail('owner recall requires an actual human foreground tool call')
        return { route: { receiptVersion: route.receiptVersion, authorityId: route.authorityId, authorityHash: route.authorityHash,
          principalId: route.principalId, principalRecordId: route.principalRecordId, principalVersion: route.principalVersion,
          workspace: route.workspace, agentPreset: route.agentPreset, bindingVersion: route.bindingVersion, generation: route.generation },
          proof: acceptanceDigest(proof) }
      }
      const initial = observe(), identity = acceptanceDigest(initial)
      const current = () => { if (acceptanceDigest(observe()) !== identity) fail('owner recall owner/call changed') }
      const resource = Object.freeze({ kind: 'automation' as const, id: config.workerAutomationId })
      const evaluate = () => {
        current()
        const decision = policy.evaluateAgent!(agent, 'inspect-work-items', resource)
        current()
        if (decision?.effect !== 'allow') fail('owner recall read permission denied')
      }
      evaluate()
      if (consume) {
        const decision = policy.authorizeAgent(agent, 'inspect-work-items', resource, { idempotencyKey: `work-items-owner-read:${acceptanceDigest({
          owner: initial.route, sessionId: String(agent.session.id), callId: execution.callId, name: execution.name, args })}` })
        current()
        if (decision?.effect !== 'allow') fail('owner recall read permission denied')
      }
      evaluate()
      const owner: StoreOwner = { principalId: initial.route.principalId, principalRecordId: initial.route.principalRecordId,
        principalVersion: initial.route.principalVersion, workspace: scope.workspace, preset: scope.preset,
        ownerRouteId: scope.ownerRouteId, workerAutomationId: config.workerAutomationId,
        generation: initial.route.generation, bindingVersion: initial.route.bindingVersion }
      const result = read(store, Object.freeze(owner))
      evaluate()
      return result
    } finally { this.#busy.delete(agent) }
  }

  preauthorize(execution: OwnerWorkItemExecution): boolean {
    try {
      const args = this.#arguments(execution, execution.arguments, execution.name)
      if (!['work_item_list', 'work_item_recall'].includes(execution.name)) return false
      this.#validate(args, execution.name)
      return this.#withOwner(execution, args, false, () => true)
    } catch { return false }
  }

  #validate(args: Record<string, unknown>, name: string): void {
    if (name === 'work_item_list') {
      if (args.limit !== undefined) integer(args.limit, 1, 20)
      if (args.after !== undefined && (typeof args.after !== 'string' || args.after.length < 1 || args.after.length > 2048)) throw new WorkItemError('invalid-input', 'invalid owner recall cursor')
    } else {
      if (typeof args.item_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(args.item_id)) throw new WorkItemError('invalid-input', 'invalid owner recall item selector')
      if (args.report_revision !== undefined) integer(args.report_revision, 1, Number.MAX_SAFE_INTEGER)
      if (args.offset !== undefined) integer(args.offset, 0, Number.MAX_SAFE_INTEGER)
      if (args.max_bytes !== undefined) integer(args.max_bytes, 4, 8192)
    }
  }

  list(execution: OwnerWorkItemExecution, input: OwnerWorkItemListInput) {
    const args = this.#arguments(execution, input, 'work_item_list'); this.#validate(args, execution.name)
    return this.#withOwner(execution, args, true, (store, owner) => {
      const ownerDigest = acceptanceDigest(owner)
      const after = args.after === undefined ? undefined : this.#decodeCursor(String(args.after), ownerDigest)
      const limit = args.limit === undefined ? 10 : Number(args.limit)
      const rows = store.listOwnerItems(owner, after, limit + 1), items = rows.slice(0, limit)
      const last = items.at(-1)
      return Object.freeze({ items: Object.freeze(items.map(item => {
        const last = store.lastReport(item.id)
        const cut = last ? truncateUtf8(store.ownerRecallText(item.id, last.revision), 512) : undefined
        return Object.freeze({ ...summary(item), ...(last && cut ? { lastReport: Object.freeze({ revision: last.revision, status: last.status,
          summary: cut.value, summaryTruncated: last.truncated || cut.truncated, recordedAt: last.recordedAt }) } : {}) })
      })), ...(rows.length > limit && last
        ? { nextCursor: this.#cursor({ createdAt: last.createdAt, id: last.id, owner: ownerDigest }) } : {}) })
    })
  }

  recall(execution: OwnerWorkItemExecution, input: OwnerWorkItemRecallInput) {
    const args = this.#arguments(execution, input, 'work_item_recall'); this.#validate(args, execution.name)
    return this.#withOwner(execution, args, true, (store, owner) => {
      const item = store.listOwnerItems(owner, undefined, 1, String(args.item_id))[0]
      if (!item) throw new WorkItemError('not-found', 'no owner work item matches this selector')
      const found = args.report_revision === undefined ? undefined : store.reportByRevision(item.id, Number(args.report_revision))
      const report = found?.report
      if (args.report_revision !== undefined && !report) throw new WorkItemError('not-found', 'no report matches this item revision')
      const bytes = Buffer.from(store.ownerRecallText(item.id, report?.revision), 'utf8'), offset = Number(args.offset ?? 0), maximum = Number(args.max_bytes ?? 4096)
      if (offset > bytes.length || offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new WorkItemError('invalid-input', 'offset is not a valid UTF-8 boundary')
      let end = Math.min(bytes.length, offset + maximum)
      while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
      const resume = store.workItemResumeContext(item.id)
      if (!resume) throw new WorkItemError('not-found', 'owner work item disappeared')
      return Object.freeze({ item: summary(item), content: Object.freeze({ kind: report ? 'report' as const : 'brief' as const,
        ...(report ? { reportRevision: report.revision, status: report.status, recordedAt: report.recordedAt,
          ...(found?.previousRevision == null ? {} : { previousRevision: found.previousRevision }),
          ...(found?.nextRevision == null ? {} : { nextRevision: found.nextRevision }) } : {}), text: bytes.subarray(offset, end).toString('utf8'), fullBytes: bytes.length,
        returnedBytes: end - offset, offset, ...(end < bytes.length ? { nextOffset: end } : {}),
        storedTruncated: report?.truncated ?? item.briefTruncated }), reports: Object.freeze(resume.reports.map(report => {
          const cut = truncateUtf8(store.ownerRecallText(item.id, report.revision), 512)
          return Object.freeze({ ...report, summary: cut.value, summaryTruncated: report.summaryTruncated || cut.truncated })
        })), reportsTotal: resume.reportsTotal,
        latestOutcome: resume.latestOutcome })
    })
  }

  #cursor(value: { createdAt: number; id: string; owner: string }): string {
    return Buffer.from(acceptanceCanonicalJson(value)).toString('base64url')
  }
  #decodeCursor(cursor: string, owner: string): { createdAt: number; id: string } {
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error('encoding')
      const bytes = Buffer.from(cursor, 'base64url')
      if (bytes.toString('base64url') !== cursor) throw new Error('encoding')
      const value = JSON.parse(bytes.toString('utf8')) as { createdAt: number; id: string; owner: string }
      if (!value || Object.keys(value).sort().join() !== 'createdAt,id,owner'
        || value.owner !== owner || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
        || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.id)
        || acceptanceCanonicalJson(value) !== bytes.toString('utf8')) throw new Error('scope or shape')
      return value
    } catch { throw new WorkItemError('invalid-input', 'invalid or foreign owner recall cursor') }
  }
}
