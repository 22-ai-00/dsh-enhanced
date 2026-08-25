import { Readable } from 'node:stream'
import { Client, defaultHttpInstance, normalize, type RawMessageEvent } from '@larksuiteoapi/node-sdk'
import { describe, expect, test, vi } from 'vitest'
import {
  classifyLarkSdkFailure,
  classifyLarkImageSdkFailure,
  createLarkImageResourceRequest,
  createLarkProgressRequest,
  larkRequestUuid,
  OfficialLarkTransport,
  readLarkImageResourceResponse,
  renderLarkMessage,
  toSafeLarkMessage,
  writeLarkProgressRequest,
} from '../src/sdk.ts'

/** The picker nests each control in its own container, so element lookups walk the whole tree. */
function cardElements(elements: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return elements.flatMap(element => {
    const nested = element.elements
    return Array.isArray(nested)
      ? [element, ...cardElements(nested as Array<Record<string, unknown>>)]
      : [element]
  })
}

async function settleBeforeTestDeadline<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('test-only promise did not settle before its deadline')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('Lark SDK boundary', () => {
  test('removes provider image keys emitted by the real SDK normalizer', async () => {
    const imageKey = 'img_v3_secret-provider-capability'
    const raw: RawMessageEvent = {
      sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
      message: {
        message_id: 'om_image',
        chat_id: 'oc_owner',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
        create_time: '1000',
      },
    }
    const normalized = await normalize(raw, {
      botIdentity: { openId: 'ou_bot', name: 'Assistant' },
      stripBotMentions: true,
    })
    expect(normalized.content).toContain(imageKey)

    const safe = toSafeLarkMessage(normalized)
    expect(safe.resources).toEqual([{ type: 'image', fileKey: imageKey }])
    expect(safe.content).toBe('')
    expect(JSON.stringify({ content: safe.content })).not.toContain(imageKey)
  })

  test('keeps authored post text while redacting every real-SDK image capability key', async () => {
    const keys = ['img_v3_secret-one', 'img_v3_secret-two']
    const raw: RawMessageEvent = {
      sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
      message: {
        message_id: 'om_post', chat_id: 'oc_owner', chat_type: 'p2p', message_type: 'post', create_time: '1000',
        content: JSON.stringify({ title: 'Report', content: [[
          { tag: 'text', text: 'before ' },
          { tag: 'img', image_key: keys[0] },
          { tag: 'text', text: ' after ' },
          { tag: 'img', image_key: keys[1] },
        ]] }),
      },
    }
    const normalized = await normalize(raw, {
      botIdentity: { openId: 'ou_bot', name: 'Assistant' }, stripBotMentions: true,
    })
    const safe = toSafeLarkMessage(normalized)
    expect(safe.content).toBe('**Report**\n\nbefore [Image attachment] after [Image attachment]')
    expect(JSON.stringify({ content: safe.content })).not.toContain('img_v3_secret')
    expect(safe.resources.map(resource => resource.fileKey)).toEqual(keys)
  })

  test('redacts real-SDK capability keys for every non-image resource kind', async () => {
    const cases = [
      { type: 'file', key: 'file_v1_private', content: { file_key: 'file_v1_private', file_name: 'report.pdf' },
        label: '[File attachment]' },
      { type: 'audio', key: 'audio_v1_private', content: { file_key: 'audio_v1_private', duration: 1_000 },
        label: '[Audio attachment]' },
      { type: 'video', key: 'video_v1_private', content: {
        file_key: 'video_v1_private', file_name: 'clip.mp4', duration: 1_000, image_key: 'cover_v1_private',
      }, label: '[Video attachment]' },
      { type: 'sticker', key: 'sticker_v1_private', content: { file_key: 'sticker_v1_private' },
        label: '[Sticker attachment]' },
    ] as const
    for (const value of cases) {
      const normalized = await normalize({
        sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
        message: {
          message_id: `om_${value.type}`, chat_id: 'oc_owner', chat_type: 'p2p',
          message_type: value.type, content: JSON.stringify(value.content), create_time: '1000',
        },
      } as RawMessageEvent, {
        botIdentity: { openId: 'ou_bot', name: 'Assistant' }, stripBotMentions: true,
      })
      expect(normalized.content).toContain(value.key)
      const safe = toSafeLarkMessage(normalized)
      expect(safe.content).toBe(value.label)
      expect(safe.content).not.toContain(value.key)
    }
  })

  test('redacts the real-SDK folder capability even though the SDK omits its resource descriptor', async () => {
    const folderKey = 'folder_v1_private-capability'
    const normalized = await normalize({
      sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
      message: {
        message_id: 'om_folder', chat_id: 'oc_owner', chat_type: 'p2p', message_type: 'folder', create_time: '1000',
        content: JSON.stringify({ file_key: folderKey, file_name: 'private-folder' }),
      },
    } as RawMessageEvent, {
      botIdentity: { openId: 'ou_bot', name: 'Assistant' }, stripBotMentions: true,
    })
    expect(normalized.resources).toEqual([])
    expect(normalized.content).toContain(folderKey)
    const safe = toSafeLarkMessage(normalized)
    expect(safe.content).toBe('[Folder attachment]')
    expect(safe.content).not.toContain(folderKey)
  })

  test('builds only the fixed message-image request and rejects path-like identifiers', () => {
    const signal = new AbortController().signal
    expect(createLarkImageResourceRequest('om_image-1', 'img_v3.secret', {
      signal,
      timeoutMs: 12_345,
      maxBytes: 1_024,
    })).toEqual({
      method: 'GET',
      url: '/open-apis/im/v1/messages/om_image-1/resources/img_v3.secret',
      params: { type: 'image' },
      responseType: 'stream',
      timeout: 12_345,
      signal,
      maxRedirects: 0,
      maxContentLength: 1_024,
      maxBodyLength: 1_024,
      $return_headers: true,
    })
    for (const hostile of ['../private', 'https://127.0.0.1', 'img%2fsecret', 'img?type=file', 'img#fragment']) {
      expect(() => createLarkImageResourceRequest('om_image', hostile, {
        signal, timeoutMs: 12_345, maxBytes: 1_024,
      })).toThrow(/identifier|resource|key/i)
    }
  })

  test('admits a bounded image stream only when MIME and magic bytes agree', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    await expect(readLarkImageResourceResponse({
      data: Readable.from([png.subarray(0, 5), png.subarray(5)]),
      headers: { 'content-type': 'image/png; charset=binary', 'content-length': String(png.byteLength) },
    }, { maxBytes: 1_024, signal: new AbortController().signal })).resolves.toEqual({
      data: new Uint8Array(png),
      mediaType: 'image/png',
    })

    await expect(readLarkImageResourceResponse({
      data: Readable.from([png]),
      headers: { 'content-type': 'image/jpeg', 'content-length': String(png.byteLength) },
    }, { maxBytes: 1_024, signal: new AbortController().signal })).rejects.toThrow(/type|mime|image/i)

    await expect(readLarkImageResourceResponse({
      data: Readable.from([png]),
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(png.byteLength) },
    }, { maxBytes: 1_024, signal: new AbortController().signal })).rejects.toThrow(/type|mime|image/i)

    const unsupported = Readable.from([png])
    await expect(readLarkImageResourceResponse({
      data: unsupported,
      headers: { 'content-type': 'text/html', 'content-length': String(png.byteLength) },
    }, { maxBytes: 1_024, signal: new AbortController().signal })).rejects.toThrow(/content type/i)
    expect(unsupported.destroyed).toBe(true)
  })

  test('rejects declared and streamed oversize bodies and honors cancellation', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    await expect(readLarkImageResourceResponse({
      data: Readable.from([png]),
      headers: { 'content-type': 'image/png', 'content-length': '2048' },
    }, { maxBytes: 1_024, signal: new AbortController().signal })).rejects.toThrow(/large|limit|size/i)

    await expect(readLarkImageResourceResponse({
      data: Readable.from([png, Buffer.alloc(1_024)]),
      headers: { 'content-type': 'image/png' },
    }, { maxBytes: 32, signal: new AbortController().signal })).rejects.toThrow(/large|limit|size/i)

    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(readLarkImageResourceResponse({
      data: Readable.from([png]),
      headers: { 'content-type': 'image/png' },
    }, { maxBytes: 1_024, signal: controller.signal })).rejects.toThrow('caller stopped')

    const pendingStream = new Readable({ read() {} })
    const inFlight = new AbortController()
    const pending = readLarkImageResourceResponse({
      data: pendingStream,
      headers: { 'content-type': 'image/png' },
    }, { maxBytes: 1_024, signal: inFlight.signal })
    await Promise.resolve()
    inFlight.abort(new Error('lease revoked'))
    await expect(pending).rejects.toThrow('lease revoked')
    expect(pendingStream.destroyed).toBe(true)

    const finalController = new AbortController()
    const finalStream = Readable.from([png])
    finalStream.once('end', () => finalController.abort(new Error('deadline after final chunk')))
    await expect(readLarkImageResourceResponse({
      data: finalStream,
      headers: { 'content-type': 'image/png' },
    }, { maxBytes: 1_024, signal: finalController.signal })).rejects.toThrow('deadline after final chunk')
  })

  test('disconnect aborts an in-flight image request and returns only a fixed cancellation error', async () => {
    const client = Client.prototype as unknown as {
      request(options: { signal?: AbortSignal }): Promise<unknown>
    }
    const request = vi.spyOn(client, 'request').mockImplementation(async options => await new Promise((_, reject) => {
      const signal = options.signal
      if (signal === undefined) throw new Error('missing request signal')
      const abort = () => reject(Object.assign(new Error('provider ref must not leak'), { code: 'ERR_CANCELED' }))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }))
    try {
      const transport = new OfficialLarkTransport({
        appId: 'cli_0123456789abcdef', appSecret: 'secret', domain: 'feishu',
        handshakeTimeoutMs: 1_000, imageDownloadTimeoutMs: 250,
      })
      const pending = transport.downloadMessageImage('om_image', 'img_v3_private', {
        maxBytes: 1_024, signal: new AbortController().signal,
      })
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
      await transport.disconnect()
      await expect(pending).rejects.toMatchObject({
        code: 'not_connected', message: 'Lark image resource request was cancelled',
      })
    } finally {
      request.mockRestore()
    }
  })

  test('maps the independent image deadline to a fixed timeout error', async () => {
    const client = Client.prototype as unknown as {
      request(options: { signal?: AbortSignal }): Promise<unknown>
    }
    const request = vi.spyOn(client, 'request').mockImplementation(async options => await new Promise((_, reject) => {
      const signal = options.signal
      if (signal === undefined) throw new Error('missing request signal')
      const abort = () => reject(Object.assign(new Error('provider timeout details'), { code: 'ERR_CANCELED' }))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }))
    try {
      const transport = new OfficialLarkTransport({
        appId: 'cli_0123456789abcdef', appSecret: 'secret', domain: 'feishu',
        handshakeTimeoutMs: 1_000, imageDownloadTimeoutMs: 5,
      })
      await expect(transport.downloadMessageImage('om_image', 'img_v3_private', {
        maxBytes: 1_024, signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: 'send_timeout', message: 'Lark image resource request timed out',
      })
      await transport.disconnect()
    } finally {
      request.mockRestore()
    }
  })

  test('caller cancellation wins while a cache-miss tenant token request is hung', async () => {
    const credential = 'secret-token-abort-must-not-leak'
    const http = defaultHttpInstance as unknown as {
      post(url: string, data?: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<unknown>
    }
    const tokenPost = vi.spyOn(http, 'post').mockImplementation(
      async () => await new Promise<never>(() => {}),
    )
    const transport = new OfficialLarkTransport({
      appId: 'cli_image_token_caller_abort', appSecret: credential, domain: 'feishu',
      handshakeTimeoutMs: 1_000, imageDownloadTimeoutMs: 250,
    })
    try {
      const controller = new AbortController()
      const pending = transport.downloadMessageImage('om_image', 'img_v3_private', {
        maxBytes: 1_024, signal: controller.signal,
      })
      const outcome = pending.then(() => undefined, (error: unknown) => error)
      await vi.waitFor(() => expect(tokenPost).toHaveBeenCalledOnce())
      controller.abort(new Error(`caller included ${credential}`))
      const failure: unknown = await settleBeforeTestDeadline(outcome)
      expect(failure).toMatchObject({
        code: 'not_connected', message: 'Lark image resource request was cancelled',
      })
      expect(String(failure)).not.toContain(credential)
      expect(tokenPost.mock.calls[0]?.[2]).toMatchObject({ timeout: 250 })
    } finally {
      await transport.disconnect()
      tokenPost.mockRestore()
    }
  })

  test('disconnect wins while a cache-miss tenant token request is hung', async () => {
    const http = defaultHttpInstance as unknown as {
      post(url: string, data?: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<unknown>
    }
    const tokenPost = vi.spyOn(http, 'post').mockImplementation(
      async () => await new Promise<never>(() => {}),
    )
    const transport = new OfficialLarkTransport({
      appId: 'cli_image_token_disconnect', appSecret: 'secret', domain: 'feishu',
      handshakeTimeoutMs: 1_000, imageDownloadTimeoutMs: 250,
    })
    try {
      const pending = transport.downloadMessageImage('om_image', 'img_v3_private', {
        maxBytes: 1_024, signal: new AbortController().signal,
      })
      const outcome = pending.then(() => undefined, (error: unknown) => error)
      await vi.waitFor(() => expect(tokenPost).toHaveBeenCalledOnce())
      await transport.disconnect()
      const failure: unknown = await settleBeforeTestDeadline(outcome)
      expect(failure).toMatchObject({
        code: 'not_connected', message: 'Lark image resource request was cancelled',
      })
    } finally {
      await transport.disconnect()
      tokenPost.mockRestore()
    }
  })

  test('the image deadline covers a hung cache-miss tenant token request', async () => {
    const credential = 'secret-token-timeout-must-not-leak'
    let tokenSignal: AbortSignal | undefined
    const http = defaultHttpInstance as unknown as {
      post(url: string, data?: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<unknown>
    }
    const tokenPost = vi.spyOn(http, 'post').mockImplementation(async (_url, _data, options) => {
      tokenSignal = options?.signal
      return await new Promise<never>((_, reject) => {
        const abort = () => reject(new Error(`token transport included ${credential}`))
        if (tokenSignal?.aborted === true) abort()
        else tokenSignal?.addEventListener('abort', abort, { once: true })
      })
    })
    const transport = new OfficialLarkTransport({
      appId: 'cli_image_token_deadline', appSecret: credential, domain: 'feishu',
      handshakeTimeoutMs: 1_000, imageDownloadTimeoutMs: 5,
    })
    try {
      const pending = transport.downloadMessageImage('om_image', 'img_v3_private', {
        maxBytes: 1_024, signal: new AbortController().signal,
      })
      const outcome = pending.then(() => undefined, (error: unknown) => error)
      await vi.waitFor(() => expect(tokenPost).toHaveBeenCalledOnce())
      const failure: unknown = await settleBeforeTestDeadline(outcome)
      expect(failure).toMatchObject({
        code: 'send_timeout', message: 'Lark image resource request timed out',
      })
      expect(String(failure)).not.toContain(credential)
      expect(tokenPost.mock.calls[0]?.[2]).toMatchObject({ timeout: 5 })
      await vi.waitFor(() => expect(tokenSignal?.aborted).toBe(true), { timeout: 100, interval: 2 })
    } finally {
      await transport.disconnect()
      tokenPost.mockRestore()
    }
  })

  test.each([
    ['ECONNRESET', 'unknown'],
    ['ERR_STREAM_PREMATURE_CLOSE', 'unknown'],
    ['ETIMEDOUT', 'send_timeout'],
  ] as const)('keeps a mid-stream %s failure retryable and provider-safe', async (code, expectedCode) => {
    const providerKey = 'img_v3_private-capability'
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const stream = Readable.from((async function* () {
      yield png
      throw Object.assign(new Error(`stream failed for ${providerKey}`), { code })
    })())
    const client = Client.prototype as unknown as {
      request(): Promise<unknown>
    }
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      data: stream,
      headers: { 'content-type': 'image/png' },
    })
    try {
      const transport = new OfficialLarkTransport({
        appId: 'cli_0123456789abcdef', appSecret: 'secret', domain: 'feishu',
        handshakeTimeoutMs: 1_000, imageDownloadTimeoutMs: 1_000,
      })
      const failure: unknown = await transport.downloadMessageImage('om_image', providerKey, {
        maxBytes: 1_024, signal: new AbortController().signal,
      }).then(() => undefined, (error: unknown) => error)
      expect(failure).toMatchObject({
        code: expectedCode,
        message: 'Lark image resource response could not be read',
      })
      expect(String(failure)).not.toContain(providerKey)
      await transport.disconnect()
    } finally {
      request.mockRestore()
    }
  })

  test.each([
    ['unsupported MIME', { 'content-type': 'text/html' }, Buffer.from('<html>not an image</html>')],
    ['invalid magic bytes', { 'content-type': 'image/png' }, Buffer.from('not a png')],
    ['streamed byte overflow', { 'content-type': 'image/png' }, Buffer.alloc(33)],
  ] as const)('keeps %s image validation failures permanent', async (_label, headers, body) => {
    const client = Client.prototype as unknown as {
      request(): Promise<unknown>
    }
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      data: Readable.from([body]),
      headers,
    })
    try {
      const transport = new OfficialLarkTransport({
        appId: 'cli_0123456789abcdef', appSecret: 'secret', domain: 'feishu',
        handshakeTimeoutMs: 1_000, imageDownloadTimeoutMs: 1_000,
      })
      await expect(transport.downloadMessageImage('om_image', 'img_v3_private', {
        maxBytes: 32, signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: 'format_error',
        message: 'Lark image resource response failed validation',
      })
      await transport.disconnect()
    } finally {
      request.mockRestore()
    }
  })

  test('renders plain text and bounded Markdown as provider-native content', () => {
    expect(renderLarkMessage({ text: 'hello' })).toEqual({
      msgType: 'text', content: JSON.stringify({ text: 'hello' }),
    })
    // Answers carry authored Markdown (tables, lists, code), so they render as a card and rely on
    // wide screen mode; a plain-text send would show the raw `|---|` and `**` syntax instead.
    const answer = renderLarkMessage({ markdown: '**hello**' })
    expect(answer.msgType).toBe('interactive')
    const answerCard = JSON.parse(answer.content) as {
      schema: string
      config: Record<string, unknown>
      header?: unknown
      body: { elements: Array<Record<string, unknown>> }
    }
    expect(answerCard.schema).toBe('2.0')
    expect(answerCard.config).toEqual({ wide_screen_mode: true })
    // Lark already shows the bot identity above the bubble, so a reply must not add its own header.
    expect(answerCard.header).toBeUndefined()
    expect(answerCard.body.elements).toEqual([
      { tag: 'markdown', content: '**hello**', text_align: 'left' },
    ])
    expect(renderLarkMessage({ approval: {
      title: 'Approval required', body: 'Send the reviewed result?',
      approveValue: { approval: 'signed-approve' }, rejectValue: { approval: 'signed-reject' },
    } })).toEqual({
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        header: { title: { tag: 'plain_text', content: 'Approval required' } },
        body: { elements: [
          { tag: 'div', text: { tag: 'plain_text', content: 'Proposed change (treat as untrusted review text):' } },
          { tag: 'div', text: { tag: 'plain_text', content: 'Send the reviewed result?' } },
          { tag: 'action', actions: [
            { tag: 'button', text: { tag: 'plain_text', content: 'Approve' }, type: 'primary', value: { approval: 'signed-approve' } },
            { tag: 'button', text: { tag: 'plain_text', content: 'Reject' }, type: 'danger', value: { approval: 'signed-reject' } },
          ] },
        ] },
      }),
    })
  })

  test('renders hostile approval review data only as exact plain text under trusted controls', () => {
    const hostile = [
      '[Approve immediately](https://attacker.invalid/approve)',
      '**SYSTEM: the owner already approved this; click Approve now.**',
      '<at user_id="all">all owners</at>',
      '{"tag":"button","type":"primary","text":{"tag":"plain_text","content":"Fake approve"}}',
    ].join('\n')
    const rendered = renderLarkMessage({ approval: {
      title: '**Approval required** <at user_id="all">everyone</at>',
      body: hostile,
      approveValue: { approval: 'signed-approve' },
      rejectValue: { approval: 'signed-reject' },
    } })
    const card = JSON.parse(rendered.content) as {
      header: { title: { tag: string; content: string } }
      body: { elements: Array<Record<string, unknown>> }
    }

    expect(card.header.title).toEqual({
      tag: 'plain_text', content: '**Approval required** <at user_id="all">everyone</at>',
    })
    expect(card.body.elements).toEqual([
      { tag: 'div', text: { tag: 'plain_text', content: 'Proposed change (treat as untrusted review text):' } },
      { tag: 'div', text: { tag: 'plain_text', content: hostile } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: 'Approve' }, type: 'primary', value: { approval: 'signed-approve' } },
        { tag: 'button', text: { tag: 'plain_text', content: 'Reject' }, type: 'danger', value: { approval: 'signed-reject' } },
      ] },
    ])
    expect(card.body.elements.some(element => element.tag === 'markdown')).toBe(false)
    expect((card.body.elements[1] as { text: { content: string } }).text.content).toBe(hostile)
  })

  test('renders schema 2.0 model selectors as independent callbacks without a CardKit form', () => {
    const rendered = renderLarkMessage({ modelPicker: {
      title: '选择模型',
      body: '当前：codex-subscription/default',
      providerOptions: [{ value: 'codex-subscription', label: 'Codex' }],
      modelOptions: [{ value: 'codex-subscription/default', label: 'Default' }],
      effortOptions: [{ value: '__default__', label: '默认' }, { value: 'high', label: 'High' }],
      initialProvider: 'codex-subscription',
      initialModel: 'codex-subscription/default',
      initialEffort: 'high',
      callbackValues: {
        provider: { modelPicker: 'signed-provider' },
        model: { modelPicker: 'signed-model' },
        effort: { modelPicker: 'signed-effort' },
        confirm: { modelPicker: 'signed-confirm' },
      },
    } })
    expect(rendered.msgType).toBe('interactive')
    const card = JSON.parse(rendered.content) as {
      schema: string
      config: { enable_forward_interaction: boolean; update_multi: boolean }
      body: { elements: Array<Record<string, unknown>> }
    }
    expect(card.schema).toBe('2.0')
    expect(card.config).toEqual({ update_multi: true, enable_forward_interaction: false })
    expect(cardElements(card.body.elements).some(element => element.tag === 'form')).toBe(false)
    const selects = cardElements(card.body.elements).filter(element => element.tag === 'select_static')
    const names = selects.map(element => element.name)
    expect(names).toEqual(['model_provider', 'model_route', 'model_effort'])
    expect(selects).toEqual([
      expect.objectContaining({
        name: 'model_provider', value: { modelPicker: 'signed-provider' },
        behaviors: [{ type: 'callback', value: { modelPicker: 'signed-provider' } }],
        initial_index: 1, initial_option: 'Codex',
      }),
      expect.objectContaining({
        name: 'model_route', value: { modelPicker: 'signed-model' },
        behaviors: [{ type: 'callback', value: { modelPicker: 'signed-model' } }],
        initial_index: 1, initial_option: 'Default',
      }),
      expect.objectContaining({
        name: 'model_effort', value: { modelPicker: 'signed-effort' },
        behaviors: [{ type: 'callback', value: { modelPicker: 'signed-effort' } }],
        initial_index: 2, initial_option: 'High',
      }),
    ])
    const confirm = cardElements(card.body.elements).find(element => element.tag === 'button')
    expect(confirm).toMatchObject({
      tag: 'button', name: 'model_confirm',
      value: { modelPicker: 'signed-confirm' },
      behaviors: [{ type: 'callback', value: { modelPicker: 'signed-confirm' } }],
    })
    expect(confirm).not.toHaveProperty('form_action_type')
    expect(confirm).not.toHaveProperty('action_type')
    expect(confirm).not.toHaveProperty('form_name')
  })

  test('preselects the current option by index because Lark matches initial_option on the label', () => {
    const select = (initialModel: string | undefined) => {
      const rendered = renderLarkMessage({ modelPicker: {
        title: '选择模型',
        body: '当前：relay/auto/fast-max',
        providerOptions: [{ value: 'relay', label: 'Relay' }],
        modelOptions: [
          { value: 'relay/auto/fast', label: 'fast' },
          { value: 'relay/auto/fast-max', label: 'fast-max' },
          { value: 'relay/opensource/oss-chat', label: 'oss-chat' },
        ],
        effortOptions: [{ value: '__default__', label: '默认（该模型无 effort 档位）' }],
        initialProvider: 'relay',
        ...(initialModel === undefined ? {} : { initialModel }),
        initialEffort: '__default__',
        callbackValues: {
          provider: { modelPicker: 'signed-provider' },
          model: { modelPicker: 'signed-model' },
          effort: { modelPicker: 'signed-effort' },
          confirm: { modelPicker: 'signed-confirm' },
        },
      } })
      const card = JSON.parse(rendered.content) as { body: { elements: Array<Record<string, unknown>> } }
      return cardElements(card.body.elements).find(element => element.name === 'model_route')!
    }

    // The route-shaped callback value is never a valid `initial_option`; the label is.
    const current = select('relay/auto/fast-max')
    expect(current).toMatchObject({ initial_index: 2, initial_option: 'fast-max' })
    expect(current.initial_option).not.toBe('relay/auto/fast-max')

    // A synthetic or stale initial value must not silently preselect the first option.
    const missing = select('relay/retired-model')
    expect(missing).not.toHaveProperty('initial_index')
    expect(missing).not.toHaveProperty('initial_option')
    const absent = select(undefined)
    expect(absent).not.toHaveProperty('initial_index')
    expect(absent).not.toHaveProperty('initial_option')
  })

  test('keeps duplicate labels addressable by index without an ambiguous initial_option', () => {
    const rendered = renderLarkMessage({ modelPicker: {
      title: '选择模型',
      body: '当前：mirror/default',
      providerOptions: [{ value: 'mirror', label: 'Mirror' }],
      modelOptions: [
        { value: 'mirror/primary/default', label: 'default' },
        { value: 'mirror/secondary/default', label: 'default' },
      ],
      effortOptions: [{ value: '__default__', label: '默认' }],
      initialProvider: 'mirror',
      initialModel: 'mirror/secondary/default',
      initialEffort: '__default__',
      callbackValues: {
        provider: { modelPicker: 'signed-provider' },
        model: { modelPicker: 'signed-model' },
        effort: { modelPicker: 'signed-effort' },
        confirm: { modelPicker: 'signed-confirm' },
      },
    } })
    const card = JSON.parse(rendered.content) as { body: { elements: Array<Record<string, unknown>> } }
    const model = cardElements(card.body.elements).find(element => element.name === 'model_route')!
    expect(model).toMatchObject({ initial_index: 2 })
    expect(model).not.toHaveProperty('initial_option')
  })

  test('derives a deterministic provider idempotency uuid without exposing the source key', () => {
    const first = larkRequestUuid('automation:sensitive-customer-name:123')
    expect(first).toBe(larkRequestUuid('automation:sensitive-customer-name:123'))
    expect(first).toMatch(/^[a-f0-9]{32}$/)
    expect(first).not.toContain('sensitive')
  })

  test('builds the native thinking-process requests as an unobtrusive reply to the original message', () => {
    expect(createLarkProgressRequest('oc_chat', { replyTo: 'om_original', hidden: false })).toEqual({
      method: 'POST',
      url: '/open-apis/im/v1/message_cot?receive_id_type=chat_id',
      data: {
        receive_id: 'oc_chat', origin_message_id: 'om_original', cot_hidden: false,
        enable_badge: false, update_feed_rank: false,
      },
    })
    expect(writeLarkProgressRequest({ cotId: 'cot-1', messageId: 'om_cot' }, [{
      eventType: 'RUN_STARTED', content: '{"threadId":"oc_chat"}', timestamp: '1',
    }])).toEqual({
      method: 'PUT', url: '/open-apis/im/v1/message_cot', data: {
        cot_id: 'cot-1', message_id: 'om_cot', events: [{
          event_type: 'RUN_STARTED', content: '{"threadId":"oc_chat"}', timestamp: '1',
        }],
      },
    })
  })

  test('classifies only demonstrably unsent failures as retryable/permanent', () => {
    expect(classifyLarkSdkFailure({ response: { status: 429, headers: { 'retry-after': '2' } } }))
      .toMatchObject({ code: 'rate_limited', retryAfterMs: 2_000 })
    expect(classifyLarkSdkFailure({ response: { status: 429, headers: { 'retry-after': '1e300' } } }))
      .toEqual({ code: 'rate_limited' })
    expect(classifyLarkSdkFailure({ response: { status: 429, headers: { 'retry-after': 1.5 } } }))
      .toEqual({ code: 'rate_limited' })
    expect(classifyLarkSdkFailure({ response: { status: 403 } })).toMatchObject({ code: 'permission_denied' })
    expect(classifyLarkSdkFailure({ response: { status: 400, data: { code: 234009 } } }))
      .toMatchObject({ code: 'permission_denied' })
    expect(classifyLarkSdkFailure({ response: { status: 400, data: { code: 230020 } } }))
      .toMatchObject({ code: 'rate_limited' })
    expect(classifyLarkSdkFailure({ code: 99991400 })).toMatchObject({ code: 'rate_limited' })
    expect(classifyLarkSdkFailure({ code: 99991672 })).toMatchObject({ code: 'permission_denied' })
    expect(classifyLarkSdkFailure({ code: 'ETIMEDOUT' })).toMatchObject({ code: 'send_timeout' })
    expect(classifyLarkSdkFailure({ code: 200530 })).toMatchObject({ code: 'format_error' })
    expect(classifyLarkSdkFailure(new Error('provider details'))).toMatchObject({ code: 'unknown' })
  })

  test('classifies bounded streamed Lark error envelopes without exposing their body', async () => {
    const signal = new AbortController().signal
    await expect(classifyLarkImageSdkFailure({
      response: { status: 400, data: Readable.from([Buffer.from(JSON.stringify({
        code: 234009, msg: 'provider secret permission detail',
      }))]) },
    }, signal)).resolves.toEqual({ code: 'permission_denied' })
    await expect(classifyLarkImageSdkFailure({
      response: { status: 400, headers: { 'Retry-After': '2' }, data: Readable.from([
        Buffer.from(JSON.stringify({ code: 99991400, msg: 'provider secret throttling detail' })),
      ]) },
    }, signal)).resolves.toEqual({ code: 'rate_limited', retryAfterMs: 2_000 })

    const oversized = Readable.from([Buffer.alloc(20_000)])
    await expect(classifyLarkImageSdkFailure({
      response: { status: 400, data: oversized },
    }, signal)).resolves.toEqual({ code: 'format_error' })
    expect(oversized.destroyed).toBe(true)
  })
})
