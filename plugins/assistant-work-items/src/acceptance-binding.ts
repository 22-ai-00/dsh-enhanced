/**
 * WP21 slice 4: independent acceptance binding for execute decisions.
 *
 * A decision may name an already-prepared TaskAcceptanceContract by handle.
 * Admission re-reads that contract from `assistant-verifier` itself, checks it
 * against the item's owner scope, and freezes a summary into the mandate. The
 * item's completion is then read back only from the verifier's own receipt:
 * neither the decision caller nor the worker can supply a contract body or a
 * verdict, and a worker `ready` report stays a self-report.
 */

import {
  acceptanceDigest,
  validateTaskAcceptanceContract,
  validateTaskVerificationReceipt,
  type TaskAcceptanceContract,
} from '@dsh-enhanced/task-acceptance-contract'
import type { PeerOwnerRouteReceipt, PeerVerifierService } from './peers.ts'
import type {
  WorkItemAcceptanceAuthor,
  WorkItemAcceptanceBinding,
  WorkItemAcceptanceHandle,
  WorkItemAcceptanceSettleResult,
  WorkItemAcceptanceVerdict,
  WorkItemDecisionRefusal,
  WorkItemRecord,
} from './types.ts'
import { WorkItemError } from './types.ts'

export const ACCEPTANCE_BINDING_PROTOCOL = 'work-items/acceptance-binding/v1'
/** The only identity whose receipt may settle a bound item. */
export const ACCEPTANCE_VERIFIER = 'assistant-verifier'
/** The executing side; it may never author or verify its own acceptance. */
export const ACCEPTANCE_EXECUTOR = 'assistant-work-items'

/** Same shape the acceptance wire contract uses for ids. */
export const ACCEPTANCE_CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const AUTHORS: readonly WorkItemAcceptanceAuthor[] = ['assistant-automations', 'assistant-delivery', 'assistant-goals']
const MAX_CRITERIA = 1_000

/**
 * The Host producer that froze a contract, derived from its task kind. The
 * verifier accepts each kind only from its one registered producer, so the
 * kind is a faithful author identity; an unknown kind has no author.
 */
export function acceptanceAuthorFor(taskKind: string): WorkItemAcceptanceAuthor | undefined {
  switch (taskKind) {
    case 'automation-run': return 'assistant-automations'
    case 'foreground-turn': return 'assistant-delivery'
    case 'goal-step':
    case 'goal-outcome': return 'assistant-goals'
    default: return undefined
  }
}

/** Author, verifier and executor must be three distinct identities. */
export function acceptanceIsIndependent(identities: Readonly<{ author: string; verifier: string; executor: string }>): boolean {
  const { author, verifier, executor } = identities
  return author !== verifier && author !== executor && verifier !== executor
}

function inspect(verifier: PeerVerifierService | undefined, contractId: string) {
  if (verifier === undefined || typeof verifier.inspectAcceptedTask !== 'function') return { kind: 'unavailable' as const, detail: 'assistantVerifier is not connected' }
  try {
    return { kind: 'read' as const, value: verifier.inspectAcceptedTask(contractId) }
  } catch (error) {
    return { kind: 'unavailable' as const, detail: error instanceof Error ? error.message : String(error) }
  }
}

function validContract(value: unknown): TaskAcceptanceContract | undefined {
  try {
    return validateTaskAcceptanceContract(value)
  } catch {
    return undefined
  }
}

/**
 * Resolve a decision's acceptance handle into a frozen binding.
 *
 * Pure apart from the read-only verifier call; every refusal is a value and
 * happens before any durable write. The contract must be the exact one the
 * handle names, for exactly this owner scope, unexpired, and not yet
 * verified: a receipt that predates the work cannot complete it.
 */
