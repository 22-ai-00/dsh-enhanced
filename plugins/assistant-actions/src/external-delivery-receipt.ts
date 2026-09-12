import { createPublicKey } from 'node:crypto'
import type { GitHubBrokerClientOptions } from './broker-client.js'
import {
  brokerDigest, verifyBrokerClientRequest, verifyBrokerServerHello, verifyBrokerServerResponse,
  type BrokerClientRequest, type BrokerOperationPayload, type BrokerRequestIntent, type BrokerServerHello, type BrokerServerResponse,
} from './broker-protocol.js'

/** Signed history without artifact bytes; reconstruct payload from current accepted artifacts. */
export interface ExternalDeliveryReceipt {
  hello: BrokerServerHello
  request: Omit<BrokerClientRequest, 'payload'>
  response: BrokerServerResponse
}

export function captureExternalDeliveryReceipt(hello: BrokerServerHello, request: BrokerClientRequest, response: BrokerServerResponse): ExternalDeliveryReceipt {
  const { payload: _payload, ...header } = request
  return structuredClone({ hello, request: header, response })
}

export function verifyExternalDeliveryReceipt(receipt: ExternalDeliveryReceipt, payload: BrokerOperationPayload,
  expected: Pick<BrokerRequestIntent, 'actionId' | 'grantId' | 'grantRevision' | 'grantDigest' | 'owner' | 'sessionId' | 'operation' | 'source' | 'destination'>,
  client: GitHubBrokerClientOptions): BrokerServerResponse {
  // This verifies historical signatures, not present authority or remote freshness.
  // The caller independently revalidates owner/goal/grant and performs fresh reads.
  const historicalTime = Math.min(receipt.hello.expiresAt, receipt.request.deadline) - 1
  const hello = verifyBrokerServerHello(receipt.hello, client.serverPublicKey, { now: historicalTime })
  const request = verifyBrokerClientRequest({ ...receipt.request, payload }, hello, createPublicKey(client.clientPrivateKey),
    { now: historicalTime, expectedClientKeyId: client.clientKeyId })
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (brokerDigest(request[key]) !== brokerDigest(expected[key])) throw new Error('assistant-actions: external delivery receipt scope mismatch')
  }
  if (request.client.instanceId !== client.source.instanceId || request.client.kind !== client.source.kind
    || hello.instanceId !== client.expectedServerInstanceId) throw new Error('assistant-actions: external delivery receipt identity mismatch')
  const response = verifyBrokerServerResponse(receipt.response, request, hello, client.serverPublicKey)
  if (response.status !== 'succeeded') throw new Error('assistant-actions: external delivery receipt is not successful')
  return response
}
