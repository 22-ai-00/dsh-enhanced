import { createHash } from 'node:crypto'
import {
  acceptanceDigest,
  createTaskAcceptanceContract,
  createTaskVerificationReceipt,
  type TaskAcceptanceContract,
  type TaskAcceptanceContractV1Input,
  type TaskVerificationReceipt,
} from '@dsh-enhanced/task-acceptance-contract'
import { describe, expect, test } from 'vitest'
import { acceptanceIsIndependent, settleAcceptance } from '../src/acceptance-binding.ts'
import { MALFORMED_AUTHORITY_REASON } from '../src/authority.ts'
import type { PeerVerifierService } from '../src/peers.ts'
import { ACCEPTANCE_VERIFIED_EVENT } from '../src/store.ts'
import type { WorkItemAcceptanceBinding, WorkItemExecuteDecision, WorkItemRecord } from '../src/types.ts'
import { WorkItemError } from '../src/types.ts'
import { claim, harness, PRESET, report, WORKSPACE, type Harness } from './fixtures.ts'

const NOW = 1_700_000_000_000
const SHA = 'a'.repeat(64)

type Inspection = NonNullable<ReturnType<NonNullable<PeerVerifierService['inspectAcceptedTask']>>>

/** In-memory verifier double: the only place a contract or receipt comes from. */
interface FakeVerifier {
  readonly service: PeerVerifierService
  readonly reads: string[]
  readonly tasks: Map<string, { contract: unknown; state: Inspection['state']; reason: string | null; receipt: unknown }>
  failure: Error | null
}

function fakeVerifier(): FakeVerifier {
  const reads: string[] = []
  const tasks: FakeVerifier['tasks'] = new Map()
  const verifier: FakeVerifier = {
    reads,
    tasks,
    failure: null,
    service: {
      inspectAcceptedTask(contractId) {
        reads.push(contractId)
        if (verifier.failure !== null) throw verifier.failure
        const task = tasks.get(contractId)
        return task === undefined ? null : Object.freeze({ ...task, attempts: 0 })
      },
    },
  }
  return verifier
}

function contractInput(overrides: Partial<TaskAcceptanceContractV1Input> = {}): TaskAcceptanceContractV1Input {
  return {
    protocol: 'task-acceptance/v1', id: 'acceptance-review-1',
    scope: { workspace: WORKSPACE, preset: PRESET },
    owner: { principalRecordId: 'principal-1', principalVersion: 7 },
    task: { kind: 'automation-run', ref: 'run-review-1' },
    objective: 'The deploy step passes twice in a row.',
    profile: { id: 'profile-1', version: 1, digest: SHA },
    issuedAt: NOW - 1_000, expiresAt: NOW + 3_600_000,
    criteria: [{ id: 'program', kind: 'process-behavior', authority: { id: 'node-22', digest: SHA }, artifactPath: 'fixtures/program.mjs', stdin: '', expectedStdout: 'ok\n', expectedExitCode: 0 }],
    bounds: { maxDurationMs: 30_000, maxEvidenceBytes: 10_000 },
    ...overrides,
  }
}

function receiptFor(contract: TaskAcceptanceContract, status: 'passed' | 'failed' = 'passed', id = 'receipt-1'): TaskVerificationReceipt {
  return createTaskVerificationReceipt(contract, {
    protocol: 'task-verification/v1', id, contractId: contract.id, contractDigest: contract.digest,
    scope: contract.scope, owner: contract.owner, task: contract.task,
    results: [{ criterionId: 'program', status, reason: status === 'passed' ? 'output-matched' : 'output-differed', evidence: [{ kind: 'process-output', ref: 'capture-1', digest: SHA }] }],
    startedAt: NOW + 100, completedAt: NOW + 200, validUntil: NOW + 1_800_000,
  })
}

/** Register a contract with the verifier, awaiting execution, and return its handle. */
function prepared(verifier: FakeVerifier, overrides: Partial<TaskAcceptanceContractV1Input> = {}): TaskAcceptanceContract {
  const contract = createTaskAcceptanceContract(contractInput(overrides))
  verifier.tasks.set(contract.id, { contract, state: 'awaiting-execution', reason: null, receipt: null })
  return contract
}

