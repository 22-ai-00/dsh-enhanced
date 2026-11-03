import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { TrustedWorkItemOwnerFeedbackProof } from './types.js'

function invalid(): never { throw new Error('invalid work-item owner feedback proof') }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length !== 0) invalid()
  const entries = Object.getOwnPropertyDescriptors(value)
  if (!required.every(key => Object.hasOwn(entries, key))
    || Object.keys(entries).some(key => !required.includes(key) && !optional.includes(key))
    || !Object.values(entries).every(item => item.enumerable && 'value' in item)) invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, maximum = 1_000): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum
    && value.normalize('NFC').trim() === value && !/[\p{Cc}]/u.test(value)
}
function integer(value: unknown, minimum = 1): boolean { return Number.isSafeInteger(value) && Number(value) >= minimum }
function hash(value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function content(value: unknown): boolean { return typeof value === 'string' && Buffer.byteLength(value) <= 1_048_576 }

/** Shape checking accompanies, and never replaces, a current producer capability. */
export function validateWorkItemOwnerFeedbackProof(value: unknown, now: number): Readonly<TrustedWorkItemOwnerFeedbackProof> {
  const proof = record(value, ['protocol','itemId','reportRevision','reportDigest','sourceId','itemKind','scope','owner',
    'originBindingId','production','supplier','planDigest','task','report','proofDigest'])
  const scope = record(proof.scope, ['workspace','preset'])
  const owner = record(proof.owner, ['ownerRouteId','principalId','principalRecordId','principalVersion'])
  const production = record(proof.production, ['automationId','occurrenceId','runId','definitionHash','definitionVersion',
    'executionStatus','completedAt','quiescent','budgetSettlementState'])
  const supplier = record(proof.supplier, ['provider','model'], ['reasoningEffort'])
  const task = record(proof.task, ['brief','briefTruncated'])
  const report = record(proof.report, ['status','text','truncated','recordedAt'])
  if (proof.protocol !== 'assistant-work-items/owner-report-feedback/v1'
    || ![proof.itemId,proof.sourceId,proof.itemKind,proof.originBindingId,scope.preset,
      owner.ownerRouteId,owner.principalId,owner.principalRecordId,production.automationId,production.occurrenceId,
      production.runId,supplier.provider,supplier.model].every(item => text(item))
    || !text(scope.workspace, 4_096) || !integer(proof.reportRevision) || !integer(owner.principalVersion)
    || !integer(production.definitionVersion) || !integer(production.completedAt)
    || Number(production.completedAt) > now || production.quiescent !== true || production.budgetSettlementState !== 'finalized'
    || !['succeeded','failed','timed-out','cancelled'].includes(String(production.executionStatus))
    || ![proof.reportDigest,proof.planDigest,proof.proofDigest,production.definitionHash].every(hash)
    || (Object.hasOwn(supplier,'reasoningEffort') && !text(supplier.reasoningEffort))
    || !content(task.brief) || typeof task.briefTruncated !== 'boolean'
    || !['ready','blocked','failed'].includes(String(report.status)) || !content(report.text)
    || typeof report.truncated !== 'boolean' || !integer(report.recordedAt)
    || Number(report.recordedAt) > Number(production.completedAt)) invalid()
  const { proofDigest: _digest, ...basis } = proof
  if (acceptanceDigest(basis) !== proof.proofDigest) invalid()
  return Object.freeze(JSON.parse(JSON.stringify(value)) as TrustedWorkItemOwnerFeedbackProof)
}
