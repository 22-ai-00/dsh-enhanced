import { linkSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { benchmarkSchedule } from '../../src/benchmark/schema.ts'
import { strategyBenchmarkCapabilityVersions, strategyBenchmarkJournalPlan, strategyBenchmarkProtocol, type StrategyBenchmarkPlan } from '../../src/benchmark/strategy-plan.ts'
import { StrategyEvidenceStore, strategyEvidenceProtocol, strategyFailureProtocol, type StrategyEvidenceWrite } from '../../src/benchmark/strategy-evidence.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const root = () => { const value = realpathSync(mkdtempSync(join(tmpdir(), 'strategy-evidence-'))); roots.push(value); return value }
const hash = (value: string) => value.repeat(64).slice(0, 64)
function plan(): StrategyBenchmarkPlan {
  const versions = { model: hash('1'), prompt: hash('2'), skills: hash('3'), tools: hash('4'), policy: hash('5'), runtime: hash('6') }
  const capabilities = { common: { persona: hash('a'), tools: hash('b'), policy: hash('c'), runtime: hash('d') }, strategy: { guide: hash('e'), tool: hash('f'), policy: hash('1'), runtime: hash('2') } }
  return { schemaVersion: 1, protocol: strategyBenchmarkProtocol, execution: { modelCalls: 3, maxOutputTokensPerCall: 10, maxGoalRounds: 2 }, capabilities,
    benchmark: { schemaVersion: 1, id: 'strategy-evidence', dataset: { id: 'public', version: '1', digest: hash('a'), split: 'development' }, comparison: 'capability',
      cases: [{ id: 'case', domain: 'code', inputDigest: hash('b'), acceptanceDigest: hash('c') }], budget: { durationMs: 1000, inputTokens: 100, outputTokens: 50, costUsdMicros: null, toolCalls: 3 }, repeats: 2, seed: 1,
      variants: [{ id: 'direct', role: 'baseline', features: { memory: false, planning: false, review: false, growth: false }, versions: { ...versions, ...strategyBenchmarkCapabilityVersions(capabilities, false) } },
        { id: 'adaptive-strategy', role: 'candidate', features: { memory: false, planning: false, review: false, growth: false }, versions: { ...versions, ...strategyBenchmarkCapabilityVersions(capabilities, true) } }], } }
}
function evidence(input = plan()): StrategyEvidenceWrite {
  const journal = strategyBenchmarkJournalPlan(input); const cell = benchmarkSchedule(journal)[0]!; const task = journal.cases[0]!; const variant = journal.variants.find(item => item.id === cell.variantId)!
  return { protocol: strategyEvidenceProtocol, version: 1, plan: input, request: { planId: journal.id, dataset: journal.dataset, cell, task, variant, budget: journal.budget }, input: { digest: task.inputDigest }, acceptance: { digest: task.acceptanceDigest, verdict: 'unknown' }, versions: variant.versions,
    meter: { observationMode: 'enforced-upper-bound-provider-output', budget: journal.budget, modelCalls: 1, toolCalls: 0, activeToolCalls: 0, inputTokens: 1, outputTokens: 1, costUsdMicros: null, heldModelCalls: 0, heldInputTokens: 0, heldOutputTokens: 0, heldCostUsdMicros: null,
      traces: [{ id: 1, sessionId: 'parent', agentId: 'parent', startedAt: 1, completedAt: 2, phase: 'settled', dispatched: true, reservedInputTokens: 2, reservedOutputTokens: 10, reservedCostUsdMicros: null, usage: { inputTokens: 1, uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2 }, reason: null }] },
    native: { parent: { sessionId: 'parent', goalId: 'goal', nativeGoalId: 'native-goal', definitionVersion: 1, definitionDigest: hash('d'), lifecycle: 'completed', quiescent: true }, runs: [{ runId: 'run', executionStatus: 'succeeded', quiescent: true }], strategies: [], outcomeAssessments: [], selectedOutcomeContractId: null, receipts: [] }, outcome: { status: 'unknown', verdict: 'unknown', quiescent: true } }
}
function store(base: string): StrategyEvidenceStore { mkdirSync(join(base, 'workspace'), { mode: 0o700 }); return new StrategyEvidenceStore({ stateDirectory: join(base, 'state'), candidateWorkspace: join(base, 'workspace') }) }
function unknownOutcome(): StrategyEvidenceWrite {
  const value = evidence(); const goal = value.native.parent
  const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v3', id: 'outcome-contract', scope: { workspace: '/workspace', preset: 'benchmark' }, owner: { principalRecordId: 'owner', principalVersion: 1 }, task: { kind: 'goal-outcome', ref: 'assessment', goal: { id: goal.goalId, definitionVersion: goal.definitionVersion, definitionDigest: goal.definitionDigest, assessmentId: 'assessment', sessionId: goal.sessionId, nativeGoalId: goal.nativeGoalId } }, objective: 'verify goal outcome', profile: { id: 'profile', version: 1, digest: hash('f') }, issuedAt: 1, expiresAt: 10, criteria: [{ id: 'criterion', kind: 'process-behavior', authority: { id: 'authority', digest: hash('e') }, artifactPath: 'result.txt', stdin: '', expectedStdout: '', expectedExitCode: 0 }], bounds: { maxDurationMs: 1, maxEvidenceBytes: 1024 } })
  const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v3', id: 'outcome-receipt', contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task, results: [{ criterionId: 'criterion', status: 'unknown', reason: 'not-run', evidence: [] }], startedAt: 1, completedAt: 2, validUntil: 10 })
  value.outcome = { ...value.outcome, quiescent: false }
  value.native = { ...value.native, parent: { ...value.native.parent, quiescent: false }, runs: [{ runId: 'run', executionStatus: 'unknown', quiescent: false }], outcomeAssessments: [{ contract, triggerRunId: 'run', dispatchedAt: 1, execution: { status: 'unknown', quiescent: false, completedAt: 2 } }], selectedOutcomeContractId: contract.id, receipts: [{ runId: 'run', taskKind: 'goal-outcome', contract, receipt, quiescent: false }] }
  return value
}

describe('StrategyEvidenceStore', () => {
  test('failure objects bind the exact request and preserve unknown observations without becoming acceptance', () => {
    const value = evidence(); const target = store(root())
    const input = { protocol: strategyFailureProtocol as typeof strategyFailureProtocol, version: 1 as const, plan: value.plan, request: value.request,
      reason: 'timeout' as const, observedAt: 10, snapshot: { runtimeRoot: null, stage: 'setup' as const, cleanup: 'unknown' as const, meter: null, goalSnapshot: null, lastGoalObservation: null, failureStage: null } }
    const saved = target.writeFailure(input)
    expect(target.readFailure(value.plan, value.request.cell, saved.digest)).toMatchObject({ reason: 'timeout', snapshot: input.snapshot })
    expect(() => target.read(value.plan, value.request.cell, saved.digest)).toThrow('envelope')
    expect(() => target.readFailure(value.plan, benchmarkSchedule(strategyBenchmarkJournalPlan(value.plan))[1]!, saved.digest)).toThrow('binding')
    expect(() => target.writeFailure({ ...input, snapshot: { ...input.snapshot, meter: { ...value.meter, budget: { ...value.meter.budget, inputTokens: 999 } } } })).toThrow('budget drift')
    const captured = target.writeFailure({ ...input, snapshot: { ...input.snapshot, meter: value.meter, goalSnapshot: { historical: 'not a completion receipt' } } })
    expect(target.readFailure(value.plan, value.request.cell, captured.digest).snapshot.meter?.traces).toHaveLength(1)
  })
  test('publishes canonical immutable evidence and exact duplicate writes are idempotent', () => {
    const base = root(); const value = evidence(); const target = store(base); let accessed = false
    const accessor = { ...value }
    Object.defineProperty(accessor, 'plan', { enumerable: true, get() { accessed = true; return value.plan } })
    expect(() => target.write(accessor)).toThrow('non-plain evidence'); expect(accessed).toBe(false)
    const first = target.write(value); const second = target.write(structuredClone(value))
    expect(second).toEqual(first); expect(target.read(value.plan, value.request.cell, first.digest)).toMatchObject({ protocol: strategyEvidenceProtocol, input: value.input, outcome: value.outcome })
  })
  test('rejects cross-cell reads, tampering, and candidate-state reuse', () => {
    const base = root(); const value = evidence(); const target = store(base); const saved = target.write(value)
    const other = benchmarkSchedule(strategyBenchmarkJournalPlan(value.plan))[1]!
    expect(() => target.read(value.plan, other, saved.digest)).toThrow('binding')
    writeFileSync(saved.path, `${readFileSync(saved.path, 'utf8')}x`)
    expect(() => target.read(value.plan, value.request.cell, saved.digest)).toThrow()
    expect(() => new StrategyEvidenceStore({ stateDirectory: join(base, 'workspace', 'state'), candidateWorkspace: join(base, 'workspace') })).toThrow('outside')
  })
  test('fails closed for a symlinked object and refuses achievement without a validated receipt', () => {
    const base = root(); const value = evidence(); const target = store(base); const saved = target.write(value)
    unlinkSync(saved.path); symlinkSync('/etc/passwd', saved.path)
    expect(() => target.read(value.plan, value.request.cell, saved.digest)).toThrow('private')
    const achieved = evidence(); achieved.acceptance = { ...achieved.acceptance, verdict: 'achieved' }; achieved.outcome = { ...achieved.outcome, verdict: 'achieved' }
    expect(() => store(root()).write(achieved)).toThrow('achieved')
  })
  test('rejects hard-linked evidence and forged meter aggregates', () => {
    const base = root(); const value = evidence(); const target = store(base); const saved = target.write(value)
    linkSync(saved.path, join(base, 'copied-evidence.json'))
    expect(() => target.read(value.plan, value.request.cell, saved.digest)).toThrow('private')
    const forged = evidence(); forged.meter = { ...forged.meter, modelCalls: 0 }
    expect(() => store(root()).write(forged)).toThrow('aggregate')
  })
  test('rejects quiescence that ignores an unsettled whole-goal assessment', () => {
    const value = unknownOutcome()
    value.native = { ...value.native, runs: [{ runId: 'run', executionStatus: 'succeeded', quiescent: true }], parent: { ...value.native.parent, quiescent: true } }
    value.outcome = { ...value.outcome, quiescent: true }
    expect(() => store(root()).write(value)).toThrow('quiescence')
  })
  test('retains unknown native receipts and unpriced numeric reservations', () => {
    const value = unknownOutcome(); value.meter = { ...value.meter, traces: [{ ...value.meter.traces[0]!, reservedCostUsdMicros: 9 }] }
    expect(() => store(root()).write(value)).not.toThrow()
  })
})

test('stores a bounded cell larger than a single acceptance contract without weakening per-contract validation', () => {
  const source = plan(); source.execution.modelCalls = 300; source.benchmark.budget.inputTokens = 1000; source.benchmark.budget.outputTokens = 1000
  const value = evidence(source); const trace = value.meter.traces[0]!
  value.meter = { ...value.meter, modelCalls: 300, inputTokens: 300, outputTokens: 300, traces: Array.from({ length: 300 }, (_, i) => ({ ...trace, id: i + 1 })) }
  const target = store(root()); const saved = target.write(value)
  expect(target.read(source, value.request.cell, saved.digest).meter.traces).toHaveLength(300)
  const invalid = structuredClone(value)
  invalid.meter = { ...invalid.meter, inputTokens: 600, traces: invalid.meter.traces.map(item => ({ ...item, reservedInputTokens: 1, usage: { ...item.usage!, inputTokens: 2, uncachedInputTokens: 2, totalTokens: 3 } })) }
  expect(() => target.write(invalid)).toThrow('usage exceeds reservation')
})
