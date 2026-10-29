import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { normalizeControlPlaneConfig } from '../src/index.ts'
import { validateSourceBuildConfig, type LinuxSourceBuildConfig } from '../src/source-build.ts'
import { linuxSourceConfig } from './helpers/linux-source-build-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function dualLinuxConfig(): LinuxSourceBuildConfig & Required<Pick<LinuxSourceBuildConfig, 'userNamespace' | 'systemSnapshot'>> {
  const ownerUid = process.getuid!(), ownerGid = process.getgid!()
  return { ...linuxSourceConfig(), userNamespace: { schemaVersion: 1, ownerUid, ownerGid,
    candidateUid: ownerUid + 65536, candidateGid: ownerGid + 65536,
    hostNamespace: { dev: 1, ino: 7 }, helpers: {
      uid: { path: '/usr/bin/newuidmap', sha256: '1'.repeat(64) }, gid: { path: '/usr/bin/newgidmap', sha256: '2'.repeat(64) } } },
    systemSnapshot: { schemaVersion: 1, root: { path: '/approved/system', dev: 1, ino: 3, sha256: '3'.repeat(64) },
      manifestSha256: '4'.repeat(64), bytes: 4096, entries: 16 } }
}

test('normalizes deployable minimal and coordinator profiles without creating state resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cp-deployment-config-')); roots.push(root)
  const base = { catalogPath: join(root, 'catalog.json'), trustPath: join(root, 'trust.json'), statePath: join(root, 'state') }
  const minimal = normalizeControlPlaneConfig(base)
  expect(minimal).toMatchObject({ ...base, proposalTtlMs: 900_000 })
  expect(existsSync(base.statePath)).toBe(false)
  const coordinate = normalizeControlPlaneConfig({ ...base, adoptionCoordinator: { coordinatorId: 'coordinator',
    scope: { workspace: root, preset: 'primary', principalId: 'owner', ownerRouteId: 'route' }, timeoutMs: 1_000,
    budgetId: 'adoption-runs', budgetAmount: 1 } })
  expect(coordinate.adoptionCoordinator).toMatchObject({ budgetId: 'adoption-runs', budgetAmount: 1 })
  expect(existsSync(base.statePath)).toBe(false)
})

test('rejects an unbudgeted coordinator and a source adoption chain without release execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cp-deployment-config-')); roots.push(root)
  const base = { catalogPath: join(root, 'catalog.json'), trustPath: join(root, 'trust.json'), statePath: join(root, 'state') }
  expect(() => normalizeControlPlaneConfig({ ...base, adoptionCoordinator: { coordinatorId: 'coordinator',
    scope: { workspace: root, preset: 'primary', principalId: 'owner', ownerRouteId: 'route' }, timeoutMs: 1_000, budgetAmount: 1 } as never })).toThrow('invalid adoption coordinator')
  expect(() => normalizeControlPlaneConfig({ ...base, sourceAdoptions: { profile: 'primary', planTtlMs: 60_000, timeoutMs: 1_000,
    authority: { executable: { path: '/bin/true', sha256: 'a'.repeat(64) }, configPath: '/tmp/authority.json', timeoutMs: 1_000 } } })).toThrow('sourceAdoptions requires sourceReleaseExecution')
  expect(existsSync(base.statePath)).toBe(false)
})

