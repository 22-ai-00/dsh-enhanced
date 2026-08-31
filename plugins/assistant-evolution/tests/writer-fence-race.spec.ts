import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import {
  EvaluationStore,
  type EvaluationLearningWriterFence,
  type EvaluationScope,
  type OutcomeEnvelope,
  type TrustedTaskLearningProjectionReceipt,
} from '@dsh-enhanced/assistant-evaluation'
import ts from 'typescript'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EvolutionStore, EvolutionStoreError } from '../src/store.ts'
import type {
  EvolutionMutation,
  StoredProposal,
  TaskLearningProjectionInput,
} from '../src/types.ts'

const roots: string[] = []
const scope: EvaluationScope = { workspace: '/work/alpha', preset: 'primary' }
const scopeKey = JSON.stringify([scope.workspace, scope.preset])
const situation = 'automation:writer-fence-race'

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface WorkerModules {
  evaluation: string
  evolution: string
}

interface RaceFixture {
  root: string
  evaluationPath: string
  evolutionPath: string
  modules: WorkerModules
  mutation: Extract<EvolutionMutation, { op: 'adopt' }>
  fence: EvaluationLearningWriterFence
  proposalInput: {
    idempotencyKey: string
    requester: string
    principal: string
    mutation: Extract<EvolutionMutation, { op: 'adopt' }>
    expiresAt: number
  }
  correction: OutcomeEnvelope
}

interface WorkerResult {
  action?: string
  callbackEntered?: boolean
  correctionId?: string
  fence?: { matched: boolean; reason?: string }
  proposal?: StoredProposal
  settlement?: {
    proposal: StoredProposal
    replayed: boolean
    rule?: { id: string; status: string; version: number; retiredReason?: string }
  }
  projections?: Array<{
    evaluationId: string
    replayed: boolean
    disposition: 'upsert' | 'retract'
    version: number
    scopeWatermark: number
  }>
  error?: { name: string; code?: string; message: string }
}

function compileModules(root: string): WorkerModules {
  const output = join(root, 'worker-modules')
  const evaluationOutput = join(output, 'evaluation')
  const evolutionOutput = join(output, 'evolution')
  const evaluationSource = fileURLToPath(new URL('../../assistant-evaluation/src/', import.meta.url))
  const evolutionSource = fileURLToPath(new URL('../src/', import.meta.url))
  mkdirSync(evaluationOutput, { recursive: true })
  mkdirSync(evolutionOutput, { recursive: true })

  const transpile = (source: string, target: string, names: readonly string[]) => {
    for (const name of names) {
      const compiled = ts.transpileModule(readFileSync(join(source, `${name}.ts`), 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: true,
        },
        fileName: `${name}.ts`,
      }).outputText
      writeFileSync(join(target, `${name}.js`), compiled)
    }
    writeFileSync(join(target, 'package.json'), JSON.stringify({ type: 'module' }))
  }
  transpile(evaluationSource, evaluationOutput, ['types', 'sqlite', 'store'])
  transpile(evolutionSource, evolutionOutput, ['types', 'sqlite', 'review', 'store'])
  return {
    evaluation: pathToFileURL(join(evaluationOutput, 'store.js')).href,
    evolution: pathToFileURL(join(evolutionOutput, 'store.js')).href,
  }
}

function terminal(index: number, fixtureName: string): OutcomeEnvelope {
  const runId = `${fixtureName}:run:${index}`
  return {
    scope,
    situation,
    executionStatus: 'failed',
    objectiveStatus: 'unknown',
    deliveryStatus: 'not-required',
    source: { kind: 'automation', id: 'assistant-automations' },
    trust: 'trusted',
    evidence: [{ kind: 'automation-run', ref: runId }],
    metrics: {},
    occurredAt: 1_000 + index,
    idempotencyKey: `${fixtureName}:terminal:${index}`,
    evaluator: { id: 'assistant-automations', version: 'terminal-v1' },
  }
}

