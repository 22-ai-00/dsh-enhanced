import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import * as release from '../src/release.ts'

const mock = vi.hoisted(() => ({ context: undefined as unknown, trust: undefined as unknown }))
vi.mock('../src/store.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/store.ts')>()
  return { ...actual, readOwnerHostAttestationContext: (...args: Parameters<typeof actual.readOwnerHostAttestationContext>) =>
    mock.context === null ? actual.readOwnerHostAttestationContext(...args) : mock.context }
})
vi.mock('../src/trust.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/trust.ts')>(),
  loadTrustConfig: async () => mock.trust,
}))
vi.mock('../src/release.ts', async importOriginal => ({
  ...await importOriginal<typeof release>(), invokeSourceReleaseAdapter: vi.fn(),
}))

import { Ed25519ApprovalAuthority, approvalSigningPayload } from '../src/approval.ts'
import { resolveSystemdHostAuthority, validateSystemdHostAuthorityConfig, type SystemdHostAuthorityConfig } from '../src/systemd-host-authority.ts'
import { controlPlaneDigest } from '../src/store.ts'
import { defaultHostAttestationPolicy } from '../src/trust.ts'
import type { HostAttestationRequest, PluginActivationPlan } from '../src/types.ts'
import { hostAuthorizationPlan } from './helpers/host-authorization.ts'
import { cleanupReleaseFixtures } from './helpers/source-release-runner.ts'

