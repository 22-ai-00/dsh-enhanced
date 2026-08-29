import { createMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  buildPrompt,
  CLI_PROMPT_LIMIT_CAUSE,
  DSH_TOOL_CALL_PROTOCOL,
  parseDelegatedToolCalls,
} from '../src/prompt.ts'

function request(): GenerateOptions {
  return {
    provider: 'codex-subscription',
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

function skillCatalog(
  text: string,
  update = false,
  entries: readonly { name: string; description: string }[] = [{ name: 'test-skill', description: 'test skill' }],
) {
  return createMessage({
    role: 'user',
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      entries,
      ...(update ? { update: true } : {}),
    } as never,
    content: [{ type: 'text', text }],
  })
}

function malformedCatalogUpdate(text: string) {
  return createMessage({
    role: 'user',
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      entries: 'not-an-entry-list',
    } as never,
    content: [{ type: 'text', text }],
  })
}

function conversationTexts(prompt: string): string[] {
  const request = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
    conversation: { content: { text?: string }[] }[]
  }
  return request.conversation.flatMap(message => message.content.flatMap(block => block.text ?? []))
}

describe('DSH request serialization', () => {
  it('keeps system and ordered messages while omitting historical reasoning', () => {
    const prompt = buildPrompt(request(), 100_000)
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

  it('continues to reject a top-level image on the text-only CLI route', () => {
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

  it('enforces a UTF-8 prompt bound', () => {
    try {
      buildPrompt(request(), 10)
      expect.unreachable('expected the serialized request to exceed the byte limit')
    } catch (error: unknown) {
      expect(error).toMatchObject({
        message: expect.stringMatching(/configured limit/),
        cause: CLI_PROMPT_LIMIT_CAUSE,
      })
    }
  })

  it('serializes only the newest complete skill catalog after a catalog replacement', () => {
    const prompt = buildPrompt({
      ...request(),
      messages: [
        skillCatalog(`obsolete-catalog:${'x'.repeat(5_000)}`),
        createMessage({
          role: 'assistant',
          source: { kind: 'model', provider: 'other', model: 'model' },
          content: [{ type: 'text', text: 'catalog acknowledged' }],
        }),
        skillCatalog('stale-replacement', true),
        createMessage({
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'message after stale replacement' }],
        }),
        skillCatalog('current-catalog', true),
        createMessage({
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'answer this request' }],
        }),
      ],
    }, 2_000)

    expect(conversationTexts(prompt)).toEqual([
      'catalog acknowledged',
      'message after stale replacement',
      'current-catalog',
      'answer this request',
    ])
  })

  it('keeps every skill catalog when no catalog carries an explicit replacement marker', () => {
    const prompt = buildPrompt({
      ...request(),
      messages: [skillCatalog('first-catalog'), skillCatalog('second-catalog')],
    }, 2_000)

    expect(conversationTexts(prompt)).toEqual(['first-catalog', 'second-catalog'])
  })

  it('does not let a malformed catalog source retire an earlier valid catalog', () => {
    const prompt = buildPrompt({
      ...request(),
      messages: [skillCatalog('valid-catalog'), malformedCatalogUpdate('malformed-catalog')],
    }, 2_000)

    expect(conversationTexts(prompt)).toEqual(['valid-catalog', 'malformed-catalog'])
  })

  it('does not prune from an older replacement marker when the newest valid catalog is unmarked', () => {
    const prompt = buildPrompt({
      ...request(),
      messages: [
        skillCatalog('initial-catalog'),
        skillCatalog('older-replacement', true),
        skillCatalog('newest-unmarked-catalog'),
      ],
    }, 2_000)

    expect(conversationTexts(prompt)).toEqual([
      'initial-catalog',
      'older-replacement',
      'newest-unmarked-catalog',
    ])
  })

  it('keeps an explicit empty replacement while retiring all earlier catalogs', () => {
    const prompt = buildPrompt({
      ...request(),
      messages: [skillCatalog('obsolete-catalog'), skillCatalog('empty-catalog', true, [])],
    }, 2_000)

    expect(conversationTexts(prompt)).toEqual(['empty-catalog'])
  })

  it('delegates the exact DSH tool schemas and forbids CLI-native execution', () => {
    const options = request()
    options.tools = [{
      name: 'read',
      description: 'Read one workspace file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    }]

    const prompt = buildPrompt(options, 100_000)

    expect(prompt).toContain(DSH_TOOL_CALL_PROTOCOL)
    expect(prompt).toContain('treat CLI-native tools as unavailable')
    expect(prompt).toContain('Tools can only be used through DSH')
    expect(prompt).toContain('Do not supply a tool-call id')
    expect(prompt).toContain('"name":"read"')
    expect(prompt).toContain('"description":"Read one workspace file."')
    expect(prompt).toContain('"required":["path"]')
  })

  it('keeps schemas but forbids tool delegation during an attested compaction request', () => {
    const options = request()
    options.purpose = 'compaction'
    options.tools = [{
      name: 'read',
      description: 'Read one workspace file.',
      parameters: { type: 'object' },
    }]

    const prompt = buildPrompt(options, 100_000)
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      instruction: string
      constraints: { purpose: string; tools: { available: unknown[] } }
    }

    expect(payload.instruction).toContain('Produce only the requested compaction checkpoint')
    expect(payload.instruction).toContain('Do not request or invoke any tool')
    expect(payload.instruction).toContain('do not emit a DSH tool-call JSON envelope')
    expect(payload.constraints).toMatchObject({
      purpose: 'compaction',
      tools: { available: [{ name: 'read' }] },
    })
  })

  it('decodes exact one-or-many DSH tool calls without accepting a model call id', () => {
    const tools = [
      { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
      { name: 'search', description: 'Search files.', parameters: { type: 'object' } },
    ]
    const response = JSON.stringify({
      protocol: DSH_TOOL_CALL_PROTOCOL,
      calls: [
        { name: 'read', arguments: { path: 'README.md' } },
        { name: 'search', arguments: { query: 'toolCalls' } },
      ],
    })

    expect(parseDelegatedToolCalls(response, tools)).toEqual([
      { name: 'read', arguments: '{"path":"README.md"}' },
      { name: 'search', arguments: '{"query":"toolCalls"}' },
    ])
    expect(() => parseDelegatedToolCalls(JSON.stringify({
      protocol: DSH_TOOL_CALL_PROTOCOL,
      calls: [{ id: 'model-controlled', name: 'read', arguments: { path: 'README.md' } }],
    }), tools)).toThrow(/invalid or unavailable DSH tool call/)
  })

  it('leaves ordinary assistant text and unrelated JSON untouched', () => {
    const tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    expect(parseDelegatedToolCalls('Task complete.', tools)).toBeUndefined()
    expect(parseDelegatedToolCalls('{"status":"complete"}', tools)).toBeUndefined()
  })

  it('rejects a delegated tool envelope when the Agent exposed no tools', () => {
    const response = `{"protocol":"${DSH_TOOL_CALL_PROTOCOL}","calls":[{"name":"read","arguments":{}}]}`
    expect(() => parseDelegatedToolCalls(response, [])).toThrow(/no tools were available/)
  })

  it.each([
    {
      name: 'preamble',
      response: `I will read it now.\n{"protocol":"${DSH_TOOL_CALL_PROTOCOL}","calls":[]}`,
    },
    {
      name: 'markdown fence',
      response: `\`\`\`json\n{"protocol":"${DSH_TOOL_CALL_PROTOCOL}","calls":[]}\n\`\`\``,
    },
    {
      name: 'escaped slash marker in a markdown fence',
      response: ['```json', '{"protocol":"dsh-tool-calls\\/v1","calls":[]}', '```'].join('\n'),
    },
    {
      name: 'unicode-escaped marker in mixed text',
      response: String.raw`tool request: {"protocol":"dsh-tool-calls\u002fv1","calls":[]}`,
    },
    {
      name: 'escaped marker after an unmatched quote',
      response: String.raw`"broken prefix
{"protocol":"dsh-tool-calls\/v1","calls":[]}`,
    },
    {
      name: 'fully unicode-escaped marker after malformed text',
      response: String.raw`broken {"protocol":"\u0064\u0073\u0068\u002d\u0074\u006f\u006f\u006c\u002d\u0063\u0061\u006c\u006c\u0073\u002f\u0076\u0031","calls":[]}`,
    },
    {
      name: 'unknown tool',
      response: `{"protocol":"${DSH_TOOL_CALL_PROTOCOL}","calls":[{"name":"bash","arguments":{}}]}`,
    },
    {
      name: 'non-object arguments',
      response: `{"protocol":"${DSH_TOOL_CALL_PROTOCOL}","calls":[{"name":"read","arguments":[]}]}`,
    },
    {
      name: 'empty calls',
      response: `{"protocol":"${DSH_TOOL_CALL_PROTOCOL}","calls":[]}`,
    },
    {
      name: 'extra envelope field',
      response: `{"protocol":"${DSH_TOOL_CALL_PROTOCOL}","calls":[{"name":"read","arguments":{}}],"note":"run it"}`,
    },
  ])('fails closed for an invalid tool envelope: $name', ({ response }) => {
    const tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    expect(() => parseDelegatedToolCalls(response, tools)).toThrow(/tool-call envelope|DSH tool call/)
  })

  it('bounds tool-call count and nested argument depth before host projection', () => {
    const tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const tooMany = JSON.stringify({
      protocol: DSH_TOOL_CALL_PROTOCOL,
      calls: Array.from({ length: 65 }, () => ({ name: 'read', arguments: {} })),
    })
    let nested: Record<string, unknown> = {}
    for (let depth = 0; depth < 65; depth += 1) nested = { nested }
    const tooDeep = JSON.stringify({
      protocol: DSH_TOOL_CALL_PROTOCOL,
      calls: [{ name: 'read', arguments: nested }],
    })

    expect(() => parseDelegatedToolCalls(tooMany, tools)).toThrow(/invalid DSH tool-call envelope/)
    expect(() => parseDelegatedToolCalls(tooDeep, tools)).toThrow(/invalid or unavailable DSH tool call/)
  })

  it('rejects an integer that JSON parsing would silently round before tool validation', () => {
    const tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const response = `{"protocol":"${DSH_TOOL_CALL_PROTOCOL}","calls":[{"name":"read","arguments":{"offset":9007199254740993}}]}`

    expect(() => parseDelegatedToolCalls(response, tools)).toThrow(/invalid or unavailable DSH tool call/)
  })
})
