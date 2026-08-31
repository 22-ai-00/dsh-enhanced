import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AssistantGrowthExperimentsService,
  growthPortReceiptDigest,
} from '../src/service.ts'
import { workflowTraceRevisionDigest } from '@dsh-enhanced/assistant-growth-contract'
import type {
  GrowthAutomationArtifactRequest,
  GrowthAutomationPort,
  GrowthAutomationProposalRequest,
  GrowthAutomationProposalReceipt,
  GrowthCanaryInspectionRequest,
  GrowthExperimentIdentity,
  GrowthReplayReceipt,
  WorkflowTraceRevision,
  WorkflowTraceSink,
} from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const hex = (character: string) => character.repeat(64)
const source = { sourceId: 'assistantDelivery' as const, generation: 1, authorityDigest: hex('e') }

function trace(subject: string, version = 1, disposition: 'upsert' | 'retract' = 'upsert'): WorkflowTraceRevision {
  const base = {
    source,
    scope: { workspace: '/work/alpha', preset: 'primary' },
    subjectRef: hex(subject),
    version,
    disposition,
    ...(disposition === 'upsert' ? {
      evidence: {
        occurredAt: 1,
        signal: 'owner-explicit' as const,
        objectiveStatus: 'unknown' as const,
        ownerBindingId: 'owner-main',
        taskRef: hex('a'),
        template: {
          templateRef: `workflow.${subject}`,
          templateDigest: hex('d'),
          privacyAttestation: {
            kind: 'owner-explicit' as const,
            limitation: 'deidentification-unproven' as const,
            attestationId: `attestation.${subject}`,
            attestationDigest: hex('c'),
          },
        },
        steps: [{ catalogId: 'queue.list', argumentSchemaDigest: hex('b') }],
      },
    } : {}),
  } as const
  return { ...base, digest: workflowTraceRevisionDigest(base) }
}

function id(input: GrowthExperimentIdentity): GrowthExperimentIdentity {
  return {
    contractVersion: 1,
    operationId: input.operationId,
    experimentId: input.experimentId,
    candidateId: input.candidateId,
    candidateRevision: input.candidateRevision,
    candidateDigest: input.candidateDigest,
  }
}

function seal<T extends Record<string, unknown>>(value: T): T & { receiptDigest: string } {
  return { ...value, receiptDigest: growthPortReceiptDigest(value) }
}

class FakeAutomations implements GrowthAutomationPort {
  proposal: 'approved' | 'pending' = 'pending'
  replayOutcome: 'failed' | 'passed' = 'passed'
  shadowOutcome: 'failed' | 'passed' = 'passed'
  inspectionPending = 1
  invalidCanaryEvidence = false
  failAfterProposalSideEffect = false
  failReplayAfterSideEffect = false
  readonly poisonWorkflowRefs = new Set<string>()
  readonly proposalInputs: GrowthAutomationProposalRequest[] = []
  readonly canaryInputs: GrowthAutomationArtifactRequest[] = []
  readonly inspectionInputs: GrowthCanaryInspectionRequest[] = []
  readonly rollbackInputs: GrowthAutomationArtifactRequest[] = []
  readonly receipts = new Map<string, unknown>()

  requestWorkflowAutomation(input: GrowthAutomationProposalRequest): GrowthAutomationProposalReceipt {
    this.proposalInputs.push(structuredClone(input))
    if (this.poisonWorkflowRefs.has(input.template.templateRef)) {
      throw Object.assign(new Error('poison workflow'), { code: 'poison-workflow' })
    }
    const cached = this.receipts.get(input.operationId)
    if (cached !== undefined) return cached as GrowthAutomationProposalReceipt
    const receipt = this.proposal === 'pending'
      ? seal({ ...id(input), outcome: 'approval-pending' as const, proposalId: `proposal-${input.experimentId}` })
      : seal({ ...id(input), outcome: 'approved-paused' as const, proposalId: `proposal-${input.experimentId}`,
          artifactId: `artifact-${input.experimentId}`, artifactVersion: 1, artifactDigest: hex('c') })
    this.receipts.set(input.operationId, receipt)
    if (this.failAfterProposalSideEffect) {
      this.failAfterProposalSideEffect = false
      throw Object.assign(new Error('crash after proposal side effect'), { code: 'transport-lost' })
    }
    return receipt
  }

