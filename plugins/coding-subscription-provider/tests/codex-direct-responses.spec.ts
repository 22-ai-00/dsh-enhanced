import {
  BlockAssembler,
  CallId,
  createMessage,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { apply as applyLlmInvariant } from '@deepseek-ai/dsh-llm/invariant'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  runCodexDirectResponses,
  type CodexDirectRequestRouting,
  type CodexDirectResponsesDependencies,
  type CodexResponsesRequester,
} from '../src/codex-direct-responses.ts'

function request(messages: GenerateOptions['messages'], overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'codex-subscription',
    model: 'gpt-5.6-sol',
    system: 'Keep it short.',
    messages,
    ...overrides,
  }
}

function user(text: string) {
  return createMessage({
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

function completedResponse(output: unknown[] = [{
  type: 'message', id: 'msg-default', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'ok', annotations: [] }],
}], usage: Record<string, unknown> = {
  input_tokens: 1,
  output_tokens: 1,
  total_tokens: 2,
}): Record<string, unknown> {
  return {
    id: 'resp-test',
    status: 'completed',
    output,
    usage,
  }
}

function sse(
  events: Array<Record<string, unknown> | '[DONE]'>,
  options: { splitAt?: number[]; lineEnding?: '\n' | '\r\n' } = {},
): Response {
  const ending = options.lineEnding ?? '\n'
  const source = events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}${ending}${ending}`).join('')
  const bytes = new TextEncoder().encode(source)
  const splitAt = [...(options.splitAt ?? [])].filter(value => value > 0 && value < bytes.byteLength)
  const boundaries = [0, ...splitAt, bytes.byteLength]
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < boundaries.length - 1; index += 1) {
        controller.enqueue(bytes.slice(boundaries[index], boundaries[index + 1]))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

function responseWithoutContentType(body: string): Response {
  return new Response(new TextEncoder().encode(body), { status: 200 })
}

function directDependencies(
  response: Response,
  overrides: Partial<Omit<CodexDirectResponsesDependencies, 'request'>> = {},
): Omit<CodexDirectResponsesDependencies, 'request'> & { request: Mock<CodexResponsesRequester> } {
  return {
    request: vi.fn(async () => response),
    maxRequestBytes: 32 * 1024 * 1024,
    maxRequestImageBytes: 24 * 1024 * 1024,
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function captureDirectRequest(options: GenerateOptions): Promise<{
  readonly body: Record<string, unknown>
  readonly routing: CodexDirectRequestRouting
}> {
  const dependencies = directDependencies(sse([{
    type: 'response.completed', response: completedResponse(),
  }]))
  await collect(runCodexDirectResponses(options, dependencies))
  const call = dependencies.request.mock.calls[0]
  if (call === undefined) throw new Error('expected one direct request')
  return { body: JSON.parse(call[0]) as Record<string, unknown>, routing: call[2] }
}

async function installActualLlmInvariant(source: AsyncIterable<StreamChunk>): Promise<AsyncIterable<StreamChunk>> {
  type StreamHook = (
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>
  let streamHook: StreamHook | undefined
  const runtimeContext = {
    on(event: string, callback: unknown) {
      if (event === 'llm/stream') streamHook = callback as StreamHook
      return () => {}
    },
    get() {
      return undefined
    },
  }
  const invariantContext = {
    invariants: {
      register(_packageName: string, install: (context: unknown, fail: (message: string) => never) => void) {
        install(runtimeContext, (message): never => {
          throw new Error(message)
        })
        return () => {}
      },
    },
  }
  await applyLlmInvariant(invariantContext as never)
  if (streamHook === undefined) throw new Error('rc.8 LLM stream invariant was not installed')
  return streamHook(request([]), () => source)
}

describe('Codex private Responses transport', () => {
  it('streams the official private text shape and completes without DONE or HTTP EOF', async () => {
    const doneItem = {
      type: 'message',
      role: 'assistant',
      id: 'msg-private',
      content: [{ type: 'output_text', text: 'Hello private' }],
    }
    const events = [
      {
        type: 'response.output_item.added',
        item: { type: 'message', role: 'assistant', id: 'msg-private', content: [] },
      },
      { type: 'response.output_text.delta', delta: 'Hello ' },
      { type: 'response.output_text.delta', delta: 'private' },
      { type: 'response.output_item.done', item: doneItem },
      {
        type: 'response.completed',
        response: {
          id: 'resp-private',
          usage: {
            input_tokens: 3,
            input_tokens_details: null,
            output_tokens: 2,
            output_tokens_details: null,
            total_tokens: 5,
          },
          end_turn: true,
        },
      },
    ]
    const cancelled = vi.fn()
    const source = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(source))
      },
      cancel: cancelled,
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })

    const chunks = await Promise.race([
      collect(runCodexDirectResponses(request([user('hello')]), directDependencies(response))),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 100)),
    ])
    if (chunks === 'timed-out') throw new Error('private completed event waited for EOF')
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello ' },
      { type: 'text-delta', index: 0, text: 'private' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello private' } },
      {
        type: 'usage',
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          response: {
            kind: 'codex-private-responses',
            version: 3,
            provider: 'codex-subscription',
            model: 'gpt-5.6-sol',
            responseId: 'resp-private',
            output: [doneItem],
            blockOrder: ['text:@output:0:0'],
          },
        },
      },
    ])
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('treats nullable completed fields as absent and replays authoritative done items', async () => {
    const doneItem = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'nullable private terminal' }],
    }
    const dependencies = directDependencies(sse([
      { type: 'response.output_item.done', item: doneItem },
      {
        type: 'response.completed',
        response: { id: 'resp-nullable-terminal', output: null, end_turn: null },
      },
    ]))

    const chunks = await collect(runCodexDirectResponses(request([user('hello')]), dependencies))

    expect(chunks).toContainEqual({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: {
        response: expect.objectContaining({
          responseId: 'resp-nullable-terminal',
          output: [doneItem],
        }),
      },
    })
  })

  it('fails closed when a completed response explicitly requires a follow-up turn', async () => {
    const output = [{
      type: 'message', id: 'msg-needs-follow-up', role: 'assistant',
      content: [{ type: 'output_text', text: 'Partial answer' }],
    }]
    const dependencies = directDependencies(sse([{
      type: 'response.completed',
      response: { ...completedResponse(output), end_turn: false },
    }]))

    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('accepts the official private function-call done shape and preserves it exactly for replay', async () => {
    const doneItem = {
      type: 'function_call',
      call_id: 'call-private',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    }
    const dependencies = directDependencies(sse([
      { type: 'response.output_item.done', item: doneItem },
      {
        type: 'response.completed',
        response: { id: 'resp-function', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      },
    ]))

    const chunks = await collect(runCodexDirectResponses(request([user('read')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), dependencies))
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call', id: CallId('call-private'), name: 'read_file', arguments: '{"path":"README.md"}',
      },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: { response: { output: [doneItem], blockOrder: [expect.stringMatching(/^tool:/)] } },
    })
  })

  it('treats Grok completed.output=[] as a legacy placeholder when authoritative done items exist', async () => {
    const doneItem = {
      type: 'function_call', call_id: 'call-grok-empty-output', name: 'read_file', arguments: '{}',
    }
    const dependencies = directDependencies(sse([
      { type: 'response.output_item.done', item: doneItem },
      { type: 'response.completed', response: { id: 'resp-grok-empty-output', output: [] } },
    ]))

    const chunks = await collect(runCodexDirectResponses(request([user('read')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), dependencies))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: { response: { output: [doneItem] } },
    })
  })

  it('binds a lean continuation to a rich added item with an explicit output index', async () => {
    const doneItem = {
      type: 'message', id: 'msg-rich-lean', role: 'assistant',
      content: [{ type: 'output_text', text: 'mixed dialect' }],
    }
    const dependencies = directDependencies(sse([
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'message', id: 'msg-rich-lean', role: 'assistant', status: 'in_progress', content: [] },
      },
      { type: 'response.output_text.delta', delta: 'mixed ' },
      { type: 'response.output_text.delta', delta: 'dialect' },
      { type: 'response.output_item.done', item: doneItem },
      { type: 'response.completed', response: { id: 'resp-rich-lean' } },
    ]))

    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .resolves.toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'mixed dialect' } })
  })

  it.each([
    {
      name: 'text',
      added: (outputIndex: number, prefix: string) => ({
        type: 'response.output_item.added', output_index: outputIndex,
        item: {
          type: 'message', id: `msg-ambiguous-${outputIndex}`, role: 'assistant', status: 'in_progress',
          content: [{ type: 'output_text', text: prefix }],
        },
      }),
      delta: { type: 'response.output_text.delta', delta: 'ambiguous' },
      done: (outputIndex: number, text: string) => ({
        type: 'response.output_item.done', output_index: outputIndex,
        item: {
          type: 'message', id: `msg-ambiguous-${outputIndex}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text }],
        },
      }),
    },
    {
      name: 'reasoning',
      added: (outputIndex: number, prefix: string) => ({
        type: 'response.output_item.added', output_index: outputIndex,
        item: {
          type: 'reasoning', id: `rs-ambiguous-${outputIndex}`, status: 'in_progress',
          summary: [{ type: 'summary_text', text: prefix }],
        },
      }),
      delta: { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'ambiguous' },
      done: (outputIndex: number, text: string) => ({
        type: 'response.output_item.done', output_index: outputIndex,
        item: {
          type: 'reasoning', id: `rs-ambiguous-${outputIndex}`, status: 'completed',
          summary: [{ type: 'summary_text', text }],
        },
      }),
    },
  ])('rejects an identity-less lean $name delta with two compatible rich open items', async testCase => {
    const dependencies = directDependencies(sse([
      testCase.added(0, 'first '),
      testCase.added(1, 'second'),
      testCase.delta,
      testCase.done(0, 'first ambiguous'),
      testCase.done(1, 'second'),
      { type: 'response.completed', response: { id: `resp-ambiguous-${testCase.name}` } },
    ]))

    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('streams private reasoning summary deltas through the active reasoning item', async () => {
    const doneItem = {
      type: 'reasoning', id: 'rs-private', encrypted_content: 'cipher',
      summary: [{ type: 'summary_text', text: 'Checking privately' }],
    }
    const dependencies = directDependencies(sse([
      {
        type: 'response.output_item.added',
        item: { type: 'reasoning', id: 'rs-private', summary: [] },
      },
      { type: 'response.reasoning_summary_part.added', summary_index: 0 },
      { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'Checking ' },
      { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'privately' },
      { type: 'response.reasoning_summary_text.done', item_id: 'rs-private', summary_index: 0, text: 'Checking privately' },
      { type: 'response.output_item.done', item: doneItem },
      { type: 'response.completed', response: { id: 'resp-reasoning' } },
    ]))

    const chunks = await collect(runCodexDirectResponses(request([user('think')]), dependencies))
    expect(chunks.slice(0, 4)).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Checking ' },
      { type: 'reasoning-delta', index: 0, text: 'privately' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Checking privately' } },
    ])
  })

  it('ignores official private metadata and no-op event shapes', async () => {
    const doneItem = {
      type: 'message', role: 'assistant', id: 'msg-noops',
      content: [{ type: 'output_text', text: 'ok' }],
    }
    const noops = [
      { type: 'codex.response.metadata', metadata: { opaque: true } },
      { type: 'response.metadata', metadata: { opaque: true } },
      { type: 'responsesapi.websocket_timing', timing: { opaque: true } },
      { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
      { type: 'response.content_part.done', part: { type: 'output_text', text: 'ok' } },
      { type: 'response.function_call_arguments.delta', delta: 'ignored' },
      { type: 'response.function_call_arguments.done', arguments: 'ignored' },
      { type: 'response.custom_tool_call_input.done', input: 'ignored' },
      { type: 'response.output_text.done', text: 'ignored' },
      { type: 'response.output_text.annotation.added', annotation: { opaque: true } },
      { type: 'response.reasoning_summary_part.done', summary_index: 0 },
      { type: 'response.in_progress', response: { id: 'resp-noops' } },
    ]
    const dependencies = directDependencies(sse([
      ...noops,
      { type: 'response.output_item.done', item: doneItem },
      { type: 'response.completed', response: { id: 'resp-noops' } },
    ]))

    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .resolves.toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } })
  })

  it('aggregates the private delta-only shape into durable native replay', async () => {
    const dependencies = directDependencies(sse([
      { type: 'response.output_text.delta', delta: 'delta ' },
      { type: 'response.output_text.delta', delta: 'only' },
      { type: 'response.completed', response: { id: 'resp-delta-only' } },
    ]))

    const chunks = await collect(runCodexDirectResponses(request([user('hello')]), dependencies))
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0, block: { type: 'text', text: 'delta only' },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      replayState: {
        response: {
          output: [{
            type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: 'delta only' }],
          }],
          blockOrder: ['text:@output:0:0'],
        },
      },
    })
  })

  it('binds Grok delta-only text to one empty terminal placeholder and replays the synthesized raw item', async () => {
    const synthesized = {
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'Grok compatible' }],
    }
    const firstDependencies = directDependencies(sse([
      { type: 'response.output_text.delta', delta: 'Grok ' },
      { type: 'response.output_text.delta', delta: 'compatible' },
      {
        type: 'response.completed',
        response: {
          id: 'resp-grok-placeholder',
          output: [{ type: 'message', role: 'assistant', content: [] }],
        },
      },
    ]))
    const firstChunks = await collect(runCodexDirectResponses(request([user('hello')]), firstDependencies))
    const finish = firstChunks.at(-1)
    expect(finish).toMatchObject({
      type: 'finish',
      replayState: {
        response: {
          output: [synthesized],
          blockOrder: ['text:@output:0:0'],
        },
      },
    })
    if (finish?.type !== 'finish' || finish.replayState === undefined) throw new Error('missing Grok replay state')
    const assistant = createMessage({
      role: 'assistant',
      source: {
        kind: 'model', provider: 'codex-subscription', model: 'gpt-5.6-sol',
        replayState: finish.replayState,
      },
      content: [{ type: 'text', text: 'Grok compatible' }],
    })
    const secondDependencies = directDependencies(sse([{
      type: 'response.completed', response: completedResponse(),
    }]))
    await collect(runCodexDirectResponses(request([assistant]), secondDependencies))
    expect(JSON.parse(secondDependencies.request.mock.calls[0]![0] as string).input).toEqual([{
      ...synthesized,
      status: 'completed',
    }])
  })

  it('lets an authoritative completed event supersede a preliminary failed event', async () => {
    const output = [{
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'recovered' }],
    }]
    const dependencies = directDependencies(sse([
      { type: 'response.failed', response: { id: 'resp-recovered', error: { message: 'provider secret' } } },
      { type: 'response.metadata', metadata: { type: 'safety_buffering', retry_model: 'safe' } },
      { type: 'response.completed', response: { id: 'resp-recovered', output } },
    ]))

    const chunks = await collect(runCodexDirectResponses(request([user('hello')]), dependencies))
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' },
    })
    expect(JSON.stringify(chunks)).not.toContain('provider secret')
  })

  it('allows every exact private no-op between a preliminary outcome and authoritative completion', async () => {
    const noops = [
      { type: 'response.queued', response: { id: 'resp-retry' } },
      { type: 'codex.response.metadata', metadata: {} },
      { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
      { type: 'response.content_part.done', part: { type: 'output_text', text: '' } },
      { type: 'response.custom_tool_call_input.done', input: '' },
      { type: 'response.function_call_arguments.delta', delta: '' },
      { type: 'response.function_call_arguments.done', arguments: '' },
      { type: 'response.in_progress', response: { id: 'resp-retry' } },
      { type: 'response.metadata', metadata: {} },
      { type: 'response.output_text.done', text: '' },
      { type: 'response.output_text.annotation.added', annotation: { opaque: true } },
      { type: 'response.reasoning_summary_part.done', summary_index: 0 },
      { type: 'responsesapi.websocket_timing', timing: {} },
    ]
    for (const preliminaryType of ['response.failed', 'response.incomplete'] as const) {
      for (const noop of noops) {
        const dependencies = directDependencies(sse([
          { type: preliminaryType, response: { id: 'resp-retry' } },
          noop,
          { type: 'response.completed', response: completedResponse() },
        ]))
        await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
          .resolves.toContainEqual({ type: 'finish', reason: { kind: 'stop' }, replayState: expect.anything() })
      }
    }
  })

  it('keeps mixed private items in ordinal order and replays their raw shapes on turn two', async () => {
    const output = [
      {
        type: 'reasoning', encrypted_content: 'cipher',
        summary: [{ type: 'summary_text', text: 'checked' }],
      },
      {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'using tool' }],
      },
      { type: 'function_call', call_id: 'call-mixed', name: 'read_file', arguments: '{}' },
    ]
    const firstDependencies = directDependencies(sse([
      { type: 'response.output_item.added', item: { type: 'reasoning', summary: [] } },
      { type: 'response.reasoning_summary_part.added', summary_index: 0 },
      { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'checked' },
      { type: 'response.output_item.done', item: output[0] },
      { type: 'response.output_item.added', item: { type: 'message', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', delta: 'using tool' },
      { type: 'response.output_item.done', item: output[1] },
      { type: 'response.output_item.done', item: output[2] },
      { type: 'response.completed', response: { id: 'resp-mixed' } },
    ]))
    const options = request([user('work')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    })
    const chunks = await collect(runCodexDirectResponses(options, firstDependencies))
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({
      type: 'finish',
      replayState: { response: { version: 3, output, blockOrder: [
        'reasoning:@output:0:0', 'text:@output:1:0', 'tool:@output:2',
      ] } },
    })
    const assembler = new BlockAssembler()
    chunks.forEach(chunk => assembler.push(chunk))
    if (finish?.type !== 'finish' || finish.replayState === undefined) throw new Error('missing replay state')
    const assistant = createMessage({
      role: 'assistant',
      source: {
        kind: 'model', provider: 'codex-subscription', model: 'gpt-5.6-sol',
        replayState: finish.replayState,
      },
      content: assembler.blocks(),
    })
    const secondDependencies = directDependencies(sse([{
      type: 'response.completed', response: completedResponse(),
    }]))
    await collect(runCodexDirectResponses(request([assistant]), secondDependencies))
    expect(JSON.parse(secondDependencies.request.mock.calls[0]![0] as string).input).toEqual([
      output[0],
      { ...output[1], status: 'completed' },
      output[2],
    ])
  })

  it('fails closed on private active-item overlap and optional identity disagreements', async () => {
    const cases = [
      [
        { type: 'response.output_item.added', item: { type: 'message', role: 'assistant', content: [] } },
        { type: 'response.output_item.added', item: { type: 'reasoning', summary: [] } },
      ],
      [
        { type: 'response.output_item.added', item: { type: 'message', id: 'msg-a', role: 'assistant', content: [] } },
        {
          type: 'response.output_item.done',
          item: { type: 'message', id: 'msg-b', role: 'assistant', content: [] },
        },
      ],
      [
        { type: 'response.created', response: { id: 'resp-a' } },
        { type: 'response.completed', response: { id: 'resp-b', output: [] } },
      ],
    ]
    for (const events of cases) {
      await expect(collect(runCodexDirectResponses(
        request([user('hello')]),
        directDependencies(sse(events)),
      ))).rejects.toMatchObject({ cause: 'protocol' })
    }
  })

  it.each([
    ['temperature', { temperature: 0.2 }],
    ['max tokens', { maxTokens: 321 }],
  ] as const)('rejects unsupported private request %s before network I/O', async (_label, override) => {
    const dependencies = directDependencies(sse([]))
    await expect(collect(runCodexDirectResponses(request([user('hello')], override), dependencies)))
      .rejects.toMatchObject({ cause: 'protocol' })
    expect(dependencies.request).not.toHaveBeenCalled()
  })

  it('emits the private request defaults even when no tools or reasoning are configured', async () => {
    const dependencies = directDependencies(sse([{
      type: 'response.completed', response: completedResponse(),
    }]))
    await collect(runCodexDirectResponses(request([user('hello')]), dependencies))
    const [serialized, , routing] = dependencies.request.mock.calls[0]!
    const body = JSON.parse(serialized) as Record<string, unknown>
    expect(body).toMatchObject({
      tool_choice: 'auto', parallel_tool_calls: true, reasoning: null,
      prompt_cache_key: routing.promptCacheKey,
    })
    expect(routing.sessionId).toMatch(/^dshc_[0-9a-f]{32}$/u)
    expect(routing.threadId).toMatch(/^dshth_[0-9a-f]{32}$/u)
    expect(routing.promptCacheKey).toMatch(/^pck_[0-9a-f]{24}$/u)
    expect(routing.promptCacheKey.length).toBeLessThanOrEqual(64)
    expect(body).not.toHaveProperty('prompt_cache_retention')
    expect(body).not.toHaveProperty('prompt_cache_options')
  })

  it('keeps pseudonymous routing stable across turns without placing the Host session id on the wire', async () => {
    const rawSessionId = 'delivery-private-user-and-conversation-g7' as NonNullable<GenerateOptions['sessionId']>
    const tools = [{
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }]
    const first = await captureDirectRequest(request([user('first turn')], {
      sessionId: rawSessionId,
      tools,
    }))
    const second = await captureDirectRequest(request([user('first turn'), user('second turn')], {
      sessionId: rawSessionId,
      tools,
    }))

    expect(second.routing).toEqual(first.routing)
    expect(second.body.prompt_cache_key).toBe(first.body.prompt_cache_key)
    expect(first.routing).toEqual({
      sessionId: 'dshc_743037ea2fbb87c80d4be6676b1e09c6',
      threadId: 'dshth_7ddcf9fb51c8ac2a4de6f28cf4826914',
      promptCacheKey: 'pck_fc12a1e4f3e2da0191777fe6',
    })
    expect(JSON.stringify([first.body, first.routing, second.body, second.routing]))
      .not.toContain(rawSessionId)
  })

  it('canonicalizes tool ordering and object keys when deriving the prompt cache key', async () => {
    const sessionId = 'session-canonical-tools' as NonNullable<GenerateOptions['sessionId']>
    const first = await captureDirectRequest(request([user('hello')], {
      sessionId,
      tools: [
        {
          name: 'zeta',
          description: 'Z',
          parameters: {
            type: 'object',
            properties: { beta: { type: 'number' }, alpha: { type: 'string' } },
            required: ['alpha'],
          },
        },
        { name: 'alpha', description: 'A', parameters: { type: 'object' } },
      ],
    }))
    const reordered = await captureDirectRequest(request([user('hello again')], {
      sessionId,
      tools: [
        { name: 'alpha', description: 'A', parameters: { type: 'object' } },
        {
          name: 'zeta',
          description: 'Z',
          parameters: {
            properties: { alpha: { type: 'string' }, beta: { type: 'number' } },
            required: ['alpha'],
            type: 'object',
          },
        },
      ],
    }))

    expect(reordered.routing.promptCacheKey).toBe(first.routing.promptCacheKey)
    expect(reordered.routing.sessionId).toBe(first.routing.sessionId)
    expect(reordered.routing.threadId).toBe(first.routing.threadId)
  })

  it('isolates conversations and rotates only the cache identity when the static prefix changes', async () => {
    const sessionA = 'session-a' as NonNullable<GenerateOptions['sessionId']>
    const sessionB = 'session-b' as NonNullable<GenerateOptions['sessionId']>
    const tools = [{ name: 'inspect', description: 'Inspect', parameters: { type: 'object' } }]
    const base = await captureDirectRequest(request([user('hello')], { sessionId: sessionA, tools }))
    const otherConversation = await captureDirectRequest(request([user('hello')], {
      sessionId: sessionB,
      tools,
    }))
    const changedInstructions = await captureDirectRequest(request([user('hello')], {
      sessionId: sessionA,
      system: 'Use a different static prefix.',
      tools,
    }))
    const changedTools = await captureDirectRequest(request([user('hello')], {
      sessionId: sessionA,
      tools: [{ name: 'inspect', description: 'Inspect safely', parameters: { type: 'object' } }],
    }))

    expect(otherConversation.routing.sessionId).not.toBe(base.routing.sessionId)
    expect(otherConversation.routing.threadId).not.toBe(base.routing.threadId)
    expect(otherConversation.routing.promptCacheKey).not.toBe(base.routing.promptCacheKey)
    expect(changedInstructions.routing.sessionId).toBe(base.routing.sessionId)
    expect(changedInstructions.routing.threadId).toBe(base.routing.threadId)
    expect(changedInstructions.routing.promptCacheKey).not.toBe(base.routing.promptCacheKey)
    expect(changedTools.routing.promptCacheKey).not.toBe(base.routing.promptCacheKey)
  })

  it('maps the catalog ultra reasoning effort to max on the private wire', async () => {
    const dependencies = directDependencies(sse([{
      type: 'response.completed', response: completedResponse(),
    }]))
    await collect(runCodexDirectResponses(request([user('hello')], {
      reasoningEffort: ReasoningEffortId('ultra'),
    }), dependencies))
    expect(JSON.parse(dependencies.request.mock.calls[0]![0] as string).reasoning).toEqual({
      effort: 'max', summary: 'auto',
    })
  })

  it('accepts a unique created event whose optional response id is absent', async () => {
    const dependencies = directDependencies(sse([
      { type: 'response.created', response: {} },
      { type: 'response.completed', response: completedResponse() },
    ]))
    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .resolves.toContainEqual({ type: 'finish', reason: { kind: 'stop' }, replayState: expect.anything() })
  })

  it('rejects an attachment read that omits its required reference before network I/O', async () => {
    const imageRef = {
      attachmentId: 'sha256:strict-ref', mediaType: 'image/png', bytes: 1,
      width: 1, height: 1, name: 'strict.png',
    } as never
    const message = createMessage({
      role: 'user', source: { kind: 'user' },
      content: [{ type: 'image', attachment: imageRef }],
    })
    const dependencies = directDependencies(sse([]), {
      attachments: { readImage: vi.fn(async () => ({ data: Uint8Array.from([0]) }) as never) },
    })
    await expect(collect(runCodexDirectResponses(request([message]), dependencies)))
      .rejects.toMatchObject({ cause: 'protocol' })
    expect(dependencies.request).not.toHaveBeenCalled()
  })

  it('serializes multimodal history, native tools, raw call ids, and supported generation controls', async () => {
    const imageRef = {
      attachmentId: 'sha256:image-1',
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
      name: 'pixel.png',
    } as never
    const callId = CallId('call-7')
    const messages: GenerateOptions['messages'] = [
      createMessage({
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'inspect' }, { type: 'image', attachment: imageRef }],
      }),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'codex-subscription', model: 'old-model' },
        content: [
          { type: 'text', text: 'I will read it.' },
          { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"README.md"' },
        ],
      }),
      createMessage({
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: 'contents' }],
          isError: false,
        }],
      }),
    ]
    const response = sse([
      { type: 'response.completed', response: completedResponse() },
      '[DONE]',
    ])
    const dependencies = directDependencies(response, {
      attachments: {
        readImage: vi.fn(async () => ({ ref: imageRef, data: Uint8Array.from([0, 1, 2, 3]) })),
      },
    })

    await collect(runCodexDirectResponses(request(messages, {
      reasoningEffort: ReasoningEffortId('high'),
      tools: [{
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
    }), dependencies))

    expect(dependencies.request).toHaveBeenCalledTimes(1)
    const [serialized, signal, routing] = dependencies.request.mock.calls[0]!
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(serialized)).toEqual({
      model: 'gpt-5.6-sol',
      instructions: 'Keep it short.',
      prompt_cache_key: routing.promptCacheKey,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'inspect' },
            { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AAECAw==' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will read it.' }],
        },
        { type: 'function_call', call_id: 'call-7', name: 'read_file', arguments: '{"path":"README.md"' },
        { type: 'function_call_output', call_id: 'call-7', output: 'contents' },
      ],
      tools: [{
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        strict: false,
      }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high', summary: 'auto' },
    })
  })

  it('serializes generic assistant fallback text as Responses output_text', async () => {
    const assistant = createMessage({
      role: 'assistant',
      source: { kind: 'model', provider: 'codex-subscription', model: 'another-model' },
      content: [{ type: 'text', text: 'A durable fallback answer' }],
    })
    const dependencies = directDependencies(sse([{
      type: 'response.completed', response: completedResponse(),
    }]))

    await collect(runCodexDirectResponses(request([assistant]), dependencies))

    expect(JSON.parse(dependencies.request.mock.calls[0]![0] as string).input).toEqual([{
      role: 'assistant',
      content: [{ type: 'output_text', text: 'A durable fallback answer' }],
    }])
  })

  it('maps matching long Host call ids to one deterministic wire-safe id without mutating Host messages', async () => {
    const originalCallId = 'host-call-' + 'x'.repeat(80)
    const hostCallId = CallId(originalCallId)
    const assistant = createMessage({
      role: 'assistant',
      source: { kind: 'model', provider: 'codex-subscription', model: 'another-model' },
      content: [{
        type: 'tool-call', id: hostCallId, name: 'read_file', arguments: '{"path":"README.md"}',
      }],
    })
    const toolResult = createMessage({
      role: 'user',
      source: { kind: 'tool', callId: hostCallId },
      content: [{
        type: 'tool-result', toolCallId: hostCallId, isError: false,
        content: [{ type: 'text', text: 'contents' }],
      }],
    })
    const dependencies = directDependencies(sse([{
      type: 'response.completed', response: completedResponse(),
    }]))

    await collect(runCodexDirectResponses(request([assistant, toolResult], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), dependencies))

    const input = JSON.parse(dependencies.request.mock.calls[0]![0] as string).input
    expect(input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_279df958e60d19230c7975b02f9c25be',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_279df958e60d19230c7975b02f9c25be',
        output: 'contents',
      },
    ])
    expect(input[0].call_id).toMatch(/^call_[0-9a-f]{32}$/)
    expect(assistant.content).toEqual([{
      type: 'tool-call', id: hostCallId, name: 'read_file', arguments: '{"path":"README.md"}',
    }])
    expect(toolResult.content).toEqual([{
      type: 'tool-result', toolCallId: hostCallId, isError: false,
      content: [{ type: 'text', text: 'contents' }],
    }])
  })

  it('neutralizes literal and Unicode-Cf-obfuscated Harmony tokens in every outbound text surface', async () => {
    const obscured = `<\u200d|\u200d${[...'message'].join('\u200d')}\u200d|\u200d>`
    const tainted = `literal <|start|>; obscured ${obscured}`
    const neutralized = 'literal <｜start｜>; obscured <｜message｜>'
    const callId = CallId('call-harmony')
    const messages: GenerateOptions['messages'] = [
      user(tainted),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'codex-subscription', model: 'another-model' },
        content: [
          { type: 'text', text: tainted },
          { type: 'tool-call', id: callId, name: 'inspect', arguments: JSON.stringify({ value: tainted }) },
        ],
      }),
      createMessage({
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result', toolCallId: callId, isError: false,
          content: [{ type: 'text', text: tainted }],
        }],
      }),
    ]
    const dependencies = directDependencies(sse([{
      type: 'response.completed', response: completedResponse(),
    }]))

    await collect(runCodexDirectResponses(request(messages, {
      system: tainted,
      tools: [{
        name: 'inspect',
        description: tainted,
        parameters: {
          type: 'object',
          description: tainted,
          properties: { value: { type: 'string', const: tainted } },
        },
      }],
    }), dependencies))

    const body = JSON.parse(dependencies.request.mock.calls[0]![0] as string)
    expect(body.instructions).toBe(neutralized)
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: neutralized }] },
      { role: 'assistant', content: [{ type: 'output_text', text: neutralized }] },
      {
        type: 'function_call', call_id: 'call-harmony', name: 'inspect',
        arguments: JSON.stringify({ value: neutralized }),
      },
      { type: 'function_call_output', call_id: 'call-harmony', output: neutralized },
    ])
    expect(body.tools).toEqual([{
      type: 'function',
      name: 'inspect',
      description: neutralized,
      parameters: {
        type: 'object',
        description: neutralized,
        properties: { value: { type: 'string', const: neutralized } },
      },
      strict: false,
    }])
    expect(JSON.stringify(body)).not.toContain('<|start|>')
    expect(JSON.stringify(body)).not.toContain('\u200d')
  })

  it('rejects Harmony tokens in tool-schema object keys before network I/O', async () => {
    const dependencies = directDependencies(sse([]))

    await expect(collect(runCodexDirectResponses(request([user('hello')], {
      tools: [{
        name: 'inspect',
        description: 'Inspect',
        parameters: {
          type: 'object',
          properties: { '<|start|>': { type: 'string' } },
        },
      }],
    }), dependencies))).rejects.toMatchObject({ cause: 'protocol' })
    expect(dependencies.request).not.toHaveBeenCalled()
  })

  it('encodes tool-result errors and empty results using only standard function output fields', async () => {
    const imageRef = {
      attachmentId: 'sha256:tool-image',
      mediaType: 'image/png',
      bytes: 2,
      width: 1,
      height: 1,
      name: 'tool.png',
    } as never
    const errorCallId = CallId('call-error')
    const emptyCallId = CallId('call-empty')
    const dependencies = directDependencies(sse([
      { type: 'response.completed', response: completedResponse() },
      '[DONE]',
    ]), {
      attachments: {
        readImage: vi.fn(async () => ({ ref: imageRef, data: Uint8Array.from([1, 2]) })),
      },
    })
    const messages: GenerateOptions['messages'] = [
      createMessage({
        role: 'user',
        source: { kind: 'tool', callId: errorCallId },
        content: [{
          type: 'tool-result',
          toolCallId: errorCallId,
          isError: true,
          content: [
            { type: 'text', text: 'failed' },
            { type: 'image', attachment: imageRef },
          ],
        }],
      }),
      createMessage({
        role: 'user',
        source: { kind: 'tool', callId: emptyCallId },
        content: [{
          type: 'tool-result',
          toolCallId: emptyCallId,
          isError: false,
          content: [],
        }],
      }),
    ]

    await collect(runCodexDirectResponses(request(messages), dependencies))

    expect(JSON.parse(dependencies.request.mock.calls[0]![0] as string).input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call-error',
        output: [
          { type: 'input_text', text: '[tool_error]' },
          { type: 'input_text', text: 'failed' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AQI=' },
        ],
      },
      { type: 'function_call_output', call_id: 'call-empty', output: '' },
    ])
  })

  it('replays matching native output, including encrypted reasoning, and falls back when durable content disagrees', async () => {
    const nativeOutput = [
      {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'encrypted-reasoning',
        summary: [],
      },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Answer', annotations: [] }],
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"a"}',
        status: 'completed',
      },
    ]
    const replayState = {
      response: {
        kind: 'codex-private-responses',
        version: 2,
        provider: 'codex-subscription',
        model: 'gpt-5.6-sol',
        responseId: 'resp-old',
        output: nativeOutput,
        blockOrder: ['text:msg_1:0', 'tool:fc_1'],
      },
    }
    const assistant = createMessage({
      role: 'assistant',
      source: { kind: 'model', provider: 'codex-subscription', model: 'gpt-5.6-sol', replayState },
      content: [
        { type: 'text', text: 'Answer' },
        { type: 'tool-call', id: CallId('call-1'), name: 'read_file', arguments: '{"path":"a"}' },
      ],
    })
    const terminal = sse([{ type: 'response.completed', response: completedResponse() }, '[DONE]'])
    const valid = directDependencies(terminal)

    await collect(runCodexDirectResponses(request([assistant]), valid))
    expect(JSON.parse(valid.request.mock.calls[0]![0] as string).input).toEqual([
      {
        type: 'reasoning',
        encrypted_content: 'encrypted-reasoning',
        summary: [],
      },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Answer' }],
      },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"a"}',
      },
    ])

    const mismatched = createMessage({
      role: 'assistant',
      source: { ...assistant.source, replayState },
      content: [{ type: 'text', text: 'Edited durable answer' }],
    })
    const fallback = directDependencies(sse([{ type: 'response.completed', response: completedResponse() }, '[DONE]']))
    await collect(runCodexDirectResponses(request([mismatched]), fallback))
    expect(JSON.parse(fallback.request.mock.calls[0]![0] as string).input).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Edited durable answer' }],
      },
    ])
  })

  it('removes ephemeral reasoning and function ids from replay while retaining safe message metadata', async () => {
    const nativeOutput = [
      {
        type: 'reasoning',
        id: 'rs-ephemeral',
        encrypted_content: 'encrypted-reasoning',
        summary: [{ type: 'summary_text', text: 'Reviewed' }],
      },
      {
        type: 'message',
        id: 'msg-short',
        role: 'assistant',
        status: 'incomplete',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Calling a tool', annotations: [{ opaque: true }] }],
      },
      {
        type: 'function_call',
        id: 'fc-ephemeral',
        call_id: 'call-clean-replay',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
        status: 'completed',
      },
    ]
    const assistant = createMessage({
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'codex-subscription',
        model: 'gpt-5.6-sol',
        replayState: {
          response: {
            kind: 'codex-private-responses',
            version: 3,
            provider: 'codex-subscription',
            model: 'gpt-5.6-sol',
            responseId: 'resp-clean-replay',
            output: nativeOutput,
            blockOrder: [
              'reasoning:@output:0:0',
              'text:@output:1:0',
              'tool:@output:2',
            ],
          },
        },
      },
      content: [
        { type: 'reasoning', text: 'Reviewed' },
        { type: 'text', text: 'Calling a tool' },
        {
          type: 'tool-call', id: CallId('call-clean-replay'), name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
      ],
    })
    const dependencies = directDependencies(sse([{
      type: 'response.completed', response: completedResponse(),
    }]))

    await collect(runCodexDirectResponses(request([assistant]), dependencies))

    expect(JSON.parse(dependencies.request.mock.calls[0]![0] as string).input).toEqual([
      {
        type: 'reasoning',
        encrypted_content: 'encrypted-reasoning',
        summary: [{ type: 'summary_text', text: 'Reviewed' }],
      },
      {
        type: 'message',
        id: 'msg-short',
        role: 'assistant',
        status: 'incomplete',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Calling a tool' }],
      },
      {
        type: 'function_call',
        call_id: 'call-clean-replay',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
    ])
  })

  it('appends an empty assistant item after reasoning-only replay', async () => {
    const nativeOutput = [{
      type: 'reasoning',
      id: 'rs-reasoning-only',
      encrypted_content: 'encrypted-reasoning',
      summary: [{ type: 'summary_text', text: 'Reasoned safely' }],
    }]
    const assistant = createMessage({
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'codex-subscription',
        model: 'gpt-5.6-sol',
        replayState: {
          response: {
            kind: 'codex-private-responses',
            version: 3,
            provider: 'codex-subscription',
            model: 'gpt-5.6-sol',
            responseId: 'resp-reasoning-only',
            output: nativeOutput,
            blockOrder: ['reasoning:@output:0:0'],
          },
        },
      },
      content: [{ type: 'reasoning', text: 'Reasoned safely' }],
    })
    const dependencies = directDependencies(sse([{
      type: 'response.completed', response: completedResponse(),
    }]))

    await collect(runCodexDirectResponses(request([assistant]), dependencies))

    expect(JSON.parse(dependencies.request.mock.calls[0]![0] as string).input).toEqual([
      {
        type: 'reasoning',
        encrypted_content: 'encrypted-reasoning',
        summary: [{ type: 'summary_text', text: 'Reasoned safely' }],
      },
      { role: 'assistant', content: '' },
    ])
  })

  it('accepts a durable default-model alias when replay identifies the resolved wire model', async () => {
    const nativeOutput = [{
      type: 'function_call',
      id: 'fc-native-item',
      call_id: 'call-native',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
      status: 'completed',
    }]
    const assistant = createMessage({
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'codex-subscription',
        model: 'default',
        replayState: {
          response: {
            kind: 'codex-private-responses',
            version: 2,
            provider: 'codex-subscription',
            model: 'gpt-5.6-sol',
            responseId: 'resp-old',
            output: nativeOutput,
            blockOrder: ['tool:fc-native-item'],
          },
        },
      },
      content: [{
        type: 'tool-call',
        id: CallId('call-native'),
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      }],
    })
    const dependencies = directDependencies(sse([
      { type: 'response.completed', response: completedResponse() },
      '[DONE]',
    ]))

    await collect(runCodexDirectResponses(request([assistant]), dependencies))

    expect(JSON.parse(dependencies.request.mock.calls[0]![0] as string).input).toEqual([{
      type: 'function_call',
      call_id: 'call-native',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    }])
  })

  it('streams split CRLF SSE into mixed text and tool blocks in first-seen order', async () => {
    const output = [
      {
        type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
      },
      {
        type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'read_file',
        arguments: '{"path":"README.md"}', status: 'completed',
      },
    ]
    const response = sse([
      { type: 'response.output_item.added', output_index: 0, item: { ...output[0], status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hel' },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'lo' },
      { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: 'Hello' },
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.output_item.added', output_index: 1, item: { ...output[1], status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '"README.md"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 1, arguments: '{"path":"README.md"}' },
      { type: 'response.output_item.done', output_index: 1, item: output[1] },
      {
        type: 'response.completed',
        response: completedResponse(output, {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 17,
        }),
      },
      '[DONE]',
    ], { lineEnding: '\r\n', splitAt: [1, 9, 37, 101, 503, 901] })
    const dependencies = directDependencies(response)

    const chunks = await collect(runCodexDirectResponses(request([user('hello')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    }), dependencies))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: CallId('call-1'), name: 'read_file', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 1, id: CallId('call-1'), argumentsDelta: '{"path":' },
      { type: 'tool-call-delta', index: 1, id: CallId('call-1'), argumentsDelta: '"README.md"}' },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: CallId('call-1'), name: 'read_file', arguments: '{"path":"README.md"}' },
      },
      {
        type: 'usage',
        usage: { inputTokens: 6, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 3 },
      },
      {
        type: 'finish',
        reason: { kind: 'tool-calls' },
        replayState: {
          response: {
            kind: 'codex-private-responses',
            version: 3,
            provider: 'codex-subscription',
            model: 'gpt-5.6-sol',
            responseId: 'resp-test',
            output,
            blockOrder: ['text:@output:0:0', 'tool:@output:1'],
          },
        },
      },
    ])
  })

  it('treats non-empty added text and reasoning parts as prefixes that remain open', async () => {
    const output = [
      {
        type: 'reasoning', id: 'rs-prefix', encrypted_content: 'cipher',
        summary: [{ type: 'summary_text', text: 'reasoning prefix' }],
      },
      {
        type: 'message', id: 'msg-prefix', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'text prefix', annotations: [] }],
      },
    ]
    const dependencies = directDependencies(sse([
      { type: 'response.output_item.added', output_index: 0, item: { ...output[0], summary: [] } },
      {
        type: 'response.reasoning_summary_part.added', item_id: 'rs-prefix', output_index: 0, summary_index: 0,
        part: { type: 'summary_text', text: 'reasoning ' },
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'rs-prefix', output_index: 0,
        summary_index: 0, delta: 'prefix',
      },
      {
        type: 'response.reasoning_summary_text.done', item_id: 'rs-prefix', output_index: 0,
        summary_index: 0, text: 'reasoning prefix',
      },
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      {
        type: 'response.output_item.added', output_index: 1,
        item: { ...output[1], status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added', item_id: 'msg-prefix', output_index: 1, content_index: 0,
        part: { type: 'output_text', text: 'text ', annotations: [] },
      },
      {
        type: 'response.output_text.delta', item_id: 'msg-prefix', output_index: 1,
        content_index: 0, delta: 'prefix',
      },
      {
        type: 'response.output_text.done', item_id: 'msg-prefix', output_index: 1,
        content_index: 0, text: 'text prefix',
      },
      { type: 'response.output_item.done', output_index: 1, item: output[1] },
      { type: 'response.completed', response: completedResponse(output) },
      '[DONE]',
    ]))

    const chunks = await collect(runCodexDirectResponses(request([user('hello')]), dependencies))
    const assembler = new BlockAssembler()
    chunks.forEach(chunk => assembler.push(chunk))
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'reasoning prefix' },
      { type: 'text', text: 'text prefix' },
    ])
  })

  it('synthesizes terminal-only reasoning summaries and refusals without exposing encrypted reasoning', async () => {
    const output = [
      {
        type: 'reasoning', id: 'rs_1', encrypted_content: 'do-not-render',
        summary: [{ type: 'summary_text', text: 'Safe summary' }],
      },
      {
        type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
        content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
      },
    ]
    const dependencies = directDependencies(sse([
      { type: 'response.completed', response: completedResponse(output) },
      '[DONE]',
    ]))

    const chunks = await collect(runCodexDirectResponses(request([user('hello')]), dependencies))

    expect(chunks.slice(0, 6)).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Safe summary' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Safe summary' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'I cannot help with that.' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'I cannot help with that.' } },
    ])
    expect(JSON.stringify(chunks.filter(chunk => chunk.type !== 'finish'))).not.toContain('do-not-render')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('validates but never exposes raw reasoning-text events', async () => {
    const reasoning = { type: 'reasoning', id: 'rs-raw', encrypted_content: 'cipher', summary: [] }
    const dependencies = directDependencies(sse([
      { type: 'response.output_item.added', output_index: 0, item: reasoning },
      {
        type: 'response.reasoning_text.delta', item_id: 'rs-raw', output_index: 0,
        content_index: 0, delta: 'private chain of thought',
      },
      {
        type: 'response.reasoning_text.done', item_id: 'rs-raw', output_index: 0,
        content_index: 0, text: 'private chain of thought',
      },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      {
        type: 'response.incomplete',
        response: {
          ...completedResponse([reasoning]), status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      },
      '[DONE]',
    ]))

    const chunks = await collect(runCodexDirectResponses(request([user('hello')]), dependencies))
    expect(JSON.stringify(chunks)).not.toContain('private chain of thought')

    const wrongIndex = directDependencies(sse([
      { type: 'response.output_item.added', output_index: 0, item: reasoning },
      {
        type: 'response.reasoning_text.delta', item_id: 'rs-raw', output_index: 1,
        content_index: 0, delta: 'private',
      },
    ]))
    await expect(collect(runCodexDirectResponses(request([user('hello')]), wrongIndex)))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('treats JSON object key order as irrelevant when terminal output confirms a completed item', async () => {
    const doneItem = {
      type: 'message',
      id: 'msg-order',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'same value', annotations: [] }],
    }
    const terminalItem = {
      content: [{ annotations: [], text: 'same value', type: 'output_text' }],
      status: 'completed',
      role: 'assistant',
      id: 'msg-order',
      type: 'message',
    }
    const dependencies = directDependencies(sse([
      { type: 'response.output_item.done', output_index: 0, item: doneItem },
      { type: 'response.completed', response: completedResponse([terminalItem]) },
      '[DONE]',
    ]))

    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .resolves.toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'same value' } })
  })

  it('rejects semantic events whose output index does not match the registered item', async () => {
    const dependencies = directDependencies(sse([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg-index', role: 'assistant', status: 'in_progress', content: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg-index',
        output_index: 1,
        content_index: 0,
        delta: 'wrong index',
      },
    ]))

    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('fails closed when new output items are first registered out of order', async () => {
    const dependencies = directDependencies(sse([{
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        type: 'function_call', id: 'fc-late', call_id: 'call-late', name: 'read_file',
        status: 'in_progress', arguments: '',
      },
    }]))

    await expect(collect(runCodexDirectResponses(request([user('hello')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), dependencies))).rejects.toMatchObject({ cause: 'protocol' })
  })

  it('fails closed when an earlier item registers its first visible part after a later item', async () => {
    const dependencies = directDependencies(sse([
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'message', id: 'msg-late', role: 'assistant', status: 'in_progress', content: [] },
      },
      {
        type: 'response.output_item.added', output_index: 1,
        item: {
          type: 'function_call', id: 'fc-first-visible', call_id: 'call-visible', name: 'read_file',
          status: 'in_progress', arguments: '',
        },
      },
      {
        type: 'response.content_part.added', item_id: 'msg-late', output_index: 0, content_index: 0,
        part: { type: 'output_text', text: 'late', annotations: [] },
      },
    ]))

    const error = await collect(runCodexDirectResponses(request([user('hello')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), dependencies)).then(() => undefined, value => value as Error)
    expect(error).toMatchObject({ cause: 'protocol' })
    expect(error?.message).toContain('visible content out of order')
  })

  it('rejects changed part types and terminal content not covered by streamed part indexes', async () => {
    const item = {
      type: 'message', id: 'msg-parts', role: 'assistant', status: 'completed',
      content: [
        { type: 'output_text', text: 'first', annotations: [] },
        { type: 'output_text', text: 'extra', annotations: [] },
      ],
    }
    const changedType = directDependencies(sse([
      {
        type: 'response.output_item.added', output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added', item_id: 'msg-parts', output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.content_part.added', item_id: 'msg-parts', output_index: 0, content_index: 0,
        part: { type: 'refusal', refusal: '' },
      },
    ]))
    await expect(collect(runCodexDirectResponses(request([user('hello')]), changedType)))
      .rejects.toMatchObject({ cause: 'protocol' })

    const extraTerminal = directDependencies(sse([
      {
        type: 'response.output_item.added', output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added', item_id: 'msg-parts', output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.done', item_id: 'msg-parts', output_index: 0, content_index: 0, text: 'first',
      },
      { type: 'response.completed', response: completedResponse([item]) },
      '[DONE]',
    ]))
    await expect(collect(runCodexDirectResponses(request([user('hello')]), extraTerminal)))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('rejects an extra terminal output item after streaming output-item events', async () => {
    const streamed = {
      type: 'message', id: 'msg-streamed', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'streamed', annotations: [] }],
    }
    const extra = {
      type: 'message', id: 'msg-extra', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'extra', annotations: [] }],
    }
    const dependencies = directDependencies(sse([
      { type: 'response.output_item.done', output_index: 0, item: streamed },
      { type: 'response.completed', response: completedResponse([streamed, extra]) },
      '[DONE]',
    ]))

    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('validates terminal message role and output item status before retaining replay', async () => {
    for (const output of [
      [{ type: 'message', id: 'msg-role', role: 'user', status: 'completed', content: [] }],
      [{ type: 'message', id: 'msg-status', role: 'assistant', status: 'mystery', content: [] }],
      [{ type: 'message', id: 'msg-open', role: 'assistant', status: 'in_progress', content: [] }],
    ]) {
      const dependencies = directDependencies(sse([
        { type: 'response.completed', response: completedResponse(output) },
        '[DONE]',
      ]))
      await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
        .rejects.toMatchObject({ cause: 'protocol' })
    }
  })

  it.each([
    {
      label: 'message',
      item: {
        type: 'message', role: 'assistant', status: 'incomplete',
        content: [{ type: 'output_text', text: 'partial' }],
      },
    },
    {
      label: 'reasoning',
      item: {
        type: 'reasoning', status: 'incomplete',
        summary: [{ type: 'summary_text', text: 'partial reasoning' }],
      },
    },
  ])('rejects explicit incomplete $label status under a completed response', async ({ item }) => {
    const dependencies = directDependencies(sse([{
      type: 'response.completed',
      response: { id: 'resp-rich-status-conflict', status: 'completed', output: [item] },
    }]))
    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('rejects terminal synthesis that would place earlier visible content after a streamed later item', async () => {
    const reasoning = {
      type: 'reasoning', id: 'rs-late-summary', encrypted_content: 'cipher',
      summary: [{ type: 'summary_text', text: 'late summary' }],
    }
    const tool = {
      type: 'function_call', id: 'fc-earlier-chunk', call_id: 'call-earlier-chunk', name: 'read_file',
      status: 'completed', arguments: '{}',
    }
    const dependencies = directDependencies(sse([
      { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [] } },
      {
        type: 'response.output_item.added', output_index: 1,
        item: { ...tool, status: 'in_progress', arguments: '' },
      },
      { type: 'response.completed', response: completedResponse([reasoning, tool]) },
      '[DONE]',
    ]))

    await expect(collect(runCodexDirectResponses(request([user('hello')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), dependencies))).rejects.toMatchObject({ cause: 'protocol' })
  })

  it.each(['incomplete', 'failed'] as const)(
    'never closes a %s function call into an executable tool block',
    async status => {
      const chunks: StreamChunk[] = []
      const item = {
        type: 'function_call', id: `fc-${status}`, call_id: `call-${status}`, name: 'read_file',
        status, arguments: '{}',
      }
      const dependencies = directDependencies(sse([
        {
          type: 'response.output_item.added', output_index: 0,
          item: { ...item, status: 'in_progress', arguments: '' },
        },
        {
          type: 'response.function_call_arguments.delta', item_id: item.id,
          output_index: 0, delta: '{}',
        },
        {
          type: 'response.function_call_arguments.done', item_id: item.id,
          output_index: 0, arguments: '{}',
        },
        { type: 'response.output_item.done', output_index: 0, item },
      ]))
      let error: unknown
      try {
        for await (const chunk of runCodexDirectResponses(request([user('hello')], {
          tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
        }), dependencies)) chunks.push(chunk)
      } catch (value) {
        error = value
      }

      expect(error).toMatchObject({ cause: 'protocol' })
      expect(chunks).not.toContainEqual(expect.objectContaining({
        type: 'block-end', block: expect.objectContaining({ type: 'tool-call' }),
      }))
    },
  )

  it('closes every partial max-token block before finish through the actual rc.8 LLM invariant', async () => {
    const cases: Array<{
      readonly name: string
      readonly events: Array<Record<string, unknown> | '[DONE]'>
      readonly overrides?: Partial<GenerateOptions>
    }> = [
      {
        name: 'tool',
        overrides: { tools: [{ name: 'read_file', description: 'Read', parameters: {} }] },
        events: [{
          type: 'response.incomplete',
          response: {
            id: 'resp-host-tool',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [{ type: 'function_call', call_id: 'call-host-partial', name: 'read_file', arguments: '{' }],
          },
        }, '[DONE]'],
      },
      {
        name: 'text',
        events: [
          { type: 'response.output_item.added', item: { type: 'message', role: 'assistant', content: [] } },
          { type: 'response.output_text.delta', delta: 'partial text' },
          {
            type: 'response.incomplete',
            response: { id: 'resp-host-text', incomplete_details: { reason: 'max_output_tokens' } },
          },
          '[DONE]',
        ],
      },
      {
        name: 'reasoning',
        events: [
          { type: 'response.output_item.added', item: { type: 'reasoning', summary: [] } },
          { type: 'response.reasoning_summary_part.added', summary_index: 0 },
          { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'partial reasoning' },
          {
            type: 'response.incomplete',
            response: { id: 'resp-host-reasoning', incomplete_details: { reason: 'max_output_tokens' } },
          },
          '[DONE]',
        ],
      },
    ]

    for (const testCase of cases) {
      const dependencies = directDependencies(sse(testCase.events))
      const source = runCodexDirectResponses(
        request([user(testCase.name)], testCase.overrides),
        dependencies,
      )
      const chunks = await collect(await installActualLlmInvariant(source))
      expect(chunks.at(-1), testCase.name).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
      expect(chunks.at(-1), testCase.name).not.toHaveProperty('replayState')
      if (testCase.name === 'tool') {
        const assembler = new BlockAssembler()
        chunks.forEach(chunk => assembler.push(chunk))
        expect(assembler.blocks()).toEqual([])
      }
    }
  })

  it('maps a max-token truncated function call by closing the protocol block without durable execution', async () => {
    const truncated = {
      type: 'function_call', id: 'fc-truncated', call_id: 'call-truncated', name: 'read_file',
      status: 'incomplete', arguments: '{',
    }
    const dependencies = directDependencies(sse([{
      type: 'response.incomplete',
      response: {
        ...completedResponse([truncated]),
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    }, '[DONE]']))

    const chunks = await collect(runCodexDirectResponses(request([user('hello')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), dependencies))
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'block-end', block: expect.objectContaining({ type: 'tool-call' }),
    }))
    const assembler = new BlockAssembler()
    chunks.forEach(chunk => assembler.push(chunk))
    expect(assembler.blocks()).toEqual([])
  })

  it('closes a lean status-less terminal-only function call for grammar but emits no replay', async () => {
    const truncated = {
      type: 'function_call', call_id: 'call-lean-truncated', name: 'read_file', arguments: '{',
    }
    const dependencies = directDependencies(sse([{
      type: 'response.incomplete',
      response: {
        id: 'resp-lean-truncated',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [truncated],
      },
    }, '[DONE]']))

    const chunks = await collect(runCodexDirectResponses(request([user('hello')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), dependencies))
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'block-end', block: expect.objectContaining({ type: 'tool-call' }),
    }))
    expect(chunks.at(-1)).not.toHaveProperty('replayState')
  })

  it.each(['max-tokens', 'failed'] as const)(
    'keeps a streamed done-only function candidate non-executable when the turn ends %s',
    async outcome => {
      const chunks: StreamChunk[] = []
      const item = {
        type: 'function_call', call_id: `call-done-${outcome}`, name: 'read_file', arguments: '{}',
      }
      const terminal = outcome === 'max-tokens'
        ? {
            type: 'response.incomplete',
            response: {
              id: 'resp-done-incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
            },
          }
        : { type: 'response.failed', response: { id: 'resp-done-failed' } }
      const dependencies = directDependencies(sse([
        { type: 'response.output_item.done', item },
        terminal,
        '[DONE]',
      ]))
      let error: unknown
      try {
        for await (const chunk of runCodexDirectResponses(request([user('hello')], {
          tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
        }), dependencies)) chunks.push(chunk)
      } catch (value) {
        error = value
      }
      if (outcome === 'max-tokens') {
        expect(error).toBeUndefined()
        expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
      } else {
        expect(error).toMatchObject({ cause: 'provider-failure' })
      }
      const toolEnd = expect.objectContaining({
        type: 'block-end', block: expect.objectContaining({ type: 'tool-call' }),
      })
      if (outcome === 'max-tokens') expect(chunks).toContainEqual(toolEnd)
      else expect(chunks).not.toContainEqual(toolEnd)
    },
  )

  it('maps max-output incompletion without replay and classifies filtered or failed provider outcomes', async () => {
    const partialOutput = [{
      type: 'message', id: 'msg_1', role: 'assistant', status: 'incomplete',
      content: [{ type: 'output_text', text: 'partial', annotations: [] }],
    }]
    const maxOutput = directDependencies(sse([{
      type: 'response.incomplete',
      response: {
        ...completedResponse(partialOutput),
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    }, '[DONE]']))

    const chunks = await collect(runCodexDirectResponses(request([user('hello')]), maxOutput))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })

    for (const [event, cause] of [
      [{
        type: 'response.incomplete',
        response: { ...completedResponse(), status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
      }, 'content-filter'],
      [{
        type: 'response.failed',
        response: {
          ...completedResponse(),
          status: 'failed',
          error: { code: 'server_error', message: 'provider secret body' },
        },
      }, 'provider-failure'],
    ] as const) {
      const dependencies = directDependencies(sse([event, '[DONE]']))
      const error = await collect(runCodexDirectResponses(request([user('hello')]), dependencies))
        .then(() => undefined, value => value as Error)
      expect(error).toMatchObject({ cause })
      expect(error?.message).not.toContain('provider secret body')
    }
  })

  it.each([
    ['EOF before a terminal event', [{ type: 'response.created', response: { id: 'resp-test' } }]],
    ['DONE before a terminal event', ['[DONE]']],
    [
      'a duplicate terminal event',
      [
        { type: 'response.completed', response: completedResponse() },
        { type: 'response.completed', response: completedResponse() },
      ],
    ],
    [
      'a semantic event after the terminal event',
      [
        { type: 'response.completed', response: completedResponse() },
        { type: 'response.output_text.delta', item_id: 'msg_1', content_index: 0, delta: 'late' },
      ],
    ],
    [
      'a duplicate DONE marker',
      [
        { type: 'response.completed', response: completedResponse() },
        '[DONE]',
        '[DONE]',
      ],
    ],
  ] as const)('rejects %s as a protocol error', async (_name, events) => {
    const dependencies = directDependencies(sse(events as unknown as Array<Record<string, unknown> | '[DONE]'>))
    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('does not expose a terminal finish before validating DONE or EOF', async () => {
    const dependencies = directDependencies(sse([
      { type: 'response.completed', response: completedResponse() },
      { type: 'response.output_text.delta', item_id: 'msg_1', content_index: 0, delta: 'late' },
    ]))
    const iterator = runCodexDirectResponses(request([user('hello')]), dependencies)[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toMatchObject({ cause: 'protocol' })
  })

  it('finishes on terminal plus DONE without waiting for HTTP EOF', async () => {
    const output = [{
      type: 'message', id: 'msg-done', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'done', annotations: [] }],
    }]
    const cancelled = vi.fn()
    const bytes = new TextEncoder().encode([
      `data: ${JSON.stringify({ type: 'response.completed', response: completedResponse(output) })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''))
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
      },
      cancel: cancelled,
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })

    const result = await Promise.race([
      collect(runCodexDirectResponses(request([user('hello')]), directDependencies(response))),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 100)),
    ])

    expect(result).not.toBe('timed-out')
    if (result === 'timed-out') throw new Error('stream waited for EOF after DONE')
    expect(result).toContainEqual({ type: 'finish', reason: { kind: 'stop' }, replayState: expect.anything() })
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('finishes a completed pending stream even when reader cancellation never settles', async () => {
    const output = [{
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'prompt finish' }],
    }]
    const cancelled = vi.fn(() => new Promise<void>(() => {}))
    const terminal = `data: ${JSON.stringify({
      type: 'response.completed', response: { id: 'resp-pending-cancel', output },
    })}\n\n`
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(terminal))
      },
      cancel: cancelled,
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })

    const result = await Promise.race([
      collect(runCodexDirectResponses(request([user('hello')]), directDependencies(response))),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 100)),
    ])
    expect(result).not.toBe('timed-out')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('rejects non-empty trailing bytes already buffered after terminal plus DONE', async () => {
    const secret = 'SECRET_TRAILING_BYTES'
    const output = [{
      type: 'message', id: 'msg-trailing', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'done', annotations: [] }],
    }]
    const source = [
      `data: ${JSON.stringify({ type: 'response.completed', response: completedResponse(output) })}\n\n`,
      'data: [DONE]\n\n',
      `data: ${secret}`,
    ].join('')
    const response = new Response(new TextEncoder().encode(source), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })

    const error = await collect(runCodexDirectResponses(
      request([user('hello')]),
      directDependencies(response),
    )).then(() => undefined, value => value as Error)
    expect(error).toMatchObject({ cause: 'protocol' })
    expect(error?.message).not.toContain(secret)
  })

  it('keeps unsupported SSE event types out of protocol error messages', async () => {
    const secret = 'SECRET_UNSUPPORTED_EVENT'
    const dependencies = directDependencies(sse([{ type: secret }]))

    const error = await collect(runCodexDirectResponses(
      request([user('hello')]),
      dependencies,
    )).then(() => undefined, value => value as Error)
    expect(error).toMatchObject({ cause: 'protocol' })
    expect(error?.message).not.toContain(secret)
  })

  it('maps SSE error events to a redacted provider failure', async () => {
    const secret = 'SECRET_PROVIDER_ERROR_BODY'
    const dependencies = directDependencies(sse([{
      type: 'error',
      message: secret,
      error: { message: secret, body: secret },
    }]))

    const error = await collect(runCodexDirectResponses(
      request([user('hello')]),
      dependencies,
    )).then(() => undefined, value => value as Error)
    expect(error).toMatchObject({ cause: 'provider-failure' })
    expect(error?.message).not.toContain(secret)
  })

  it.each([
    ['context_length_exceeded', 'context-window'],
    ['insufficient_quota', 'quota'],
    ['future_provider_code', 'provider-failure'],
  ] as const)('maps failed code %s to a stable redacted cause', async (code, cause) => {
    const secret = 'SECRET_FAILED_PROVIDER_BODY'
    const dependencies = directDependencies(sse([
      {
        type: 'response.failed',
        response: { id: 'resp-failed-code', error: { code, message: secret, body: secret } },
      },
      '[DONE]',
    ]))

    const error = await collect(runCodexDirectResponses(
      request([user('hello')]),
      dependencies,
    )).then(() => undefined, value => value as Error)
    expect(error).toMatchObject({ cause })
    expect(error?.message).not.toContain(secret)
    expect(error?.message).not.toContain(code)
  })

  it('rejects EOF with an unterminated pending SSE event', async () => {
    const output = [{
      type: 'message', id: 'msg-eof', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'must not dispatch', annotations: [] }],
    }]
    const source = `data: ${JSON.stringify({ type: 'response.completed', response: completedResponse(output) })}`
    const response = new Response(new TextEncoder().encode(source), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })

    await expect(collect(runCodexDirectResponses(request([user('hello')]), directDependencies(response))))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('cancels the SSE reader when a consumer returns early', async () => {
    const item = {
      type: 'message', id: 'msg-early', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'first chunk', annotations: [] }],
    }
    const cancelled = vi.fn()
    const source = [
      {
        type: 'response.output_item.added', output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added', item_id: 'msg-early', output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta', item_id: 'msg-early', output_index: 0,
        content_index: 0, delta: 'first chunk',
      },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(source))
      },
      cancel: cancelled,
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const iterator = runCodexDirectResponses(
      request([user('hello')]),
      directDependencies(response),
    )[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({ value: { type: 'block-start', index: 0, blockType: 'text' }, done: false })
    await iterator.return?.()

    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('cancels the SSE reader on processor failure but not after natural complete EOF', async () => {
    const failedCancel = vi.fn()
    const invalidResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"unsupported"}\n\n'))
      },
      cancel: failedCancel,
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    await expect(collect(runCodexDirectResponses(
      request([user('hello')]),
      directDependencies(invalidResponse),
    ))).rejects.toMatchObject({ cause: 'protocol' })
    expect(failedCancel).toHaveBeenCalledTimes(1)

    const naturalCancel = vi.fn()
    const output = [{
      type: 'message', id: 'msg-natural', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'natural', annotations: [] }],
    }]
    const terminal = `data: ${JSON.stringify({
      type: 'response.completed', response: completedResponse(output),
    })}\n\n`
    const naturalResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(terminal))
        controller.close()
      },
      cancel: naturalCancel,
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    await expect(collect(runCodexDirectResponses(
      request([user('hello')]),
      directDependencies(naturalResponse),
    ))).resolves.toContainEqual({ type: 'finish', reason: { kind: 'stop' }, replayState: expect.anything() })
    expect(naturalCancel).not.toHaveBeenCalled()
  })

  it('counts inserted data-line newlines against the SSE event byte limit', async () => {
    const response = new Response(new TextEncoder().encode('data: {\ndata: }\n\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const error = await collect(runCodexDirectResponses(
      request([user('hello')]),
      directDependencies(response, { maxSseEventBytes: 2 }),
    )).then(() => undefined, value => value as Error)

    expect(error).toMatchObject({ cause: 'protocol' })
    expect(error?.message).toContain('safety limit')
  })

  it('rejects unknown or duplicate native tool calls without parsing their argument strings', async () => {
    const unknown = [{
      type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'not_allowed', arguments: '{broken', status: 'completed',
    }]
    const unknownDependencies = directDependencies(sse([
      { type: 'response.completed', response: completedResponse(unknown) },
      '[DONE]',
    ]))
    await expect(collect(runCodexDirectResponses(request([user('hello')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), unknownDependencies))).rejects.toMatchObject({ cause: 'protocol' })

    const duplicate = [
      { type: 'function_call', id: 'fc_1', call_id: 'same-call', name: 'read_file', arguments: '{broken', status: 'completed' },
      { type: 'function_call', id: 'fc_2', call_id: 'same-call', name: 'read_file', arguments: 'still broken}', status: 'completed' },
    ]
    const duplicateDependencies = directDependencies(sse([
      { type: 'response.completed', response: completedResponse(duplicate) },
      '[DONE]',
    ]))
    await expect(collect(runCodexDirectResponses(request([user('hello')], {
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), duplicateDependencies))).rejects.toMatchObject({ cause: 'protocol' })
  })

  it('keeps interleaved parallel calls correlated and preserves malformed arguments as raw strings', async () => {
    const sessionId = 'session-parallel-tool-loop' as NonNullable<GenerateOptions['sessionId']>
    const first = {
      type: 'function_call', id: 'fc-first', call_id: 'call-first', name: 'read_file',
      arguments: '{malformed', status: 'completed',
    }
    const second = {
      type: 'function_call', id: 'fc-second', call_id: 'call-second', name: 'read_file',
      arguments: '{"path":"b"}', status: 'completed',
    }
    const dependencies = directDependencies(sse([
      { type: 'response.output_item.added', output_index: 0, item: { ...first, status: 'in_progress', arguments: '' } },
      { type: 'response.output_item.added', output_index: 1, item: { ...second, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-second', output_index: 1, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-first', output_index: 0, delta: '{mal' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-second', output_index: 1, delta: '"b"}' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-first', output_index: 0, delta: 'formed' },
      { type: 'response.function_call_arguments.done', item_id: 'fc-first', output_index: 0, arguments: '{malformed' },
      { type: 'response.function_call_arguments.done', item_id: 'fc-second', output_index: 1, arguments: '{"path":"b"}' },
      { type: 'response.output_item.done', output_index: 0, item: first },
      { type: 'response.output_item.done', output_index: 1, item: second },
      { type: 'response.completed', response: completedResponse([first, second]) },
      '[DONE]',
    ]))

    const chunks = await collect(runCodexDirectResponses(request([user('parallel')], {
      sessionId,
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), dependencies))
    const assembler = new BlockAssembler()
    chunks.forEach(chunk => assembler.push(chunk))

    expect(assembler.blocks()).toEqual([
      { type: 'tool-call', id: CallId('call-first'), name: 'read_file', arguments: '{malformed' },
      { type: 'tool-call', id: CallId('call-second'), name: 'read_file', arguments: '{"path":"b"}' },
    ])
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })

    const finish = chunks.find(chunk => chunk.type === 'finish')
    if (finish?.type !== 'finish') throw new Error('missing finish')
    const replayDependencies = directDependencies(sse([
      { type: 'response.completed', response: completedResponse() },
      '[DONE]',
    ]))
    const replayAssistant = createMessage({
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'codex-subscription',
        model: 'default',
        replayState: finish.replayState,
      },
      content: assembler.blocks(),
    })
    const firstToolResult = createMessage({
      role: 'user',
      source: { kind: 'tool', callId: CallId('call-first') },
      content: [{
        type: 'tool-result',
        toolCallId: CallId('call-first'),
        isError: false,
        content: [{ type: 'text', text: 'first contents' }],
      }],
    })
    await collect(runCodexDirectResponses(request([replayAssistant, firstToolResult], {
      sessionId,
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
    }), replayDependencies))
    expect(JSON.parse(replayDependencies.request.mock.calls[0]![0] as string).input).toEqual([
      {
        type: 'function_call', call_id: 'call-first', name: 'read_file', arguments: '{malformed',
      },
      {
        type: 'function_call', call_id: 'call-second', name: 'read_file', arguments: '{"path":"b"}',
      },
      { type: 'function_call_output', call_id: 'call-first', output: 'first contents' },
    ])
    expect(replayDependencies.request.mock.calls[0]![2]).toEqual(dependencies.request.mock.calls[0]![2])
    expect(JSON.parse(replayDependencies.request.mock.calls[0]![0]).prompt_cache_key)
      .toBe(JSON.parse(dependencies.request.mock.calls[0]![0]).prompt_cache_key)
  })

  it('fails closed on unsupported options, oversized requests, HTTP errors, and non-SSE responses', async () => {
    const unused = directDependencies(sse([{ type: 'response.completed', response: completedResponse() }]))
    await expect(collect(runCodexDirectResponses(request([user('hello')], { stop: ['END'] }), unused)))
      .rejects.toMatchObject({ cause: 'protocol' })
    expect(unused.request).not.toHaveBeenCalled()

    const oversized = directDependencies(sse([{ type: 'response.completed', response: completedResponse() }]), {
      maxRequestBytes: 32,
    })
    await expect(collect(runCodexDirectResponses(request([user('this is larger than thirty-two bytes')]), oversized)))
      .rejects.toMatchObject({ cause: 'prompt-limit' })
    expect(oversized.request).not.toHaveBeenCalled()

    const unauthorized = directDependencies(new Response('', { status: 401 }))
    await expect(collect(runCodexDirectResponses(request([user('hello')]), unauthorized)))
      .rejects.toMatchObject({ cause: 'subscription-auth', status: 401 })

    const notSse = directDependencies(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(collect(runCodexDirectResponses(request([user('hello')]), notSse)))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('accepts a strict terminal SSE body when the successful Codex response omits Content-Type', async () => {
    const doneItem = {
      type: 'message',
      id: 'msg-missing-content-type',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'headerless SSE', annotations: [] }],
    }
    const response = responseWithoutContentType([
      { type: 'response.output_item.done', output_index: 0, item: doneItem },
      {
        type: 'response.completed',
        response: {
          id: 'resp-missing-content-type',
          status: 'completed',
          output: [doneItem],
          usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        },
      },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))

    expect(response.headers.get('content-type')).toBeNull()
    const chunks = await collect(runCodexDirectResponses(
      request([user('hello')]),
      directDependencies(response),
    ))

    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'headerless SSE' },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: {
        response: {
          responseId: 'resp-missing-content-type',
          output: [doneItem],
        },
      },
    })
  })

  it.each([
    ['a non-SSE body', '{}'],
    [
      'SSE with no terminal event',
      [
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', role: 'assistant', id: 'msg-no-terminal', content: [] },
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: 'partial',
        })}\n\n`,
      ].join(''),
    ],
  ] as const)('fails closed on HTTP 200 without Content-Type when the body is %s', async (_label, body) => {
    const response = responseWithoutContentType(body)

    expect(response.headers.get('content-type')).toBeNull()
    await expect(collect(runCodexDirectResponses(
      request([user('hello')]),
      directDependencies(response),
    ))).rejects.toMatchObject({ cause: 'protocol' })
  })

  it.each([
    ['HTTP failure', 503, 'text/plain', 'provider-http'],
    ['subscription failure', 401, 'text/plain', 'subscription-auth'],
    ['non-SSE success', 200, 'application/json', 'protocol'],
  ] as const)('does not await a never-settling body cancellation for %s', async (_label, status, contentType, cause) => {
    const cancelled = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
      status,
      headers: { 'content-type': contentType },
    })
    const pending = collect(runCodexDirectResponses(request([user('hello')]), directDependencies(response)))
      .then(() => ({ kind: 'resolved' as const }), error => ({ kind: 'rejected' as const, error }))

    const result = await Promise.race([
      pending,
      new Promise<{ kind: 'timed-out' }>(resolve => setTimeout(() => resolve({ kind: 'timed-out' }), 100)),
    ])
    expect(result).toMatchObject({ kind: 'rejected', error: { cause } })
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('does not await body cancellation when the caller aborts as the response arrives', async () => {
    const cancelled = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const controller = new AbortController()
    const reason = new DOMException('abort at response handoff', 'AbortError')
    const dependencies: CodexDirectResponsesDependencies = {
      signal: controller.signal,
      request: async () => {
        controller.abort(reason)
        return response
      },
    }

    const result = await Promise.race([
      collect(runCodexDirectResponses(request([user('hello')]), dependencies))
        .then(() => ({ kind: 'resolved' as const }), error => ({ kind: 'rejected' as const, error })),
      new Promise<{ kind: 'timed-out' }>(resolve => setTimeout(() => resolve({ kind: 'timed-out' }), 100)),
    ])
    expect(result).toEqual({ kind: 'rejected', error: reason })
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid usage and classifies completed responses with no visible output as empty', async () => {
    const invalidUsage = directDependencies(sse([{
      type: 'response.completed',
      response: completedResponse([], {
        input_tokens: 2,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 1,
        total_tokens: 3,
      }),
    }]))
    await expect(collect(runCodexDirectResponses(request([user('hello')]), invalidUsage)))
      .rejects.toMatchObject({ cause: 'protocol' })

    for (const output of [
      [],
      [{ type: 'message', id: 'msg-empty', role: 'assistant', status: 'completed', content: [] }],
      [{
        type: 'message', id: 'msg-zero', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      }],
      [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'hidden', summary: [] }],
    ]) {
      const dependencies = directDependencies(sse([{
        type: 'response.completed',
        response: completedResponse(output),
      }, '[DONE]']))
      await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
        .rejects.toMatchObject({ cause: 'empty-response' })
    }
  })

  it('allows max-output incompletion containing only hidden reasoning', async () => {
    const dependencies = directDependencies(sse([{
      type: 'response.incomplete',
      response: {
        ...completedResponse([{
          type: 'reasoning', id: 'rs-hidden', encrypted_content: 'hidden', summary: [],
        }]),
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    }, '[DONE]']))

    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .resolves.toContainEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('settles a blocked SSE read promptly with the caller abort reason', async () => {
    const cancelled = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel: cancelled,
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const controller = new AbortController()
    const dependencies = directDependencies(response, { signal: controller.signal })
    const reason = new Error('cancelled by test')
    const pending = collect(runCodexDirectResponses(request([user('hello')]), dependencies))
      .then(
        () => ({ kind: 'resolved' as const }),
        error => ({ kind: 'rejected' as const, error }),
      )
    await vi.waitFor(() => expect(dependencies.request).toHaveBeenCalledTimes(1))

    controller.abort(reason)

    const result = await Promise.race([
      pending,
      new Promise<{ kind: 'timed-out' }>(resolve => setTimeout(() => resolve({ kind: 'timed-out' }), 100)),
    ])
    expect(result).toEqual({ kind: 'rejected', error: reason })
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('cancels a response body when the signal aborts as the requester returns it', async () => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel: cancelled,
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const controller = new AbortController()
    const reason = new DOMException('aborted in requester race', 'AbortError')
    const requestAtAbort = vi.fn<CodexResponsesRequester>(async () => {
      controller.abort(reason)
      return response
    })

    await expect(collect(runCodexDirectResponses(request([user('hello')]), {
      request: requestAtAbort,
      signal: controller.signal,
    }))).rejects.toBe(reason)
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('rejects visible deltas for an output item that was never registered', async () => {
    const dependencies = directDependencies(sse([
      {
        type: 'response.output_text.delta',
        item_id: 'msg-ghost',
        content_index: 0,
        delta: 'uncommitted',
      },
      { type: 'response.completed', response: completedResponse([]) },
      '[DONE]',
    ]))

    await expect(collect(runCodexDirectResponses(request([user('hello')]), dependencies)))
      .rejects.toMatchObject({ cause: 'protocol' })
  })

  it('passes the combined lifecycle signal through a blocked attachment read', async () => {
    const imageRef = {
      attachmentId: 'sha256:blocked-image',
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
      name: 'blocked.png',
    } as never
    const controller = new AbortController()
    const reason = new Error('attachment read cancelled')
    const readImage = vi.fn((_ref, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const dependencies = directDependencies(sse([]), {
      signal: controller.signal,
      attachments: { readImage },
    })
    const pending = collect(runCodexDirectResponses(request([createMessage({
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'image', attachment: imageRef }],
    })]), dependencies)).then(
      () => ({ kind: 'resolved' as const }),
      error => ({ kind: 'rejected' as const, error }),
    )
    await vi.waitFor(() => expect(readImage).toHaveBeenCalledTimes(1))

    controller.abort(reason)

    const result = await Promise.race([
      pending,
      new Promise<{ kind: 'timed-out' }>(resolve => setTimeout(() => resolve({ kind: 'timed-out' }), 100)),
    ])
    expect(result).toEqual({ kind: 'rejected', error: reason })
    expect(dependencies.request).not.toHaveBeenCalled()
  })
})
