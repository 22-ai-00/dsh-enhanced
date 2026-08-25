import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  SessionPreparation,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { AssistantEvolutionService } from '@dsh-enhanced/assistant-evolution'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import {
  CodingSubscriptionAdapter,
  Config as CodingSubscriptionConfig,
} from '@dsh-enhanced/coding-subscription-provider'
import {
  LarkChannelService,
  type LarkCardAction,
  type LarkMessage,
  type LarkProgressEvent,
  type LarkProgressHandle,
  type LarkSendInput,
  type LarkSendOptions,
  type LarkTransport,
  type LarkTransportHandlers,
} from '@dsh-enhanced/lark-channel'
import {
  registerLlmRouteCapability,
  resolveLlmRouteCapability,
} from '@dsh-enhanced/llm-route-capabilities'
import { afterEach, describe, expect, test, vi } from 'vitest'

const ACCOUNT = 'bot-1'
const TENANT = 'tenant-a'
const OWNER_USER = 'ou_owner'
const OWNER = `lark/${ACCOUNT}/${TENANT}/${OWNER_USER}`
const PRESET = 'primary'
const GROWTH_AUTOMATION = 'growth-loop'
const GROWTH_SITUATION = `automation:${GROWTH_AUTOMATION}`
const GUIDANCE = 'Verify durable evidence before reporting that the growth loop succeeded.'
const LARK_SECRET = 'personal-assistant-e2e-signing-secret'

const roots: string[] = []
const contexts = new Set<Context>()
let larkMessageSequence = 0

interface SavedSession {
  header: SessionHeader
  events: readonly SessionEvent[]
}

interface SentLarkMessage {
  chatId: string
  input: LarkSendInput
  options?: LarkSendOptions
  messageId: string
}

class FakeLarkTransport implements LarkTransport {
  handlers: LarkTransportHandlers | undefined
  readonly sent: SentLarkMessage[] = []