export function resolveAcceptanceBinding(
  verifier: PeerVerifierService | undefined,
  handle: WorkItemAcceptanceHandle,
  owner: PeerOwnerRouteReceipt,
  now: number,
  /**
   * Late binding of a worker run's own contract (WP21 slice 6): the contract
   * must name exactly `taskRef`, and `pending` is also accepted because that
   * run's evidence cannot predate the run the contract was frozen for.
   */
  late?: Readonly<{ taskRef: string }>,
): WorkItemAcceptanceBinding | WorkItemDecisionRefusal {
  const read = inspect(verifier, handle.contractId)
  if (read.kind === 'unavailable' || read.value === null || read.value === undefined) return 'acceptance-unavailable'
  const contract = validContract(read.value.contract)
  if (contract === undefined || contract.id !== handle.contractId || contract.digest !== handle.contractDigest
    || contract.scope.workspace !== owner.workspace || contract.scope.preset !== owner.agentPreset
    || contract.owner.principalRecordId !== owner.principalRecordId || contract.owner.principalVersion !== owner.principalVersion
    || (late !== undefined && (contract.task.kind !== 'automation-run' || contract.task.ref !== late.taskRef))) {
    return 'acceptance-mismatch'
  }
  if (contract.expiresAt <= now) return 'acceptance-expired'
  if (read.value.state === 'done' || read.value.state === 'needs-attention' || read.value.receipt !== null) return 'acceptance-already-settled'
  // Only a contract nobody has started verifying may bind new work; a pending
  // or verifying one could settle on evidence gathered before this item ran.
  if (read.value.state !== 'awaiting-execution' && (late === undefined || read.value.state !== 'pending')) return 'acceptance-not-awaiting'
  const author = acceptanceAuthorFor(contract.task.kind)
  if (author === undefined || !acceptanceIsIndependent({ author, verifier: ACCEPTANCE_VERIFIER, executor: ACCEPTANCE_EXECUTOR })) {
    return 'acceptance-not-independent'
  }
  return Object.freeze({
    protocol: ACCEPTANCE_BINDING_PROTOCOL,
    verifier: ACCEPTANCE_VERIFIER,
    author,
    contractId: contract.id,
    contractDigest: contract.digest,
    taskKind: contract.task.kind,
    taskDigest: acceptanceDigest(contract.task),
    objectiveDigest: acceptanceDigest(contract.objective),
    profileDigest: contract.profile.digest,
    criteria: contract.criteria.length,
    expiresAt: contract.expiresAt,
  })
}

/**
 * The acceptance task ref Automations freezes for the worker run of one
 * occurrence: task id `task-<occurrenceId>`, ref `run-<taskId>`. Coupled to
 * Automations' id derivation on purpose, so a contract for any other run of
 * the same automation can never bind this item.
 */
export function workerRunTaskRef(occurrenceId: string): string {
  return `run-task-${occurrenceId}`
}

/** Structural check of a stored binding; anything else makes the mandate malformed. */
export function acceptanceBindingIsUsable(value: unknown): value is WorkItemAcceptanceBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const binding = value as Record<string, unknown>
  const keys = ['protocol', 'verifier', 'author', 'contractId', 'contractDigest', 'taskKind', 'taskDigest', 'objectiveDigest', 'profileDigest', 'criteria', 'expiresAt']
  if (Object.keys(binding).length !== keys.length || !keys.every(key => Object.hasOwn(binding, key))) return false
  const author = binding['author']
  const criteria = binding['criteria']
  const expiresAt = binding['expiresAt']
  return binding['protocol'] === ACCEPTANCE_BINDING_PROTOCOL
    && binding['verifier'] === ACCEPTANCE_VERIFIER
    && typeof author === 'string' && (AUTHORS as readonly string[]).includes(author)
    && typeof binding['taskKind'] === 'string' && acceptanceAuthorFor(binding['taskKind']) === author
    && acceptanceIsIndependent({ author, verifier: ACCEPTANCE_VERIFIER, executor: ACCEPTANCE_EXECUTOR })
    && typeof binding['contractId'] === 'string' && ACCEPTANCE_CONTRACT_ID.test(binding['contractId'])
    && ['contractDigest', 'taskDigest', 'objectiveDigest', 'profileDigest'].every(key => typeof binding[key] === 'string' && DIGEST.test(binding[key]))
    && typeof criteria === 'number' && Number.isSafeInteger(criteria) && criteria >= 0 && criteria <= MAX_CRITERIA
    && typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt > 0
}

