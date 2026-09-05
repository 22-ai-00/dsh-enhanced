import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
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
  type SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import {
  AssistantDeliveryService,
  pairPrincipalLocally,
  type DeliveryPreferenceEvent,
} from '@dsh-enhanced/assistant-delivery'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { AssistantEvolutionService } from '@dsh-enhanced/assistant-evolution'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { PreferenceLearningService } from '@dsh-enhanced/preference-learning'
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
import { afterEach, describe, expect, test, vi } from 'vitest'

const ACCOUNT = 'bot-1'
const TENANT = 'tenant-a'
const OWNER_USER = 'ou_owner'
const OWNER = `lark/${ACCOUNT}/${TENANT}/${OWNER_USER}`
const REPLACEMENT_OWNER_USER = 'ou_replacement_owner'
const REPLACEMENT_OWNER = `lark/${ACCOUNT}/${TENANT}/${REPLACEMENT_OWNER_USER}`
const PRESET = 'primary'
const GROWTH_AUTOMATION = 'growth-loop'
const GROWTH_SITUATION = `automation:${GROWTH_AUTOMATION}`
const LARK_SECRET = 'personal-assistant-e2e-signing-secret'

const roots: string[] = []
const contexts = new Set<Context>()
let larkMessageSequence = 0

interface SavedSession {
  header: SessionHeader
  events: readonly SessionEvent[]
  inheritedEventCount: SessionLogOffset
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

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const messages = JSON.stringify(options.messages)
    const text = messages.includes('automation-growth-run')
      ? 'automation growth run succeeded'
      : 'personal assistant reply'
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

function larkMessage(messageId: string, content: string, replyToMessageId?: string): LarkMessage {
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
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
  }
}

