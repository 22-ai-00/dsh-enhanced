import { createMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { buildPrompt, parseDelegatedToolCalls } from '../src/prompt.ts'

function request(): GenerateOptions {
  return {
    provider: 'traex-agent',
    model: 'default',
    system: 'Be concise.',
    messages: [
      createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'other', model: 'model' },
        content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'Hello' }],
      }),
    ],
  }
}

describe('DSH request serialization', () => {
  it('keeps system and ordered messages while omitting historical reasoning', () => {
    const prompt = buildPrompt(request(), 100_000)
    expect(prompt).toContain('dsh-traex-acp-provider/v1')
    expect(prompt).toContain('Be concise.')
    expect(prompt).toContain('你好')
    expect(prompt).toContain('reasoning-omitted')
    expect(prompt).not.toContain('private')
  })

  it('projects nested tool-result images to bounded metadata text without reading image bytes', () => {
    const options = request()
    const callId = 'call-image-result' as never
    const longId = `opaque:${'i'.repeat(10_000)}`
    const longName = `${'n'.repeat(10_000)}.png`
    options.messages = [...options.messages, createMessage({
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:tool-image',
              mediaType: 'image/png',
              bytes: 2,
              width: 1,
              height: 1,
              name: 'tool.png',
              data: 'TOP_SECRET_IMAGE_BYTES',
            },
          } as never,
          {
            type: 'image',
            attachment: {
              attachmentId: longId,
              mediaType: 'image/webp',
              bytes: 123,
              width: 640,
              height: 480,
              name: longName,
            },
          } as never,
        ],
      }],
    })]

    const prompt = buildPrompt(options, 100_000)
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      conversation: Array<{ content: Array<{ content?: Array<{ type: string; text?: string }> }> }>
    }
    const projected = payload.conversation.at(-1)!.content[0]!.content!

    expect(projected[0]).toEqual({
      type: 'text',
      text: '[DSH image attachment omitted by text-only backend; '
        + 'attachmentId="sha256:tool-image"; mediaType="image/png"; bytes=2; '
        + 'width=1; height=1; name="tool.png"]',
    })
    expect(projected[1]!.type).toBe('text')
    expect(projected[1]!.text!.length).toBeLessThanOrEqual(640)
    expect(projected[1]!.text).toContain('mediaType="image/webp"')
    expect(projected[1]!.text).toContain('bytes=123; width=640; height=480')
    expect(projected[1]!.text).toContain('…')
    expect(prompt).not.toContain('TOP_SECRET_IMAGE_BYTES')
    expect(prompt).not.toContain('i'.repeat(1_000))
    expect(prompt).not.toContain('n'.repeat(1_000))
  })

  it('continues to reject a top-level image on the text-only ACP route', () => {
    const options = request()
    options.messages = [createMessage({
      role: 'user',
      source: { kind: 'user' },
      content: [{
        type: 'image',
        attachment: {
          attachmentId: 'sha256:user-image', mediaType: 'image/png', bytes: 1,
          width: 1, height: 1,
        },
      } as never],
    })]

    expect(() => buildPrompt(options, 100_000)).toThrow(/text-only DSH requests/)
  })

  it('delegates DSH tool schemas and requires an immediate tool-call envelope', () => {
    const options = request()
    options.tools = [{
      name: 'read',
      description: 'Read a workspace file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }]

    const prompt = buildPrompt(options, 100_000)

    expect(prompt).toContain('dsh-tool-calls/v1')
    expect(prompt).toContain('do not invoke TraeX-native tools')
    expect(prompt).toContain('The first output character must be {')
    expect(prompt).toContain('request the required tool now')
    expect(prompt).toContain('"name":"read"')
    expect(prompt).toContain('"description":"Read a workspace file."')
    expect(prompt).toContain('"required":["path"]')
  })

  it('recovers a valid tool envelope accidentally wrapped in a progress preamble', () => {
    const tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const response = '我先读取关键源码，然后继续分析。\n\n'
      + '{"protocol":"dsh-tool-calls/v1","calls":[{"name":"read","arguments":{"path":"README.md"}}]}'

    expect(parseDelegatedToolCalls(response, tools)).toEqual([
      { name: 'read', arguments: '{"path":"README.md"}' },
    ])
  })

  it('does not reinterpret ordinary prose containing unrelated JSON as a tool request', () => {
    const tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    expect(parseDelegatedToolCalls('Result: {"status":"ok"}', tools)).toBeUndefined()
  })

  it('fails closed for an embedded envelope that names an unavailable tool', () => {
    const tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const response = '准备执行。\n'
      + '{"protocol":"dsh-tool-calls/v1","calls":[{"name":"bash","arguments":{"command":"pwd"}}]}'
    expect(() => parseDelegatedToolCalls(response, tools)).toThrow(/unavailable DSH tool/)
  })

  it('enforces a UTF-8 prompt bound', () => {
    expect(() => buildPrompt(request(), 10)).toThrow(/configured limit/)
  })

  it('marks an oversized prompt with a routable cause and an actionable remedy', () => {
    // The bound exists only to cap local memory: the prompt travels as an ACP stdin text block,
    // never as argv, so the failure must stay routable rather than surfacing unclassified.
    expect(() => buildPrompt(request(), 10)).toThrow(/maxPromptBytes/)
    try {
      buildPrompt(request(), 10)
      expect.unreachable('an oversized prompt must throw')
    } catch (error) {
      expect((error as Error).cause).toBe('prompt-limit')
    }
  })

  it('fails closed for unknown or extension content blocks', () => {
    const options = request()
    options.messages = [{
      ...options.messages[0]!,
      content: [{ type: 'future-extension', payload: 'secret' } as never],
    }]
    expect(() => buildPrompt(options, 100_000)).toThrow(/does not support content block type/)
  })
})