  settleWorkflowAutomation(input: Parameters<GrowthAutomationPort['settleWorkflowAutomation']>[0]) {
    return seal({ ...id(input), outcome: 'approved-paused' as const, proposalId: input.proposalId,
      artifactId: `artifact-${input.experimentId}`, artifactVersion: 1, artifactDigest: hex('c') })
  }

  replayWorkflowAutomation(input: GrowthAutomationArtifactRequest): GrowthReplayReceipt {
    const cached = this.receipts.get(input.operationId)
    if (cached !== undefined) return cached as GrowthReplayReceipt
    const receipt = seal({ ...id(input), artifactId: input.artifactId, artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest, outcome: this.replayOutcome, replayDigest: hex('d') })
    this.receipts.set(input.operationId, receipt)
    if (this.failReplayAfterSideEffect) {
      this.failReplayAfterSideEffect = false
      throw Object.assign(new Error('crash after replay side effect'), { code: 'transport-lost' })
    }
    return receipt
  }

  shadowWorkflowAutomation(input: GrowthAutomationArtifactRequest) {
    return seal({ ...id(input), artifactId: input.artifactId, artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest, outcome: this.shadowOutcome, effectsBlocked: true as const,
      effectBlockerAttestation: {
        contract: 'assistant-automations-effect-blocker/v1' as const,
        blockedEffects: ['delivery', 'tool-execution'] as const,
        implementationDigest: hex('a'),
      },
      shadowDigest: hex('e') })
  }

  canaryWorkflowAutomation(input: GrowthAutomationArtifactRequest) {
    this.canaryInputs.push(structuredClone(input))
    return seal({ ...id(input), artifactId: input.artifactId, artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest, outcome: 'pending' as const, exposureCount: 1 as const,
      exposureOperationId: `${input.experimentId}:canary` })
  }

  inspectWorkflowCanary(input: GrowthCanaryInspectionRequest) {
    this.inspectionInputs.push(structuredClone(input))
    if (this.inspectionPending-- > 0) {
      return seal({ ...id(input), artifactId: input.artifactId, artifactVersion: input.artifactVersion,
        artifactDigest: input.artifactDigest, exposureOperationId: input.exposureOperationId,
        outcome: 'pending' as const, exposureCount: 1 as const })
    }
    if (this.invalidCanaryEvidence) {
      return seal({ ...id(input), artifactId: input.artifactId, artifactVersion: input.artifactVersion,
        artifactDigest: input.artifactDigest, exposureOperationId: input.exposureOperationId,
        outcome: 'passed' as const, exposureCount: 1 as const, evaluationDigest: hex('f') }) as never
    }
    return seal({ ...id(input), artifactId: input.artifactId, artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest, exposureOperationId: input.exposureOperationId,
      outcome: 'passed' as const, exposureCount: 1 as const, evaluationDigest: hex('f'),
      evaluationTrust: 'trusted' as const, objectiveStatus: 'achieved' as const })
  }

  promoteWorkflowAutomation(input: GrowthAutomationArtifactRequest) {
    return seal({ ...id(input), artifactId: input.artifactId, artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest, outcome: 'promoted' as const,
      resultingArtifactVersion: input.artifactVersion + 1, resultingArtifactDigest: hex('1') })
  }

  rollbackWorkflowAutomation(input: GrowthAutomationArtifactRequest) {
    this.rollbackInputs.push(structuredClone(input))
    return seal({ ...id(input), artifactId: input.artifactId, artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest, outcome: 'rolled-back' as const })
  }
}

function harness(root: string, automations: FakeAutomations, now: () => number) {
  const ctx = new Context(); contexts.push(ctx)
  let sink: WorkflowTraceSink | undefined
  ctx.provide('assistantAutomations' as never, automations as never)
  ctx.provide('assistantDelivery' as never, {
    registerWorkflowTraceSink(input: { contractVersion: 1; sink: WorkflowTraceSink }) {
      sink = input.sink
      return { contractVersion: 1 as const, ...source, dispose() { sink = undefined } }
    },
  } as never)
  const service = new AssistantGrowthExperimentsService(ctx, {
    databasePath: join(root, 'growth.sqlite'), tickIntervalMs: 0, minRepeatedSuccesses: 3,
    maxBatchSize: 10, maxExperimentDurationMs: 10_000, maxOperationAttempts: 2,
    retryBaseMs: 10, retryMaxMs: 100,
  }, { now })
  return { ctx, service, get sink() { return sink! } }
}

