import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  KNOWN_SESSION_EVENT_TYPES,
  SessionPreparation,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService, type DeliveryAdapter, type OutboundIntent } from '@dsh-enhanced/assistant-delivery'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import {
  growthObjectDigest,
  workflowArgumentShapeDigest,
  workflowCandidateSignature,
  workflowScopeKey,
  type GrowthAutomationProposalRequest,
  type WorkflowTraceRevision,
} from '@dsh-enhanced/assistant-growth-contract'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantGrowthExperimentsService } from '../src/service.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

// The public Delivery runtime creates/adopts its bound workspace. Use the
// system temporary directory so this integration test does not need authority
// to create a synthetic top-level /work path.
const workspace = tmpdir()
const preset = 'primary'
const principal = Object.freeze({
  channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner',
})
const principalId = 'lark/bot-1/tenant-a/ou_owner'
const conversation = Object.freeze({
  channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner',
})
const secretPrompt = 'PRIVATE: prepare the owner-only daily operating summary.'
const verifiedRepetitionSelector = '准备每日工作区状态摘要'
const modelStep = Object.freeze({
  catalogId: 'assistant.agent-turn',
  argumentSchemaDigest: workflowArgumentShapeDigest({ prompt: secretPrompt }),
})

interface PersistedSession {
  events: readonly SessionEvent[]
  header: SessionHeader
}

/** Minimal durable session backend required by Delivery's public Agent resume path. */
function mountSessionPersistence(ctx: Context): void {
  const saved = new Map<string, PersistedSession>()
  ctx.on('session/flush', session => {
    saved.set(String(session.id), structuredClone({ header: session.header, events: session.events }))
  })
  ctx.provide('sessionPersistence' as never, {
    coordinator: {
      assertEventsSupported(_header: SessionHeader, events: readonly SessionEvent[]) {
        for (const event of events) {
          if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue
          throw new Error(`unsupported durable session event: ${event.type}`)
        }
      },
    },
    list: async () => [...saved.values()].map(value => structuredClone(value.header)),
    prepare: async (id: SessionId) => {
      const value = saved.get(String(id))
      if (value === undefined) throw new Error(`missing durable session ${String(id)}`)
      const restored = structuredClone(value)
      return SessionPreparation.create(ctx.sessions.prepare(id, {
        seedSource: 'persistence',
        seed: [...restored.events],
        meta: restored.header,
      }))
    },
  } as never)
}

class GrowthTextAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Growth canary completed.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Growth canary completed.' } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface SeededWorkflow {
  bindingId: string
  candidateId: string
  candidateDigest: string
  experimentId: string
  automationId: string
  sourceProviderMessageId: string
  subjectRef: string
  trace: Readonly<WorkflowTraceRevision>
}

async function driveDelivery(service: AssistantDeliveryService): Promise<void> {
  await service.tick()
  await service.whenIdle()
  await service.tick()
  await service.whenIdle()
}

/**
 * Seed the real stack through Delivery's supported owner-facing routes.  This
 * deliberately avoids importing Delivery's internal Store from a different
 * package: the test now exercises pairing, Agent reply delivery, /workflow
 * save, and trace publication exactly as an installed bundle does.
 */
