import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ForegroundToolCallAttestation, OwnerForegroundToolInput } from '@dsh-enhanced/assistant-delivery'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalScope } from './types.js'

/** Frozen identity of the authenticated owner request that authorized one native goal. */
export const OWNER_INTENT_PROTOCOL = 'assistant-goals/owner-intent/v1'
/** Complete persisted human input is bounded; larger input cannot be proven in one intent. */
export const MAX_OWNER_INTENT_INPUT_BYTES = 65_536
/** Delivery serves at most 8192 bytes per page; Goals asks for a fixed conservative page. */
export const OWNER_INTENT_PAGE_BYTES = 4_096

const HEX = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u
const objectiveLimit = 16_384

export interface GoalOwnerIntentSupplier {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface GoalOwnerIntent {
  protocol: typeof OWNER_INTENT_PROTOCOL
  /** Delivery source digest: task, original envelope, full human text and frozen model state. */
  sourceDigest: string
  inputSha256: string
  inputBytes: number
  fullTextDigest: string
  text: string
  objective: { text: string; start: number; end: number }
  owner: { principalRecordId: string; principalVersion: number }
  scope: { workspace: string; preset: string }
  sessionId: string
  binding: { id: string; version: number; generation: number }
  call: { id: string; toolName: string; argumentsDigest: string }
  supplier: GoalOwnerIntentSupplier
  turn: number
  at: number
}

/** Host-only proof surface consumed by Goals; never reachable from model tool arguments. */
export interface GoalOwnerIntentDelivery {
  inspectOwnerForegroundToolCallForAgent(agent: Agent, input: Readonly<{
    callId: string; toolName: string; argumentsJson: string
  }>): Readonly<ForegroundToolCallAttestation> | undefined
  readOwnerForegroundToolInputForAgent(agent: Agent, input: Readonly<{
    callId: string; toolName: string; argumentsJson: string; offset?: number; maxBytes?: number
  }>): Readonly<OwnerForegroundToolInput> | undefined
}

export interface BuildGoalOwnerIntentInput {
  delivery: GoalOwnerIntentDelivery
  agent: Agent
  execution: ToolExecution
  scope: GoalScope
  /** Total persisted-input byte bound, for focused tests; production uses the maximum. */
  maxBytes?: number
}

function fail(message: string): never { throw new Error(`assistant-goals: owner intent ${message}`) }
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => plain(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min
const utf8 = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value
const textId = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
const pathText = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/')
  && Buffer.byteLength(value, 'utf8') <= 4_096 && !/\p{Cc}/u.test(value)
const supplierPart = (value: unknown): value is string => typeof value === 'string' && value.trim() === value
  && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 4_096 && !/\p{Cc}/u.test(value)
const validSupplier = (value: unknown): value is GoalOwnerIntentSupplier => {
  if (!plain(value) || Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) return false
  return [value.provider, value.model, ...(value.reasoningEffort === undefined ? [] : [value.reasoningEffort])].every(supplierPart)
}
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * Locate the model-supplied objective inside the authenticated owner text.
 *
 * The objective must already be trimmed, non-empty and UTF-8 clean, and it
 * must occur verbatim in the owner text. Repeated occurrences are permitted but
 * only the first occurrence is frozen: the intent pins exactly one canonical
 * span so later consumers can prove which owner words authorized the goal.
 * Absence fails closed; paraphrases and normalized text are not owner quotes.
 */
export function ownerIntentObjectiveSpan(text: string, objective: string): { start: number; end: number } {
  if (typeof text !== 'string' || !utf8(text) || Buffer.byteLength(text, 'utf8') < 1) fail('owner text is invalid')
  if (typeof objective !== 'string' || objective.length < 1 || objective.length > objectiveLimit || objective.trim() !== objective || !utf8(objective)) {
    fail('objective must be a trimmed, non-empty UTF-8 owner quote')
  }
  const start = text.indexOf(objective)
  if (start < 0) fail(`objective must quote the owner's original words verbatim; the authenticated owner request does not contain it`)
  return Object.freeze({ start, end: start + objective.length })
}

function goalCreateObjective(value: unknown): string {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length !== 0) fail('requires the plain live goal_create arguments')
  if (Object.keys(value).some(key => !['objective', 'max_goal_rounds', 'start_native_rounds', 'acceptance'].includes(key))) fail('received unknown goal_create arguments')
  const objective = value.objective
  if (typeof objective !== 'string' || objective.length < 1 || objective.length > objectiveLimit
    || objective.trim() !== objective || !utf8(objective)) fail('objective must be a trimmed, non-empty UTF-8 owner quote')
  return objective
}

function toolProof(proof: Readonly<ForegroundToolCallAttestation> | undefined, execution: ToolExecution,
  agent: Agent, scope: GoalScope): Readonly<ForegroundToolCallAttestation> {
  if (!proof || typeof proof !== 'object' || proof.protocol !== 'assistant-delivery/foreground-tool-call/v1') fail('proof is unavailable')
  const task = proof.task
  if (!task || typeof task !== 'object' || task.protocol !== 'assistant-delivery/foreground-task/v1'
    || typeof task.inboxId !== 'string' || task.inboxId.length < 1 || task.inboxId.length > 512
    || task.sessionId !== String(agent.session.id)
    || !task.scope || task.scope.workspace !== scope.workspace || task.scope.preset !== scope.preset
    || !task.owner || task.owner.principalRecordId !== scope.principalRecordId || task.owner.principalVersion !== scope.principalVersion
    || !task.binding || typeof task.binding.id !== 'string' || !BINDING_ID.test(task.binding.id)
    || !integer(task.binding.version, 1) || !integer(task.binding.generation, 1) || !integer(task.dispatchedAt)) fail('proof identity differs from the authenticated owner turn')
  if (!integer(proof.turn) || !proof.call || proof.call.id !== String(execution.callId)
    || proof.call.toolName !== execution.name || !integer(proof.call.eventSeq)
    || typeof proof.call.eventDigest !== 'string' || !HEX.test(proof.call.eventDigest)
    || typeof proof.call.argumentsDigest !== 'string' || !HEX.test(proof.call.argumentsDigest)) fail('proof does not describe the live goal_create call')
  return proof
}

type GoalOwnerIntentPage = Readonly<OwnerForegroundToolInput> & { readonly input: Readonly<OwnerForegroundToolInput['input']> }

function inputPage(page: Readonly<OwnerForegroundToolInput> | undefined, proof: Readonly<ForegroundToolCallAttestation>,
  expectedOffset: number, byteBound: number): GoalOwnerIntentPage {
  if (!page || typeof page !== 'object' || page.protocol !== 'assistant-delivery/foreground-tool-input/v1') fail('human input reader is unavailable')
  if (typeof page.sourceDigest !== 'string' || !HEX.test(page.sourceDigest)) fail('human input source digest is invalid')
  if (page.modelSelectionState !== 'frozen' || !validSupplier(page.modelSelection)) fail('human input supplier is not frozen')
  if (!page.attestation || page.attestation.protocol !== 'assistant-delivery/foreground-tool-call/v1'
    || acceptanceDigest(page.attestation) !== acceptanceDigest(proof)) fail('human input proof differs from the goal_create call')
  const data = page.input
  if (!data || typeof data.text !== 'string' || !utf8(data.text)
    || typeof data.fullTextDigest !== 'string' || !HEX.test(data.fullTextDigest)
    || !integer(data.fullBytes, 1) || data.fullBytes > byteBound
    || data.offset !== expectedOffset || data.returnedBytes !== Buffer.byteLength(data.text, 'utf8')
    || data.returnedBytes < 1 || data.returnedBytes > OWNER_INTENT_PAGE_BYTES
    || expectedOffset + data.returnedBytes > data.fullBytes
    || (data.nextOffset === undefined ? expectedOffset + data.returnedBytes !== data.fullBytes
      : data.nextOffset !== expectedOffset + data.returnedBytes || data.nextOffset >= data.fullBytes)) fail('human input page binding differs')
  return page
}

/**
 * Freeze the authenticated owner request behind one live goal_create call.
 *
 * The proof is read twice (once before pagination and once after each read and
 * at the end) and pagination is byte-exact: every page must carry the same
 * task/call/model-state identity and the reassembled text must match the
 * delivery full-text digest and byte count. Missing, forged, PTC, settled or
 * concurrently changed calls fail closed; no intent is returned.
 */
export function buildGoalOwnerIntent(input: BuildGoalOwnerIntentInput): GoalOwnerIntent {
  const { delivery, agent, execution, scope } = input
  if (!delivery || typeof delivery.inspectOwnerForegroundToolCallForAgent !== 'function'
    || typeof delivery.readOwnerForegroundToolInputForAgent !== 'function') fail('proof is unavailable')
  if (!agent || !execution || typeof execution !== 'object' || execution.agent !== agent || execution.name !== 'goal_create') {
    fail('requires the live goal_create call')
  }
  if (execution.parent !== undefined) fail('requires a top-level native call, not a PTC sub-call')
  if (execution.signal?.aborted === true) fail('call was cancelled')
  if (typeof execution.callId !== 'string' || execution.callId.length < 1 || execution.callId.length > 512) fail('call identity is invalid')
  const objective = goalCreateObjective(execution.arguments)
  const byteBound = input.maxBytes ?? MAX_OWNER_INTENT_INPUT_BYTES
  if (!Number.isSafeInteger(byteBound) || byteBound < 1 || byteBound > MAX_OWNER_INTENT_INPUT_BYTES) fail('byte bound is invalid')
  if (!scope || typeof scope !== 'object' || !textId(scope.principalRecordId) || !integer(scope.principalVersion, 1)
    || !pathText(scope.workspace) || !textId(scope.preset)) fail('owner scope is invalid')
  let argumentsJson: string
  try { argumentsJson = JSON.stringify(execution.arguments) } catch { fail('arguments are not serializable') }
  const call = { callId: String(execution.callId), toolName: execution.name, argumentsJson }
  const inspect = () => {
    if (execution.agent !== agent || execution.name !== 'goal_create' || execution.signal?.aborted === true) fail('call changed during pagination')
    return delivery.inspectOwnerForegroundToolCallForAgent(agent, call)
  }
  const firstProof = toolProof(inspect(), execution, agent, scope)
  let offset = 0, text = '', pages = 0
  let first: GoalOwnerIntentPage | undefined
  let identity: string | undefined
  const pageBound = Math.ceil(byteBound / OWNER_INTENT_PAGE_BYTES) + 1
  for (;;) {
    if (++pages > pageBound) fail('input exceeds the page bound')
    const page = inputPage(delivery.readOwnerForegroundToolInputForAgent(agent, { ...call, offset, maxBytes: OWNER_INTENT_PAGE_BYTES }), firstProof, offset, byteBound)
    const current = toolProof(inspect(), execution, agent, scope)
    if (acceptanceDigest(current) !== acceptanceDigest(firstProof)) fail('proof changed during pagination')
    const pageIdentity = JSON.stringify([page.sourceDigest, page.modelSelectionState, page.modelSelection, page.input.fullTextDigest, page.input.fullBytes])
    if (first === undefined) { first = page; identity = pageIdentity }
    else if (pageIdentity !== identity || page.sourceDigest !== first.sourceDigest) fail('human input changed during pagination')
    text += page.input.text
    if (Buffer.byteLength(text, 'utf8') > byteBound) fail('human input exceeds the byte bound')
    if (page.input.nextOffset === undefined) break
    offset = page.input.nextOffset
  }
  if (acceptanceDigest(toolProof(inspect(), execution, agent, scope)) !== acceptanceDigest(firstProof)) fail('proof changed during pagination')
  const pagesFirst = first!
  if (Buffer.byteLength(text, 'utf8') !== pagesFirst.input.fullBytes || sha256(text) !== pagesFirst.input.fullTextDigest) fail('human input full digest differs')
  const span = ownerIntentObjectiveSpan(text, objective)
  const supplier = pagesFirst.modelSelection
  if (!validSupplier(supplier)) fail('human input supplier is not frozen')
  return validateGoalOwnerIntent({
    protocol: OWNER_INTENT_PROTOCOL,
    sourceDigest: pagesFirst.sourceDigest,
    inputSha256: sha256(text),
    inputBytes: Buffer.byteLength(text, 'utf8'),
    fullTextDigest: pagesFirst.input.fullTextDigest,
    text,
    objective: { text: objective, start: span.start, end: span.end },
    owner: { principalRecordId: firstProof.task.owner.principalRecordId, principalVersion: firstProof.task.owner.principalVersion },
    scope: { workspace: firstProof.task.scope.workspace, preset: firstProof.task.scope.preset },
    sessionId: firstProof.task.sessionId,
    binding: { id: firstProof.task.binding.id, version: firstProof.task.binding.version, generation: firstProof.task.binding.generation },
    call: { id: firstProof.call.id, toolName: firstProof.call.toolName, argumentsDigest: firstProof.call.argumentsDigest },
    supplier: { provider: supplier.provider, model: supplier.model, ...(supplier.reasoningEffort === undefined ? {} : { reasoningEffort: supplier.reasoningEffort }) },
    turn: firstProof.turn,
    at: Date.now(),
  })
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) frozen(child); Object.freeze(value) }
  return value
}

