import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { truncateUtf8 } from './config.js'
import type { WorkItemContinuation } from './continuation.js'
import type { ContinuationSource } from './continuation-contract.js'
import { MAX_CONTINUATION_INPUT_BYTES, continuationDigest, continuationSourceKey, type WorkItemContinuationAdmission } from './continuation-record.js'
import { WorkItemOwnerAccess, ownerArgumentsOf, type OwnerWorkItemExecution, type WorkItemOwnerAccessContext, type WorkItemOwnerAccessDependencies } from './owner-access.js'
import type { PeerOwnerForegroundToolInput } from './peers.js'
import { WorkItemError, type WorkItemAdmitInput, type WorkItemAdmitResult } from './types.js'

export interface OwnerWorkItemContinueInput { item_id: string }
export interface WorkItemOwnerContinuationDependencies extends WorkItemOwnerAccessDependencies {
  runtime: () => WorkItemContinuation | undefined
  admit: (input: WorkItemAdmitInput, continuation: WorkItemContinuationAdmission) => WorkItemAdmitResult
}
const HEX = /^[a-f0-9]{64}$/u
const ALLOWED = ['item_id'] as const
const PAGE = 8192
function fail(message: string): never { throw new WorkItemError('identity-mismatch', `owner continuation ${message}`) }
function argumentsOf(execution: OwnerWorkItemExecution, input: unknown): Record<string, unknown> {
  if (execution.name !== 'work_item_continue') fail('tool identity mismatch')
  const args = ownerArgumentsOf(input, ALLOWED, 'owner continuation')
  if (typeof args.item_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(args.item_id)) throw new WorkItemError('invalid-input', 'invalid owner continuation item selector')
  return args
}
function validModel(value: PeerOwnerForegroundToolInput['modelSelection']): value is NonNullable<PeerOwnerForegroundToolInput['modelSelection']> {
  return !!value && typeof value.provider === 'string' && typeof value.model === 'string'
    && Object.keys(value).every(key => ['provider', 'model', 'reasoningEffort'].includes(key))
    && [value.provider, value.model, ...(value.reasoningEffort === undefined ? [] : [value.reasoningEffort])].every(part => typeof part === 'string' && part.trim() === part && part.length > 0 && Buffer.byteLength(part) <= 4096 && !/\p{Cc}/u.test(part))
}

/** The model chooses only an owner-filtered parent id. The new instruction and
 * supplier come exclusively from the current persisted human foreground task. */
export class WorkItemOwnerContinuation {
  readonly #access: WorkItemOwnerAccess
  constructor(private readonly dependencies: WorkItemOwnerContinuationDependencies) { this.#access = dependencies.access ?? new WorkItemOwnerAccess(dependencies) }

  #readPage(execution: OwnerWorkItemExecution, context: WorkItemOwnerAccessContext, offset: number): Readonly<PeerOwnerForegroundToolInput> {
    context.assertCurrent()
    const read = context.delivery.readOwnerForegroundToolInput
    if (!read || !execution.agent) fail('live human input reader is unavailable')
    const page = read.call(context.delivery, { agent: execution.agent, authorityId: context.route.authorityId, callId: String(execution.callId),
      toolName: execution.name, argumentsJson: JSON.stringify(ownerArgumentsOf(execution.arguments, ALLOWED, 'owner continuation')), offset, maxBytes: PAGE })
    context.assertCurrent()
    const proof = context.delivery.inspectOwnerForegroundToolCall!({ agent: execution.agent, authorityId: context.route.authorityId,
      callId: String(execution.callId), toolName: execution.name, argumentsJson: JSON.stringify(execution.arguments) })
    if (!page || page.protocol !== 'assistant-delivery/foreground-tool-input/v1' || !HEX.test(page.sourceDigest)
      || page.modelSelectionState !== 'frozen' || !validModel(page.modelSelection)
      || page.attestation?.protocol !== 'assistant-delivery/foreground-tool-call/v1' || acceptanceDigest(page.attestation) !== acceptanceDigest(proof)) fail('human input or actual supplier is unproven')
    const task = page.attestation.task, data = page.input
    if (!task || !task.scope || !task.owner || !task.binding || task.protocol !== 'assistant-delivery/foreground-task/v1' || task.sessionId !== String(execution.agent.session.id)
      || task.scope.workspace !== context.route.workspace || task.scope.preset !== context.route.agentPreset
      || task.owner.principalRecordId !== context.route.principalRecordId || task.owner.principalVersion !== context.route.principalVersion
      || task.binding.version !== context.route.bindingVersion || task.binding.generation !== context.route.generation
      || typeof task.binding.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(task.binding.id)
      || typeof data?.text !== 'string' || Buffer.from(data.text, 'utf8').toString('utf8') !== data.text || !HEX.test(data.fullTextDigest)
      || !Number.isSafeInteger(data.fullBytes) || data.fullBytes < 1 || data.fullBytes > MAX_CONTINUATION_INPUT_BYTES
      || data.offset !== offset || data.returnedBytes !== Buffer.byteLength(data.text) || data.returnedBytes < 1 || data.returnedBytes > PAGE
      || offset + data.returnedBytes > data.fullBytes || (data.nextOffset === undefined ? offset + data.returnedBytes !== data.fullBytes
        : data.nextOffset !== offset + data.returnedBytes || data.nextOffset >= data.fullBytes)) fail('human input page binding differs')
    return page
  }