const roots: string[] = []
const hex = (character: string) => character.repeat(64)
afterEach(async () => { mock.context = undefined; mock.trust = undefined; await cleanupReleaseFixtures(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'systemd-host-authority-'))); roots.push(root)
  const home = join(root, 'home'), profilePath = join(home, 'profiles', 'test')
  await mkdir(profilePath, { recursive: true, mode: 0o700 }); await chmod(root, 0o700)
  const controlDatabasePath = join(root, 'control.sqlite'), trustPath = join(root, 'trust.json'), statePath = join(root, 'authority.sqlite')
  new DatabaseSync(controlDatabasePath).close(); await chmod(controlDatabasePath, 0o600)
  await writeFile(trustPath, '{}', { mode: 0o600 })
  const now = Date.now(), approvalKey = generateKeyPairSync('ed25519')
  const owner = { authorityId: 'owner', authorityHash: hex('a'), principalId: 'principal', principalRecordId: 'record',
    principalVersion: 1, workspace: '/workspace', agentPreset: 'default' }
  const candidate = { id: 'health-helper', package: '@dsh-enhanced/health-helper', version: '1.2.3', integrity: 'sha512-YQ==',
    dshBaseline: '0.1.5-rc.3', capabilities: ['health'], authorities: [], requires: [] }
  const liveQualification = { protocol: 'dsh-bounded-live/v1' as const, maximumWindowMs: 60_000, minimumTasks: 1,
    authority: 'live-authority', keyId: 'live-key' }
  const handoffTerms = { schemaVersion: 1 as const, coordinatorId: 'coordinator', maximumWindowMs: 60_000, commit: 'target-host' as const }
  const input = 'node_modules/@dsh-enhanced/health-helper/lib/index.js'
  const profileFiles = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(name => ({ path: join(profilePath, name), sha256: hex('b') }))
  const deploymentFiles = [{ input, path: join(profilePath, input), sha256: hex('c') }]
  const plan = { id: 'plan', digest: hex('d'), status: 'awaiting-reload', revision: 4, createdAt: now - 1_000, expiresAt: now + 60_000,
    installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00', ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: controlDatabasePath },
    profile: 'test', target: { dshHome: home, profile: 'test', profilePath }, candidate,
    dossier: { catalogProvenance: 'owner-provided-integrity-pinned', hostDeploymentInputs: [input], handoff: handoffTerms, liveQualification },
    activation: { id: 'activation', fence: 1, targetOriginallyExisted: true, targetBaselineFiles: profileFiles,
      hostRecoveryRequired: true, rollbackProfileRestored: false, updatedAt: now - 500 } } as unknown as PluginActivationPlan
  const unsignedApproval = { schemaVersion: 1 as const, approvalId: 'approval', authority: 'approval-authority', keyId: 'approval-key',
    planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: owner.principalId,
    decidedAt: now - 800, expiresAt: now + 60_000 }
  const approvalReceipt = { ...unsignedApproval, signature: sign(null, Buffer.from(approvalSigningPayload(unsignedApproval)), approvalKey.privateKey).toString('base64') }
  plan.approval = await new Ed25519ApprovalAuthority(approvalKey.publicKey.export({ format: 'pem', type: 'spki' }),
    approvalReceipt.authority, approvalReceipt.keyId).verify(approvalReceipt, plan)
  const executable = { path: '/owner/attestor.js', sha256: hex('e') }, interpreter = { path: '/owner/node', sha256: hex('f') }
  const template: SystemdHostAuthorityConfig['template'] = { authority: 'host-authority', keyId: 'host-key',
    privateKeyPath: join(root, 'host.pem'), stateRoot: join(root, 'attestor-state'), executable, interpreter,
    processHelper: { path: '/owner/process.js', sha256: hex('1') }, systemctl: { path: '/usr/bin/systemctl', sha256: hex('2'), interpreter: null },
    scope: 'system', unit: 'dsh-profile-test.service', unitProperties: { FragmentPath: '/owner/test.service', DropInPaths: '',
      ExecStart: '{ path=/owner/node ; argv[]=/owner/node dsh --profile test ; ignore_errors=no ; }',
      Environment: `DSH_HOME=${home}`, WorkingDirectory: home, User: '', Group: '', Type: 'simple', KillMode: 'control-group' },
    timeoutMs: 5_000, stableWindowMs: 75, pollIntervalMs: 25,
    readiness: { client: { path: '/owner/observer.js', sha256: hex('3') },
      observer: { socketPath: join(root, 'observer.sock'), keyPath: join(root, 'observer.key'), profilePath,
        targets: [{ entryId: 'candidate', module: candidate.package, configDigest: hex('4'), services: ['healthService'] }] } },
    recoveryReadiness: { client: { path: '/owner/recovery-observer.js', sha256: hex('5') },
      observer: { socketPath: join(root, 'recovery-observer.sock'), keyPath: join(root, 'recovery-observer.key'), profilePath,
        targets: [{ entryId: 'old-capability', module: '@dsh-enhanced/old-capability', configDigest: hex('6'), services: ['oldService'] }] } } }
  const request: HostAttestationRequest = { schemaVersion: 2, kind: 'dsh-host-attestation-request', operationId: 'operation-reload',
    requestedAt: now, receiptTtlMs: 30_000, installationId: plan.installationId, ledger: plan.ledger,
    plan: { id: plan.id, digest: plan.digest }, activation: { id: 'activation', fence: 1 }, profile: { name: 'test', path: profilePath },
    issuer: { mode: 'configured-executable', id: 'systemd-host', version: 'dsh-systemd-host-attestor-6', ...executable,
      interpreter, authority: template.authority, keyId: template.keyId }, phase: 'reload', requirements: { kind: 'reload', previousHostGeneration: 0 }, predecessor: null }
  const witnessCore = { schemaVersion: 1, kind: 'dsh-host-input-witness', planId: plan.id, planDigest: plan.digest,
    activationId: 'activation', fence: 1, createdAt: now - 400, inputs: [input], profileFiles,
    deploymentFiles, baselineDeploymentFiles: deploymentFiles }
  const witness = { ...witnessCore, digest: controlPlaneDigest(witnessCore) }
  const handoff = { planId: plan.id, planDigest: plan.digest, coordinatorId: 'coordinator', createdAt: now - 600, expiresAt: now + 60_000 }
  const context = { plan, sourcePlan: { status: 'release-complete' }, source: { owner }, released: candidate, handoff,
    approvalReceipt, operation: { request, requestDigest: controlPlaneDigest(request) },
    dispatch: { status: 'claimed', claimedAt: now + 10 }, witness }
  mock.context = context
  mock.trust = { installationId: plan.installationId, ledger: plan.ledger, dshHome: home,
    hostAttestor: { id: 'systemd-host', version: 'dsh-systemd-host-attestor-6', ...executable, interpreter,
      authority: template.authority, keyId: template.keyId },
    approvalKeys: [{ authority: approvalReceipt.authority, keyId: approvalReceipt.keyId,
      publicKeyPem: approvalKey.publicKey.export({ format: 'pem', type: 'spki' }) }] }
  const config: SystemdHostAuthorityConfig = { schemaVersion: 1, statePath, controlDatabasePath, trustPath,
    grant: { id: 'grant', notBefore: now - 1_000, expiresAt: now + 60_000, maximumReloads: 1,
      owner: { ...owner }, profile: { name: 'test', path: profilePath }, packages: [candidate.package], coordinatorId: 'coordinator',
      hostDeploymentInputs: [input], liveQualification }, template }
  return { config, context, request, profileFiles, now }
}

