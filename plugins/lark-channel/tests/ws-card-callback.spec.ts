import { describe, expect, test, vi } from 'vitest'
import { installLarkCardCallbackBridge } from '../src/ws-card-callback.ts'

function frame(type: string) {
  return {
    method: 1,
    headers: [
      { key: 'type', value: type },
      { key: 'message_id', value: 'om_card_frame' },
      { key: 'trace_id', value: 'trace-card' },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
    ],
    payload: new TextEncoder().encode('{"schema":"2.0"}'),
  }
}

describe('Lark CardKit WebSocket callback bridge', () => {
  test('dispatches and acknowledges type=card frames that the pinned SDK drops', async () => {
    const original = vi.fn(async (_input: ReturnType<typeof frame>) => {})
    const invoke = vi.fn(async () => ({ card: { type: 'raw', data: { schema: '2.0' } } }))
    const sendMessage = vi.fn<(input: ReturnType<typeof frame>) => void>()
    const client = {
      handleEventData: original,
      dataCache: { mergeData: vi.fn(input => JSON.parse(new TextDecoder().decode(input.data)) as Record<string, unknown>) },
      eventDispatcher: { invoke },
      sendMessage,
    }
    installLarkCardCallbackBridge(client)
    installLarkCardCallbackBridge(client)

    await client.handleEventData(frame('card'))
    expect(original).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith({ schema: '2.0' }, { needCheck: false })
    expect(sendMessage).toHaveBeenCalledOnce()
    const responseFrame = sendMessage.mock.calls[0]![0] as ReturnType<typeof frame>
    expect(responseFrame.headers).toContainEqual(expect.objectContaining({ key: 'biz_rt' }))
    const response = JSON.parse(new TextDecoder().decode(responseFrame.payload)) as { code: number; data: string }
    expect(response.code).toBe(200)
    expect(JSON.parse(Buffer.from(response.data, 'base64').toString('utf8'))).toEqual({
      card: { type: 'raw', data: { schema: '2.0' } },
    })

    const event = frame('event')
    await client.handleEventData(event)
    expect(original).toHaveBeenCalledWith(event)
  })

  test('waits for all fragments and returns a 500 ACK when dispatch fails', async () => {
    let fragments = 0
    const sendMessage = vi.fn<(input: ReturnType<typeof frame>) => void>()
    const client = {
      handleEventData: vi.fn(async (_input: ReturnType<typeof frame>) => {}),
      dataCache: { mergeData: vi.fn(input => ++fragments === 1
        ? null
        : JSON.parse(new TextDecoder().decode(input.data)) as Record<string, unknown>) },
      eventDispatcher: { invoke: vi.fn(async () => { throw new Error('handler failed') }) },
      sendMessage,
    }
    installLarkCardCallbackBridge(client)
    await client.handleEventData(frame('card'))
    expect(sendMessage).not.toHaveBeenCalled()
    await client.handleEventData(frame('card'))
    const response = JSON.parse(new TextDecoder().decode(
      (sendMessage.mock.calls[0]![0] as ReturnType<typeof frame>).payload,
    )) as { code: number }
    expect(response).toEqual({ code: 500 })
  })

  test('returns a 500 ACK when the SDK cannot parse a completed frame', async () => {
    const sendMessage = vi.fn<(input: ReturnType<typeof frame>) => void>()
    const client = {
      handleEventData: vi.fn(async (_input: ReturnType<typeof frame>) => {}),
      dataCache: { mergeData: vi.fn(() => { throw new SyntaxError('invalid callback JSON') }) },
      eventDispatcher: { invoke: vi.fn() },
      sendMessage,
    }
    installLarkCardCallbackBridge(client)

    await client.handleEventData(frame('card'))
    expect(client.eventDispatcher.invoke).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledOnce()
    const response = JSON.parse(new TextDecoder().decode(
      (sendMessage.mock.calls[0]![0] as ReturnType<typeof frame>).payload,
    )) as { code: number }
    expect(response).toEqual({ code: 500 })
  })
})
