import { generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExternalBrokerCore } from '../src/broker-core.ts'
import { withBrokerGrantDigest } from '../src/broker-ledger.ts'
import { createBrokerGrantProjection } from '../src/broker-protocol.ts'
import { startGitHubBrokerServer } from '../src/broker-server.ts'
import { requestGitHubBroker } from '../src/broker-client.ts'
import type { ActionGrant } from '../src/types.ts'
import type { Config } from '../src/config.ts'

/** Real signed socket/core/SQLite; only GitHub transport and kernel peer probe are fixtures. */
export async function externalDeliveryFixture(root: string, grant: ActionGrant, transports: ConstructorParameters<typeof ExternalBrokerCore>[1]) {
  const keys = generateKeyPairSync('ed25519'), clientKeys = generateKeyPairSync('ed25519'), adminKeys = generateKeyPairSync('ed25519')
  const uid = process.getuid!(), gid = process.getgid!(), brokerRoot = join(root, 'broker'), keyRoot = join(root, 'keys')
  await mkdir(brokerRoot, { mode: 0o700 }); await mkdir(keyRoot, { mode: 0o700 })
  const tokenPath = join(brokerRoot, 'token'), brokerPublicKeyPath = join(keyRoot, 'broker.pem'), clientSigningKeyPath = join(keyRoot, 'client.pem')
  await writeFile(tokenPath, 'external-only-fixture-secret', { mode: 0o600 })
  await writeFile(brokerPublicKeyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
  await writeFile(clientSigningKeyPath, clientKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const authority = withBrokerGrantDigest({ protocol: 'assistant-actions/external-github-grant/v1', id: grant.id, revision: grant.revision,
    clientKeyId: 'host', client: { kind: 'assistant-actions-host', instanceId: 'host', generation: 1 },
    owner: { principalDigest: grant.principalDigest, principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion,
      workspace: grant.workspace, preset: grant.agentPreset, bindingId: 'binding', bindingVersion: 1, bindingGeneration: 1 }, sessionId: 'owner-session',
    destination: { classification: 'github-repository', repository: grant.repository, branch: grant.branch, baseBranch: grant.repoWorkflow!.baseBranch, paths: grant.paths },
    credentialId: 'github', expiresAt: grant.expiresAt, maxActions: grant.maxActions, maxTotalBytes: grant.maxTotalBytes, maxCostUnits: 100,
    allowedOperations: grant.repoWorkflow!.allowPullRequest ? ['commit', 'inspect', 'pull-request'] : ['commit', 'inspect'],
    allowedInspectKinds: grant.repoWorkflow!.allowPullRequest ? ['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews'] : ['repository', 'branch', 'file', 'commit-checks'],
    verifiedDelivery: grant.verifiedDelivery!, source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) }, policyEpoch: 1, emergencyEpoch: 0 })
  const coreConfig = { instanceId: 'broker', statePath: join(brokerRoot, 'state.sqlite'), grants: [authority], policyEpoch: 1,
    credentials: [{ id: 'github', provider: 'linux-protected-file' as const, path: tokenPath, maxLeaseMs: 30_000 }] }
  const peer = () => ({ uid, gid, pid: process.pid })
  const actionSocketPath = join(brokerRoot, 'action.sock'), adminSocketPath = join(brokerRoot, 'admin.sock')
  const start = async () => {
    const core = new ExternalBrokerCore(coreConfig, transports)
    return await startGitHubBrokerServer({ core, actionSocketPath, adminSocketPath, instanceId: 'broker', generation: core.snapshot().generation,
      serverPrivateKey: keys.privateKey, clientPublicKey: clientKeys.publicKey, clientKeyId: 'host', adminPublicKey: adminKeys.publicKey, adminKeyId: 'admin',
      inspectPeerCredentials: peer, expectedClientPeerUid: uid, expectedClientPeerGid: gid, expectedAdminPeerUid: uid, expectedAdminPeerGid: gid,
      expectedActionSocketUid: uid, expectedActionSocketGid: gid, expectedActionParentMode: 0o700, expectedActionSocketMode: 0o600,
      expectedAdminSocketUid: uid, expectedAdminSocketGid: gid, expectedAdminParentMode: 0o700, expectedAdminSocketMode: 0o600 })
  }
  const { digest: _digest, ...unsigned } = authority
  const projection = createBrokerGrantProjection(unsigned)
  let server = await start()
  const config: Config = { stateRoot: join(root, 'actions'), externalGrants: [projection], broker: { mode: 'external-unix-v1',
    actionSocketPath, brokerId: 'broker', brokerPublicKeyPath, clientSigningKeyPath, clientKeyId: 'host', clientInstanceId: 'host', clientGeneration: 1,
    expectedSocketUid: uid, expectedSocketGid: gid, expectedSocketMode: 0o600, expectedSocketParentUid: uid, expectedSocketParentGid: gid, expectedSocketParentMode: 0o700,
    expectedBrokerPeerUid: uid, expectedBrokerPeerGid: gid, minimumBrokerGeneration: 1 } }
  const dispatch: typeof requestGitHubBroker = (options, intent, signal) => requestGitHubBroker({ ...options, inspectPeerCredentials: peer }, intent, signal)
  return { config, dispatch, close: () => server.stop(), restart: async () => { await server.stop(); server = await start() } }
}
