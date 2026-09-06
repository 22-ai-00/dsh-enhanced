import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantVerifierService } from '../src/service.ts'
import { createVerifierAuthorities } from '../src/drivers.ts'
import * as drivers from '../src/drivers.ts'
import { AcceptanceStore } from '../src/store.ts'
import type { DocumentAuthorityInput } from '../src/drivers.ts'
import type { AcceptanceHandle, AcceptanceTask, AcceptedExecution, TaskAcceptanceProducer, TaskAcceptanceRegistration, VerifierEvaluationRegistration } from '../src/host.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.restart()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Test-only producer; actual Automation/Delivery dispatch is covered separately. */
class Producer implements TaskAcceptanceProducer {
  registration: TaskAcceptanceRegistration | undefined
  readonly generation = crypto.randomUUID()
  proof: AcceptedExecution | null = null
  inspected = 0
  trustedAcceptanceProducerGeneration() { return this.generation }
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration) {
    const owner = registration.owner as AssistantVerifierService
    if (!owner.ownsTaskAcceptanceRegistration(registration)) throw new Error('foreign registration')
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  async inspectAcceptedExecution(_contract: TaskAcceptanceContract) { this.inspected++; return this.proof }
}

async function harness(kind: AcceptanceTask['task']['kind'] = 'automation-run', required = false) {
  const root = await mkdtemp(join(tmpdir(), 'task-verifier-service-')); roots.push(root)
  await writeFile(join(root, 'report.md'), 'Confirmed result\n')
  const ctx = new Context(); contexts.push(ctx)
  const producer = new Producer()
  ctx.provide((kind === 'automation-run' ? 'assistantAutomations' : kind === 'foreground-turn' ? 'assistantDelivery' : 'assistantGoals') as never, producer as never)
  const authority: DocumentAuthorityInput = { kind: 'document', id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
  const authorities = createVerifierAuthorities({ authorities: [authority] })
  const task: AcceptanceTask = { scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: 'owner-1', principalVersion: 1 },
    task: kind === 'goal-step' ? { kind, ref: 'run-1', goal: { id: 'goal-1', definitionVersion: 1, definitionDigest: 'a'.repeat(64), stepId: 'step-1', runId: 'run-1', sessionId: 'session-1', nativeGoalId: 'native-1', nativeRevision: 1 } } : { kind, ref: 'run-1' }, objective: '  Keep original objective\n' }
  let now = 1_000
  const config = { databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: required, authorities: [authority],
    profiles: [{ id: 'report', version: 1, scope: task.scope, owner: task.owner, taskKind: kind, objective: task.objective,
      validityMs: 60_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
      criteria: [{ id: 'result', kind: 'document-citations' as const, authority: { id: 'sources', digest: authorities[0]!.digest },
        artifactPath: 'report.md', requiredText: ['Confirmed result'], quotes: [] }] }] }
  const service = new AssistantVerifierService(ctx, config, { now: () => now })
  const complete = (handle: AcceptanceHandle, overrides: Partial<AcceptedExecution> = {}) => {
    now = 2_000
    producer.proof = { ...handle, dispatchedAt: 1_000, completedAt: now, status: 'succeeded', quiescent: true, executionRef: task.task.ref, ...overrides }
  }
  return { root, ctx, producer, task, service, config, complete, time: (value: number) => { now = value } }
}

