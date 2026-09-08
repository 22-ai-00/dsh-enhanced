import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { acceptanceCanonicalJson, validateTaskAcceptanceContract, validateTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { TaskAcceptanceContract, TaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { benchmarkHash, benchmarkObject, benchmarkSchedule } from './schema.js'
import { parseStrategyBenchmarkPlan, strategyBenchmarkJournalPlan, strategyBenchmarkPlanDigest } from './strategy-plan.js'
import type { StrategyBenchmarkMeterSnapshot } from './strategy-meter.js'
import type { BenchmarkBudget, BenchmarkCase, BenchmarkCell, BenchmarkPlan, BenchmarkVariant, BenchmarkVersions } from './types.js'
import type { StrategyBenchmarkPlan } from './strategy-plan.js'

export const strategyEvidenceProtocol = 'dsh-native-goal-strategy-evidence/v1'
export interface StrategyEvidenceRequest { planId: string; dataset: BenchmarkPlan['dataset']; cell: BenchmarkCell; task: BenchmarkCase; variant: BenchmarkVariant; budget: BenchmarkBudget }
export interface StrategyEvidenceNative {
  parent: { sessionId: string; goalId: string; nativeGoalId: string; definitionVersion: number; definitionDigest: string; lifecycle: 'completed' | 'failed' | 'cancelled' | 'unknown'; quiescent: boolean }
  runs: readonly { runId: string; executionStatus: 'succeeded' | 'unknown'; quiescent: boolean }[]
  strategies: readonly { strategyId: string; parentRunId: string; kind: 'investigate' | 'review' | 'compare'; outcome: 'advice' | 'execution-failed' | 'cancelled' | 'unknown'; children: readonly { sessionId: string; stopReason: string; quiescent: boolean }[] }[]
  outcomeAssessments: readonly { contract: TaskAcceptanceContract; triggerRunId: string | null; dispatchedAt: number | null; execution: { status: 'succeeded' | 'unknown'; quiescent: boolean; completedAt: number } | null }[]
  selectedOutcomeContractId: string | null
  receipts: readonly { runId: string; taskKind: 'goal-step' | 'goal-outcome'; contract: TaskAcceptanceContract; receipt: TaskVerificationReceipt; quiescent: boolean }[]
}
export interface StrategyEvidenceWrite {
  protocol: typeof strategyEvidenceProtocol; version: 1; plan: StrategyBenchmarkPlan; request: StrategyEvidenceRequest
  input: { digest: string }; acceptance: { digest: string; verdict: 'achieved' | 'not-achieved' | 'unknown' }; versions: BenchmarkVersions
  meter: StrategyBenchmarkMeterSnapshot; native: StrategyEvidenceNative
  outcome: { status: 'completed' | 'unknown'; verdict: 'achieved' | 'not-achieved' | 'unknown'; quiescent: boolean }
}
export interface StrategyEvidenceObject extends Omit<StrategyEvidenceWrite, 'plan'> { planDigest: string }
export interface StrategyEvidenceStoreOptions { stateDirectory: string; candidateWorkspace: string }

// A cell aggregates many individually bounded contracts and model traces.
// Keep their canonical encoding while using an independent aggregate bound.
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024
function evidenceJson(value: unknown): string {
  const active = new Set<object>(); let nodes = 0; let bytes = 0
  const encode = (item: unknown, depth: number): string => {
    if (++nodes > 500000 || depth > 32) fail('evidence is too complex')
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number') {
      if (typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) fail('invalid evidence number')
      if (typeof item === 'string' && Buffer.byteLength(item) > MAX_EVIDENCE_BYTES) fail('evidence too large')
      const text = JSON.stringify(item); bytes += Buffer.byteLength(text)
      if (bytes > MAX_EVIDENCE_BYTES) fail('evidence too large')
      return text
    }
    if (typeof item !== 'object' || active.has(item)) fail('invalid evidence value')
    const array = Array.isArray(item)
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail('non-plain evidence')
    const names = Reflect.ownKeys(item).filter(key => !(array && key === 'length'))
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (typeof key === 'string') { bytes += Buffer.byteLength(key) + 3; if (bytes > MAX_EVIDENCE_BYTES) fail('evidence too large') }
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || !descriptor.enumerable || !('value' in descriptor)) fail('non-plain evidence')
    }
    if (array && (names.length !== item.length || item.length > 10001 || names.some((key, index) => key !== String(index)))) fail('invalid evidence array')
    active.add(item)
    try {
      return array ? `[${item.map(child => encode(child, depth + 1)).join(',')}]`
        : `{${(names as string[]).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`
    } finally { active.delete(item) }
  }
  const text = encode(value, 0)
  if (Buffer.byteLength(text) > MAX_EVIDENCE_BYTES) fail('evidence too large')
  return text
}
function evidenceSnapshot<T>(value: T): T {
  const copy = JSON.parse(evidenceJson(value)) as T
  const freeze = (item: unknown): void => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item) } }
  freeze(copy); return copy
}
const evidenceDigest = (value: unknown): string => createHash('sha256').update(evidenceJson(value)).digest('hex')

