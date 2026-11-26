import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMap, isSeq, parseDocument } from 'yaml'
import { startSandboxGitHubServer } from './repo-sandbox-github-server.mjs'

const initialOid = '1'.repeat(40)
const brokerDaemonScript = fileURLToPath(new URL('./repo-sandbox-broker-daemon.mjs', import.meta.url))

function configRow(document, id) {
  const find = node => {
    if (isMap(node)) { if (node.get('id') === id) return node; for (const item of node.items) { const found = find(item.value); if (found) return found } }
    if (isSeq(node)) for (const item of node.items) { const found = find(item); if (found) return found }
  }
  let row = find(document.contents)
  if (!row) { row = document.createNode({ id, name: `@dsh-ray/${id.slice('dsh-ray-'.length)}` }); document.contents.add(row) }
  if (!isMap(row)) throw new Error(`external fixture invalid ${id}`)
  if (!isMap(row.get('config', true))) row.set('config', document.createNode({}))
  return row
}

function literalDeliveryPath(node, home) {
  const value = node?.value
  if (typeof value !== 'string') throw new Error('external fixture delivery database path is not a literal')
  const match = /^dshHomePath\('([^']+)'\)$/u.exec(value)
  if (match) return join(home, match[1])
  if (value.startsWith('/')) return value
  throw new Error('external fixture delivery database path is not an installed path')
}

async function resolveShortSocketDir(home) {
  const candidate = join(dirname(home), 'bk')
  await mkdir(candidate, { recursive: true, mode: 0o700 })
  const canonicalCandidate = await realpath(candidate)
  if (Buffer.byteLength(join(canonicalCandidate, 'a.sock')) <= 100 && Buffer.byteLength(join(canonicalCandidate, 'm.sock')) <= 100) {
    return { socketDir: canonicalCandidate, ownedOutsideHome: false }
  }
  const canonicalTmp = await realpath(tmpdir())
  const fallback = await mkdtemp(join(canonicalTmp, 'dshb-'))
  if (Buffer.byteLength(join(fallback, 'a.sock')) > 100 || Buffer.byteLength(join(fallback, 'm.sock')) > 100) {
    await rm(fallback, { recursive: true, force: true })
    throw new Error('cannot allocate Unix broker socket path within 100-byte sun_path limit')
  }
  return { socketDir: fallback, ownedOutsideHome: true }
}