function ownerObjective(input: {
  fixtureName: string
  index: number
  objectiveStatus: 'achieved' | 'not-achieved'
  suffix: string
}): OutcomeEnvelope {
  const runId = `${input.fixtureName}:run:${input.index}`
  return {
    scope,
    situation,
    executionStatus: 'unknown',
    objectiveStatus: input.objectiveStatus,
    deliveryStatus: 'delivered',
    source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
    trust: 'trusted',
    evidence: [
      { kind: 'automation-run', ref: runId },
      { kind: 'delivery-outbox', ref: `${input.fixtureName}:outbox:${input.index}` },
    ],
    metrics: {},
    occurredAt: input.objectiveStatus === 'not-achieved' ? 2_000 + input.index : 3_000 + input.index,
    idempotencyKey: `${input.fixtureName}:owner:${input.index}:${input.suffix}`,
    evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
  }
}

function projectionInput(receipt: TrustedTaskLearningProjectionReceipt): TaskLearningProjectionInput {
  const common = {
    scopeKey: receipt.scopeKey,
    scopeWatermark: receipt.scopeWatermark,
    subjectKind: receipt.projection.subjectKind,
    subjectRef: receipt.projection.subjectRef,
    version: receipt.projection.version,
    digest: receipt.projection.digest,
    situation: receipt.situation,
    occurredAt: receipt.execution?.occurredAt ?? receipt.objective?.occurredAt ?? 10_000,
  }
  if (receipt.projection.disposition === 'retract') {
    return { ...common, disposition: 'retract' }
  }
  const objective = receipt.objective
  if (objective === undefined
    || (objective.status !== 'achieved' && objective.status !== 'not-achieved')) {
    throw new Error('test fixture produced an invalid upsert receipt')
  }
  return {
    ...common,
    disposition: 'upsert',
    outcome: objective.status === 'achieved' ? 'succeeded' : 'failed',
    detail: `authoritative Evaluation objective: ${objective.status}`,
    evidenceRef: objective.outcomeId,
  }
}

function seedFixture(name: string): RaceFixture {
  const root = mkdtempSync(join(tmpdir(), `assistant-writer-fence-${name}-`))
  roots.push(root)
  const evaluationPath = join(root, 'evaluation.sqlite')
  const evolutionPath = join(root, 'evolution.sqlite')
  const evaluation = new EvaluationStore({ path: evaluationPath, now: () => 10_000 })
  const evolution = new EvolutionStore({ path: evolutionPath, now: () => 10_000 })

  for (let index = 1; index <= 4; index += 1) {
    evaluation.append(terminal(index, name))
    evaluation.append(ownerObjective({
      fixtureName: name,
      index,
      objectiveStatus: 'not-achieved',
      suffix: 'failed',
    }))
  }
  for (const entry of evaluation.listPendingProjections(100, 10_000)) {
    const receipt = evaluation.getTaskLearningProjection(scope, entry.evaluationId)!
    evolution.applyTaskLearningProjection(projectionInput(receipt))
    expect(evaluation.completeProjection({ evaluationId: entry.evaluationId, now: 10_000 })).toBe(true)
  }
  expect(evaluation.listPendingProjections(100, 10_000)).toEqual([])

  const candidate = evolution.candidates({
    scopeKey,
    window: 10,
    minSample: 4,
    adoptFailureRate: 0.5,
    retireFailureRate: 0.5,
    limit: 10,
    evidenceSampleLimit: 8,
  })[0]
  if (candidate === undefined || candidate.kind !== 'adopt') {
    throw new Error('test fixture did not produce an adoption candidate')
  }
  const mutation: Extract<EvolutionMutation, { op: 'adopt' }> = {
    op: 'adopt',
    ruleId: `rule-${randomUUID()}`,
    input: {
      scopeKey,
      situation,
      guidance: `Use the reviewed ${name} evidence.`,
    },
    baseline: candidate.stats,
    evidence: {
      sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
      digest: candidate.evidenceDigest,
      total: candidate.evidenceTotal,
      window: 10,
      scopeWatermark: candidate.scopeWatermark,
      taskRevisions: candidate.taskRevisions,
    },
  }
  const fence: EvaluationLearningWriterFence = {
    scopeWatermark: candidate.scopeWatermark,
    evidence: candidate.taskRevisions,
  }
  const proposalInput = {
    idempotencyKey: `${name}:proposal`,
    requester: 'agent:primary',
    principal: 'owner:lark:writer-fence',
    mutation,
    expiresAt: 60_000,
  }
  const correction = ownerObjective({
    fixtureName: name,
    index: 1,
    objectiveStatus: 'achieved',
    suffix: 'correction',
  })
  evaluation.close()
  evolution.close()
  return {
    root,
    evaluationPath,
    evolutionPath,
    modules: compileModules(root),
    mutation,
    fence,
    proposalInput,
    correction,
  }
}

