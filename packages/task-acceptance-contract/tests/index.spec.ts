import { describe, expect, test } from 'vitest'
import {
  AcceptanceContractError,
  acceptanceDigest,
  createTaskAcceptanceContract,
  createTaskVerificationReceipt,
  validateTaskAcceptanceContract,
  validateTaskVerificationReceipt,
  type TaskAcceptanceContractInput,
  type TaskAcceptanceContractV2Input,
  type TaskAcceptanceContractV3Input,
} from '../src/index.ts'

const sha = 'a'.repeat(64)
const contractInput = (): TaskAcceptanceContractInput => ({
  protocol: 'task-acceptance/v1', id: 'acceptance-1',
  scope: { workspace: '/workspace/task', preset: 'default' },
  owner: { principalRecordId: 'principal-1', principalVersion: 1 },
  task: { kind: 'automation-run', ref: 'run-1' },
  objective: 'Emit exactly: hello\\n',
  profile: { id: 'profile-1', version: 1, digest: sha },
  issuedAt: 1_000, expiresAt: 2_000,
  criteria: [{ id: 'program', kind: 'process-behavior', authority: { id: 'node-22', digest: sha }, artifactPath: 'fixtures/program.mjs', stdin: '', expectedStdout: 'hello\\n', expectedExitCode: 0 }],
  bounds: { maxDurationMs: 30_000, maxEvidenceBytes: 10_000 },
})
const goalStepContractInput = (): TaskAcceptanceContractV2Input => ({
  ...contractInput(), protocol: 'task-acceptance/v2', id: 'goal-acceptance-1',
  task: { kind: 'goal-step', ref: 'run-1', goal: {
    id: 'goal-1', definitionVersion: 2, definitionDigest: sha, stepId: 'step-1',
    runId: 'run-1', sessionId: 'session-1', nativeGoalId: 'native-goal-1', nativeRevision: 3,
  } },
})
const goalOutcomeContractInput = (): TaskAcceptanceContractV3Input => ({
  ...contractInput(), protocol: 'task-acceptance/v3', id: 'goal-outcome-acceptance-1',
  task: { kind: 'goal-outcome', ref: 'assessment-1', goal: {
    id: 'goal-1', definitionVersion: 2, definitionDigest: sha, assessmentId: 'assessment-1',
    sessionId: 'session-1', nativeGoalId: 'native-goal-1',
  } },
})
function receiptInput(contract = createTaskAcceptanceContract(contractInput())) {
  return {
    protocol: 'task-verification/v1' as const, id: 'receipt-1', contractId: contract.id, contractDigest: contract.digest,
    scope: contract.scope, owner: contract.owner, task: contract.task,
    results: [{ criterionId: 'program', status: 'passed' as const, reason: 'output-matched', evidence: [{ kind: 'process-output', ref: 'capture-1', digest: sha }] }],
    startedAt: 1_100, completedAt: 1_200, validUntil: 1_900,
  }
}

