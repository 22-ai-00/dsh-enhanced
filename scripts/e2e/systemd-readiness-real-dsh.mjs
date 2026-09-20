#!/usr/bin/env node
// Explicitly opt-in, temporary Host/profile only. No model calls or production writes.
import { execFile, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { queryRuntimeObserver, runtimeConfigDigest } from '../../plugins/plugin-control-plane/lib/runtime-observer.js'
import { Ed25519HostAttestationAuthority, hostAttestationRequestDigest } from '../../plugins/plugin-control-plane/lib/attestation.js'
import { DatabaseSync } from 'node:sqlite'

if (process.env.DSH_READINESS_FIXTURE !== '1' || !process.env.DSH_READINESS_DSH || process.platform !== 'linux') {
  throw new Error('requires Linux, DSH_READINESS_FIXTURE=1 and DSH_READINESS_DSH=/absolute/path/to/dsh')
}
const output = process.argv[process.argv.indexOf('--output') + 1]
if (!process.argv.includes('--output') || !output) throw new Error('--output is required')
const run = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ready-')))
const home = join(root, 'home'); const owner = join(root, 'owner')
const name = `readiness-fixture-${process.pid}-${randomUUID().slice(0, 8)}`
const profile = join(home, 'profiles', name); const unit = `dsh-profile-${name}.service`
const dsh = await realpath(process.env.DSH_READINESS_DSH)
const node = await realpath(process.execPath)
const controlUrl = new URL('../../plugins/plugin-control-plane/lib/index.js', import.meta.url)
const candidateUrl = new URL('../../plugins/assistant-policy/lib/index.js', import.meta.url)
const supervisor = async args => (await run('/usr/bin/systemctl', ['--user', ...args], { timeout: 15000, maxBuffer: 65536 })).stdout
let dispatched = false
let evidence
try {
  await mkdir(owner, { mode: 0o700 }); await mkdir(join(home, 'profiles'), { recursive: true })
  const env = { PATH: '/usr/bin:/bin', HOME: root, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  const dshVersion = (await run(node, [dsh, '--version'], { env, timeout: 10000 })).stdout.trim()
  await run(node, [dsh, '--profile', name, '--from-default-profile', 'web', '--dump-config'], { env, timeout: 30000, maxBuffer: 1048576 })
  const keyPath = join(owner, 'observer.key'); await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
  const candidateConfig = { databasePath: join(owner, 'policy.sqlite'), autoReview: { enabled: false }, rules: [], budgets: [] }
  const config = { socketPath: join(owner, 'observer.sock'), keyPath, profilePath: profile,
    targets: [{ entryId: 'include:observed-candidate', module: candidateUrl.href,
      configDigest: runtimeConfigDigest(candidateConfig), services: ['assistantPolicy'] }] }
  const patch = disabled => [{ insert: [
    { id: 'observer-control', name: controlUrl.href, config: { catalogPath: join(owner, 'catalog.json'), trustPath: join(owner, 'trust.json'),
      statePath: join(owner, 'state'), runtimeObserver: config } },
    { id: 'observed-candidate', name: candidateUrl.href, config: candidateConfig, disabled },
  ] }]
  const patchPath = join(profile, 'cordis.patch.yml')
  await writeFile(patchPath, JSON.stringify(patch(false)), { mode: 0o600 })
  // Mark possible dispatch before crossing the supervisor boundary, so finally
  // also attempts stop if systemd-run's acknowledgement is lost.
  dispatched = true
  const launch = () => run('/usr/bin/systemd-run', ['--user', `--unit=${unit}`, '--property=Type=exec', '--property=KillMode=control-group',
    '--property=RuntimeMaxSec=180s', `--property=WorkingDirectory=${home}`, `--setenv=DSH_HOME=${home}`, `--setenv=HOME=${root}`,
    '--setenv=DSH_TELEMETRY_DISABLED=1', node, dsh, '--profile', name, '--host', '127.0.0.1', '--port', '0', '--no-open'], { timeout: 15000, maxBuffer: 65536 })
  await launch()
  const identity = async () => Object.fromEntries((await supervisor(['show', unit, '--property=MainPID', '--property=InvocationID', '--property=ActiveState']))
    .trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
  const observe = async expectedActive => {
    const deadline = Date.now() + 30000; let last
    while (Date.now() < deadline) {
      try {
        const current = await queryRuntimeObserver(config)
        if (current.entries[0]?.active !== expectedActive) throw new Error('candidate lifecycle state differs')
        const state = await identity()
        if (state.ActiveState !== 'active' || current.processId !== Number(state.MainPID) || current.invocationId !== state.InvocationID) throw new Error('supervisor binding differs')
        return { supervisor: state, observation: current }
      } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    const logs = (await run('/usr/bin/journalctl', ['--user', '-u', unit, '--no-pager', '--quiet', '--output=cat', '--lines=25'], { timeout: 5000, maxBuffer: 65536 })).stdout
    throw new Error(`runtime fixture failed: ${String(last)}\n${logs}`)
  }
  const active = await observe(true)
  const replay = await observe(true)
  if (JSON.stringify(active.observation.entries) !== JSON.stringify(replay.observation.entries)
    || active.observation.observerId !== replay.observation.observerId
    || active.observation.challenge === replay.observation.challenge) throw new Error('stable fresh-challenge sampling failed')
  const pinned = async path => ({ path: await realpath(path), sha256: sha(await readFile(path)) })
  const privateNode = join(owner, 'node'); await copyFile(node, privateNode); await chmod(privateNode, 0o700)
  const interpreter = await pinned(privateNode)
  const executable = await pinned(fileURLToPath(new URL('../../plugins/plugin-control-plane/bin/dsh-systemd-host-attestor.js', import.meta.url)))
  const processHelper = await pinned(fileURLToPath(new URL('../../plugins/plugin-control-plane/lib/adapter-process.js', import.meta.url)))
  const keys = generateKeyPairSync('ed25519'); const privateKeyPath = join(owner, 'receipt.pem')
  await writeFile(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const stateRoot = join(owner, 'attestor-state'); await mkdir(stateRoot, { mode: 0o700 })
  const ledgerPath = join(owner, 'external-ledger.sqlite'); await writeFile(ledgerPath, '', { mode: 0o600 })
  const now = Date.now()
  const reloadRequest = { schemaVersion: 1, kind: 'dsh-host-attestation-request', operationId: `reload-${randomUUID()}`,
    requestedAt: now, receiptTtlMs: 120000, installationId: randomUUID(), ledger: { id: 'fixture-ledger', path: ledgerPath },
    plan: { id: 'fixture-plan', digest: 'a'.repeat(64) }, activation: { id: 'fixture-activation', fence: 1 }, profile: { name, path: profile },
    issuer: { mode: 'configured-executable', id: 'systemd-fixture', version: 'dsh-systemd-host-attestor-2', ...executable,
      interpreter, authority: 'fixture-owner', keyId: 'fixture-key' }, phase: 'reload', requirements: { kind: 'reload', previousHostGeneration: 0 } }
  const properties = ['FragmentPath', 'DropInPaths', 'ExecStart', 'Environment', 'WorkingDirectory', 'User', 'Group', 'Type', 'KillMode']
  const unitProperties = Object.fromEntries((await supervisor(['show', unit, ...properties.map(key => `--property=${key}`)]))
    .trimEnd().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
  unitProperties.ExecStart = unitProperties.ExecStart.replace(/ ; start_time=.* \}$/u, ' ; }')
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n', { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const profileFiles = await Promise.all(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(file => pinned(join(profile, file))))
  const reloadConfig = { schemaVersion: 1, authority: 'fixture-owner', keyId: 'fixture-key', privateKeyPath, stateRoot, executable, interpreter, processHelper,
    systemctl: { ...await pinned('/usr/bin/systemctl'), interpreter: null }, scope: 'user', unit, unitProperties, profileFiles,
    authorization: { installationId: reloadRequest.installationId, ledger: reloadRequest.ledger, profile: reloadRequest.profile,
      plan: reloadRequest.plan, activation: reloadRequest.activation, previousHostGeneration: 0, requestDigest: hostAttestationRequestDigest(reloadRequest),
      notBefore: now - 1000, expiresAt: now + 120000 }, timeoutMs: 15000, stableWindowMs: 500, pollIntervalMs: 100 }
  const configPath = join(owner, 'attestor.json')
  const invoke = async (request, ownerConfig, allowFailure = false) => {
    await writeFile(configPath, JSON.stringify(ownerConfig), { mode: 0o600 })
    return new Promise((resolveResult, reject) => {
      const child = spawn(interpreter.path, [executable.path, 'attest'], { env: { DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 25000)
      child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); if (code === 0) resolveResult(JSON.parse(stdout));
        else if (allowFailure && code === 1 && !stdout) resolveResult({ rejected: true }); else reject(new Error(`attestor failed ${code}: ${stderr}`)) })
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request))
    })
  }
  const authority = new Ed25519HostAttestationAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), reloadConfig.authority, reloadConfig.keyId)
  const plan = { id: reloadRequest.plan.id, digest: reloadRequest.plan.digest, installationId: reloadRequest.installationId,
    activation: reloadRequest.activation, createdAt: now - 1000 }
  const reloadReceipt = await invoke(reloadRequest, reloadConfig); await authority.verify(reloadReceipt, plan, reloadRequest)
  const successor = await observe(true)
  if (successor.observation.invocationId === active.observation.invocationId) throw new Error('reload did not replace Host')
  const readinessRequest = { ...reloadRequest, operationId: `readiness-${randomUUID()}`, requestedAt: Date.now(), phase: 'readiness', requirements: { kind: 'readiness', minimumChecks: 3 } }
  const { previousHostGeneration: _previous, ...authorization } = reloadConfig.authorization
  const readinessConfig = { ...reloadConfig, schemaVersion: 2,
    authorization: { ...authorization, hostGeneration: reloadReceipt.hostGeneration, requestDigest: hostAttestationRequestDigest(readinessRequest) },
    readiness: { reloadOperationId: reloadRequest.operationId, observer: config,
      client: await pinned(fileURLToPath(new URL('../../plugins/plugin-control-plane/lib/runtime-observer-protocol.js', import.meta.url))),
      deploymentFiles: await Promise.all([fileURLToPath(candidateUrl), fileURLToPath(new URL('../../plugins/assistant-policy/package.json', import.meta.url))].map(pinned)) } }
  const readinessReceipt = await invoke(readinessRequest, readinessConfig); await authority.verify(readinessReceipt, plan, readinessRequest)
  const readinessReplay = await invoke(readinessRequest, readinessConfig)
  if (JSON.stringify(readinessReplay) !== JSON.stringify(readinessReceipt)) throw new Error('readiness replay differs')
  const afterReadiness = await identity()
  if (JSON.stringify(afterReadiness) !== JSON.stringify(successor.supervisor)) throw new Error('readiness restarted the Host')
  const db = new DatabaseSync(join(stateRoot, 'reload.sqlite'), { readOnly: true })
  let signedObservation
  try { signedObservation = JSON.parse(db.prepare('SELECT observation FROM readiness').get().observation) } finally { db.close() }
  await supervisor(['stop', unit])
  try { await lstat(config.socketPath); throw new Error('Host stop retained the observer socket') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(patchPath, JSON.stringify(patch(true)), { mode: 0o600 })
  await launch()
  const disabled = await observe(false)
  if (active.observation.observerId === disabled.observation.observerId
    || active.observation.invocationId === disabled.observation.invocationId) throw new Error('Host instance did not change')
  const rejected = await invoke(readinessRequest, readinessConfig, true)
  if (!rejected.rejected) throw new Error('stale readiness receipt replay was accepted')
  evidence = { schemaVersion: 1, kind: 'systemd-readiness-real-dsh-fixture', observedAt: new Date().toISOString(), dshVersion,
    dshCliSha256: sha(await readFile(dsh)), candidatePackage: '@dsh-enhanced/assistant-policy',
    candidateVersion: JSON.parse(await readFile(new URL('../../plugins/assistant-policy/package.json', import.meta.url), 'utf8')).version,
    runtimeDigests: { observer: sha(await readFile(new URL('../../plugins/plugin-control-plane/lib/runtime-observer.js', import.meta.url))),
      attestor: executable.sha256, observerClient: readinessConfig.readiness.client.sha256, processHelper: processHelper.sha256,
      controlEntry: sha(await readFile(fileURLToPath(controlUrl))), candidateEntry: sha(await readFile(fileURLToPath(candidateUrl))) },
    active, replay, successor, afterReadiness, disabled, reloadReceipt, readinessReceipt, signedObservation,
    receiptPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), plan,
    requests: { reload: reloadRequest, readiness: readinessRequest },
    byteIdenticalReadinessReplay: true, staleReplayRejected: true, socketRemovedOnHostStop: true,
    limits: ['Actual DSH process with local built Control Plane and Policy package entries, referenced by file URL in a disposable profile; no npm install/publication or candidate artifact byte attestation.',
      'Signed reload/readiness receipts independently verified against fixture requests; no Control Plane CAS transition, behavioral quality proof, model call, npm artifact install or production activation.'] }
} finally {
  if (dispatched) { await supervisor(['stop', unit]); await supervisor(['reset-failed', unit]).catch(() => {}) }
  await rm(root, { recursive: true, force: true })
}
evidence.fixtureRemoved = true
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
process.stdout.write(JSON.stringify(evidence) + '\n')
