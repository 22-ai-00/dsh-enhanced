#!/usr/bin/env node
// Explicitly opt-in, temporary Host/profile only. No model calls or production writes.
import { execFile, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { queryRuntimeObserver, runtimeConfigDigest } from '../../plugins/plugin-control-plane/lib/runtime-observer.js'
import { Ed25519HostAttestationAuthority, hostAttestationRequestDigest, hostAttestationEvidenceDigest, hostAttestationSigningPayload } from '../../plugins/plugin-control-plane/lib/attestation.js'
import { Ed25519ApprovalAuthority, approvalSigningPayload } from '../../plugins/plugin-control-plane/lib/approval.js'
import { ControlPlaneStore, controlPlaneDigest } from '../../plugins/plugin-control-plane/lib/store.js'
import { parseCatalog } from '../../plugins/plugin-control-plane/lib/catalog.js'
import { DatabaseSync } from 'node:sqlite'

if (process.env.DSH_READINESS_FIXTURE !== '1' || !process.env.DSH_READINESS_DSH || process.platform !== 'linux') {
  throw new Error('requires Linux, DSH_READINESS_FIXTURE=1 and DSH_READINESS_DSH=/absolute/path/to/dsh')
}
const output = process.argv[process.argv.indexOf('--output') + 1]
if (!process.argv.includes('--output') || !output) throw new Error('--output is required')
const rollbackAction = process.env.DSH_READINESS_ROLLBACK
if (rollbackAction !== undefined && !['restore', 'stop'].includes(rollbackAction)) throw new Error('DSH_READINESS_ROLLBACK must be restore or stop')
const initialCandidateDisabled = rollbackAction !== undefined || process.env.DSH_READINESS_EXPECT_INACTIVE === '1'
const initialRuntimeActive = rollbackAction === 'restore' || !initialCandidateDisabled
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
async function cleanupUnit() {
    // Successful stop may unload a transient unit. Prove absence/inactivity
    // before accepting cleanup; do not mask other supervisor errors.
    try { await supervisor(['stop', unit]) } catch (error) {
      const state = await supervisor(['show', unit, '--property=LoadState', '--property=ActiveState', '--property=MainPID'])
      if (!state.includes('LoadState=not-found') || !state.includes('ActiveState=inactive') || !state.includes('MainPID=0')) throw error
    }
    await supervisor(['reset-failed', unit]).catch(() => {})
}
let dispatched = false
let evidence
let store
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
  await writeFile(patchPath, JSON.stringify(patch(!initialRuntimeActive)), { mode: 0o600 })
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
  const active = await observe(initialRuntimeActive)
  const replay = await observe(initialRuntimeActive)
  if (JSON.stringify(active.observation.entries) !== JSON.stringify(replay.observation.entries)
    || active.observation.observerId !== replay.observation.observerId
    || active.observation.challenge === replay.observation.challenge) throw new Error('stable fresh-challenge sampling failed')
  const pinned = async path => ({ path: await realpath(path), sha256: sha(await readFile(path)) })
  const privateNode = join(owner, 'node'); await copyFile(node, privateNode); await chmod(privateNode, 0o700)
  const interpreter = await pinned(privateNode)
  const attestorSource = fileURLToPath(new URL('../../plugins/plugin-control-plane/bin/dsh-systemd-host-attestor.js', import.meta.url))
  const deployedAttestor = join(owner, 'attestor.mjs')
  await writeFile(deployedAttestor, (await readFile(attestorSource, 'utf8')).replace('#!/usr/bin/node', `#!${interpreter.path}`), { mode: 0o700 })
  const executable = await pinned(deployedAttestor)
  const processHelper = await pinned(fileURLToPath(new URL('../../plugins/plugin-control-plane/lib/adapter-process.js', import.meta.url)))
  const keys = generateKeyPairSync('ed25519'); const privateKeyPath = join(owner, 'receipt.pem')
  await writeFile(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const stateRoot = join(owner, 'attestor-state'); await mkdir(stateRoot, { mode: 0o700 })
  const ledgerPath = join(owner, 'external-ledger.sqlite')
  store = new ControlPlaneStore({ path: ledgerPath })
  const now = Date.now()
  // Catalog integrity and staging are fixture inputs. The existing store owns
  // the actual immutable plan, owner approval, durable requests and phase CAS.
  const candidateVersion = JSON.parse(await readFile(new URL('../../plugins/assistant-policy/package.json', import.meta.url), 'utf8')).version
  const catalog = parseCatalog({ schemaVersion: 1, entries: [{ id: 'assistant-policy', package: '@dsh-enhanced/assistant-policy',
    version: candidateVersion, integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, dshBaseline: dshVersion,
    capabilities: ['policy'], authorities: ['filesystem: disposable policy fixture'] }] })
  const gap = store.recordGap({ idempotencyKey: 'fixture-gap', capability: 'policy', context: 'disposable readiness verification',
    expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
  let plan = store.createPlan({ gapId: gap.id, idempotencyKey: 'fixture-plan', candidate: catalog.entries[0],
    catalog: { digest: controlPlaneDigest(catalog), provenance: 'owner-provided-integrity-pinned' }, matchedCapabilities: ['policy'],
    profile: name, target: { dshHome: home, profile: name, profilePath: profile }, installationId: randomUUID(),
    ledger: { id: randomUUID(), path: ledgerPath }, executor: { id: 'dsh', version: dshVersion, ...await pinned(dsh) }, ttlMs: 300000 }).result
  const approvalKeys = generateKeyPairSync('ed25519')
  const approvalAuthority = new Ed25519ApprovalAuthority(approvalKeys.publicKey.export({ type: 'spki', format: 'pem' }), 'fixture-approval', 'approval-key')
  const approval = { schemaVersion: 1, approvalId: 'fixture-approval', authority: 'fixture-approval', keyId: 'approval-key',
    planId: plan.id, planDigest: plan.digest, decision: 'approved', principal: 'fixture-owner', decidedAt: Date.now(), expiresAt: now + 120000 }
  plan = (await store.approve({ planId: plan.id, expectedRevision: plan.revision, idempotencyKey: 'fixture-approval',
    receipt: { ...approval, signature: sign(null, Buffer.from(approvalSigningPayload(approval)), approvalKeys.privateKey).toString('base64') },
    resolveAuthority: () => approvalAuthority })).result
  plan = await store.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs: 30000, resolveApprovalAuthority: () => approvalAuthority })
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n', { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const baselineFiles = rollbackAction === 'stop' ? [] : await Promise.all(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(file => pinned(join(profile, file))))
  plan = store.recordActivationTargetBaseline({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation.fence,
    existed: rollbackAction !== 'stop', baselineFiles })
  if (rollbackAction === 'restore') {
    const suffix = plan.activation.id.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
    await cp(profile, join(home, 'profiles', `.${name}.plugin-backup-${suffix}`), { recursive: true })
    await writeFile(patchPath, JSON.stringify(patch(true)), { mode: 0o600 })
  }
  plan = store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation.fence, from: 'staging', to: 'awaiting-reload' })
  const issuer = { mode: 'configured-executable', id: 'systemd-fixture', version: 'dsh-systemd-host-attestor-5', ...executable,
    interpreter, authority: 'fixture-owner', keyId: 'fixture-key' }
  const prepare = requirements => store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
    expectedFence: plan.activation.fence, issuer, requirements, receiptTtlMs: 120000 }).request
  const reloadRequest = prepare({ kind: 'reload', previousHostGeneration: 0 })
  if (reloadRequest.schemaVersion !== 2 || reloadRequest.predecessor !== null) throw new Error('reload request is not an unchained schema-2 generation transition')
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
  const initialPlan = plan
  const transitions = []
  const apply = async (request, ownerConfig) => {
    const receipt = await store.runHostAttestationOperation({ operationId: request.operationId, expectedRevision: plan.revision,
      expectedFence: plan.activation.fence, execute: durableRequest => invoke(durableRequest, ownerConfig), resolveAuthority: () => authority })
    await authority.verify(receipt, plan, request)
    const before = { status: plan.status, revision: plan.revision }
    plan = (await store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.activation.fence, receipt, resolveAuthority: () => authority, idempotencyKey: `apply:${request.operationId}` })).result
    transitions.push({ phase: request.phase, outcome: receipt.outcome, before, after: { status: plan.status, revision: plan.revision } })
    return receipt
  }
  const reloadReceipt = await apply(reloadRequest, reloadConfig)
  const successor = await observe(!initialCandidateDisabled)
  if (successor.observation.invocationId === active.observation.invocationId) throw new Error('reload did not replace Host')
  const readinessRequest = prepare({ kind: 'readiness', minimumChecks: 3 })
  const predecessor = { operationId: reloadReceipt.operationId, receiptId: reloadReceipt.receiptId,
    phase: 'reload', receiptDigest: controlPlaneDigest(reloadReceipt), hostGeneration: reloadReceipt.hostGeneration }
  if (readinessRequest.schemaVersion !== 2 || controlPlaneDigest(readinessRequest.predecessor) !== controlPlaneDigest(predecessor)) {
    throw new Error('readiness did not bind the exact applied reload receipt')
  }
  const { previousHostGeneration: _previous, ...authorization } = reloadConfig.authorization
  const readinessConfig = { ...reloadConfig, schemaVersion: 2,
    authorization: { ...authorization, hostGeneration: reloadReceipt.hostGeneration, requestDigest: hostAttestationRequestDigest(readinessRequest) },
    readiness: { reloadOperationId: reloadRequest.operationId, observer: config,
      client: await pinned(fileURLToPath(new URL('../../plugins/plugin-control-plane/lib/runtime-observer-protocol.js', import.meta.url))),
      deploymentFiles: await Promise.all([fileURLToPath(candidateUrl), fileURLToPath(new URL('../../plugins/assistant-policy/package.json', import.meta.url))].map(pinned)) } }
  const readinessReceipt = await apply(readinessRequest, readinessConfig)
  const expectedOutcome = initialCandidateDisabled ? 'failed' : 'passed'
  const expectedStatus = initialCandidateDisabled ? 'rollback-pending' : 'awaiting-effect-blocked-replay'
  if (readinessReceipt.outcome !== expectedOutcome || plan.status !== expectedStatus) throw new Error('readiness outcome did not drive the expected phase CAS')
  store.close(); store = new ControlPlaneStore({ path: ledgerPath })
  if (controlPlaneDigest(store.getPlan(plan.id)) !== controlPlaneDigest(plan)) throw new Error('readiness phase CAS did not survive ledger reopen')
  const readinessReplay = await invoke(readinessRequest, readinessConfig)
  if (JSON.stringify(readinessReplay) !== JSON.stringify(readinessReceipt)) throw new Error('readiness replay differs')
  const afterReadiness = await identity()
  if (JSON.stringify(afterReadiness) !== JSON.stringify(successor.supervisor)) throw new Error('readiness restarted the Host')
  let generationSubstitution
  if (plan.status === 'awaiting-effect-blocked-replay') {
    const request = prepare({ kind: 'effect-blocked-replay', minimumDeliveryAttempts: 1,
      minimumToolExecutionAttempts: 1, maximumExternalEffects: 0 })
    if (request.predecessor?.receiptDigest !== controlPlaneDigest(readinessReceipt)) throw new Error('replay does not bind actual readiness')
    // Deliberately fabricated negative input, not an external-effect observation.
    // A valid owner signature must not authorize switching the observed Host generation.
    const invalidEvidence = { kind: 'effect-blocked-replay', deliveryAttempts: 1, deliveryBlocked: 1,
      toolExecutionAttempts: 1, toolExecutionBlocked: 1, externalEffects: 0, replayDigest: 'f'.repeat(64) }
    const observedAt = Date.now()
    const unsigned = { schemaVersion: 2, receiptId: 'invalid-generation-fixture', authority: issuer.authority, keyId: issuer.keyId,
      installationId: plan.installationId, planId: plan.id, planDigest: plan.digest, activationId: plan.activation.id,
      fence: plan.activation.fence, operationId: request.operationId, requestDigest: hostAttestationRequestDigest(request),
      phase: request.phase, outcome: 'passed', hostGeneration: readinessReceipt.hostGeneration + 1, evidence: invalidEvidence,
      evidenceDigest: hostAttestationEvidenceDigest(invalidEvidence), observedAt, expiresAt: observedAt + 30000 }
    const receipt = { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), keys.privateKey).toString('base64') }
    let refused = false
    try {
      await store.runHostAttestationOperation({ operationId: request.operationId, expectedRevision: plan.revision,
        expectedFence: plan.activation.fence, execute: async () => receipt, resolveAuthority: () => authority })
    } catch (error) { if (!/changed generation from its predecessor/u.test(String(error))) throw error; refused = true }
    if (!refused || store.getHostAttestationOperation(request.operationId).status !== 'pending'
      || controlPlaneDigest(store.getPlan(plan.id)) !== controlPlaneDigest(plan)) throw new Error('generation substitution advanced activation')
    generationSubstitution = { syntheticNegativeReceipt: true, refused, request, receipt, activationUnchanged: true }
  }
  const db = new DatabaseSync(join(stateRoot, 'reload.sqlite'), { readOnly: true })
  let signedObservation
  try { signedObservation = JSON.parse(db.prepare('SELECT observation FROM readiness').get().observation) } finally { db.close() }
  let recoveryEvidence
  let replacement
  if (rollbackAction) {
    const controlDir = join(home, 'plugin-control'); await mkdir(controlDir, { mode: 0o700 })
    const { mode: _mode, ...hostAttestor } = issuer
    const trust = { schemaVersion: 2, installationId: plan.installationId, dshHome: home, ledger: plan.ledger,
      executor: { ...plan.executor, environmentAllowlist: [] },
      hostPolicy: { readinessMinimumChecks: 3, effectBlockedMinimumDeliveryAttempts: 1, effectBlockedMinimumToolExecutionAttempts: 1,
        shadowMinimumSamples: 1, shadowMaximumMismatches: 0, canaryMinimumSamples: 1, canaryMaximumFailures: 0,
        soakMinimumWindowMs: 1000, soakMinimumSamples: 1, soakMaximumFailureRate: 0, healthMinimumChecks: 3,
        healthMaximumFailures: 0, receiptTtlMs: 120000 },
      hostAttestor: { ...hostAttestor, environmentAllowlist: ['DSH_SYSTEMD_HOST_ATTESTOR_CONFIG'], timeoutMs: 30000 },
      approvalKeys: [{ authority: 'fixture-approval', keyId: 'approval-key', publicKeyPem: approvalKeys.publicKey.export({ type: 'spki', format: 'pem' }) }],
      hostAttestationKeys: [{ authority: issuer.authority, keyId: issuer.keyId, publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] }
    await writeFile(join(controlDir, 'trust.json'), JSON.stringify(trust), { mode: 0o600 })
    const cliPath = fileURLToPath(new URL('../../plugins/plugin-control-plane/bin/dsh-plugin-control.js', import.meta.url))
    const cli = async args => JSON.parse((await run(node, [cliPath, ...args],
      { env: { ...env, DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: configPath }, timeout: 40000, maxBuffer: 1048576 })).stdout)
    plan = await cli(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)])
    if (plan.status !== 'rollback-pending' || !plan.activation.rollbackProfileRestored) throw new Error('filesystem recovery falsely terminalized plan')
    const filesRestoredPlan = plan
    const args = ['probe', '--plan-id', plan.id, '--expected-revision', String(plan.revision), '--expected-fence', String(plan.activation.fence)]
    const request = await cli([...args, '--prepare-only'])
    if (request.schemaVersion !== 2 || request.activation.fence <= readinessRequest.activation.fence || request.predecessor !== null) {
      throw new Error('physical recovery did not preserve its new fence and empty same-fence predecessor')
    }
    if (request.requirements.action !== rollbackAction || controlPlaneDigest(request.requirements.baselineFiles) !== controlPlaneDigest(baselineFiles)) throw new Error('rollback request does not bind original baseline')
    const ownerConfig = { ...reloadConfig, schemaVersion: 3, profileFiles: baselineFiles,
      authorization: { ...reloadConfig.authorization, activation: request.activation,
        previousHostGeneration: request.requirements.previousHostGeneration, requestDigest: hostAttestationRequestDigest(request) },
      readiness: rollbackAction === 'restore' ? { observer: config, client: readinessConfig.readiness.client,
        deploymentFiles: readinessConfig.readiness.deploymentFiles } : null }
    await writeFile(configPath, JSON.stringify(ownerConfig), { mode: 0o600 })
    let result
    try { result = await cli(args) } catch (error) {
      // Reconcile the same request for diagnostic stderr; never submit a new operation.
      try { await invoke(request, ownerConfig) } catch (diagnostic) { throw new Error(`${String(error)}; reconciliation: ${String(diagnostic)}`) }
      throw error
    }
    plan = result.result
    if (plan.status !== 'rolled-back') throw new Error('physical recovery did not complete ledger rollback')
    const receipt = store.getHostAttestationOperation(request.operationId).receipt
    await authority.verify(receipt, plan, request)
    const physical = rollbackAction === 'restore' ? await observe(true) : await identity()
    if (rollbackAction === 'stop' && (physical.ActiveState !== 'inactive' || physical.MainPID !== '0')) throw new Error('removed profile left live Host')
    const repeated = await invoke(request, ownerConfig)
    if (controlPlaneDigest(repeated) !== controlPlaneDigest(receipt)) throw new Error('recovery receipt replay differs')
    const recoveryDb = new DatabaseSync(join(stateRoot, 'reload.sqlite'), { readOnly: true })
    let observation
    try { observation = JSON.parse(recoveryDb.prepare('SELECT observation FROM reloads WHERE operation_id = ?').get(request.operationId).observation) }
    finally { recoveryDb.close() }
    store.close(); store = new ControlPlaneStore({ path: ledgerPath })
    if (controlPlaneDigest(store.getPlan(plan.id)) !== controlPlaneDigest(plan)) throw new Error('physical recovery did not survive reopen')
    recoveryEvidence = { action: rollbackAction, filesRestoredPlan, request, receipt, observation, physical,
      cliRestoreAndProbe: true, persistedAfterReopen: true, identicalReceiptReplay: true }
    replacement = physical
  } else {
  await supervisor(['stop', unit])
  try { await lstat(config.socketPath); throw new Error('Host stop retained the observer socket') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(patchPath, JSON.stringify(patch(!initialCandidateDisabled)), { mode: 0o600 })
  await launch()
  replacement = await observe(initialCandidateDisabled)
  if (active.observation.observerId === replacement.observation.observerId
    || active.observation.invocationId === replacement.observation.invocationId) throw new Error('Host instance did not change')
  const rejected = await invoke(readinessRequest, readinessConfig, true)
  if (!rejected.rejected) throw new Error('stale readiness receipt replay was accepted')
  }
  evidence = { schemaVersion: 1, kind: rollbackAction ? 'systemd-rollback-real-dsh-fixture' : 'systemd-readiness-real-dsh-fixture', observedAt: new Date().toISOString(), dshVersion,
    dshCliSha256: sha(await readFile(dsh)), candidatePackage: '@dsh-enhanced/assistant-policy',
    candidateVersion, initialCandidateDisabled, rollbackAction, recoveryEvidence,
    runtimeDigests: { observer: sha(await readFile(new URL('../../plugins/plugin-control-plane/lib/runtime-observer.js', import.meta.url))),
      attestor: sha(await readFile(attestorSource)), deployedAttestor: executable.sha256, observerClient: readinessConfig.readiness.client.sha256, processHelper: processHelper.sha256,
      controlCli: sha(await readFile(new URL('../../plugins/plugin-control-plane/lib/cli.js', import.meta.url))),
      controlStore: sha(await readFile(new URL('../../plugins/plugin-control-plane/lib/store.js', import.meta.url))),
      controlAttestation: sha(await readFile(new URL('../../plugins/plugin-control-plane/lib/attestation.js', import.meta.url))),
      fixtureScript: sha(await readFile(fileURLToPath(import.meta.url))),
      controlEntry: sha(await readFile(fileURLToPath(controlUrl))), candidateEntry: sha(await readFile(fileURLToPath(candidateUrl))) },
    active, replay, successor, afterReadiness, replacement, reloadReceipt, readinessReceipt, signedObservation, generationSubstitution,
    receiptPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), plan: initialPlan,
    controlPlane: { transitions, finalPlan: plan, persistedAfterReopen: true },
    requests: { reload: reloadRequest, readiness: readinessRequest },
    byteIdenticalReadinessReplay: true, staleReplayRejected: rollbackAction ? undefined : true, socketRemovedOnHostStop: rollbackAction ? undefined : true,
    limits: ['Actual DSH process with local built Control Plane and Policy package entries, referenced by file URL in a disposable profile; no npm install/publication or candidate artifact byte attestation.',
      'Existing Control Plane store performs signed approval and reload/readiness request/receipt CAS; catalog integrity, owner approval and profile staging are controlled fixture inputs, not actual npm artifact installation or CLI activation.',
      rollbackAction ? 'CLI restores/removes fixture profile, then descriptor-pinned supervisor attestor proves physical recovery. Initial catalog/artifact installation is fixture input; no production activation, npm publication, model call or behavioral quality proof.'
        : 'Negative readiness stops at rollback-pending; no profile restoration, physical Host rollback, behavioral quality proof, model call or production activation.'] }
} finally {
  store?.close()
  if (dispatched) await cleanupUnit()
  await rm(root, { recursive: true, force: true })
}
evidence.fixtureRemoved = true
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
process.stdout.write(JSON.stringify(evidence) + '\n')