describe('task acceptance contract', () => {
  test('deep-freezes canonical output while retaining byte-exact objective and stdout', () => {
    const contract = createTaskAcceptanceContract(contractInput())
    expect(contract.digest).toBe('73fb01ba3f6e15b8ed10336f98616038caf25fb34df725dbe268fd8cad2996e7')
    expect(contract.objective).toBe('Emit exactly: hello\\n')
    expect(contract.criteria[0]?.kind === 'process-behavior' && contract.criteria[0].expectedStdout).toBe('hello\\n')
    expect(Object.isFrozen(contract)).toBe(true)
    expect(Object.isFrozen(contract.criteria)).toBe(true)
    expect(acceptanceDigest({ b: 1, a: 2 })).toBe(acceptanceDigest({ a: 2, b: 1 }))
  })

  test('preserves v1 digest while version-gating legacy and goal-step task identities', () => {
    expect(() => createTaskAcceptanceContract({ ...contractInput(), task: goalStepContractInput().task })).toThrow(/task kind|shape/i)
    expect(() => createTaskAcceptanceContract({ ...goalStepContractInput(), task: contractInput().task })).toThrow(/task kind|shape/i)
    const contract = createTaskAcceptanceContract(goalStepContractInput())
    expect(contract.protocol).toBe('task-acceptance/v2')
    expect(contract.task.kind).toBe('goal-step')
    expect(contract.digest).not.toBe(createTaskAcceptanceContract({ ...goalStepContractInput(), task: { ...goalStepContractInput().task, goal: { ...goalStepContractInput().task.goal, nativeRevision: 4 } } }).digest)
  })

  test('binds every goal-step field and requires the matching v2 receipt protocol', () => {
    const contract = createTaskAcceptanceContract(goalStepContractInput())
    const v2Receipt = {
      ...receiptInput(contract), protocol: 'task-verification/v2' as const,
    }
    expect(createTaskVerificationReceipt(contract, v2Receipt).protocol).toBe('task-verification/v2')
    for (const field of ['id', 'definitionVersion', 'definitionDigest', 'stepId', 'runId', 'sessionId', 'nativeGoalId', 'nativeRevision'] as const) {
      const original = contract.task.kind === 'goal-step' ? contract.task.goal : undefined
      const changed = field === 'definitionVersion' || field === 'nativeRevision' ? (original![field] as number) + 1 : field === 'definitionDigest' ? 'b'.repeat(64) : `${original![field]}-other`
      const task = { ...contract.task, goal: { ...original!, [field]: changed } }
      expect(() => createTaskVerificationReceipt(contract, { ...v2Receipt, task })).toThrow(/identity/i)
    }
    expect(() => createTaskVerificationReceipt(contract, { ...v2Receipt, protocol: 'task-verification/v1' })).toThrow(/protocol/i)
    const legacy = createTaskAcceptanceContract(contractInput())
    expect(() => createTaskVerificationReceipt(legacy, { ...receiptInput(legacy), protocol: 'task-verification/v2', task: goalStepContractInput().task })).toThrow(/protocol/i)
  })

  test('round-trips a goal outcome only through v3 and binds its complete assessment identity', () => {
    const contract = createTaskAcceptanceContract(goalOutcomeContractInput())
    expect(contract.protocol).toBe('task-acceptance/v3')
    expect(contract.task.kind).toBe('goal-outcome')
    if (contract.task.kind !== 'goal-outcome') throw new Error('expected goal outcome task')
    const outcomeTask = contract.task
    expect(Object.isFrozen(outcomeTask.goal)).toBe(true)
    const receiptInputV3 = { ...receiptInput(contract), protocol: 'task-verification/v3' as const }
    const receipt = createTaskVerificationReceipt(contract, receiptInputV3)
    expect(receipt.protocol).toBe('task-verification/v3')
    expect(validateTaskVerificationReceipt(contract, receipt)).toEqual(receipt)

    expect(() => createTaskAcceptanceContract({ ...goalOutcomeContractInput(), task: goalStepContractInput().task })).toThrow(/task kind|shape/i)
    expect(() => createTaskAcceptanceContract({ ...goalOutcomeContractInput(), protocol: 'task-acceptance/v2' })).toThrow(/task kind|shape/i)
    expect(() => createTaskAcceptanceContract({ ...goalOutcomeContractInput(), task: { ...goalOutcomeContractInput().task, ref: 'other-assessment' } })).toThrow(/assessment identity/i)
    expect(() => createTaskAcceptanceContract({ ...goalOutcomeContractInput(), task: { ...goalOutcomeContractInput().task, goal: { ...goalOutcomeContractInput().task.goal, assessmentId: 'other-assessment' } } })).toThrow(/assessment identity/i)
    expect(() => createTaskAcceptanceContract({ ...goalOutcomeContractInput(), task: { ...goalOutcomeContractInput().task, goal: { ...goalOutcomeContractInput().task.goal, nativeRevision: 3 } } })).toThrow(/shape/i)

    for (const field of ['id', 'definitionVersion', 'definitionDigest', 'assessmentId', 'sessionId', 'nativeGoalId'] as const) {
      const goal = outcomeTask.goal
      const value = goal![field]
      const changed = typeof value === 'number' ? value + 1 : field === 'definitionDigest' ? 'b'.repeat(64) : `${value}-other`
      expect(() => createTaskVerificationReceipt(contract, { ...receiptInputV3, task: { ...outcomeTask, goal: { ...goal, [field]: changed } } })).toThrow(/identity/i)
    }
    expect(() => createTaskVerificationReceipt(contract, { ...receiptInputV3, protocol: 'task-verification/v2' })).toThrow(/protocol/i)
    expect(() => createTaskVerificationReceipt(contract, { ...receiptInputV3, task: goalStepContractInput().task })).toThrow(/identity|task kind/i)
    expect(() => validateTaskAcceptanceContract({ ...contract, task: { ...outcomeTask, goal: { ...outcomeTask.goal, definitionDigest: 'b'.repeat(64) } } })).toThrow(/digest/i)
  })

  test('rejects tampering, unsafe input, duplicate criteria, and changed byte expectations', () => {
    const contract = createTaskAcceptanceContract(contractInput())
    expect(() => validateTaskAcceptanceContract({ ...contract, objective: 'changed' })).toThrow(/digest/i)
    expect(() => createTaskAcceptanceContract({ ...contractInput(), objective: ' trailing ' })).not.toThrow()
    expect(() => createTaskAcceptanceContract({ ...contractInput(), criteria: [...contractInput().criteria, { ...contractInput().criteria[0]!, id: 'program' }] })).toThrow(/unique/i)
    expect(() => createTaskAcceptanceContract({ ...contractInput(), criteria: [{ ...contractInput().criteria[0]!, artifactPath: '../program.mjs' }] })).toThrow(/relative/i)
    const cyclic: Record<string, unknown> = {}; cyclic.loop = cyclic
    expect(() => acceptanceDigest(cyclic)).toThrow(AcceptanceContractError)
  })

  test('binds receipt to exact contract scope, identity and complete criterion set', () => {
    const contract = createTaskAcceptanceContract(contractInput())
    const receipt = createTaskVerificationReceipt(contract, receiptInput(contract))
    expect(validateTaskVerificationReceipt(contract, receipt)).toEqual(receipt)
    expect(() => createTaskVerificationReceipt(contract, { ...receiptInput(contract), scope: { ...contract.scope, preset: 'other' } })).toThrow(/identity/i)
    expect(() => createTaskVerificationReceipt(contract, { ...receiptInput(contract), results: [] })).toThrow(/length/i)
    expect(() => validateTaskVerificationReceipt(contract, { ...receipt, contractDigest: 'b'.repeat(64) })).toThrow(/identity|digest/i)
  })

  test('derives status and rejects self-attested or replayed changed receipts', () => {
    const contract = createTaskAcceptanceContract(contractInput())
    const unknown = createTaskVerificationReceipt(contract, { ...receiptInput(contract), results: [{ ...receiptInput(contract).results[0]!, status: 'unknown', reason: 'source-unavailable' }] })
    expect(unknown.objectiveStatus).toBe('unknown')
    const failed = createTaskVerificationReceipt(contract, { ...receiptInput(contract), results: [{ ...receiptInput(contract).results[0]!, status: 'failed', reason: 'output-mismatch' }] })
    expect(failed.objectiveStatus).toBe('not-achieved')
    const receipt = createTaskVerificationReceipt(contract, receiptInput(contract))
    expect(() => validateTaskVerificationReceipt(contract, { ...receipt, objectiveStatus: 'unknown' })).toThrow(/derived/i)
    expect(() => createTaskVerificationReceipt(contract, { ...receiptInput(contract), startedAt: 999 })).toThrow(/time/i)
    const different = createTaskAcceptanceContract({ ...contractInput(), id: 'acceptance-2' })
    expect(() => validateTaskVerificationReceipt(different, receipt)).toThrow(/identity/i)
  })

  test('rejects receipt validity beyond the immutable contract expiry', () => {
    const contract = createTaskAcceptanceContract(contractInput())
    expect(() => createTaskVerificationReceipt(contract, { ...receiptInput(contract), completedAt: 2_001, validUntil: 2_001 })).toThrow(/time/i)
  })

  test('accepts every criterion wire form and rejects unsafe readback pointers', () => {
    const initial = contractInput()
    const criteria = [
      initial.criteria[0]!,
      { id: 'document', kind: 'document-citations', authority: { id: 'source-registry', digest: sha }, artifactPath: 'report.md', requiredText: ['Measured result'], quotes: [{ quote: 'Primary source', sourceId: 'source-1', sourceSha256: sha }] },
      { id: 'target', kind: 'target-readback', authority: { id: 'target-api', digest: sha }, objectId: 'record-1', expected: [{ pointer: '/status', value: { value: 'done' } }], expectedRevision: 'rev-1' },
    ]
    const input = { ...initial, criteria }
    expect(createTaskAcceptanceContract(input).criteria).toHaveLength(3)
    expect(() => createTaskAcceptanceContract({ ...input, criteria: [input.criteria[0]!, input.criteria[1]!, { ...input.criteria[2]!, expected: [{ pointer: '/__proto__/status', value: true }] }] })).toThrow(/pointer/i)
    const accessor = { ...contractInput() }
    Object.defineProperty(accessor, 'objective', { enumerable: true, get: () => 'not allowed' })
    expect(() => createTaskAcceptanceContract(accessor)).toThrow(/unsafe property/i)
  })

  test('requires a non-vacuous document criterion and permits RFC6901 root pointer', () => {
    const input = contractInput()
    const document = { id: 'document', kind: 'document-citations' as const, authority: { id: 'sources', digest: sha }, artifactPath: 'report.md', requiredText: [], quotes: [] }
    expect(() => createTaskAcceptanceContract({ ...input, criteria: [document] })).toThrow(/measurable/i)
    const target = { id: 'target', kind: 'target-readback' as const, authority: { id: 'target-api', digest: sha }, objectId: 'record-1', expected: [{ pointer: '', value: { complete: true } }] }
    expect(createTaskAcceptanceContract({ ...input, criteria: [target] }).criteria).toHaveLength(1)
  })

  test('rejects hidden fields and aggregate JSON or evidence bytes over accepted bounds', () => {
    const hidden = contractInput() as unknown as Record<PropertyKey, unknown>
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: true })
    expect(() => createTaskAcceptanceContract(hidden)).toThrow(/shape/i)
    const symbol = contractInput() as unknown as Record<PropertyKey, unknown>
    symbol[Symbol('hidden')] = true
    expect(() => createTaskAcceptanceContract(symbol)).toThrow(/symbol|shape/i)
    const oversizedValues = Array.from({ length: 2 }, (_, index) => ({ pointer: `/item${index}`, value: 'x'.repeat(40_000) }))
    const target = { id: 'target', kind: 'target-readback' as const, authority: { id: 'target-api', digest: sha }, objectId: 'record-1', expected: oversizedValues }
    expect(() => createTaskAcceptanceContract({ ...contractInput(), criteria: [target] })).toThrow(/expectations/i)
    const contract = createTaskAcceptanceContract({ ...contractInput(), bounds: { maxDurationMs: 30_000, maxEvidenceBytes: 100 } })
    expect(() => createTaskVerificationReceipt(contract, { ...receiptInput(contract), results: [{ criterionId: 'program', status: 'passed', reason: 'output-matched', evidence: [{ kind: 'process-output', ref: 'a'.repeat(200), digest: sha }] }] })).toThrow(/evidence/i)
  })

  test('rejects unsafe integer JSON values in both canonical and target paths', () => {
    expect(() => acceptanceDigest(Number.MAX_SAFE_INTEGER + 1)).toThrow(/number/i)
    expect(() => acceptanceDigest(Number.MIN_SAFE_INTEGER - 1)).toThrow(/number/i)
    const target = (value: number) => ({ id: 'target', kind: 'target-readback' as const, authority: { id: 'target-api', digest: sha }, objectId: 'record-1', expected: [{ pointer: '/value', value }] })
    expect(() => createTaskAcceptanceContract({ ...contractInput(), criteria: [target(Number.MAX_SAFE_INTEGER + 1)] })).toThrow(/number/i)
    expect(() => createTaskAcceptanceContract({ ...contractInput(), criteria: [target(Number.MIN_SAFE_INTEGER - 1)] })).toThrow(/number/i)
  })
})