describe('Host acceptance service', () => {
  it('does not persist a verdict when disposal interrupts verification, even if the driver later returns success', async () => {
    const { ctx, producer, task, service, complete, config } = await harness()
    const handle = producer.registration!.prepare(task)!
    complete(handle)
    let started!: () => void
    const verifying = new Promise<void>(resolve => { started = resolve })
    let finishDriver!: () => void
    const gate = new Promise<void>(resolve => { finishDriver = resolve })
    // A test-only paused driver isolates the service lifecycle race. Driver I/O is tested separately.
    const driver = vi.spyOn(drivers, 'verifyAcceptanceCriteria').mockImplementation(async () => {
      started()
      await gate
      return [{ criterionId: 'result', status: 'passed', reason: 'verified', evidence: [] }]
    })
    try {
      const tick = service.tick()
      await verifying
      expect(service.inspect(handle.contractId)?.state).toBe('verifying')
      await ctx.fiber.restart()
      await tick
      finishDriver()
      await new Promise<void>(resolve => setImmediate(resolve))
      const reopened = new AcceptanceStore(config.databasePath)
      try {
        expect(reopened.getState(handle.contractId)).toMatchObject({ state: 'verifying', receipt: null })
        expect(reopened.pendingReceipts()).toEqual([])
        const claim = reopened.claimDue({ workerId: 'replacement', now: 307_001, leaseMs: 305_000 })
        expect(claim).toBeNull()
        expect(reopened.getState(handle.contractId)).toMatchObject({ state: 'needs-attention', receipt: null })
      } finally { reopened.close() }
    } finally { finishDriver(); driver.mockRestore() }
  })

  it('disposes without waiting forever on a Host inspection that ignores cancellation', async () => {
    const { ctx, producer, task, service, complete } = await harness()
    const handle = producer.registration!.prepare(task)!
    complete(handle)
    producer.inspectAcceptedExecution = async () => await new Promise(() => {})
    const tick = expect(service.tick()).rejects.toThrow('operation cancelled')
    await ctx.fiber.restart()
    await tick
    expect(() => service.inspect(handle.contractId)).toThrow('disposed')
  })

  it('disposes without awaiting a hung Evaluation acknowledgement and retains its outbox', async () => {
    const { ctx, producer, task, service, complete, config } = await harness()
    const handle = producer.registration!.prepare(task)!
    complete(handle)
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const owner = { ownsTrustedVerifierEvaluationRegistration: (registration: VerifierEvaluationRegistration) => registration === sink }
    const sink: VerifierEvaluationRegistration = { protocol: 'assistant-verifier/evaluation/v1',
      generation: service.trustedVerificationProducerGeneration(), owner,
      append: async () => { markStarted(); await new Promise(() => {}) } }
    ctx.provide('assistantEvaluation' as never, owner as never)
    service.registerTrustedVerifierEvaluationSink(sink)
    const tick = expect(service.tick()).rejects.toThrow('operation cancelled')
    await started
    await ctx.fiber.restart()
    await tick
    const next = new Context(); contexts.push(next)
    const reopened = new AssistantVerifierService(next, config, { now: () => 2_000 })
    expect(reopened.health()).toMatchObject({ pendingReceipts: 1, evaluationConnected: false })
    expect(reopened.inspect(handle.contractId)?.attempts).toBe(1)
  })

  it('eventually reconciles a completed task beyond 100 still-running tasks', async () => {
    const { producer, task, service, complete } = await harness()
    const handles = Array.from({ length: 101 }, (_, index) => producer.registration!.prepare({ ...task,
      task: { ...task.task, ref: `run-${index}` } })!).sort((left, right) => left.contractId.localeCompare(right.contractId))
    const last = handles.at(-1)!
    complete(last)
    producer.inspectAcceptedExecution = async contract => contract.id === last.contractId
      ? { ...producer.proof!, executionRef: contract.task.ref } : null
    await service.tick()
    expect(service.inspect(last.contractId)?.state).toBe('awaiting-execution')
    await service.tick()
    expect(service.inspect(last.contractId)).toMatchObject({ state: 'done', receipt: { objectiveStatus: 'achieved' } })
    expect(service.inspect(handles[0]!.contractId)?.state).toBe('awaiting-execution')
  })

  it('rejects an execution proof returned after the Host generation changed', async () => {
    const { producer, task, service, complete } = await harness()
    const handle = producer.registration!.prepare(task)!
    complete(handle)
    let deliver!: (proof: AcceptedExecution) => void
    producer.inspectAcceptedExecution = async () => await new Promise(resolve => { deliver = resolve })
    const tick = service.tick()
    const replacementGeneration = crypto.randomUUID()
    producer.trustedAcceptanceProducerGeneration = () => replacementGeneration
    deliver(producer.proof!)
    await expect(tick).rejects.toThrow('stale Host execution proof')
    expect(service.inspect(handle.contractId)?.state).toBe('awaiting-execution')
  })

  it.each(['automation-run', 'foreground-turn'] as const)('freezes acceptance before %s and verifies actual file content', async kind => {
    const { producer, task, service, complete, root } = await harness(kind)
    const registration = producer.registration!
    const handle = registration.prepare(task)!
    expect(service.inspect(handle.contractId)).toMatchObject({ state: 'awaiting-execution', receipt: null })
    expect(registration.prepare(task)).toEqual(handle)
    expect(() => registration.prepare({ ...task, objective: task.objective.trim() })).toThrow('changed')
    expect(() => registration.prepare({ ...task, task: { ...task.task, kind: kind === 'automation-run' ? 'foreground-turn' : 'automation-run' } })).toThrow('wrong Host')
    await expect(registration.completed({ ...handle })).rejects.toThrow('foreign acceptance handle')
    complete(handle)
    await writeFile(join(root, 'report.md'), 'Model says success, but required result is missing.')
    await registration.completed(handle)
    await service.tick()
    expect(service.inspect(handle.contractId)).toMatchObject({ state: 'done', attempts: 1, receipt: { objectiveStatus: 'not-achieved' } })
  })

  it('freezes and reconciles a trusted goal-step v2 contract and receipt', async () => {
    const { producer, task, service, complete, config } = await harness('goal-step')
    const registration = producer.registration!
    const handle = registration.prepare(task)!
    const durable = new AcceptanceStore(config.databasePath)
    try { expect(durable.getContract(handle.contractId)).toMatchObject({ protocol: 'task-acceptance/v2', task: task.task }) } finally { durable.close() }
    complete(handle)
    await registration.completed(handle)
    await service.tick()
    expect(service.inspect(handle.contractId)).toMatchObject({ state: 'done', receipt: { protocol: 'task-verification/v2', task: task.task } })
  })

  it('returns a deeply frozen exact v2 contract with its validated receipt without changing legacy inspect', async () => {
    const { producer, task, service, complete } = await harness('goal-step')
    const handle = producer.registration!.prepare(task)!
    const before = service.inspect(handle.contractId)
    const acceptedBefore = service.inspectAcceptedTask(handle.contractId)
    expect(before).toEqual({ state: 'awaiting-execution', attempts: 0, reason: null, receipt: null, execution: null })
    expect(Object.keys(before!).sort()).toEqual(['attempts', 'execution', 'reason', 'receipt', 'state'])
    expect(acceptedBefore).toMatchObject({ contract: { protocol: 'task-acceptance/v2', task: task.task }, state: 'awaiting-execution' })
    expect(Object.isFrozen(acceptedBefore)).toBe(true)
    expect(Object.isFrozen(acceptedBefore!.contract)).toBe(true)
    expect(Object.isFrozen(acceptedBefore!.contract.task)).toBe(true)
    expect(Object.isFrozen(acceptedBefore!.contract.task.kind === 'goal-step' && acceptedBefore!.contract.task.goal)).toBe(true)
    expect(Object.isFrozen(acceptedBefore!.contract.criteria)).toBe(true)
    complete(handle)
    await producer.registration!.completed(handle)
    await service.tick()
    const accepted = service.inspectAcceptedTask(handle.contractId)
    expect(accepted).toMatchObject({ state: 'done', receipt: { protocol: 'task-verification/v2', task: task.task, objectiveStatus: 'achieved' } })
    expect(Object.isFrozen(accepted!.receipt)).toBe(true)
    expect(Object.isFrozen(accepted!.receipt!.task)).toBe(true)
    expect(() => service.inspectAcceptedTask('bad id')).toThrow(/contractId.*invalid/i)
    expect(service.inspectAcceptedTask('unknown-contract')).toBeNull()
  })

  it.each(['automation-run', 'foreground-turn'] as const)('rejects a %s producer attempting goal-step work', async kind => {
    const { producer, task } = await harness(kind)
    const goalTask: AcceptanceTask = { ...task, task: { kind: 'goal-step', ref: 'goal-run', goal: { id: 'goal-1', definitionVersion: 1, definitionDigest: 'a'.repeat(64), stepId: 'step-1', runId: 'run-1', sessionId: 'session-1', nativeGoalId: 'native-1', nativeRevision: 1 } } }
    expect(() => producer.registration!.prepare(goalTask)).toThrow('wrong Host task kind')
  })

  it('reconciles a durable terminal proof after restart without rerunning task effects', async () => {
    const { ctx, producer, task, service, config, complete } = await harness()
    const handle = producer.registration!.prepare(task)!
    complete(handle)
    await ctx.fiber.restart()
    contexts.splice(contexts.indexOf(ctx), 1)
    const next = new Context(); contexts.push(next)
    next.provide('assistantAutomations' as never, producer as never)
    const reopened = new AssistantVerifierService(next, config, { now: () => 2_000 })
    await reopened.tick()
    expect(reopened.inspect(handle.contractId)).toMatchObject({ state: 'done', receipt: { objectiveStatus: 'achieved' } })
    expect(() => service.inspect(handle.contractId)).toThrow('disposed')
    expect(producer.inspected).toBe(1)
  })

  it('requires prior exact contract proof and never verifies a non-quiescent execution', async () => {
    const { producer, task, service, complete } = await harness()
    const handle = producer.registration!.prepare(task)!
    complete(handle, { contractDigest: 'a'.repeat(64) })
    await expect(service.tick()).rejects.toThrow('does not bind prior acceptance')
    expect(service.inspect(handle.contractId)?.state).toBe('awaiting-execution')
    complete(handle, { quiescent: false })
    await service.tick()
    expect(service.inspect(handle.contractId)).toMatchObject({ state: 'needs-attention', receipt: { objectiveStatus: 'unknown', results: [{ reason: 'execution-not-quiescent' }] } })
    expect(service.continuations()).toHaveLength(1)
  })

  it('retains delivery retries independently from verification and task execution', async () => {
    const { ctx, producer, task, service, complete } = await harness()
    const handle = producer.registration!.prepare(task)!
    complete(handle)
    let attempts = 0
    const owner = { ownsTrustedVerifierEvaluationRegistration: (registration: VerifierEvaluationRegistration) => registration === sink }
    const sink: VerifierEvaluationRegistration = { protocol: 'assistant-verifier/evaluation/v1',
      generation: service.trustedVerificationProducerGeneration(), owner,
      append: async input => { expect(input.receipt.objectiveStatus).toBe('achieved'); attempts++; if (attempts === 1) throw new Error('evaluation unavailable') } }
    ctx.provide('assistantEvaluation' as never, owner as never)
    service.registerTrustedVerifierEvaluationSink(sink)
    await expect(service.tick()).rejects.toThrow('evaluation unavailable')
    await service.tick()
    await service.tick()
    expect(attempts).toBe(2)
    expect(service.inspect(handle.contractId)?.attempts).toBe(1)
  })

  it('does not turn missing or expired proof into success', async () => {
    const { producer, task, service, time } = await harness('automation-run', true)
    expect(() => producer.registration!.prepare({ ...task, objective: 'different task' })).toThrow('no Host-approved')
    const handle = producer.registration!.prepare(task)!
    time(70_000)
    await service.tick()
    expect(service.inspect(handle.contractId)).toMatchObject({ state: 'needs-attention', receipt: null })
    expect(() => producer.registration!.prepare(task)).toThrow('expired')
  })
})