async function seedOwnerWorkflow(
  service: AssistantDeliveryService,
  delivered: readonly { intent: Readonly<OutboundIntent>; providerMessageId: string }[],
  deliveryPath: string,
): Promise<SeededWorkflow> {
  const captured: WorkflowTraceRevision[] = []
  const registration = service.registerWorkflowTraceSink({
    contractVersion: 1,
    sink: {
      projectWorkflowTraceRevision(revision) {
        captured.push(structuredClone(revision))
        return {
          contractVersion: 1,
          source: revision.source,
          scope: revision.scope,
          subjectRef: revision.subjectRef,
          version: revision.version,
          disposition: revision.disposition,
          digest: revision.digest,
          outcome: 'applied' as const,
          candidateIds: [],
        }
      },
    },
  })
  try {
    const pairing = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    await service.acceptInbound({
      channel: principal.channel,
      account: principal.account,
      eventId: 'evt-workflow-source',
      occurredAt: Date.now() - 10_000,
      principal,
      conversation,
      kind: 'text',
      text: secretPrompt,
      metadata: { source: 'test-owner' },
    })
    await driveDelivery(service)
    const sourceDelivery = delivered.find(entry => entry.intent.replyToEventId === 'evt-workflow-source')
    if (sourceDelivery === undefined) {
      const database = new DatabaseSync(deliveryPath, { readOnly: true })
      try {
        const inbox = database.prepare(`
          SELECT status, failure_code FROM inbox_messages WHERE event_id = 'evt-workflow-source'
        `).get() as { status: string; failure_code: string | null } | undefined
        const outbox = database.prepare(`
          SELECT status, failure_code FROM outbox_messages ORDER BY created_at, id
        `).all() as Array<{ status: string; failure_code: string | null }>
        throw new Error(`real-stack source Agent reply was not delivered (${JSON.stringify({ inbox, outbox })})`)
      } finally {
        database.close()
      }
    }
    await service.acceptInbound({
      channel: principal.channel,
      account: principal.account,
      eventId: 'evt-workflow-review',
      occurredAt: Date.now() - 9_000,
      principal,
      conversation,
      kind: 'command',
      text: '/workflow save name="Daily owner summary" cron="0 9 * * *" timezone="UTC"',
      metadata: { replyToProviderMessageId: sourceDelivery.providerMessageId },
    })
    await driveDelivery(service)
    await service.projectWorkflowTraces()
    const trace = captured.find(revision => revision.disposition === 'upsert')
    const evidence = trace?.evidence
    if (trace === undefined || evidence === undefined) {
      throw new Error('real-stack owner workflow trace was not published')
    }
    const scope = trace.scope
    const signature = workflowCandidateSignature({ scope, evidence })
    const candidateId = `workflow_${growthObjectDigest([
      'workflow-candidate/v1', workflowScopeKey(scope), signature,
    ])}`
    const candidateDigest = growthObjectDigest({
      contract: 'assistant-growth-evidence-window/v1',
      rows: [{ subjectRef: trace.subjectRef, version: trace.version, digest: trace.digest }],
    })
    const experimentId = `growth_${growthObjectDigest([
      'assistant-growth-experiment/v1', candidateId, 1, candidateDigest,
    ])}`
    const automationId = `workflow-growth:${growthObjectDigest([
      'assistant-growth-automation/v1', experimentId, candidateId, 1, candidateDigest,
    ])}`
    return {
      bindingId: evidence.ownerBindingId,
      candidateId,
      candidateDigest,
      experimentId,
      automationId,
      sourceProviderMessageId: sourceDelivery.providerMessageId,
      subjectRef: trace.subjectRef,
      trace,
    }
  } finally {
    registration.dispose()
  }
}

async function retractOwnerWorkflow(service: AssistantDeliveryService, seed: SeededWorkflow): Promise<void> {
  await service.acceptInbound({
    channel: principal.channel,
    account: principal.account,
    eventId: 'evt-workflow-retract',
    occurredAt: Date.now(),
    principal,
    conversation,
    kind: 'command',
    text: '/workflow retract',
    metadata: { replyToProviderMessageId: seed.sourceProviderMessageId },
  })
  await driveDelivery(service)
  await service.projectWorkflowTraces()
}

/**
 * Exercise the ordinary Agent-reply feedback path. The selected phrase is a
 * closed Delivery catalog selector, so its source text must not cross into
 * the verified-repetition trace that Growth receives.
 */
async function publishVerifiedRepetition(
  service: AssistantDeliveryService,
  delivered: readonly { intent: Readonly<OutboundIntent>; providerMessageId: string }[],
): Promise<void> {
  await service.acceptInbound({
    channel: principal.channel,
    account: principal.account,
    eventId: 'evt-verified-repetition-source',
    occurredAt: Date.now(),
    principal,
    conversation,
    kind: 'text',
    text: verifiedRepetitionSelector,
    metadata: { source: 'verified-repetition-e2e' },
  })
  await driveDelivery(service)
  const source = delivered.find(entry => entry.intent.replyToEventId === 'evt-verified-repetition-source')
  if (source === undefined) throw new Error('ordinary Agent result for verified repetition was not delivered')
  await service.acceptInbound({
    channel: principal.channel,
    account: principal.account,
    eventId: 'evt-verified-repetition-feedback',
    occurredAt: Date.now(),
    principal,
    conversation,
    kind: 'command',
    text: '/feedback achieved',
    metadata: { replyToProviderMessageId: source.providerMessageId },
  })
  await driveDelivery(service)
  await service.projectWorkflowTraces()
}