/** Durable verdict sink; the store keeps one verdict per item. */
export interface AcceptanceVerdictSink {
  acceptanceVerdict(itemId: string): WorkItemAcceptanceVerdict | undefined
  recordAcceptanceVerdict(verdict: Omit<WorkItemAcceptanceVerdict, 'recordedAt'>): Readonly<{ verdict: WorkItemAcceptanceVerdict; created: boolean }>
}

/**
 * Read one bound item's verdict back from the independent verifier.
 *
 * Takes no verdict input. The verifier must still hold the exact frozen
 * contract, and its receipt must validate against that contract; the
 * objective status is the one `validateTaskVerificationReceipt` derives from
 * criterion results. Anything short of a validated receipt writes nothing.
 */
export function settleAcceptance(
  sink: AcceptanceVerdictSink,
  verifier: PeerVerifierService | undefined,
  item: WorkItemRecord,
  binding: WorkItemAcceptanceBinding,
): WorkItemAcceptanceSettleResult {
  const recorded = sink.acceptanceVerdict(item.id)
  if (recorded !== undefined) {
    // First receipt wins, but only for the contract this binding froze.
    if (recorded.contractId !== binding.contractId || recorded.contractDigest !== binding.contractDigest) {
      return Object.freeze({ outcome: 'drift', detail: 'recorded verdict is for another contract' })
    }
    return Object.freeze({ outcome: 'already-verified', verdict: recorded })
  }
  const read = inspect(verifier, binding.contractId)
  if (read.kind === 'unavailable') return Object.freeze({ outcome: 'unavailable', detail: read.detail })
  if (read.value === null || read.value === undefined) return Object.freeze({ outcome: 'drift', detail: 'verifier no longer holds the bound contract' })
  const contract = validContract(read.value.contract)
  if (contract === undefined || contract.id !== binding.contractId || contract.digest !== binding.contractDigest) {
    return Object.freeze({ outcome: 'drift', detail: 'verifier contract differs from the frozen binding' })
  }
  const state = read.value.state
  if (state === 'needs-attention') return Object.freeze({ outcome: 'needs-attention', reason: read.value.reason })
  if (state !== 'done') return Object.freeze({ outcome: 'pending', state })
  let receipt
  try {
    receipt = validateTaskVerificationReceipt(contract, read.value.receipt)
  } catch (error) {
    return Object.freeze({ outcome: 'drift', detail: `verifier receipt is invalid: ${error instanceof Error ? error.message : String(error)}` })
  }
  // Defensive: validateTaskVerificationReceipt already binds the receipt to
  // this contract's id and digest, so this cannot fire for a valid receipt.
  if (receipt.contractId !== binding.contractId || receipt.contractDigest !== binding.contractDigest) {
    return Object.freeze({ outcome: 'drift', detail: 'verifier receipt is for another contract' })
  }
  // Evidence gathered before this item existed cannot complete it.
  if (receipt.startedAt < item.createdAt) {
    return Object.freeze({ outcome: 'drift', detail: 'verifier receipt predates the work item' })
  }
  let result
  try {
    result = sink.recordAcceptanceVerdict({
      itemId: item.id,
      verifier: ACCEPTANCE_VERIFIER,
      contractId: binding.contractId,
      contractDigest: binding.contractDigest,
      receiptId: receipt.id,
      receiptDigest: receipt.digest,
      objectiveStatus: receipt.objectiveStatus,
      completedAt: receipt.completedAt,
    })
  } catch (error) {
    // A different receipt already won (first-receipt-wins); report, never overwrite.
    const existing = error instanceof WorkItemError && error.code === 'identity-mismatch' ? sink.acceptanceVerdict(item.id) : undefined
    if (existing === undefined) throw error
    return Object.freeze({ outcome: 'identity-mismatch', verdict: existing, receiptDigest: receipt.digest })
  }
  return Object.freeze({ outcome: result.created ? 'verified' : 'already-verified', verdict: result.verdict })
}