function bindRealContext(base: Awaited<ReturnType<typeof fixture>>, real: Awaited<ReturnType<typeof hostAuthorizationPlan>>,
  plan: PluginActivationPlan, issuer: HostAttestationRequest['issuer']): SystemdHostAuthorityConfig {
  const source = real.f.store.getOwnerTaskFailureReference(plan.gapId)!
  const config: SystemdHostAuthorityConfig = { ...base.config, controlDatabasePath: plan.ledger.path,
    grant: { ...base.config.grant, notBefore: Date.now() - 10_000, expiresAt: Math.min(plan.expiresAt, Date.now() + 30_000),
      owner: { authorityId: source.owner.authorityId, authorityHash: source.owner.authorityHash,
        principalId: source.owner.principalId, principalRecordId: source.owner.principalRecordId,
        principalVersion: source.owner.principalVersion, workspace: source.owner.workspace, agentPreset: source.owner.agentPreset },
      profile: { name: plan.profile, path: plan.target.profilePath }, packages: [plan.candidate.package],
      coordinatorId: real.handoff.coordinatorId, hostDeploymentInputs: plan.dossier.hostDeploymentInputs! },
    template: { ...base.config.template, unit: `dsh-profile-${plan.profile}.service`,
      readiness: { ...base.config.template.readiness,
        observer: { ...base.config.template.readiness.observer, profilePath: plan.target.profilePath } },
      recoveryReadiness: { ...base.config.template.recoveryReadiness,
        observer: { ...base.config.template.recoveryReadiness.observer, profilePath: plan.target.profilePath } } } }
  mock.context = null
  mock.trust = { installationId: plan.installationId, ledger: plan.ledger, dshHome: plan.target.dshHome,
    hostAttestor: { id: issuer.mode === 'configured-executable' ? issuer.id : '',
      version: issuer.mode === 'configured-executable' ? issuer.version : '',
      path: base.config.template.executable.path, sha256: base.config.template.executable.sha256,
      interpreter: base.config.template.interpreter, authority: base.config.template.authority,
      keyId: base.config.template.keyId },
    approvalKeys: [{ authority: real.receipt.authority, keyId: real.receipt.keyId, publicKeyPem: real.approvalPublicKeyPem }] }
  return config
}

test('derives one exact reload config from claimed owner context and replays the persisted bytes', async () => {
  const f = await fixture()
  const first = await resolveSystemdHostAuthority(f.config, f.request)
  expect(first).toMatchObject({ schemaVersion: 1, profileFiles: f.profileFiles,
    authorization: { requestDigest: controlPlaneDigest(f.request), previousHostGeneration: 0 } })
  expect(await resolveSystemdHostAuthority(f.config, f.request)).toEqual(first)
  const db = new DatabaseSync(f.config.statePath, { readOnly: true })
  try { expect(db.prepare('SELECT COUNT(*) AS n FROM systemd_host_operations').get()).toEqual({ n: 1 }) }
  finally { db.close() }
})

test('rejects forged requests, owner drift, and a changed grant without consuming a new reload', async () => {
  const f = await fixture()
  await expect(resolveSystemdHostAuthority(f.config, { ...f.request, operationId: 'forged' })).rejects.toThrow('refused')
  f.context.source.owner.principalId = 'other-owner'
  await expect(resolveSystemdHostAuthority(f.config, f.request)).rejects.toThrow('refused')
  f.context.source.owner.principalId = 'principal'
  await resolveSystemdHostAuthority(f.config, f.request)
  await expect(resolveSystemdHostAuthority({ ...f.config, grant: { ...f.config.grant, maximumReloads: 2 } }, f.request)).rejects.toThrow('refused')
  const secondRequest = { ...f.request, operationId: 'operation-reload-two' }
  f.context.operation.request = secondRequest; f.context.operation.requestDigest = controlPlaneDigest(secondRequest)
  await expect(resolveSystemdHostAuthority(f.config, secondRequest)).rejects.toThrow('refused')
})

