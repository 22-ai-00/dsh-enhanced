/**
 * P1-4 revision benefit evidence. Windows are built only from the revision
 * journal's foreground-attributed entry calls and the Host-certified task
 * heads they belong to; the creation-capability association ledger is never
 * consulted. Parent and candidate windows are paired before/after the revision
 * adoption: equal-length, adjacent at the candidate adoption instant.
 */
import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService, EvaluationCanonicalLearningEvidenceTuple, TrustedTaskLearningProjectionReceipt } from '@dsh-enhanced/assistant-evaluation'
import { evaluateRevisionBenefit, revisionBenefitContractDigest, validateRevisionBenefitWindowStats,
  type RevisionBenefitContract, type RevisionBenefitEvaluation, type RevisionBenefitWindowStats } from '@dsh-enhanced/assistant-growth-contract'
import { controlPlaneDigest } from './store.js'
import type { CreationCapabilityOwner } from './creation-capability-types.js'
import type { RevisionCapabilityBenefitSample, RevisionCapabilityCallEvidence,
  RevisionCapabilityRollbackRecord } from './revision-capability-types.js'

type Evaluation = Pick<AssistantEvaluationService, 'canonicalHostScope' | 'getTrustedForegroundLearningProjection'
  | 'withTrustedCanonicalTaskWriterFence'> & Partial<Pick<AssistantEvaluationService, 'inspectTrustedOutcomeMetrics'>>
type Delivery = Pick<AssistantDeliveryService, 'inspectOwnerForegroundLearningTask' | 'inspectOwnerForegroundTaskSource'>

/** Evidence windows are bounded to at most one day, as in the creation ledger. */
export const REVISION_BENEFIT_MAX_WINDOW_MS = 86_400_000

export interface RevisionBenefitWindowRange { start: number; end: number }
export interface RevisionBenefitPairedWindows {
  candidate: RevisionBenefitWindowRange
  parent: RevisionBenefitWindowRange
}

/**
 * Equal-length adjacent windows around the candidate adoption:
 * parent [adoptedAt - W, adoptedAt], candidate [adoptedAt, adoptedAt + W].
 * W is bounded by the candidate signed lifetime, the candidate serving time
 * observed so far, the parent history before adoption and one day.
 */
export function revisionBenefitPairedWindows(input: {
  candidate: RevisionCapabilityBenefitSample
  parent: Readonly<{ adoptedAt: number; expiresAt: number }>
  now: number
}): RevisionBenefitPairedWindows | undefined {
  const { candidate, parent, now } = input
  const adoption = candidate.version.adoptedAt
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(adoption) || adoption > now) return undefined
  if (candidate.version.role !== 'revision') return undefined
  if (!Number.isSafeInteger(parent.adoptedAt) || !Number.isSafeInteger(parent.expiresAt) || parent.adoptedAt >= adoption) return undefined
  const lifetime = Math.min(REVISION_BENEFIT_MAX_WINDOW_MS, candidate.version.expiresAt - adoption, now - adoption)
  const history = Math.min(REVISION_BENEFIT_MAX_WINDOW_MS, adoption - parent.adoptedAt)
  const length = Math.min(lifetime, history)
  if (!Number.isSafeInteger(length) || length < 1) return undefined
  const candidateRange = Object.freeze({ start: adoption, end: adoption + length })
  const parentRange = Object.freeze({ start: adoption - length, end: adoption })
  if (candidateRange.end > candidate.version.expiresAt || parentRange.end > parent.expiresAt) return undefined
  return Object.freeze({ candidate: candidateRange, parent: parentRange })
}

/**
 * Observation deadline used by the terminal rollback: the end of the paired
 * candidate window, so the keep/rollback decision uses the same W as the
 * evaluator instead of a lifetime-only cap.
 */
export function revisionBenefitObservationDeadline(input: {
  candidate: RevisionCapabilityBenefitSample
  parent: Readonly<{ adoptedAt: number; expiresAt: number }>
  now: number
}): number | undefined {
  return revisionBenefitPairedWindows(input)?.candidate.end
}

/** True only for equal-length, adjacent parent-then-candidate windows. */
export function revisionBenefitWindowsArePaired(parent: RevisionBenefitWindowRange, candidate: RevisionBenefitWindowRange): boolean {
  return Number.isSafeInteger(parent.start) && Number.isSafeInteger(parent.end) && Number.isSafeInteger(candidate.start)
    && Number.isSafeInteger(candidate.end) && parent.end === candidate.start
    && candidate.end - candidate.start === parent.end - parent.start && parent.end > parent.start
}