test.skipIf(process.platform !== 'linux')('admits durable Linux modify preparation and the connected source release and adoption lanes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cp-linux-deployment-config-')); roots.push(root)
  const base = { catalogPath: join(root, 'catalog.json'), trustPath: join(root, 'trust.json'), statePath: join(root, 'state') }
  const sourceBuild = { ...linuxSourceConfig(), stateRoot: join(root, 'repository-jobs') }
  const sourceJobs = { authorityId: 'source-grant', expiresAt: Date.now() + 60_000, maxSubmissions: 2,
    repository: root, workspace: root, preset: 'primary', ownerRouteId: 'owner-route', principalId: 'owner',
    budgetId: 'source-budget', budgetAmount: 1, allowedModes: ['modify'] as const }
  expect(() => normalizeControlPlaneConfig({ ...base, sourceBuild })).toThrow('requires durable sourceJobs')
  const config = normalizeControlPlaneConfig({ ...base, sourceBuild, sourceJobs: { ...sourceJobs, allowedModes: ['modify'] } })
  expect(config.sourceBuild).toEqual(sourceBuild)
  expect(config.sourceJobs?.allowedModes).toEqual(['modify'])
  const approvalAuthority = { executable: { path: '/bin/true', sha256: 'a'.repeat(64) },
    configPath: join(root, 'source-authority.json'), timeoutMs: 1_000 }
  // Empty lane objects reach each lane's own validator instead of a backend placeholder refusal.
  expect(() => normalizeControlPlaneConfig({ ...config, sourceReleases: {} as never })).toThrow('unknown or missing fields')
  expect(() => normalizeControlPlaneConfig({ ...config, sourceReleaseExecution: {} as never })).toThrow('invalid sourceReleaseExecution config')
  expect(() => normalizeControlPlaneConfig({ ...config, sourceAdoptions: {} as never })).toThrow('invalid source adoption config')
  // The generic chain gates remain backend-independent: releases need approvals plus Host patch versioning.
  expect(() => normalizeControlPlaneConfig({ ...config, sourceReleases: approvalAuthority }))
    .toThrow('sourceReleases requires sourceApprovals and Host patch versioning')
  expect(() => normalizeControlPlaneConfig({ ...config, sourceBuild: { ...sourceBuild, versioning: 'patch' as const },
    sourceReleases: approvalAuthority })).toThrow('sourceReleases requires sourceApprovals and Host patch versioning')
  for (const field of ['revisionVerifications', 'revisionRegressions']) {
    expect(() => normalizeControlPlaneConfig({ ...config, [field]: {} })).toThrow('dual-UID repository boundary')
  }
  const dual = normalizeControlPlaneConfig({ catalogPath: join(root, 'catalog-dual.json'), trustPath: join(root, 'trust-dual.json'),
    statePath: join(root, 'state-dual'), sourceBuild: { ...dualLinuxConfig(), stateRoot: join(root, 'dual-jobs') }, sourceJobs })
  expect(() => normalizeControlPlaneConfig({ ...dual, revisionVerifications: {} as never }))
    .toThrow('revision verification requires its separate finite grant and retained adopted source')
  expect(() => normalizeControlPlaneConfig({ ...dual, revisionRegressions: {} as never }))
    .toThrow('regression requires independently configured review and retained parent source')
  expect(() => normalizeControlPlaneConfig({ ...config, creationCapabilities: {} as never })).toThrow('requires the dual-UID repository boundary')
  expect(() => normalizeControlPlaneConfig({ ...config, creationVerifications: {} as never })).toThrow('requires the dual-UID repository boundary')
  // The full approval → release → execution → adoption chain normalizes on the linux-native modify boundary.
  const reviewRoot = join(root, 'review-decisions'); await mkdir(reviewRoot, { mode: 0o700 })
  const chained = normalizeControlPlaneConfig({ catalogPath: join(root, 'catalog-chain.json'), trustPath: join(root, 'trust-chain.json'),
    statePath: join(root, 'state-chain'), sourceBuild: { ...sourceBuild, versioning: 'patch' as const }, sourceJobs,
    sourceApprovals: approvalAuthority, sourceReleases: approvalAuthority,
    sourceReleaseExecution: { reviewDecisionRoot: reviewRoot, timeoutMs: 60_000 },
    sourceAdoptions: { profile: 'primary', planTtlMs: 60_000, timeoutMs: 1_000, authority: approvalAuthority } })
  expect(chained.sourceApprovals).toEqual(approvalAuthority)
  expect(chained.sourceReleases).toEqual(approvalAuthority)
  expect(chained.sourceReleaseExecution).toMatchObject({ reviewDecisionRoot: reviewRoot, timeoutMs: 60_000 })
  expect(chained.sourceAdoptions).toMatchObject({ profile: 'primary' })
  expect(existsSync(base.statePath)).toBe(false)
  expect(existsSync(sourceBuild.stateRoot)).toBe(false)
  expect(existsSync(join(root, 'state-chain'))).toBe(false)
})

test.skipIf(process.platform !== 'linux' || !process.getuid?.())('normalizes paired repository identities synchronously without acquiring runtime resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cp-dual-linux-config-')); roots.push(root)
  const sourceBuild = { ...dualLinuxConfig(), stateRoot: join(root, 'repository-jobs') }
  const config = normalizeControlPlaneConfig({ catalogPath: join(root, 'catalog.json'), trustPath: join(root, 'trust.json'),
    statePath: join(root, 'state'), sourceBuild, sourceJobs: { authorityId: 'source-grant', expiresAt: Date.now() + 60_000,
      maxSubmissions: 2, repository: root, workspace: root, preset: 'primary', ownerRouteId: 'owner-route', principalId: 'owner',
      budgetId: 'source-budget', budgetAmount: 1, allowedModes: ['modify'] } })
  expect(config.sourceBuild).toEqual(sourceBuild)
  expect(existsSync(sourceBuild.stateRoot)).toBe(false)
  expect(existsSync(join(root, 'state'))).toBe(false)
  const legacy = linuxSourceConfig()
  expect(() => validateSourceBuildConfig(legacy)).not.toThrow()
  expect('userNamespace' in legacy).toBe(false)
})