test('authorizes exact physical rollback after forward expiry without renewing reload', async () => {
  const f = await fixture()
  const expired = { ...f.config, grant: { ...f.config.grant, expiresAt: f.now - 1 } }
  expect(() => validateSystemdHostAuthorityConfig(expired)).not.toThrow()
  await expect(resolveSystemdHostAuthority(expired, f.request)).rejects.toThrow('refused')
  const request: HostAttestationRequest = { ...f.request, operationId: 'operation-rollback', requestedAt: Date.now(),
    phase: 'rollback', requirements: { kind: 'rollback', previousHostGeneration: 0, action: 'restore',
      baselineFiles: f.profileFiles, minimumChecks: 1 } }
  f.context.plan.status = 'rollback-pending'
  f.context.plan.activation!.rollbackProfileRestored = true
  f.context.operation.request = request; f.context.operation.requestDigest = controlPlaneDigest(request)
  f.context.dispatch.claimedAt = Date.now()
  const result = await resolveSystemdHostAuthority(expired, request)
  expect(result).toMatchObject({ schemaVersion: 3, profileFiles: f.profileFiles,
    authorization: { requestDigest: controlPlaneDigest(request) },
    readiness: { client: f.config.template.recoveryReadiness.client, deploymentFiles: expect.any(Array) } })
  expect(await resolveSystemdHostAuthority(expired, request)).toEqual(result)
})

test('rejects unsafe grant paths, protected packages, and missing deployment inputs', async () => {
  const f = await fixture()
  expect(() => validateSystemdHostAuthorityConfig({ ...f.config, statePath: join(f.config.grant.profile.path, 'state.sqlite') })).toThrow('refused')
  expect(() => validateSystemdHostAuthorityConfig({ ...f.config, grant: { ...f.config.grant,
    packages: ['@dsh-enhanced/plugin-control-plane'] } })).toThrow('refused')
  f.context.witness = undefined as unknown as typeof f.context.witness
  await expect(resolveSystemdHostAuthority(f.config, f.request)).rejects.toThrow('refused')
})

test('reads a real claimed schema-25 owner release and pre-exposure witness through the read-only Store seam', async () => {
  const base = await fixture()
  const issuer = base.request.issuer
  const real = await hostAuthorizationPlan({ liveQualification: base.config.grant.liveQualification, issuer })
  const claimed = await real.exposeAndClaimReload()
  try {
    const config = bindRealContext(base, real, claimed.plan, issuer)
    const result = await resolveSystemdHostAuthority(config, claimed.operation.request as HostAttestationRequest)
    expect(result).toMatchObject({ schemaVersion: 1, profileFiles: real.witnessInput.profileFiles,
      authorization: { plan: { id: claimed.plan.id, digest: claimed.plan.digest },
        requestDigest: claimed.operation.requestDigest } })
    expect(await resolveSystemdHostAuthority(config, claimed.operation.request as HostAttestationRequest)).toEqual(result)
  } finally { await claimed.stop(); real.coordinator.close() }
})

test('derives real claimed physical stop recovery after forward grant expiry and handoff revocation', async () => {
  const base = await fixture()
  const issuer = base.request.issuer
  const real = await hostAuthorizationPlan({ liveQualification: base.config.grant.liveQualification, issuer })
  let plan = real.coordinator.recordActivationHostInputWitness(real.witnessInput)
  plan = real.coordinator.markActivationHostExposure({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence })
  plan = real.coordinator.advanceActivation({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence, from: 'staging', to: 'awaiting-reload' })
  plan = real.coordinator.requestActivationRollback({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence, failureCode: 'fixture-failure' })
  plan = await real.coordinator.claimActivation({ planId: plan.id, expectedRevision: plan.revision,
    leaseMs: 60_000, resolveApprovalAuthority: () => real.approvalAuthority })
  plan = real.coordinator.markRollbackProfileRestored({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence })
  const operation = real.coordinator.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
    expectedFence: plan.activation!.fence, issuer, receiptTtlMs: 10_000,
    requirements: { kind: 'rollback', previousHostGeneration: 0, action: 'stop', baselineFiles: [], minimumChecks: 1 } })
  let rejectExecution!: (reason?: unknown) => void
  const pending = new Promise<never>((_resolve, reject) => { rejectExecution = reject })
  const running = real.coordinator.runHostAttestationOperation({ operationId: operation.operationId,
    expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
    execute: async () => pending, resolveAuthority: () => { throw new Error('test does not settle Host attestation') } })
  try {
    const db = new DatabaseSync(plan.ledger.path)
    try { db.prepare('UPDATE adoption_handoffs SET revoked_at=? WHERE plan_id=?').run(Date.now(), plan.id) }
    finally { db.close() }
    const current = bindRealContext(base, real, plan, issuer)
    const config = { ...current, grant: { ...current.grant, expiresAt: Date.now() - 1 } }
    const result = await resolveSystemdHostAuthority(config, operation.request as HostAttestationRequest)
    expect(result).toMatchObject({ schemaVersion: 3, profileFiles: [], readiness: null,
      authorization: { requestDigest: operation.requestDigest, activation: { fence: plan.activation!.fence } } })
    expect(await resolveSystemdHostAuthority(config, operation.request as HostAttestationRequest)).toEqual(result)
  } finally { rejectExecution(new Error('test stopped')); await running.catch(() => {}); real.coordinator.close() }
})

