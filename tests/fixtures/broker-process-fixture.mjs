import { createPrivateKey, createPublicKey } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { createExternalBrokerCore } from '../../plugins/assistant-actions/lib/broker-core.js'
import { inspectLinuxPeerCredentials } from '../../plugins/assistant-actions/lib/broker-peer-linux.js'
import { startGitHubBrokerServer } from '../../plugins/assistant-actions/lib/broker-server.js'

const configPath = process.argv[2]
if (!configPath) throw new Error('fixture config path required')

const config = JSON.parse(await readFile(configPath, 'utf8'))
const serverPrivateKey = createPrivateKey(await readFile(config.serverPrivateKeyPath))
const clientPublicKey = createPublicKey(await readFile(config.clientPublicKeyPath))
const adminPublicKey = createPublicKey(await readFile(config.adminPublicKeyPath))

const core = createExternalBrokerCore({
  instanceId: config.brokerId,
  statePath: config.statePath,
  credentials: config.credentials,
  grants: config.grants,
  policyEpoch: config.policyEpoch,
  controllerTtlMs: config.controllerTtlMs,
  credentialMaxBytes: config.credentialMaxBytes,
}, {
  commit: async input => {
    await appendFile(config.transportLogPath, JSON.stringify({ actionId: input.actionId, operation: 'commit' }) + '\n', { mode: 0o600 })
    if (process.send) process.send({ event: 'dispatch', actionId: input.actionId })
    await new Promise((resolve, reject) => {
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
    })
    return { actionId: input.actionId, status: 'unknown', reason: 'aborted' }
  },
})

let server
let resolveStopped
const stopped = new Promise(resolve => { resolveStopped = resolve })
const proxyCore = {
  snapshot: () => core.snapshot(),
  execute: (request, signal) => core.execute(request, signal),
  beginDrain: reason => core.beginDrain(reason),
  drain: deadlineAt => core.drain(deadlineAt),
  close: () => core.close(),
  admin: async (request, signal) => {
    const response = await core.admin(request, signal)
    if (request.operation === 'stop' && response.status === 'succeeded') {
      setImmediate(() => {
        void server.stop('admin', config.drainTimeoutMs).then(() => { process.exitCode = 0; resolveStopped() }, () => { process.exitCode = 1; resolveStopped() })
      })
    }
    return response
  },
}

server = await startGitHubBrokerServer({
  actionSocketPath: config.actionSocketPath,
  adminSocketPath: config.adminSocketPath,
  instanceId: config.brokerId,
  generation: core.snapshot().generation,
  serverPrivateKey,
  clientPublicKey,
  clientKeyId: config.clientKeyId,
  adminPublicKey,
  adminKeyId: config.adminKeyId,
  core: proxyCore,
  inspectPeerCredentials: inspectLinuxPeerCredentials,
  expectedClientPeerUid: config.expectedClientPeerUid,
  expectedClientPeerGid: config.expectedClientPeerGid,
  expectedAdminPeerUid: config.expectedAdminPeerUid,
  expectedAdminPeerGid: config.expectedAdminPeerGid,
  expectedActionSocketUid: config.expectedActionSocketUid,
  expectedActionSocketGid: config.expectedActionSocketGid,
  expectedActionParentMode: config.expectedActionParentMode,
  expectedActionSocketMode: config.expectedActionSocketMode,
  expectedAdminSocketUid: config.expectedAdminSocketUid,
  expectedAdminSocketGid: config.expectedAdminSocketGid,
  expectedAdminParentMode: config.expectedAdminParentMode,
  expectedAdminSocketMode: config.expectedAdminSocketMode,
  maxActionConnections: config.maxActionConnections,
  maxAdminConnections: config.maxAdminConnections,
  maxConcurrentRequests: config.maxConcurrentRequests,
  firstByteTimeoutMs: Math.min(2_000, config.requestTimeoutMs),
  frameTimeoutMs: Math.min(10_000, config.requestTimeoutMs),
  totalTimeoutMs: config.requestTimeoutMs,
  helloTtlMs: config.helloTtlMs,
  drainTimeoutMs: config.drainTimeoutMs,
})

if (process.send) process.send({ event: 'ready', generation: core.snapshot().generation })
await Promise.race([stopped, new Promise(resolve => {
  const stop = () => {
    void server.stop('sigterm', config.drainTimeoutMs).finally(resolve)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
})])