function fail(message: string): never { throw new Error(`strategy evidence: ${message}`) }
const identical = (a: unknown, b: unknown): boolean => acceptanceCanonicalJson(a) === acceptanceCanonicalJson(b)
const id = (value: unknown, label: string, max = 512): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value) || value.length > max) fail(`invalid ${label}`)
  return value
}
const verdict = (value: unknown): 'achieved' | 'not-achieved' | 'unknown' => {
  if (value !== 'achieved' && value !== 'not-achieved' && value !== 'unknown') fail('invalid verdict'); return value
}
const privateDirectory = (path: string, label: string, create: boolean): string => {
  if (!isAbsolute(path)) fail(`${label} must be absolute`)
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 })
  const original = lstatSync(path); if (original.isSymbolicLink()) fail(`${label} is not private`)
  const resolved = realpathSync(path); if (resolved !== path) fail(`${label} must be canonical`); const stat = lstatSync(resolved); const uid = process.getuid?.()
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || uid !== undefined && stat.uid !== uid) fail(`${label} is not private`)
  return resolved
}
const nested = (parent: string, child: string): boolean => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) }
function privateFile(path: string): void {
  const stat = lstatSync(path); if (stat.size > MAX_EVIDENCE_BYTES) fail('evidence too large'); const uid = process.getuid?.()
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || uid !== undefined && stat.uid !== uid) fail('evidence object is not private')
}
function privateOpenedFile(fd: number, path: string): void {
  const stat = fstatSync(fd); if (stat.size > MAX_EVIDENCE_BYTES) fail('evidence too large'); const entry = lstatSync(path); const uid = process.getuid?.()
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || uid !== undefined && stat.uid !== uid
    || entry.isSymbolicLink() || entry.dev !== stat.dev || entry.ino !== stat.ino || entry.nlink !== 1
    || (entry.mode & 0o077) !== 0 || uid !== undefined && entry.uid !== uid) fail('evidence object is not private')
}
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd) } finally { closeSync(fd) } }
function keys(value: unknown, expected: readonly string[]): Record<string, unknown> { return benchmarkObject(value, expected) }
function requestFor(plan: StrategyBenchmarkPlan, cell: BenchmarkCell): StrategyEvidenceRequest {
  const journal = strategyBenchmarkJournalPlan(plan); const exact = benchmarkSchedule(journal).find(item => identical(item, cell))
  if (!exact) fail('cell is not in strategy plan')
  const task = journal.cases.find(item => item.id === exact.caseId); const variant = journal.variants.find(item => item.id === exact.variantId)
  if (!task || !variant) fail('cell has no bound request')
  return { planId: journal.id, dataset: journal.dataset, cell: exact, task, variant, budget: journal.budget }
}
function parseMeter(value: unknown): StrategyBenchmarkMeterSnapshot {
  const raw = keys(evidenceSnapshot(value), ['observationMode', 'budget', 'modelCalls', 'toolCalls', 'activeToolCalls', 'inputTokens', 'outputTokens', 'costUsdMicros', 'heldModelCalls', 'heldInputTokens', 'heldOutputTokens', 'heldCostUsdMicros', 'traces'])
  if (raw.observationMode !== 'enforced-upper-bound-provider-output' || !Array.isArray(raw.traces) || raw.traces.length > 10_001) fail('invalid meter snapshot')
  const budget = keys(raw.budget, ['durationMs', 'inputTokens', 'outputTokens', 'costUsdMicros', 'toolCalls'])
  for (const name of ['durationMs', 'inputTokens', 'outputTokens', 'toolCalls']) if (!Number.isSafeInteger(budget[name]) || (budget[name] as number) < 0) fail('invalid meter budget')
  if (budget.costUsdMicros !== null && (!Number.isSafeInteger(budget.costUsdMicros) || (budget.costUsdMicros as number) < 0)) fail('invalid meter budget')
  for (const name of ['modelCalls', 'toolCalls', 'activeToolCalls', 'inputTokens', 'outputTokens', 'heldModelCalls', 'heldInputTokens', 'heldOutputTokens']) if (!Number.isSafeInteger(raw[name]) || (raw[name] as number) < 0) fail('invalid meter counters')
  if (raw.costUsdMicros !== null && (!Number.isSafeInteger(raw.costUsdMicros) || (raw.costUsdMicros as number) < 0) || raw.heldCostUsdMicros !== null && (!Number.isSafeInteger(raw.heldCostUsdMicros) || (raw.heldCostUsdMicros as number) < 0)) fail('invalid meter cost')
  let calls = 0; let input = 0; let output = 0; let heldCalls = 0; let heldInput = 0; let heldOutput = 0; let heldCost: number | null = raw.heldCostUsdMicros === null ? null : 0; const ids = new Set<number>()
  raw.traces.forEach(trace => {
    const item = keys(trace, ['id', 'sessionId', 'agentId', 'startedAt', 'completedAt', 'phase', 'dispatched', 'reservedInputTokens', 'reservedOutputTokens', 'reservedCostUsdMicros', 'usage', 'reason'])
    if (!Number.isSafeInteger(item.id) || (item.id as number) < 1 || ids.has(item.id as number) || !Number.isSafeInteger(item.startedAt) || (item.startedAt as number) < 0 || item.completedAt !== null && (!Number.isSafeInteger(item.completedAt) || (item.completedAt as number) < (item.startedAt as number)) || !(item.sessionId === null || typeof item.sessionId === 'string') || !(item.agentId === null || typeof item.agentId === 'string') || typeof item.dispatched !== 'boolean' || !['preflight', 'reserved', 'streaming', 'settled', 'retained', 'rejected'].includes(item.phase as string) || !Number.isSafeInteger(item.reservedInputTokens) || !Number.isSafeInteger(item.reservedOutputTokens) || (item.reservedInputTokens as number) < 0 || (item.reservedOutputTokens as number) < 0 || !(item.reservedCostUsdMicros === null || Number.isSafeInteger(item.reservedCostUsdMicros) && (item.reservedCostUsdMicros as number) >= 0) || !(item.reason === null || ['cancelled', 'disposed', 'request-contract', 'input-bound', 'shared-budget', 'stream', 'usage', 'cost', 'tool-budget'].includes(item.reason as string))) fail('invalid meter trace')
    ids.add(item.id as number)
    const reserved = item.reservedInputTokens as number > 0 || item.reservedOutputTokens as number > 0
    if (item.phase === 'settled') {
      if (!item.dispatched || item.completedAt === null || item.reason !== null || !reserved) fail('invalid settled trace')
      const usage = keys(item.usage, ['inputTokens', 'uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'])
      for (const field of Object.values(usage)) if (!Number.isSafeInteger(field) || (field as number) < 0) fail('invalid settled usage')
      if ((usage.inputTokens as number) > (item.reservedInputTokens as number) || (usage.outputTokens as number) > (item.reservedOutputTokens as number)) fail('usage exceeds reservation')
      if (usage.inputTokens !== (usage.uncachedInputTokens as number) + (usage.cacheReadTokens as number) + (usage.cacheWriteTokens as number) || usage.totalTokens !== (usage.inputTokens as number) + (usage.outputTokens as number) || (usage.reasoningTokens as number) > (usage.outputTokens as number)) fail('invalid settled usage')
      calls++; input += usage.inputTokens as number; output += usage.outputTokens as number
    } else {
      if (item.phase === 'retained' && !reserved || item.phase === 'rejected' && (reserved || item.dispatched)) fail('invalid rejected reservation')
      if (item.usage !== null || item.phase === 'preflight' && (item.dispatched || item.completedAt !== null || item.reason !== null || reserved) || (item.phase === 'reserved' || item.phase === 'streaming') && (item.completedAt !== null || item.reason !== null || !reserved) || item.phase === 'streaming' && !item.dispatched || (item.phase === 'retained' || item.phase === 'rejected') && (item.completedAt === null || item.reason === null)) fail('invalid meter phase')
      if (item.phase === 'reserved' || item.phase === 'streaming' || item.phase === 'retained') {
        heldCalls++; heldInput += item.reservedInputTokens as number; heldOutput += item.reservedOutputTokens as number
        if (heldCost !== null) { if (item.reservedCostUsdMicros === null) fail('meter aggregate mismatch'); heldCost += item.reservedCostUsdMicros as number }
      }
    }
  })
  if (calls !== raw.modelCalls || input !== raw.inputTokens || output !== raw.outputTokens || heldCalls !== raw.heldModelCalls || heldInput !== raw.heldInputTokens || heldOutput !== raw.heldOutputTokens || heldCost !== raw.heldCostUsdMicros || (raw.activeToolCalls as number) > (raw.toolCalls as number)) fail('meter aggregate mismatch')
  return raw as unknown as StrategyBenchmarkMeterSnapshot
}
function validateMeterBounds(meter: StrategyBenchmarkMeterSnapshot, plan: StrategyBenchmarkPlan, budget: BenchmarkBudget): void {
  if (meter.modelCalls > plan.execution.modelCalls || meter.heldModelCalls > plan.execution.modelCalls || meter.modelCalls + meter.heldModelCalls > plan.execution.modelCalls
    || meter.toolCalls > budget.toolCalls || meter.activeToolCalls > meter.toolCalls || meter.inputTokens > budget.inputTokens || meter.heldInputTokens > budget.inputTokens || meter.inputTokens + meter.heldInputTokens > budget.inputTokens
    || meter.outputTokens > budget.outputTokens || meter.heldOutputTokens > budget.outputTokens || meter.outputTokens + meter.heldOutputTokens > budget.outputTokens
    || meter.traces.some(trace => trace.reservedInputTokens > budget.inputTokens || trace.reservedOutputTokens > plan.execution.maxOutputTokensPerCall)
    || budget.costUsdMicros !== null && (meter.costUsdMicros === null || meter.heldCostUsdMicros === null || meter.costUsdMicros > budget.costUsdMicros || meter.heldCostUsdMicros > budget.costUsdMicros || meter.costUsdMicros + meter.heldCostUsdMicros > budget.costUsdMicros)) fail('meter exceeds bound plan')
}
function parseNative(value: unknown): StrategyEvidenceNative {
  const raw = keys(value, ['parent', 'runs', 'strategies', 'outcomeAssessments', 'selectedOutcomeContractId', 'receipts']); const parent = keys(raw.parent, ['sessionId', 'goalId', 'nativeGoalId', 'definitionVersion', 'definitionDigest', 'lifecycle', 'quiescent'])
  id(parent.sessionId, 'parent session'); id(parent.goalId, 'parent goal'); id(parent.nativeGoalId, 'native parent goal'); if (!Number.isSafeInteger(parent.definitionVersion) || (parent.definitionVersion as number) < 1 || !/^[a-f0-9]{64}$/u.test(parent.definitionDigest as string) || !['completed', 'failed', 'cancelled', 'unknown'].includes(parent.lifecycle as string) || typeof parent.quiescent !== 'boolean' || !Array.isArray(raw.runs) || !Array.isArray(raw.strategies) || !Array.isArray(raw.outcomeAssessments) || !Array.isArray(raw.receipts)) fail('invalid native evidence')
  const runs = new Map<string, { executionStatus: string; quiescent: boolean }>()
  raw.runs.forEach(run => { const item = keys(run, ['runId', 'executionStatus', 'quiescent']); const runId = id(item.runId, 'run id'); if (!['succeeded', 'unknown'].includes(item.executionStatus as string) || typeof item.quiescent !== 'boolean' || runs.has(runId)) fail('invalid native run'); runs.set(runId, { executionStatus: item.executionStatus as string, quiescent: item.quiescent }) })
  const strategyIds = new Set<string>(); const childSessions = new Set<string>()
  raw.strategies.forEach(strategy => { const item = keys(strategy, ['strategyId', 'parentRunId', 'kind', 'outcome', 'children']); const strategyId = id(item.strategyId, 'strategy id'); if (strategyIds.has(strategyId) || !runs.has(id(item.parentRunId, 'strategy parent run')) || !['investigate', 'review', 'compare'].includes(item.kind as string) || !['advice', 'execution-failed', 'cancelled', 'unknown'].includes(item.outcome as string) || !Array.isArray(item.children)) fail('invalid strategy evidence'); strategyIds.add(strategyId); item.children.forEach(child => { const row = keys(child, ['sessionId', 'stopReason', 'quiescent']); const sessionId = id(row.sessionId, 'child session'); id(row.stopReason, 'child stop reason'); if (childSessions.has(sessionId) || typeof row.quiescent !== 'boolean') fail('invalid child lifecycle'); childSessions.add(sessionId) }) })
  const assessments = new Map<string, { contract: TaskAcceptanceContract; triggerRunId: string | null; dispatchedAt: number | null; execution: { status: 'succeeded' | 'unknown'; quiescent: boolean; completedAt: number } | null }>()
  raw.outcomeAssessments.forEach(assessment => { const item = keys(assessment, ['contract', 'triggerRunId', 'dispatchedAt', 'execution']); let contract: TaskAcceptanceContract; try { contract = validateTaskAcceptanceContract(item.contract) } catch { fail('invalid outcome assessment') }; if (contract.task.kind !== 'goal-outcome' || assessments.has(contract.id) || !(item.triggerRunId === null || typeof item.triggerRunId === 'string') || item.triggerRunId !== null && !runs.has(id(item.triggerRunId, 'assessment trigger run')) || !(item.dispatchedAt === null || Number.isSafeInteger(item.dispatchedAt) && (item.dispatchedAt as number) >= 0)) fail('invalid outcome assessment'); const goal = contract.task.goal; if (goal.id !== parent.goalId || goal.sessionId !== parent.sessionId || goal.nativeGoalId !== parent.nativeGoalId || goal.definitionVersion !== parent.definitionVersion || goal.definitionDigest !== parent.definitionDigest) fail('outcome assessment binding differs'); let execution: { status: 'succeeded' | 'unknown'; quiescent: boolean; completedAt: number } | null = null; if (item.execution !== null) { const status = keys(item.execution, ['status', 'quiescent', 'completedAt']); if ((status.status !== 'succeeded' && status.status !== 'unknown') || typeof status.quiescent !== 'boolean' || !Number.isSafeInteger(status.completedAt) || (status.completedAt as number) < 0 || item.dispatchedAt === null || (status.completedAt as number) < (item.dispatchedAt as number)) fail('invalid outcome assessment'); execution = status as unknown as { status: 'succeeded' | 'unknown'; quiescent: boolean; completedAt: number } }; assessments.set(contract.id, { contract, triggerRunId: item.triggerRunId as string | null, dispatchedAt: item.dispatchedAt as number | null, execution }) })
  if (raw.selectedOutcomeContractId !== null && typeof raw.selectedOutcomeContractId !== 'string') fail('invalid selected outcome')
  const selected = raw.selectedOutcomeContractId === null ? undefined : assessments.get(id(raw.selectedOutcomeContractId, 'selected outcome'))
  const selectedAt = selected?.dispatchedAt
  if (raw.selectedOutcomeContractId !== null && (selected === undefined || selectedAt === null || selectedAt === undefined || selected.execution === null || [...assessments.values()].some(item => item !== selected && item.dispatchedAt !== null && item.dispatchedAt >= selectedAt))) fail('invalid selected outcome')
  const contractIds = new Set<string>(); const receiptIds = new Set<string>()
  raw.receipts.forEach(receipt => { const item = keys(receipt, ['runId', 'taskKind', 'contract', 'receipt', 'quiescent']); const runId = id(item.runId, 'receipt run'); const run = runs.get(runId); if (!run || (item.taskKind !== 'goal-step' && item.taskKind !== 'goal-outcome') || typeof item.quiescent !== 'boolean') fail('invalid receipt lifecycle'); let contract: TaskAcceptanceContract; let proof: TaskVerificationReceipt; try { contract = validateTaskAcceptanceContract(item.contract); proof = validateTaskVerificationReceipt(contract, item.receipt) } catch { fail('invalid acceptance receipt') }; if (contract.task.kind !== 'goal-step' && contract.task.kind !== 'goal-outcome') fail('receipt binding differs'); const assessment = contract.task.kind === 'goal-outcome' ? assessments.get(contract.id) : undefined; if (contractIds.has(contract.id) || receiptIds.has(proof.id) || contract.task.kind !== item.taskKind || contract.task.kind === 'goal-outcome' && (assessment === undefined || !identical(assessment.contract, contract) || assessment.triggerRunId !== runId)) fail('receipt binding differs'); const goal = contract.task.goal; if (goal.id !== parent.goalId || goal.sessionId !== parent.sessionId || goal.nativeGoalId !== parent.nativeGoalId || goal.definitionVersion !== parent.definitionVersion || goal.definitionDigest !== parent.definitionDigest || contract.task.kind === 'goal-step' && contract.task.goal.runId !== runId) fail('receipt binding differs'); contractIds.add(contract.id); receiptIds.add(proof.id) })
  return raw as unknown as StrategyEvidenceNative
}
function parse(input: unknown): StrategyEvidenceObject {
  const raw = keys(evidenceSnapshot(input), ['protocol', 'version', 'planDigest', 'request', 'input', 'acceptance', 'versions', 'meter', 'native', 'outcome'])
  if (raw.protocol !== strategyEvidenceProtocol || raw.version !== 1) fail('unsupported protocol')
  benchmarkHash(raw.planDigest); const request = keys(raw.request, ['planId', 'dataset', 'cell', 'task', 'variant', 'budget']); id(request.planId, 'plan id')
  const inputDigest = keys(raw.input, ['digest']); const acceptance = keys(raw.acceptance, ['digest', 'verdict']); benchmarkHash(inputDigest.digest); benchmarkHash(acceptance.digest); const accepted = verdict(acceptance.verdict)
  const outcome = keys(raw.outcome, ['status', 'verdict', 'quiescent']); if ((outcome.status !== 'completed' && outcome.status !== 'unknown') || typeof outcome.quiescent !== 'boolean') fail('invalid outcome'); const result = verdict(outcome.verdict)
  const native = parseNative(raw.native); const meter = parseMeter(raw.meter)
  const attributedSessions = new Set([native.parent.sessionId, ...native.strategies.flatMap(strategy => strategy.children.map(child => child.sessionId))])
  const knownNativeStop = native.runs.length > 0 && native.runs.every(run => run.executionStatus === 'succeeded' && run.quiescent)
    && native.strategies.every(strategy => strategy.outcome !== 'unknown' && strategy.children.every(child => child.quiescent))
    && meter.traces.every(trace => trace.sessionId !== null && attributedSessions.has(trace.sessionId))
  const versions = keys(raw.versions, ['model', 'prompt', 'skills', 'tools', 'policy', 'runtime']); Object.values(versions).forEach(benchmarkHash)
  const trustedOutcome = native.selectedOutcomeContractId !== null && native.receipts.some(item => {
    if (item.taskKind !== 'goal-outcome' || item.contract.id !== native.selectedOutcomeContractId || item.receipt.objectiveStatus !== result || !item.quiescent) return false
    const run = native.runs.find(row => row.runId === item.runId)
    const assessment = native.outcomeAssessments.find(row => identical(row.contract, item.contract))
    return run?.executionStatus === 'succeeded' && run.quiescent && assessment?.triggerRunId === item.runId && assessment.execution?.status === 'succeeded' && assessment.execution.quiescent
  })
  if (accepted !== result || native.selectedOutcomeContractId === null && result !== 'unknown' || result !== 'unknown' && native.selectedOutcomeContractId !== null && !trustedOutcome || result === 'achieved' && (!knownNativeStop || outcome.status !== 'completed' || !outcome.quiescent || !native.parent.quiescent || native.parent.lifecycle !== 'completed' || meter.modelCalls < 1 || meter.heldModelCalls !== 0 || meter.activeToolCalls !== 0 || meter.traces.length < 1 || meter.traces.some(trace => trace.phase !== 'settled') || !trustedOutcome)) fail('achieved evidence is incomplete')
  if (outcome.status === 'unknown' && result !== 'unknown') fail('unknown outcome cannot assert a verdict')
  return raw as unknown as StrategyEvidenceObject
}

