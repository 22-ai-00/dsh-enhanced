import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'
import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk'
import { installLarkCardCallbackBridge } from '../../src/ws-card-callback.ts'

const mode = process.argv[2]
const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('@larksuiteoapi/node-sdk'))
const WebSocket = sdkRequire('ws')
const logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }

async function handshakeFixture(earlyClose) {
  const sockets = new Set()
  let accept
  const accepted = new Promise(resolve => { accept = resolve })
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    accept()
    // A real TCP peer accepts but never completes the HTTP Upgrade.
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const originalTerminate = WebSocket.prototype.terminate
  const terminations = []
  WebSocket.prototype.terminate = function (...args) {
    terminations.push({ state: this.readyState, errorListeners: this.listenerCount('error') })
    return originalTerminate.apply(this, args)
  }
  const client = new WSClient({
    appId: 'cli_0123456789abcdef', appSecret: 'fixture_only',
    autoReconnect: false, handshakeTimeoutMs: 200, logger,
  })
  client.wsConfig.updateWs({ connectUrl: `ws://127.0.0.1:${server.address().port}` })
  const started = performance.now()
  try {
    const pending = client.connect()
    await accepted
    if (earlyClose) client.close({ force: true })
    const result = await pending
    const elapsed = performance.now() - started
    assert.equal(result, false)
    // Let ws emit its asynchronous abort error while no process handler masks it.
    await new Promise(resolve => setTimeout(resolve, 20))
    console.log(`handshake=${earlyClose ? 'early-close' : 'timeout'} connect=false elapsed_ms=${elapsed.toFixed(0)}`)
    console.log(`terminations=${JSON.stringify(terminations)}`)
    console.log('async_abort_error=handled')
  } finally {
    client.close({ force: true })
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    WebSocket.prototype.terminate = originalTerminate
    console.log('fixture_resources=closed')
  }
}

function frame(type, eventType, id) {
  return {
    method: 1,
    headers: [
      { key: 'type', value: type },
      { key: 'message_id', value: `fixture-${id}` },
      { key: 'trace_id', value: `fixture-trace-${id}` },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
    ],
    payload: new TextEncoder().encode(JSON.stringify({
      schema: '2.0', header: { event_type: eventType },
      event: eventType === 'card.action.trigger'
        ? { action: { value: { key: 'fixture' } } }
        : { message: { content: 'fixture-event' } },
    })),
  }
}

async function cardFixture() {
  const count = { card: 0, event: 0 }
  const sent = []
  const dispatcher = new EventDispatcher({ logger })
  dispatcher.register({
    'card.action.trigger': async data => {
      count.card += 1
      assert.equal(data.action.value.key, 'fixture')
      return { card: { type: 'raw', data: { label: 'fixture-response' } } }
    },
    'im.message.receive_v1': async data => {
      count.event += 1
      assert.equal(data.message.content, 'fixture-event')
    },
  })
  const client = new WSClient({
    appId: 'cli_0123456789abcdef', appSecret: 'fixture_only', logger,
  })
  client.eventDispatcher = dispatcher
  // Capture the real SDK instance's outgoing frames; no socket or fake client.
  client.sendMessage = outgoing => { sent.push(outgoing) }
  try {
    await client.handleEventData(frame('card', 'card.action.trigger', 'native-card'))
    assert.deepEqual(count, { card: 0, event: 0 })
    assert.equal(sent.length, 0)
    installLarkCardCallbackBridge(client)
    installLarkCardCallbackBridge(client)
    await client.handleEventData(frame('card', 'card.action.trigger', 'bridged-card'))
    assert.deepEqual(count, { card: 1, event: 0 })
    assert.equal(sent.length, 1)
    assert.ok(sent[0].headers.some(header => header.key === 'biz_rt'))
    const cardAck = JSON.parse(new TextDecoder().decode(sent[0].payload))
    assert.equal(cardAck.code, 200)
    assert.deepEqual(JSON.parse(Buffer.from(cardAck.data, 'base64').toString('utf8')),
      { card: { type: 'raw', data: { label: 'fixture-response' } } })
    await client.handleEventData(frame('event', 'im.message.receive_v1', 'native-event'))
    assert.deepEqual(count, { card: 1, event: 1 })
    assert.equal(sent.length, 2)
    assert.equal(JSON.parse(new TextDecoder().decode(sent[1].payload)).code, 200)
    console.log('native_card=discarded bridge_card=invoke_once_ack_200 event=invoke_once_ack_200')
  } finally {
    client.close({ force: true })
    console.log('fixture_resources=closed')
  }
}

if (mode === 'timeout') await handshakeFixture(false)
else if (mode === 'early-close') await handshakeFixture(true)
else if (mode === 'card') await cardFixture()
else throw new Error(`unknown fixture mode: ${mode}`)