test.skipIf(process.platform !== 'linux' || !process.getuid?.()).each([
  ['partial mapping', (config: ReturnType<typeof dualLinuxConfig>) => { delete (config as LinuxSourceBuildConfig).systemSnapshot }],
  ['partial snapshot', (config: ReturnType<typeof dualLinuxConfig>) => { delete (config as LinuxSourceBuildConfig).userNamespace }],
  ['wrong owner UID', (config: ReturnType<typeof dualLinuxConfig>) => { config.userNamespace.ownerUid++ }],
  ['wrong owner GID', (config: ReturnType<typeof dualLinuxConfig>) => { config.userNamespace.ownerGid++ }],
  ['candidate UID equals owner', (config: ReturnType<typeof dualLinuxConfig>) => { config.userNamespace.candidateUid = config.userNamespace.ownerUid }],
  ['candidate GID equals owner', (config: ReturnType<typeof dualLinuxConfig>) => { config.userNamespace.candidateGid = config.userNamespace.ownerGid }],
  ['low candidate UID', (config: ReturnType<typeof dualLinuxConfig>) => { config.userNamespace.candidateUid = 65535 }],
  ['overflow candidate GID', (config: ReturnType<typeof dualLinuxConfig>) => { config.userNamespace.candidateGid = 0xffff_ffff }],
  ['fractional namespace inode', (config: ReturnType<typeof dualLinuxConfig>) => { config.userNamespace.hostNamespace.ino = 1.5 }],
  ['helper path substitution', (config: ReturnType<typeof dualLinuxConfig>) => { config.userNamespace.helpers.uid.path = '/tmp/newuidmap' as '/usr/bin/newuidmap' }],
  ['malformed helper hash', (config: ReturnType<typeof dualLinuxConfig>) => { config.userNamespace.helpers.gid.sha256 = 'bad' }],
  ['extra mapping key', (config: ReturnType<typeof dualLinuxConfig>) => { Object.assign(config.userNamespace, { extra: true }) }],
  ['extra helper key', (config: ReturnType<typeof dualLinuxConfig>) => { Object.assign(config.userNamespace.helpers.uid, { extra: true }) }],
  ['array mapping', (config: ReturnType<typeof dualLinuxConfig>) => { config.userNamespace = [] as unknown as typeof config.userNamespace }],
  ['null snapshot', (config: ReturnType<typeof dualLinuxConfig>) => { config.systemSnapshot = null as unknown as typeof config.systemSnapshot }],
  ['snapshot schema', (config: ReturnType<typeof dualLinuxConfig>) => { config.systemSnapshot.schemaVersion = 2 as 1 }],
  ['snapshot manifest hash', (config: ReturnType<typeof dualLinuxConfig>) => { config.systemSnapshot.manifestSha256 = 'BAD' }],
  ['snapshot byte limit', (config: ReturnType<typeof dualLinuxConfig>) => { config.systemSnapshot.bytes = 640 * 1024 ** 2 + 1 }],
  ['snapshot entry limit', (config: ReturnType<typeof dualLinuxConfig>) => { config.systemSnapshot.entries = 32769 }],
  ['snapshot unsafe path', (config: ReturnType<typeof dualLinuxConfig>) => { config.systemSnapshot.root.path = '/approved/system/../system' }],
  ['snapshot state overlap', (config: ReturnType<typeof dualLinuxConfig>) => { config.systemSnapshot.root.path = config.stateRoot + '/snapshot' }],
  ['snapshot state ancestor', (config: ReturnType<typeof dualLinuxConfig>) => { config.systemSnapshot.root.path = '/approved' }],
  ['snapshot runtime overlap', (config: ReturnType<typeof dualLinuxConfig>) => { config.systemSnapshot.root.path = config.runtime.root.path + '/system' }],
  ['snapshot runtime filesystem alias', (config: ReturnType<typeof dualLinuxConfig>) => {
    config.systemSnapshot.root.dev = config.runtime.root.dev; config.systemSnapshot.root.ino = config.runtime.root.ino
  }],
  ['extra snapshot root key', (config: ReturnType<typeof dualLinuxConfig>) => { Object.assign(config.systemSnapshot.root, { extra: true }) }],
] as const)('rejects %s before any repository authority is constructed', (_name, change) => {
  const config = dualLinuxConfig()
  change(config)
  expect(() => validateSourceBuildConfig(config)).toThrow('Linux source build configuration is invalid')
})