async function installAgentRuntime(ctx: Context, saved: Map<string, SavedSession>): Promise<void> {
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { persona: '' },
    tools: { mode: 'native' },
  })
  await ctx.plugin(SessionProjectionRegistry)
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
    saved.set(String(session.id), structuredClone({
      header: session.header,
      events: session.snapshotEvents(),
      inheritedEventCount: session.inheritedEventCount,
    }))
  })
  ctx.provide('sessionPersistence' as never, {
    coordinator: {
      assertEventsSupported(_meta: SessionHeader, events: readonly SessionEvent[]) {
        for (const event of events) {
          if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue
          throw new Error(`unknown required session event type: ${event.type}`)
        }
      },
    },
    list: async () => [...saved.values()].map(value => structuredClone(value.header)),
    prepare: async (id: SessionId) => {
      const stored = saved.get(String(id))
      if (stored === undefined) throw new Error(`session not found: ${id}`)
      const restored = structuredClone(stored)
      return SessionPreparation.create(ctx.sessions.prepare(id, {
        seedSource: 'persistence',
        seed: [...restored.events],
        meta: restored.header,
        inheritedEventCount: restored.inheritedEventCount,
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
  // One pass may first drain recovered outboxes and only materialize the new
  // task. Bound the drain rather than assuming a fresh-process pass ordering.
  for (let pass = 0; pass < 4; pass += 1) {
    await ctx.assistantAutomations.tick()
    await ctx.assistantAutomations.whenIdle()
  }
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
      id: 'trusted-lark-owner-feedback', effect: 'allow' as const,
      subject: { kind: 'external' as const, id: OWNER, workspace },
      actions: ['signal'], resource: { kind: 'preference' as const, id: `${PRESET}/*` },
      context: { initiators: ['external' as const] },
    },
    {
      id: 'preference-overlay', effect: 'allow' as const,
      subject: { kind: 'agent' as const, id: PRESET, workspace, principal: OWNER },
      actions: ['snapshot'], resource: { kind: 'preference' as const, id: 'active' },
      context: { initiators: ['external' as const] },
    },
    {
      id: 'delivery-agent-reply', effect: 'allow' as const,
      subject: { kind: 'agent' as const, id: PRESET, workspace, principal: OWNER },
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
    {
      id: 'automation-delivery', effect: 'allow' as const,
      subject: { kind: 'background' as const, id: GROWTH_AUTOMATION, workspace, principal: OWNER },
      actions: ['send'], resource: { kind: 'message' as const, id: '*' },
      context: { initiators: ['background' as const] },
    },
  ]
}

function reconcileGrowthAutomation(ctx: Context, workspace: string, deliveryBindingId?: string): void {
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
      ...(deliveryBindingId === undefined ? {} : { deliveryBindingId }),
      budgetId: 'growth-budget',
      budgetAmount: 1,
    },
  })
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
  })
  await ctx.plugin(AssistantEvaluationService, {
    databasePath: join(input.root, 'evaluation.sqlite'),
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

describe('personal-assistant growth composition', () => {
  // This path deliberately drives seventeen durable owner turns.  The default
  // five-second unit-test budget is too small when the root suite is also
  // compiling and exercising the SQLite-heavy plugin packages in parallel.
  test('learns a language overlay from ordinary owner use and rolls back the exact exposed version on correction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-preference-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const deliveryPath = join(root, 'delivery.sqlite')
    const preferencePath = join(root, 'preferences.sqlite')
    const ctx = new Context()
    contexts.add(ctx)
    const saved = new Map<string, SavedSession>()
    const llm = new GrowthAdapter()

    await installAgentRuntime(ctx, saved)
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      proposalMaintenanceIntervalMs: 0,
      rules: policyRules(workspace),
    })
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: deliveryPath,
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      defaultWorkspace: workspace,
      defaultAgentPreset: PRESET,
      agentProvider: 'growth-model',
      agentModel: 'default',
    })
    await ctx.plugin(PreferenceLearningService, {
      databasePath: preferencePath,
      maintenanceIntervalMs: 3_600_000,
    })
    ctx.llm.registerAdapter(['growth-model'], llm)
    await ctx.plugin(AgentLoop, { agents: [] })
    const transport = new FakeLarkTransport()
    await installLark(ctx, transport)
    await pairOwner(ctx)

    const completeTurn = async (
      eventId: string,
      content: string,
      replyToMessageId?: string,
    ): Promise<SentLarkMessage> => {
      const before = transport.sent.length
      await transport.message(larkMessage(eventId, content, replyToMessageId))
      // Bound the public Delivery drain: the first pass completes the Agent
      // turn, while later passes may send its reply and project its durable,
      // content-free preference receipt.
      for (let pass = 0; pass < 3; pass += 1) await runInboundPass(ctx)
      const reply = transport.sent.slice(before).find(message => 'markdown' in message.input)
      if (reply === undefined) throw new Error(`owner turn did not produce a durable reply: ${eventId}`)
      return reply
    }

    const chineseTurns = [
      '请帮我整理紫竹项目今天需要完成的工作',
      '请帮我总结紫竹项目本周的重要安排',
      '请帮我检查紫竹项目当前还有哪些风险',
      '请帮我梳理紫竹项目下一步行动计划',
      '请帮我列出紫竹项目今天的优先事项',
      '请帮我回顾紫竹项目尚未完成的任务',
    ]
    for (const [index, content] of chineseTurns.entries()) {
      await completeTurn(`om-preference-zh-${index + 1}`, content)
    }

    expect(ctx.assistantPreferenceLearning.health()).toMatchObject({
      signals: 6,
      active: 1,
      rolledBack: 0,
    })
    const preferenceDatabase = new DatabaseSync(preferencePath, { readOnly: true })
    const signalColumns = preferenceDatabase.prepare('PRAGMA table_info(preference_signals)')
      .all() as Array<{ name: string }>
    expect(signalColumns.map(column => column.name)).not.toEqual(expect.arrayContaining([
      'content', 'message', 'prompt', 'reply', 'text',
    ]))
    const initialSignals = preferenceDatabase.prepare(`
      SELECT preference_key, candidate_value, interpretation_trust, source
      FROM preference_signals ORDER BY occurred_at, id
    `).all()
    expect(initialSignals).toEqual(chineseTurns.map(() => ({
      preference_key: 'response.language',
      candidate_value: 'zh-CN',
      interpretation_trust: 'behavioral-inference',
      source: 'delivery-observation',
    })))
    expect(JSON.stringify(preferenceDatabase.prepare('SELECT * FROM preference_signals').all()))
      .not.toContain('紫竹项目')
    const activatedChinese = preferenceDatabase.prepare(`
      SELECT id, version, effect_state FROM preference_hypotheses
      WHERE preference_key = 'response.language' AND candidate_value = 'zh-CN'
    `).get() as { id: string; version: number; effect_state: string }
    expect(activatedChinese.effect_state).toBe('active')

    const deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM inbox_messages
      WHERE event_id LIKE 'om-preference-zh-%' AND status = 'processed'
    `).get()).toEqual({ count: 6 })
    expect(deliveryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM outbox_messages
      WHERE idempotency_key LIKE 'inbound:%:reply'
        AND status IN ('accepted', 'delivered', 'read')
    `).get()).toEqual({ count: 6 })
    expect(deliveryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM delivery_preference_projection_outbox
    `).get()).toEqual({ count: 0 })

    const initialBinding = deliveryDatabase.prepare(`
      SELECT id, principal_json, generation FROM conversation_bindings
      WHERE status = 'active'
    `).get() as { id: string; principal_json: string; generation: number }
    await transport.message(larkMessage('om-preference-new-binding', '/new'))
    for (let pass = 0; pass < 3; pass += 1) await runInboundPass(ctx)
    const rotatedBinding = deliveryDatabase.prepare(`
      SELECT id, principal_json, generation FROM conversation_bindings
      WHERE status = 'active'
    `).get() as { id: string; principal_json: string; generation: number }
    expect(rotatedBinding).toMatchObject({
      principal_json: initialBinding.principal_json,
      generation: initialBinding.generation + 1,
    })
    expect(rotatedBinding.id).not.toBe(initialBinding.id)

    const englishReply = await completeTurn(
      'om-preference-en-once',
      'Please summarize all work that I need to finish today',
    )
    const firstAdaptedPrompt = JSON.stringify(llm.requests.at(-1)?.messages)
    expect(firstAdaptedPrompt).toContain('<tentative_preference_overlay>')
    expect(firstAdaptedPrompt).toContain('Respond in Simplified Chinese')
    expect(ctx.assistantPreferenceLearning.health()).toMatchObject({ active: 1, rolledBack: 0 })
    const stillActiveChinese = preferenceDatabase.prepare(`
      SELECT id, version, effect_state FROM preference_hypotheses
      WHERE preference_key = 'response.language' AND candidate_value = 'zh-CN'
    `).get() as { id: string; version: number; effect_state: string }
    expect(stillActiveChinese).toMatchObject({ id: activatedChinese.id, effect_state: 'active' })

    const signalsBeforeOneShotRequests = ctx.assistantPreferenceLearning.health().signals
    const oneShotRequests = [
      '请用英文回答。',
      '这次请用英文回答',
      'Please answer in Chinese.',
      'Please respond in English.',
      'Please be concise.',
      'Please use more bullet points.',
      'this time, answer in English',
      'for this response, please respond in English',
    ]
    for (const [index, content] of oneShotRequests.entries()) {
      await completeTurn(`om-preference-one-shot-${index + 1}`, content)
    }
    expect(ctx.assistantPreferenceLearning.health()).toMatchObject({
      signals: signalsBeforeOneShotRequests,
      active: 1,
      rolledBack: 0,
    })

    // Preference keeps only durable identifiers for the exact completed turn;
    // message content remains in Delivery and never crosses this boundary.
    const exposureRows = preferenceDatabase.prepare(`
      SELECT hypothesis_id, hypothesis_version, source_inbox_id, reply_outbox_id, state
      , source_event_id FROM preference_exposures
    `).all() as Array<{
      hypothesis_id: string
      hypothesis_version: number
      source_inbox_id: string
      reply_outbox_id: string
      state: string
      source_event_id: string
    }>
    const exactExposure = exposureRows.find(row => row.source_event_id === 'om-preference-en-once')
    if (exactExposure === undefined) {
      throw new Error(`active overlay exposure was not bound: ${JSON.stringify(exposureRows)}`)
    }
    expect(exactExposure).toMatchObject({
      hypothesis_id: activatedChinese.id,
      state: 'bound',
    })

    await completeTurn('om-preference-explicit-en', '以后用英文回答', englishReply.messageId)
    expect(ctx.assistantPreferenceLearning.health()).toMatchObject({ active: 1, rolledBack: 1 })
    const rolledBackChinese = preferenceDatabase.prepare(`
      SELECT id, effect_state FROM preference_hypotheses
      WHERE preference_key = 'response.language' AND candidate_value = 'zh-CN'
    `).get()
    expect(rolledBackChinese).toEqual({ id: activatedChinese.id, effect_state: 'rolled-back' })
    const correction = preferenceDatabase.prepare(`
      SELECT c.hypothesis_id, c.hypothesis_version, c.source_inbox_id, c.reply_outbox_id
      FROM preference_exposure_corrections c
      WHERE c.hypothesis_id = ? AND c.hypothesis_version = ?
    `).get(exactExposure!.hypothesis_id, exactExposure!.hypothesis_version)
    expect(correction).toEqual({
      hypothesis_id: exactExposure!.hypothesis_id,
      hypothesis_version: exactExposure!.hypothesis_version,
      source_inbox_id: exactExposure!.source_inbox_id,
      reply_outbox_id: exactExposure!.reply_outbox_id,
    })

    await completeTurn('om-preference-final-check', 'Please give me the final status of this work')
    const correctedRuntimeSnapshots = (llm.requests.at(-1)?.messages ?? [])
      .filter(message => JSON.stringify(message).includes('"form":"snapshot"'))
    const correctedPrompt = JSON.stringify(correctedRuntimeSnapshots.at(-1))
    expect(correctedPrompt).toContain('<tentative_preference_overlay>')
    expect(correctedPrompt).toContain('Respond in English')
    expect(correctedPrompt).not.toContain('Respond in Simplified Chinese')
    deliveryDatabase.close()
    preferenceDatabase.close()
  }, 20_000)

  test('controls preference learning through Lark across restart without entering the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-learning-control-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const policyPath = join(root, 'policy.sqlite')
    const deliveryPath = join(root, 'delivery.sqlite')
    const preferencePath = join(root, 'preferences.sqlite')
    const saved = new Map<string, SavedSession>()
    const llm = new GrowthAdapter()

    const openRuntime = async () => {
      const ctx = new Context()
      contexts.add(ctx)
      await installAgentRuntime(ctx, saved)
      await ctx.plugin(AssistantPolicyService, {
        databasePath: policyPath,
        proposalMaintenanceIntervalMs: 0,
        rules: policyRules(workspace),
      })
      await ctx.plugin(AssistantDeliveryService, {
        databasePath: deliveryPath,
        spoolPath: join(root, 'spool'),
        schedulerEnabled: false,
        retryBaseMs: 60_000,
        retryMaxMs: 60_000,
        defaultWorkspace: workspace,
        defaultAgentPreset: PRESET,
        agentProvider: 'growth-model',
        agentModel: 'default',
      })
      await ctx.plugin(PreferenceLearningService, {
        databasePath: preferencePath,
        maintenanceIntervalMs: 3_600_000,
      })
      ctx.llm.registerAdapter(['growth-model'], llm)
      await ctx.plugin(AgentLoop, { agents: [] })
      const transport = new FakeLarkTransport()
      await installLark(ctx, transport)
      return { ctx, transport }
    }

    const drain = async (ctx: Context) => {
      for (let pass = 0; pass < 3; pass += 1) await runInboundPass(ctx)
    }
    const send = async (
      runtime: Awaited<ReturnType<typeof openRuntime>>,
      eventId: string,
      content: string,
    ) => {
      await runtime.transport.message(larkMessage(eventId, content))
      await drain(runtime.ctx)
    }

    let runtime = await openRuntime()
    await pairOwner(runtime.ctx)
    for (let index = 1; index <= 6; index += 1) {
      await send(
        runtime,
        `om-learning-control-seed-${index}`,
        `请帮我整理云杉项目第 ${index} 批工作的今日安排`,
      )
    }
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 6, active: 1 })
    const callsAfterLearning = llm.requests.length

    await send(runtime, 'om-learning-control-explain', '/learning explain')
    expect(llm.requests).toHaveLength(callsAfterLearning)
    const explainReply = JSON.stringify(runtime.transport.sent.at(-1)?.input)
    expect(explainReply).toContain('key=response.language')
    expect(explainReply).toContain('value=zh-CN')
    expect(explainReply).toContain('state=active')
    expect(explainReply).toMatch(/version=\d+/u)
    expect(explainReply).toContain('supportingSignals=6')
    expect(explainReply).toContain('contradictingSignals=0')
    expect(explainReply).toMatch(/evidenceMass=\d+/u)
    expect(explainReply).not.toContain('云杉项目')
    let preferenceDatabase = new DatabaseSync(preferencePath, { readOnly: true })
    const explainReceiptBeforeRestart = preferenceDatabase.prepare(`
      SELECT payload_hash, action, admission_cursor_epoch, admission_cursor_sequence,
        result_admission_high_water, result_signals, result_hypotheses,
        result_active_overlays, result_stored_active_overlays,
        result_explanation_json
      FROM preference_owner_control_receipts WHERE action = 'explain'
    `).get()
    expect(explainReceiptBeforeRestart).toMatchObject({
      action: 'explain', result_signals: 6, result_hypotheses: 1,
      result_active_overlays: 1, result_stored_active_overlays: 1,
    })
    const explainOrdering = explainReceiptBeforeRestart as {
      admission_cursor_sequence: number
      result_admission_high_water: number
    }
    expect(explainOrdering.result_admission_high_water)
      .toBeLessThan(explainOrdering.admission_cursor_sequence)
    expect(JSON.parse((explainReceiptBeforeRestart as { result_explanation_json: string })
      .result_explanation_json)).toEqual([expect.objectContaining({
      key: 'response.language', value: 'zh-CN', state: 'active',
      supportingSignals: 6, contradictingSignals: 0,
    })])

    await send(runtime, 'om-learning-control-export', '/learning export')
    expect(llm.requests).toHaveLength(callsAfterLearning)
    const exportInput = runtime.transport.sent.at(-1)?.input
    if (exportInput === undefined || !('text' in exportInput)) {
      throw new Error('learning export did not produce a plain JSON reply')
    }
    const exportJson = exportInput.text
    expect(JSON.parse(exportJson)).toEqual({
      format: 'dsh-preference-learning',
      records: [expect.objectContaining({
        key: 'response.language', value: 'zh-CN', state: 'active',
        supportingSignals: 6, contradictingSignals: 0,
      })],
      version: 1,
    })
    expect(exportJson).not.toMatch(
      /云杉项目|\/assistant-workspace|principal|lineage|generation|session|event|inbox|outbox|cursor|idempot|exposure/iu,
    )
    const exportReceiptBeforeRestart = preferenceDatabase.prepare(`
      SELECT payload_hash, action, admission_cursor_epoch, admission_cursor_sequence,
        result_admission_high_water, result_signals, result_hypotheses,
        result_active_overlays, result_stored_active_overlays,
        result_explanation_json
      FROM preference_owner_control_receipts WHERE action = 'export'
    `).get()
    expect(exportReceiptBeforeRestart).toMatchObject({
      action: 'export', result_signals: 6, result_hypotheses: 1,
      result_active_overlays: 1, result_stored_active_overlays: 1,
    })
    preferenceDatabase.close()

    await closeContext(runtime.ctx)
    runtime = await openRuntime()
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 6, active: 1 })
    preferenceDatabase = new DatabaseSync(preferencePath, { readOnly: true })
    expect(preferenceDatabase.prepare(`
      SELECT payload_hash, action, admission_cursor_epoch, admission_cursor_sequence,
        result_admission_high_water, result_signals, result_hypotheses,
        result_active_overlays, result_stored_active_overlays,
        result_explanation_json
      FROM preference_owner_control_receipts WHERE action = 'explain'
    `).get()).toEqual(explainReceiptBeforeRestart)
    expect(preferenceDatabase.prepare(`
      SELECT payload_hash, action, admission_cursor_epoch, admission_cursor_sequence,
        result_admission_high_water, result_signals, result_hypotheses,
        result_active_overlays, result_stored_active_overlays,
        result_explanation_json
      FROM preference_owner_control_receipts WHERE action = 'export'
    `).get()).toEqual(exportReceiptBeforeRestart)
    preferenceDatabase.close()

    await send(runtime, 'om-learning-control-export-after-restart', '/learning export')
    expect(llm.requests).toHaveLength(callsAfterLearning)
    const restartedExportInput = runtime.transport.sent.at(-1)?.input
    if (restartedExportInput === undefined || !('text' in restartedExportInput)) {
      throw new Error('restarted learning export did not produce a plain JSON reply')
    }
    expect(restartedExportInput.text).toBe(exportJson)

    await send(runtime, 'om-learning-control-status', '/learning status')
    expect(llm.requests).toHaveLength(callsAfterLearning)
    expect(JSON.stringify(runtime.transport.sent.at(-1)?.input)).toContain('组件状态：已启用')
    expect(JSON.stringify(runtime.transport.sent.at(-1)?.input)).toContain('收集状态：运行中')

    await send(runtime, 'om-learning-control-pause', '/learning pause')
    expect(llm.requests).toHaveLength(callsAfterLearning)
    expect(JSON.stringify(runtime.transport.sent.at(-1)?.input)).toContain('已暂停当前工作区')

    await closeContext(runtime.ctx)
    runtime = await openRuntime()
    await send(
      runtime,
      'om-learning-control-paused-turn',
      '请帮我继续整理云杉项目今天的工作安排',
    )
    expect(llm.requests).toHaveLength(callsAfterLearning + 1)
    expect(JSON.stringify(llm.requests.at(-1)?.messages)).not.toContain('<tentative_preference_overlay>')
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 6, active: 1 })

    await send(runtime, 'om-learning-control-resume', '/learning resume')
    expect(llm.requests).toHaveLength(callsAfterLearning + 1)
    expect(JSON.stringify(runtime.transport.sent.at(-1)?.input)).toContain('已恢复当前工作区')
    await send(
      runtime,
      'om-learning-control-resumed-turn',
      '请帮我检查云杉项目今天是否还有遗漏事项',
    )
    expect(JSON.stringify(llm.requests.at(-1)?.messages)).toContain('<tentative_preference_overlay>')
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 7, active: 1 })

    type ProjectionFence = (
      input: { batchKey: string; payloadDigest: string },
      project: (entry: unknown) => void,
    ) => unknown
    interface ProjectionStore {
      projectPreferenceProjectionUnderOwnerFence: ProjectionFence
      enqueuePreferenceProjection(events: readonly Readonly<DeliveryPreferenceEvent>[]): unknown
    }
    const projectionStore = (runtime.ctx.assistantDelivery as unknown as {
      deliveryStore: ProjectionStore
    }).deliveryStore
    const projectUnderFence = projectionStore.projectPreferenceProjectionUnderOwnerFence
      .bind(projectionStore)
    vi.spyOn(projectionStore, 'projectPreferenceProjectionUnderOwnerFence')
      .mockImplementationOnce((input, project) => projectUnderFence(input, entry => {
        project(entry)
        throw new Error('injected delayed projection after Preference commit before Delivery ACK')
      }))
    await send(
      runtime,
      'om-learning-control-delayed-before-rollback',
      '请继续整理云杉项目今天的工作安排',
    )
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 8, active: 1 })
    let deliveryDatabase = new DatabaseSync(deliveryPath)
    const delayedProjection = deliveryDatabase.prepare(`
      SELECT events_json FROM delivery_preference_projection_outbox
      WHERE status = 'retry_wait' AND failure_code = 'sink-projection-failed'
    `).get() as { events_json: string } | undefined
    if (delayedProjection === undefined) throw new Error('delayed projection fixture was not retained')
    deliveryDatabase.prepare(`
      UPDATE delivery_preference_projection_outbox SET next_attempt_at = 0
      WHERE status = 'retry_wait' AND failure_code = 'sink-projection-failed'
    `).run()
    deliveryDatabase.close()

    const callsBeforeRollback = llm.requests.length
    await send(
      runtime,
      'om-learning-control-rollback-language',
      '/learning rollback response.language confirm',
    )
    expect(llm.requests).toHaveLength(callsBeforeRollback)
    expect(JSON.stringify(runtime.transport.sent.at(-1)?.input))
      .toContain('已回滚 response.language')
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({
      signals: 8, active: 0, rolledBack: 1,
    })
    preferenceDatabase = new DatabaseSync(preferencePath, { readOnly: true })
    expect(preferenceDatabase.prepare(`
      SELECT effect_state FROM preference_hypotheses
      WHERE preference_key = 'response.language' AND candidate_value = 'zh-CN'
    `).get()).toEqual({ effect_state: 'rolled-back' })
    const rollbackFence = preferenceDatabase.prepare(`
      SELECT admission_high_water, ignore_events_through_sequence
      FROM preference_scope_principals
    `).get() as { admission_high_water: number; ignore_events_through_sequence: number }
    expect(rollbackFence.ignore_events_through_sequence).toBe(rollbackFence.admission_high_water)
    preferenceDatabase.close()

    const staleEvents = (JSON.parse(delayedProjection.events_json) as DeliveryPreferenceEvent[])
      .map(event => Object.freeze({
        ...event,
        idempotencyKey: `${event.idempotencyKey}-delayed-after-rollback`,
      }))
    projectionStore.enqueuePreferenceProjection(staleEvents)
    await closeContext(runtime.ctx)
    runtime = await openRuntime()
    await drain(runtime.ctx)
    expect(llm.requests).toHaveLength(callsBeforeRollback)
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({
      signals: 8, active: 0, rolledBack: 1,
    })
    deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM delivery_preference_projection_outbox
      WHERE terminal_at IS NULL
    `).get()).toEqual({ count: 0 })
    deliveryDatabase.close()

    await send(
      runtime,
      'om-learning-control-after-rollback',
      'Please summarize the remaining work for the spruce project',
    )
    const postRollbackRuntimeTail = (llm.requests.at(-1)?.messages ?? []).slice(-2)
    expect(JSON.stringify(postRollbackRuntimeTail)).not.toContain('<tentative_preference_overlay>')
    expect(JSON.stringify(postRollbackRuntimeTail))
      .toContain('Earlier runtime-context snapshots no longer apply')
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ active: 0, rolledBack: 1 })

    type RollbackArgs = [unknown, unknown, unknown, unknown, number, string]
    interface RollbackStore {
      rollbackScopeLearningKey(...args: RollbackArgs): unknown
    }
    const rollbackStore = (runtime.ctx.assistantPreferenceLearning as unknown as {
      store: RollbackStore
    }).store
    const rollbackOnce = rollbackStore.rollbackScopeLearningKey.bind(rollbackStore)
    vi.spyOn(rollbackStore, 'rollbackScopeLearningKey')
      .mockImplementationOnce((...args: RollbackArgs) => {
        rollbackOnce(...args)
        throw new Error('injected crash after durable no-active rollback receipt')
      })
    const callsBeforeNoop = llm.requests.length
    await send(
      runtime,
      'om-learning-control-rollback-no-active',
      '/learning rollback response.language confirm',
    )
    expect(llm.requests).toHaveLength(callsBeforeNoop)
    deliveryDatabase = new DatabaseSync(deliveryPath)
    expect(deliveryDatabase.prepare(`
      SELECT status, failure_code FROM inbox_messages
      WHERE event_id = 'om-learning-control-rollback-no-active'
    `).get()).toEqual({ status: 'retry_wait', failure_code: 'learning-dispatch-recovery' })
    deliveryDatabase.prepare(`
      UPDATE inbox_messages SET next_attempt_at = 0
      WHERE event_id = 'om-learning-control-rollback-no-active' AND status = 'retry_wait'
    `).run()
    deliveryDatabase.close()
    preferenceDatabase = new DatabaseSync(preferencePath, { readOnly: true })
    const noActiveReceiptBeforeRestart = preferenceDatabase.prepare(`
      SELECT payload_hash, target_preference_key, result_applied,
        result_rolled_back, result_rolled_back_version, admission_cursor_sequence
      FROM preference_owner_control_receipts
      WHERE action = 'rollback' AND result_rolled_back = 0
    `).get()
    expect(noActiveReceiptBeforeRestart).toMatchObject({
      target_preference_key: 'response.language', result_applied: 1,
      result_rolled_back: 0, result_rolled_back_version: null,
    })
    preferenceDatabase.close()

    await closeContext(runtime.ctx)
    runtime = await openRuntime()
    await drain(runtime.ctx)
    expect(llm.requests).toHaveLength(callsBeforeNoop)
    expect(JSON.stringify(runtime.transport.sent.at(-1)?.input))
      .toContain('response.language 当前没有激活偏好')
    preferenceDatabase = new DatabaseSync(preferencePath, { readOnly: true })
    expect(preferenceDatabase.prepare(`
      SELECT payload_hash, target_preference_key, result_applied,
        result_rolled_back, result_rolled_back_version, admission_cursor_sequence
      FROM preference_owner_control_receipts
      WHERE action = 'rollback' AND result_rolled_back = 0
    `).get()).toEqual(noActiveReceiptBeforeRestart)
    expect(preferenceDatabase.prepare(`
      SELECT COUNT(*) AS count FROM preference_transitions
      WHERE reason = 'owner-rejected'
    `).get()).toEqual({ count: 1 })
    preferenceDatabase.close()

    await send(runtime, 'om-learning-control-forget-prompt', '/learning forget')
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ active: 0, rolledBack: 1 })
    expect(JSON.stringify(runtime.transport.sent.at(-1)?.input)).toContain('尚未删除任何学习记录')
    await send(runtime, 'om-learning-control-forget', '/learning forget confirm')
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({
      signals: 0,
      hypotheses: 0,
      active: 0,
    })
    expect(JSON.stringify(runtime.transport.sent.at(-1)?.input)).toContain('已永久删除')

    const callsBeforeFreshTurn = llm.requests.length
    await send(
      runtime,
      'om-learning-control-after-forget',
      '请帮我重新整理云杉项目今天的计划',
    )
    expect(llm.requests).toHaveLength(callsBeforeFreshTurn + 1)
    const freshRuntimeTail = (llm.requests.at(-1)?.messages ?? []).slice(-2)
    expect(JSON.stringify(freshRuntimeTail)).not.toContain('<tentative_preference_overlay>')
    expect(JSON.stringify(llm.requests.at(-1)?.messages))
      .toContain('Earlier runtime-context snapshots no longer apply')
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 1, active: 0 })
  }, 20_000)

  test('projects a committed reply after Preference is installed late and never reruns the owner turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-preference-recovery-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const policyPath = join(root, 'policy.sqlite')
    const deliveryPath = join(root, 'delivery.sqlite')
    const preferencePath = join(root, 'preferences.sqlite')
    const saved = new Map<string, SavedSession>()
    const llm = new GrowthAdapter()

    const openRuntime = async (withPreference: boolean) => {
      const ctx = new Context()
      contexts.add(ctx)
      await installAgentRuntime(ctx, saved)
      await ctx.plugin(AssistantPolicyService, {
        databasePath: policyPath,
        proposalMaintenanceIntervalMs: 0,
        rules: policyRules(workspace),
      })
      await ctx.plugin(AssistantDeliveryService, {
        databasePath: deliveryPath,
        spoolPath: join(root, 'spool'),
        schedulerEnabled: false,
        defaultWorkspace: workspace,
        defaultAgentPreset: PRESET,
        agentProvider: 'growth-model',
        agentModel: 'default',
      })
      if (withPreference) {
        await ctx.plugin(PreferenceLearningService, {
          databasePath: preferencePath,
          maintenanceIntervalMs: 3_600_000,
        })
      }
      ctx.llm.registerAdapter(['growth-model'], llm)
      await ctx.plugin(AgentLoop, { agents: [] })
      const transport = new FakeLarkTransport()
      await installLark(ctx, transport)
      return { ctx, transport }
    }

    let runtime = await openRuntime(false)
    await pairOwner(runtime.ctx)
    await runtime.transport.message(larkMessage(
      'om-preference-before-install',
      '请帮我整理青松项目今天需要完成的工作',
    ))
    for (let pass = 0; pass < 3; pass += 1) await runInboundPass(runtime.ctx)
    expect(llm.requests).toHaveLength(1)

    let deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT status, failure_code FROM inbox_messages
      WHERE event_id = 'om-preference-before-install'
    `).get()).toEqual({ status: 'processed', failure_code: null })
    expect(deliveryDatabase.prepare(`
      SELECT status FROM outbox_messages
      WHERE idempotency_key LIKE 'inbound:%:reply'
    `).get()).toEqual({ status: 'accepted' })
    expect(deliveryDatabase.prepare(`
      SELECT status, attempt_count, failure_code
      FROM delivery_preference_projection_outbox
    `).get()).toEqual({ status: 'pending', attempt_count: 0, failure_code: null })
    deliveryDatabase.close()

    await closeContext(runtime.ctx)
    runtime = await openRuntime(true)
    for (let pass = 0; pass < 3; pass += 1) await runInboundPass(runtime.ctx)
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({
      signals: 1,
      active: 0,
    })
    expect(llm.requests).toHaveLength(1)
    deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM delivery_preference_projection_outbox
    `).get()).toEqual({ count: 0 })
    deliveryDatabase.close()

    // A second full reload proves both ledgers agree that the projection has
    // already committed; neither the model turn nor the signal is replayed.
    await closeContext(runtime.ctx)
    runtime = await openRuntime(true)
    for (let pass = 0; pass < 2; pass += 1) await runInboundPass(runtime.ctx)
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({
      signals: 1,
      active: 0,
    })
    expect(llm.requests).toHaveLength(1)
  })

  test('replays a real Preference commit after Delivery loses its acknowledgement without duplicating a signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-preference-ack-loss-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const policyPath = join(root, 'policy.sqlite')
    const deliveryPath = join(root, 'delivery.sqlite')
    const preferencePath = join(root, 'preferences.sqlite')
    const saved = new Map<string, SavedSession>()
    const llm = new GrowthAdapter()

    const openRuntime = async () => {
      const ctx = new Context()
      contexts.add(ctx)
      await installAgentRuntime(ctx, saved)
      await ctx.plugin(AssistantPolicyService, {
        databasePath: policyPath,
        proposalMaintenanceIntervalMs: 0,
        rules: policyRules(workspace),
      })
      await ctx.plugin(AssistantDeliveryService, {
        databasePath: deliveryPath,
        spoolPath: join(root, 'spool'),
        schedulerEnabled: false,
        retryBaseMs: 60_000,
        retryMaxMs: 60_000,
        defaultWorkspace: workspace,
        defaultAgentPreset: PRESET,
        agentProvider: 'growth-model',
        agentModel: 'default',
      })
      await ctx.plugin(PreferenceLearningService, {
        databasePath: preferencePath,
        maintenanceIntervalMs: 3_600_000,
      })
      ctx.llm.registerAdapter(['growth-model'], llm)
      await ctx.plugin(AgentLoop, { agents: [] })
      const transport = new FakeLarkTransport()
      await installLark(ctx, transport)
      return { ctx, transport }
    }

    let runtime = await openRuntime()
    await pairOwner(runtime.ctx)
    type ProjectionFence = (
      input: { batchKey: string; payloadDigest: string },
      project: (entry: unknown) => void,
    ) => unknown
    const projectionStore = (runtime.ctx.assistantDelivery as unknown as {
      deliveryStore: { projectPreferenceProjectionUnderOwnerFence: ProjectionFence }
    }).deliveryStore
    const projectUnderFence = projectionStore.projectPreferenceProjectionUnderOwnerFence.bind(projectionStore)
    vi.spyOn(projectionStore, 'projectPreferenceProjectionUnderOwnerFence')
      .mockImplementationOnce((input, project) => projectUnderFence(input, entry => {
        project(entry)
        throw new Error('injected crash after the real Preference commit before Delivery ACK')
      }))

    await runtime.transport.message(larkMessage(
      'om-preference-ack-loss',
      '请帮我整理今天需要完成的工作安排',
    ))
    for (let pass = 0; pass < 3; pass += 1) await runInboundPass(runtime.ctx)
    expect(llm.requests).toHaveLength(1)
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 1, active: 0 })

    let deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT status, attempt_count, failure_code
      FROM delivery_preference_projection_outbox
    `).get()).toEqual({
      status: 'retry_wait',
      attempt_count: 1,
      failure_code: 'sink-projection-failed',
    })
    deliveryDatabase.close()

    await closeContext(runtime.ctx)
    runtime = await openRuntime()
    for (let pass = 0; pass < 3; pass += 1) await runInboundPass(runtime.ctx)
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 1, active: 0 })
    expect(llm.requests).toHaveLength(1)
    deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM delivery_preference_projection_outbox
    `).get()).toEqual({ count: 0 })
    deliveryDatabase.close()
  })

  test('fails closed on the replacement owner first turn and ignores a delayed old-owner replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-preference-owner-fence-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const policyPath = join(root, 'policy.sqlite')
    const deliveryPath = join(root, 'delivery.sqlite')
    const preferencePath = join(root, 'preferences.sqlite')
    const saved = new Map<string, SavedSession>()
    const llm = new GrowthAdapter()
    const replacementPrincipal = {
      channel: 'lark', account: ACCOUNT, tenant: TENANT, user: REPLACEMENT_OWNER_USER,
    }
    const replacementRules = [
      {
        id: 'trusted-lark-replacement-owner', effect: 'allow' as const,
        subject: { kind: 'external' as const, id: REPLACEMENT_OWNER },
        actions: ['approval.decide', 'ingest', 'pair.confirm'],
        resource: { kind: 'message' as const, id: '*' },
        context: { initiators: ['external' as const] },
      },
      {
        id: 'trusted-lark-replacement-owner-feedback', effect: 'allow' as const,
        subject: { kind: 'external' as const, id: REPLACEMENT_OWNER, workspace },
        actions: ['signal'], resource: { kind: 'preference' as const, id: `${PRESET}/*` },
        context: { initiators: ['external' as const] },
      },
      {
        id: 'replacement-owner-preference-overlay', effect: 'allow' as const,
        subject: { kind: 'agent' as const, id: PRESET, workspace, principal: REPLACEMENT_OWNER },
        actions: ['snapshot'], resource: { kind: 'preference' as const, id: 'active' },
        context: { initiators: ['external' as const] },
      },
      {
        id: 'replacement-owner-delivery-reply', effect: 'allow' as const,
        subject: { kind: 'agent' as const, id: PRESET, workspace, principal: REPLACEMENT_OWNER },
        actions: ['reply'], resource: { kind: 'message' as const, id: '*' },
        context: { initiators: ['external' as const] },
      },
    ]

    const openRuntime = async () => {
      const ctx = new Context()
      contexts.add(ctx)
      await installAgentRuntime(ctx, saved)
      await ctx.plugin(AssistantPolicyService, {
        databasePath: policyPath,
        proposalMaintenanceIntervalMs: 0,
        rules: [...policyRules(workspace), ...replacementRules],
      })
      await ctx.plugin(AssistantDeliveryService, {
        databasePath: deliveryPath,
        spoolPath: join(root, 'spool'),
        schedulerEnabled: false,
        retryBaseMs: 60_000,
        retryMaxMs: 60_000,
        defaultWorkspace: workspace,
        defaultAgentPreset: PRESET,
        agentProvider: 'growth-model',
        agentModel: 'default',
      })
      await ctx.plugin(PreferenceLearningService, {
        databasePath: preferencePath,
        maintenanceIntervalMs: 3_600_000,
      })
      ctx.llm.registerAdapter(['growth-model'], llm)
      await ctx.plugin(AgentLoop, { agents: [] })
      const transport = new FakeLarkTransport()
      await installLark(ctx, transport)
      return { ctx, transport }
    }

    const replacementMessage = (messageId: string, content: string): LarkMessage => ({
      ...larkMessage(messageId, content),
      chatId: 'oc_replacement_owner',
      senderId: REPLACEMENT_OWNER_USER,
    })
    const completeTurn = async (
      runtime: Awaited<ReturnType<typeof openRuntime>>,
      message: LarkMessage,
    ): Promise<void> => {
      await runtime.transport.message(message)
      for (let pass = 0; pass < 3; pass += 1) await runInboundPass(runtime.ctx)
    }

    let runtime = await openRuntime()
    await pairOwner(runtime.ctx)
    for (let index = 1; index <= 6; index += 1) {
      await completeTurn(runtime, larkMessage(
        `om-owner-fence-seed-${index}`,
        `请帮我整理青竹项目第 ${index} 批工作的今日安排`,
      ))
    }
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 6, active: 1 })

    type ProjectionFence = (
      input: { batchKey: string; payloadDigest: string },
      project: (entry: unknown) => void,
    ) => unknown
    const projectionStore = (runtime.ctx.assistantDelivery as unknown as {
      deliveryStore: { projectPreferenceProjectionUnderOwnerFence: ProjectionFence }
    }).deliveryStore
    const projectUnderFence = projectionStore.projectPreferenceProjectionUnderOwnerFence.bind(projectionStore)
    vi.spyOn(projectionStore, 'projectPreferenceProjectionUnderOwnerFence')
      .mockImplementationOnce((input, project) => projectUnderFence(input, entry => {
        project(entry)
        throw new Error('injected old-owner crash after Preference commit before Delivery ACK')
      }))
    await completeTurn(runtime, larkMessage(
      'om-owner-fence-delayed-old',
      '请帮我继续整理青竹项目的今日安排',
    ))
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 7, active: 1 })

    pairPrincipalLocally({ databasePath: deliveryPath, principal: replacementPrincipal })
    await completeTurn(runtime, replacementMessage(
      'om-owner-fence-replacement-first',
      'Please summarize everything that I need to finish today',
    ))
    expect(JSON.stringify(llm.requests.at(-1)?.messages)).not.toContain('<tentative_preference_overlay>')
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({
      signals: 1,
      active: 0,
      rolledBack: 0,
    })
    let preferenceDatabase = new DatabaseSync(preferencePath, { readOnly: true })
    expect(preferenceDatabase.prepare(`
      SELECT candidate_value, COUNT(*) AS count
      FROM preference_signals GROUP BY candidate_value
    `).all()).toEqual([{ candidate_value: 'en', count: 1 }])
    preferenceDatabase.close()

    let deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT status, attempt_count, failure_code, terminal_at IS NOT NULL AS terminal
      FROM delivery_preference_projection_outbox
    `).all()).toEqual([{
      status: 'retry_wait',
      attempt_count: 1,
      failure_code: 'owner-lineage-retired',
      terminal: 1,
    }])
    deliveryDatabase.close()

    const modelCallsBeforeRestart = llm.requests.length
    await closeContext(runtime.ctx)
    runtime = await openRuntime()
    for (let pass = 0; pass < 3; pass += 1) await runInboundPass(runtime.ctx)
    expect(llm.requests).toHaveLength(modelCallsBeforeRestart)
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({
      signals: 1,
      active: 0,
      rolledBack: 0,
    })
    preferenceDatabase = new DatabaseSync(preferencePath, { readOnly: true })
    expect(preferenceDatabase.prepare(`
      SELECT candidate_value, COUNT(*) AS count
      FROM preference_signals GROUP BY candidate_value
    `).all()).toEqual([{ candidate_value: 'en', count: 1 }])
    preferenceDatabase.close()
    deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT status, attempt_count, failure_code, terminal_at IS NOT NULL AS terminal
      FROM delivery_preference_projection_outbox
    `).all()).toEqual([{
      status: 'retry_wait',
      attempt_count: 1,
      failure_code: 'owner-lineage-retired',
      terminal: 1,
    }])
    deliveryDatabase.close()
  })

  test('never revives an uncommitted A1 projection when the same owner returns as A3', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-preference-owner-aba-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const policyPath = join(root, 'policy.sqlite')
    const deliveryPath = join(root, 'delivery.sqlite')
    const preferencePath = join(root, 'preferences.sqlite')
    const saved = new Map<string, SavedSession>()
    const llm = new GrowthAdapter()
    const ownerPrincipal = {
      channel: 'lark', account: ACCOUNT, tenant: TENANT, user: OWNER_USER,
    }
    const replacementPrincipal = {
      channel: 'lark', account: ACCOUNT, tenant: TENANT, user: REPLACEMENT_OWNER_USER,
    }

    const openRuntime = async (withPreference: boolean) => {
      const ctx = new Context()
      contexts.add(ctx)
      await installAgentRuntime(ctx, saved)
      await ctx.plugin(AssistantPolicyService, {
        databasePath: policyPath,
        proposalMaintenanceIntervalMs: 0,
        rules: policyRules(workspace),
      })
      await ctx.plugin(AssistantDeliveryService, {
        databasePath: deliveryPath,
        spoolPath: join(root, 'spool'),
        schedulerEnabled: false,
        retryBaseMs: 60_000,
        retryMaxMs: 60_000,
        defaultWorkspace: workspace,
        defaultAgentPreset: PRESET,
        agentProvider: 'growth-model',
        agentModel: 'default',
      })
      if (withPreference) {
        await ctx.plugin(PreferenceLearningService, {
          databasePath: preferencePath,
          maintenanceIntervalMs: 3_600_000,
        })
      }
      ctx.llm.registerAdapter(['growth-model'], llm)
      await ctx.plugin(AgentLoop, { agents: [] })
      const transport = new FakeLarkTransport()
      await installLark(ctx, transport)
      return { ctx, transport }
    }
    const completeTurn = async (
      runtime: Awaited<ReturnType<typeof openRuntime>>,
      messageId: string,
      content: string,
    ) => {
      await runtime.transport.message(larkMessage(messageId, content))
      for (let pass = 0; pass < 3; pass += 1) await runInboundPass(runtime.ctx)
    }

    // A1 first establishes a genuine active preference in the downstream DB.
    let runtime = await openRuntime(true)
    await pairOwner(runtime.ctx)
    for (let index = 1; index <= 6; index += 1) {
      await completeTurn(
        runtime,
        `om-owner-aba-seed-${index}`,
        `请帮我整理雪松项目第 ${index} 批工作的今日安排`,
      )
    }
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 6, active: 1 })
    await closeContext(runtime.ctx)

    // With Preference absent, A1 commits its reply and durable projection but
    // cannot advance Preference's observed owner lineage.
    runtime = await openRuntime(false)
    await completeTurn(
      runtime,
      'om-owner-aba-pending-a1',
      '请帮我继续整理雪松项目今天的工作安排',
    )
    expect(llm.requests).toHaveLength(7)
    let deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT status, attempt_count, terminal_at, lane_principal_version
      FROM delivery_preference_projection_outbox
    `).all()).toEqual([{
      status: 'pending', attempt_count: 0, terminal_at: null, lane_principal_version: 1,
    }])
    deliveryDatabase.close()
    await closeContext(runtime.ctx)

    // No B or A3 projection reaches Preference. The handoff transaction alone
    // must retire A1, including when the external principal string returns.
    pairPrincipalLocally({ databasePath: deliveryPath, principal: replacementPrincipal })
    const returnedOwner = pairPrincipalLocally({ databasePath: deliveryPath, principal: ownerPrincipal })
    expect(returnedOwner).toMatchObject({ version: 3, status: 'active', role: 'owner' })
    deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT status, attempt_count, failure_code, terminal_at IS NOT NULL AS terminal,
        lane_principal_version
      FROM delivery_preference_projection_outbox
    `).all()).toEqual([{
      status: 'pending',
      attempt_count: 0,
      failure_code: 'owner-lineage-retired',
      terminal: 1,
      lane_principal_version: 1,
    }])
    deliveryDatabase.close()
    let preferenceDatabase = new DatabaseSync(preferencePath, { readOnly: true })
    expect(preferenceDatabase.prepare(`
      SELECT generation, principal_lineage_version FROM preference_scope_principals
    `).get()).toEqual({ generation: 1, principal_lineage_version: 1 })
    expect(preferenceDatabase.prepare(`
      SELECT COUNT(*) AS count FROM preference_signals
    `).get()).toEqual({ count: 6 })
    preferenceDatabase.close()

    // A3 must fail closed before its first prompt, then reset Preference to its
    // exact new lineage. The terminal A1 outbox is never sent or model-rerun.
    runtime = await openRuntime(true)
    const callsBeforeA3 = llm.requests.length
    await completeTurn(
      runtime,
      'om-owner-aba-first-a3',
      'Please list everything that remains for the cedar project today',
    )
    expect(llm.requests).toHaveLength(callsBeforeA3 + 1)
    expect(JSON.stringify(llm.requests.at(-1)?.messages)).not.toContain('<tentative_preference_overlay>')
    expect(runtime.ctx.assistantPreferenceLearning.health()).toMatchObject({
      signals: 1,
      active: 0,
      rolledBack: 0,
    })
    preferenceDatabase = new DatabaseSync(preferencePath, { readOnly: true })
    expect(preferenceDatabase.prepare(`
      SELECT generation, principal_lineage_version FROM preference_scope_principals
    `).get()).toEqual({ generation: 2, principal_lineage_version: 3 })
    expect(preferenceDatabase.prepare(`
      SELECT candidate_value, COUNT(*) AS count
      FROM preference_signals GROUP BY candidate_value
    `).all()).toEqual([{ candidate_value: 'en', count: 1 }])
    preferenceDatabase.close()
    deliveryDatabase = new DatabaseSync(deliveryPath, { readOnly: true })
    expect(deliveryDatabase.prepare(`
      SELECT failure_code, terminal_at IS NOT NULL AS terminal
      FROM delivery_preference_projection_outbox
    `).all()).toEqual([{ failure_code: 'owner-lineage-retired', terminal: 1 }])
    deliveryDatabase.close()
  })

  test('turns an exact owner reply into one trusted objective episode and rejects stale/unlinked replies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-feedback-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const policyPath = join(root, 'policy.sqlite')
    const automationPath = join(root, 'automations.sqlite')
    const evolutionPath = join(root, 'evolution.sqlite')
    const saved = new Map<string, SavedSession>()
    const llm = new GrowthAdapter()
    const runtime = await openGrowthRuntime({ root, workspace, policyPath, automationPath, evolutionPath, saved, llm })
    const { ctx, transport } = runtime
    await pairOwner(ctx)
    await transport.message(larkMessage('om-feedback-bind', 'establish owner binding'))
    await runInboundPass(ctx)
    await runInboundPass(ctx)

    const deliveryDatabase = new DatabaseSync(join(root, 'delivery.sqlite'), { readOnly: true })
    const binding = deliveryDatabase.prepare(`
      SELECT id FROM conversation_bindings WHERE status = 'active' ORDER BY generation DESC LIMIT 1
    `).get() as { id: string } | undefined
    deliveryDatabase.close()
    if (binding === undefined) throw new Error('owner Delivery binding was not established')

    reconcileGrowthAutomation(ctx, workspace, binding.id)
    await runGrowthAutomation(ctx, 'objective-feedback-run')
    await runInboundPass(ctx)
    await runInboundPass(ctx)
    const automationMessage = transport.sent.find(message =>
      JSON.stringify(message.input).includes('automation growth run succeeded'))
    if (automationMessage === undefined) throw new Error('Automation result was not delivered to owner')

    const objectiveFeedbackMessage = larkMessage(
      'om-objective-not-achieved', '/feedback not-achieved', automationMessage.messageId,
    )
    await transport.message(objectiveFeedbackMessage)
    await runInboundPass(ctx)
    await runInboundPass(ctx)
    await ctx.assistantEvaluation.whenProjectionIdle()

    const evaluationDatabase = new DatabaseSync(join(root, 'evaluation.sqlite'), { readOnly: true })
    const objective = evaluationDatabase.prepare(`
      SELECT objective_status, delivery_status, source_kind, trust, evidence_json
      FROM evaluation_outcomes
      WHERE source_kind = 'user-feedback'
    `).all() as Array<{
      objective_status: string
      delivery_status: string
      source_kind: string
      trust: string
      evidence_json: string
    }>
    evaluationDatabase.close()
    expect(objective).toHaveLength(1)
    expect(objective[0]).toMatchObject({
      objective_status: 'not-achieved', delivery_status: 'delivered',
      source_kind: 'user-feedback', trust: 'trusted',
    })
    expect(JSON.parse(objective[0]!.evidence_json)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'automation-run' }),
      expect.objectContaining({ kind: 'delivery-outbox' }),
    ]))

    // The terminal Automation row and its later owner judgement remain two
    // immutable audit records, but user-facing Evaluation is one task. The
    // terminal supplies execution/metrics while the authenticated reply
    // supplies objective/delivery, so learning evidence is not double-counted.
    expect(ctx.assistantEvaluation.summary({
      scope: { workspace, preset: PRESET }, situation: GROWTH_SITUATION,
    })).toMatchObject({
      total: 1,
      execution: { succeeded: 1, failed: 0, timedOut: 0, cancelled: 0, unknown: 0 },
      objective: { achieved: 0, partial: 0, notAchieved: 1, unknown: 0 },
      delivery: { delivered: 1, failed: 0, notRequired: 0, unknown: 0 },
    })
    expect(ctx.assistantEvaluation.queryTasks({
      scope: { workspace, preset: PRESET }, situation: GROWTH_SITUATION, limit: 10,
    })).toEqual([
      expect.objectContaining({
        executionStatus: 'succeeded', objectiveStatus: 'not-achieved', deliveryStatus: 'delivered',
        projection: expect.objectContaining({ subjectKind: 'automation-run', status: 'ready' }),
      }),
    ])

    const evolutionDatabase = new DatabaseSync(evolutionPath, { readOnly: true })
    const projected = evolutionDatabase.prepare(`
      SELECT outcome, source, trust, evidence_kind
      FROM evolution_episodes WHERE situation = ? AND source = 'evaluation'
    `).all(GROWTH_SITUATION)
    evolutionDatabase.close()
    expect(projected).toEqual([{ outcome: 'failed', source: 'evaluation', trust: 'trusted', evidence_kind: 'objective' }])

    // Provider retry of the same event is absorbed by Inbox/Evaluation idempotency.
    await transport.message(objectiveFeedbackMessage)
    await runInboundPass(ctx)
    await ctx.assistantEvaluation.whenProjectionIdle()

    // Distinct provider events about the same immutable run cannot amplify its
    // sample weight. Equal judgement replays the same Evaluation receipt; an
    // opposite judgement is surfaced as a conflict and does not overwrite it.
    await transport.message(larkMessage(
      'om-objective-same-run', '/feedback not-achieved', automationMessage.messageId,
    ))
    await runInboundPass(ctx)
    await runInboundPass(ctx)
    await transport.message(larkMessage(
      'om-objective-conflict', '/feedback achieved', automationMessage.messageId,
    ))
    await runInboundPass(ctx)
    await runInboundPass(ctx)
    expect(transport.sent.some(message =>
      JSON.stringify(message.input).includes('已经记录了不同的任务结果'))).toBe(true)

    // A new session changes the binding generation. Neither an unlinked command
    // nor a reply to the old generation may relabel the immutable run.
    await transport.message(larkMessage('om-feedback-new', '/new'))
    await runInboundPass(ctx)
    await runInboundPass(ctx)
    await transport.message(larkMessage('om-feedback-unlinked', '/feedback achieved'))
    await runInboundPass(ctx)
    await transport.message(larkMessage(
      'om-feedback-stale', '/feedback achieved', automationMessage.messageId,
    ))
    await runInboundPass(ctx)
    await runInboundPass(ctx)
    await ctx.assistantEvaluation.whenProjectionIdle()

    const finalEvaluation = new DatabaseSync(join(root, 'evaluation.sqlite'), { readOnly: true })
    const finalCount = finalEvaluation.prepare(`
      SELECT COUNT(*) AS count FROM evaluation_outcomes WHERE source_kind = 'user-feedback'
    `).get()
    finalEvaluation.close()
    expect(finalCount).toEqual({ count: 1 })
  })

  test('runs a tool-bearing Delivery turn on Codex CLI without route capability metadata', async () => {
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
    })
    await ctx.plugin(AssistantEvaluationService, {
      databasePath: join(root, 'evaluation.sqlite'),
    })
    await ctx.plugin(AssistantEvolutionService, {
      databasePath: join(root, 'evolution.sqlite'),
      reconcileIntervalMs: 0,
    })
    const verifyAuth = vi.fn(async () => {})
    const runText = vi.fn(() => (async function* () { yield 'Codex received the same Agent tools.' })())
    const codingConfig = CodingSubscriptionConfig()
    codingConfig.cwd = workspace
    const codex = new CodingSubscriptionAdapter(codingConfig, {
      verifyAuth,
      runText,
      liveSessions: ctx.sessions,
    })
    const stream = vi.spyOn(codex, 'stream')
    ctx.llm.registerAdapter(['codex-subscription'], codex)
    await ctx.plugin(AgentLoop, { agents: [] })
    const transport = new FakeLarkTransport()
    await installLark(ctx, transport)
    await pairOwner(ctx)

    await transport.message(larkMessage('om-codex-tool-turn', 'use an evolution tool'))
    expect(saved.size).toBe(1)
    await runInboundPass(ctx)
    await runInboundPass(ctx)

    expect(stream).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(verifyAuth).toHaveBeenCalled()
      expect(runText).toHaveBeenCalled()
    })
    const request = stream.mock.calls[0]?.[0]
    expect(request?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'evolution_review',
      'evolution_propose',
      'evolution_undo',
    ]))
    expect(transport.sent.at(-1)?.input).toMatchObject({
      markdown: expect.stringContaining('Codex received the same Agent tools.'),
    })
    await closeContext(ctx)
  })
})
