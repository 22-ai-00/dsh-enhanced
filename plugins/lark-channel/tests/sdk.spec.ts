import { describe, expect, test } from 'vitest'
import {
  classifyLarkSdkFailure,
  createLarkProgressRequest,
  larkRequestUuid,
  renderLarkMessage,
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
    expect(classifyLarkSdkFailure({ response: { status: 403 } })).toMatchObject({ code: 'permission_denied' })
    expect(classifyLarkSdkFailure({ code: 'ETIMEDOUT' })).toMatchObject({ code: 'send_timeout' })
    expect(classifyLarkSdkFailure({ code: 200530 })).toMatchObject({ code: 'format_error' })
    expect(classifyLarkSdkFailure(new Error('provider details'))).toMatchObject({ code: 'unknown' })
  })
})
