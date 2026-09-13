import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMap, isSeq, parseDocument } from 'yaml'

const initialOid = '1'.repeat(40)

function configRow(document, id) {
  const find = node => {
    if (isMap(node)) { if (node.get('id') === id) return node; for (const item of node.items) { const found = find(item.value); if (found) return found } }
    if (isSeq(node)) for (const item of node.items) { const found = find(item); if (found) return found }
  }
  let row = find(document.contents)
  if (!row) { row = document.createNode({ id, name: `@dsh-enhanced/${id.slice('dsh-enhanced-'.length)}` }); document.contents.add(row) }
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

/** Real signed UDS server/Core/Ledger and Linux peer checks; GitHub transport is a fixture. */
export async function prepareExternalRepositoryFixture(home, patchPath, env, { sessionId, workspace, objective, source }) {
  if (process.env.DSH_REPO_VERIFIED_DELIVERY !== 'fixture' || ![undefined, 'fixture'].includes(process.env.DSH_REPO_EVENT_SOURCE)) throw new Error('external repository fixture requires fixture delivery and an optional fixture event source')
  const events = process.env.DSH_REPO_EVENT_SOURCE === 'fixture'
  if (process.platform !== 'linux') throw new Error('external repository fixture requires the Linux protected-file credential backend')
  const actionsRoot = join(home, 'external-repository-broker'), keysRoot = join(actionsRoot, 'keys')
  await mkdir(keysRoot, { recursive: true, mode: 0o700 })
  const delivery = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-delivery/lib/index.js')).href)
  const { ExternalBrokerCore } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-actions/lib/broker-core.js')).href)
  const { startGitHubBrokerServer } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-actions/lib/broker-server.js')).href)
  const { withBrokerGrantDigest } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-actions/lib/broker-ledger.js')).href)
  const { createBrokerGrantProjection } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-actions/lib/broker-protocol.js')).href)
  const { inspectLinuxPeerCredentials, linuxPeerCredentialsAvailable } = await import(pathToFileURL(join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-actions/lib/broker-peer-linux.js')).href)
  if (!linuxPeerCredentialsAvailable()) throw new Error('external fixture requires real Linux SO_PEERCRED')
  const installed = parseDocument(await (await import('node:fs/promises')).readFile(patchPath, 'utf8'))
  const ownerConfig = configRow(installed, 'dsh-enhanced-assistant-web-owner').get('config', true).toJSON()
  const deliveryConfig = configRow(installed, 'dsh-enhanced-assistant-delivery').get('config', true)
  const principal = ownerConfig.principal
  if (!principal || ownerConfig.workspace !== workspace || typeof ownerConfig.preset !== 'string') throw new Error('external fixture installed owner scope is unavailable')
  const snapshot = delivery.inspectActiveWebOwnerBindingLocally({ databasePath: literalDeliveryPath(deliveryConfig.get('databasePath', true), home), sessionId,
    expectedPrincipal: { channel: 'web', ...principal }, workspace: ownerConfig.workspace, agentPreset: ownerConfig.preset })
  if (snapshot.status !== 'matched') throw new Error(`external repository fixture owner snapshot ${snapshot.status}`)
  const { binding, owner } = snapshot.snapshot
  const profile = principal.account
  if (typeof profile !== 'string' || typeof principal.tenant !== 'string' || typeof principal.user !== 'string') throw new Error('external fixture installed owner principal is invalid')
  const principalId = `web/${profile}/${principal.tenant}/${principal.user}`
  const admissionId = `goal-${createHash('sha256').update(JSON.stringify([profile, binding.id, owner.id, owner.version, objective])).digest('hex').slice(0, 24)}`
  const expiresAt = Date.now() + 420_000, grantId = 'external-repository-fixture', uid = process.getuid(), gid = process.getgid()
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('external repository fixture requires Unix peer ids')
  const serverKeys = generateKeyPairSync('ed25519'), clientKeys = generateKeyPairSync('ed25519'), adminKeys = generateKeyPairSync('ed25519')
  const brokerPublicKeyPath = join(keysRoot, 'broker.pem'), clientSigningKeyPath = join(keysRoot, 'client.pem'), tokenPath = join(actionsRoot, 'broker-token')
  await writeFile(brokerPublicKeyPath, serverKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
  await writeFile(clientSigningKeyPath, clientKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(tokenPath, 'fixture-broker-only-token', { mode: 0o600 })
  const authority = withBrokerGrantDigest({ protocol: 'assistant-actions/external-github-grant/v1', id: grantId, revision: 1, clientKeyId: 'host',
    client: { kind: 'assistant-actions-host', instanceId: 'host', generation: 1 }, owner: { principalDigest: createHash('sha256').update(principalId).digest('hex'), principalRecordId: owner.id, principalVersion: owner.version,
      workspace, preset: ownerConfig.preset, bindingId: binding.id, bindingVersion: binding.version, bindingGeneration: binding.generation }, sessionId,
    destination: { classification: 'github-repository', repository: 'fixture/orders', branch: 'automation/fix', baseBranch: 'main', paths: ['summarize.mjs'] }, credentialId: 'broker-token', expiresAt,
    maxActions: events ? 850 : 8, maxTotalBytes: 1_048_576, maxCostUnits: events ? 1300 : 20, allowedOperations: ['commit', 'inspect', 'pull-request'], allowedInspectKinds: ['repository', 'branch', 'file', ...(events ? ['pull-request', 'checks', 'reviews'] : [])],
    verifiedDelivery: { ownerRouteId: admissionId, budgetId: `${admissionId}-runs`, ...(events ? { acceptance: 'goal-step' } : {}) }, source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) }, policyEpoch: 1, emergencyEpoch: 0 })
  const log = join(home, 'github-fixture.jsonl'), record = row => appendFileSync(log, `${JSON.stringify(row)}\n`, { mode: 0o600 })
  env.DSH_REPO_DELIVERY_FIXTURE_LOG = log
  if (events) {
    env.DSH_REPO_EVENT_STATE = join(home, 'repository-event-fixture.json')
    env.DSH_REPO_EVENT_SOURCE_LOG = join(home, 'repository-event-source.jsonl')
    await writeFile(env.DSH_REPO_EVENT_STATE, '{"ready":false}', { mode: 0o600 })
  }
  const remoteSnapshot = () => {
    const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const committed = rows.find(row => row.kind === 'commit'), created = rows.find(row => row.kind === 'pr')
    const ready = events && JSON.parse(readFileSync(env.DSH_REPO_EVENT_STATE, 'utf8')).ready === true
    const headOid = committed?.commitOid ?? initialOid
    const pullRequest = created ? { number: 17, state: 'open', merged: false, head: { ref: 'automation/fix', sha: headOid, repo: { full_name: 'fixture/orders' } }, base: { ref: 'main', repo: { full_name: 'fixture/orders' } } } : null
    const checks = [{ id: 1, name: 'tests', app: { id: 7 }, head_sha: headOid, status: ready ? 'completed' : 'in_progress', conclusion: ready ? 'success' : null }]
    const reviews = ready && pullRequest ? [{ id: 1, user: { id: 42 }, commit_id: headOid, state: 'APPROVED' }] : []
    return { ready, headOid, pullRequest, checks, reviews }
  }
  const actionSocketPath = join(actionsRoot, 'action.sock'), adminSocketPath = join(actionsRoot, 'admin.sock')
  const core = new ExternalBrokerCore({ instanceId: 'broker', statePath: join(actionsRoot, 'state.sqlite'), grants: [authority], policyEpoch: 1,
    credentials: [{ id: 'broker-token', provider: 'linux-protected-file', path: tokenPath, maxLeaseMs: 30_000 }] }, {
    commit: async input => { input.signal.throwIfAborted(); if (input.request.expectedHeadOid !== initialOid) throw new Error('fixture head mismatch'); const commitOid = createHash('sha1').update(JSON.stringify(input.request.files)).digest('hex'); record({ kind: 'commit', at: Date.now(), actionId: input.actionId, commitOid, files: input.request.files }); return { actionId: input.actionId, status: 'succeeded', commitOid } },
    pullRequest: async input => { input.signal.throwIfAborted(); record({ kind: 'pr', at: Date.now(), actionId: input.actionId, headOid: input.expectedHeadOid, number: 17 }); return { actionId: input.actionId, status: 'succeeded', pullRequestNumber: 17 } },
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
  const server = await startGitHubBrokerServer({ core, actionSocketPath, adminSocketPath, instanceId: 'broker', generation: core.snapshot().generation,
    serverPrivateKey: serverKeys.privateKey, clientPublicKey: clientKeys.publicKey, clientKeyId: 'host', adminPublicKey: adminKeys.publicKey, adminKeyId: 'admin', inspectPeerCredentials: inspectLinuxPeerCredentials,
    expectedClientPeerUid: uid, expectedClientPeerGid: gid, expectedAdminPeerUid: uid, expectedAdminPeerGid: gid, expectedActionSocketUid: uid, expectedActionSocketGid: gid, expectedActionParentMode: 0o700, expectedActionSocketMode: 0o600, expectedAdminSocketUid: uid, expectedAdminSocketGid: gid, expectedAdminParentMode: 0o700, expectedAdminSocketMode: 0o600 })
  try {
    const { digest: _digest, ...unsigned } = authority, projection = createBrokerGrantProjection(unsigned)
    configRow(installed, 'dsh-enhanced-assistant-actions').set('config', installed.createNode({ stateRoot: join(home, 'assistant-actions/web'), grants: [], externalGrants: [projection], broker: { mode: 'external-unix-v1', actionSocketPath, brokerId: 'broker', brokerPublicKeyPath, clientSigningKeyPath, clientKeyId: 'host', clientInstanceId: 'host', clientGeneration: 1, expectedSocketUid: uid, expectedSocketGid: gid, expectedSocketMode: 0o600, expectedSocketParentUid: uid, expectedSocketParentGid: gid, expectedSocketParentMode: 0o700, expectedBrokerPeerUid: uid, expectedBrokerPeerGid: gid, minimumBrokerGeneration: 1 } }))
    await writeFile(patchPath, String(installed), { mode: 0o600 }); env.DSH_REPO_DELIVERY_FIXTURE_LOG = log
    return { repository: 'fixture/orders', baseBranch: 'main', branch: 'automation/fix', paths: ['summarize.mjs'], externalGrantId: grantId, expiresAt, maxActions: authority.maxActions, maxTotalBytes: 1_048_576, openPullRequest: true,
      ...(events ? { acceptance: 'goal-step', outcome: { requiredChecks: [{ name: 'tests', appId: 7 }], reviewerIds: [42], minApprovals: 1, timeoutMs: 10000, freshnessMs: 30000 },
        events: { maxPolls: 180, maxFires: 4, pollIntervalMs: 2000, requestTimeoutMs: 10000 } } : {}), close: () => server.stop() }
  } catch (error) { await server.stop(); throw error }
}
