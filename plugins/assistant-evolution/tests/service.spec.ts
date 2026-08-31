import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION, type UserMessage } from '@deepseek-ai/dsh-session'
import {
  AssistantEvaluationService,
  TRUSTED_EVALUATION_PRODUCER_PROTOCOL,
  canonicalEvaluationHostScope,
  type StoredOutcome,
  type TrustedAutomationEvaluationClaims,
  type TrustedAutomationEvaluationRegistration,
  type TrustedDeliveryEvaluationClaims,
  type TrustedDeliveryEvaluationRegistration,
} from '@dsh-enhanced/assistant-evaluation'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  HOST_RECOVERY_BACKGROUND_ID,
  AssistantEvolutionError,
  AssistantEvolutionService,
  canonicalEvolutionHostScope,
} from '../src/service.ts'
import { EvolutionStoreError } from '../src/store.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function stubAgent(options: {
  cwd?: string
  preset?: string
  id?: string
  inject?: (message: UserMessage) => void
} = {}) {
  const id = SessionId(options.id ?? `evolution-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: options.cwd ?? '/work/alpha',
    agentPreset: options.preset ?? 'primary',
  })
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  const injections: UserMessage[] = []
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject(message) {
      options.inject?.(message)
      injections.push(message)
    },
  }
  return { agent, injections }
}

interface HarnessOptions {
  allow?: boolean
  root?: string
  maxInjectedRules?: number
  maxEvidenceSamples?: number
  now?: () => number
  autonomousRollback?: boolean
  allowRollbackPolicy?: boolean
  allowHostPolicy?: boolean
}

class FakeAutomationQualityResolver {
  private readonly receipts = new Map<string, Readonly<Record<string, unknown>>>()
  private readonly evaluationGeneration = `evolution-service-test-automations:${crypto.randomUUID()}`
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
      || this.evaluationRegistration !== undefined) throw new Error('invalid test registration')
    this.evaluationRegistration = registration
    return () => {
      if (this.evaluationRegistration === registration) this.evaluationRegistration = undefined
    }
  }

  appendTrustedEvaluation(claims: TrustedAutomationEvaluationClaims): StoredOutcome {
    const registration = this.evaluationRegistration
    if (registration === undefined) throw new Error('test Evaluation producer is not bound')
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

class FakeDeliveryEvaluationProducer {
  private readonly generation = `evolution-service-test-delivery:${crypto.randomUUID()}`
  private registration: Readonly<TrustedDeliveryEvaluationRegistration> | undefined

  constructor(ctx: Context) { ctx.provide('assistantDelivery' as never, this as never) }
  isBound(): boolean { return this.registration !== undefined }
  trustedEvaluationProducerGeneration(): string { return this.generation }
  registerTrustedDeliveryEvaluationSink(
    registration: Readonly<TrustedDeliveryEvaluationRegistration>,
  ): () => void {
    if (registration.protocol !== TRUSTED_EVALUATION_PRODUCER_PROTOCOL
      || registration.producer !== 'assistant-delivery'
      || registration.generation !== this.generation
      || !registration.owner.ownsTrustedDeliveryEvaluationRegistration(registration)
      || this.registration !== undefined) throw new Error('invalid test Delivery registration')
    this.registration = registration
    return () => {
      if (this.registration === registration) this.registration = undefined
    }
  }
  appendTrustedEvaluation(claims: TrustedDeliveryEvaluationClaims): StoredOutcome {
    const registration = this.registration
    if (registration === undefined) throw new Error('test Delivery Evaluation producer is not bound')
    const capabilityReceipt = registration.issueCapability(claims)
    return registration.append({
      capabilityReceipt,
      runId: claims.runId,
      outboxId: claims.outboxId,
      chatId: claims.chatId,
      principalId: claims.principalId,
      bindingId: claims.bindingId,
      idempotencyKey: claims.idempotencyKey,
    })
  }
}

async function harness(options: HarnessOptions = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'assistant-evolution-service-'))
  if (options.root === undefined) temporaryRoots.push(root)
  const ctx = new Context()
  const policy = new AssistantPolicyService(ctx, {
    databasePath: join(root, 'policy.sqlite'),
    rules: options.allow === false ? [] : ['/work/alpha', '/work/beta'].flatMap((workspace, index) => [
      {
        id: `allow-evolution-${index}`,
        effect: 'allow' as const,
        subject: { kind: 'agent' as const, id: 'primary', workspace },
        actions: ['append', 'inspect', 'snapshot'],
        resource: { kind: 'evolution' as const, id: '*' },
        context: { initiators: ['foreground' as const] },
      },
      {
        id: `allow-evolution-proposals-${index}`,
        effect: 'allow' as const,
        subject: { kind: 'agent' as const, id: 'primary', workspace },
        actions: ['propose'],
        resource: { kind: 'evolution' as const, id: 'proposals' },
        context: { initiators: ['foreground' as const] },
      },
      ...(options.allowRollbackPolicy === false ? [] : [{
        id: `allow-evolution-rollback-${index}`,
        effect: 'allow' as const,
        subject: { kind: 'agent' as const, id: 'primary', workspace },
        actions: ['rollback'],
        resource: { kind: 'evolution' as const, id: 'rule:*' },
        context: { initiators: ['foreground' as const] },
      }]),
      ...(options.allowHostPolicy === false ? [] : [{
        id: `allow-evolution-recovery-host-${index}`,
        effect: 'allow' as const,
        subject: {
          kind: 'background' as const,
          id: HOST_RECOVERY_BACKGROUND_ID,
          workspace,
          principal: 'owner:lark:123',
        },
        actions: ['inspect', 'rollback'],
        resource: { kind: 'evolution' as const, id: '*' },
        context: { initiators: ['background' as const] },
      }]),
    ]),
  })
  const qualityResolver = new FakeAutomationQualityResolver(ctx)
  const evaluation = new AssistantEvaluationService(ctx, {
    databasePath: join(root, 'evaluation.sqlite'),
  }, options.now === undefined ? {} : { now: options.now })
  const service = new AssistantEvolutionService(ctx, {
    databasePath: join(root, 'evolution.sqlite'),
    evaluationWindow: 10,
    minSample: 4,
    maxInjectedRules: options.maxInjectedRules ?? 12,
    maxEvidenceSamples: options.maxEvidenceSamples ?? 8,
    reconcileIntervalMs: 0,
    autonomousRollback: options.autonomousRollback ?? false,
  }, options.now === undefined ? {} : { now: options.now })
  return { ctx, policy, evaluation, qualityResolver, service, root }
}

function observe(
  service: AssistantEvolutionService,
  agent: Agent,
  situation: string,
  outcome: 'succeeded' | 'failed',
  index: number,
) {
  return service.recordEpisode(agent, {
    situation,
    outcome,
    detail: `attempt ${index}`,
    source: 'foreground',
    occurredAt: 1_000 + index,
    idempotencyKey: `${situation}:${index}`,
  })
}

async function observeTrusted(
  fixture: Awaited<ReturnType<typeof harness>>,
  situation: string,
  outcome: 'succeeded' | 'failed',
  index: number,
  options: {
    workspace?: string
    preset?: string
    occurredAt?: number
    sessionId?: string
    ruleId?: string
    guidanceVersion?: number
  } = {},
) {
  const workspace = options.workspace ?? '/work/alpha'
  const preset = options.preset ?? 'primary'
  const occurredAt = options.occurredAt ?? 1_000 + index
  const runId = `run:${workspace}:${situation}:${index}:${occurredAt}:${options.sessionId ?? 'baseline'}`
  const effectiveSituation = situation.startsWith('automation:') ? situation : `automation:${situation}`
  const automationId = effectiveSituation.slice('automation:'.length)
  fixture.qualityResolver.register({
      automationId,
      runId,
      workspace,
      preset,
      situation: effectiveSituation,
      occurredAt,
      status: outcome,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.ruleId === undefined ? {} : { ruleId: options.ruleId }),
      ...(options.guidanceVersion === undefined ? {} : { guidanceVersion: options.guidanceVersion }),
  })
  fixture.qualityResolver.appendTrustedEvaluation({
      scope: { workspace, preset },
      automationId,
      situation: effectiveSituation,
      runId,
      executionMode: 'production',
      executionStatus: outcome,
      objectiveStatus: 'unknown',
      deliveryStatus: 'not-required',
      metrics: {},
      occurredAt,
      idempotencyKey: `evaluation-terminal:${workspace}:${situation}:${index}:${occurredAt}`,
      evaluatorVersion: 'terminal-v1',
  })
  const evaluation = fixture.qualityResolver.appendTrustedEvaluation({
    scope: { workspace, preset },
    automationId,
    situation: effectiveSituation,
    runId,
    executionMode: 'production',
    executionStatus: outcome,
    objectiveStatus: outcome === 'succeeded' ? 'achieved' : 'not-achieved',
    deliveryStatus: 'not-required',
    metrics: {},
    occurredAt,
    idempotencyKey: `evaluation:${workspace}:${situation}:${index}:${occurredAt}`,
    evaluatorVersion: 'terminal-v1',
  })
  for (let attempt = 0; attempt < 5 && fixture.evaluation.health().pendingProjections > 0; attempt += 1) {
    await fixture.evaluation.reconcileProjections()
    await fixture.evaluation.whenProjectionIdle()
    if (fixture.evaluation.health().pendingProjections > 0) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  if (fixture.evaluation.health().pendingProjections > 0) {
    throw new Error('service test Evaluation projection did not settle')
  }
  return fixture.service.projectEvaluationOutcome({
    scope: canonicalEvolutionHostScope({ workspace, preset }),
    evaluationId: evaluation.id,
  })
}

/** Drive the full observe -> candidate -> propose -> approve -> commit loop. */
async function adoptRule(situation = 'weekly-report', options: HarnessOptions = {}) {
  const fixture = await harness(options)
  const { agent } = stubAgent()
  for (let index = 1; index <= 4; index += 1) await observeTrusted(fixture, situation, 'failed', index)
  const effectiveSituation = situation.startsWith('automation:') ? situation : `automation:${situation}`
  const candidate = fixture.service.candidates(agent)[0]!
  const proposed = fixture.service.propose(agent, {
    mutation: {
      op: 'adopt',
      ruleId: `rule-${situation}`,
      input: { situation: effectiveSituation, guidance: 'Draft the report a day early.' },
      baseline: candidate.stats,
    },
    principal: 'owner:lark:123',
  })
  return { ...fixture, agent, proposed }
}

function approve(
  fixture: Awaited<ReturnType<typeof harness>>,
  proposal: { policyProposalId: string },
) {
  fixture.policy.decideProposal({
    proposalId: proposal.policyProposalId,
    principal: 'owner:lark:123',
    expectedVersion: 1,
    decision: 'approved',
    reason: 'owner confirmed',
  })
  return fixture.service.reconcileProposals()[0]!
}

async function approvedRule(situation = 'weekly-report', options: HarnessOptions = {}) {
  const fixture = await adoptRule(situation, options)
  const settled = approve(fixture, fixture.proposed)
  return { ...fixture, rule: settled.rule! }
}

async function recordAttributedOutcomes(
  fixture: Awaited<ReturnType<typeof approvedRule>>,
  outcomes: readonly ('succeeded' | 'failed')[],
  keyPrefix = 'attributed',
) {
  const recorded = []
  for (const [offset, outcome] of outcomes.entries()) {
    const index = offset + 1
    const session = stubAgent({ id: `${keyPrefix}-session-${index}` })
    agentEvents(fixture.ctx, session.agent).emit('agent/session-start', { source: 'startup' })
    const automationId = fixture.rule.situation.replace(/^automation:/u, '')
    const exposure = await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId,
      sessionId: String(session.agent.session.id),
    })
    recorded.push(await observeTrusted(fixture, fixture.rule.situation, outcome, index, {
      occurredAt: Date.now() + 10_000 + index,
      sessionId: String(session.agent.session.id),
      ruleId: exposure!.ruleId,
      guidanceVersion: exposure!.guidanceVersion,
    }))
  }
  return recorded
}

describe('assistant evolution service', () => {
  test('Host inspection requires a canonical immutable explicit scope and background Policy owner', async () => {
    const fixture = await harness()
    for (let index = 1; index <= 4; index += 1) {
      await observeTrusted(fixture, 'host-gap', 'failed', index)
    }
    const scope = canonicalEvolutionHostScope({ workspace: '/work/alpha', preset: 'primary' })
    expect(Object.isFrozen(scope)).toBe(true)
    const authorize = vi.spyOn(fixture.policy, 'authorize')

    expect(fixture.service.hostCandidates({
      scope, principal: 'owner:lark:123', operationId: 'growth-run:candidates:1',
    })).toMatchObject([{ kind: 'adopt', situation: 'automation:host-gap', evidenceTotal: 4 }])
    expect(fixture.service.hostListRules({
      scope, principal: 'owner:lark:123', operationId: 'growth-run:rules:1', status: 'active',
    })).toEqual([])
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      subject: {
        kind: 'background', id: HOST_RECOVERY_BACKGROUND_ID,
        workspace: '/work/alpha', principal: 'owner:lark:123',
      },
      action: 'inspect',
      context: { initiator: 'background' },
    }), expect.any(Object))

    expect(() => fixture.service.hostCandidates({
      scope: { ...scope } as typeof scope,
      principal: 'owner:lark:123', operationId: 'growth-run:forged-scope',
    })).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'invalid-input' }))
    expect(() => fixture.service.hostCandidates({
      scope, principal: 'owner:lark:other', operationId: 'growth-run:wrong-owner',
    })).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'forbidden' }))
    await fixture.ctx.fiber.restart()
  })

  test('projects only an exact authoritative Evaluation receipt and rejects free quality claims', async () => {
    const fixture = await harness()
    const scope = canonicalEvolutionHostScope({ workspace: '/work/alpha', preset: 'primary' })
    fixture.qualityResolver.register({
      automationId: 'authoritative-review', runId: 'run:authoritative-review:42',
      workspace: '/work/alpha', preset: 'primary', situation: 'automation:authoritative-review',
      occurredAt: 4_200, status: 'succeeded',
    })
    const trusted = fixture.qualityResolver.appendTrustedEvaluation({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      automationId: 'authoritative-review', situation: 'automation:authoritative-review',
      runId: 'run:authoritative-review:42', executionMode: 'production',
      executionStatus: 'succeeded',
      objectiveStatus: 'not-achieved',
      deliveryStatus: 'not-required',
      metrics: {},
      occurredAt: 4_200,
      idempotencyKey: 'authoritative-review:42',
      evaluatorVersion: 'terminal-v1',
    })

    const first = fixture.service.projectEvaluationOutcome({ scope, evaluationId: trusted.id })
    expect(first).toMatchObject({
      scopeKey: JSON.stringify(['/work/alpha', 'primary']),
      situation: 'automation:authoritative-review',
      outcome: 'failed',
      detail: 'authoritative Evaluation objective: not-achieved',
      source: 'evaluation',
      evidenceKind: 'objective',
      evidenceRef: trusted.id,
      learningEligible: true,
      occurredAt: 4_200,
    })
    expect(fixture.service.projectEvaluationOutcome({ scope, evaluationId: trusted.id })).toEqual(first)

    expect(() => fixture.service.projectEvaluationOutcome({
      scope,
      evaluationId: trusted.id,
      outcome: 'succeeded',
    } as never)).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({
      code: 'invalid-input',
    }))
    expect(() => fixture.service.projectEvaluationOutcome({
      scope: canonicalEvolutionHostScope({ workspace: '/work/beta', preset: 'primary' }),
      evaluationId: trusted.id,
    })).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'not-found' }))
    expect(() => fixture.service.projectEvaluationOutcome({
      scope: { workspace: '/work/alpha', preset: 'primary' } as typeof scope,
      evaluationId: trusted.id,
    })).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'invalid-input' }))
    expect(() => fixture.service.projectEvaluationOutcome({
      scope,
      evaluationId: 'outcome-00000000-0000-4000-8000-000000000000',
    })).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'not-found' }))

    const untrusted = fixture.evaluation.append({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      situation: 'authoritative-review',
      executionStatus: 'failed',
      objectiveStatus: 'not-achieved',
      deliveryStatus: 'not-required',
      source: { kind: 'foreground', id: 'model' },
      trust: 'self-reported',
      evidence: [],
      metrics: {},
      occurredAt: 4_201,
      idempotencyKey: 'untrusted-review:42',
      evaluator: { id: 'model', version: '1' },
    })
    expect(() => fixture.service.projectEvaluationOutcome({ scope, evaluationId: untrusted.id }))
      .toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'not-found' }))
    expect(() => fixture.service.recordEvaluationOutcome({} as never))
      .toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'forbidden' }))
    await fixture.ctx.fiber.restart()
  })

  test('rejects an Evaluation execution status that contradicts the exact Automation proof', async () => {
    const fixture = await harness()
    const scope = canonicalEvolutionHostScope({ workspace: '/work/alpha', preset: 'primary' })
    const situation = 'automation:status-integrity'
    const runId = 'run:status-integrity'
    fixture.qualityResolver.register({
      automationId: 'status-integrity',
      runId,
      workspace: '/work/alpha',
      preset: 'primary',
      situation,
      occurredAt: 4_300,
      status: 'succeeded',
    })
    const contradictory = fixture.qualityResolver.appendTrustedEvaluation({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      automationId: 'status-integrity',
      situation,
      runId,
      executionMode: 'production',
      executionStatus: 'failed',
      objectiveStatus: 'not-achieved',
      deliveryStatus: 'not-required',
      metrics: {},
      occurredAt: 4_300,
      idempotencyKey: 'status-integrity:contradictory',
      evaluatorVersion: 'terminal-v1',
    })

    expect(() => fixture.service.projectEvaluationOutcome({
      scope,
      evaluationId: contradictory.id,
    })).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'forbidden' }))
    await fixture.ctx.fiber.restart()
  })

  test('counts one immutable Automation run once across several Evaluation outcomes', async () => {
    const fixture = await harness()
    const scope = canonicalEvolutionHostScope({ workspace: '/work/alpha', preset: 'primary' })
    const situation = 'automation:one-learning-subject'
    const runId = 'run:one-learning-subject'
    fixture.qualityResolver.register({
      automationId: 'one-learning-subject',
      runId,
      workspace: '/work/alpha',
      preset: 'primary',
      situation,
      occurredAt: 4_400,
      status: 'succeeded',
    })
    fixture.qualityResolver.appendTrustedEvaluation({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      automationId: 'one-learning-subject',
      situation,
      runId,
      executionMode: 'production',
      executionStatus: 'succeeded',
      objectiveStatus: 'unknown',
      deliveryStatus: 'not-required',
      metrics: {},
      occurredAt: 4_400,
      idempotencyKey: 'learning-subject:terminal',
      evaluatorVersion: 'terminal-v1',
    })
    const append = (key: string, objectiveStatus: 'achieved' | 'not-achieved') => fixture
      .qualityResolver.appendTrustedEvaluation({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      automationId: 'one-learning-subject',
      situation,
      runId,
      executionMode: 'production',
      executionStatus: 'succeeded',
      objectiveStatus,
      deliveryStatus: 'not-required',
      metrics: {},
      occurredAt: 4_400,
      idempotencyKey: key,
      evaluatorVersion: 'terminal-v1',
    })
    const firstOutcome = append('learning-subject:first', 'achieved')
    const secondOutcome = append('learning-subject:second', 'achieved')
    const first = fixture.service.projectEvaluationOutcome({ scope, evaluationId: firstOutcome.id })
    const replay = fixture.service.projectEvaluationOutcome({ scope, evaluationId: secondOutcome.id })

    expect(replay).toEqual(first)
    expect(first.learningSubjectRef).toBe(JSON.stringify(['automation-run', runId]))
    expect(fixture.service.candidates(stubAgent().agent)).toEqual([])

    const contradictory = append('learning-subject:contradictory', 'not-achieved')
    const replaced = fixture.service.projectEvaluationOutcome({
      scope,
      evaluationId: contradictory.id,
    })
    expect(replaced.outcome).toBe('failed')
    expect(replaced.id).not.toBe(first.id)
    expect(fixture.service.health()).toMatchObject({
      trustedEpisodes: 2,
      qualityEligibleEpisodes: 1,
      taskLearningProjections: 1,
      taskLearningProjectionRevisions: 3,
    })
    await fixture.ctx.fiber.restart()
  })

  test('ignores partial objectives instead of converting them into failures', async () => {
    const fixture = await harness()
    const scope = canonicalEvolutionHostScope({ workspace: '/work/alpha', preset: 'primary' })
    const deliveryEvaluationProducer = new FakeDeliveryEvaluationProducer(fixture.ctx)
    await vi.waitFor(() => expect(deliveryEvaluationProducer.isBound()).toBe(true))
    const partial = deliveryEvaluationProducer.appendTrustedEvaluation({
      scope: canonicalEvaluationHostScope({ workspace: '/work/alpha', preset: 'primary' }),
      situation: 'partially-complete-report',
      runId: 'run:partially-complete-report', outboxId: 'outbox:partial:42',
      chatId: 'chat:partial', principalId: 'owner:lark:123', bindingId: 'binding:partial',
      objectiveStatus: 'partial',
      occurredAt: 4_500,
      idempotencyKey: 'partial:42',
    })

    const receipt = fixture.evaluation.getTrustedTaskLearningProjection({
      scope: canonicalEvaluationHostScope({ workspace: '/work/alpha', preset: 'primary' }),
      outcomeId: partial.id,
    })!
    expect(fixture.service.projectTrustedEvaluationTaskRevision({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      evaluationId: partial.id,
    })).toEqual({
      triggerOutcomeId: partial.id,
      subjectKind: receipt.projection.subjectKind,
      subjectRef: receipt.projection.subjectRef,
      version: receipt.projection.version,
      digest: receipt.projection.digest,
      scopeWatermark: receipt.scopeWatermark,
      disposition: 'retract',
      status: 'replayed',
    })
    expect(() => fixture.service.projectEvaluationOutcome({
      scope,
      evaluationId: partial.id,
    })).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'forbidden' }))
    expect(fixture.service.health()).toMatchObject({
      trustedEpisodes: 0,
      qualityEligibleEpisodes: 0,
    })
    expect(fixture.service.candidates(stubAgent().agent)).toEqual([])
    await fixture.ctx.fiber.restart()
  })

  test('Host rollback is one exact CAS and rejects operational-only or unexposed evidence', async () => {
    const fixture = await approvedRule('automation:host-growth', { autonomousRollback: true })
    const scope = canonicalEvolutionHostScope({ workspace: '/work/alpha', preset: 'primary' })
    for (let index = 1; index <= 4; index += 1) {
      fixture.service.recordAutomationOutcome({
        situation: fixture.rule.situation,
        outcome: 'failed', detail: `operational failure ${index}`,
        workspace: '/work/alpha', agentPreset: 'primary', automationId: 'host-growth',
        ruleId: fixture.rule.id, guidanceVersion: fixture.rule.generation,
        occurredAt: Date.now() + index,
        idempotencyKey: `host-operational-only:${index}`,
      })
    }
    expect(() => fixture.service.hostRollbackOne({
      scope, principal: 'owner:lark:123', operationId: 'growth-run:rollback-operational',
      ruleId: fixture.rule.id, expectedVersion: fixture.rule.version,
    })).toThrowError(/evidence|regression|sample/iu)

    await recordAttributedOutcomes(fixture, ['failed', 'failed', 'failed', 'failed'], 'host-objective')
    const result = fixture.service.hostRollbackOne({
      scope, principal: 'owner:lark:123', operationId: 'growth-run:rollback-objective',
      ruleId: fixture.rule.id, expectedVersion: fixture.rule.version,
    })
    expect(result).toMatchObject({
      replayed: false,
      rule: { id: fixture.rule.id, status: 'retired', version: fixture.rule.version + 1 },
      rollback: { evidence: { total: 4 } },
    })
    expect(() => fixture.service.hostRollbackOne({
      scope, principal: 'owner:lark:123', operationId: 'growth-run:rollback-stale',
      ruleId: fixture.rule.id, expectedVersion: fixture.rule.version + 1,
    })).toThrowError(/active|state|version/iu)
    await fixture.ctx.fiber.restart()
  })

  test('exposes only content-free global health counters with explicit zero timestamps', async () => {
    const fixture = await harness({ now: () => 7_000 })
    const { agent } = stubAgent()

    expect(fixture.service.health()).toEqual({
      activeRules: 0,
      retiredRules: 0,
      pendingProposals: 0,
      conflictedProposals: 0,
      trustedEpisodes: 0,
      qualityEligibleEpisodes: 0,
      operationalEpisodes: 0,
      legacyQuarantinedEpisodes: 0,
      unattributedTrustedEpisodes: 0,
      unattributedQualityEligibleEpisodes: 0,
      lastTrustedEpisodeAt: 0,
      lastQualityEligibleEpisodeAt: 0,
      lastReconciledAt: 0,
      autonomousRollbacks: 0,
      taskLearningProjections: 0,
      retractedTaskLearningProjections: 0,
      taskLearningProjectionRevisions: 0,
      taskLearningProjectionIntegrityErrors: 0,
    })

    fixture.service.recordEpisode(agent, {
      situation: 'SENTINEL-SITUATION', outcome: 'failed', detail: 'SENTINEL-DETAIL',
      occurredAt: 6_000, idempotencyKey: 'health-self-reported',
    })
    fixture.service.recordAutomationOutcome({
      situation: 'SENTINEL-AUTOMATION', outcome: 'succeeded', detail: 'SENTINEL-TRUSTED-DETAIL',
      workspace: '/work/alpha', agentPreset: 'primary', occurredAt: 6_500,
      idempotencyKey: 'health-trusted',
    })

    expect(fixture.service.health()).toMatchObject({
      trustedEpisodes: 1,
      qualityEligibleEpisodes: 0,
      operationalEpisodes: 2,
      legacyQuarantinedEpisodes: 0,
      unattributedTrustedEpisodes: 1,
      unattributedQualityEligibleEpisodes: 0,
      lastTrustedEpisodeAt: 6_500,
      lastQualityEligibleEpisodeAt: 0,
      lastReconciledAt: 0,
    })
    fixture.service.reconcileProposals()
    const serialized = JSON.stringify(fixture.service.health())
    expect(serialized).toContain('"lastReconciledAt":7000')
    expect(serialized).not.toMatch(/SENTINEL|\/work\/alpha|primary|situation|detail/i)
    await fixture.ctx.fiber.restart()
  })

  test('fails closed without a trusted Agent identity', async () => {
    const fixture = await harness()
    for (const call of [
      () => fixture.service.candidates(undefined),
      () => fixture.service.listRules(undefined),
      () => fixture.service.recordEpisode(undefined, {
        situation: 'x', outcome: 'failed', detail: 'x', source: 'foreground',
        occurredAt: 1, idempotencyKey: 'x',
      }),
    ]) {
      expect(call).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'missing-identity' }))
    }
    await fixture.ctx.fiber.restart()
  })

  test('fails closed when policy denies, even for read-only inspection', async () => {
    const fixture = await harness({ allow: false })
    const { agent } = stubAgent()

    expect(() => fixture.service.candidates(agent))
      .toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'forbidden' }))
    await fixture.ctx.fiber.restart()
  })

  test('a proposal alone never changes behaviour', async () => {
    const fixture = await adoptRule()

    expect(fixture.proposed.status).toBe('pending')
    expect(fixture.service.health()).toMatchObject({
      activeRules: 0,
      pendingProposals: 1,
      trustedEpisodes: 4,
      qualityEligibleEpisodes: 4,
      unattributedTrustedEpisodes: 4,
      unattributedQualityEligibleEpisodes: 4,
      lastTrustedEpisodeAt: 1_004,
      lastQualityEligibleEpisodeAt: 1_004,
    })
    expect(fixture.service.listRules(fixture.agent, 'active')).toEqual([])
    expect(fixture.service.guidance(fixture.agent)).toBe('')
    await fixture.ctx.fiber.restart()
  })

  test('records automation execution failures for audit without producing a learning candidate', async () => {
    const fixture = await harness()
    const { agent } = stubAgent()
    for (let index = 1; index <= 5; index += 1) {
      expect(fixture.service.recordAutomationOutcome({
        situation: 'automation:supervised-growth',
        outcome: 'failed',
        detail: 'immutable allowlist rejected preset tools',
        workspace: '/work/alpha',
        agentPreset: 'primary',
        occurredAt: 1_000 + index,
        idempotencyKey: `operational-supervised-growth:${index}`,
      })).toMatchObject({
        trust: 'trusted',
        evidenceKind: 'operational',
        learningEligible: false,
      })
    }

    expect(fixture.service.candidates(agent)).toEqual([])
    expect(fixture.service.health()).toMatchObject({
      trustedEpisodes: 5,
      operationalEpisodes: 5,
      qualityEligibleEpisodes: 0,
    })
    await fixture.ctx.fiber.restart()
  })

  test('cannot approve its own proposal: only the policy decision commits it', async () => {
    const fixture = await adoptRule()

    // The service exposes no self-approval path; the owner decides on the ledger.
    expect((fixture.service as unknown as Record<string, unknown>)['decideProposal']).toBeUndefined()
    expect(fixture.service.reconcileProposals()).toEqual([])
    expect(fixture.service.listRules(fixture.agent, 'active')).toEqual([])

    fixture.policy.decideProposal({
      proposalId: fixture.proposed.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })
    const settled = fixture.service.reconcileProposals()

    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ status: 'approved' })
    expect(fixture.service.listRules(fixture.agent, 'active')).toHaveLength(1)
    expect(fixture.service.health()).toMatchObject({ activeRules: 1, pendingProposals: 0 })
    await fixture.ctx.fiber.restart()
  })

  test('injects approved guidance into a new session, and nothing before approval', async () => {
    const fixture = await adoptRule()
    const before = stubAgent()
    agentEvents(fixture.ctx, before.agent).emit('agent/session-start', { source: 'startup' })
    expect(before.injections).toEqual([])

    fixture.policy.decideProposal({
      proposalId: fixture.proposed.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })
    fixture.service.reconcileProposals()

    const after = stubAgent()
    agentEvents(fixture.ctx, after.agent).emit('agent/session-start', { source: 'startup' })

    expect(after.injections).toHaveLength(1)
    const text = after.injections[0]!.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('<learned_guidance>')
    expect(text).toContain('Draft the report a day early.')
    expect(text).toContain('cannot widen what you are allowed to do')
    await fixture.ctx.fiber.restart()
  })

  test('does not inject guidance when policy denies the snapshot', async () => {
    const fixture = await harness({ allow: false })
    const { agent, injections } = stubAgent()

    agentEvents(fixture.ctx, agent).emit('agent/session-start', { source: 'startup' })

    expect(injections).toEqual([])
    await fixture.ctx.fiber.restart()
  })

  test('injects at most once per session', async () => {
    const fixture = await adoptRule()
    fixture.policy.decideProposal({
      proposalId: fixture.proposed.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })
    fixture.service.reconcileProposals()
    const { agent, injections } = stubAgent()

    agentEvents(fixture.ctx, agent).emit('agent/session-start', { source: 'startup' })
    agentEvents(fixture.ctx, agent).emit('agent/session-start', { source: 'startup' })

    expect(injections).toHaveLength(1)
    await fixture.ctx.fiber.restart()
  })

  test('captures only an exact durable receipt written after successful injection', async () => {
    const fixture = await approvedRule('automation:weekly-report')
    const session = stubAgent({ id: 'automation-session-1' })

    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'weekly-report',
      sessionId: String(session.agent.session.id),
    })).toBeUndefined()

    agentEvents(fixture.ctx, session.agent).emit('agent/session-start', { source: 'startup' })

    expect(session.injections).toHaveLength(1)
    const captured = await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha/projects/..',
      agentPreset: ' primary ',
      automationId: 'weekly-report',
      sessionId: String(session.agent.session.id),
    })
    expect(captured).toEqual({ ruleId: fixture.rule.id, guidanceVersion: fixture.rule.generation })
    expect(fixture.service.recordAutomationOutcome({
      situation: 'automation:weekly-report',
      outcome: 'failed',
      detail: 'claimed before injection',
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'weekly-report',
      sessionId: String(session.agent.session.id),
      ruleId: captured!.ruleId,
      guidanceVersion: captured!.guidanceVersion,
      occurredAt: 0,
      idempotencyKey: 'pre-exposure-outcome',
    })).toMatchObject({ ruleId: undefined, claimedRuleId: fixture.rule.id })
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/beta',
      agentPreset: 'primary',
      automationId: 'weekly-report',
      sessionId: String(session.agent.session.id),
    })).toBeUndefined()
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'other',
      sessionId: String(session.agent.session.id),
    })).toBeUndefined()
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'weekly-report',
      sessionId: 'wrong-session',
    })).toBeUndefined()
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'weekly-report',
      sessionId: ` ${String(session.agent.session.id)} `,
    })).toBeUndefined()
    await fixture.ctx.fiber.restart()
  })

  test('never injects guidance or records exposure for preview automation Agents', async () => {
    const fixture = await approvedRule('automation:preview-safe')
    const preview = stubAgent({ id: 'preview-session' })
    preview.agent.ctx.provide('assistantAutomationExecution' as never, Object.freeze({
      mode: 'preview',
      automationId: 'preview-safe',
      occurrenceId: 'occurrence-preview',
    }) as never)

    agentEvents(fixture.ctx, preview.agent).emit('agent/session-start', { source: 'startup' })

    expect(preview.injections).toEqual([])
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'preview-safe',
      sessionId: String(preview.agent.session.id),
    })).toBeUndefined()

    const production = stubAgent({ id: 'production-session' })
    production.agent.ctx.provide('assistantAutomationExecution' as never, Object.freeze({
      mode: 'production',
      automationId: 'preview-safe',
      occurrenceId: 'occurrence-production',
    }) as never)
    agentEvents(fixture.ctx, production.agent).emit('agent/session-start', { source: 'startup' })
    expect(production.injections).toHaveLength(1)
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'preview-safe',
      sessionId: String(production.agent.session.id),
    })).toEqual({ ruleId: fixture.rule.id, guidanceVersion: fixture.rule.generation })
    await fixture.ctx.fiber.restart()
  })

  test('does not create a receipt when injection fails', async () => {
    const fixture = await approvedRule('automation:weekly-report')
    const session = stubAgent({
      id: 'failed-injection-session',
      inject: () => { throw new Error('inject failed') },
    })

    agentEvents(fixture.ctx, session.agent).emit('agent/session-start', { source: 'startup' })
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'weekly-report',
      sessionId: String(session.agent.session.id),
    })).toBeUndefined()
    await fixture.ctx.fiber.restart()
  })

  test('persists injection idempotency and exposure across a service restart', async () => {
    const first = await approvedRule('automation:weekly-report')
    const sessionId = 'resumed-automation-session'
    const initial = stubAgent({ id: sessionId })
    agentEvents(first.ctx, initial.agent).emit('agent/session-start', { source: 'startup' })
    expect(initial.injections).toHaveLength(1)
    const expected = {
      ruleId: first.rule.id,
      guidanceVersion: first.rule.generation,
    }
    const root = first.root
    await first.ctx.fiber.restart()

    const restarted = await harness({ root })
    const resumed = stubAgent({ id: sessionId })
    agentEvents(restarted.ctx, resumed.agent).emit('agent/session-start', { source: 'startup' })

    expect(resumed.injections).toEqual([])
    expect(await restarted.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'weekly-report',
      sessionId,
    })).toEqual(expected)
    await restarted.ctx.fiber.restart()
  })

  test('with several active rules attributes only the exact automation situation actually injected', async () => {
    const fixture = await harness({ maxInjectedRules: 1 })
    const { agent } = stubAgent()
    for (const situation of ['automation:a', 'automation:b']) {
      for (let index = 1; index <= 4; index += 1) {
        await observeTrusted(fixture, situation, 'failed', index, {
          workspace: '/work/alpha',
        })
      }
      const proposal = fixture.service.propose(agent, {
        mutation: { op: 'adopt', input: { situation, guidance: `Guidance for ${situation}.` } },
        principal: 'owner:lark:123',
      })
      approve(fixture, proposal)
    }
    const session = stubAgent({ id: 'bounded-guidance-session' })

    agentEvents(fixture.ctx, session.agent).emit('agent/session-start', { source: 'startup' })

    expect(session.injections).toHaveLength(1)
    const capturedA = await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha', agentPreset: 'primary', automationId: 'a',
      sessionId: String(session.agent.session.id),
    })
    expect(capturedA?.ruleId).toBe(fixture.service.listRules(agent, 'active')
      .find(rule => rule.situation === 'automation:a')?.id)
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha', agentPreset: 'primary', automationId: 'b',
      sessionId: String(session.agent.session.id),
    })).toBeUndefined()
    await fixture.ctx.fiber.restart()
  })

  test('prioritizes the exact production Automation rule before the global 12-rule limit', async () => {
    const fixture = await harness({ maxInjectedRules: 12 })
    const { agent } = stubAgent()
    const situations = [
      ...Array.from({ length: 12 }, (_, index) => `automation:a${String(index).padStart(2, '0')}`),
      'automation:zz-target',
    ]
    for (const situation of situations) {
      for (let index = 1; index <= 4; index += 1) {
        await observeTrusted(fixture, situation, 'failed', index)
      }
      const proposal = fixture.service.propose(agent, {
        mutation: { op: 'adopt', input: { situation, guidance: `Guidance for ${situation}.` } },
        principal: 'owner:lark:123',
      })
      approve(fixture, proposal)
    }
    const session = stubAgent({ id: 'thirteenth-exact-automation-session' })
    const execution = Object.freeze({
      mode: 'production' as const,
      automationId: 'zz-target',
      occurrenceId: 'occurrence-thirteenth-exact',
    })
    session.agent.ctx.provide('assistantAutomationExecution' as never, execution as never)

    fixture.service.injectAutomationGuidance(session.agent, execution)

    expect(session.injections).toHaveLength(1)
    const injected = session.injections[0]!.content
      .map(block => block.type === 'text' ? block.text : '').join('')
    expect(injected).toContain('Guidance for automation:zz-target.')
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'zz-target',
      sessionId: String(session.agent.session.id),
    })).toMatchObject({ ruleId: expect.stringMatching(/^rule-/u) })
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'a11',
      sessionId: String(session.agent.session.id),
    })).toBeUndefined()
    const database = new DatabaseSync(join(fixture.root, 'evolution.sqlite'))
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM evolution_guidance_exposures WHERE session_id = ?
    `).get(String(session.agent.session.id))).toEqual({ count: 12 })

    const lateContext = stubAgent({ id: 'thirteenth-late-context-session' })
    agentEvents(fixture.ctx, lateContext.agent).emit('agent/session-start', { source: 'startup' })
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'zz-target',
      sessionId: String(lateContext.agent.session.id),
    })).toBeUndefined()
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM evolution_guidance_exposures WHERE session_id = ?
    `).get(String(lateContext.agent.session.id))).toEqual({ count: 11 })
    lateContext.agent.ctx.provide('assistantAutomationExecution' as never, execution as never)
    fixture.service.injectAutomationGuidance(lateContext.agent, execution)
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha',
      agentPreset: 'primary',
      automationId: 'zz-target',
      sessionId: String(lateContext.agent.session.id),
    })).toMatchObject({ ruleId: expect.stringMatching(/^rule-/u) })
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM evolution_guidance_exposures WHERE session_id = ?
    `).get(String(lateContext.agent.session.id))).toEqual({ count: 12 })
    database.close()
    await fixture.ctx.fiber.restart()
  })

  test('rejects ambiguous exposure after two generations were injected into one resumed session', async () => {
    const fixture = await approvedRule('automation:weekly-report')
    const sessionId = 'multi-generation-session'
    const firstSession = stubAgent({ id: sessionId })
    agentEvents(fixture.ctx, firstSession.agent).emit('agent/session-start', { source: 'startup' })

    await recordAttributedOutcomes(
      fixture,
      ['failed', 'failed', 'failed', 'failed'],
      'first-generation-retire',
    )

    const retire = fixture.service.propose(fixture.agent, {
      mutation: {
        op: 'retire',
        ruleId: fixture.rule.id,
        expectedVersion: fixture.rule.version,
        reason: 'replace guidance',
      },
      principal: 'owner:lark:123',
    })
    approve(fixture, retire)
    const afterRetirement = Date.now() + 10_000
    for (let index = 1; index <= 4; index += 1) {
      await observeTrusted(fixture, 'automation:weekly-report', 'failed', index, {
        occurredAt: afterRetirement + index,
      })
    }
    const readopt = fixture.service.propose(fixture.agent, {
      mutation: {
        op: 'adopt',
        input: { situation: 'automation:weekly-report', guidance: 'Use replacement guidance.' },
      },
      principal: 'owner:lark:123',
    })
    approve(fixture, readopt)

    const resumed = stubAgent({ id: sessionId })
    agentEvents(fixture.ctx, resumed.agent).emit('agent/session-start', { source: 'startup' })

    expect(resumed.injections).toHaveLength(1)
    const replacementText = resumed.injections[0]!.content
      .map(block => block.type === 'text' ? block.text : '').join('')
    expect(replacementText).toContain('Use replacement guidance.')
    expect(replacementText).not.toContain('Draft the report a day early.')
    expect(await fixture.service.captureAutomationExposure({
      workspace: '/work/alpha', agentPreset: 'primary', automationId: 'weekly-report', sessionId,
    })).toBeUndefined()
    await fixture.ctx.fiber.restart()
  })

  test('exact captured automated outcomes become post-adoption retirement evidence', async () => {
    const fixture = await approvedRule('automation:nightly')
    for (let index = 1; index <= 4; index += 1) {
      const session = stubAgent({ id: `nightly-session-${index}` })
      agentEvents(fixture.ctx, session.agent).emit('agent/session-start', { source: 'startup' })
      const exposure = (await fixture.service.captureAutomationExposure({
        workspace: '/work/alpha',
        agentPreset: 'primary',
        automationId: 'nightly',
        sessionId: String(session.agent.session.id),
      }))!
      const episode = await observeTrusted(fixture, 'automation:nightly', 'failed', index, {
        sessionId: String(session.agent.session.id),
        ruleId: exposure.ruleId,
        guidanceVersion: exposure.guidanceVersion,
        occurredAt: Date.now() + 10_000 + index,
      })
      expect(episode).toMatchObject({
        trust: 'trusted',
        ruleId: fixture.rule.id,
        guidanceVersion: fixture.rule.generation,
      })
    }

    expect(fixture.service.candidates(fixture.agent)).toMatchObject([{
      kind: 'retire',
      ruleId: fixture.rule.id,
      stats: { failures: 4, total: 4 },
    }])
    await fixture.ctx.fiber.restart()
  })

  test('post-exposure execution failures remain ineligible for retirement and automatic rollback', async () => {
    const fixture = await approvedRule('automation:operational-retire-gate', {
      autonomousRollback: true,
    })
    for (let index = 1; index <= 5; index += 1) {
      const session = stubAgent({ id: `operational-retire-session-${index}` })
      agentEvents(fixture.ctx, session.agent).emit('agent/session-start', { source: 'startup' })
      const exposure = (await fixture.service.captureAutomationExposure({
        workspace: '/work/alpha',
        agentPreset: 'primary',
        automationId: 'operational-retire-gate',
        sessionId: String(session.agent.session.id),
      }))!
      expect(fixture.service.recordAutomationOutcome({
        situation: fixture.rule.situation,
        outcome: 'failed',
        detail: `provider failed ${index}`,
        workspace: '/work/alpha',
        agentPreset: 'primary',
        automationId: 'operational-retire-gate',
        sessionId: String(session.agent.session.id),
        ruleId: exposure.ruleId,
        guidanceVersion: exposure.guidanceVersion,
        occurredAt: Date.now() + 10_000 + index,
        idempotencyKey: `operational-retire-gate:${index}`,
      })).toMatchObject({
        ruleId: fixture.rule.id,
        evidenceKind: 'operational',
        learningEligible: false,
      })
    }

    expect(fixture.service.candidates(fixture.agent)).toEqual([])
    expect(() => fixture.service.rollback(fixture.agent, {
      ruleId: fixture.rule.id,
      expectedVersion: fixture.rule.version,
    })).toThrowError(/regression evidence/u)
    expect(fixture.service.listRules(fixture.agent, 'active')).toHaveLength(1)
    await fixture.ctx.fiber.restart()
  })

  test('direct service retirement refuses zero or insufficient exact attributed evidence before Policy dispatch', async () => {
    const fixture = await approvedRule('automation:retire-gate')
    const recover = vi.spyOn(fixture.policy, 'recoverOrCreateProposal')
    const request = {
      mutation: {
        op: 'retire' as const,
        ruleId: fixture.rule.id,
        expectedVersion: fixture.rule.version,
        reason: 'the rule did not help',
      },
      principal: 'owner:lark:123',
    }

    expect(() => fixture.service.propose(fixture.agent, request))
      .toThrowError(/retire candidate|evidence|sample/iu)
    expect(recover).not.toHaveBeenCalled()

    await recordAttributedOutcomes(fixture, ['failed', 'failed', 'failed'], 'insufficient-retire')
    expect(() => fixture.service.propose(fixture.agent, request))
      .toThrowError(/retire candidate|evidence|sample/iu)
    expect(recover).not.toHaveBeenCalled()
    await fixture.ctx.fiber.restart()
  })

  test('autonomous rollback is opt-in and never falls back to a proposal', async () => {
    const fixture = await approvedRule('automation:rollback-disabled')
    await recordAttributedOutcomes(
      fixture,
      ['failed', 'failed', 'failed', 'failed'],
      'rollback-disabled',
    )
    const authorize = vi.spyOn(fixture.policy, 'authorizeAgent')

    expect(() => fixture.service.rollback(fixture.agent, {
      ruleId: fixture.rule.id,
      expectedVersion: fixture.rule.version,
    })).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'forbidden' }))
    expect(authorize).not.toHaveBeenCalled()
    expect(fixture.service.listRules(fixture.agent, 'active')).toHaveLength(1)
    expect(fixture.policy.listPendingApprovalDispatches()).toHaveLength(0)
    await fixture.ctx.fiber.restart()
  })

  test('Host recomputes and atomically applies an exact low-risk rollback', async () => {
    const fixture = await approvedRule('automation:auto-rollback', { autonomousRollback: true })
    const episodes = await recordAttributedOutcomes(
      fixture,
      ['failed', 'failed', 'failed', 'failed'],
      'auto-rollback',
    )
    const authorize = vi.spyOn(fixture.policy, 'authorizeAgent')

    const result = fixture.service.rollback(fixture.agent, {
      ruleId: fixture.rule.id,
      expectedVersion: fixture.rule.version,
    })

    expect(authorize).toHaveBeenCalledWith(
      fixture.agent,
      'rollback',
      { kind: 'evolution', id: `rule:${fixture.rule.id}` },
    )
    expect(result).toMatchObject({
      replayed: false,
      rule: { id: fixture.rule.id, status: 'retired', version: 2 },
      rollback: {
        risk: 'low',
        evaluation: { failures: 4, total: 4 },
        baseline: { failures: 4, total: 4 },
        evidence: { total: 4 },
      },
    })
    expect(result.rollback.reason).toMatch(/Automatic low-risk rollback/u)
    expect(result.rollback.evidence.sampleEpisodeIds)
      .toEqual(episodes.toReversed().map(episode => episode.id))
    expect(fixture.service.guidance(fixture.agent)).toBe('')
    expect(fixture.service.health()).toMatchObject({
      activeRules: 0,
      retiredRules: 1,
      autonomousRollbacks: 1,
    })
    expect(fixture.policy.listPendingApprovalDispatches()).toHaveLength(0)
    await fixture.ctx.fiber.restart()
  })

  test('autonomous rollback requires its distinct exact Policy capability and scope', async () => {
    const denied = await approvedRule('automation:rollback-policy-denied', {
      autonomousRollback: true,
      allowRollbackPolicy: false,
    })
    await recordAttributedOutcomes(denied, ['failed', 'failed', 'failed', 'failed'], 'rollback-denied')
    expect(() => denied.service.rollback(denied.agent, {
      ruleId: denied.rule.id,
      expectedVersion: denied.rule.version,
    })).toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'forbidden' }))
    expect(denied.service.listRules(denied.agent, 'active')).toHaveLength(1)
    await denied.ctx.fiber.restart()

    const scoped = await approvedRule('automation:rollback-scope', { autonomousRollback: true })
    await recordAttributedOutcomes(scoped, ['failed', 'failed', 'failed', 'failed'], 'rollback-scope')
    const beta = stubAgent({ cwd: '/work/beta' })
    expect(() => scoped.service.rollback(beta.agent, {
      ruleId: scoped.rule.id,
      expectedVersion: scoped.rule.version,
    })).toThrowError(expect.objectContaining<Partial<EvolutionStoreError>>({ code: 'not-found' }))
    expect(scoped.service.listRules(scoped.agent, 'active')).toHaveLength(1)
    await scoped.ctx.fiber.restart()
  })

  test('autonomous rollback replays its immutable Host receipt exactly', async () => {
    const fixture = await approvedRule('automation:rollback-replay', { autonomousRollback: true })
    await recordAttributedOutcomes(fixture, ['failed', 'failed', 'failed', 'failed'], 'rollback-replay')
    const input = { ruleId: fixture.rule.id, expectedVersion: fixture.rule.version }

    const first = fixture.service.rollback(fixture.agent, input)
    const replay = fixture.service.rollback(fixture.agent, input)

    expect(replay.replayed).toBe(true)
    expect(replay.rollback).toEqual(first.rollback)
    expect(replay.rule).toEqual(first.rule)
    expect(fixture.service.health().autonomousRollbacks).toBe(1)
    await fixture.ctx.fiber.restart()
  })

  test('cross-scope, claimed, self-reported, and old-generation rows never satisfy retirement evidence', async () => {
    const fixture = await approvedRule('automation:exact-retire')
    const database = new DatabaseSync(join(fixture.root, 'evolution.sqlite'))
    const scopeKey = JSON.stringify(['/work/alpha', 'primary'])
    const insert = database.prepare(`
      INSERT INTO evolution_episodes(
        id, idempotency_key, situation, outcome, detail, source, scope_key,
        trust, evidence_kind, evidence_ref, learning_eligible,
        rule_id, guidance_version, claimed_rule_id, occurred_at)
      VALUES (?, ?, ?, 'failed', ?, 'automation', ?, ?, 'operational', NULL, 0, ?, ?, ?, ?)
    `)
    let sequence = 0
    const add = (input: {
      scopeKey?: string
      trust?: 'trusted' | 'self-reported'
      ruleId?: string
      guidanceVersion?: number
      claimedRuleId?: string
    }) => {
      sequence += 1
      const id = `episode-00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
      insert.run(
        id,
        `ineligible:${sequence}`,
        fixture.rule.situation,
        `ineligible ${sequence}`,
        input.scopeKey ?? scopeKey,
        input.trust ?? 'trusted',
        input.ruleId ?? null,
        input.guidanceVersion ?? null,
        input.claimedRuleId ?? null,
        Date.now() + 20_000 + sequence,
      )
    }
    for (let index = 0; index < 4; index += 1) {
      add({ scopeKey: JSON.stringify(['/work/beta', 'primary']), ruleId: fixture.rule.id,
        guidanceVersion: fixture.rule.generation })
      add({ trust: 'self-reported', ruleId: fixture.rule.id,
        guidanceVersion: fixture.rule.generation })
      add({ claimedRuleId: fixture.rule.id })
      add({ ruleId: fixture.rule.id, guidanceVersion: fixture.rule.generation + 1 })
    }
    database.close()
    const recover = vi.spyOn(fixture.policy, 'recoverOrCreateProposal')

    expect(() => fixture.service.propose(fixture.agent, {
      mutation: {
        op: 'retire',
        ruleId: fixture.rule.id,
        expectedVersion: fixture.rule.version,
        reason: 'launder ineligible evidence',
      },
      principal: 'owner:lark:123',
    })).toThrowError(/retire candidate|evidence|sample/iu)
    expect(recover).not.toHaveBeenCalled()
    await fixture.ctx.fiber.restart()
  })

  test('a rejected proposal leaves behaviour unchanged', async () => {
    const fixture = await adoptRule()
    fixture.policy.decideProposal({
      proposalId: fixture.proposed.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'rejected',
      reason: 'owner declined',
    })

    const settled = fixture.service.reconcileProposals()

    expect(settled[0]).toMatchObject({ status: 'rejected' })
    expect(fixture.service.guidance(fixture.agent)).toBe('')
    await fixture.ctx.fiber.restart()
  })

  test('reconcile is idempotent and treats an undecided proposal as pending', async () => {
    const fixture = await adoptRule()
    expect(fixture.service.reconcileProposals()).toEqual([])

    fixture.policy.decideProposal({
      proposalId: fixture.proposed.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })

    expect(fixture.service.reconcileProposals()).toHaveLength(1)
    expect(fixture.service.reconcileProposals()).toEqual([])
    expect(fixture.service.listRules(fixture.agent, 'active')).toHaveLength(1)
    await fixture.ctx.fiber.restart()
  })

  test('replays an identical proposal instead of creating a second one', async () => {
    const fixture = await adoptRule()
    const candidate = fixture.service.candidates(fixture.agent)[0]!
    const replay = fixture.service.propose(fixture.agent, {
      mutation: {
        op: 'adopt',
        ruleId: 'rule-weekly-report',
        input: { situation: 'automation:weekly-report', guidance: 'Draft the report a day early.' },
        baseline: candidate.stats,
      },
      principal: 'owner:lark:123',
    })

    expect(replay.proposalId).toBe(fixture.proposed.proposalId)
    expect(replay.replayed).toBe(true)
    const database = new DatabaseSync(join(fixture.root, 'evolution.sqlite'))
    const stored = database.prepare(`
      SELECT mutation_json, creation_intent_json FROM evolution_proposals WHERE id = ?
    `).get(replay.proposalId) as { mutation_json: string; creation_intent_json: string }
    const mutation = JSON.parse(stored.mutation_json) as { ruleId: string }
    const intent = JSON.parse(stored.creation_intent_json) as { diff: string }
    expect(mutation.ruleId).toMatch(/^rule-[0-9a-f-]{36}$/u)
    expect(JSON.parse(intent.diff)).toMatchObject({ op: 'adopt', ruleId: mutation.ruleId })
    database.close()
    await fixture.ctx.fiber.restart()
  })

  test('foreground rule ids are claims and never trusted candidate evidence', async () => {
    const fixture = await harness()
    const { agent } = stubAgent()
    const first = fixture.service.recordEpisode(agent, {
      situation: 'foreground-only',
      outcome: 'failed',
      detail: 'model asserted failure',
      source: 'foreground',
      ruleId: 'claimed-rule',
      occurredAt: 1_001,
      idempotencyKey: 'foreground-only:1',
    })
    for (let index = 2; index <= 4; index += 1) {
      observe(fixture.service, agent, 'foreground-only', 'failed', index)
    }

    expect(first).toMatchObject({
      trust: 'self-reported', claimedRuleId: 'claimed-rule', ruleId: undefined,
    })
    expect(fixture.service.candidates(agent)).toEqual([])
    await fixture.ctx.fiber.restart()
  })

  test('returns bounded deterministic untrusted evidence from the exact candidate window', async () => {
    const fixture = await harness({ maxEvidenceSamples: 2 })
    const { agent } = stubAgent()
    const trusted = []
    for (let index = 1; index <= 4; index += 1) {
      trusted.push(await observeTrusted(
        fixture,
        'evidence-review',
        index === 4 ? 'succeeded' : 'failed',
        index,
      ))
    }
    fixture.service.recordEpisode(agent, {
      situation: 'evidence-review',
      outcome: 'failed',
      detail: 'self-reported and ineligible',
      occurredAt: 2_000,
      idempotencyKey: 'evidence-review:self-reported',
    })

    const first = fixture.service.candidates(agent)[0]!
    const replay = fixture.service.candidates(agent)[0]!

    expect(first.evidence).toEqual([
      {
        episodeId: trusted[3]!.id,
        outcome: 'succeeded',
        evidenceKind: 'objective',
        evidenceRef: trusted[3]!.evidenceRef,
        detail: 'authoritative Evaluation objective: achieved',
        occurredAt: 1_004,
      },
      {
        episodeId: trusted[2]!.id,
        outcome: 'failed',
        evidenceKind: 'objective',
        evidenceRef: trusted[2]!.evidenceRef,
        detail: 'authoritative Evaluation objective: not-achieved',
        occurredAt: 1_003,
      },
    ])
    expect(first.evidenceDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.evidenceDigest).toBe(replay.evidenceDigest)
    expect(first.evidenceTotal).toBe(4)
    await fixture.ctx.fiber.restart()
  })

  test('persists adoption evidence IDs and digest through proposal and audit settlement', async () => {
    const fixture = await harness()
    const { agent } = stubAgent()
    for (let index = 1; index <= 4; index += 1) {
      await observeTrusted(fixture, 'traceable-guidance', 'failed', index)
    }
    const candidate = fixture.service.candidates(agent)[0]!
    const proposed = fixture.service.propose(agent, {
      mutation: {
        op: 'adopt',
        input: {
          situation: 'automation:traceable-guidance',
          guidance: 'Use the reviewed evidence.',
        },
      },
      principal: 'owner:lark:123',
    })
    const database = new DatabaseSync(join(fixture.root, 'evolution.sqlite'))
    const pending = database.prepare('SELECT mutation_json FROM evolution_proposals WHERE id = ?')
      .get(proposed.proposalId) as { mutation_json: string }
    const mutation = JSON.parse(pending.mutation_json) as {
      evidence: {
        sampleEpisodeIds: string[]
        digest: string
        total: number
        window: number
        scopeWatermark: number
        taskRevisions: unknown[]
      }
    }
    expect(mutation.evidence).toEqual({
      sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
      digest: candidate.evidenceDigest,
      total: candidate.evidenceTotal,
      window: 10,
      scopeWatermark: candidate.scopeWatermark,
      taskRevisions: candidate.taskRevisions,
    })
    fixture.policy.decideProposal({
      proposalId: proposed.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'evidence reviewed',
    })
    const [settled] = fixture.service.reconcileProposals()
    const trace = database.prepare(`
      SELECT p.mutation_json FROM evolution_audit AS a
      JOIN evolution_proposals AS p ON p.result_rule_id = a.rule_id
      WHERE a.rule_id = ? AND a.operation = 'adopt'
        AND json_extract(p.mutation_json, '$.op') = 'adopt'
    `).get(settled!.rule!.id) as { mutation_json: string }
    expect(JSON.parse(trace.mutation_json)).toMatchObject({ evidence: mutation.evidence })
    database.close()
    await fixture.ctx.fiber.restart()
  })

  test('trusted automation input without an exact exposure keeps rule id only as a claim', async () => {
    const fixture = await harness()
    const episode = fixture.service.recordAutomationOutcome({
      situation: 'weekly-report',
      outcome: 'failed',
      detail: 'automation failed',
      workspace: '/work/alpha/projects/..',
      agentPreset: ' primary ',
      automationId: 'weekly-report',
      sessionId: 'session-without-receipt',
      ruleId: 'rule-from-exposure',
      guidanceVersion: 7,
      occurredAt: 1_001,
      idempotencyKey: 'automation:1',
    })

    expect(episode).toMatchObject({
      scopeKey: JSON.stringify(['/work/alpha', 'primary']),
      trust: 'trusted',
      ruleId: undefined,
      guidanceVersion: undefined,
      claimedRuleId: 'rule-from-exposure',
    })
    await fixture.ctx.fiber.restart()
  })

  test('rules and guidance are isolated by canonical Agent scope', async () => {
    const fixture = await adoptRule()
    fixture.policy.decideProposal({
      proposalId: fixture.proposed.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })
    fixture.service.reconcileProposals()
    const beta = stubAgent({ cwd: '/work/beta' })

    expect(fixture.service.listRules(beta.agent, 'active')).toEqual([])
    expect(fixture.service.guidance(beta.agent)).toBe('')
    await fixture.ctx.fiber.restart()
  })

  test('refuses every operation after disposal', async () => {
    const fixture = await harness()
    const { agent } = stubAgent()
    await fixture.ctx.fiber.restart()

    expect(() => fixture.service.listRules(agent))
      .toThrowError(expect.objectContaining<Partial<AssistantEvolutionError>>({ code: 'disposed' }))
  })
})