/** Strict exact-key validation of one persisted intent; any drift fails closed. */
export function validateGoalOwnerIntent(value: unknown): GoalOwnerIntent {
  const keys = ['protocol', 'sourceDigest', 'inputSha256', 'inputBytes', 'fullTextDigest', 'text', 'objective', 'owner', 'scope', 'sessionId', 'binding', 'call', 'supplier', 'turn', 'at']
  if (!exact(value, keys)) fail('identity is invalid')
  const intent = value as unknown as Record<string, unknown>
  if (intent.protocol !== OWNER_INTENT_PROTOCOL
    || typeof intent.sourceDigest !== 'string' || !HEX.test(intent.sourceDigest)
    || typeof intent.fullTextDigest !== 'string' || !HEX.test(intent.fullTextDigest)
    || typeof intent.text !== 'string' || Buffer.byteLength(intent.text, 'utf8') < 1 || !utf8(intent.text)
    || !integer(intent.inputBytes, 1) || intent.inputBytes > MAX_OWNER_INTENT_INPUT_BYTES || Buffer.byteLength(intent.text, 'utf8') !== intent.inputBytes
    || intent.inputSha256 !== sha256(intent.text)
    || !exact(intent.objective, ['text', 'start', 'end'])
    || typeof intent.objective.text !== 'string' || intent.objective.text.length < 1 || intent.objective.text.length > objectiveLimit
    || intent.objective.text.trim() !== intent.objective.text || !utf8(intent.objective.text)
    || !integer(intent.objective.start) || !integer(intent.objective.end)
    || intent.objective.end !== intent.objective.start + intent.objective.text.length
    || intent.text.slice(intent.objective.start, intent.objective.end) !== intent.objective.text
    || !exact(intent.owner, ['principalRecordId', 'principalVersion']) || !textId(intent.owner.principalRecordId) || !integer(intent.owner.principalVersion, 1)
    || !exact(intent.scope, ['workspace', 'preset']) || !pathText(intent.scope.workspace) || !textId(intent.scope.preset)
    || !textId(intent.sessionId)
    || !exact(intent.binding, ['id', 'version', 'generation']) || typeof intent.binding.id !== 'string' || !BINDING_ID.test(intent.binding.id)
    || !integer(intent.binding.version, 1) || !integer(intent.binding.generation, 1)
    || !exact(intent.call, ['id', 'toolName', 'argumentsDigest']) || !textId(intent.call.id) || intent.call.toolName !== 'goal_create'
    || typeof intent.call.argumentsDigest !== 'string' || !HEX.test(intent.call.argumentsDigest)
    || !validSupplier(intent.supplier) || !integer(intent.turn) || !integer(intent.at)) fail('identity is invalid')
  return frozen(JSON.parse(JSON.stringify(intent)) as GoalOwnerIntent)
}