  subscribe(handlers: LarkTransportHandlers): () => void {
    this.handlers = handlers
    return () => {
      if (this.handlers === handlers) this.handlers = undefined
    }
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async addReaction(): Promise<string> { return 'reaction-1' }
  async createProgress(): Promise<LarkProgressHandle> {
    return { cotId: 'cot-1', messageId: 'om-progress-1' }
  }
  async writeProgress(_handle: LarkProgressHandle, _events: readonly LarkProgressEvent[]): Promise<void> {}

  async send(chatId: string, input: LarkSendInput, options?: LarkSendOptions) {
    const messageId = `om-${++larkMessageSequence}`
    this.sent.push({ chatId, input, ...(options === undefined ? {} : { options }), messageId })
    return { messageId }
  }

  async message(message: LarkMessage): Promise<void> {
    if (this.handlers === undefined) throw new Error('fake Lark transport is not connected')
    await this.handlers.message(message)
  }

  async action(action: LarkCardAction): Promise<unknown> {
    if (this.handlers === undefined) throw new Error('fake Lark transport is not connected')
    return this.handlers.cardAction(action)
  }
}

class GrowthAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  failAutomationRuns = false
  retirementTarget: { ruleId: string; expectedVersion: number } | undefined

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const messages = JSON.stringify(options.messages)
    if (this.failAutomationRuns && messages.includes('automation-growth-run')) {
      throw new Error('deterministic post-adoption automation failure')
    }
    if (messages.includes('request-evolution-retirement') && !messages.includes('evolution_review')) {
      const id = CallId('e2e-evolution-review')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'evolution_review', argumentsDelta: '{}' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'evolution_review', arguments: '{}' },
      }
      yield { type: 'usage', usage: completeUsage(12, 2) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (messages.includes('request-evolution-retirement') && !messages.includes('evolution_propose')) {
      if (this.retirementTarget === undefined) throw new Error('retirement target is not configured')
      const id = CallId('e2e-evolution-retirement')
      const args = JSON.stringify({
        operation: 'retire',
        rule_id: this.retirementTarget.ruleId,
        expected_version: this.retirementTarget.expectedVersion,
        reason: 'Post-adoption automated runs show the guidance is not helping.',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'evolution_propose', argumentsDelta: args }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'evolution_propose', arguments: args },
      }
      yield { type: 'usage', usage: completeUsage(12, 3) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (messages.includes('request-evolution-proposal') && !messages.includes('tool-result')) {
      const id = CallId('e2e-evolution-proposal')
      const args = JSON.stringify({
        operation: 'adopt',
        situation: GROWTH_SITUATION,
        guidance: GUIDANCE,
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'evolution_propose', argumentsDelta: args }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'evolution_propose', arguments: args },
      }
      yield { type: 'usage', usage: completeUsage(12, 3) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = messages.includes('automation-growth-run')
      ? 'automation growth run succeeded'
      : messages.includes('fresh-guidance-check')
        ? 'fresh session received approved guidance'
        : 'evolution proposal submitted for owner approval'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: completeUsage(10, 2) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function completeUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
}

function larkMessage(messageId: string, content: string): LarkMessage {
  return {
    messageId,
    chatId: 'oc_owner',
    chatType: 'p2p',
    senderId: OWNER_USER,
    content,
    rawContentType: 'text',
    resources: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  }
}

async function installAgentRuntime(ctx: Context, saved: Map<string, SavedSession>): Promise<void> {
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { persona: '' },
    tools: { mode: 'native' },
  })
  ctx.on('agent/session-start', ({ agent }) => {
    agent.session.append('approval/policy', { policy: 'never' })
    agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = agent.session.append as unknown as (type: string, data: unknown) => unknown
    append.call(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
  })
  ctx.provide('agentPresets' as never, {
    resolve: async (id?: string) => ({ id: id ?? PRESET }),
    mount: async (_agentContext: unknown, id?: string) => ({ id: id ?? PRESET }),
  } as never)
  ctx.on('session/flush', session => {
    saved.set(String(session.id), structuredClone({ header: session.header, events: session.events }))
  })
  ctx.provide('sessionPersistence' as never, {
    prepare: async (id: SessionId) => {
      const stored = saved.get(String(id))
      if (stored === undefined) throw new Error(`session not found: ${id}`)
      const restored = structuredClone(stored)
      return SessionPreparation.create(ctx.sessions.prepare(id, {
        seedSource: 'persistence',
        seed: [...restored.events],
        meta: restored.header,
      }))
    },
  } as never)
}

async function installLark(ctx: Context, transport: FakeLarkTransport): Promise<void> {
  const channel = new LarkChannelService(ctx, {
    enabled: true,
    account: ACCOUNT,
    tenant: TENANT,
    appId: 'cli_0123456789abcdef',
    appSecretEnv: 'LARK_APP_SECRET',
    showProgress: false,
    statusReactions: false,
  }, {
    env: { LARK_APP_SECRET: LARK_SECRET },
    createTransport: () => transport,
  })
  await channel.whenReady()
}

async function pairOwner(ctx: Context): Promise<void> {
  const principal = { channel: 'lark', account: ACCOUNT, tenant: TENANT, user: OWNER_USER }
  const pairing = ctx.assistantDelivery.issuePairing('e2e', principal)
  ctx.assistantDelivery.confirmPairing({
    challengeId: pairing.challenge.id,
    principal,
    code: pairing.code,
  })
}

async function runInboundPass(ctx: Context): Promise<void> {
  await ctx.assistantDelivery.tick()
  await ctx.assistantDelivery.whenIdle()
}

async function runGrowthAutomation(ctx: Context, eventId: string): Promise<void> {
  ctx.assistantAutomations.ingestExternal({
    sourceId: 'e2e-trigger',
    automationId: GROWTH_AUTOMATION,
    eventId,
    occurredAt: Date.now(),
  })
  await ctx.assistantAutomations.tick()
  await ctx.assistantAutomations.whenIdle()
  await ctx.assistantAutomations.tick()
}

function policyRules(workspace: string) {
  return [
    {
      id: 'pair-owner', effect: 'allow' as const,
      subject: { kind: 'external' as const, id: 'local:e2e' },
      actions: ['pair.issue'], resource: { kind: 'message' as const, id: 'pairing' },
      context: { initiators: ['foreground' as const] },
    },
    {
      id: 'trusted-lark-owner', effect: 'allow' as const,
      subject: { kind: 'external' as const, id: OWNER },
      actions: ['approval.decide', 'ingest', 'pair.confirm'],
      resource: { kind: 'message' as const, id: '*' },
      context: { initiators: ['external' as const] },
    },
    {
      id: 'delivery-agent-reply', effect: 'allow' as const,
      subject: { kind: 'agent' as const, id: PRESET, workspace },
      actions: ['reply'], resource: { kind: 'message' as const, id: '*' },
      context: { initiators: ['external' as const] },
    },
    {
      id: 'evolution-candidates', effect: 'allow' as const,
      subject: { kind: 'agent' as const, id: PRESET, workspace },
      actions: ['inspect'], resource: { kind: 'evolution' as const, id: 'candidates' },
      context: { initiators: ['external' as const] },
    },
    {
      id: 'evolution-rules', effect: 'allow' as const,
      subject: { kind: 'agent' as const, id: PRESET, workspace },
      actions: ['inspect'], resource: { kind: 'evolution' as const, id: 'rules' },
      context: { initiators: ['external' as const] },
    },
    {
      id: 'evolution-proposals', effect: 'allow' as const,
      subject: { kind: 'agent' as const, id: PRESET, workspace },
      actions: ['propose'], resource: { kind: 'evolution' as const, id: 'proposals' },
      context: { initiators: ['external' as const] },
    },
    {
      id: 'evolution-guidance', effect: 'allow' as const,
      subject: { kind: 'agent' as const, id: PRESET, workspace },
      actions: ['snapshot'], resource: { kind: 'evolution' as const, id: 'guidance' },
      context: { initiators: ['background' as const, 'external' as const] },
    },
    {
      id: 'evolution-tools', effect: 'allow' as const,
      subject: { kind: 'agent' as const, id: PRESET, workspace },
      actions: ['execute'], resource: { kind: 'tool' as const, id: 'evolution_*' },
      context: { initiators: ['external' as const] },
    },
    {
      id: 'evolution-card', effect: 'allow' as const,
      subject: { kind: 'background' as const, id: 'dsh-enhanced-assistant-evolution', workspace },
      actions: ['approval.send'], resource: { kind: 'message' as const, id: '*' },
      context: { initiators: ['background' as const] },
    },
    {
      id: 'automation-reconcile', effect: 'allow' as const,
      subject: { kind: 'background' as const, id: 'e2e-system', workspace, principal: OWNER },
      actions: ['reconcile'], resource: { kind: 'automation' as const, id: GROWTH_AUTOMATION },
      context: { initiators: ['background' as const] },
    },
    {
      id: 'automation-trigger', effect: 'allow' as const,
      subject: { kind: 'external' as const, id: 'e2e-trigger', workspace },
      actions: ['ingest'], resource: { kind: 'automation' as const, id: GROWTH_AUTOMATION },
      context: { initiators: ['external' as const] },
    },
    {
      id: 'automation-execute', effect: 'allow' as const,
      subject: { kind: 'background' as const, id: GROWTH_AUTOMATION, workspace, principal: OWNER },
      actions: ['execute'], resource: { kind: 'automation' as const, id: GROWTH_AUTOMATION },
      context: { initiators: ['background' as const] },
    },
  ]
}

function seedGrowthCandidate(service: AssistantEvolutionService, workspace: string): void {
  for (let index = 1; index <= 4; index += 1) {
    service.recordAutomationOutcome({
      situation: GROWTH_SITUATION,
      outcome: 'failed',
      detail: `trusted pre-adoption failure ${index}`,
      workspace,
      agentPreset: PRESET,
      occurredAt: 1_000 + index,
      idempotencyKey: `e2e-growth-seed:${index}`,
    })
  }
}

async function openGrowthRuntime(input: {
  root: string
  workspace: string
  policyPath: string
  automationPath: string
  evolutionPath: string
  saved: Map<string, SavedSession>
  llm: GrowthAdapter
}): Promise<{ ctx: Context; transport: FakeLarkTransport }> {
  const ctx = new Context()
  contexts.add(ctx)
  await installAgentRuntime(ctx, input.saved)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: input.policyPath,
    proposalMaintenanceIntervalMs: 0,
    budgets: [{
      id: 'growth-budget', metric: 'automation-runs', limit: 10, periodMs: 60_000, scope: 'subject',
    }],
    rules: policyRules(input.workspace),
  })
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: join(input.root, 'delivery.sqlite'),
    spoolPath: join(input.root, 'spool'),
    schedulerEnabled: false,
    defaultWorkspace: input.workspace,
    defaultAgentPreset: PRESET,
    agentProvider: 'growth-model',
    agentModel: 'default',
    toolCapableProviders: ['growth-model'],
  })
  await ctx.plugin(AssistantEvolutionService, {
    databasePath: input.evolutionPath,
    evaluationWindow: 10,
    minSample: 4,
    reconcileIntervalMs: 0,
  })
  await ctx.plugin(AssistantAutomationsService, {
    databasePath: input.automationPath,
    runsPath: join(input.root, 'runs'),
    schedulerEnabled: false,
    reconcileIntervalMs: 0,
    allowUnbudgetedExecution: false,
    toolCapableProviders: ['growth-model'],
  })
  ctx.llm.registerAdapter(['growth-model'], input.llm)
  await ctx.plugin(AgentLoop, { agents: [] })
  const transport = new FakeLarkTransport()
  await installLark(ctx, transport)
  return { ctx, transport }
}