/** Sums two disjoint evidence sources over the exact same window. */
export function mergeRevisionBenefitWindows(left: RevisionBenefitWindowStats, right: RevisionBenefitWindowStats):
RevisionBenefitWindowStats | undefined {
  if (left.windowStart !== right.windowStart || left.windowEnd !== right.windowEnd) return undefined
  const merged: RevisionBenefitWindowStats = { ...left,
    taskRevisions: left.taskRevisions + right.taskRevisions,
    correctedOrWithdrawn: left.correctedOrWithdrawn + right.correctedOrWithdrawn,
    failed: left.failed + right.failed, reworked: left.reworked + right.reworked,
    latencyMsTotal: left.latencyMsTotal + right.latencyMsTotal,
    tokensTotal: left.tokensTotal + right.tokensTotal,
    inputTokensTotal: left.inputTokensTotal + right.inputTokensTotal,
    outputTokensTotal: left.outputTokensTotal + right.outputTokensTotal }
  try { validateRevisionBenefitWindowStats(merged) } catch { return undefined }
  return merged
}

interface BenefitRow {
  inboxId: string
  sessionId: string
  callKeys: readonly string[]
  status: 'achieved' | 'not-achieved'
  ownerRevisionAction: 'initial' | 'correct' | 'withdraw'
  latencyMs?: number
  tokens?: { input: number; output: number }
}

export interface RevisionBenefitFeedbackInput {
  sample: RevisionCapabilityBenefitSample
  windowStart: number
  windowEnd: number
  owner: CreationCapabilityOwner
  evaluation: Evaluation
  delivery: Delivery
  now?: number
}

const same = (left: unknown, right: unknown): boolean => controlPlaneDigest(left) === controlPlaneDigest(right)
type Execution = { quiescent: boolean; dispatchedAt: number; completedAt: number }
const taskLatencyMs = (execution: Execution | undefined): number | undefined =>
  execution?.quiescent && Number.isSafeInteger(execution.completedAt) && Number.isSafeInteger(execution.dispatchedAt)
    && execution.completedAt >= execution.dispatchedAt ? execution.completedAt - execution.dispatchedAt : undefined

/** Exact foreground calls of one version inside the window, grouped per Inbox. */
function eligibleCalls(input: RevisionBenefitFeedbackInput):
Map<string, { sessionId: string; calls: RevisionCapabilityCallEvidence[] }> | undefined {
  const { sample, owner } = input, version = sample.version
  const grouped = new Map<string, { sessionId: string; calls: RevisionCapabilityCallEvidence[] }>()
  for (const call of sample.calls) {
    const foreground = call.foreground
    if (call.status !== 'completed' || call.attribution !== 'foreground' || foreground === undefined) continue
    if (call.versionPlanId !== version.planId || call.role !== version.role
      || call.receiptDigest !== version.receiptDigest || call.artifactSha256 !== version.artifactSha256
      || call.schemaDigest !== version.schemaDigest
      || !version.tools.some(tool => tool.name === call.toolAlias)) continue
    const task = foreground.task
    if (task.scope.workspace !== owner.workspace || task.scope.preset !== owner.agentPreset
      || task.owner.principalRecordId !== owner.principalRecordId
      || task.owner.principalVersion !== owner.principalVersion) continue
    if (!Number.isSafeInteger(call.claimedAt) || call.claimedAt < input.windowStart
      || call.claimedAt > input.windowEnd || call.claimedAt < version.adoptedAt
      || call.claimedAt >= version.expiresAt || task.dispatchedAt > call.claimedAt) continue
    if (call.settledAt !== undefined && (!Number.isSafeInteger(call.settledAt)
      || call.settledAt < call.claimedAt || call.settledAt > input.windowEnd || call.settledAt >= version.expiresAt)) continue
    const prior = grouped.get(task.inboxId)
    if (prior !== undefined && prior.sessionId !== task.sessionId) return undefined
    if (prior !== undefined) prior.calls.push(call)
    else grouped.set(task.inboxId, { sessionId: task.sessionId, calls: [call] })
  }
  return grouped
}

