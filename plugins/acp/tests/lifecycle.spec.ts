import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService, { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

async function initialize(harness: BridgeHarness): Promise<void> {
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
}

async function newSession(harness: BridgeHarness): Promise<string> {
  return (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
}

function messageText(harness: BridgeHarness, sessionId: string): string {
  return harness.updates.flatMap(({ sessionId: owner, update }) => (
    owner === sessionId && update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
      ? [update.content.text]
      : []
  )).join('')
}

describe('official ACP lifecycle contracts', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('cancels a running prompt and awaits agent teardown on plugin disposal', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    await initialize(harness)
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await vi.waitFor(() => { expect(agent.status).toBe('running') })

    await harness.acpFiber.dispose()

    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(agent.status).toBe('idle')
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('drains continuable descendants before disposing owned agents', async () => {
    harness = await makeBridgeHarness()
    const order: string[] = []
    let parents: readonly Agent[] = []
    harness.ctx.provide('subagents', {
      drainContinuableDescendants: (agents: readonly Agent[]) => {
        parents = agents
        order.push('drained')
        return Promise.resolve()
      },
    } as never)
    harness.ctx.on('agent/disposed', () => { order.push('disposed') })
    await initialize(harness)
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    await harness.acpFiber.dispose()

    expect(parents).toEqual([agent])
    expect(order).toEqual(['drained', 'disposed'])
  })

  it('isolates concurrent session output and cancellation', async () => {
    harness = await makeBridgeHarness({ script: ['hang', textResponse('B done')] })
    await initialize(harness)
    const a = await newSession(harness)
    const b = await newSession(harness)
    const pendingA = harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'A' }] })
    await vi.waitFor(() => { expect(harness?.ctx.agents.get(SessionId(a))?.status).toBe('running') })

    await harness.client.cancel({ sessionId: a })
    await expect(pendingA).resolves.toEqual({ stopReason: 'cancelled' })
    await expect(harness.client.prompt({ sessionId: b, prompt: [{ type: 'text', text: 'B' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await vi.waitFor(() => { expect(messageText(harness!, b)).toBe('B done') })
    expect(messageText(harness, a)).not.toContain('B done')
  })

  it('session/close cancels work, removes the session, and leaves peers alive', async () => {
    harness = await makeBridgeHarness({ script: ['hang', textResponse('still alive')] })
    await initialize(harness)
    const closing = await newSession(harness)
    const peer = await newSession(harness)
    const prompt = harness.client.prompt({ sessionId: closing, prompt: [{ type: 'text', text: 'go' }] })
    await vi.waitFor(() => { expect(harness?.ctx.agents.get(SessionId(closing))?.status).toBe('running') })

    await harness.client.closeSession({ sessionId: closing })

    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.ctx.agents.get(SessionId(closing))).toBeUndefined()
    await expect(harness.client.prompt({ sessionId: peer, prompt: [{ type: 'text', text: 'peer' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await expect(harness.client.closeSession({ sessionId: closing })).rejects.toThrow(/unknown session/)
  })

  it('a client disconnect disposes all owned sessions without root disposal', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    await initialize(harness)
    const sessionId = await newSession(harness)
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await vi.waitFor(() => { expect(harness?.ctx.agents.get(SessionId(sessionId))?.status).toBe('running') })

    await harness.closeClientTransport()

    await vi.waitFor(() => { expect(harness?.ctx.agents.get(SessionId(sessionId))).toBeUndefined() })
  })
})

describe('official ACP permission contracts', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  async function ownedRequest(): Promise<ApprovalRequest> {
    if (harness === undefined) throw new Error('missing harness')
    await harness.ctx.plugin(ApprovalService)
    await initialize(harness)
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.session.append('turn/start', { turn: 1 })
    return { agent, toolName: 'bash', callId: ToolCallId('call-9') }
  }

  it('maps one-shot choices and rejects unknown selections', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('allowed-once')
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'unknown' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')
    expect(harness.permissionRequests[0]).toMatchObject({
      sessionId: request.agent.session.id,
      toolCall: { toolCallId: 'call-9' },
    })
  })

  it('fails closed when the ACP client errors a permission request', async () => {
    harness = await makeBridgeHarness()
    const request = await ownedRequest()
    harness.onPermission = () => { throw new Error('client gone') }
    await expect(harness.ctx.approval.request(request)).resolves.toBe('unavailable')
  })
})