async function closeContext(ctx: Context): Promise<void> {
  if (!contexts.delete(ctx)) return
  await ctx.fiber.restart()
}

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.restart()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  larkMessageSequence = 0
})

describe('supervised personal-assistant growth composition', () => {
  test('adopts guidance, records attributed automation evidence, and retires it through a second owner approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-growth-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const policyPath = join(root, 'policy.sqlite')
    const automationPath = join(root, 'automations.sqlite')
    const evolutionPath = join(root, 'evolution.sqlite')
    const saved = new Map<string, SavedSession>()
    const llm = new GrowthAdapter()
    const runtimeInput = { root, workspace, policyPath, automationPath, evolutionPath, saved, llm }
    let runtime = await openGrowthRuntime(runtimeInput)
    let ctx = runtime.ctx
    let transport = runtime.transport
    await pairOwner(ctx)
    seedGrowthCandidate(ctx.assistantEvolution, workspace)

    const evolutionSubject = { kind: 'agent' as const, id: PRESET, workspace }
    expect(ctx.assistantPolicy.evaluate({
      subject: evolutionSubject,
      action: 'propose',
      resource: { kind: 'evolution', id: 'proposals' },
      context: { initiator: 'external' },
    })).toMatchObject({ effect: 'allow', ruleId: 'evolution-proposals' })
    expect(ctx.assistantPolicy.evaluate({
      subject: evolutionSubject,
      action: 'propose',
      resource: { kind: 'evolution', id: `situation:${GROWTH_SITUATION}` },
      context: { initiator: 'external' },
    })).toMatchObject({ effect: 'deny' })

    await transport.message(larkMessage('om-growth-request', 'request-evolution-proposal'))
    await runInboundPass(ctx)

    const [dispatch] = ctx.assistantPolicy.listPendingApprovalDispatches()
    expect(dispatch).toMatchObject({
      sourceId: 'dsh-enhanced-assistant-evolution',
      workspace,
      principal: OWNER,
      requester: `agent:${PRESET}`,
      action: 'evolution.adopt',
      resource: { kind: 'evolution', id: `situation:${GROWTH_SITUATION}` },
      proposalVersion: 1,
      state: 'pending',
    })
    expect(dispatch?.diff).toContain(GUIDANCE)

    // Delivery preserves per-binding order: the turn reply settles before the
    // approval card that was appended later in the same durable outbox.
    await runInboundPass(ctx)
    await runInboundPass(ctx)
    const approvalMessage = transport.sent.find(message => 'approval' in message.input)
    expect(approvalMessage?.input).toMatchObject({
      approval: {
        title: `Adopt learned guidance for ${GROWTH_SITUATION}`,
        body: expect.stringContaining(GUIDANCE),
      },
    })
    if (approvalMessage === undefined || !('approval' in approvalMessage.input)) {
      throw new Error('Delivery did not send the durable evolution approval card')
    }
    await transport.action({
      messageId: approvalMessage.messageId,
      chatId: approvalMessage.chatId,
      operatorId: OWNER_USER,
      tag: 'button',
      value: approvalMessage.input.approval.approveValue,
    })
    expect(ctx.assistantPolicy.getProposal(dispatch!.proposalId)).toMatchObject({
      status: 'approved',
      decidedBy: OWNER,
      version: 2,
    })
    const beforeRestart = new DatabaseSync(evolutionPath, { readOnly: true })
    const unapplied = beforeRestart.prepare(`
      SELECT status, result_rule_id FROM evolution_proposals WHERE policy_proposal_id = ?
    `).get(dispatch!.proposalId)
    beforeRestart.close()
    expect(unapplied).toEqual({ status: 'pending', result_rule_id: null })

    // The callback has committed Policy and Delivery state, but Evolution has
    // not applied the mutation yet. Tear down every service and reopen the same
    // SQLite files to prove reconciliation does not depend on in-memory objects.
    await closeContext(ctx)
    runtime = await openGrowthRuntime(runtimeInput)
    ctx = runtime.ctx
    transport = runtime.transport
    expect(ctx.assistantPolicy.getProposal(dispatch!.proposalId)).toMatchObject({
      status: 'approved',
      decidedBy: OWNER,
      version: 2,
    })
    const [reconciled] = ctx.assistantEvolution.reconcileProposals()
    expect(reconciled).toMatchObject({
      status: 'approved',
      rule: { situation: GROWTH_SITUATION, guidance: GUIDANCE, generation: 1 },
    })
    expect(ctx.assistantEvolution.reconcileProposals()).toEqual([])
    const rule = reconciled?.rule
    if (rule === undefined) throw new Error('approved evolution proposal did not produce a rule')
    llm.retirementTarget = { ruleId: rule.id, expectedVersion: rule.version }

    ctx.assistantAutomations.reconcileSystem({
      owner: 'e2e-system',
      automationId: GROWTH_AUTOMATION,
      idempotencyKey: 'e2e-growth-automation-v1',
      definition: {
        name: 'Growth evidence loop',
        prompt: 'automation-growth-run',
        schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z' },
        workspace,
        agentPreset: PRESET,
        provider: 'growth-model',
        model: 'default',
        allowedTools: [],
        timeoutMs: 60_000,
        maxOutputTokens: 256,
        maxToolCalls: 0,
        misfire: { kind: 'latest' },
        overlap: 'skip',
        retrySafety: 'never',
        maxRetries: 0,
        principal: OWNER,
        budgetId: 'growth-budget',
        budgetAmount: 1,
      },
    })
    await runGrowthAutomation(ctx, 'growth-event-1')

    const automationRequest = llm.requests.find(request =>
      JSON.stringify(request.messages).includes('automation-growth-run'))
    expect(JSON.stringify(automationRequest?.messages)).toContain('<learned_guidance>')
    expect(JSON.stringify(automationRequest?.messages)).toContain(GUIDANCE)

    await transport.message(larkMessage('om-new-session', '/new'))
    await runInboundPass(ctx)
    await transport.message(larkMessage('om-guidance-check', 'fresh-guidance-check'))
    await runInboundPass(ctx)
    await runInboundPass(ctx)
    const freshRequest = llm.requests.find(request =>
      JSON.stringify(request.messages).includes('fresh-guidance-check'))
    expect(JSON.stringify(freshRequest?.messages)).toContain('<learned_guidance>')
    expect(JSON.stringify(freshRequest?.messages)).toContain(GUIDANCE)

    const firstAutomationDb = new DatabaseSync(automationPath, { readOnly: true })
    const firstDurableRun = firstAutomationDb.prepare(`
      SELECT id, status, session_id, evidence_status, evidence_json
      FROM automation_runs WHERE automation_id = ?
    `).get(GROWTH_AUTOMATION) as {
      id: string
      status: string
      session_id: string
      evidence_status: string
      evidence_json: string
    }
    firstAutomationDb.close()
    expect(firstDurableRun).toMatchObject({ status: 'succeeded', evidence_status: 'recorded' })
    expect(JSON.parse(firstDurableRun.evidence_json)).toMatchObject({
      situation: GROWTH_SITUATION,
      outcome: 'succeeded',
      automationId: GROWTH_AUTOMATION,
      runId: firstDurableRun.id,
      sessionId: firstDurableRun.session_id,
      ruleId: rule.id,
      guidanceVersion: rule.generation,
    })

    const firstEvolutionDb = new DatabaseSync(evolutionPath, { readOnly: true })
    const firstEvidence = firstEvolutionDb.prepare(`
      SELECT source, trust, situation, rule_id, guidance_version
      FROM evolution_episodes WHERE idempotency_key = ?
    `).get(`automation-run:${firstDurableRun.id}`)
    firstEvolutionDb.close()
    expect(firstEvidence).toEqual({
      source: 'automation',
      trust: 'trusted',
      situation: GROWTH_SITUATION,
      rule_id: rule.id,
      guidance_version: rule.generation,
    })

    llm.failAutomationRuns = true
    for (let index = 2; index <= 5; index += 1) {
      await runGrowthAutomation(ctx, `growth-event-${index}`)
    }

    await transport.message(larkMessage('om-retirement-session', '/new'))
    await runInboundPass(ctx)
    await transport.message(larkMessage('om-retirement-request', 'request-evolution-retirement'))
    await runInboundPass(ctx)

    const [retirementDispatch] = ctx.assistantPolicy.listPendingApprovalDispatches()
    expect(retirementDispatch).toMatchObject({
      sourceId: 'dsh-enhanced-assistant-evolution',
      workspace,
      principal: OWNER,
      requester: `agent:${PRESET}`,
      action: 'evolution.retire',
      resource: { kind: 'evolution', id: `rule:${rule.id}` },
      proposalVersion: 1,
      state: 'pending',
    })
    expect(retirementDispatch?.diff).toContain('Post-adoption automated runs')
    const retirementProposalRequest = llm.requests.find(request => {
      const messages = JSON.stringify(request.messages)
      return messages.includes('request-evolution-retirement')
        && messages.includes('evolution_review')
        && !messages.includes('evolution_propose')
    })
    const retirementProposalMessages = JSON.stringify(retirementProposalRequest?.messages)
    expect(retirementProposalMessages).toContain('\\"kind\\":\\"retire\\"')
    expect(retirementProposalMessages).toContain(`\\"ruleId\\":\\"${rule.id}\\"`)
    expect(retirementProposalMessages).toContain('\\"evidenceTotal\\":5')

    await runInboundPass(ctx)
    await runInboundPass(ctx)
    const retirementApprovalMessage = transport.sent.find(message =>
      'approval' in message.input
      && message.input.approval.title === `Retire learned guidance rule ${rule.id}`)
    expect(retirementApprovalMessage?.input).toMatchObject({
      approval: {
        title: `Retire learned guidance rule ${rule.id}`,
        body: expect.stringContaining('Post-adoption automated runs'),
      },
    })
    if (retirementApprovalMessage === undefined || !('approval' in retirementApprovalMessage.input)) {
      throw new Error('Delivery did not send the durable retirement approval card')
    }
    await transport.action({
      messageId: retirementApprovalMessage.messageId,
      chatId: retirementApprovalMessage.chatId,
      operatorId: OWNER_USER,
      tag: 'button',
      value: retirementApprovalMessage.input.approval.approveValue,
    })
    expect(ctx.assistantPolicy.getProposal(retirementDispatch!.proposalId)).toMatchObject({
      status: 'approved',
      decidedBy: OWNER,
      version: 2,
    })

    const retirementBeforeRestart = new DatabaseSync(evolutionPath, { readOnly: true })
    const unappliedRetirement = retirementBeforeRestart.prepare(`
      SELECT status, result_rule_id FROM evolution_proposals WHERE policy_proposal_id = ?
    `).get(retirementDispatch!.proposalId)
    retirementBeforeRestart.close()
    expect(unappliedRetirement).toEqual({ status: 'pending', result_rule_id: null })

    await closeContext(ctx)
    runtime = await openGrowthRuntime(runtimeInput)
    ctx = runtime.ctx
    transport = runtime.transport
    expect(ctx.assistantPolicy.getProposal(retirementDispatch!.proposalId)).toMatchObject({
      status: 'approved',
      decidedBy: OWNER,
      version: 2,
    })
    const [reconciledRetirement] = ctx.assistantEvolution.reconcileProposals()
    expect(reconciledRetirement).toMatchObject({
      status: 'approved',
      rule: {
        id: rule.id,
        situation: GROWTH_SITUATION,
        guidance: GUIDANCE,
        status: 'retired',
        retiredReason: 'Post-adoption automated runs show the guidance is not helping.',
        version: rule.version + 1,
      },
    })
    expect(ctx.assistantEvolution.reconcileProposals()).toEqual([])

    const exactOnceDb = new DatabaseSync(evolutionPath, { readOnly: true })
    const retirementAudit = exactOnceDb.prepare(`
      SELECT COUNT(*) AS count, MAX(result_version) AS result_version
      FROM evolution_audit WHERE operation = 'retire' AND rule_id = ?
    `).get(rule.id)
    exactOnceDb.close()
    expect(retirementAudit).toEqual({ count: 1, result_version: rule.version + 1 })

    await transport.message(larkMessage('om-post-retirement-session', '/new'))
    await runInboundPass(ctx)
    await transport.message(larkMessage(
      'om-post-retirement-guidance-check',
      'fresh-guidance-check-after-retirement',
    ))
    await runInboundPass(ctx)
    await runInboundPass(ctx)
    const postRetirementRequest = llm.requests.find(request =>
      JSON.stringify(request.messages).includes('fresh-guidance-check-after-retirement'))
    const postRetirementMessages = JSON.stringify(postRetirementRequest?.messages)
    expect(postRetirementMessages).not.toContain('<learned_guidance>')
    expect(postRetirementMessages).not.toContain(GUIDANCE)

    await closeContext(ctx)

    const policyDb = new DatabaseSync(policyPath, { readOnly: true })
    const budgets = policyDb.prepare(`
      SELECT amount, actual_amount, status FROM budget_reservations
      WHERE idempotency_key LIKE 'automation-budget:growth-loop:%:automation-runs:growth-budget'
      ORDER BY idempotency_key
    `).all()
    policyDb.close()
    expect(budgets).toHaveLength(5)
    expect(budgets).toEqual(budgets.map(() => ({ amount: 1, actual_amount: 1, status: 'finalized' })))

    const automationDb = new DatabaseSync(automationPath, { readOnly: true })
    const durableRuns = automationDb.prepare(`
      SELECT id, status, session_id, evidence_status, evidence_json
      FROM automation_runs WHERE automation_id = ? ORDER BY created_at, id
    `).all(GROWTH_AUTOMATION) as Array<{
      id: string
      status: string
      session_id: string
      evidence_status: string
      evidence_json: string
    }>
    automationDb.close()
    expect(durableRuns).toHaveLength(5)
    expect(durableRuns.filter(run => run.status === 'succeeded')).toHaveLength(1)
    expect(durableRuns.filter(run => run.status === 'failed')).toHaveLength(4)
    expect(durableRuns.every(run => run.evidence_status === 'recorded')).toBe(true)
    for (const durableRun of durableRuns) {
      expect(JSON.parse(durableRun.evidence_json)).toMatchObject({
        situation: GROWTH_SITUATION,
        outcome: durableRun.status,
        automationId: GROWTH_AUTOMATION,
        runId: durableRun.id,
        sessionId: durableRun.session_id,
        ruleId: rule.id,
        guidanceVersion: rule.generation,
      })
    }

    const evolutionDb = new DatabaseSync(evolutionPath, { readOnly: true })
    const durableEvidence = evolutionDb.prepare(`
      SELECT source, trust, situation, outcome, rule_id, guidance_version
      FROM evolution_episodes WHERE idempotency_key LIKE 'automation-run:%'
      ORDER BY occurred_at, id
    `).all()
    evolutionDb.close()
    expect(durableEvidence).toHaveLength(5)
    expect(durableEvidence.filter(entry => entry.outcome === 'failed')).toHaveLength(4)
    expect(durableEvidence.every(entry =>
      entry.source === 'automation'
      && entry.trust === 'trusted'
      && entry.situation === GROWTH_SITUATION
      && entry.rule_id === rule.id
      && entry.guidance_version === rule.generation)).toBe(true)
  })

  test('rejects a tool-bearing Delivery turn on Codex text-only capability before adapter auth or stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-codex-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const ctx = new Context()
    contexts.add(ctx)
    const saved = new Map<string, SavedSession>()
    await installAgentRuntime(ctx, saved)
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      proposalMaintenanceIntervalMs: 0,
      rules: policyRules(workspace),
    })
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      defaultWorkspace: workspace,
      defaultAgentPreset: PRESET,
      agentProvider: 'codex-subscription',
      agentModel: 'default',
      // The provider-owned `none` declaration below must override this legacy allowlist.
      toolCapableProviders: ['codex-subscription'],
    })
    await ctx.plugin(AssistantEvolutionService, {
      databasePath: join(root, 'evolution.sqlite'),
      reconcileIntervalMs: 0,
    })
    const verifyAuth = vi.fn(async () => {})
    const runText = vi.fn(() => (async function* () { yield 'must never run' })())
    const codingConfig = CodingSubscriptionConfig()
    codingConfig.cwd = workspace
    const codex = new CodingSubscriptionAdapter(codingConfig, {
      verifyAuth,
      runText,
    })
    const stream = vi.spyOn(codex, 'stream')
    ctx.llm.registerAdapter(['codex-subscription'], codex)
    registerLlmRouteCapability(ctx.llm, { provider: 'codex-subscription', toolCalls: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const transport = new FakeLarkTransport()
    await installLark(ctx, transport)
    await pairOwner(ctx)

    expect(resolveLlmRouteCapability(ctx.llm, 'codex-subscription', 'default'))
      .toMatchObject({ toolCalls: 'none' })
    await transport.message(larkMessage('om-codex-tool-turn', 'use an evolution tool'))
    expect(saved.size).toBe(1)
    await runInboundPass(ctx)
    await runInboundPass(ctx)

    expect(stream).not.toHaveBeenCalled()
    expect(verifyAuth).not.toHaveBeenCalled()
    expect(runText).not.toHaveBeenCalled()
    expect(transport.sent.at(-1)?.input).toMatchObject({
      text: expect.stringContaining('codex-subscription/default'),
    })
    expect(transport.sent.at(-1)?.input).toMatchObject({
      text: expect.stringContaining('/model'),
    })
    await closeContext(ctx)
  })
})