async function tick(service: AssistantGrowthExperimentsService, times = 1) {
  for (let index = 0; index < times; index += 1) await service.tick()
}

describe('AssistantGrowthExperimentsService', () => {
  it('accepts traces only through the authenticated private Delivery capability', () => {
    const root = mkdtempSync(join(tmpdir(), 'growth-source-auth-')); roots.push(root)
    const value = harness(root, new FakeAutomations(), () => 100)
    expect('projectWorkflowTraceRevision' in value.service).toBe(false)
    const changed = trace('1')
    const { digest: _digest, ...changedPayload } = changed
    const forgedBase = { ...changedPayload, source: { ...changed.source, generation: 2 } }
    const forged = { ...forgedBase, digest: workflowTraceRevisionDigest(forgedBase) }
    expect(() => value.sink.projectWorkflowTraceRevision(forged)).toThrowError(/authenticated Delivery/)
    expect(value.service.health()).toMatchObject({ traceRevisions: 0, currentTraces: 0 })
  })

  it('runs approval -> replay -> effect-blocked shadow -> one canary -> trusted CAS promotion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'growth-service-')); roots.push(root)
    let clock = 100
    const automations = new FakeAutomations()
    const value = harness(root, automations, () => clock)
    const projected = value.sink.projectWorkflowTraceRevision(trace('1'))
    await value.service.whenIdle()
    const candidateId = projected.candidateIds[0]!
    let experiment = value.service.beginCandidateExperiment(candidateId)
    expect(experiment.state).toBe('approval-pending')
    for (let index = 0; index < 8; index += 1) {
      clock += 10
      await tick(value.service)
    }
    experiment = value.service.getExperiment(experiment.id)!
    expect(experiment.state).toBe('promoted')
    expect(experiment.canaryExposureCount).toBe(1)
    expect(experiment).toMatchObject({ artifactVersion: 2, artifactDigest: hex('1') })
    expect(automations.proposalInputs.every(input => input.initialState === 'paused')).toBe(true)
    expect(automations.canaryInputs).toHaveLength(1)
    expect(automations.inspectionInputs).toHaveLength(2)
    expect(new Set(automations.inspectionInputs.map(input => input.operationId)).size).toBe(2)
    expect(automations.inspectionInputs.every(input => input.exposureOperationId === `${experiment.id}:canary`)).toBe(true)
    value.sink.projectWorkflowTraceRevision(trace('1', 2, 'retract'))
    await value.service.whenIdle()
    expect(value.service.getExperiment(experiment.id)?.state).toBe('rolled-back')
    expect(automations.rollbackInputs.at(-1)).toMatchObject({ artifactVersion: 2, artifactDigest: hex('1') })
  })

  it('recovers crash-after-side-effect across restart with the exact operation and payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'growth-restart-')); roots.push(root)
    let clock = 100
    const automations = new FakeAutomations()
    automations.proposal = 'approved'
    automations.failAfterProposalSideEffect = true
    const first = harness(root, automations, () => clock)
    const projected = first.sink.projectWorkflowTraceRevision(trace('2'))
    await first.service.whenIdle()
    let experiment = first.service.beginCandidateExperiment(projected.candidateIds[0]!)
    expect(experiment.state).toBe('approval-requesting')
    const original = automations.proposalInputs[0]!
    await first.ctx.fiber.restart()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    clock += 20
    const second = harness(root, automations, () => clock)
    await tick(second.service)
    experiment = second.service.getExperiment(experiment.id)!
    expect(experiment.state).toBe('replay-pending')
    expect(automations.proposalInputs).toHaveLength(2)
    expect(automations.proposalInputs[1]).toEqual(original)
  })

  it('rolls back after failed replay and after evidence becomes stale during a crashed approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'growth-rollback-')); roots.push(root)
    let clock = 100
    const failed = new FakeAutomations(); failed.proposal = 'approved'; failed.replayOutcome = 'failed'
    const first = harness(root, failed, () => clock)
    const projected = first.sink.projectWorkflowTraceRevision(trace('3'))
    await first.service.whenIdle()
    let experiment = first.service.beginCandidateExperiment(projected.candidateIds[0]!)
    clock += 10
    await tick(first.service, 2)
    experiment = first.service.getExperiment(experiment.id)!
    expect(experiment.state).toBe('rolled-back')

    const staleRoot = mkdtempSync(join(tmpdir(), 'growth-stale-')); roots.push(staleRoot)
    const stalePort = new FakeAutomations(); stalePort.proposal = 'approved'; stalePort.failAfterProposalSideEffect = true
    const stale = harness(staleRoot, stalePort, () => clock)
    const staleProjection = stale.sink.projectWorkflowTraceRevision(trace('4'))
    await stale.service.whenIdle()
    let staleExperiment = stale.service.beginCandidateExperiment(staleProjection.candidateIds[0]!)
    stale.sink.projectWorkflowTraceRevision(trace('4', 2, 'retract'))
    await stale.service.whenIdle()
    clock += 20
    await tick(stale.service, 2)
    staleExperiment = stale.service.getExperiment(staleExperiment.id)!
    expect(staleExperiment.state).toBe('rolled-back')
    expect(staleExperiment.terminalCode).toBe('evidence-superseded')
  })

  it('expires all waiting approvals at their exact deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'growth-fairness-')); roots.push(root)
    let clock = 100
    const automations = new FakeAutomations()
    const value = harness(root, automations, () => clock)
    const first = value.sink.projectWorkflowTraceRevision(trace('5'))
    const second = value.sink.projectWorkflowTraceRevision(trace('6'))
    await value.service.whenIdle()
    const firstExperiment = value.service.beginCandidateExperiment(first.candidateIds[0]!)
    const secondExperiment = value.service.beginCandidateExperiment(second.candidateIds[0]!)
    expect(firstExperiment.state).toBe('approval-pending')
    expect(secondExperiment.state).toBe('approval-pending')
    clock = 10_101
    await tick(value.service)
    expect(value.service.getExperiment(firstExperiment.id)?.state).toBe('expired')
    expect(value.service.getExperiment(secondExperiment.id)?.state).toBe('expired')
    expect(value.service.health()).toMatchObject({ activeExperiments: 0, candidates: 2 })
  })

  it('keeps poison work from starving a healthy candidate and fences concurrent ticks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'growth-poison-')); roots.push(root)
    let clock = 100
    const automations = new FakeAutomations(); automations.proposal = 'approved'
    automations.poisonWorkflowRefs.add('workflow.7')
    const value = harness(root, automations, () => clock)
    const poison = value.sink.projectWorkflowTraceRevision(trace('7'))
    const healthy = value.sink.projectWorkflowTraceRevision(trace('8'))
    await value.service.whenIdle()
    const poisonExperiment = value.service.beginCandidateExperiment(poison.candidateIds[0]!)
    const healthyExperiment = value.service.beginCandidateExperiment(healthy.candidateIds[0]!)
    expect(value.service.getExperiment(poisonExperiment.id)).toMatchObject({
      state: 'approval-requesting', attemptCount: 1,
    })
    expect(value.service.getExperiment(healthyExperiment.id)?.state).toBe('replay-pending')
    await Promise.all([value.service.tick(), value.service.tick(), value.service.tick()])
    expect(['shadow-pending', 'canary-pending', 'promotion-pending', 'promoted'])
      .toContain(value.service.getExperiment(healthyExperiment.id)?.state)
    expect(automations.proposalInputs.filter(input => input.template.templateRef === 'workflow.8')).toHaveLength(1)
    clock += 20
  })

  it('fails closed to rollback when canary evidence is not trusted and the retry budget expires', async () => {
    const root = mkdtempSync(join(tmpdir(), 'growth-budget-')); roots.push(root)
    let clock = 100
    const automations = new FakeAutomations()
    automations.proposal = 'approved'
    automations.inspectionPending = 0
    automations.invalidCanaryEvidence = true
    const value = harness(root, automations, () => clock)
    const projected = value.sink.projectWorkflowTraceRevision(trace('9'))
    await value.service.whenIdle()
    let experiment = value.service.beginCandidateExperiment(projected.candidateIds[0]!)
    await tick(value.service, 3)
    clock += 10
    await tick(value.service)
    expect(value.service.getExperiment(experiment.id)).toMatchObject({
      state: 'canary-pending', attemptCount: 1,
    })
    clock += 10
    await tick(value.service)
    expect(value.service.getExperiment(experiment.id)?.state).toBe('rollback-pending')
    await tick(value.service)
    experiment = value.service.getExperiment(experiment.id)!
    expect(experiment.state).toBe('rolled-back')
    expect(experiment.canaryExposureCount).toBe(1)
  })
})
