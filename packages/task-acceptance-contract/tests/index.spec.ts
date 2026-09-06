import { describe, expect, test } from 'vitest'
import {
  AcceptanceContractError,
  acceptanceDigest,
  createTaskAcceptanceContract,
  createTaskVerificationReceipt,
  validateTaskAcceptanceContract,
  validateTaskVerificationReceipt,
  type TaskAcceptanceContractInput,
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
    expect(contract.objective).toBe('Emit exactly: hello\\n')
    expect(contract.criteria[0]?.kind === 'process-behavior' && contract.criteria[0].expectedStdout).toBe('hello\\n')
    expect(Object.isFrozen(contract)).toBe(true)
    expect(Object.isFrozen(contract.criteria)).toBe(true)
    expect(acceptanceDigest({ b: 1, a: 2 })).toBe(acceptanceDigest({ a: 2, b: 1 }))
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
