#!/usr/bin/env node
// Explicit opt-in: disposable actual DSH processes, no prompts or production profile writes.
import assert from 'node:assert/strict'
import { prepareRealHostControlPackage } from './real-host-control-package.mjs'
import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { queryReplayEndpoint } from '../../plugins/plugin-control-plane/lib/replay-endpoint.js'
import { queryRuntimeObserver, runtimeConfigDigest } from '../../plugins/plugin-control-plane/lib/runtime-observer.js'
import { hostAttestationRequestDigest } from '../../plugins/plugin-control-plane/lib/attestation.js'
import { replayGrantSigningPayload } from '../../plugins/plugin-control-plane/lib/replay-grant.js'

if (process.platform !== 'linux' || process.env.DSH_REPLAY_FIXTURE !== '1' || !process.env.DSH_REPLAY_DSH) {
  throw new Error('requires Linux, DSH_REPLAY_FIXTURE=1 and DSH_REPLAY_DSH=/absolute/path/to/dsh')
}
const outputIndex = process.argv.indexOf('--output')
const output = outputIndex < 0 ? undefined : process.argv[outputIndex + 1]
if (!output || output.startsWith('--')) throw new Error('--output is required')
const run = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-replay-')))
const home = join(root, 'home'), owner = join(root, 'owner')
const name = `replay-${process.pid}-${randomUUID().slice(0, 8)}`
const profile = join(home, 'profiles', name), unit = `dsh-profile-${name}.service`
const dsh = await realpath(process.env.DSH_REPLAY_DSH), node = await realpath(process.execPath)
const controlPackage = join(owner, 'control-package')
const policyUrl = new URL('../../plugins/assistant-policy/lib/index.js', import.meta.url)
const deliveryUrl = new URL('../../plugins/assistant-delivery/lib/index.js', import.meta.url)
const supervisor = async args => (await run('/usr/bin/systemctl', ['--user', ...args], { timeout: 15000, maxBuffer: 65536 })).stdout
const state = async () => Object.fromEntries((await supervisor(['show', unit, '--property=MainPID', '--property=InvocationID',
  '--property=ActiveState', '--property=LoadState'])).trim().split('\n').map(line => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]
}))
let dispatched = false, evidence
const stop = async () => {
  try { await supervisor(['stop', unit]) } catch (error) {
    const current = await state()
    if (current.LoadState !== 'not-found' || current.ActiveState !== 'inactive' || current.MainPID !== '0') throw error
  }
  const current = await state()
  assert.equal(current.MainPID, '0')
  assert.ok(['inactive', 'failed'].includes(current.ActiveState))
  await supervisor(['reset-failed', unit]).catch(() => {})
}
const launch = async () => {
  dispatched = true
  await run('/usr/bin/systemd-run', ['--user', `--unit=${unit}`, '--property=Type=exec', '--property=KillMode=control-group',
    '--property=RuntimeMaxSec=120s', '--property=TimeoutStopSec=10s', `--property=WorkingDirectory=${home}`,
    `--setenv=DSH_HOME=${home}`, `--setenv=HOME=${root}`, '--setenv=DSH_TELEMETRY_DISABLED=1',
    node, dsh, '--profile', name, '--host', '127.0.0.1', '--port', '0', '--no-open'], { timeout: 15000, maxBuffer: 65536 })
}
const poll = async (callback, label) => {
  const deadline = Date.now() + 30_000; let last
  while (Date.now() < deadline) {
    try { return await callback() } catch (error) { last = error; await setTimeout(100) }
  }
  throw new Error(`${label}: ${String(last)}`)
}
try {
  await mkdir(owner, { mode: 0o700 }); await mkdir(join(home, 'profiles'), { recursive: true })
  const { controlUrl, controlBuild, peerPackages } = await prepareRealHostControlPackage(dsh, controlPackage)
  const env = { PATH: '/usr/bin:/bin', HOME: root, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  const dshVersion = (await run(node, [dsh, '--version'], { env, timeout: 10000 })).stdout.trim()
  await run(node, [dsh, '--profile', name, '--from-default-profile', 'web', '--dump-config'], { env, timeout: 30000, maxBuffer: 1048576 })
  const candidatePath = join(profile, 'replay-probe.mjs')
  await copyFile(new URL('./fixtures/replay-host-probe.mjs', import.meta.url), candidatePath)
  const toolsModule = pathToFileURL(createRequire(dsh).resolve('@deepseek-ai/dsh-tools')).href
  const scenarios = []
  for (const mode of ['complete', 'crash']) {
    const area = join(owner, mode); await mkdir(area, { mode: 0o700 })
    const auditPath = join(area, 'audit.jsonl')
    const keyPath = join(area, 'replay.key'), observerKey = join(area, 'observer.key')
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
    await writeFile(observerKey, randomBytes(32), { mode: 0o600 })
    const candidateConfig = { toolsModule, auditPath, mode }
    const targets = [{ entryId: 'include:replay-probe', module: pathToFileURL(candidatePath).href,
      configDigest: runtimeConfigDigest(candidateConfig), services: ['replayFixture'] }]
    const runtimeObserver = { socketPath: join(area, 'observer.sock'), keyPath: observerKey, profilePath: profile, targets }
    const cases = [{ id: 'tool', kind: 'tool', name: 'endpoint_probe', arguments: {} },
      { id: 'reply', kind: 'delivery', text: 'fixture blocked reply' }]
    const signer = generateKeyPairSync('ed25519')
    const scope = { installationId: randomUUID(), ledger: { id: randomUUID(), path: join(area, 'synthetic-ledger.sqlite') },
      plan: { id: randomUUID(), digest: sha(`synthetic-plan-${mode}-${name}`) }, activation: { id: randomUUID(), fence: 1 },
      profile: { name, path: profile } }
    const authority = { mode: 'signed', authority: 'fixture-owner', keyId: 'fixture-ed25519',
      publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString(), scope,
      notBefore: Date.now() - 1000, expiresAt: Date.now() + 60_000, maximumGrantMs: 30_000, cases }
    const operationId = `fixture-${mode}`, syntheticReadiness = {
      operationId: `synthetic-readiness-${mode}`, receiptId: `synthetic-readiness-receipt-${mode}`, phase: 'readiness',
      receiptDigest: sha(`synthetic-readiness-receipt-${mode}-${name}`), hostGeneration: 1,
    }
    const replayEndpoint = {
      runtime: { socketPath: join(area, 'replay.sock'), keyPath, profilePath: profile, targets },
      journalPath: join(area, 'replay.sqlite'), timeoutMs: 15000,
      authority,
      agent: { cwd: root, preset: 'standard', provider: 'fixture-unused', model: 'fixture-unused' },
    }
    const patch = [{ insert: [
      { id: 'replay-policy', name: policyUrl.href, config: { databasePath: join(area, 'policy.sqlite'), toolDefaultEffect: 'allow' } },
      { id: 'replay-delivery', name: deliveryUrl.href, inject: ['assistantPolicy'], config: { databasePath: join(area, 'delivery.sqlite'), spoolPath: join(area, 'spool'),
        defaultWorkspace: root, schedulerEnabled: false } },
      { id: 'replay-probe', name: pathToFileURL(candidatePath).href, config: candidateConfig },
      { id: 'replay-control', name: controlUrl.href, config: { catalogPath: join(area, 'catalog.json'), trustPath: join(area, 'trust.json'),
        statePath: join(area, 'state'), runtimeObserver, replayEndpoint } },
    ] }]
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(patch), { mode: 0o600 })
    const grant = (host, id = operationId) => {
      const now = Date.now(), request = { schemaVersion: 2, kind: 'dsh-host-attestation-request', operationId: id,
        requestedAt: now, receiptTtlMs: 30_000, installationId: scope.installationId, ledger: scope.ledger, plan: scope.plan,
        activation: scope.activation, profile: scope.profile, issuer: { mode: 'owner-manual' }, phase: 'effect-blocked-replay',
        requirements: { kind: 'effect-blocked-replay', minimumDeliveryAttempts: 1, minimumToolExecutionAttempts: 1, maximumExternalEffects: 0 },
        // Synthetic only: this fixture has no Control Plane-produced readiness receipt.
        predecessor: syntheticReadiness }
      const unsigned = { schemaVersion: 1, kind: 'dsh-effect-replay-grant', authority: authority.authority, keyId: authority.keyId,
        request, endpointDigest: runtimeConfigDigest(replayEndpoint), caseDigest: runtimeConfigDigest(cases),
        processId: Number(host.MainPID), invocationId: host.InvocationID, notBefore: now, expiresAt: now + 20_000 }
      return { ...unsigned, signature: sign(null, Buffer.from(replayGrantSigningPayload(unsigned)), signer.privateKey).toString('base64') }
    }
    const query = (action, signed, overrides = {}) => queryReplayEndpoint({ socketPath: replayEndpoint.runtime.socketPath, keyPath,
      action, operationId: signed?.request.operationId ?? operationId,
      requestDigest: signed ? hostAttestationRequestDigest(signed.request) : sha(`unsigned-${mode}-${name}`),
      timeoutMs: 16000, ...(signed ? { grant: signed } : {}), ...overrides })
    const audit = async () => {
      try { return (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
      catch (error) { if (error.code === 'ENOENT') return []; throw error }
    }
    const ready = () => poll(async () => {
      const observation = await queryRuntimeObserver(runtimeObserver), supervisorState = await state()
      const replaySocket = await lstat(replayEndpoint.runtime.socketPath)
      assert.equal(observation.entries[0]?.active, true)
      assert.equal(supervisorState.ActiveState, 'active')
      assert.equal(observation.processId, Number(supervisorState.MainPID))
      assert.equal(observation.invocationId, supervisorState.InvocationID)
      assert.ok(replaySocket.isSocket())
      assert.equal(replaySocket.uid, process.getuid())
      assert.equal(replaySocket.mode & 0o077, 0)
      assert.equal(await realpath(replayEndpoint.runtime.socketPath), replayEndpoint.runtime.socketPath)
      return { observation, supervisor: supervisorState, replaySocket: { dev: replaySocket.dev, ino: replaySocket.ino } }
    }, 'Host readiness')
    await launch()
    const initial = await ready()
    const initialGrant = grant(initial.supervisor)
    await assert.rejects(query('execute'))
    const wrongKey = join(area, 'wrong.key'); await writeFile(wrongKey, randomBytes(32), { mode: 0o600 })
    await assert.rejects(query('execute', initialGrant, { keyPath: wrongKey }))
    await assert.rejects(query('execute', initialGrant, { requestDigest: '0'.repeat(64) }))
    assert.equal((await audit()).length, 0)
    let completed = null, interrupted = null
    if (mode === 'complete') {
      completed = await query('execute', initialGrant)
      assert.equal(completed.status, 'completed')
      assert.deepEqual(completed.result.attempts.map(item => item.blockedAt), ['native-tool-guard', 'delivery-reply-admission'])
      assert.equal(completed.result.runtime.processId, Number(initial.supervisor.MainPID))
      assert.deepEqual((await query('execute', initialGrant)).result, completed.result)
      assert.deepEqual((await query('query', initialGrant)).result, completed.result)
      await stop()
      await assert.rejects(lstat(replayEndpoint.runtime.socketPath), { code: 'ENOENT' })
    } else {
      const socketIdentities = await Promise.all([replayEndpoint.runtime.socketPath, runtimeObserver.socketPath].map(async path => ({ path, stat: await lstat(path) })))
      const flight = query('execute', initialGrant).then(value => ({ value }), error => ({ error: String(error) }))
      await poll(async () => { assert.equal((await audit()).filter(row => row.kind === 'gate-entered').length, 1) }, 'pre-execute crash gate')
      await supervisor(['kill', '--signal=SIGKILL', '--kill-whom=all', unit])
      interrupted = await flight
      assert.ok(interrupted.error, 'SIGKILL must not yield a completion response')
      await stop()
      // Owner recovery removes only the observed dead Host socket inodes after
      // supervisor quiescence. The endpoint never automatically unlinks a peer.
      for (const { path, stat } of socketIdentities) {
        const current = await lstat(path)
        assert.ok(current.isSocket() && current.ino === stat.ino && current.dev === stat.dev)
        await unlink(path)
      }
    }
    const beforeRestart = await audit()
    assert.equal(beforeRestart.filter(row => row.kind === 'create').length, 1)
    assert.equal(beforeRestart.filter(row => row.kind === 'tool-body').length, 0)
    await launch()
    const restarted = await ready()
    assert.notEqual(restarted.supervisor.InvocationID, initial.supervisor.InvocationID)
    const queried = await query('query', initialGrant)
    await assert.rejects(query('execute', initialGrant))
    const changedOperationGrant = grant(restarted.supervisor, `${operationId}-different`)
    const changedGrant = grant(restarted.supervisor)
    await assert.rejects(query('query', changedOperationGrant))
    await assert.rejects(query('execute', changedOperationGrant))
    await assert.rejects(query('query', changedGrant))
    await assert.rejects(query('execute', changedGrant))
    assert.equal(queried.status, mode === 'complete' ? 'stale' : 'unknown')
    assert.equal(queried.result, null)
    assert.deepEqual(await audit(), beforeRestart)
    await stop()
    const journal = new DatabaseSync(replayEndpoint.journalPath, { readOnly: true })
    let journalRows
    try { journalRows = journal.prepare('SELECT operation_id, result_json IS NOT NULL AS completed FROM replay_operations').all() }
    finally { journal.close() }
    assert.equal(journalRows.length, 1)
    assert.equal(journalRows[0].completed, mode === 'complete' ? 1 : 0)
    scenarios.push({ mode, initial, completed, interrupted, restarted, queried, audit: beforeRestart, journalRows,
      signedAdmission: { endpointConfigDigest: runtimeConfigDigest(replayEndpoint), authorityScope: scope,
        authorityPublicKeySha256: sha(authority.publicKeyPem), casesDigest: runtimeConfigDigest(cases),
        syntheticReadinessPredecessor: syntheticReadiness, initialGrantDigest: runtimeConfigDigest(initialGrant),
        changedOperationQueryRejected: true, changedOperationExecuteRejected: true,
        renewedSameOperationQueryRejected: true, renewedSameOperationExecuteRejected: true,
        oldGrantExecuteRejectedAfterRestart: true },
      noRedispatchAfterRestart: true, deadSocketsRemovedByOwner: mode === 'crash' })
  }
  evidence = { schemaVersion: 1, kind: 'replay-endpoint-real-dsh-fixture', observedAt: new Date().toISOString(), dshVersion,
    dshCliSha256: sha(await readFile(dsh)), fixtureSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    probeSha256: sha(await readFile(candidatePath)), controlBuild, peerPackages, scenarios,
    limits: ['Actual isolated temporary DSH profiles using local built packages and the actual Host peer closure for Control Plane; no published artifact byte attestation or production activation.',
      'No prompt or model dispatch; fixture provider/model are unused labels. Actual model quality and supplier integration are not assessed.',
      'Native tool/reply admission proof and durable no-redispatch only; no independent global externalEffects=0 observation, signer receipt or promotion.',
      'Crash recovery includes explicit owner cleanup of dead socket inodes after supervisor quiescence; production crash recovery needs equivalent deployment ownership.'] }
} catch (error) {
  const logs = await run('/usr/bin/journalctl', ['--user', '-u', unit, '--no-pager', '--quiet', '--output=cat', '--lines=35'],
    { timeout: 5000, maxBuffer: 65536 }).then(result => result.stdout, () => '')
  const files = await readdir(root, { recursive: true }).catch(() => [])
  const hostLogs = await Promise.all(files.filter(path => path.endsWith('.log')).slice(0, 5).map(async path =>
    `${path}\n${(await readFile(join(root, path), 'utf8')).slice(-12000)}`))
  const diagnostics = [logs, ...hostLogs].join('\n').replace(/([?&]token=)[^\s]+/gu, '$1[redacted]')
  throw new Error(`${String(error)}\n${diagnostics}`, { cause: error })
} finally {
  if (dispatched) await stop()
  await rm(root, { recursive: true, force: true })
}
evidence.fixtureRemoved = true
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
process.stdout.write(JSON.stringify(evidence) + '\n')