  preauthorize(execution: OwnerWorkItemExecution): boolean {
    try {
      const args = argumentsOf(execution, execution.arguments), runtime = this.dependencies.runtime()
      if (!runtime) return false
      return this.#access.withOwner(execution, args, ALLOWED, 'continue-work-items', false, context => {
        if (!context.store.listOwnerItems(context.owner, undefined, 1, String(args.item_id))[0]) return false
        this.#readPage(execution, context, 0)
        return this.dependencies.runtime() === runtime
      })
    } catch { return false }
  }

  continue(execution: OwnerWorkItemExecution, input: OwnerWorkItemContinueInput): Readonly<{ itemId: string; parentItemId: string; rootItemId: string; state: string; replayed: boolean }> {
    const args = argumentsOf(execution, input), runtime = this.dependencies.runtime()
    if (!runtime) throw new WorkItemError('missing-dependency', 'owner continuation runtime is unavailable')
    return this.#access.withOwner(execution, args, ALLOWED, 'continue-work-items', true, context => {
      const parent = context.store.listOwnerItems(context.owner, undefined, 1, String(args.item_id))[0]
      if (!parent) throw new WorkItemError('not-found', 'no owner work item matches this continuation selector')
      const first = this.#readPage(execution, context, 0), firstFingerprint = acceptanceDigest(first)
      const identity = acceptanceCanonicalJson({ attestation: first.attestation, sourceDigest: first.sourceDigest,
        modelSelection: first.modelSelection, fullTextDigest: first.input.fullTextDigest, fullBytes: first.input.fullBytes })
      let page = first, text = '', count = 0
      for (;;) {
        if (++count > 34 || acceptanceCanonicalJson({ attestation: page.attestation, sourceDigest: page.sourceDigest,
          modelSelection: page.modelSelection, fullTextDigest: page.input.fullTextDigest, fullBytes: page.input.fullBytes }) !== identity) fail('human input changed during pagination')
        text += page.input.text
        if (Buffer.byteLength(text) > MAX_CONTINUATION_INPUT_BYTES) fail('human input exceeds byte bound')
        if (page.input.nextOffset === undefined) break
        page = this.#readPage(execution, context, page.input.nextOffset)
      }
      if (Buffer.byteLength(text) !== first.input.fullBytes || continuationDigest(text) !== first.input.fullTextDigest) fail('human input full digest differs')
      const source: ContinuationSource = Object.freeze({ sourceDigest: first.sourceDigest, inputText: text, modelSelection: Object.freeze({ ...first.modelSelection! }) })
      const assertCurrent = () => {
        context.assertCurrent()
        if (this.dependencies.runtime() !== runtime || acceptanceDigest(this.#readPage(execution, context, 0)) !== firstFingerprint) fail('source or runtime changed before admission')
      }
      assertCurrent()
      const continuation = runtime.prepare(parent.id, source, assertCurrent)
      if (continuation.parentItemId !== parent.id || continuation.sourceDigest !== source.sourceDigest || continuation.sourceKey !== continuationSourceKey(parent.id, source.sourceDigest)) fail('runtime admission identity differs')
      assertCurrent()
      const result = this.dependencies.admit({ kind: 'owner-continuation', externalId: continuation.sourceKey,
        title: truncateUtf8(`Continue: ${parent.title}`, 256).value,
        brief: 'Continue this owner task. Call work_item_read_context to read the authenticated owner instruction and linked history before acting.',
        originBindingId: first.attestation.task.binding.id,
        provenance: { source: 'owner-continuation', sourceVersion: 'assistant-work-items/owner-continuation/v1', signalDigest: source.sourceDigest,
          observedAt: Date.now(), evidence: { parentItemId: parent.id, sourceDigest: source.sourceDigest } } }, continuation)
      assertCurrent()
      const record = context.store.getContinuation(result.item.id)
      if (!record || record.parentItemId !== parent.id || record.sourceKey !== continuation.sourceKey || record.sourceDigest !== source.sourceDigest
        || record.rootItemId !== (context.store.getContinuation(parent.id)?.rootItemId ?? parent.id)
        || result.item.workerAutomationId !== this.dependencies.config.ownerContinuation!.automationId) fail('admitted continuation record differs')
      runtime.wakePending()
      assertCurrent()
      return Object.freeze({ itemId: result.item.id, parentItemId: record.parentItemId, rootItemId: record.rootItemId,
        state: context.store.findItemById(result.item.id)?.state ?? result.item.state, replayed: !result.created })
    })
  }
}
