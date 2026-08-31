import { Context } from '@deepseek-ai/cordis'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import {
  TRUSTED_EVALUATION_PRODUCER_PROTOCOL,
  type StoredOutcome,
  type TrustedAutomationEvaluationClaims,
  type TrustedAutomationEvaluationRegistration,
} from '@dsh-enhanced/assistant-evaluation'
import {
  AssistantEvolutionService,
  canonicalEvolutionHostScope,
} from '../src/service.ts'

export class FakeAutomationQualityResolver {
  private readonly receipts = new Map<string, Readonly<Record<string, unknown>>>()
  private readonly evaluationGeneration = `evolution-test-automations:${crypto.randomUUID()}`
  private evaluationRegistration: Readonly<TrustedAutomationEvaluationRegistration> | undefined

  constructor(ctx: Context) { ctx.provide('assistantAutomations' as never, this as never) }

  trustedEvaluationProducerGeneration(): string { return this.evaluationGeneration }

  registerTrustedAutomationEvaluationSink(
    registration: Readonly<TrustedAutomationEvaluationRegistration>,
  ): () => void {
    if (registration.protocol !== TRUSTED_EVALUATION_PRODUCER_PROTOCOL
      || registration.producer !== 'assistant-automations'
      || registration.generation !== this.evaluationGeneration
      || !registration.owner.ownsTrustedAutomationEvaluationRegistration(registration)
      || this.evaluationRegistration !== undefined) {
      throw new Error('invalid Evolution test Evaluation registration')
    }
    this.evaluationRegistration = registration
    return () => {
      if (this.evaluationRegistration === registration) this.evaluationRegistration = undefined
    }
  }

  appendTrustedEvaluation(claims: TrustedAutomationEvaluationClaims): StoredOutcome {
    const registration = this.evaluationRegistration
    if (registration === undefined) throw new Error('Evolution test Evaluation producer is not bound')
    const capabilityReceipt = registration.issueCapability(claims)
    return registration.append({
      capabilityReceipt,
      automationId: claims.automationId,
      runId: claims.runId,
      idempotencyKey: claims.idempotencyKey,
    })
  }

  register(input: {
    automationId: string
    runId: string
    workspace: string
    preset: string
    situation: string
    occurredAt: number
    status: 'succeeded' | 'failed' | 'timed_out'
    sessionId?: string
    ruleId?: string
    guidanceVersion?: number
  }): void {
    const base = {
      schemaVersion: 1,
      source: 'assistant-automations',
      executionKind: 'agent',
      automationId: input.automationId,
      runId: input.runId,
      definitionHash: `definition:${input.automationId}`,
      status: input.status,
      scope: Object.freeze({ workspace: input.workspace, preset: input.preset }),
      situation: input.situation,
      occurredAt: input.occurredAt,
      evidenceRef: Object.freeze({ kind: 'automation-run', ref: input.runId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
      ...(input.guidanceVersion === undefined ? {} : { guidanceVersion: input.guidanceVersion }),
      proofDigest: `proof:${input.runId}`,
    }
    this.receipts.set(input.runId, Object.freeze(base))
  }

  resolveQualityEvidence(input: {
    automationId: string
    runId: string
    expectedScope: { workspace: string; preset: string }
    expectedSituation: string
    expectedOccurredAt: number
    evidenceRef: { kind: 'automation-run'; ref: string }
  }): Readonly<Record<string, unknown>> | undefined {
    const receipt = this.receipts.get(input.runId) as {
      automationId: string
      scope: { workspace: string; preset: string }
      situation: string
      occurredAt: number
      evidenceRef: { kind: string; ref: string }
    } | undefined
    return receipt?.automationId === input.automationId
      && receipt.scope.workspace === input.expectedScope.workspace
      && receipt.scope.preset === input.expectedScope.preset
      && receipt.situation === input.expectedSituation
      && receipt.occurredAt === input.expectedOccurredAt
      && receipt.evidenceRef.kind === input.evidenceRef.kind
      && receipt.evidenceRef.ref === input.evidenceRef.ref
      ? receipt
      : undefined
  }

  validateQualityEvidence(receipt: { runId: string }): boolean {
    return this.receipts.get(receipt.runId) === receipt
  }
}

export function installQualityFixtures(ctx: Context, databasePath: string): {
  evaluation: AssistantEvaluationService
  qualityResolver: FakeAutomationQualityResolver
} {
  const qualityResolver = new FakeAutomationQualityResolver(ctx)
  const evaluation = new AssistantEvaluationService(ctx, { databasePath })
  return { evaluation, qualityResolver }
}

export async function projectTrustedOutcome(input: {
  service: AssistantEvolutionService
  evaluation: AssistantEvaluationService
  qualityResolver: FakeAutomationQualityResolver
  key: string
  situation: string
  outcome: 'succeeded' | 'failed'
  workspace?: string
  preset?: string
  occurredAt: number
  sessionId?: string
  ruleId?: string
  guidanceVersion?: number
}) {
  const workspace = input.workspace ?? '/work/alpha'
  const preset = input.preset ?? 'primary'
  const situation = input.situation.startsWith('automation:')
    ? input.situation
    : `automation:${input.situation}`
  const automationId = situation.slice('automation:'.length)
  const runId = `run:${input.key}`
  input.qualityResolver.register({
    automationId,
    runId,
    workspace,
    preset,
    situation,
    occurredAt: input.occurredAt,
    status: input.outcome,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
    ...(input.guidanceVersion === undefined ? {} : { guidanceVersion: input.guidanceVersion }),
  })
  input.qualityResolver.appendTrustedEvaluation({
      scope: { workspace, preset },
      automationId,
      situation,
      runId,
      executionMode: 'production',
      executionStatus: input.outcome,
      objectiveStatus: 'unknown',
      deliveryStatus: 'not-required',
      metrics: {},
      occurredAt: input.occurredAt,
      idempotencyKey: `evaluation-terminal:${input.key}`,
      evaluatorVersion: 'terminal-v1',
  })
  const evaluation = input.qualityResolver.appendTrustedEvaluation({
    scope: { workspace, preset },
    automationId,
    situation,
    runId,
    executionMode: 'production',
    executionStatus: input.outcome,
    objectiveStatus: input.outcome === 'succeeded' ? 'achieved' : 'not-achieved',
    deliveryStatus: 'not-required',
    metrics: {},
    occurredAt: input.occurredAt,
    idempotencyKey: `evaluation:${input.key}`,
    evaluatorVersion: 'terminal-v1',
  })
  for (let attempt = 0; attempt < 5 && input.evaluation.health().pendingProjections > 0; attempt += 1) {
    await input.evaluation.reconcileProjections()
    await input.evaluation.whenProjectionIdle()
    if (input.evaluation.health().pendingProjections > 0) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  if (input.evaluation.health().pendingProjections > 0) {
    throw new Error('Evolution test Evaluation projection did not settle')
  }
  return input.service.projectEvaluationOutcome({
    scope: canonicalEvolutionHostScope({ workspace, preset }),
    evaluationId: evaluation.id,
  })
}