function decision(contract: TaskAcceptanceContract | undefined, overrides: Partial<WorkItemExecuteDecision> = {}): WorkItemExecuteDecision {
  return {
    protocol: 'work-items/execute-decision/v1',
    decisionId: 'decision-acc-1',
    verdict: 'execute',
    origin: 'explicit',
    mode: 'auto',
    budgetRemaining: 3,
    mandate: {
      kind: 'review',
      title: 'Review the flaky deploy step',
      brief: 'Find why the deploy step failed twice and report.',
      originBindingId: 'binding-origin-1',
      acceptanceRef: 'tac:deploy-review/v1',
    },
    ...(contract === undefined ? {} : { acceptance: { contractId: contract.id, contractDigest: contract.digest } }),
    ...overrides,
  }
}

async function bound(): Promise<{ fixture: Harness; verifier: FakeVerifier }> {
  const verifier = fakeVerifier()
  const fixture = await harness({}, { verifier: () => verifier.service })
  return { fixture, verifier }
}

function admittedItem(result: ReturnType<Harness['admission']['admitDecision']>): WorkItemRecord {
  if (result.outcome === 'refused') throw new Error(`refused: ${result.reasonCode}`)
  return result.item
}

function bindingOf(item: WorkItemRecord): WorkItemAcceptanceBinding {
  const binding = item.authority?.mandate?.acceptance
  if (binding === undefined) throw new Error('item has no acceptance binding')
  return binding
}

function verdictEvents(fixture: Harness, itemId: string): number {
  return fixture.store.events(itemId).filter(event => event.kind === ACCEPTANCE_VERIFIED_EVENT).length
}