test('packaged CLI resolves the exact claimed Store request through its relative lib import', async () => {
  const base = await fixture()
  const nodePath = join(dirname(base.config.trustPath), 'node')
  await copyFile(await realpath(process.execPath), nodePath)
  await chmod(nodePath, 0o700)
  const attestorPath = join(dirname(base.config.trustPath), 'attestor.js')
  const attestor = await readFile(resolve('bin/dsh-systemd-host-attestor.js'), 'utf8')
  if (!attestor.startsWith('#!/usr/bin/node\n')) throw new Error('packaged attestor shebang changed')
  await writeFile(attestorPath, `#!${nodePath}\n${attestor.slice('#!/usr/bin/node\n'.length)}`, { mode: 0o700 })
  const helperPath = await realpath(resolve('lib/adapter-process.js'))
  const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
  const executable = { path: attestorPath, sha256: await sha(attestorPath) }
  const interpreter = { path: nodePath, sha256: await sha(nodePath) }
  const issuer: HostAttestationRequest['issuer'] = { mode: 'configured-executable', id: 'systemd-host',
    version: 'dsh-systemd-host-attestor-6', ...executable, interpreter,
    authority: base.config.template.authority, keyId: base.config.template.keyId }
  const real = await hostAuthorizationPlan({ liveQualification: base.config.grant.liveQualification, issuer })
  const claimed = await real.exposeAndClaimReload()
  try {
    const bound = bindRealContext(base, real, claimed.plan, issuer)
    const template = { ...bound.template, executable, interpreter,
      processHelper: { path: helperPath, sha256: await sha(helperPath) } }
    const config = { ...bound, template }
    const hostKey = generateKeyPairSync('ed25519')
    const trust = { schemaVersion: 2, installationId: claimed.plan.installationId, dshHome: claimed.plan.target.dshHome,
      ledger: claimed.plan.ledger, executor: { id: 'dsh', version: '1', path: nodePath, sha256: interpreter.sha256,
        environmentAllowlist: [] }, hostPolicy: defaultHostAttestationPolicy,
      hostAttestor: { id: issuer.mode === 'configured-executable' ? issuer.id : '', version: issuer.mode === 'configured-executable' ? issuer.version : '',
        ...executable, interpreter, environmentAllowlist: ['DSH_SYSTEMD_HOST_ATTESTOR_CONFIG'],
        authority: template.authority, keyId: template.keyId, timeoutMs: 10_000 },
      approvalKeys: [{ authority: real.receipt.authority, keyId: real.receipt.keyId, publicKeyPem: real.approvalPublicKeyPem }],
      hostAttestationKeys: [{ authority: template.authority, keyId: template.keyId,
        publicKeyPem: hostKey.publicKey.export({ format: 'pem', type: 'spki' }) }] }
    await writeFile(config.trustPath, JSON.stringify(trust), { mode: 0o600 })
    const configPath = join(dirname(config.trustPath), 'resolver-config.json')
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    const command = () => spawnSync(nodePath, [resolve('bin/dsh-systemd-host-authority.js'), '--config', configPath],
      { input: `${JSON.stringify(claimed.operation.request)}\n`, encoding: 'utf8', timeout: 10_000,
        env: { LANG: 'C', LC_ALL: 'C' } })
    const first = command()
    expect(first.status, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ schemaVersion: 1,
      profileFiles: real.witnessInput.profileFiles, authorization: { requestDigest: claimed.operation.requestDigest } })
    const replay = command()
    expect(replay.status, replay.stderr).toBe(0)
    expect(replay.stdout).toBe(first.stdout)
  } finally { await claimed.stop(); real.coordinator.close() }
})
