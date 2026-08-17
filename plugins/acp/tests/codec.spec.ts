import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { createSessionEventMapper } from '../src/codec.ts'

function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  seq = 1,
): Extract<SessionEvent, { type: T }> {
  return { type, data, seq, time: 1_700_000_000_000 } as Extract<SessionEvent, { type: T }>
}

describe('DSH session event to ACP updates', () => {
  it('exposes committed text, reasoning and token accounting', () => {
    const mapper = createSessionEventMapper({ includeRawEvents: true })
    mapper.map(event('request/context', { provider: 'alpha', model: 'reasoner', contextWindow: 128_000 }))
    const updates = mapper.map(event('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'private thought' },
          { type: 'text', text: 'visible answer' },
        ],
        source: { provider: 'alpha', model: 'reasoner' },
      }),
      usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 12, cacheReadTokens: 30 },
    }))

    expect(updates).toEqual([
      expect.objectContaining({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'private thought' },
      }),
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'visible answer' },
      }),
      expect.objectContaining({
        sessionUpdate: 'usage_update',
        size: 128_000,
        used: 150,
        _meta: { dsh: expect.objectContaining({ usage: expect.objectContaining({ reasoningTokens: 12 }) }) },
      }),
    ])
  })

  it('reports tool lifecycle and preserves DSH raw payloads in metadata', () => {
    const mapper = createSessionEventMapper({ includeRawEvents: true })
    const callId = CallId('call-1')
    const started = mapper.map(event('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: 'read_file',
      arguments: '{"path":"/tmp/a"}',
    }))
    const finished = mapper.map(event('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
      }),
      meta: { presentation: 'native' },
    }))

    expect(started).toEqual([expect.objectContaining({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'read_file',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: '/tmp/a' },
      _meta: { dsh: expect.objectContaining({ event: expect.objectContaining({ type: 'tool/call' }) }) },
    })])
    expect(finished).toEqual([expect.objectContaining({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }],
      rawOutput: expect.objectContaining({ meta: { presentation: 'native' } }),
    })])
  })

  it('maps native todos, modes and titles and carries otherwise-unmapped events', () => {
    const mapper = createSessionEventMapper({ includeRawEvents: true })
    const plan = mapper.map(event('todo/write', {
      todos: [
        { content: 'Inspect source', status: 'completed' },
        { content: 'Implement bridge', status: 'in_progress' },
      ],
    }))
    const mode = mapper.map(event('plan/mode', { active: true }))
    const title = mapper.map(event('session/title', {
      title: 'ACP integration',
      messageSeqs: [1],
      source: { kind: 'fallback' },
    }))
    const raw = mapper.map(event('turn/start', { turn: 2 }))

    expect(plan).toEqual([expect.objectContaining({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect source', status: 'completed', priority: 'medium' },
        { content: 'Implement bridge', status: 'in_progress', priority: 'medium' },
      ],
    })])
    expect(mode).toEqual([expect.objectContaining({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })])
    expect(title).toEqual([expect.objectContaining({
      sessionUpdate: 'session_info_update',
      title: 'ACP integration',
      updatedAt: '2023-11-14T22:13:20.000Z',
    })])
    expect(raw).toEqual([{
      sessionUpdate: 'session_info_update',
      _meta: { dsh: { event: expect.objectContaining({ type: 'turn/start', data: { turn: 2 } }) } },
    }])
  })

  it('can suppress trace-only raw event notifications', () => {
    const mapper = createSessionEventMapper({ includeRawEvents: false })
    expect(mapper.map(event('turn/start', { turn: 1 }))).toEqual([])
  })
})