function certifiedTask(input: RevisionBenefitFeedbackInput, canonical: TrustedTaskLearningProjectionReceipt | undefined,
  inboxId: string, call: RevisionCapabilityCallEvidence): OwnerForegroundLearningTask | undefined {
  const { owner, delivery } = input
  const task = call.foreground!.task
  if (!canonical || canonical.projection.subjectKind !== 'foreground-turn'
    || canonical.projection.subjectRef !== inboxId || canonical.projection.disposition !== 'upsert') return undefined
  const source = delivery.inspectOwnerForegroundLearningTask({ authorityId: owner.authorityId,
    principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
    outcomeId: canonical.triggerOutcomeId })
  if (!source || source.protocol !== 'assistant-delivery/owner-foreground-learning/v1' || !same(source.canonical, canonical)
    || source.source.inboxId !== inboxId || source.source.truncated || !source.source.quiescent
    || source.source.sessionId !== task.sessionId
    || source.owner.authorityId !== owner.authorityId || source.owner.authorityHash !== owner.authorityHash
    || source.owner.principalId !== owner.principalId
    || source.owner.principalRecordId !== owner.principalRecordId
    || source.owner.principalVersion !== owner.principalVersion || source.owner.workspace !== owner.workspace
    || source.owner.agentPreset !== owner.agentPreset
    || source.owner.bindingVersion !== task.binding.version || source.owner.generation !== task.binding.generation
    || source.ownerRevision?.action === 'withdraw'
    || !['owner-feedback', 'independent-verifier'].includes(source.judgement)
    || !['achieved', 'not-achieved'].includes(source.canonical.objective?.status ?? '')) return undefined
  return source
}

/** Exact Delivery source and execution of one certified foreground task. */
function originalTaskSource(input: RevisionBenefitFeedbackInput, source: OwnerForegroundLearningTask,
  inboxId: string, call: RevisionCapabilityCallEvidence) {
  const { owner, delivery } = input, task = call.foreground!.task
  const original = delivery.inspectOwnerForegroundTaskSource({ authorityId: owner.authorityId,
    principalId: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
    expectedOwner: { authorityHash: owner.authorityHash, principalRecordId: owner.principalRecordId,
      principalVersion: owner.principalVersion }, inboxId })
  if (!original || source.source.sessionId !== original.binding.sessionId
    || source.owner.bindingVersion !== original.binding.version || source.owner.generation !== original.binding.generation
    || original.binding.version !== task.binding.version || original.binding.generation !== task.binding.generation
    || original.authorityId !== owner.authorityId || original.authorityHash !== owner.authorityHash
    || original.principalId !== owner.principalId
    || original.owner.principalRecordId !== owner.principalRecordId
    || original.owner.principalVersion !== owner.principalVersion) return undefined
  return original
}

function readRows(input: RevisionBenefitFeedbackInput,
  grouped: Map<string, { sessionId: string; calls: RevisionCapabilityCallEvidence[] }>):
{ rows: BenefitRow[]; evidence: EvaluationCanonicalLearningEvidenceTuple[]; watermark: number } {
  const { evaluation, owner } = input
  const scope = evaluation.canonicalHostScope({ workspace: owner.workspace, preset: owner.agentPreset })
  const evidence: EvaluationCanonicalLearningEvidenceTuple[] = []
  const rows: BenefitRow[] = []
  let watermark = 0
  for (const [inboxId, group] of grouped) {
    const canonical = evaluation.getTrustedForegroundLearningProjection({ scope, inboxId })
    const source = certifiedTask(input, canonical, inboxId, group.calls[0]!)
    if (!source) throw new Error('revision benefit task source is not current')
    const original = originalTaskSource(input, source, inboxId, group.calls[0]!)
    if (!original) throw new Error('revision benefit task binding changed')
    evidence.push(source.canonical.projection)
    watermark = Math.max(watermark, source.canonical.scopeWatermark)
    const metrics = evaluation.inspectTrustedOutcomeMetrics?.({
      scope, outcomeId: source.canonical.objective?.outcomeId ?? source.canonical.triggerOutcomeId })
    const tokens = metrics === undefined || typeof metrics.inputTokens !== 'number' || typeof metrics.outputTokens !== 'number'
      ? undefined : { input: metrics.inputTokens, output: metrics.outputTokens }
    const latencyMs = taskLatencyMs(original.execution as Execution | undefined)
    rows.push({ inboxId, sessionId: group.sessionId,
      callKeys: group.calls.map(call => call.key).sort(),
      status: source.canonical.objective!.status as 'achieved' | 'not-achieved',
      ownerRevisionAction: (source.ownerRevision?.action ?? 'initial') as BenefitRow['ownerRevisionAction'],
      ...(latencyMs === undefined ? {} : { latencyMs }),
      ...(tokens === undefined ? {} : { tokens }) })
  }
  return { rows, evidence, watermark }
}

/**
 * One revision-benefit window over foreground-attributed entry calls. Rows the
 * owner corrected are excluded from the aggregates and counted separately;
 * withdrawn rows are absent; unmeasured cost/latency stay zero so the evaluator
 * can only return insufficient.
 */
