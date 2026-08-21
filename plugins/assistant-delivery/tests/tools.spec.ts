import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function agent(sessionId: string): Agent {
  const id = SessionId(sessionId)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1,
    cwd: '/work/alpha', agentPreset: 'primary' })
  return { id, options: {}, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-tools-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'],
      resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'owner', effect: 'allow', subject: { kind: 'external', id: 'lark/bot/tenant/owner' },
      actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'delivery-service', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground'] } },
    { id: 'delivery-tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['execute'], resource: { kind: 'tool', id: 'delivery_*' }, context: { initiators: ['foreground'] } },
  ] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'),
    schedulerEnabled: false })
  const principal = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
  const conversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'chat' }
  const pairing = ctx.assistantDelivery.issuePairing('test', principal)
  ctx.assistantDelivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  ctx.assistantDelivery.registerInboundRuntime({ createSession: async () => ({ sessionId: 'delivery-tool-session',
    workspace: '/work/alpha', agentPreset: 'primary', policyRef: 'owner-dm' }),
  process: async () => ({ outcome: 'processed' }) })
  await ctx.assistantDelivery.acceptInbound({ channel: 'lark', account: 'bot', eventId: 'evt-1', occurredAt: 1,
    principal, conversation, kind: 'text', text: 'hello' })
  return { ctx, current: agent('delivery-tool-session') }
}

function call(name: string, arguments_: Record<string, unknown>, current?: Agent) {
  return { callId: CallId(`${name}-${Math.random()}`), name, arguments: arguments_, signal: new AbortController().signal,
    ...(current === undefined ? {} : { agent: current }) }
}

describe('delivery tools', () => {
  test('registers only reply-to-current-binding and bounded status', async () => {
    const f = await harness()
    expect(f.ctx.tools.schemas().map(value => value.name).filter(name => name.startsWith('delivery_')).sort())
      .toEqual(['delivery_reply', 'delivery_status'])
    expect(f.ctx.tools.get('delivery_reply')?.parameters).not.toHaveProperty('channel')
    expect(f.ctx.tools.get('delivery_reply')?.parameters).not.toHaveProperty('chat')
    await f.ctx.fiber.restart()
  })

  test('reply persists an intent and status excludes bodies and route identifiers', async () => {
    const f = await harness()
    const reply = await f.ctx.tools.execute(call('delivery_reply', { idempotency_key: 'reply-1', text: 'secret body' }, f.current))
    expect(reply.isError ? undefined : reply.value).toMatchObject({ status: 'pending' })
    const status = await f.ctx.tools.execute(call('delivery_status', { limit: 5 }, f.current))
    expect(status.isError).toBe(false)
    const serialized = JSON.stringify(status.isError ? undefined : status.value)
    expect(serialized).not.toContain('secret body')
    expect(serialized).not.toContain('chat')
    expect(serialized).not.toContain('owner')
    await f.ctx.fiber.restart()
  })

  test('fails closed without a trusted Agent', async () => {
    const f = await harness()
    for (const [name, args] of [['delivery_reply', { idempotency_key: 'x', text: 'x' }], ['delivery_status', {}]] as const) {
      const value = await f.ctx.tools.execute(call(name, args))
      expect(value.isError).toBe(true)
    }
    await f.ctx.fiber.restart()
  })
})
