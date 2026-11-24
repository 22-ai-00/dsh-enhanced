import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSandboxGitHubHttpTransport } from './repo-sandbox-github-server.mjs'

async function main() {
  const configPath = process.argv[2]
  if (typeof configPath !== 'string' || configPath.length === 0) {
    throw new Error('repo-sandbox-broker-daemon requires config JSON path')
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const libDir = config.assistantActionsLibDir
  const { ExternalBrokerCore } = await import(pathToFileURL(join(libDir, 'broker-core.js')).href)
  const { startGitHubBrokerServer } = await import(pathToFileURL(join(libDir, 'broker-server.js')).href)
  const { inspectLinuxPeerCredentials } = await import(pathToFileURL(join(libDir, 'broker-peer-linux.js')).href)
  const { commitOnGitHub, createPullRequestOnGitHub, inspectGitHub } = await import(pathToFileURL(join(libDir, 'github.js')).href)

  const transport = createSandboxGitHubHttpTransport(config.githubBaseUrl)

  const core = new ExternalBrokerCore(
    {
      instanceId: config.instanceId,
      statePath: config.statePath,
      grants: config.grants,
      policyEpoch: config.policyEpoch,
      credentials: config.credentials,
    },
    {
      commit: input => commitOnGitHub(input, transport),
      pullRequest: input => createPullRequestOnGitHub(input, transport),
      inspect: input => inspectGitHub(input, transport),
    },
  )

  const server = await startGitHubBrokerServer({
    core,
    actionSocketPath: config.actionSocketPath,
    adminSocketPath: config.adminSocketPath,
    instanceId: config.instanceId,
    generation: core.snapshot().generation,
    serverPrivateKey: config.serverPrivateKeyPem,
    clientPublicKey: config.clientPublicKeyPem,
    clientKeyId: config.clientKeyId,
    adminPublicKey: config.adminPublicKeyPem,
    adminKeyId: config.adminKeyId,
    inspectPeerCredentials: inspectLinuxPeerCredentials,
    expectedClientPeerUid: config.uid,
    expectedClientPeerGid: config.gid,
    expectedAdminPeerUid: config.uid,
    expectedAdminPeerGid: config.gid,
    expectedActionSocketUid: config.uid,
    expectedActionSocketGid: config.gid,
    expectedActionParentMode: 0o700,
    expectedActionSocketMode: 0o600,
    expectedAdminSocketUid: config.uid,
    expectedAdminSocketGid: config.gid,
    expectedAdminParentMode: 0o700,
    expectedAdminSocketMode: 0o600,
  })

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    try {
      await server.stop()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })

  process.stdout.write(`READY ${process.pid}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