describe('acceptance-bound execute decisions', () => {
  test('admission freezes the verifier-held contract summary into the mandate', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    const item = admittedItem(fixture.admission.admitDecision(decision(contract)))
    expect(verifier.reads).toEqual([contract.id])
    expect(bindingOf(item)).toEqual({
      protocol: 'work-items/acceptance-binding/v1',
      verifier: 'assistant-verifier',
      author: 'assistant-automations',
      contractId: contract.id,
      contractDigest: contract.digest,
      taskKind: 'automation-run',
      taskDigest: acceptanceDigest(contract.task),
      objectiveDigest: acceptanceDigest(contract.objective),
      profileDigest: SHA,
      criteria: 1,
      expiresAt: contract.expiresAt,
    })
    // Durable round-trip, and the bound mandate is a usable basis for dispatch.
    const stored = fixture.store.findItemById(item.id)!
    expect(stored.authority?.mandate).toEqual(item.authority?.mandate)
    expect(fixture.authority.check(stored)).toEqual({ kind: 'allow' })
    const admitted = fixture.store.events(item.id).find(event => event.kind === 'admitted')
    expect(JSON.parse(String(admitted?.detail))).toMatchObject({
      mandate: { acceptance: { verifier: 'assistant-verifier', author: 'assistant-automations', contractId: contract.id, contractDigest: contract.digest } },
    })
  })

  test('a decision without a handle is unchanged: no verifier read, no binding, the slice-1 digest', async () => {
    const { fixture, verifier } = await bound()
    const plain = decision(undefined)
    const item = admittedItem(fixture.admission.admitDecision(plain))
    expect(verifier.reads).toHaveLength(0)
    expect(item.authority?.mandate).not.toHaveProperty('acceptance')
    const legacy = createHash('sha256').update(JSON.stringify([
      'work-items/mandate/v1', plain.decisionId, plain.origin, null, plain.mandate.kind, plain.mandate.title,
      plain.mandate.brief, plain.mandate.originBindingId, plain.mandate.acceptanceRef,
    ]), 'utf8').digest('hex')
    expect(item.authority?.mandate?.digest).toBe(legacy)
  })

  test('the contract must be the exact one named, for this owner scope, unexpired and unverified', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    const wrongPrincipal = prepared(verifier, { id: 'acceptance-other-principal', owner: { principalRecordId: 'principal-1', principalVersion: 8 } })
    const wrongWorkspace = prepared(verifier, { id: 'acceptance-other-workspace', scope: { workspace: '/work/beta', preset: PRESET } })
    const expired = prepared(verifier, { id: 'acceptance-expired', expiresAt: NOW })
    const verified = prepared(verifier, { id: 'acceptance-verified' })
    verifier.tasks.set(verified.id, { contract: verified, state: 'done', reason: null, receipt: receiptFor(verified) })
    const attention = prepared(verifier, { id: 'acceptance-attention' })
    verifier.tasks.set(attention.id, { contract: attention, state: 'needs-attention', reason: 'runner-unavailable', receipt: null })
    const wrongPreset = prepared(verifier, { id: 'acceptance-other-preset', scope: { workspace: WORKSPACE, preset: 'other-preset' } })
    const forged = prepared(verifier, { id: 'acceptance-forged' })
    // A body edited after freezing no longer matches its own digest.
    verifier.tasks.set(forged.id, { contract: { ...forged, objective: 'Anything passes.' }, state: 'awaiting-execution', reason: null, receipt: null })
    const cases: Array<[WorkItemExecuteDecision, string]> = [
      [decision(undefined, { acceptance: { contractId: 'acceptance-unknown', contractDigest: SHA } }), 'acceptance-unavailable'],
      [decision(undefined, { acceptance: { contractId: contract.id, contractDigest: SHA } }), 'acceptance-mismatch'],
      [decision(wrongPrincipal), 'acceptance-mismatch'],
      [decision(wrongWorkspace), 'acceptance-mismatch'],
      [decision(wrongPreset), 'acceptance-mismatch'],
      [decision(forged), 'acceptance-mismatch'],
      [decision(expired), 'acceptance-expired'],
      [decision(verified), 'acceptance-already-settled'],
      [decision(attention), 'acceptance-already-settled'],
    ]
    cases.forEach(([input, reasonCode], index) => {
      const keyed = { ...input, decisionId: `decision-refused-${String(index)}` }
      expect(fixture.admission.admitDecision(keyed)).toEqual({ outcome: 'refused', reasonCode })
      expect(fixture.admission.admitDecision(keyed)).toEqual({ outcome: 'refused', reasonCode })
    })
    // Refusals happen before Policy or any durable write.
    expect(fixture.policy.requests).toHaveLength(0)
    expect(fixture.store.countItemsSince(0)).toBe(0)
  })

  test('a missing or failing verifier peer refuses a bound decision without a write', async () => {
    const detached = await harness()
    const contract = createTaskAcceptanceContract(contractInput())
    expect(detached.admission.admitDecision(decision(contract))).toEqual({ outcome: 'refused', reasonCode: 'acceptance-unavailable' })
    expect(detached.store.countItemsSince(0)).toBe(0)
    const { fixture, verifier } = await bound()
    prepared(verifier)
    verifier.failure = new Error('verifier stopped')
    expect(fixture.admission.admitDecision(decision(contract))).toEqual({ outcome: 'refused', reasonCode: 'acceptance-unavailable' })
    expect(fixture.store.countItemsSince(0)).toBe(0)
  })

  test('the handle is part of the decision identity; replay is stable after the contract settles', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    const other = prepared(verifier, { id: 'acceptance-review-2', task: { kind: 'automation-run', ref: 'run-review-2' } })
    const first = admittedItem(fixture.admission.admitDecision(decision(contract)))
    verifier.tasks.set(contract.id, { contract, state: 'done', reason: null, receipt: receiptFor(contract) })
    const replay = fixture.admission.admitDecision(decision(contract))
    expect(replay.outcome).toBe('replayed')
    expect(admittedItem(replay).id).toBe(first.id)
    expect(() => fixture.admission.admitDecision(decision(other))).toThrow(expect.objectContaining({ code: 'identity-mismatch' }))
    expect(() => fixture.admission.admitDecision(decision(undefined))).toThrow(expect.objectContaining({ code: 'identity-mismatch' }))
    expect(fixture.store.countItemsSince(0)).toBe(1)
  })

  test('only a contract still awaiting execution may bind new work', async () => {
    const { fixture, verifier } = await bound()
    for (const state of ['pending', 'verifying'] as const) {
      const contract = prepared(verifier, { id: `acceptance-${state}` })
      verifier.tasks.set(contract.id, { contract, state, reason: null, receipt: null })
      const input = decision(contract, { decisionId: `decision-${state}` })
      expect(fixture.admission.admitDecision(input)).toEqual({ outcome: 'refused', reasonCode: 'acceptance-not-awaiting' })
      expect(fixture.admission.admitDecision(input)).toEqual({ outcome: 'refused', reasonCode: 'acceptance-not-awaiting' })
    }
    expect(fixture.policy.requests).toHaveLength(0)
    expect(fixture.store.countItemsSince(0)).toBe(0)
  })

  test('one contract binds exactly one item; its own decision still replays', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    const first = admittedItem(fixture.admission.admitDecision(decision(contract)))
    expect(fixture.store.findItemByAcceptanceContract(contract.id)?.id).toBe(first.id)
    const second = decision(contract, { decisionId: 'decision-acc-2' })
    expect(fixture.admission.admitDecision(second)).toEqual({ outcome: 'refused', reasonCode: 'acceptance-contract-bound' })
    expect(fixture.admission.admitDecision(second)).toEqual({ outcome: 'refused', reasonCode: 'acceptance-contract-bound' })
    const replay = fixture.admission.admitDecision(decision(contract))
    expect(replay.outcome).toBe('replayed')
    expect(admittedItem(replay).id).toBe(first.id)
    expect(fixture.store.countItemsSince(0)).toBe(1)
    expect(fixture.store.findItemByAcceptanceContract('acceptance-unbound')).toBeUndefined()
  })

  test('a receipt whose verification started before the item existed cannot settle it', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    // The item is admitted after the receipt's startedAt (NOW + 100).
    fixture.advance(1_000)
    const item = admittedItem(fixture.admission.admitDecision(decision(contract)))
    verifier.tasks.set(contract.id, { contract, state: 'done', reason: null, receipt: receiptFor(contract) })
    expect(settleAcceptance(fixture.store, verifier.service, item, bindingOf(item)))
      .toEqual({ outcome: 'drift', detail: 'verifier receipt predates the work item' })
    expect(verdictEvents(fixture, item.id)).toBe(0)
  })

  test('a recorded verdict only answers for the contract it was recorded against', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    const item = admittedItem(fixture.admission.admitDecision(decision(contract)))
    verifier.tasks.set(contract.id, { contract, state: 'done', reason: null, receipt: receiptFor(contract) })
    const binding = bindingOf(item)
    expect(settleAcceptance(fixture.store, verifier.service, item, binding).outcome).toBe('verified')
    for (const forged of [{ ...binding, contractId: 'acceptance-review-9' }, { ...binding, contractDigest: 'b'.repeat(64) }]) {
      expect(settleAcceptance(fixture.store, verifier.service, item, forged))
        .toEqual({ outcome: 'drift', detail: 'recorded verdict is for another contract' })
    }
  })

  test('first receipt wins: a racing different receipt is reported as identity-mismatch, not thrown', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    const item = admittedItem(fixture.admission.admitDecision(decision(contract)))
    const winner = receiptFor(contract, 'failed', 'receipt-2')
    fixture.store.recordAcceptanceVerdict({
      itemId: item.id, verifier: 'assistant-verifier', contractId: contract.id, contractDigest: contract.digest,
      receiptId: winner.id, receiptDigest: winner.digest, objectiveStatus: 'not-achieved', completedAt: winner.completedAt,
    })
    const loser = receiptFor(contract)
    verifier.tasks.set(contract.id, { contract, state: 'done', reason: null, receipt: loser })
    // The first read misses the winner, as it would for a concurrent settle.
    let reads = 0
    const racing = {
      acceptanceVerdict: (itemId: string) => reads++ === 0 ? undefined : fixture.store.acceptanceVerdict(itemId),
      recordAcceptanceVerdict: (verdict: Parameters<Harness['store']['recordAcceptanceVerdict']>[0]) => fixture.store.recordAcceptanceVerdict(verdict),
    }
    expect(settleAcceptance(racing, verifier.service, item, bindingOf(item))).toEqual({
      outcome: 'identity-mismatch',
      verdict: expect.objectContaining({ receiptId: 'receipt-2', objectiveStatus: 'not-achieved' }),
      receiptDigest: loser.digest,
    })
    expect(fixture.store.acceptanceVerdict(item.id)?.receiptId).toBe('receipt-2')
    expect(verdictEvents(fixture, item.id)).toBe(1)
  })

  test('author, verifier and executor stay distinct; a forged binding is a malformed basis', async () => {
    expect(acceptanceIsIndependent({ author: 'assistant-automations', verifier: 'assistant-verifier', executor: 'assistant-work-items' })).toBe(true)
    expect(acceptanceIsIndependent({ author: 'assistant-verifier', verifier: 'assistant-verifier', executor: 'assistant-work-items' })).toBe(false)
    expect(acceptanceIsIndependent({ author: 'assistant-work-items', verifier: 'assistant-verifier', executor: 'assistant-work-items' })).toBe(false)
    const { fixture, verifier } = await bound()
    const item = admittedItem(fixture.admission.admitDecision(decision(prepared(verifier))))
    const basis = item.authority!
    const binding = bindingOf(item)
    const variants: unknown[] = [
      { ...binding, author: 'assistant-verifier' },
      { ...binding, author: 'assistant-work-items' },
      { ...binding, verifier: 'assistant-work-items' },
      // The author is derived from the task kind; a mismatched pair is corrupt.
      { ...binding, author: 'assistant-delivery' },
      { ...binding, contractDigest: 'not-a-digest' },
      { ...binding, verdict: 'achieved' },
      { ...binding, expiresAt: undefined },
    ]
    for (const acceptance of variants) {
      const forged = { ...item, authority: { ...basis, mandate: { ...basis.mandate!, acceptance } } } as WorkItemRecord
      expect(fixture.authority.check(forged)).toEqual({ kind: 'revoked', reasonCode: MALFORMED_AUTHORITY_REASON })
    }
  })

  test('completion is read only from the verifier receipt, never from the worker report', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    const item = admittedItem(fixture.admission.admitDecision(decision(contract)))
    const binding = bindingOf(item)
    expect(settleAcceptance(fixture.store, verifier.service, item, binding)).toEqual({ outcome: 'pending', state: 'awaiting-execution' })
    claim(fixture, item.id)
    report(fixture, item.id, 'ready')
    // The worker's `ready` is a self-report: no outcome revision claims the objective.
    expect(fixture.store.outcomes(item.id).every(outcome => outcome.objectiveStatus !== 'achieved' && outcome.objectiveStatus !== 'partial')).toBe(true)
    verifier.tasks.set(contract.id, { contract, state: 'verifying', reason: null, receipt: null })
    expect(settleAcceptance(fixture.store, verifier.service, item, binding)).toEqual({ outcome: 'pending', state: 'verifying' })
    expect(verdictEvents(fixture, item.id)).toBe(0)
    const receipt = receiptFor(contract)
    verifier.tasks.set(contract.id, { contract, state: 'done', reason: null, receipt })
    const settled = settleAcceptance(fixture.store, verifier.service, item, binding)
    expect(settled).toEqual({
      outcome: 'verified',
      verdict: {
        itemId: item.id, verifier: 'assistant-verifier', contractId: contract.id, contractDigest: contract.digest,
        receiptId: receipt.id, receiptDigest: receipt.digest, objectiveStatus: 'achieved', completedAt: receipt.completedAt, recordedAt: NOW,
      },
    })
    expect(fixture.store.acceptanceVerdict(item.id)).toEqual(settled.outcome === 'verified' ? settled.verdict : undefined)
    // Idempotent: the same receipt again writes nothing new.
    expect(settleAcceptance(fixture.store, verifier.service, item, binding).outcome).toBe('already-verified')
    expect(verdictEvents(fixture, item.id)).toBe(1)
    // Recording a verdict does not move the item's own lifecycle.
    expect(fixture.store.findItemById(item.id)?.state).toBe(item.state === 'queued' ? 'ready' : item.state)
  })

  test('a failed criterion yields not-achieved; a second receipt cannot overwrite a verdict', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    const item = admittedItem(fixture.admission.admitDecision(decision(contract)))
    verifier.tasks.set(contract.id, { contract, state: 'done', reason: null, receipt: receiptFor(contract, 'failed') })
    const settled = settleAcceptance(fixture.store, verifier.service, item, bindingOf(item))
    expect(settled).toMatchObject({ outcome: 'verified', verdict: { objectiveStatus: 'not-achieved' } })
    const other = receiptFor(contract, 'passed', 'receipt-2')
    expect(() => fixture.store.recordAcceptanceVerdict({
      itemId: item.id, verifier: 'assistant-verifier', contractId: contract.id, contractDigest: contract.digest,
      receiptId: other.id, receiptDigest: other.digest, objectiveStatus: 'achieved', completedAt: other.completedAt,
    })).toThrow(expect.objectContaining({ code: 'identity-mismatch' }))
    expect(fixture.store.acceptanceVerdict(item.id)?.objectiveStatus).toBe('not-achieved')
    expect(verdictEvents(fixture, item.id)).toBe(1)
  })

  test('settlement fails closed on drift, a forged receipt, attention or a missing verifier', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    const item = admittedItem(fixture.admission.admitDecision(decision(contract)))
    const binding = bindingOf(item)
    expect(settleAcceptance(fixture.store, undefined, item, binding)).toMatchObject({ outcome: 'unavailable' })
    verifier.failure = new Error('verifier stopped')
    expect(settleAcceptance(fixture.store, verifier.service, item, binding)).toEqual({ outcome: 'unavailable', detail: 'verifier stopped' })
    verifier.failure = null
    verifier.tasks.set(contract.id, { contract, state: 'needs-attention', reason: 'runner-unavailable', receipt: null })
    expect(settleAcceptance(fixture.store, verifier.service, item, binding)).toEqual({ outcome: 'needs-attention', reason: 'runner-unavailable' })
    // A receipt that claims `achieved` against failed results does not validate.
    const failed = receiptFor(contract, 'failed')
    verifier.tasks.set(contract.id, { contract, state: 'done', reason: null, receipt: { ...failed, objectiveStatus: 'achieved' } })
    expect(settleAcceptance(fixture.store, verifier.service, item, binding)).toMatchObject({ outcome: 'drift' })
    // The verifier now holds a different contract under the same id.
    const replaced = createTaskAcceptanceContract(contractInput({ objective: 'A looser objective.' }))
    verifier.tasks.set(contract.id, { contract: replaced, state: 'done', reason: null, receipt: receiptFor(replaced) })
    expect(settleAcceptance(fixture.store, verifier.service, item, binding)).toMatchObject({ outcome: 'drift' })
    verifier.tasks.delete(contract.id)
    expect(settleAcceptance(fixture.store, verifier.service, item, binding)).toMatchObject({ outcome: 'drift' })
    expect(verdictEvents(fixture, item.id)).toBe(0)
    expect(fixture.store.acceptanceVerdict(item.id)).toBeUndefined()
  })

  test('malformed acceptance handles fail closed without a verifier read or a write', async () => {
    const { fixture, verifier } = await bound()
    const contract = prepared(verifier)
    const bad: unknown[] = [
      { ...decision(contract), acceptance: null },
      { ...decision(contract), acceptance: { contractId: contract.id } },
      { ...decision(contract), acceptance: { contractId: contract.id, contractDigest: 'ABC' } },
      { ...decision(contract), acceptance: { contractId: ' spaced', contractDigest: contract.digest } },
      { ...decision(contract), acceptance: { contractId: contract.id, contractDigest: contract.digest, verdict: 'achieved' } },
    ]
    for (const input of bad) {
      expect(() => fixture.admission.admitDecision(input)).toThrow(WorkItemError)
    }
    expect(verifier.reads).toHaveLength(0)
    expect(fixture.store.countItemsSince(0)).toBe(0)
  })
})
