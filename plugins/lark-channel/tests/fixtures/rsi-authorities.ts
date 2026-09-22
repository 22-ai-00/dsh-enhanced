import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RsiSetupManifest } from '../../src/rsi-profile.js'

const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const

export interface RsiAuthorityFixture {
  root: string
  manifest: RsiSetupManifest
  binding: { owner: { id: string; version: number } }
  readAuthority(name: 'approvals' | 'releases' | 'adoptions' | 'observations'): Promise<Record<string, any>>
  writeAuthority(name: 'approvals' | 'releases' | 'adoptions' | 'observations', value: Record<string, any>): Promise<void>
  dispose(): Promise<void>
}

/** A real, owner-private schema-v4 trust root and all four finite authority files. */
export async function createRsiAuthorityFixture(): Promise<RsiAuthorityFixture> {
  // macOS 上 os.tmpdir() 经 /var → /private/var 符号链接；safeFile 的 canonical
  // 检查会拒绝非规范化路径，夹具先 realpath 到真实路径。
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-rsi-authorities-'))
  await chmod(root, 0o700)
  const privateDirectory = async (name: string): Promise<string> => {
    const path = join(root, name)
    await mkdir(path, { mode: 0o700 })
    await chmod(path, 0o700)
    return path
  }
  const writePrivate = async (path: string, value: string): Promise<void> => {
    await writeFile(path, value, { encoding: 'utf8', mode: 0o600 })
    await chmod(path, 0o600)
  }
  const statePath = await privateDirectory('state')
  const home = await privateDirectory('dsh')
  await privateDirectory('dsh/profiles')
  const profilePath = await privateDirectory('dsh/profiles/target')
  const repository = await privateDirectory('repository')
  const worktreeRoot = await privateDirectory('state/source-worktrees')
  const registry = await privateDirectory('registry')
  const controlPath = join(statePath, 'control.sqlite')
  const catalogPath = join(root, 'catalog.json')
  await writePrivate(controlPath, '')
  await writePrivate(catalogPath, '{"schemaVersion":1,"entries":[]}\n')

  const shell = await realpath('/bin/sh')
  const shellDigest = digest(await readFile(shell))
  const executable = async (name: string): Promise<{ path: string; sha256: string }> => {
    const path = join(root, name)
    await writeFile(path, `#!${shell}\nexit 0\n`, { encoding: 'utf8', mode: 0o700 })
    await chmod(path, 0o700)
    return { path, sha256: digest(await readFile(path)) }
  }
  const executor = { id: 'fixture-executor', version: '1.0.0', path: shell, sha256: shellDigest, environmentAllowlist: [] }
  const hostAttestor = await executable('host-attestor')
  const authorityKey = async (name: string, authority: string, keyId: string) => {
    const pair = generateKeyPairSync('ed25519')
    const keyPath = join(root, `${name}.pem`)
    await writePrivate(keyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    return { authority, keyId, keyPath, publicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() }
  }
  const approval = await authorityKey('approval-authority', 'approval-authority', 'approval-key')
  const release = await authorityKey('release-authority', 'release-authority', 'release-key')
  const adoption = await authorityKey('adoption-authority', 'adoption-authority', 'adoption-key')
  const observation = await authorityKey('observation-authority', 'observation-authority', 'observation-key')
  const host = await authorityKey('host-attestation', 'host-attestation', 'host-key')
  const adapterKeys = await Promise.all(phases.map(phase => authorityKey(`adapter-${phase}`, `adapter-${phase}`, `${phase}-key`)))
  const adapters = Object.fromEntries(await Promise.all(phases.map(async (phase, index) => {
    const command = await executable(`adapter-${phase}`), key = adapterKeys[index]!
    return [phase, { id: `adapter-${phase}`, version: '1.0.0', ...command,
      interpreter: { path: shell, sha256: shellDigest }, environmentAllowlist: [], authority: key.authority, keyId: key.keyId, timeoutMs: 1_000 }]
  })))

  const owner = { authorityId: 'owner-authority', authorityHash: 'a'.repeat(64), principalId: 'lark/account/tenant/owner',
    principalRecordId: 'owner-record', principalVersion: 7, workspace: repository, agentPreset: 'primary' }
  const expiresAt = Date.now() + 60_000
  const policy = { id: 'task-observations', expiresAt, maximumObservations: 2, minimumChecks: 1, maximumChecks: 2, lookbackMs: 1_000 }
  const sourcePolicy = { targetBranch: 'dev', candidateId: 'health-helper', packageName: '@dsh-enhanced/health-helper', packagePath: 'plugins/health-helper',
    dshBaseline: '0.1.0', capabilities: ['health'], authorities: ['network'], requires: [], registryId: 'fixture-registry',
    registryLocator: pathToFileURL(registry).href, catalogId: 'fixture-catalog', catalogPath, minimumReproducibleBuilds: 2 }
  const adoptionPolicy = { candidateId: 'health-helper', packageName: '@dsh-enhanced/health-helper', dshBaseline: '0.1.0',
    capabilities: ['health'], authorities: ['network'], requires: [], registryId: 'fixture-registry', registryLocator: pathToFileURL(registry).href }
  const authorityPath = (name: string) => join(root, `${name}.json`)
  const approvals = { schemaVersion: 1, authority: approval.authority, keyId: approval.keyId, keyPath: approval.keyPath,
    statePath: join(root, 'approval-state.sqlite'), controlDatabasePath: controlPath,
    grant: { id: 'approval-grant', expiresAt, maxApprovals: 2, repository, worktreeRoot, owner, plugins: ['health-helper'],
      maxChangedFiles: 8, maxChangedBytes: 4096, receiptTtlMs: 30_000, versioning: 'patch' } }
  const releases = { schemaVersion: 1, authority: release.authority, keyId: release.keyId, keyPath: release.keyPath,
    statePath: join(root, 'release-state.sqlite'), controlDatabasePath: controlPath,
    grant: { id: 'release-grant', expiresAt, maxReleases: 2, repository, worktreeRoot, owner, plugins: ['health-helper'],
      maxChangedFiles: 8, maxChangedBytes: 4096, receiptTtlMs: 30_000, versioning: 'patch', policies: [sourcePolicy] } }
  const adoptions = { schemaVersion: 1, authority: adoption.authority, keyId: adoption.keyId, keyPath: adoption.keyPath,
    statePath: join(root, 'adoption-state.sqlite'), controlDatabasePath: controlPath,
    grant: { id: 'adoption-grant', expiresAt, maxAdoptions: 2, owner, installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
      ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: controlPath },
      target: { dshHome: home, profile: 'target', profilePath }, executor: { id: executor.id, version: executor.version, path: executor.path, sha256: executor.sha256 },
      catalogPath, receiptTtlMs: 30_000, policies: [adoptionPolicy] } }
  const observations = { schemaVersion: 1, authority: observation.authority, keyId: observation.keyId, keyPath: observation.keyPath,
    statePath: join(root, 'observation-state.sqlite'), controlDatabasePath: controlPath,
    grant: { policy, owner, installationId: adoptions.grant.installationId, ledger: adoptions.grant.ledger, profilePath,
      packages: ['@dsh-enhanced/health-helper'], receiptTtlMs: 30_000 } }
  for (const [name, value] of Object.entries({ approvals, releases, adoptions, observations })) await writePrivate(authorityPath(name), `${JSON.stringify(value)}\n`)
  const trustPath = join(root, 'trust.json')
  await writePrivate(trustPath, `${JSON.stringify({ schemaVersion: 4, installationId: adoptions.grant.installationId, dshHome: home,
    ledger: adoptions.grant.ledger, executor, hostPolicy: { readinessMinimumChecks: 1, effectBlockedMinimumDeliveryAttempts: 1,
      effectBlockedMinimumToolExecutionAttempts: 1, shadowMinimumSamples: 1, shadowMaximumMismatches: 0, canaryMinimumSamples: 1,
      canaryMaximumFailures: 0, soakMinimumWindowMs: 1_000, soakMinimumSamples: 1, soakMaximumFailureRate: 0, healthMinimumChecks: 1,
      healthMaximumFailures: 0, receiptTtlMs: 1_000 }, hostAttestor: { id: 'fixture-host-attestor', version: '1.0.0', ...hostAttestor,
      interpreter: { path: shell, sha256: shellDigest }, environmentAllowlist: [], authority: host.authority, keyId: host.keyId, timeoutMs: 1_000 },
    catalog: { id: 'fixture-catalog', path: catalogPath }, releaseRegistry: { id: 'fixture-registry', locator: 'https://registry.example/', protocol: 'dsh' },
    releaseReceiptTtlMs: 1_000, releaseAdapters: adapters, approvalKeys: [approval, adoption].map(({ authority, keyId, publicKeyPem }) => ({ authority, keyId, publicKeyPem })),
    hostAttestationKeys: [host, observation].map(({ authority, keyId, publicKeyPem }) => ({ authority, keyId, publicKeyPem })),
    releaseKeys: adapterKeys.map(({ authority, keyId, publicKeyPem }) => ({ authority, keyId, publicKeyPem })),
    releaseAuthorizationKeys: [release].map(({ authority, keyId, publicKeyPem }) => ({ authority, keyId, publicKeyPem })) })}\n`)
  const manifest = { schemaVersion: 1, targetProfile: 'target', coordinatorProfile: 'coordinator', controlPlane: { catalogPath, statePath, trustPath,
    sourceJobs: { repository }, sourceApprovals: { configPath: authorityPath('approvals') }, sourceReleases: { configPath: authorityPath('releases') },
    sourceAdoptions: { authority: { configPath: authorityPath('adoptions') } }, runtimeObserver: { profilePath },
    taskObservations: { authority: { configPath: authorityPath('observations') }, policy, profilePath } },
  sourceReviews: { owner, plugins: ['health-helper'], expiresAt } } as unknown as RsiSetupManifest
  const names = new Set(['approvals', 'releases', 'adoptions', 'observations'])
  return { root, manifest, binding: { owner: { id: owner.principalRecordId, version: owner.principalVersion } },
    async readAuthority(name) { return JSON.parse(await readFile(authorityPath(name), 'utf8')) },
    async writeAuthority(name, value) { if (!names.has(name)) throw new Error('unknown authority'); await writePrivate(authorityPath(name), `${JSON.stringify(value)}\n`) },
    async dispose() { await rm(root, { recursive: true, force: true }) } }
}
