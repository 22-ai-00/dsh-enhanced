import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import type {
  DeliveryToolApprovalOutcome,
  DeliveryToolApprovalRequest,
  InboundEnvelope,
} from '../src/types.ts'

const roots: string[] = []
const contexts = new Set<Context>()

const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = {
  channel: 'lark',
  account: 'bot-1',
  tenant: 'tenant-a',
  kind: 'dm' as const,
  chat: 'oc_owner',
}
const envelope: InboundEnvelope = {
  channel: 'lark',
  account: 'bot-1',
  eventId: 'evt-runtime-approval',
  occurredAt: 1,
  principal,
  conversation,
  kind: 'text',
  text: 'run the exact requested operation',
}

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.restart()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function registerAgent(ctx: Context, sessionId: string, input: {
  callId: ReturnType<typeof ToolCallId>
  toolName: string
  argumentsJson: string
}): Agent {
  const id = SessionId(sessionId)
  const session = ctx.sessions.create(id, { meta: { cwd: '/work/alpha', agentPreset: 'primary' } })
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(),
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
  ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('approval/policy', { policy: 'ask' })
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: input.callId,
    name: input.toolName,
    arguments: input.argumentsJson,
  })
  return agent
}

async function fixture(adapterOutcome: DeliveryToolApprovalOutcome) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-tool-runtime-'))
  roots.push(root)
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      {
        id: 'pair-local-owner',
        effect: 'allow',
        subject: { kind: 'external', id: 'local:test' },
        actions: ['pair.issue'],
        resource: { kind: 'message', id: 'pairing' },
        context: { initiators: ['foreground'] },
      },
      {
        id: 'admit-owner-message',
        effect: 'allow',
        subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
        actions: ['pair.confirm', 'ingest'],
        resource: { kind: 'message', id: '*' },
        context: { initiators: ['external'] },
      },
      {
        id: 'allow-exact-probe',
        effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['execute'],
        resource: { kind: 'tool', id: 'delivery_mutation_probe' },
        context: { initiators: ['foreground'] },
      },
    ],
  })
  ctx.on('tools/pre-execute', (execution, next) => execution.name === 'delivery_mutation_probe'
    ? Promise.resolve({ kind: 'ask', reason: 'Owner approval required for the exact integration probe.' })
    : next())
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: join(root, 'delivery.sqlite'),
    spoolPath: join(root, 'spool'),
    schedulerEnabled: false,
  })
  ctx.on('session/flush', () => {})

  const pairing = ctx.assistantDelivery.issuePairing('test', principal)
  ctx.assistantDelivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  ctx.assistantDelivery.registerInboundRuntime({
    createSession: async () => ({
      sessionId: 'runtime-approval-session',
      workspace: '/work/alpha',
      agentPreset: 'primary',
      policyRef: 'owner-dm',
    }),
    process: async () => ({ outcome: 'processed' }),
  })
  await ctx.assistantDelivery.acceptInbound(envelope)

  const callId = ToolCallId('runtime-approval-call')
  const arguments_ = { operation: 'exact-request', value: 7 }
  const argumentsJson = JSON.stringify(arguments_)
  const agent = registerAgent(ctx, 'runtime-approval-session', {
    callId,
    toolName: 'delivery_mutation_probe',
    argumentsJson,
  })
  let executions = 0
  const receivedArguments: unknown[] = []
  ctx.tools.register(defineTool({
    name: 'delivery_mutation_probe',
    description: 'Mutating integration probe that requires owner approval.',
    parameters: {
      operation: { type: 'string', required: true },
      value: { type: 'integer', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_arguments, value) => [{ type: 'text', text: value }],
    },
    async execute(arguments_) {
      executions += 1
      receivedArguments.push(arguments_)
      return 'probe-executed'
    },
  }))
  const requests: DeliveryToolApprovalRequest[] = []
  const requestToolApproval = vi.fn(async (request: Readonly<DeliveryToolApprovalRequest>) => {
    requests.push(request)
    return adapterOutcome
  })
  await ctx.assistantDelivery.registerAdapter({
    channel: 'lark',
    account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], toolApprovals: true },
    start: async () => {},
    requestToolApproval,
    send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
  })

  return {
    agent,
    arguments_,
    argumentsJson,
    callId,
    ctx,
    get executions() { return executions },
    receivedArguments,
    requests,
    requestToolApproval,
  }
}

describe('owner-DM approval through the real tool runtime', () => {
  test('an allowed-once owner decision dispatches the exact tool exactly once', async () => {
    const current = await fixture('allowed-once')

    const result = await current.ctx.tools.execute({
      callId: current.callId,
      name: 'delivery_mutation_probe',
      arguments: current.arguments_,
      signal: new AbortController().signal,
      agent: current.agent,
    })

    expect(result).toMatchObject({ isError: false, value: 'probe-executed' })
    expect(current.executions).toBe(1)
    expect(current.receivedArguments).toEqual([current.arguments_])
    expect(current.requestToolApproval).toHaveBeenCalledOnce()
    expect(current.requests).toEqual([
      expect.objectContaining({
        target: { conversation, principal },
        toolName: 'delivery_mutation_probe',
        callId: String(current.callId),
        arguments: current.argumentsJson,
      }),
    ])
    expect(current.agent.session.snapshotEvents().filter(event => event.type === 'approval/asked')).toHaveLength(1)
    expect(current.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'allowed-once' }) }),
    ])
  })

  test('a rejected owner decision leaves the exact tool body unexecuted', async () => {
    const current = await fixture('rejected')

    const result = await current.ctx.tools.execute({
      callId: current.callId,
      name: 'delivery_mutation_probe',
      arguments: current.arguments_,
      signal: new AbortController().signal,
      agent: current.agent,
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('user rejected') }),
    ])
    expect(current.executions).toBe(0)
    expect(current.receivedArguments).toEqual([])
    expect(current.requestToolApproval).toHaveBeenCalledOnce()
    expect(current.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'rejected' }) }),
    ])
  })
})