export function inspectRevisionCapabilityBenefitWindow(input: RevisionBenefitFeedbackInput): RevisionBenefitWindowStats | undefined {
  if (!Number.isSafeInteger(input.windowStart) || !Number.isSafeInteger(input.windowEnd)
    || input.windowEnd <= input.windowStart || input.windowEnd < 1) return undefined
  const grouped = eligibleCalls(input)
  if (grouped === undefined) return undefined
  let read: ReturnType<typeof readRows>
  if (grouped.size === 0) read = { rows: [], evidence: [], watermark: 0 }
  else {
    try {
      const before = readRows(input, grouped)
      const scope = input.evaluation.canonicalHostScope({ workspace: input.owner.workspace, preset: input.owner.agentPreset })
      const fenced = input.evaluation.withTrustedCanonicalTaskWriterFence({ scope,
        scopeWatermark: before.watermark, evidence: before.evidence }, () => {
        const during = readRows(input, grouped)
        if (!same(during, before)) throw new Error('revision benefit task source changed')
        return during.rows
      })
      if (!fenced.matched) return undefined
      read = { ...before, rows: fenced.value }
    } catch { return undefined }
  }
  let correctedOrWithdrawn = 0, failed = 0, reworked = 0
  let latencyMsTotal = 0, tokensTotal = 0, inputTokensTotal = 0, outputTokensTotal = 0
  for (const row of read.rows) {
    if (row.ownerRevisionAction !== 'initial') { correctedOrWithdrawn += 1; continue }
    if (row.status === 'not-achieved') failed += 1
    if (row.callKeys.length > 1) reworked += 1
    latencyMsTotal += row.latencyMs ?? 0
    if (row.tokens !== undefined) {
      tokensTotal += row.tokens.input + row.tokens.output
      inputTokensTotal += row.tokens.input
      outputTokensTotal += row.tokens.output
    }
  }
  const stats: RevisionBenefitWindowStats = {
    protocol: 'assistant-growth/revision-benefit-window/v1', artifactSha256: input.sample.version.artifactSha256,
    windowStart: input.windowStart, windowEnd: input.windowEnd, taskRevisions: read.rows.length,
    correctedOrWithdrawn, failed, reworked, latencyMsTotal, tokensTotal, inputTokensTotal, outputTokensTotal,
  }
  try { validateRevisionBenefitWindowStats(stats) } catch { return undefined }
  return stats
}

export interface RevisionBenefitEvidenceEvaluation {
  evaluation: RevisionBenefitEvaluation
  contractDigest: string
  candidate: RevisionBenefitWindowStats
  parent: RevisionBenefitWindowStats
  windows: RevisionBenefitPairedWindows
}

/**
 * Host-only evaluation over equal, adjacent parent/candidate windows. The
 * evaluator refuses any unpaired window data instead of comparing arbitrary
 * ranges.
 */
export function evaluateRevisionBenefitEvidence(input: {
  contract: RevisionBenefitContract
  candidate: RevisionCapabilityBenefitSample
  parent: RevisionBenefitWindowStats
  windows: RevisionBenefitPairedWindows
  owner: CreationCapabilityOwner
  evaluation: Evaluation
  delivery: Delivery
  now: number
}): RevisionBenefitEvidenceEvaluation | undefined {
  try {
    const windows = input.windows
    if (!revisionBenefitWindowsArePaired(windows.parent, windows.candidate)) return undefined
    if (input.parent.windowStart !== windows.parent.start || input.parent.windowEnd !== windows.parent.end) return undefined
    const candidate = inspectRevisionCapabilityBenefitWindow({ sample: input.candidate, windowStart: windows.candidate.start,
      windowEnd: windows.candidate.end, owner: input.owner, evaluation: input.evaluation, delivery: input.delivery, now: input.now })
    if (candidate === undefined || candidate.windowStart !== windows.candidate.start || candidate.windowEnd !== windows.candidate.end) {
      return undefined
    }
    const evaluation = evaluateRevisionBenefit(input.contract, input.parent, candidate, input.now)
    return Object.freeze({ evaluation, contractDigest: revisionBenefitContractDigest(input.contract),
      candidate, parent: input.parent, windows })
  } catch { return undefined }
}

export interface RevisionBenefitRollbackRuntime {
  listEntries(): readonly { entryId: string; currentPlanId: string }[]
  inspectEntry(entryId: string): { currentPlanId: string } | undefined
  rollback(input: { entryId: string; expectedCurrentPlanId: string; signal?: AbortSignal }): Promise<unknown>
}

