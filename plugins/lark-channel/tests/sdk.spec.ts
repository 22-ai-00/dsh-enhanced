import { describe, expect, test } from 'vitest'
import {
  classifyLarkSdkFailure,
  createLarkProgressRequest,
  extractLarkFormValue,
  larkRequestUuid,
  renderLarkMessage,
  writeLarkProgressRequest,
} from '../src/sdk.ts'

describe('Lark SDK boundary', () => {
  test('renders plain text and bounded Markdown as provider-native content', () => {
    expect(renderLarkMessage({ text: 'hello' })).toEqual({
      msgType: 'text', content: JSON.stringify({ text: 'hello' }),
    })
    expect(renderLarkMessage({ markdown: '**hello**' })).toEqual({
      msgType: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**hello**' }] } }),
    })
    expect(renderLarkMessage({ approval: {
      title: 'Approval required', body: 'Send the reviewed result?',
      approveValue: { approval: 'signed-approve' }, rejectValue: { approval: 'signed-reject' },
    } })).toEqual({
      msgType: 'interactive',
      content: JSON.stringify({
        schema: '2.0',
        header: { title: { tag: 'plain_text', content: 'Approval required' } },
        body: { elements: [
          { tag: 'markdown', content: 'Send the reviewed result?' },
          { tag: 'action', actions: [
            { tag: 'button', text: { tag: 'plain_text', content: 'Approve' }, type: 'primary', value: { approval: 'signed-approve' } },
            { tag: 'button', text: { tag: 'plain_text', content: 'Reject' }, type: 'danger', value: { approval: 'signed-reject' } },
          ] },
        ] },
      }),
    })
  })

  test('renders a schema 2.0 model form with provider, model, and effort dropdowns plus submit', () => {
    const rendered = renderLarkMessage({ modelPicker: {
      title: '选择模型',
      body: '当前：codex-subscription/default',
      providerOptions: [{ value: 'codex-subscription', label: 'Codex' }],
      modelOptions: [{ value: 'codex-subscription/default', label: 'Default' }],
      effortOptions: [{ value: '__default__', label: '默认' }, { value: 'high', label: 'High' }],
      initialProvider: 'codex-subscription',
      initialModel: 'codex-subscription/default',
      initialEffort: 'high',
      confirmValue: { modelPicker: 'signed-model-picker' },
    } })
    expect(rendered.msgType).toBe('interactive')
    const card = JSON.parse(rendered.content) as {
      schema: string
      config: { enable_forward_interaction: boolean; update_multi: boolean }
      body: { elements: Array<Record<string, unknown>> }
    }
    expect(card.schema).toBe('2.0')
    expect(card.config).toEqual({ update_multi: true, enable_forward_interaction: false })
    const form = card.body.elements.find(element => element.tag === 'form') as {
      name: string
      elements: Array<Record<string, unknown>>
    }
    const selects = form.elements.filter(element => element.tag === 'select_static')
    const names = selects.map(element => element.name)
    expect(form.name).toMatch(/^dsh_model_picker_[a-f0-9]{16}$/u)
    expect(names).toEqual([
      expect.stringMatching(/^provider_[a-f0-9]{16}$/u),
      expect.stringMatching(/^model_[a-f0-9]{16}$/u),
      expect.stringMatching(/^effort_[a-f0-9]{16}$/u),
    ])
    expect(new Set([form.name, ...names]).size).toBe(4)
    expect(selects.slice(0, 2))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: names[0], behaviors: [{ type: 'callback', value: { modelPicker: 'signed-model-picker' } }],
        }),
        expect.objectContaining({
          name: names[1], behaviors: [{ type: 'callback', value: { modelPicker: 'signed-model-picker' } }],
        }),
      ]))
    expect(form.elements.at(-1)).toMatchObject({
      tag: 'button', name: expect.stringMatching(/^confirm_[a-f0-9]{16}$/u), form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: { modelPicker: 'signed-model-picker' } }],
    })
  })

  test('isolates model form state across picker operations and cascading routes', () => {
    const renderNames = (token: string, provider: string, model: string) => {
      const rendered = renderLarkMessage({ modelPicker: {
        title: '选择模型', body: '当前模型',
        providerOptions: [{ value: provider, label: provider }],
        modelOptions: [{ value: `${provider}/${model}`, label: model }],
        effortOptions: [{ value: '__default__', label: '默认' }],
        initialProvider: provider,
        initialModel: `${provider}/${model}`,
        initialEffort: '__default__',
        confirmValue: { modelPicker: token },
      } })
      const card = JSON.parse(rendered.content) as { body: { elements: Array<Record<string, unknown>> } }
      const form = card.body.elements.find(element => element.tag === 'form') as {
        name: string
        elements: Array<{ name?: string }>
      }
      return [form.name, ...form.elements.flatMap(element => element.name === undefined ? [] : [element.name])]
    }

    const first = renderNames('signed-model-picker-1', 'provider-a', 'model-a')
    expect(renderNames('signed-model-picker-1', 'provider-a', 'model-a')).toEqual(first)
    expect(renderNames('signed-model-picker-2', 'provider-a', 'model-a')).not.toEqual(first)
    expect(renderNames('signed-model-picker-1', 'provider-b', 'model-b')).not.toEqual(first)
  })

  test('strictly extracts named form values from the pinned SDK raw callback', () => {
    expect(extractLarkFormValue({ action: { form_value: {
      provider: 'codex-subscription', model: 'codex-subscription/default', effort: 'high',
    } } })).toEqual({
      provider: 'codex-subscription', model: 'codex-subscription/default', effort: 'high',
    })
    expect(extractLarkFormValue({ action: { form_value: [] } })).toBeUndefined()
    expect(extractLarkFormValue({ action: { value: {} } })).toBeUndefined()
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
    expect(classifyLarkSdkFailure({ response: { status: 403 } })).toMatchObject({ code: 'permission_denied' })
    expect(classifyLarkSdkFailure({ code: 'ETIMEDOUT' })).toMatchObject({ code: 'send_timeout' })
    expect(classifyLarkSdkFailure(new Error('provider details'))).toMatchObject({ code: 'unknown' })
  })
})
