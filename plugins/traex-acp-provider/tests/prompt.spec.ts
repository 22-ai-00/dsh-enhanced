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

  it('serializes request-only user input without inventing a durable source', () => {
    const options = request()
    options.messages = [{ role: 'user', content: [{ type: 'text', text: 'one-shot input' }] }]
    const payload = JSON.parse(buildPrompt(options, 100_000).split('\n').slice(1).join('\n')) as { conversation: unknown[] }
    expect(payload.conversation).toEqual([{ role: 'user', content: [{ type: 'text', text: 'one-shot input' }] }])
  })

  it('projects tool-result images to bounded metadata text without reading image bytes', () => {
    const options = request()
    const callId = 'call-image-result' as never
    const longId = `opaque:${'i'.repeat(10_000)}`
    const longName = `${'n'.repeat(10_000)}.png`
    options.messages = [...options.messages, createMessage({
      role: 'tool',
      source: { kind: 'tool', callId },
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

  it('delegates DSH tool schemas without treating availability as authorization', () => {
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
    expect(prompt).toContain('Declared tools describe availability, not authorization')
    expect(prompt).toContain('rejected or denied by the user, by policy, or because authorization is absent')
    expect(prompt).toContain('correct invalid arguments through authorized read-only discovery')
    expect(prompt).toContain('later authorized user or system instruction explicitly permits it')
    expect(prompt).toContain('honestly report that the requested work is blocked')
    expect(prompt).toContain('request it now instead of merely describing future work')
    expect(prompt).toContain('never a JSON-encoded string')
    expect(prompt).toContain('"name":"read"')
    expect(prompt).toContain('"description":"Read a workspace file."')
    expect(prompt).toContain('"required":["path"]')
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { constraints: { tools: { responseFormat: { calls: Array<{ arguments: unknown }> } } } }
    expect(payload.constraints.tools.responseFormat.calls[0]!.arguments).toEqual({ '<parameter name>': '<value matching that parameter schema>' })
  })

  it('preserves denied tool history and later user instructions across serialization', () => {
    const options = request()
    const callId = 'call-bash-denied' as never
    options.tools = [{ name: 'bash', description: 'Run a shell command.', parameters: { type: 'object' } }]
    options.messages = [
      createMessage({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Run `bash` to inspect the repository.' }],
      }),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'traex-agent', model: 'default' },
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"pwd"}' }],
      }),
      createMessage({
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        isError: true,
        content: [{ type: 'text', text: 'Denied by policy: shell access is not authorized.' }],
      }),
      createMessage({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Do not retry it; summarize the blocker and continue permitted analysis.' }],
      }),
    ]

    const prompt = buildPrompt(options, 100_000)
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      conversation: Array<{ role: string; content: unknown[] }>
    }

    expect(payload.conversation).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Run `bash` to inspect the repository.' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"pwd"}' }] },
      {
        role: 'tool',
        content: [{
          type: 'tool-result', toolCallId: callId, isError: true,
          content: [{ type: 'text', text: 'Denied by policy: shell access is not authorized.' }],
        }],
      },
      { role: 'user', content: [{ type: 'text', text: 'Do not retry it; summarize the blocker and continue permitted analysis.' }] },
    ])
  })

  it('recovers a valid tool envelope accidentally wrapped in a progress preamble', () => {
    const tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const response = '我先读取关键源码，然后继续分析。\n\n'
      + '{"protocol":"dsh-tool-calls/v1","calls":[{"name":"read","arguments":{"path":"README.md"}}]}'

    expect(parseDelegatedToolCalls(response, tools)).toEqual([
      { name: 'read', arguments: '{"path":"README.md"}' },
    ])
  })

  it('accepts one JSON-encoded object for a delegated tool call', () => {
    const tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const response = '{"protocol":"dsh-tool-calls/v1","calls":[{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}]}'
    expect(parseDelegatedToolCalls(response, tools)).toEqual([
      { name: 'read', arguments: '{"path":"README.md"}' },
    ])
  })

  it.each([
    ['null', null],
    ['array', []],
    ['malformed string', '{not-json}'],
    ['double-encoded object', '"{}"'],
    ['decoded scalar', '42'],
  ])('rejects a delegated tool call with %s arguments', (_name, argumentsValue) => {
    const tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const response = JSON.stringify({ protocol: 'dsh-tool-calls/v1', calls: [{ name: 'read', arguments: argumentsValue }] })
    expect(() => parseDelegatedToolCalls(response, tools)).toThrow(/invalid or unavailable DSH tool/u)
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

  it('customizes native-tool prohibition wording for Antigravity while keeping the dsh-traex-acp-provider/v1 envelope', () => {
    const options = request()
    options.tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const prompt = buildPrompt(options, 100_000, 'Antigravity')
    expect(prompt).toContain('dsh-traex-acp-provider/v1')
    expect(prompt).toContain('do not invoke Antigravity-native tools')
    expect(prompt).not.toContain('TraeX-native tools')
  })

  it('keeps schemas but forbids tool delegation during an attested compaction request', () => {
    const options = request()
    options.purpose = 'compaction' as never
    options.tools = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object' } }]
    const prompt = buildPrompt(options, 100_000, 'Antigravity')
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
    expect(payload.constraints.tools.available[0]).toEqual({ name: 'read' })
  })

  it('deduplicates superseded runtime-context snapshots and skill-catalogs, places constraints before conversation, and adds Antigravity plan guard', () => {
    const options = request()
    const tools = Array.from({ length: 80 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool ${index} description ${'x'.repeat(200)}`,
      parameters: { type: 'object', properties: { arg: { type: 'string', description: 'y'.repeat(300) } } },
    }))
    options.tools = tools
    const runtimeSnapshots = Array.from({ length: 18 }, (_, index) => createMessage({
      role: 'user',
      source: {
        kind: 'runtime-context',
        form: 'snapshot',
        sections: [{ name: 'memory', text: `snapshot-${index}:${'M'.repeat(10_000)}` }],
      } as never,
      content: [{ type: 'text', text: `<system-reminder>\nsnapshot-${index}:${'M'.repeat(10_000)}\n</system-reminder>` }],
    }))
    const oldCatalog = createMessage({
      role: 'user',
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'old-skill', description: 'old' }],
      } as never,
      content: [{ type: 'text', text: `OLD_CATALOG:${'C'.repeat(40_000)}` }],
    })
    const newCatalog = createMessage({
      role: 'user',
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        update: true,
        entries: [{ name: 'new-skill', description: 'new' }],
      } as never,
      content: [{ type: 'text', text: 'NEW_CATALOG:new-skill' }],
    })
    const latestQuestion = createMessage({
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '你现在什么版本' }],
    })
    options.messages = [
      ...runtimeSnapshots.slice(0, 9),
      oldCatalog,
      ...runtimeSnapshots.slice(9),
      newCatalog,
      latestQuestion,
    ]

    const prompt = buildPrompt(options, 184_320, 'Antigravity')
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(184_320)
    expect(prompt.indexOf('"constraints":')).toBeLessThan(prompt.indexOf('"conversation":'))

    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      instruction: string
      constraints: { tools: { available: unknown[] } }
      conversation: Array<{ content: Array<{ text?: string }> }>
    }
    expect(payload.instruction).toContain('never invoke exit_plan_mode')
    expect(payload.constraints.tools.available).toHaveLength(80)
    const serializedConversation = JSON.stringify(payload.conversation)
    expect(serializedConversation).not.toContain('snapshot-0:')
    expect(serializedConversation).not.toContain('snapshot-16:')
    expect(serializedConversation).toContain('snapshot-17:')
    expect(serializedConversation).not.toContain('OLD_CATALOG:')
    expect(serializedConversation).toContain('NEW_CATALOG:new-skill')
    expect(serializedConversation).toContain('你现在什么版本')
  })

  it('bounds oversized shadowed compaction history with UTF-8 multi-byte safety while keeping COMPACTION_INSTRUCTION intact', () => {
    const options = request()
    options.purpose = 'compaction' as never
    options.tools = Array.from({ length: 80 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'z'.repeat(400),
      parameters: { type: 'object', properties: { p: { type: 'string', description: 'w'.repeat(400) } } },
    }))
    const emojiBlock = '中文测试😀'.repeat(3_000)
    const directive = 'Produce exact structured compaction checkpoint now.'
    options.messages = [
      createMessage({ role: 'system', source: { kind: 'system-prompt' } as never, content: [{ type: 'text', text: 'SYS_HEAD' }] }),
      ...Array.from({ length: 14 }, (_, index) => createMessage({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `MSG_${index}_${emojiBlock}` }],
      })),
      { role: 'user', content: [{ type: 'text', text: directive }] },
    ]

    const prompt = buildPrompt(options, 184_320, 'Antigravity')
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(184_320)
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      constraints: { tools: { available: Array<Record<string, unknown>> } }
      conversation: Array<{ role: string; content: Array<{ text?: string }> }>
    }
    expect(payload.constraints.tools.available[0]).toEqual({ name: 'tool_0' })
    expect(payload.conversation[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'SYS_HEAD' }] })
    expect(payload.conversation.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: directive }] })
    expect(JSON.stringify(payload)).not.toMatch(/[\ud800-\udfff]/u)
  })

  it('uses Pass 2 omission binary search to retain the newest compaction messages within maxPromptBytes', () => {
    const options = request()
    options.purpose = 'compaction' as never
    options.tools = []
    const directive = 'Produce exact structured compaction checkpoint now.'
    options.messages = [
      createMessage({ role: 'system', source: { kind: 'system-prompt' } as never, content: [{ type: 'text', text: 'SYS_HEAD' }] }),
      ...Array.from({ length: 30 }, (_, index) => createMessage({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `MSG_${String(index).padStart(2, '0')}_${'B'.repeat(9_000)}` }],
      })),
      { role: 'user', content: [{ type: 'text', text: directive }] },
    ]

    const prompt = buildPrompt(options, 184_320, 'Antigravity')
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(184_320)
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      conversation: Array<{ role: string; content: Array<{ text?: string }> }>
    }
    expect(payload.conversation[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'SYS_HEAD' }] })
    expect(payload.conversation[1]).toEqual({
      role: 'user',
      content: [{
        type: 'text',
        text: '[Earlier conversation messages omitted to fit local ACP prompt byte limit during compaction.]',
      }],
    })
    expect(payload.conversation.at(-2)?.content[0]?.text).toMatch(/^MSG_29_B+…\[truncated for compaction\]$/u)
    expect(payload.conversation.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: directive }] })
  })

  it('throws cause prompt-limit when even minimal compaction envelope exceeds maxPromptBytes', () => {
    const options = request()
    options.purpose = 'compaction' as never
    options.tools = []
    options.messages = [
      createMessage({ role: 'system', source: { kind: 'system-prompt' } as never, content: [{ type: 'text', text: 'SYS_HEAD' }] }),
      createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'old context' }] }),
      { role: 'user', content: [{ type: 'text', text: 'Compact now.' }] },
    ]

    let caught: unknown
    try {
      buildPrompt(options, 100, 'Antigravity')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).cause).toBe('prompt-limit')
  })

  it('never splits UTF-16 surrogate pairs at the 8192-byte boundary and truncates nested tool-result blocks in compaction', () => {
    const options = request()
    options.purpose = 'compaction' as never
    options.tools = []
    const boundaryText = `${'a'.repeat(8_191)}😀${'tail'.repeat(500)}`
    const callId = 'call-compaction-nested' as never
    const directive = 'Compact cleanly.'
    options.messages = [
      createMessage({ role: 'system', source: { kind: 'system-prompt' } as never, content: [{ type: 'text', text: 'SYS_HEAD' }] }),
      createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: boundaryText }] }),
      createMessage({
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: `NESTED_TOOL_${'b'.repeat(9_000)}` }],
      }),
      createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'c'.repeat(2_000) }] }),
      { role: 'user', content: [{ type: 'text', text: directive }] },
    ]

    const prompt = buildPrompt(options, 21_000, 'Antigravity')
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(21_000)
    expect(prompt).not.toMatch(/[\ud800-\udfff]/u)
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      conversation: Array<{
        role: string
        content: Array<{ type: string; text?: string; content?: Array<{ type: string; text?: string }> }>
      }>
    }
    const surrogateMsg = payload.conversation.find(message => message.content[0]?.text?.startsWith('a'))
    expect(surrogateMsg?.content[0]?.text).toBe(`${'a'.repeat(8_191)}…[truncated for compaction]`)
    const toolMsg = payload.conversation.find(message => message.role === 'tool')
    expect(toolMsg?.content[0]?.type).toBe('tool-result')
    expect(toolMsg?.content[0]?.content?.[0]?.text).toMatch(/^NESTED_TOOL_b+…\[truncated for compaction\]$/u)
    expect(Buffer.byteLength(toolMsg?.content[0]?.content?.[0]?.text ?? '', 'utf8')).toBeLessThan(8_250)
  })

  it('retains earlier skill-catalog messages when a newer skill-catalog omits update: true', () => {
    const options = request()
    options.tools = []
    const firstCatalog = createMessage({
      role: 'user',
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'skill-a', description: 'First skill' }],
      } as never,
      content: [{ type: 'text', text: 'FIRST_CATALOG_KEEP' }],
    })
    const secondCatalog = createMessage({
      role: 'user',
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'skill-b', description: 'Second skill' }],
      } as never,
      content: [{ type: 'text', text: 'SECOND_CATALOG_KEEP' }],
    })
    options.messages = [firstCatalog, secondCatalog]

    const prompt = buildPrompt(options, 100_000, 'Antigravity')
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      conversation: Array<{ content: Array<{ text?: string }> }>
    }
    const serialized = JSON.stringify(payload.conversation)
    expect(serialized).toContain('FIRST_CATALOG_KEEP')
    expect(serialized).toContain('SECOND_CATALOG_KEEP')
  })

  it('compacts a realistic 99-tool (~69 KB) schema while preserving structural constraints and tool-call parsing', () => {
    const options = request()
    const tools = Array.from({ length: 99 }, (_, index) => ({
      name: `dsh_tool_${String(index).padStart(2, '0')}`,
      description: `Execute structured operation ${index} across workspace resources with validation. ${'Verbose usage guidance. '.repeat(10)}`,
      parameters: index === 0
        ? {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            title: 'Tool0Input',
            description: 'Root schema description for tool 0',
            type: 'object',
            additionalProperties: false,
            required: ['action', 'target'],
            examples: [{ action: 'read', target: { path: 'README.md' } }],
            properties: {
              action: {
                type: 'string',
                enum: ['read', 'list', 'inspect'],
                title: 'ActionTitle',
                description: `Action selector for tool 0. ${'Detailed prose '.repeat(8)}`,
              },
              target: {
                type: 'object',
                additionalProperties: false,
                required: ['path'],
                description: 'Target object description',
                properties: {
                  path: {
                    type: 'string',
                    description: 'Deep nested path description that should be stripped in compact mode',
                  },
                  title: {
                    type: 'string',
                    description: 'A real parameter literally named title',
                  },
                },
              },
              tags: {
                type: 'array',
                items: {
                  anyOf: [
                    { type: 'string', description: 'Deep branch description' },
                    { type: 'number' },
                  ],
                },
              },
            },
          }
        : {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            title: `Tool${index}Input`,
            description: `Root schema description for tool ${index}`,
            type: 'object',
            additionalProperties: false,
            required: ['path'],
            examples: [{ path: 'README.md', mode: 'read' }],
            properties: {
              path: {
                type: 'string',
                title: 'PathTitle',
                description: `Target file path for tool ${index}. ${'Detailed parameter guidance. '.repeat(6)}`,
              },
              mode: {
                type: 'string',
                enum: ['read', 'inspect'],
                description: `Mode selector for tool ${index}. ${'Mode guidance. '.repeat(4)}`,
              },
            },
          },
    }))
    const rawToolsBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8')
    expect(rawToolsBytes).toBeGreaterThanOrEqual(65_000)

    options.tools = tools
    const prompt = buildPrompt(options, 184_320, 'Antigravity')
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      constraints: {
        tools: {
          available: Array<{
            name: string
            description?: string
            parameters: Record<string, unknown>
          }>
        }
      }
    }

    const available = payload.constraints.tools.available
    const compactedToolsBytes = Buffer.byteLength(JSON.stringify(available), 'utf8')
    expect(available).toHaveLength(99)
    expect(compactedToolsBytes).toBeLessThan(35_000)
    expect(compactedToolsBytes).toBeLessThan(Math.floor(rawToolsBytes * 0.45))

    const sample = available[0]!
    expect(sample.name).toBe('dsh_tool_00')
    expect(sample.description?.length).toBeLessThanOrEqual(80)
    expect(sample.parameters).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['action', 'target'],
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'list', 'inspect'],
        },
        target: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: { type: 'string' },
            title: { type: 'string' },
          },
        },
        tags: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
            ],
          },
        },
      },
    })

    const envelope = JSON.stringify({
      protocol: 'dsh-tool-calls/v1',
      calls: [{
        name: 'dsh_tool_98',
        arguments: { path: 'src/prompt.ts', mode: 'read' },
      }],
    })
    expect(parseDelegatedToolCalls(envelope, tools)).toEqual([{
      name: 'dsh_tool_98',
      arguments: '{"path":"src/prompt.ts","mode":"read"}',
    }])
  })

  it('keeps concise top-level and parameter descriptions on small tool catalogs while stripping non-structural metadata', () => {
    const options = request()
    options.tools = [{
      name: 'lookup',
      description: 'Lookup a workspace symbol by name and optional scope.',
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'LookupInput',
        description: 'Duplicate root schema description',
        type: 'object',
        required: ['query'],
        examples: [{ query: 'buildPrompt' }],
        properties: {
          query: {
            type: 'string',
            title: 'QueryTitle',
            description: 'Symbol query string.',
          },
          nested: {
            type: 'object',
            properties: {
              filter: {
                type: 'string',
                description: 'Deep nested description omitted even on small catalogs.',
              },
            },
          },
        },
      },
    }]

    const prompt = buildPrompt(options, 100_000, 'Antigravity')
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      constraints: { tools: { available: Array<Record<string, unknown>> } }
    }
    expect(payload.constraints.tools.available).toEqual([{
      name: 'lookup',
      description: 'Lookup a workspace symbol by name and optional scope.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'Symbol query string.',
          },
          nested: {
            type: 'object',
            properties: {
              filter: { type: 'string' },
            },
          },
        },
      },
    }])
  })

  it('bounds earlier tool outputs under 184_320 bytes while preserving the latest trailing tool-result batch verbatim', () => {
    const options = request()
    options.system = 'S'.repeat(6_000)
    options.tools = Array.from({ length: 99 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool ${index} performs action ${index}. ${'Extra description text. '.repeat(8)}`,
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Workspace path argument '.repeat(5) },
          mode: { type: 'string', enum: ['full', 'slice'], description: 'Read mode '.repeat(5) },
        },
      },
    }))

    const skillCatalog = createMessage({
      role: 'user',
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        update: true,
        entries: [{ name: 'dsh-doc', description: 'Docs' }],
      } as never,
      content: [{ type: 'text', text: `<available_skills>${'K'.repeat(41_000)}</available_skills>` }],
    })
    const olderCallA = 'call-old-a' as never
    const olderCallB = 'call-old-b' as never
    const olderCallC = 'call-old-c' as never
    const latestCall1 = 'call-latest-1' as never
    const latestCall2 = 'call-latest-2' as never
    const oldOutputA = `${'OLD_A_中文😀'.repeat(2_000)}_END_A`
    const oldOutputB = `${'OLD_B_'.repeat(6_500)}_END_B`
    const oldOutputC = `${'OLD_C_'.repeat(6_500)}_END_C`
    const latestOutput1 = `LATEST_BATCH_1_${'L1'.repeat(12_000)}_TAIL1`
    const latestOutput2 = `LATEST_BATCH_2_${'L2'.repeat(10_000)}_TAIL2`
    const totalToolBytes = Buffer.byteLength(
      oldOutputA + oldOutputB + oldOutputC + latestOutput1 + latestOutput2,
      'utf8',
    )
    expect(totalToolBytes).toBeGreaterThan(150_000)

    options.messages = [
      skillCatalog,
      createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect files' }] }),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'agy-agent', model: 'gemini-4-hydrogen' },
        content: [
          { type: 'tool-call', id: olderCallA, name: 'tool_0', arguments: '{"path":"a.ts"}' },
          { type: 'tool-call', id: olderCallB, name: 'tool_0', arguments: '{"path":"b.ts"}' },
        ],
      }),
      createMessage({
        role: 'tool',
        source: { kind: 'tool', callId: olderCallA },
        toolCallId: olderCallA,
        content: [{ type: 'text', text: oldOutputA }],
      }),
      createMessage({
        role: 'tool',
        source: { kind: 'tool', callId: olderCallB },
        toolCallId: olderCallB,
        content: [{ type: 'text', text: oldOutputB }],
      }),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'agy-agent', model: 'gemini-4-hydrogen' },
        content: [{ type: 'tool-call', id: olderCallC, name: 'tool_0', arguments: '{"path":"c.ts"}' }],
      }),
      createMessage({
        role: 'tool',
        source: { kind: 'tool', callId: olderCallC },
        toolCallId: olderCallC,
        content: [{ type: 'text', text: oldOutputC }],
      }),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'agy-agent', model: 'gemini-4-hydrogen' },
        content: [
          { type: 'tool-call', id: latestCall1, name: 'tool_0', arguments: '{"path":"latest1.ts"}' },
          { type: 'tool-call', id: latestCall2, name: 'tool_0', arguments: '{"path":"latest2.ts"}' },
        ],
      }),
      createMessage({
        role: 'tool',
        source: { kind: 'tool', callId: latestCall1 },
        toolCallId: latestCall1,
        content: [{ type: 'text', text: latestOutput1 }],
      }),
      createMessage({
        role: 'tool',
        source: { kind: 'tool', callId: latestCall2 },
        toolCallId: latestCall2,
        content: [{ type: 'text', text: latestOutput2 }],
      }),
      createMessage({
        role: 'user',
        source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'cwd', text: '/workspace' }] } as never,
        content: [{ type: 'text', text: '<system-reminder>cwd=/workspace</system-reminder>' }],
      }),
    ]

    const prompt = buildPrompt(options, 184_320, 'Antigravity')
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(184_320)
    expect(prompt).not.toMatch(/[\ud800-\udfff]/u)

    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
      conversation: Array<{
        role: string
        content: Array<{ type: string; toolCallId?: string; content?: Array<{ type: string; text?: string }> }>
      }>
    }
    const toolMessages = payload.conversation.filter(message => message.role === 'tool')
    expect(toolMessages).toHaveLength(5)

    for (const earlier of toolMessages.slice(0, 3)) {
      const text = earlier.content[0]?.content?.[0]?.text ?? ''
      expect(text).toContain('…[earlier tool output truncated to fit local ACP prompt byte limit; re-read specific line range if needed]')
    }
    expect(toolMessages[0]!.content[0]?.content?.[0]?.text).not.toContain('_END_A')
    expect(toolMessages[3]!.content[0]?.content?.[0]?.text).toBe(latestOutput1)
    expect(toolMessages[4]!.content[0]?.content?.[0]?.text).toBe(latestOutput2)
  })

  it('bounds already-answered historical tool output on later turns but fails closed with prompt-limit when trailing batch or single message is irreducible', () => {
    const answeredCall = 'call-answered' as never
    const answeredOptions = request()
    answeredOptions.messages = [
      createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Read file' }] }),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'agy-agent', model: 'default' },
        content: [{ type: 'tool-call', id: answeredCall, name: 'read', arguments: '{}' }],
      }),
      createMessage({
        role: 'tool',
        source: { kind: 'tool', callId: answeredCall },
        toolCallId: answeredCall,
        content: [{ type: 'text', text: 'A'.repeat(25_000) }],
      }),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'agy-agent', model: 'default' },
        content: [{ type: 'text', text: 'Summarized the file.' }],
      }),
      createMessage({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Follow-up question.' }],
      }),
    ]
    const boundedAnsweredPrompt = buildPrompt(answeredOptions, 10_000, 'Antigravity')
    expect(Buffer.byteLength(boundedAnsweredPrompt, 'utf8')).toBeLessThanOrEqual(10_000)
    expect(boundedAnsweredPrompt).toContain('…[earlier tool output truncated to fit local ACP prompt byte limit; re-read specific line range if needed]')

    const trailingOnlyCall = 'call-oversized-trailing' as never
    const oversizedTrailing = request()
    oversizedTrailing.messages = [
      createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Read huge file' }] }),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'agy-agent', model: 'default' },
        content: [{ type: 'tool-call', id: trailingOnlyCall, name: 'read', arguments: '{}' }],
      }),
      createMessage({
        role: 'tool',
        source: { kind: 'tool', callId: trailingOnlyCall },
        toolCallId: trailingOnlyCall,
        content: [{ type: 'text', text: 'Z'.repeat(190_000) }],
      }),
    ]
    let trailingError: unknown
    try {
      buildPrompt(oversizedTrailing, 184_320, 'Antigravity')
    } catch (error) {
      trailingError = error
    }
    expect(trailingError).toBeInstanceOf(Error)
    expect((trailingError as Error).cause).toBe('prompt-limit')

    const oversizedUser = request()
    oversizedUser.messages = [
      createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'U'.repeat(190_000) }] }),
    ]
    let userError: unknown
    try {
      buildPrompt(oversizedUser, 184_320, 'Antigravity')
    } catch (error) {
      userError = error
    }
    expect(userError).toBeInstanceOf(Error)
    expect((userError as Error).cause).toBe('prompt-limit')
  })
})