const workerSource = String.raw`
  const { parentPort, workerData } = require('node:worker_threads')

  function signal(barrier) {
    if (barrier === undefined) return
    const view = new Int32Array(barrier)
    Atomics.add(view, 0, 1)
    Atomics.notify(view, 0)
  }

  function signalAndWait(barrier) {
    if (barrier === undefined) return
    const view = new Int32Array(barrier)
    Atomics.add(view, 0, 1)
    Atomics.notify(view, 0)
    Atomics.wait(view, 1, 0)
  }

  function projectionInput(receipt) {
    const common = {
      scopeKey: receipt.scopeKey,
      scopeWatermark: receipt.scopeWatermark,
      subjectKind: receipt.projection.subjectKind,
      subjectRef: receipt.projection.subjectRef,
      version: receipt.projection.version,
      digest: receipt.projection.digest,
      situation: receipt.situation,
      occurredAt: receipt.execution?.occurredAt ?? receipt.objective?.occurredAt ?? 10_000,
    }
    if (receipt.projection.disposition === 'retract') {
      return { ...common, disposition: 'retract' }
    }
    if (receipt.objective === undefined) throw new Error('upsert receipt is missing its objective')
    return {
      ...common,
      disposition: 'upsert',
      outcome: receipt.objective.status === 'achieved' ? 'succeeded' : 'failed',
      detail: 'authoritative Evaluation objective: ' + receipt.objective.status,
      evidenceRef: receipt.objective.outcomeId,
    }
  }

  void (async () => {
    let evaluation
    let evolution
    try {
      const { EvaluationStore } = await import(workerData.modules.evaluation)
      const { EvolutionStore } = await import(workerData.modules.evolution)
      evaluation = new EvaluationStore({ path: workerData.evaluationPath, now: () => 20_000 })
      evolution = new EvolutionStore({ path: workerData.evolutionPath, now: () => 20_000 })

      if (workerData.action === 'fenced-create') {
        let callbackEntered = false
        const fence = evaluation.withLearningWriterFence(
          workerData.scope,
          workerData.fence,
          () => {
            callbackEntered = true
            signalAndWait(workerData.lockBarrier)
            return evolution.createProposal(workerData.proposalInput)
          },
        )
        parentPort.postMessage({
          action: workerData.action,
          callbackEntered,
          fence: fence.matched ? { matched: true } : fence,
          proposal: fence.matched ? fence.value : undefined,
        })
      } else if (workerData.action === 'fenced-settle') {
        let callbackEntered = false
        const fence = evaluation.withLearningWriterFence(
          workerData.scope,
          workerData.fence,
          () => {
            callbackEntered = true
            signalAndWait(workerData.lockBarrier)
            return evolution.settleProposal(workerData.settlementInput)
          },
        )
        parentPort.postMessage({
          action: workerData.action,
          callbackEntered,
          fence: fence.matched ? { matched: true } : fence,
          settlement: fence.matched ? fence.value : undefined,
        })
      } else if (workerData.action === 'fenced-settle-or-conflict') {
        let callbackEntered = false
        const fence = evaluation.withLearningWriterFence(
          workerData.scope,
          workerData.fence,
          () => {
            callbackEntered = true
            return evolution.settleProposal(workerData.settlementInput)
          },
        )
        const settlement = fence.matched
          ? fence.value
          : evolution.settleProposal({
              proposalId: workerData.settlementInput.proposalId,
              securityConflict: true,
            })
        parentPort.postMessage({
          action: workerData.action,
          callbackEntered,
          fence: fence.matched ? { matched: true } : fence,
          settlement,
        })
      } else if (workerData.action === 'correct') {
        signalAndWait(workerData.startBarrier)
        signal(workerData.attemptBarrier)
        const correction = evaluation.append(workerData.correction)
        const receipt = evaluation.getTaskLearningProjection(workerData.scope, correction.id)
        if (receipt === undefined) throw new Error('correction projection receipt is missing')
        const projected = evolution.applyTaskLearningProjection(projectionInput(receipt))
        evaluation.completeProjection({ evaluationId: correction.id, now: 20_000 })
        parentPort.postMessage({
          action: workerData.action,
          correctionId: correction.id,
          projections: [{
            evaluationId: correction.id,
            replayed: projected.replayed,
            disposition: projected.projection.disposition,
            version: projected.projection.version,
            scopeWatermark: projected.projection.scopeWatermark,
          }],
        })
      } else if (workerData.action === 'append-correction-and-crash') {
        const correction = evaluation.append(workerData.correction)
        parentPort.postMessage({ action: workerData.action, correctionId: correction.id })
      } else if (workerData.action === 'project-pending') {
        const projections = []
        for (const entry of evaluation.listPendingProjections(100, 20_000)) {
          const receipt = evaluation.getTaskLearningProjection(workerData.scope, entry.evaluationId)
          if (receipt === undefined) throw new Error('pending projection receipt is missing')
          const projected = evolution.applyTaskLearningProjection(projectionInput(receipt))
          if (workerData.acknowledge !== false) {
            evaluation.completeProjection({ evaluationId: entry.evaluationId, now: 20_000 })
          }
          projections.push({
            evaluationId: entry.evaluationId,
            replayed: projected.replayed,
            disposition: projected.projection.disposition,
            version: projected.projection.version,
            scopeWatermark: projected.projection.scopeWatermark,
          })
        }
        parentPort.postMessage({ action: workerData.action, projections })
      } else if (workerData.action === 'replay-settle') {
        parentPort.postMessage({
          action: workerData.action,
          settlement: evolution.settleProposal(workerData.settlementInput),
        })
      } else {
        throw new Error('unknown writer-fence race worker action')
      }
      evaluation.close()
      evolution.close()
    } catch (error) {
      try { evaluation?.close() } catch {}
      try { evolution?.close() } catch {}
      parentPort.postMessage({ error: {
        name: error?.name ?? 'Error',
        code: error?.code,
        message: String(error?.message ?? error),
      } })
    }
  })()
`