const pause = () => new Promise(resolve => setTimeout(resolve, 3))

describe('real supervised workflow-growth stack', () => {
  test('survives restarts and lost ACKs across exact approval, blocked shadow, one canary, promotion, and rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-growth-real-stack-'))
    roots.push(root)
    const deliveryPath = join(root, 'delivery.sqlite')
    const automationsPath = join(root, 'automations.sqlite')
    const growthPath = join(root, 'growth.sqlite')
    const ctx = new Context()
    contexts.push(ctx)

    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
    // Delivery's public runtime refuses to bind or later resume an Agent
    // session unless it crosses the durable session-persistence boundary.
    mountSessionPersistence(ctx)
    ctx.provide('agentPresets' as never, {
      resolve: async (id?: string) => ({ id: id ?? preset }),
      mount: async (_agent: unknown, id?: string) => ({ id: id ?? preset }),
    } as never)
    const adapter = new GrowthTextAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      budgets: [{
        id: 'growth-budget', metric: 'automation-runs', limit: 20,
        periodMs: 60_000, scope: 'subject',
      }],
      rules: [
        {
          id: 'local-pair', effect: 'allow',
          subject: { kind: 'external', id: 'local:test' },
          actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['foreground'] },
        },
        {
          id: 'growth-template-inspect', effect: 'allow',
          subject: { kind: 'background', id: 'assistant-growth-experiments', workspace, principal: principalId },
          actions: ['inspect'],
          resource: { kind: 'evolution', id: 'workflow-template:*' },
          context: { initiators: ['background'] },
        },
        {
          id: 'growth-reconcile', effect: 'allow',
          subject: { kind: 'background', id: 'assistant-growth-experiments', workspace, principal: principalId },
          actions: ['reconcile'], resource: { kind: 'automation', id: '*' },
          context: { initiators: ['background'] },
        },
        {
          id: 'growth-execute', effect: 'allow',
          subject: { kind: 'background', id: '*', workspace, principal: principalId },
          actions: ['execute'], resource: { kind: 'automation', id: '*' },
          context: { initiators: ['background'] },
        },
        {
          id: 'growth-result-send', effect: 'allow',
          subject: { kind: 'background', id: '*', workspace, principal: principalId },
          actions: ['send'], resource: { kind: 'message', id: '*' },
          context: { initiators: ['background'] },
        },
        {
          id: 'growth-approval-send', effect: 'allow',
          subject: { kind: 'background', id: 'assistant-growth-experiments', workspace, principal: principalId },
          actions: ['approval.send'], resource: { kind: 'message', id: '*' },
          context: { initiators: ['background'] },
        },
        {
          id: 'owner-feedback-ingest', effect: 'allow',
          subject: { kind: 'external', id: principalId }, actions: ['ingest', 'pair.confirm'],
          resource: { kind: 'message', id: '*' },
          context: { initiators: ['external'] },
        },
        {
          id: 'owner-feedback-reply', effect: 'allow',
          subject: { kind: 'agent', id: preset, workspace, principal: principalId }, actions: ['reply'],
          resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] },
        },
      ],
    })
    const deliveryFiber = await ctx.plugin(AssistantDeliveryService, {
      databasePath: deliveryPath,
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      defaultWorkspace: workspace,
      defaultAgentPreset: preset,
      agentProvider: 'mock',
      agentModel: 'growth-model',
    })
    void deliveryFiber
    const delivered: Array<{ intent: Readonly<OutboundIntent>; providerMessageId: string }> = []
    const deliveryAdapter: DeliveryAdapter = {
      channel: 'lark',
      account: 'bot-1',
      capabilities: {
        reconcileUnknownSend: false,
        receipts: [],
        formats: ['plain', 'markdown', 'approval'],
      },
      async start() {},
      async send(intent) {
        const providerMessageId = `om_${growthObjectDigest(intent.idempotencyKey).slice(0, 32)}`
        delivered.push({ intent, providerMessageId })
        return { outcome: 'accepted', providerMessageId }
      },
    }
    await ctx.assistantDelivery.registerAdapter(deliveryAdapter)
    const seed = await seedOwnerWorkflow(ctx.assistantDelivery, delivered, deliveryPath)
    await ctx.plugin(AssistantEvaluationService, {
      databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0,
    })

    const automationConfig = {
      databasePath: automationsPath,
      runsPath: join(root, 'runs'),
      schedulerEnabled: false,
      reconcileIntervalMs: 0,
      proposalDefaults: {
        provider: 'mock', model: 'growth-model', allowedTools: [],
        timeoutMs: 60_000, maxOutputTokens: 256, maxToolCalls: 0,
        misfireKind: 'latest' as const, misfireLimit: 1, overlap: 'skip' as const,
        retrySafety: 'never' as const, maxRetries: 0,
        budgetId: 'growth-budget', budgetAmount: 1,
      },
    }
    const growthConfig = {
      databasePath: growthPath,
      tickIntervalMs: 0,
      minRepeatedSuccesses: 3,
      maxBatchSize: 10,
      maxExperimentDurationMs: 60_000,
      maxOperationAttempts: 3,
      retryBaseMs: 1,
      retryMaxMs: 5,
    }
    let automationFiber = await ctx.plugin(AssistantAutomationsService, automationConfig)
    let growthFiber = await ctx.plugin(AssistantGrowthExperimentsService, growthConfig)
    let automations = ctx.assistantAutomations
    let growth = ctx.assistantGrowthExperiments

    await Promise.resolve()
    await ctx.assistantDelivery.projectWorkflowTraces()
    await growth.whenIdle()
    let experiment = growth.getExperiment(seed.experimentId)!
    expect(experiment).toMatchObject({ state: 'approval-pending', proposalId: expect.any(String) })

    // This runs through the public Delivery inbound/Agent/reply-feedback path
    // while Growth is its actual registered sink. It must yield an observing
    // verified-repetition candidate, never an owner-explicit candidate, and
    // must not leak the original selector into Growth's durable evidence.
    await publishVerifiedRepetition(ctx.assistantDelivery, delivered)
    await growth.whenIdle()
    const verifiedGrowth = new DatabaseSync(growthPath, { readOnly: true })
    try {
      const verifiedCandidates = verifiedGrowth.prepare(`
        SELECT state, owner_explicit_count, verified_success_count, template_json, steps_json
        FROM workflow_candidates
        WHERE owner_explicit_count = 0 AND verified_success_count = 1
      `).all() as unknown as Array<{
        state: string
        owner_explicit_count: number
        verified_success_count: number
        template_json: string
        steps_json: string
      }>
      const verifiedTraces = verifiedGrowth.prepare(`
        SELECT evidence_json FROM workflow_trace_revisions
        WHERE evidence_json IS NOT NULL
          AND json_extract(evidence_json, '$.signal') = 'verified-repetition'
      `).all() as unknown as Array<{ evidence_json: string }>
      expect(verifiedCandidates).toEqual([expect.objectContaining({
        state: 'observing', owner_explicit_count: 0, verified_success_count: 1,
      })])
      expect(verifiedTraces).toHaveLength(1)
      expect(JSON.stringify({ verifiedCandidates, verifiedTraces })).not.toContain(verifiedRepetitionSelector)
    } finally {
      verifiedGrowth.close()
    }
    const requestsBeforeGrowthRuns = adapter.requests.length
    const proposalRequest: GrowthAutomationProposalRequest = {
      contractVersion: 1,
      operationId: `${seed.experimentId}:approval-request`,
      experimentId: seed.experimentId,
      candidateId: seed.candidateId,
      candidateRevision: 1,
      candidateDigest: seed.candidateDigest,
      initialState: 'paused',
      scope: { workspace, preset },
      ownerBindingId: seed.bindingId,
      evidenceDigest: seed.candidateDigest,
      evidenceCount: 1,
      template: seed.trace.evidence!.template,
      steps: [modelStep],
      deadlineAt: experiment.deadlineAt,
    }
    const pendingReceipt = await automations.requestWorkflowAutomation(proposalRequest)
    expect(pendingReceipt).toMatchObject({ outcome: 'approval-pending', proposalId: experiment.proposalId })
    await expect(automations.requestWorkflowAutomation({
      ...proposalRequest, evidenceCount: 2,
    })).rejects.toMatchObject({ code: 'idempotency-conflict' })

    await growthFiber.dispose()
    await automationFiber.dispose()
    automationFiber = await ctx.plugin(AssistantAutomationsService, automationConfig)
    automations = ctx.assistantAutomations
    expect(await automations.requestWorkflowAutomation(proposalRequest)).toEqual(pendingReceipt)
    growthFiber = await ctx.plugin(AssistantGrowthExperimentsService, growthConfig)
    growth = ctx.assistantGrowthExperiments
    await Promise.resolve()
    await ctx.assistantDelivery.projectWorkflowTraces()
    await growth.whenIdle()

    await ctx.assistantDelivery.tick()
    await ctx.assistantDelivery.whenIdle()
    expect(delivered.some(entry => entry.intent.format === 'approval'
      && entry.intent.text.includes(secretPrompt))).toBe(true)
    expect(ctx.assistantPolicy.listPendingApprovalDispatches()).toEqual([])
    const proposal = ctx.assistantPolicy.getProposal(experiment.proposalId!)!
    expect(proposal.diffHash).toMatch(/^[a-f0-9]{64}$/u)
    ctx.assistantPolicy.decideProposal({
      proposalId: proposal.proposalId,
      principal: principalId,
      expectedVersion: proposal.version,
      decision: 'approved',
      reason: 'Owner reviewed the exact prompt, schedule, and delivery route.',
    })

    for (let index = 0; index < 10; index += 1) {
      await pause()
      await growth.tick()
      experiment = growth.getExperiment(seed.experimentId)!
      if (experiment.state === 'canary-pending'
        && experiment.canaryExposureCount === 1
        && experiment.operationKind === 'canary-inspection') break
    }
    expect(experiment).toMatchObject({
      state: 'canary-pending', operationKind: 'canary-inspection', canaryExposureCount: 1,
      artifactVersion: 1,
    })
    expect(adapter.requests).toHaveLength(requestsBeforeGrowthRuns + 2)
    expect(adapter.requests[requestsBeforeGrowthRuns]?.tools ?? []).toEqual([])
    const canaryRequest = {
      contractVersion: 1 as const,
      operationId: `${seed.experimentId}:canary`,
      experimentId: seed.experimentId,
      candidateId: seed.candidateId,
      candidateRevision: 1,
      candidateDigest: seed.candidateDigest,
      artifactId: experiment.artifactId!,
      artifactVersion: experiment.artifactVersion!,
      artifactDigest: experiment.artifactDigest!,
    }
    expect(await automations.canaryWorkflowAutomation(canaryRequest)).toMatchObject({
      outcome: 'pending', exposureCount: 1, exposureOperationId: `${seed.experimentId}:canary`,
    })
    await expect(automations.canaryWorkflowAutomation({
      ...canaryRequest, artifactDigest: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'idempotency-conflict' })

    await ctx.assistantDelivery.tick()
    await ctx.assistantDelivery.whenIdle()
    const resultMessage = delivered.find(entry =>
      entry.intent.metadata?.['dsh.learning.kind'] === 'automation-run')
    expect(resultMessage).toBeDefined()
    await ctx.assistantDelivery.acceptInbound({
      channel: principal.channel,
      account: principal.account,
      eventId: 'evt-canary-achieved',
      occurredAt: Date.now(),
      principal,
      conversation,
      kind: 'command',
      text: '/feedback achieved',
      metadata: { replyToProviderMessageId: resultMessage!.providerMessageId },
    })
    await ctx.assistantDelivery.tick()
    await ctx.assistantDelivery.whenIdle()
    expect(ctx.assistantEvaluation.query({
      scope: { workspace, preset },
      situation: `automation:${seed.automationId}`,
      objectiveStatus: 'achieved',
      trust: 'trusted',
      limit: 10,
    })).toEqual([expect.objectContaining({
      objectiveStatus: 'achieved', trust: 'trusted',
      source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
    })])

    for (let index = 0; index < 5; index += 1) {
      await pause()
      await growth.tick()
      experiment = growth.getExperiment(seed.experimentId)!
      if (experiment.state === 'promotion-pending') break
    }
    expect(experiment.state).toBe('promotion-pending')
    const promotionStore = (automations as unknown as {
      growthStore: { completePromotion(...args: unknown[]): unknown }
    }).growthStore
    const promotionAckLoss = vi.spyOn(promotionStore, 'completePromotion')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('promotion acknowledgement lost'), { code: 'ack-lost' })
      })
    await growth.tick()
    promotionAckLoss.mockRestore()
    expect(growth.getExperiment(seed.experimentId)).toMatchObject({
      state: 'promotion-pending', attemptCount: 1, terminalCode: 'ack-lost',
    })
    expect(automations.listSystemOwned({ owner: 'assistant-growth-experiments' })).toEqual([
      expect.objectContaining({ automationId: seed.automationId, automationStatus: 'active', definitionVersion: 2 }),
    ])

    await growthFiber.dispose()
    await automationFiber.dispose()
    automationFiber = await ctx.plugin(AssistantAutomationsService, automationConfig)
    automations = ctx.assistantAutomations
    growthFiber = await ctx.plugin(AssistantGrowthExperimentsService, growthConfig)
    growth = ctx.assistantGrowthExperiments
    await pause()
    await growth.tick()
    experiment = growth.getExperiment(seed.experimentId)!
    expect(experiment).toMatchObject({ state: 'promoted', artifactVersion: 2 })

    const rollbackStore = (automations as unknown as {
      growthStore: { completeRollback(...args: unknown[]): unknown }
    }).growthStore
    const rollbackAckLoss = vi.spyOn(rollbackStore, 'completeRollback')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('rollback acknowledgement lost'), { code: 'ack-lost' })
      })
    await retractOwnerWorkflow(ctx.assistantDelivery, seed)
    await ctx.assistantDelivery.projectWorkflowTraces()
    await growth.whenIdle()
    rollbackAckLoss.mockRestore()
    expect(growth.getExperiment(seed.experimentId)).toMatchObject({
      state: 'rollback-pending', attemptCount: 1, terminalCode: 'ack-lost',
    })
    expect(automations.listSystemOwned({ owner: 'assistant-growth-experiments' })).toEqual([
      expect.objectContaining({ automationStatus: 'paused', definitionVersion: 3 }),
    ])

    await growthFiber.dispose()
    await automationFiber.dispose()
    automationFiber = await ctx.plugin(AssistantAutomationsService, automationConfig)
    void automationFiber
    growthFiber = await ctx.plugin(AssistantGrowthExperimentsService, growthConfig)
    void growthFiber
    growth = ctx.assistantGrowthExperiments
    await pause()
    await growth.tick()
    expect(growth.getExperiment(seed.experimentId)).toMatchObject({
      state: 'rolled-back', artifactVersion: 2,
    })

    const automationDb = new DatabaseSync(automationsPath)
    const occurrences = automationDb.prepare(`
      SELECT dry_run, COUNT(*) AS count FROM automation_occurrences
      WHERE automation_id = ? GROUP BY dry_run ORDER BY dry_run
    `).all(seed.automationId) as unknown as Array<{ dry_run: number; count: number }>
    const operations = automationDb.prepare(`
      SELECT operation_kind, status FROM automation_growth_operations ORDER BY operation_kind
    `).all() as unknown as Array<{ operation_kind: string; status: string }>
    automationDb.close()
    expect(occurrences).toEqual([{ dry_run: 0, count: 1 }, { dry_run: 1, count: 1 }])
    expect(new Set(operations.map(row => row.operation_kind))).toEqual(new Set([
      'approval-proposal', 'approval-settlement', 'replay', 'shadow', 'canary',
      'canary-inspection', 'promotion', 'rollback',
    ]))
    expect(operations.every(row => row.status === 'completed')).toBe(true)

    const growthDb = new DatabaseSync(growthPath, { readOnly: true })
    const contentFree = growthDb.prepare(`
      SELECT candidate_json FROM growth_experiments
      UNION ALL SELECT template_json FROM workflow_candidates
      UNION ALL SELECT steps_json FROM workflow_candidates
      UNION ALL SELECT evidence_json FROM workflow_trace_revisions WHERE evidence_json IS NOT NULL
    `).all() as unknown as Array<{ candidate_json: string }>
    growthDb.close()
    expect(JSON.stringify(contentFree)).not.toContain(secretPrompt)
    expect(JSON.stringify(contentFree)).not.toContain('"prompt"')
  }, 30_000)
})
