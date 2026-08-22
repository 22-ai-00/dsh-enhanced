interface LarkWsHeader {
  key: string
  value: string
}

interface LarkWsFrame {
  headers: LarkWsHeader[]
  payload?: Uint8Array
  [key: string]: unknown
}

type LarkWsMergedData = Record<string, unknown>

interface LarkWsClientInternals {
  dataCache: {
    mergeData(input: {
      message_id: string
      sum: number
      seq: number
      trace_id: string
      data: Uint8Array | undefined
    }): LarkWsMergedData | null | undefined
  }
  eventDispatcher?: {
    invoke(data: LarkWsMergedData, options: { needCheck: false }): unknown | Promise<unknown>
  }
  handleEventData(frame: LarkWsFrame): unknown | Promise<unknown>
  sendMessage(frame: LarkWsFrame): void
}

const installed = new WeakSet<object>()

function headers(frame: LarkWsFrame): Record<string, string> {
  return Object.fromEntries(frame.headers.map(header => [header.key, header.value]))
}

/**
 * Bridge CardKit callback frames dropped by @larksuiteoapi/node-sdk 1.73.0.
 * The pinned SDK only dispatches `type=event`; Feishu may deliver
 * `card.action.trigger` as `type=card`, which still requires the same ACK.
 */
export function installLarkCardCallbackBridge(client: object): void {
  if (installed.has(client)) return
  const ws = client as LarkWsClientInternals
  if (typeof ws.handleEventData !== 'function' || typeof ws.sendMessage !== 'function'
    || typeof ws.dataCache?.mergeData !== 'function') {
    throw new Error('lark-channel: pinned Lark WS internals do not support the CardKit callback bridge')
  }
  const original = ws.handleEventData.bind(ws)
  ws.handleEventData = async frame => {
    const values = headers(frame)
    if (values.type !== 'card') return await original(frame)
    const response: { code: number; data?: string } = { code: 200 }
    const startedAt = Date.now()
    try {
      const merged = ws.dataCache.mergeData({
        message_id: values.message_id ?? '',
        sum: Number(values.sum ?? '1'),
        seq: Number(values.seq ?? '0'),
        trace_id: values.trace_id ?? '',
        data: frame.payload,
      })
      if (merged == null) return
      const result = await ws.eventDispatcher?.invoke(merged, { needCheck: false })
      if (result !== undefined && result !== null) {
        response.data = Buffer.from(JSON.stringify(result), 'utf8').toString('base64')
      }
    } catch {
      response.code = 500
    }
    ws.sendMessage({
      ...frame,
      headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - startedAt) }],
      payload: new TextEncoder().encode(JSON.stringify(response)),
    })
  }
  installed.add(client)
}
