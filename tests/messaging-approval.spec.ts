import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { LarkChannelService } from '@dsh-enhanced/lark-channel'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  LarkCardAction,
  LarkMessage,
  LarkSendInput,
  LarkSendOptions,
  LarkTransport,
  LarkTransportHandlers,
} from '@dsh-enhanced/lark-channel'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

class FakeLarkTransport implements LarkTransport {
  handlers: LarkTransportHandlers | undefined
  readonly send = vi.fn(async (_chat: string, _input: LarkSendInput, _options?: LarkSendOptions) => ({ messageId: 'om_card' }))
  subscribe(handlers: LarkTransportHandlers): () => void {
    this.handlers = handlers
    return () => { this.handlers = undefined }
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async message(input: LarkMessage): Promise<void> { await this.handlers?.message(input) }
  async action(input: LarkCardAction): Promise<void> { await this.handlers?.cardAction(input) }
}

function agent(sessionId: string): Agent {
  const id = SessionId(sessionId)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1,
    cwd: '/work/alpha', agentPreset: 'primary' })
  return { id, options: {}, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
}

describe('durable Lark approval composition', () => {
  test('settles one signed outbox approval through the exact paired actor and chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'messaging-approval-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
      { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
        actions: ['pair.issue'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground'] } },
      { id: 'owner', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
        actions: ['approval.decide', 'ingest', 'pair.confirm'], resource: { kind: 'message', id: '*' },
        context: { initiators: ['external'] } },
      { id: 'send-approval', effect: 'allow', subject: { kind: 'background', id: 'automation-1', workspace: '/work/alpha' },
        actions: ['approval.send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
      { id: 'history', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['history'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground'] } },
    ] })
    await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'), schedulerEnabled: false })
    const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
    const challenge = ctx.assistantDelivery.issuePairing('test', principal)
    ctx.assistantDelivery.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    ctx.assistantDelivery.registerInboundRuntime({
      createSession: async () => ({ sessionId: 'approval-session', workspace: '/work/alpha',
        agentPreset: 'primary', policyRef: 'owner-dm' }),
      process: async () => ({ outcome: 'processed' }),
    })
    const transport = new FakeLarkTransport()
    const lark = new LarkChannelService(ctx, { enabled: true, account: 'bot-1', tenant: 'tenant-a',
      appId: 'cli_0123456789abcdef', appSecretEnv: 'LARK_APP_SECRET' }, {
      env: { LARK_APP_SECRET: 'approval-signing-secret-value-12345' }, createTransport: () => transport,
    })
    await lark.whenReady()
    await transport.message({ messageId: 'om_in', chatId: 'oc_owner', chatType: 'p2p', senderId: 'ou_owner',
      content: 'hello', rawContentType: 'text', resources: [], mentionAll: false, mentionedBot: false,
      createTime: Date.now() })
    const approvalAgent = agent('approval-session')
    const binding = ctx.assistantDelivery.history(approvalAgent, {}).binding
    const dispatch = ctx.assistantDelivery.prepareAgentApproval(approvalAgent, { sourceId: 'automation-1' })
    const proposal = ctx.assistantPolicy.propose({ idempotencyKey: 'proposal-1', requester: 'automation-1',
      principal: 'lark/bot-1/tenant-a/ou_owner', action: 'send', resource: { kind: 'message', id: binding.id },
      diff: 'send the reviewed result', summary: 'Send result', ttlMs: 60_000,
      dispatch })
    await ctx.assistantDelivery.tick()
    await ctx.assistantDelivery.whenIdle()
    const card = transport.send.mock.calls[0]![1] as { approval: { approveValue: { approval: string } } }
    await transport.action({ messageId: 'om_card', chatId: 'oc_owner', operatorId: 'ou_owner',
      value: card.approval.approveValue })
    expect(ctx.assistantPolicy.decideProposal({ proposalId: proposal.proposalId,
      principal: 'lark/bot-1/tenant-a/ou_owner', expectedVersion: proposal.version,
      decision: 'approved', reason: 'Lark owner approved' })).toMatchObject({ status: 'approved', replayed: true })
    await ctx.fiber.restart()
  })
})