function runWorker(fixture: RaceFixture, input: Record<string, unknown>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        modules: fixture.modules,
        evaluationPath: fixture.evaluationPath,
        evolutionPath: fixture.evolutionPath,
        scope,
        ...input,
      },
    })
    let received = false
    worker.once('message', value => {
      received = true
      resolve(value as WorkerResult)
    })
    worker.once('error', reject)
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`writer-fence race worker exited ${code}`))
      else if (!received) reject(new Error('writer-fence race worker exited without a result'))
    })
  })
}

function barrier(): SharedArrayBuffer {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
}

async function waitUntilReady(
  target: SharedArrayBuffer,
  expected = 1,
  label = 'race worker',
): Promise<void> {
  const view = new Int32Array(target)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll)
      reject(new Error(`${label} did not reach its deterministic barrier`))
    }, 10_000)
    const poll = setInterval(() => {
      if (Atomics.load(view, 0) < expected) return
      clearTimeout(timeout)
      clearInterval(poll)
      resolve()
    }, 2)
  })
}

function release(target: SharedArrayBuffer, count = 1): void {
  const view = new Int32Array(target)
  Atomics.store(view, 1, 1)
  Atomics.notify(view, 1, count)
}

async function noDeadlock<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} deadlocked`)), 15_000)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function attachPendingProposal(fixture: RaceFixture): StoredProposal {
  const evolution = new EvolutionStore({ path: fixture.evolutionPath, now: () => 10_000 })
  const proposal = evolution.createProposal(fixture.proposalInput)
  const attached = evolution.attachPolicy(proposal.proposalId, `${fixture.proposalInput.idempotencyKey}:policy`)
  evolution.close()
  return attached
}

describe('Evaluation to Evolution writer-fence races', () => {
  test('serializes proposal creation before a concurrent correction and deterministically conflicts the stale card', async () => {
    const fixture = seedFixture('create-first')
    const correctionReady = barrier()
    const correctionAttempt = barrier()
    const lockHeld = barrier()
    const correcting = runWorker(fixture, {
      action: 'correct',
      correction: fixture.correction,
      startBarrier: correctionReady,
      attemptBarrier: correctionAttempt,
    })
    await waitUntilReady(correctionReady, 1, 'correction worker')

    const creating = runWorker(fixture, {
      action: 'fenced-create',
      fence: fixture.fence,
      proposalInput: fixture.proposalInput,
      lockBarrier: lockHeld,
    })
    await waitUntilReady(lockHeld, 1, 'proposal writer after Evaluation lock')
    release(correctionReady)
    await waitUntilReady(correctionAttempt, 1, 'correction writer competing for Evaluation')
    release(lockHeld)

    const [created, corrected] = await noDeadlock(
      Promise.all([creating, correcting]),
      'Evaluation-first proposal/correction race',
    )
    expect(created.error).toBeUndefined()
    expect(created).toMatchObject({
      callbackEntered: true,
      fence: { matched: true },
      proposal: { status: 'pending', version: 1 },
    })
    expect(corrected.error).toBeUndefined()
    expect(corrected.projections).toMatchObject([{
      replayed: false,
      disposition: 'retract',
      version: 3,
      scopeWatermark: fixture.fence.scopeWatermark + 1,
    }])

    const restartedEvolution = new EvolutionStore({ path: fixture.evolutionPath, now: () => 30_000 })
    expect(restartedEvolution.getProposal(created.proposal!.proposalId)).toMatchObject({
      status: 'conflicted',
      version: 2,
    })
    expect(restartedEvolution.listRules(scopeKey)).toEqual([])
    expect(restartedEvolution.getTaskLearningProjection({
      scopeKey,
      subjectKind: 'automation-run',
      subjectRef: 'create-first:run:1',
    })).toMatchObject({ disposition: 'retract', version: 3 })
    restartedEvolution.close()
    const restartedEvaluation = new EvaluationStore({ path: fixture.evaluationPath, now: () => 30_000 })
    expect(restartedEvaluation.listPendingProjections(100, 30_000)).toEqual([])
    restartedEvaluation.close()
  }, 30_000)

  test('never enters proposal creation when the owner correction won the Evaluation commit point', async () => {
    const fixture = seedFixture('correction-before-create')
    const corrected = await runWorker(fixture, {
      action: 'append-correction-and-crash',
      correction: fixture.correction,
    })
    expect(corrected.error).toBeUndefined()

    const blocked = await runWorker(fixture, {
      action: 'fenced-create',
      fence: fixture.fence,
      proposalInput: fixture.proposalInput,
    })
    expect(blocked.error).toBeUndefined()
    expect(blocked).toMatchObject({
      callbackEntered: false,
      fence: { matched: false, reason: 'watermark-changed' },
    })
    expect(blocked.proposal).toBeUndefined()

    const restarted = new EvolutionStore({ path: fixture.evolutionPath, now: () => 30_000 })
    expect(restarted.getProposalByIdempotencyKey(fixture.proposalInput.idempotencyKey)).toBeUndefined()
    expect(restarted.listRules(scopeKey)).toEqual([])
    restarted.close()
  }, 30_000)

  test('fails a settlement closed while correction projection is pending and recovers an Evolution-commit/ACK crash', async () => {
    const fixture = seedFixture('correction-first')
    const proposal = attachPendingProposal(fixture)

    const crashed = await runWorker(fixture, {
      action: 'append-correction-and-crash',
      correction: fixture.correction,
    })
    expect(crashed.error).toBeUndefined()
    expect(crashed.correctionId).toMatch(/^outcome-/u)

    const settled = await runWorker(fixture, {
      action: 'fenced-settle-or-conflict',
      fence: fixture.fence,
      settlementInput: {
        proposalId: proposal.proposalId,
        policyStatus: 'approved',
        policyVersion: 2,
      },
    })
    expect(settled.error).toBeUndefined()
    expect(settled).toMatchObject({
      callbackEntered: false,
      fence: { matched: false, reason: 'watermark-changed' },
      settlement: { proposal: { status: 'conflicted', version: 2 }, replayed: false },
    })
    expect(settled.settlement?.rule).toBeUndefined()

    // Simulate a second crash after Evolution committed the retract but before
    // Evaluation received its outbox acknowledgement.
    const projectedWithoutAck = await runWorker(fixture, {
      action: 'project-pending',
      acknowledge: false,
    })
    expect(projectedWithoutAck.error).toBeUndefined()
    expect(projectedWithoutAck.projections).toMatchObject([{
      replayed: false,
      disposition: 'retract',
      version: 3,
      scopeWatermark: fixture.fence.scopeWatermark + 1,
    }])

    const retried = await runWorker(fixture, {
      action: 'project-pending',
      acknowledge: true,
    })
    expect(retried.error).toBeUndefined()
    expect(retried.projections).toMatchObject([{
      replayed: true,
      disposition: 'retract',
      version: 3,
      scopeWatermark: fixture.fence.scopeWatermark + 1,
    }])

    const restartedEvaluation = new EvaluationStore({ path: fixture.evaluationPath, now: () => 30_000 })
    expect(restartedEvaluation.listPendingProjections(100, 30_000)).toEqual([])
    const staleCallback = vi.fn(() => 'must-not-settle')
    expect(restartedEvaluation.withLearningWriterFence(scope, fixture.fence, staleCallback)).toEqual({
      matched: false,
      reason: 'watermark-changed',
    })
    expect(staleCallback).not.toHaveBeenCalled()
    restartedEvaluation.close()

    const replay = await runWorker(fixture, {
      action: 'replay-settle',
      settlementInput: {
        proposalId: proposal.proposalId,
        policyStatus: 'approved',
        policyVersion: 2,
      },
    })
    expect(replay.error).toBeUndefined()
    expect(replay.settlement).toMatchObject({
      proposal: { status: 'conflicted', version: 2 },
      replayed: true,
    })
    expect(replay.settlement?.rule).toBeUndefined()
  }, 30_000)

  test('linearizes approval first without deadlock, then retracts its exact dependent rule after correction', async () => {
    const fixture = seedFixture('settle-first')
    const proposal = attachPendingProposal(fixture)
    const correctionReady = barrier()
    const correctionAttempt = barrier()
    const lockHeld = barrier()
    const correcting = runWorker(fixture, {
      action: 'correct',
      correction: fixture.correction,
      startBarrier: correctionReady,
      attemptBarrier: correctionAttempt,
    })
    await waitUntilReady(correctionReady, 1, 'settlement correction worker')

    const settling = runWorker(fixture, {
      action: 'fenced-settle',
      fence: fixture.fence,
      settlementInput: {
        proposalId: proposal.proposalId,
        policyStatus: 'approved',
        policyVersion: 2,
      },
      lockBarrier: lockHeld,
    })
    await waitUntilReady(lockHeld, 1, 'settlement writer after Evaluation lock')
    release(correctionReady)
    await waitUntilReady(correctionAttempt, 1, 'correction writer competing with settlement')
    release(lockHeld)

    const [settled, corrected] = await noDeadlock(
      Promise.all([settling, correcting]),
      'Evaluation-first settlement/correction race',
    )
    expect(settled.error).toBeUndefined()
    expect(settled).toMatchObject({
      callbackEntered: true,
      fence: { matched: true },
      settlement: {
        proposal: { status: 'approved', version: 2 },
        replayed: false,
        rule: { id: fixture.mutation.ruleId, status: 'active', version: 1 },
      },
    })
    expect(corrected.error).toBeUndefined()
    expect(corrected.projections).toMatchObject([{
      replayed: false,
      disposition: 'retract',
      version: 3,
      scopeWatermark: fixture.fence.scopeWatermark + 1,
    }])

    const restarted = new EvolutionStore({ path: fixture.evolutionPath, now: () => 30_000 })
    expect(restarted.getProposal(proposal.proposalId)).toMatchObject({
      status: 'approved',
      resultRuleId: fixture.mutation.ruleId,
      version: 2,
    })
    expect(restarted.getRule(fixture.mutation.ruleId!)).toMatchObject({
      status: 'retired',
      version: 2,
      retiredReason: expect.stringMatching(/authoritative Evaluation evidence/iu),
    })
    expect(restarted.listRules(scopeKey, 'active')).toEqual([])
    restarted.close()

    const replay = await runWorker(fixture, {
      action: 'replay-settle',
      settlementInput: {
        proposalId: proposal.proposalId,
        policyStatus: 'approved',
        policyVersion: 2,
      },
    })
    expect(replay.error).toBeUndefined()
    expect(replay.settlement).toMatchObject({
      proposal: { status: 'approved', version: 2 },
      replayed: true,
      rule: { id: fixture.mutation.ruleId, status: 'retired', version: 2 },
    })
  }, 30_000)

  test('uses a digest-bound immutable mutation identity in every race fixture', () => {
    const fixture = seedFixture('digest-check')
    expect(fixture.mutation.evidence?.digest).toMatch(/^[a-f\d]{64}$/u)
    expect(fixture.mutation.evidence?.taskRevisions).toHaveLength(4)
    expect(createHash('sha256').update(JSON.stringify(fixture.mutation)).digest('hex'))
      .toMatch(/^[a-f\d]{64}$/u)
  })

  test('still rejects an immutable application receipt rebound to a forged Policy proposal', () => {
    const fixture = seedFixture('forged-receipt-binding')
    const proposal = attachPendingProposal(fixture)
    const evolution = new EvolutionStore({ path: fixture.evolutionPath, now: () => 10_000 })
    expect(evolution.settleProposal({
      proposalId: proposal.proposalId,
      policyStatus: 'approved',
      policyVersion: 2,
    }).proposal.status).toBe('approved')
    evolution.close()

    const database = new DatabaseSync(fixture.evolutionPath)
    database.prepare(`
      UPDATE evolution_application_receipts
      SET policy_proposal_id = 'policy:forged-rebinding'
      WHERE local_proposal_id = ?
    `).run(proposal.proposalId)
    database.close()

    const restarted = new EvolutionStore({ path: fixture.evolutionPath, now: () => 30_000 })
    expect(() => restarted.settleProposal({
      proposalId: proposal.proposalId,
      policyStatus: 'approved',
      policyVersion: 2,
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({
      code: 'idempotency-conflict',
      message: expect.stringMatching(/proposal binding/iu),
    }))
    restarted.close()
  })
})