/**
 * The bounded negative-benefit decision: only a pinned, post-window `inferior`
 * outcome for the entry's exact current plan rolls back to the parent CAS.
 * Everything else leaves the adoption untouched.
 */
export async function autoRollbackInferiorRevision(input: {
  runtime: RevisionBenefitRollbackRuntime | undefined
  planId: string
  benefitConfigured: boolean
  pinnedContractDigest: string | undefined
  growthRunCreatedAt: number | undefined
  observeWindowMs: number
  outcome: { contractDigest: string; status: 'insufficient' | 'inferior' | 'non-inferior'; reason: string } | undefined
  now: number
  /** When set and elapsed, a missing/insufficient result is itself a terminal rollback. */
  observationDeadline?: number
  rollback?: (runtime: RevisionBenefitRollbackRuntime, input: { entryId: string; expectedCurrentPlanId: string }) => Promise<unknown>
}): Promise<{ rolledBack: boolean; reason: string; record?: unknown }> {
  const runtime = input.runtime
  if (!runtime || !input.benefitConfigured) return { rolledBack: false, reason: 'benefit-not-configured' }
  const entry = runtime.listEntries().find(item => item.currentPlanId === input.planId)
  if (entry === undefined) return { rolledBack: false, reason: 'entry-not-found' }
  const current = runtime.inspectEntry(entry.entryId)
  if (!current || current.currentPlanId !== input.planId) return { rolledBack: false, reason: 'not-current' }
  if (input.pinnedContractDigest === undefined) return { rolledBack: false, reason: 'benefit-not-pinned' }
  if (input.observationDeadline !== undefined && input.now >= input.observationDeadline) {
    if (input.outcome !== undefined && input.outcome.contractDigest !== input.pinnedContractDigest) {
      return { rolledBack: false, reason: 'outcome-contract-mismatch' }
    }
  }
  if (input.observationDeadline !== undefined && input.now >= input.observationDeadline
    && (input.outcome === undefined || input.outcome.status !== 'non-inferior')) {
    const reason = input.outcome === undefined ? 'observation-expired-unverified' : 'observation-expired-' + input.outcome.status
    const record = await (input.rollback ?? ((target, value) => target.rollback(value)))(runtime,
      { entryId: entry.entryId, expectedCurrentPlanId: input.planId })
    return { rolledBack: true, reason, record }
  }
  const windowEnd = input.growthRunCreatedAt === undefined ? undefined
    : input.growthRunCreatedAt + Math.max(1, input.observeWindowMs)
  if (windowEnd === undefined || input.now < windowEnd) return { rolledBack: false, reason: 'observation-open' }
  if (input.outcome === undefined || input.outcome.contractDigest !== input.pinnedContractDigest) {
    return { rolledBack: false, reason: 'outcome-missing' }
  }
  if (input.outcome.status !== 'inferior') return { rolledBack: false, reason: 'outcome:' + input.outcome.status }
  const record = await (input.rollback ?? ((target, value) => target.rollback(value)))(runtime,
    { entryId: entry.entryId, expectedCurrentPlanId: input.planId })
  return { rolledBack: true, reason: input.outcome.reason, record }
}

/** Host-only terminal read combining the benefit ledger with the revision journal. */
export function inspectRevisionBenefitTerminal(input: {
  planId: string
  outcome: { contractDigest: string; status: 'insufficient' | 'inferior' | 'non-inferior'
    reason: string; recordedAt: number } | undefined
  runtime: {
    inspectBenefitEvidence(planId: string): RevisionCapabilityBenefitSample | undefined
    listEntries(): readonly { entryId: string; currentPlanId: string }[]
    inspectLatestRollback(entryId: string): RevisionCapabilityRollbackRecord | undefined
  }
}): {
  protocol: 'plugin-control-plane/revision-benefit-terminal/v1'
  planId: string
  outcome: (NonNullable<typeof input.outcome>) | null
  entry: { entryId: string; currentPlanId: string } | null
  rollback: RevisionCapabilityRollbackRecord | null
} {
  const entryId = input.runtime.inspectBenefitEvidence(input.planId)?.version.entryId
  const entry = entryId === undefined ? undefined
    : input.runtime.listEntries().find(item => item.entryId === entryId)
  return Object.freeze({ protocol: 'plugin-control-plane/revision-benefit-terminal/v1' as const,
    planId: input.planId, outcome: input.outcome ?? null,
    entry: entry === undefined ? null : { entryId: entry.entryId, currentPlanId: entry.currentPlanId },
    rollback: entryId === undefined ? null : input.runtime.inspectLatestRollback(entryId) ?? null })
}