export class StrategyEvidenceStore {
  readonly #directory: string
  constructor(input: StrategyEvidenceStoreOptions) {
    if (!isAbsolute(input.candidateWorkspace) || !isAbsolute(input.stateDirectory)) fail('workspace and state directory must be absolute')
    const workspace = privateDirectory(input.candidateWorkspace, 'candidate workspace', false)
    const state = privateDirectory(input.stateDirectory, 'evidence state directory', true)
    if (nested(workspace, state) || nested(state, workspace)) fail('evidence state must be outside candidate workspace')
    this.#directory = privateDirectory(resolve(state, 'strategy-evidence-v1'), 'evidence object directory', true)
  }
  #path(digest: string): string { benchmarkHash(digest); return resolve(this.#directory, `${digest}.json`) }
  write(input: StrategyEvidenceWrite): Readonly<{ digest: string; path: string }> {
    input = evidenceSnapshot(input)
    const plan = parseStrategyBenchmarkPlan(input.plan); const expected = requestFor(plan, input.request.cell)
    const { plan: _plan, ...unbound } = input
    const object = parse({ ...unbound, planDigest: strategyBenchmarkPlanDigest(plan) })
    if (!identical(object.request, expected) || !identical(object.meter.budget, expected.budget) || object.input.digest !== expected.task.inputDigest || object.acceptance.digest !== expected.task.acceptanceDigest || !identical(object.versions, expected.variant.versions)) fail('request identity drift')
    validateMeterBounds(object.meter, plan, expected.budget)
    const digest = evidenceDigest(object); const content = evidenceJson({ protocol: strategyEvidenceProtocol, version: 1, digest, evidence: object }); const path = this.#path(digest)
    try { privateFile(path); if (readFileSync(path, 'utf8') !== content) fail('digest collision or conflicting evidence'); return Object.freeze({ digest, path }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const temporary = resolve(this.#directory, `.${digest}.${randomUUID()}.tmp`); let fd: number | undefined
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); writeFileSync(fd, content, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
      try { linkSync(temporary, path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; privateFile(path); if (readFileSync(path, 'utf8') !== content) fail('digest collision or conflicting evidence') }
      unlinkSync(temporary); syncDirectory(this.#directory); return Object.freeze({ digest, path })
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary) } catch {} }
  }
  read(planInput: StrategyBenchmarkPlan, cell: BenchmarkCell, digest: string): Readonly<StrategyEvidenceObject> {
    const plan = parseStrategyBenchmarkPlan(planInput); const expected = requestFor(plan, cell); const path = this.#path(digest); privateFile(path)
    let serialized: string; let fd: number | undefined
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); privateOpenedFile(fd, path); serialized = readFileSync(fd, 'utf8'); privateOpenedFile(fd, path) } catch (error) { if ((error as NodeJS.ErrnoException).message?.startsWith('strategy evidence:')) throw error; fail('invalid evidence object') } finally { if (fd !== undefined) closeSync(fd) }
    let value: unknown; try { value = JSON.parse(serialized!) } catch { fail('invalid evidence JSON') }
    const envelope = keys(value, ['protocol', 'version', 'digest', 'evidence']); if (envelope.protocol !== strategyEvidenceProtocol || envelope.version !== 1 || envelope.digest !== digest) fail('invalid evidence envelope')
    const evidence = parse(envelope.evidence); if (evidenceDigest(evidence) !== digest || evidence.planDigest !== strategyBenchmarkPlanDigest(plan) || !identical(evidence.request, expected) || !identical(evidence.meter.budget, expected.budget)
      || evidence.input.digest !== expected.task.inputDigest || evidence.acceptance.digest !== expected.task.acceptanceDigest || !identical(evidence.versions, expected.variant.versions)) fail('evidence binding differs')
    validateMeterBounds(evidence.meter, plan, expected.budget)
    return evidence
  }
}