async function spawnSandboxBrokerDaemon(config) {
  const configPath = join(dirname(config.statePath), 'broker-daemon-config.json')
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  const child = spawn(process.execPath, [brokerDaemonScript, configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })

  let readyPid
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`sandbox broker daemon timed out before readiness: ${stderr}`))
    }, 15_000)
    const onData = chunk => {
      stdout += chunk
      const match = /^READY (\d+)\n/m.exec(stdout)
      if (match) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        readyPid = Number(match[1])
        resolveReady()
      }
    }
    child.stdout.on('data', onData)
    child.once('error', error => {
      clearTimeout(timer)
      rejectReady(error)
    })
    child.once('close', code => {
      clearTimeout(timer)
      rejectReady(new Error(`sandbox broker daemon exited early (${code}): ${stderr}`))
    })
  }).catch(async error => {
    try { child.kill('SIGKILL') } catch {}
    throw error
  })

  const actionStat = await lstat(config.actionSocketPath)
  const adminStat = await lstat(config.adminSocketPath)
  if (!actionStat.isSocket() || !adminStat.isSocket()) {
    try { child.kill('SIGKILL') } catch {}
    throw new Error('sandbox broker daemon did not bind real Unix domain sockets')
  }

  return {
    pid: readyPid ?? child.pid,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const closed = once(child, 'close')
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
      }, 10_000)
      try {
        await closed
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * Provisions real Ed25519 keys, Linux SO_PEERCRED Unix domain sockets, and an
 * external broker. By default (unless `DSH_REPO_SANDBOX_GIT === '0'`), runs a
 * real local bare Git repo + HTTP GitHub REST/GraphQL server and spawns a
 * separate-process ExternalBrokerCore daemon wrapping real `github.ts` calls.
 */
export async function prepareExternalRepositoryFixture(home, patchPath, env, { sessionId, workspace, objective, source }) {
  if (process.env.DSH_REPO_VERIFIED_DELIVERY !== 'fixture' || ![undefined, 'fixture'].includes(process.env.DSH_REPO_EVENT_SOURCE)) {
    throw new Error('external repository fixture requires fixture delivery and an optional fixture event source')
  }
  const events = process.env.DSH_REPO_EVENT_SOURCE === 'fixture'
  if (process.platform !== 'linux') throw new Error('external repository fixture requires the Linux protected-file credential backend')

  const actionsRoot = join(home, 'external-repository-broker')
  const keysRoot = join(actionsRoot, 'keys')
  await mkdir(keysRoot, { recursive: true, mode: 0o700 })

  const assistantActionsLibDir = join(home, 'profiles/web/node_modules/@dsh-ray/assistant-actions/lib')
  const delivery = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-ray/assistant-delivery/lib/index.js')).href)
  const { ExternalBrokerCore } = await import(pathToFileURL(join(assistantActionsLibDir, 'broker-core.js')).href)
  const { startGitHubBrokerServer } = await import(pathToFileURL(join(assistantActionsLibDir, 'broker-server.js')).href)
  const { withBrokerGrantDigest } = await import(pathToFileURL(join(assistantActionsLibDir, 'broker-ledger.js')).href)
  const { createBrokerGrantProjection } = await import(pathToFileURL(join(assistantActionsLibDir, 'broker-protocol.js')).href)
  const { inspectLinuxPeerCredentials, linuxPeerCredentialsAvailable } = await import(pathToFileURL(join(assistantActionsLibDir, 'broker-peer-linux.js')).href)
  if (!linuxPeerCredentialsAvailable()) throw new Error('external fixture requires real Linux SO_PEERCRED')

  const installed = parseDocument(await readFile(patchPath, 'utf8'))
  const ownerConfig = configRow(installed, 'dsh-ray-assistant-web-owner').get('config', true).toJSON()
  const deliveryConfig = configRow(installed, 'dsh-ray-assistant-delivery').get('config', true)
  const principal = ownerConfig.principal
  if (!principal || ownerConfig.workspace !== workspace || typeof ownerConfig.preset !== 'string') {
    throw new Error('external fixture installed owner scope is unavailable')
  }
  const deliveryDbPath = literalDeliveryPath(deliveryConfig.get('databasePath', true), home)
  let snapshot = delivery.inspectActiveWebOwnerBindingLocally({
    databasePath: deliveryDbPath,
    sessionId,
    expectedPrincipal: { channel: 'web', ...principal },
    workspace: ownerConfig.workspace,
    agentPreset: ownerConfig.preset,
  })
  for (let attempt = 0; attempt < 20 && snapshot.status === 'busy'; attempt += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    snapshot = delivery.inspectActiveWebOwnerBindingLocally({
      databasePath: deliveryDbPath,
      sessionId,
      expectedPrincipal: { channel: 'web', ...principal },
      workspace: ownerConfig.workspace,
      agentPreset: ownerConfig.preset,
    })
  }
  if (snapshot.status !== 'matched') {
    let leaseDiag = ''
    if (snapshot.status === 'busy') {
      try {
        const { DatabaseSync } = await import('node:sqlite')
        const db = new DatabaseSync(deliveryDbPath, { readOnly: true })
        try {
          const rows = db.prepare('SELECT session_id, state, holder_id, lease_until FROM delivery_session_leases').all()
          leaseDiag = ` (leases=${JSON.stringify(rows)})`
        } finally {
          db.close()
        }
      } catch (err) {
        leaseDiag = ` (sqliteErr=${err instanceof Error ? err.message : String(err)})`
      }
    }
    throw new Error(`external repository fixture owner snapshot ${snapshot.status}${leaseDiag}`)
  }
  const { binding, owner } = snapshot.snapshot
  const profile = principal.account
  if (typeof profile !== 'string' || typeof principal.tenant !== 'string' || typeof principal.user !== 'string') {
    throw new Error('external fixture installed owner principal is invalid')
  }
  const principalId = `web/${profile}/${principal.tenant}/${principal.user}`
  const admissionId = `goal-${createHash('sha256').update(JSON.stringify([profile, binding.id, owner.id, owner.version, objective])).digest('hex').slice(0, 24)}`
  const expiresAt = Date.now() + 420_000
  const grantId = 'external-repository-fixture'
  const uid = process.getuid()
  const gid = process.getgid()
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('external repository fixture requires Unix peer ids')

  const serverKeys = generateKeyPairSync('ed25519')
  const clientKeys = generateKeyPairSync('ed25519')
  const adminKeys = generateKeyPairSync('ed25519')
  const brokerPublicKeyPath = join(keysRoot, 'broker.pem')
  const clientSigningKeyPath = join(keysRoot, 'client.pem')
  const tokenPath = join(actionsRoot, 'broker-token')
  const brokerToken = 'fixture-broker-only-token'
  await writeFile(brokerPublicKeyPath, serverKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
  await writeFile(clientSigningKeyPath, clientKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(tokenPath, brokerToken, { mode: 0o600 })

  const authority = withBrokerGrantDigest({
    protocol: 'assistant-actions/external-github-grant/v1',
    id: grantId,
    revision: 1,
    clientKeyId: 'host',
    client: { kind: 'assistant-actions-host', instanceId: 'host', generation: 1 },
    owner: {
      principalDigest: createHash('sha256').update(principalId).digest('hex'),
      principalRecordId: owner.id,
      principalVersion: owner.version,
      workspace,
      preset: ownerConfig.preset,
      bindingId: binding.id,
      bindingVersion: binding.version,
      bindingGeneration: binding.generation,
    },
    sessionId,
    destination: {
      classification: 'github-repository',
      repository: 'fixture/orders',
      branch: 'automation/fix',
      baseBranch: 'main',
      paths: ['summarize.mjs'],
    },
    credentialId: 'broker-token',
    expiresAt,
    maxActions: events ? 850 : 8,
    maxTotalBytes: 1_048_576,
    maxCostUnits: events ? 1300 : 20,
    allowedOperations: ['commit', 'inspect', 'pull-request'],
    allowedInspectKinds: ['repository', 'branch', 'file', ...(events ? ['pull-request', 'checks', 'reviews'] : [])],
    verifiedDelivery: {
      ownerRouteId: admissionId,
      budgetId: `${admissionId}-runs`,
      ...(events ? { acceptance: 'goal-step' } : {}),
    },
    source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
    policyEpoch: 1,
    emergencyEpoch: 0,
  })

  const log = join(home, 'github-fixture.jsonl')
  env.DSH_REPO_DELIVERY_FIXTURE_LOG = log
  if (events) {
    env.DSH_REPO_EVENT_STATE = join(home, 'repository-event-fixture.json')
    env.DSH_REPO_EVENT_SOURCE_LOG = join(home, 'repository-event-source.jsonl')
    await writeFile(env.DSH_REPO_EVENT_STATE, '{"ready":false}', { mode: 0o600 })
  }

  const useSandboxGitHttp = process.env.DSH_REPO_SANDBOX_GIT !== '0'

  if (useSandboxGitHttp) {
    const { socketDir, ownedOutsideHome } = await resolveShortSocketDir(home)
    const actionSocketPath = join(socketDir, 'a.sock')
    const adminSocketPath = join(socketDir, 'm.sock')
    if (Buffer.byteLength(actionSocketPath) > 100 || Buffer.byteLength(adminSocketPath) > 100) {
      throw new Error('Unix broker socket path exceeds 100 bytes')
    }
    const repoPath = join(dirname(home), 'sandbox-remote.git')
    const githubServer = await startSandboxGitHubServer({
      repoPath,
      repository: 'fixture/orders',
      baseBranch: 'main',
      branch: 'automation/fix',
      initialFiles: [{ path: 'summarize.mjs', content: source }],
      expectedToken: brokerToken,
      deliveryLogPath: log,
      eventStatePath: env.DSH_REPO_EVENT_STATE,
      eventSourceLogPath: env.DSH_REPO_EVENT_SOURCE_LOG,
    })

    let daemon
    try {
      daemon = await spawnSandboxBrokerDaemon({
        assistantActionsLibDir,
        githubBaseUrl: githubServer.url,
        instanceId: 'broker',
        statePath: join(actionsRoot, 'state.sqlite'),
        grants: [authority],
        policyEpoch: 1,
        credentials: [{ id: 'broker-token', provider: 'linux-protected-file', path: tokenPath, maxLeaseMs: 30_000 }],
        actionSocketPath,
        adminSocketPath,
        serverPrivateKeyPem: serverKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        clientPublicKeyPem: clientKeys.publicKey.export({ type: 'spki', format: 'pem' }),
        clientKeyId: 'host',
        adminPublicKeyPem: adminKeys.publicKey.export({ type: 'spki', format: 'pem' }),
        adminKeyId: 'admin',
        uid,
        gid,
      })

      const { digest: _digest, ...unsigned } = authority
      const projection = createBrokerGrantProjection(unsigned)
      configRow(installed, 'dsh-ray-assistant-actions').set('config', installed.createNode({
        stateRoot: join(home, 'assistant-actions/web'),
        grants: [],
        externalGrants: [projection],
        broker: {
          mode: 'external-unix-v1',
          actionSocketPath,
          brokerId: 'broker',
          brokerPublicKeyPath,
          clientSigningKeyPath,
          clientKeyId: 'host',
          clientInstanceId: 'host',
          clientGeneration: 1,
          expectedSocketUid: uid,
          expectedSocketGid: gid,
          expectedSocketMode: 0o600,
          expectedSocketParentUid: uid,
          expectedSocketParentGid: gid,
          expectedSocketParentMode: 0o700,
          expectedBrokerPeerUid: uid,
          expectedBrokerPeerGid: gid,
          minimumBrokerGeneration: 1,
        },
      }))
      await writeFile(patchPath, String(installed), { mode: 0o600 })
      env.DSH_REPO_DELIVERY_FIXTURE_LOG = log
      env.DSH_REPO_SANDBOX_GIT_DIR = repoPath
      env.DSH_REPO_SANDBOX_GITHUB_URL = githubServer.url
      env.DSH_REPO_SANDBOX_INITIAL_OID = githubServer.initialOid
      env.DSH_REPO_SANDBOX_BROKER_PID = String(daemon.pid)

      return {
        repository: 'fixture/orders',
        baseBranch: 'main',
        branch: 'automation/fix',
        paths: ['summarize.mjs'],
        externalGrantId: grantId,
        expiresAt,
        maxActions: authority.maxActions,
        maxTotalBytes: 1_048_576,
        openPullRequest: true,
        sandboxGit: {
          repoPath,
          initialOid: githubServer.initialOid,
          url: githubServer.url,
          brokerPid: daemon.pid,
        },
        ...(events ? {
          acceptance: 'goal-step',
          outcome: { requiredChecks: [{ name: 'tests', appId: 7 }], reviewerIds: [42], minApprovals: 1, timeoutMs: 10000, freshnessMs: 30000 },
          events: { maxPolls: 180, maxFires: 4, pollIntervalMs: 2000, requestTimeoutMs: 10000 },
        } : {}),
        close: async () => {
          try { await daemon.stop() } finally {
            try { await githubServer.close() } finally {
              if (ownedOutsideHome) await rm(socketDir, { recursive: true, force: true })
            }
          }
        },
      }
    } catch (error) {
      await daemon?.stop().catch(() => {})
      await githubServer.close().catch(() => {})
      if (ownedOutsideHome) await rm(socketDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  // Legacy in-process JSONL stub fallback when DSH_REPO_SANDBOX_GIT === '0'.
  const record = row => appendFileSync(log, `${JSON.stringify(row)}\n`, { mode: 0o600 })
  const remoteSnapshot = () => {
    const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const committed = rows.find(row => row.kind === 'commit')
    const created = rows.find(row => row.kind === 'pr')
    const ready = events && JSON.parse(readFileSync(env.DSH_REPO_EVENT_STATE, 'utf8')).ready === true
    const headOid = committed?.commitOid ?? initialOid
    const pullRequest = created ? { number: 17, state: 'open', merged: false, head: { ref: 'automation/fix', sha: headOid, repo: { full_name: 'fixture/orders' } }, base: { ref: 'main', repo: { full_name: 'fixture/orders' } } } : null
    const checks = [{ id: 1, name: 'tests', app: { id: 7 }, head_sha: headOid, status: ready ? 'completed' : 'in_progress', conclusion: ready ? 'success' : null }]
    const reviews = ready && pullRequest ? [{ id: 1, user: { id: 42 }, commit_id: headOid, state: 'APPROVED' }] : []
    return { ready, headOid, pullRequest, checks, reviews }
  }
  const { socketDir, ownedOutsideHome } = await resolveShortSocketDir(home)
  const actionSocketPath = join(socketDir, 'a.sock')
  const adminSocketPath = join(socketDir, 'm.sock')
  const core = new ExternalBrokerCore({
    instanceId: 'broker',
    statePath: join(actionsRoot, 'state.sqlite'),
    grants: [authority],
    policyEpoch: 1,
    credentials: [{ id: 'broker-token', provider: 'linux-protected-file', path: tokenPath, maxLeaseMs: 30_000 }],
  }, {
    commit: async input => {
      input.signal.throwIfAborted()
      if (input.request.expectedHeadOid !== initialOid) throw new Error('fixture head mismatch')
      const commitOid = createHash('sha1').update(JSON.stringify(input.request.files)).digest('hex')
      record({ kind: 'commit', at: Date.now(), actionId: input.actionId, commitOid, files: input.request.files })
      return { actionId: input.actionId, status: 'succeeded', commitOid }
    },
    pullRequest: async input => {
      input.signal.throwIfAborted()
      record({ kind: 'pr', at: Date.now(), actionId: input.actionId, headOid: input.expectedHeadOid, number: 17 })
      return { actionId: input.actionId, status: 'succeeded', pullRequestNumber: 17 }
    },
    inspect: async input => {
      input.signal.throwIfAborted()
      const state = remoteSnapshot()
      if (events) {
        const entry = { kind: input.kind, ready: state.ready, headOid: state.headOid, pullRequest: state.pullRequest?.number ?? null, at: Date.now() }
        appendFileSync(env.DSH_REPO_EVENT_SOURCE_LOG, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
        appendFileSync(`${log}.readbacks`, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      }
      if (input.kind === 'branch') return { observed: { name: 'automation/fix', commit: { sha: state.headOid }, untrusted: true } }
      if (input.kind === 'repository') return { observed: { full_name: 'fixture/orders', untrusted: true } }
      if (input.kind === 'file' && input.path === 'summarize.mjs') return { observed: { path: input.path, sha: createHash('sha1').update(source).digest('hex'), content: source, untrusted: true } }
      if (events && state.pullRequest && input.pullRequestNumber === 17) {
        if (input.kind === 'pull-request') return { observed: { ...state.pullRequest, untrusted: true } }
        if (input.kind === 'checks' || input.kind === 'reviews') return { observed: { pullRequest: state.pullRequest, headOid: state.headOid, items: input.kind === 'checks' ? state.checks : state.reviews, truncated: false, untrusted: true } }
      }
      throw new Error('external repository fixture inspection is outside its scope')
    },
  })
  const server = await startGitHubBrokerServer({
    core,
    actionSocketPath,
    adminSocketPath,
    instanceId: 'broker',
    generation: core.snapshot().generation,
    serverPrivateKey: serverKeys.privateKey,
    clientPublicKey: clientKeys.publicKey,
    clientKeyId: 'host',
    adminPublicKey: adminKeys.publicKey,
    adminKeyId: 'admin',
    inspectPeerCredentials: inspectLinuxPeerCredentials,
    expectedClientPeerUid: uid,
    expectedClientPeerGid: gid,
    expectedAdminPeerUid: uid,
    expectedAdminPeerGid: gid,
    expectedActionSocketUid: uid,
    expectedActionSocketGid: gid,
    expectedActionParentMode: 0o700,
    expectedActionSocketMode: 0o600,
    expectedAdminSocketUid: uid,
    expectedAdminSocketGid: gid,
    expectedAdminParentMode: 0o700,
    expectedAdminSocketMode: 0o600,
  })
  try {
    const { digest: _digest, ...unsigned } = authority
    const projection = createBrokerGrantProjection(unsigned)
    configRow(installed, 'dsh-ray-assistant-actions').set('config', installed.createNode({
      stateRoot: join(home, 'assistant-actions/web'),
      grants: [],
      externalGrants: [projection],
      broker: {
        mode: 'external-unix-v1',
        actionSocketPath,
        brokerId: 'broker',
        brokerPublicKeyPath,
        clientSigningKeyPath,
        clientKeyId: 'host',
        clientInstanceId: 'host',
        clientGeneration: 1,
        expectedSocketUid: uid,
        expectedSocketGid: gid,
        expectedSocketMode: 0o600,
        expectedSocketParentUid: uid,
        expectedSocketParentGid: gid,
        expectedSocketParentMode: 0o700,
        expectedBrokerPeerUid: uid,
        expectedBrokerPeerGid: gid,
        minimumBrokerGeneration: 1,
      },
    }))
    await writeFile(patchPath, String(installed), { mode: 0o600 })
    env.DSH_REPO_DELIVERY_FIXTURE_LOG = log
    return {
      repository: 'fixture/orders',
      baseBranch: 'main',
      branch: 'automation/fix',
      paths: ['summarize.mjs'],
      externalGrantId: grantId,
      expiresAt,
      maxActions: authority.maxActions,
      maxTotalBytes: 1_048_576,
      openPullRequest: true,
      ...(events ? {
        acceptance: 'goal-step',
        outcome: { requiredChecks: [{ name: 'tests', appId: 7 }], reviewerIds: [42], minApprovals: 1, timeoutMs: 10000, freshnessMs: 30000 },
        events: { maxPolls: 180, maxFires: 4, pollIntervalMs: 2000, requestTimeoutMs: 10000 },
      } : {}),
      close: async () => {
        try { await server.stop() } finally {
          if (ownedOutsideHome) await rm(socketDir, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await server.stop()
    if (ownedOutsideHome) await rm(socketDir, { recursive: true, force: true })
    throw error
  }
}
