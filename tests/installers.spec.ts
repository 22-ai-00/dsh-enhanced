import { appendFile, chmod, cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { RECOVERY_CATALOG_DIGEST } from '@dsh-enhanced/assistant-recovery'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'
import { nativeInstallerHost, nativeInstallerSetupPackage } from './native-installer-host-fixture.ts'
import { rsiMemoryLearningInitialRow } from '../plugins/lark-channel/src/rsi-local-roots-extension.ts'
import { assertEffectiveSupervisedGrowthConfig, configureSupervisedGrowthProfilePatch } from '../plugins/lark-channel/src/supervised-growth-profile.ts'
import { createInstallerFixtures } from './helpers/installer-fixtures.ts'

const {
  cleanupInstallerFixtures,
  repoRoot,
  installDirectory,
  localInstaller,
  npmInstaller,
  installerLibrary,
  pathWithoutTraex,
  temporaryRoots,
  digest64,
  runInstaller,
  temporaryDshHome,
  writeExecutable,
  lifecycleFixture,
  nativePreOwnerLifecycleFixture,
  runPreOwnerLifecycle,
  lifecycleEnvironment,
  runServiceLifecycle,
  readJsonLines,
  readLifecycleSystemdState,
  readLifecycleSystemdLog,
  lifecycleIdentity,
  serviceLifecycleBinding,
} = createInstallerFixtures()

afterEach(cleanupInstallerFixtures)

const restartScript = join(installDirectory, 'restart.sh')
const pinnedInstallerSource = readFileSync(npmInstaller, 'utf8')
const pinnedReleaseRef = pinnedInstallerSource.match(/^DSH_ENHANCED_PINNED_RELEASE_REF='([^']+)'$/mu)?.[1]
const pinnedLifecycleConfigHash = pinnedInstallerSource
  .match(/^DSH_ENHANCED_PINNED_LIFECYCLE_CONFIG_SHA256='([0-9a-f]{64})'$/mu)?.[1]
const pinnedLifecycleProfileHash = pinnedInstallerSource
  .match(/^DSH_ENHANCED_PINNED_LIFECYCLE_PROFILE_SHA256='([0-9a-f]{64})'$/mu)?.[1]
const pinnedRemoteCommon = pinnedReleaseRef === undefined ? undefined : spawnSync('git', [
  'show', `${pinnedReleaseRef}:scripts/install/common.sh`,
], {
  cwd: repoRoot,
  encoding: 'buffer',
})
const pinnedRemoteLifecycleConfig = pinnedReleaseRef === undefined ? undefined : spawnSync('git', [
  'show', `${pinnedReleaseRef}:scripts/install/lifecycle-config.mjs`,
], { cwd: repoRoot, encoding: 'buffer' })
const pinnedRemoteLifecycleProfile = pinnedReleaseRef === undefined ? undefined : spawnSync('git', [
  'show', `${pinnedReleaseRef}:scripts/install/lifecycle-profile.mjs`,
], { cwd: repoRoot, encoding: 'buffer' })

function supervisedProof(protocol: string, schemaVersion: number, extras: Record<string, unknown> = {}) {
  return {
    protocol, schemaVersion, database: { device: '1', inode: '2', size: '3', digest: digest64 },
    snapshotDigest: digest64, ...extras,
  }
}

function supervisedManifestFixture(phase: string) {
  const recoveryProof = supervisedProof('assistant-recovery/operator-snapshot/v1', 5, {
    bootstrap: { status: 'succeeded', generation: 1, attestationValid: true,
      attestationSetDigest: digest64, attestations: [{ automationId: 'recovery:supervised-growth',
        activationState: 'active', activationNonce: 'old', activationPlanDigest: digest64 }] },
  })
  const source = {
    effectiveConfigDigest: digest64, semanticDigest: digest64,
    databasePaths: { delivery: 'assistant-delivery/state.sqlite', automations: 'assistant-automations/state.sqlite', recovery: 'assistant-recovery/state.sqlite' },
    ownerBindingDigest: digest64,
    unmanagedAutomationsDigest: digest64,
    deliveryProof: supervisedProof('assistant-delivery/active-lark-owner-bindings-snapshot/v1', 23, { storageDigest: digest64 }),
    recoveryProof,
    automationsProof: supervisedProof('assistant-automations-operator-snapshot/v1', 15, { inventoryDigest: digest64, storageDigest: digest64 }),
    activePlan: { effectiveConfigDigest: digest64, attestationSetDigest: digest64,
      managedInventoryDigest: digest64, attestationDigest: digest64, activationNonceDigest: digest64, catalogDigest: digest64 },
  }
  const acceptance = (generation: number) => ({ generation, deliveryProof: source.deliveryProof,
    ownerBindingDigest: digest64, unmanagedAutomationsDigest: digest64,
    databasePaths: source.databasePaths, attestationDigest: digest64, invocationId: 'fresh-web-1',
    recoveryProof: { ...recoveryProof, bootstrap: { ...recoveryProof.bootstrap, generation } },
    automationsProof: source.automationsProof })
  const plan = { patchDigest: digest64, effectiveConfigDigest: digest64, attestationSetDigest: digest64,
    managedInventoryDigest: digest64, ownerBindingDigest: digest64, externalProviderExemptions: ['larkChannel'], runtimeOverlayDigest: digest64 }
  const { runtimeOverlayDigest: _runtimeOverlayDigest, ...activePlan } = plan
  return { protocol: 'dsh-enhanced/supervised-lifecycle/v1', phase,
    activationNonce: '12345678-1234-4123-8123-123456789abc', catalogDigest: digest64,
    databasePaths: source.databasePaths, source, previewPlan: plan,
    previewAcceptance: (({ invocationId: _invocationId, ...value }) => value)(acceptance(2)),
    activePlan: { ...activePlan, externalProviderExemptions: [] },
    startAttempt: { kind: 'accept-active', baselineGeneration: 2 },
    postSwapAcceptance: acceptance(3),
  }
}

function supervisedUninstallLifecycleFixture(phase: string) {
  const source = supervisedManifestFixture('post-swap-accepted').source
  return {
    protocol: 'dsh-enhanced/supervised-uninstall/v1',
    phase,
    ...(['source-attested', 'clean-target-validated', 'clean-target-pending', 'clean-target-accepted'].includes(phase)
      ? { databasePaths: source.databasePaths, source }
      : {}),
  }
}

function supervisedUninstallManifestFixture(phase = 'clean-target-accepted') {
  const lifecycle = supervisedUninstallLifecycleFixture(phase)
  const stateByPhase: Record<string, [string, string]> = {
    'source-pending': ['preparing', 'stopped'],
    'source-attested': ['prepared', 'stopped'],
    'clean-target-validated': ['validated', 'stopped'],
    'clean-target-pending': ['swapped', 'starting'],
    'clean-target-accepted': ['service-accepted', 'service-accepted'],
  }
  const [state, servicePhase] = stateByPhase[phase]!
  const id = '11111111-2222-4333-8444-555555555555'
  const accepted = { unit: 'dsh-profile-web.service', invocationId: 'fresh-web-1', mainPid: 42, nRestarts: 0 }
  const cleanPhase = ['clean-target-validated', 'clean-target-pending', 'clean-target-accepted'].includes(phase)
  return {
    version: 3, id, profile: 'web', operation: 'uninstall', expectedScenario: 'supervised',
    stagedScenario: 'unsupported', state, servicePhase,
    originalProfileDigest: digest64,
    ...(phase === 'source-pending' ? {} : { originalProfileTreeDigest: digest64 }),
    ...(cleanPhase ? { cleanProfileDigest: digest64 } : {}),
    services: [{ unit: 'dsh-profile-web.service', wasActive: true }],
    ...(phase === 'clean-target-accepted' ? { serviceAcceptance: [accepted] } : {}),
    ...(cleanPhase ? {
      archivedProfile: {
        relativePath: `uninstalled-profiles/web-20260911T000000000Z-${id}`,
        identity: { dev: '1', ino: '2', uid: process.getuid?.() ?? 0, mode: 0o40700 },
        profileDigest: digest64, treeDigest: digest64,
      },
    } : {}),
    supervisedLifecycle: lifecycle,
  }
}

describe('supervised lifecycle v3 invariants', () => {
  test('validates supervised uninstall as a strict operation/protocol/phase union', () => {
    const validator = (lifecycleProfileTest as typeof lifecycleProfileTest & {
      validV3OperationShape(value: unknown): boolean
    }).validV3OperationShape
    for (const phase of [
      'source-pending', 'source-attested', 'clean-target-validated', 'clean-target-pending', 'clean-target-accepted',
    ]) {
      const manifest = supervisedUninstallManifestFixture(phase)
      expect(validator(manifest), phase).toBe(true)
      expect(lifecycleProfileTest.validSupervisedLifecycle(manifest.supervisedLifecycle, 'uninstall'), phase).toBe(true)
    }

    const accepted = supervisedUninstallManifestFixture()
    const rejects = [
      { ...accepted, operation: 'upgrade' },
      { ...accepted, stagedScenario: 'supervised' },
      { ...accepted, supervisedLifecycle: { ...accepted.supervisedLifecycle, protocol: 'dsh-enhanced/supervised-lifecycle/v1' } },
      { ...accepted, supervisedLifecycle: { ...accepted.supervisedLifecycle, phase: 'post-swap-accepted' } },
      { ...accepted, supervisedLifecycle: { ...accepted.supervisedLifecycle, activationNonce: 'smuggled' } },
      { ...accepted, supervisedLifecycle: { ...accepted.supervisedLifecycle, startAttempt: { kind: 'accept-active', baselineGeneration: 2 } } },
      { ...accepted, archivedProfile: { ...accepted.archivedProfile, extra: true } },
    ]
    for (const candidate of rejects) expect(validator(candidate)).toBe(false)
  })

  test('accepts only the exact phase payload and rejects future fields or proof type drift', () => {
    const accepted = supervisedManifestFixture('post-swap-accepted')
    expect(lifecycleProfileTest.validSupervisedLifecycle(accepted)).toBe(true)
    const early = supervisedManifestFixture('source-pending')
    expect(lifecycleProfileTest.validSupervisedLifecycle(early)).toBe(false)
    expect(lifecycleProfileTest.validSupervisedLifecycle({ ...accepted, unknown: true })).toBe(false)
    expect(lifecycleProfileTest.validSupervisedLifecycle({
      ...accepted, source: { ...accepted.source, recoveryProof: {
        ...accepted.source.recoveryProof, database: { ...accepted.source.recoveryProof.database, size: false },
      } },
    })).toBe(false)
  })

  test('accepts only reviewed Automations schema 15 through 18 compact proofs across all lifecycle phases', () => {
    const locations = ['source', 'previewAcceptance', 'postSwapAcceptance'] as const
    for (const schemaVersion of [15, 16, 17, 18]) {
      const accepted = structuredClone(supervisedManifestFixture('post-swap-accepted'))
      for (const location of locations) accepted[location].automationsProof = {
        ...accepted[location].automationsProof, schemaVersion,
      }
      expect(lifecycleProfileTest.validSupervisedLifecycle(accepted), `reviewed schema ${schemaVersion}`).toBe(true)
    }
    for (const schemaVersion of [14, 19, 0, -1, 16.5, '16', null]) for (const location of locations) {
      const rejected = structuredClone(supervisedManifestFixture('post-swap-accepted'))
      rejected[location].automationsProof = { ...rejected[location].automationsProof, schemaVersion } as never
      expect(lifecycleProfileTest.validSupervisedLifecycle(rejected), `${location} schema ${schemaVersion}`).toBe(false)
    }
  })

  test('accepts reviewed Delivery schema 23 through 31 compact proofs and rejects schema 32 in every phase', () => {
    const locations = ['source', 'previewAcceptance', 'postSwapAcceptance'] as const
    for (const schemaVersion of [23, 24, 25, 26, 27, 28, 29, 30, 31]) {
      const accepted = structuredClone(supervisedManifestFixture('post-swap-accepted'))
      for (const location of locations) accepted[location].deliveryProof.schemaVersion = schemaVersion
      expect(lifecycleProfileTest.validSupervisedLifecycle(accepted), `reviewed schema ${schemaVersion}`).toBe(true)
      for (const location of locations) {
        const rejected = structuredClone(accepted)
        rejected[location].deliveryProof.schemaVersion = 32
        expect(lifecycleProfileTest.validSupervisedLifecycle(rejected), `${location} schema 32`).toBe(false)
      }
    }
  })

  test('requires post-swap proof to bind the accepted systemd InvocationID', () => {
    const accepted = supervisedManifestFixture('post-swap-accepted')
    expect(lifecycleProfileTest.validSupervisedLifecycle(accepted)).toBe(true)
    const missing = structuredClone(accepted)
    delete (missing.postSwapAcceptance as { invocationId?: string }).invocationId
    expect(lifecycleProfileTest.validSupervisedLifecycle(missing)).toBe(false)
  })

  test('binds supervised phases to outer service state and requires a fresh start baseline', () => {
    const accepted = supervisedManifestFixture('post-swap-accepted')
    expect(lifecycleProfileTest.validSupervisedManifestPhase({
      version: 3, state: 'service-accepted', servicePhase: 'service-accepted', supervisedLifecycle: accepted,
    })).toBe(true)
    expect(lifecycleProfileTest.validSupervisedManifestPhase({
      version: 3, state: 'prepared', servicePhase: 'stopped', supervisedLifecycle: accepted,
    })).toBe(false)
    const pending = { ...accepted, phase: 'post-swap-pending', postSwapAcceptance: undefined, startAttempt: undefined }
    expect(lifecycleProfileTest.validSupervisedLifecycle(pending)).toBe(false)
    const missingBaseline = structuredClone(accepted)
    delete (missingBaseline as { startAttempt?: unknown }).startAttempt
    expect(() => lifecycleProfileTest.validSupervisedLifecycle(missingBaseline)).not.toThrow()
    expect(lifecycleProfileTest.validSupervisedLifecycle(missingBaseline)).toBe(false)
    const wrongKind = structuredClone(accepted)
    wrongKind.startAttempt.kind = 'restore-source'
    expect(lifecycleProfileTest.validSupervisedLifecycle(wrongKind)).toBe(false)
  })

  test('validates v3 service acceptance schema, active coverage, uniqueness, and target invocation binding', () => {
    const lifecycle = supervisedManifestFixture('post-swap-accepted')
    const service = (unit: string, wasActive: boolean) => ({ unit, wasActive })
    const accepted = (unit: string, invocationId: string) => ({
      unit, invocationId, mainPid: 42, nRestarts: 0,
    })
    const manifest = {
      version: 3, profile: 'web', state: 'service-accepted', servicePhase: 'service-accepted',
      services: [service('dsh-profile-web.service', true), service('dsh-profile-worker.service', true),
        service('dsh-profile-dormant.service', false)],
      serviceAcceptance: [accepted('dsh-profile-web.service', 'fresh-web-1'),
        accepted('dsh-profile-worker.service', 'fresh-worker-1')],
      supervisedLifecycle: lifecycle,
    }
    const valid = lifecycleProfileTest.validV3ServiceAcceptance
    expect(valid(manifest)).toBe(true)
    expect(valid({ ...manifest, serviceAcceptance: undefined })).toBe(false)
    expect(valid({ ...manifest, serviceAcceptance: [manifest.serviceAcceptance[0], manifest.serviceAcceptance[0]] })).toBe(false)
    expect(valid({ ...manifest, serviceAcceptance: [...manifest.serviceAcceptance,
      accepted('dsh-profile-foreign.service', 'fresh-foreign-1')] })).toBe(false)
    expect(valid({ ...manifest, serviceAcceptance: [manifest.serviceAcceptance[0]] })).toBe(false)
    expect(valid({ ...manifest, serviceAcceptance: [...manifest.serviceAcceptance,
      accepted('dsh-profile-dormant.service', 'fresh-dormant-1')] })).toBe(false)
    expect(valid({ ...manifest, serviceAcceptance: [
      { ...manifest.serviceAcceptance[0], extra: true }, manifest.serviceAcceptance[1],
    ] })).toBe(false)
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      expect(valid({ ...manifest, serviceAcceptance: [
        { ...manifest.serviceAcceptance[0], mainPid: invalid }, manifest.serviceAcceptance[1],
      ] })).toBe(false)
      expect(valid({ ...manifest, serviceAcceptance: [
        manifest.serviceAcceptance[0], { ...manifest.serviceAcceptance[1], nRestarts: invalid },
      ] })).toBe(false)
    }
    expect(valid({ ...manifest, serviceAcceptance: [
      { ...manifest.serviceAcceptance[0], invocationId: '' }, manifest.serviceAcceptance[1],
    ] })).toBe(false)
    expect(valid({ ...manifest, serviceAcceptance: [
      { ...manifest.serviceAcceptance[0], invocationId: 'fresh-web-mismatch' }, manifest.serviceAcceptance[1],
    ] })).toBe(false)
    expect(valid({ ...manifest, state: 'swapped', servicePhase: 'starting',
      supervisedLifecycle: { ...lifecycle, phase: 'post-swap-pending', postSwapAcceptance: undefined } })).toBe(true)
    expect(valid({ ...manifest, state: 'service-failed', servicePhase: 'service-failed' })).toBe(true)
    expect(valid({ ...manifest, state: 'committed', servicePhase: 'service-accepted' })).toBe(true)
    expect(valid({ ...manifest, state: 'cleanup-started', servicePhase: 'service-accepted' })).toBe(true)
    const pending = { ...manifest, state: 'swapped', servicePhase: 'starting', serviceAcceptance: undefined,
      supervisedLifecycle: { ...lifecycle, phase: 'post-swap-pending', postSwapAcceptance: undefined } }
    expect(valid(pending)).toBe(true)
    expect(valid({ ...manifest, state: 'prepared', servicePhase: 'stopped' })).toBe(false)
  })

  test.skipIf(process.platform !== 'linux')('v3 recovery loader rejects malformed service acceptance before external mutation', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised',
      systemd: { units: [
        { profile: 'web', active: true },
        { profile: 'dormant', active: false },
        { profile: 'foreign', active: true, dshHome: '__other__', fragment: 'foreign' },
      ] },
    })
    const dormantDirectory = join(f.dshHome, 'profiles', 'dormant')
    await writeFile(join(dormantDirectory, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-dormant', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
    }, null, 2)}\n`)
    await writeFile(join(dormantDirectory, 'cordis.yml'), '[]\n')
    await writeFile(join(dormantDirectory, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(dormantDirectory, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    const initial = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', canonicalCleanupFails: true, systemdUnsupportedProfile: 'dormant' },
    )
    expect(initial.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const manifestPath = join(transaction, 'manifest.json')
    const valid = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, any>
    expect(valid).toMatchObject({ version: 3, state: 'cleanup-started', servicePhase: 'service-accepted' })
    const accepted = valid.serviceAcceptance[0]
    const mutations: Array<[string, (manifest: Record<string, any>) => void]> = [
      ['missing', manifest => { delete manifest.serviceAcceptance }],
      ['duplicate', manifest => { manifest.serviceAcceptance = [accepted, accepted] }],
      ['extra', manifest => { manifest.serviceAcceptance = [accepted,
        { ...accepted, unit: 'dsh-profile-foreign.service' }] }],
      ['invalid type', manifest => { manifest.serviceAcceptance = [{ ...accepted, mainPid: '42' }] }],
      ['coverage不足', manifest => { manifest.serviceAcceptance = [{ ...accepted, unit: 'dsh-profile-dormant.service' }] }],
      ['invocation mismatch', manifest => { manifest.serviceAcceptance = [{ ...accepted, invocationId: 'fresh-web-mismatch' }] }],
    ]
    for (const [index, [label, mutate]] of mutations.entries()) {
      const candidate = structuredClone(valid)
      mutate(candidate)
      candidate.updatedAt = `2026-09-11T12:00:${String(index).padStart(2, '0')}.000Z`
      candidate.bindingDigest = createHash('sha256')
        .update(JSON.stringify(serviceLifecycleBinding(candidate))).digest('hex')
      await writeFile(manifestPath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 })
      const systemdBefore = await readFile(f.systemdLog, 'utf8')
      const operationBefore = await readFile(f.operationLog, 'utf8')
      const homeBefore = await lifecycleIdentity(f.dshHome)
      const backupBefore = await lifecycleIdentity(join(transaction, 'original-home'))

      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' },
      )

      expect(result.status, label).not.toBe(0)
      expect(result.stderr, label).toMatch(/manifest.*校验失败|未绑定/iu)
      expect(await readFile(f.systemdLog, 'utf8'), label).toBe(systemdBefore)
      expect(await readFile(f.operationLog, 'utf8'), label).toBe(operationBefore)
      expect(await lifecycleIdentity(f.dshHome), label).toEqual(homeBefore)
      expect(await lifecycleIdentity(join(transaction, 'original-home')), label).toEqual(backupBefore)
    }
  }, 30_000)

  test('the manifest envelope rejects unknown top-level fields and enforces the 64KiB write cap (F10)', async () => {
    const validTopLevel = lifecycleProfileTest.validManifestTopLevel
    expect(validTopLevel({ version: 1, bindingDigest: digest64, updatedAt: '2026-09-11T00:00:00.000Z' })).toBe(true)
    expect(validTopLevel({ version: 1, smuggled: true })).toBe(false)
    expect(validTopLevel({ version: 1, failure: 'x' })).toBe(true)
    expect(validTopLevel({ version: 1, failure: 42 })).toBe(false)
    const transactionRoot = await mkdtemp(join(tmpdir(), 'dsh-f10-manifest-'))
    temporaryRoots.push(transactionRoot)
    await expect(lifecycleProfileTest.writeManifest(transactionRoot, { id: 'x', smuggled: true }, 'preparing'))
      .rejects.toThrow(/未知顶层字段/u)
    await expect(lifecycleProfileTest.writeManifest(
      transactionRoot, { id: 'x', failure: 'a'.repeat(lifecycleProfileTest.MANIFEST_MAX_BYTES) }, 'preparing',
    )).rejects.toThrow(/65536|安全上限/u)
    await expect(readFile(join(transactionRoot, 'manifest.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('raw generation inspection permits unfinished bootstrap while accepted proof remains strict', () => {
    const snapshot = {
      effectiveConfigDigest: digest64, semanticDigest: digest64,
      databasePaths: { delivery: 'delivery.sqlite', automations: 'automations.sqlite', recovery: 'recovery.sqlite' },
      delivery: { ...supervisedProof('assistant-delivery/active-lark-owner-bindings-snapshot/v1', 23), bindings: [{ id: 'binding-1' }] },
      recovery: { ...supervisedProof('assistant-recovery/operator-snapshot/v1', 5),
        bootstrap: { status: 'running', generation: 0, attestationValid: false, attestationSetDigest: '', attestations: [] } },
      automations: { ...supervisedProof('assistant-automations-operator-snapshot/v1', 15), inFlightCount: 1, inventoryDigest: digest64, storageDigest: digest64, records: [], sidecars: { wal: null, shm: null } },
      managedProjection: { protocol: 'dsh-enhanced/supervised-growth-managed-automations/v1', records: [], digest: digest64 },
      ownerBindingDigest: digest64,
    }
    expect(lifecycleProfileTest.compactSupervisedSnapshot(snapshot, false).recoveryProof.bootstrap.generation).toBe(0)
    expect(() => lifecycleProfileTest.compactSupervisedSnapshot(snapshot, true)).toThrow(/operator snapshot/iu)
  })

  test('pins preview-only exemption, owner binding, managed plan and overlay digests', () => {
    const accepted = supervisedManifestFixture('post-swap-accepted')
    for (const mutate of [
      (value: ReturnType<typeof supervisedManifestFixture>) => { value.previewPlan.externalProviderExemptions = [] },
      (value: ReturnType<typeof supervisedManifestFixture>) => { value.activePlan.externalProviderExemptions = ['larkChannel'] },
      (value: ReturnType<typeof supervisedManifestFixture>) => { value.previewPlan.runtimeOverlayDigest = 'b'.repeat(64) + 'extra' },
      (value: ReturnType<typeof supervisedManifestFixture>) => { value.activePlan.ownerBindingDigest = '' },
      (value: ReturnType<typeof supervisedManifestFixture>) => { value.previewAcceptance.recoveryProof.bootstrap.attestationSetDigest = 'b'.repeat(64) },
    ]) {
      const candidate = structuredClone(accepted)
      mutate(candidate)
      expect(lifecycleProfileTest.validSupervisedLifecycle(candidate)).toBe(false)
    }
  })
})

async function nativeModelSetupHost(dshHome: string, fakeBin: string): Promise<void> {
  const hostRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-enhanced-model-host-')))
  temporaryRoots.push(hostRoot)
  const executable = await nativeInstallerHost(hostRoot, `#!/bin/bash
if [[ "${'$'}{1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
if [[ " $* " == *' --dump-config '* ]]; then
  "$NODE_BIN" - "$DSH_HOME/profiles/web/cordis.patch.yml" <<'NODE'
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const yaml = createRequire(process.env.MODEL_SETUP_SOURCE)('yaml')
const rows = [
  { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
  { id: 'dsh-enhanced-traex-acp-provider', name: '@dsh-enhanced/traex-acp-provider', config: { enabled: false } },
]
if (existsSync(process.argv[2])) {
  const patch = yaml.parseDocument(readFileSync(process.argv[2], 'utf8'))
  if (patch.errors.length > 0 || !yaml.isSeq(patch.contents)) process.exit(3)
  for (const entry of patch.contents.items) {
    if (!yaml.isMap(entry) || typeof entry.get('id') !== 'string') continue
    const value = entry.toJSON()
    const index = rows.findIndex(row => row.id === value.id)
    if (index < 0) rows.push(value)
    else rows[index] = { ...rows[index], ...value }
  }
}
if (process.env.DSH_FAKE_CONCURRENT_STATE === '1' && rows.find(row => row.id === 'dsh-enhanced-traex-acp-provider').config?.enabled === true) {
  writeFileSync(process.env.DSH_HOME + '/settings.yaml', 'agent-default-model:\\n  provider: concurrent-owner\\n')
  writeFileSync(process.argv[2], '- id: dsh-enhanced-traex-acp-provider\\n  config: { enabled: false, command: /fake/traex }\\n')
  rows.find(row => row.id === 'dsh-enhanced-traex-acp-provider').config.enabled = false
}
if (process.env.DSH_FAKE_COMPOSED_DISABLED === '1') rows.find(row => row.id === 'dsh-enhanced-traex-acp-provider').disabled = true
process.stdout.write(yaml.stringify(rows))
NODE
  exit $?
fi
exit 7
`)
  await symlink(executable, join(fakeBin, 'dsh'))
}

async function autoTraexSetupFixture(commandName: 'traex' | 'trae-cli', loggedIn: boolean,
  policyLayout: 'top-level' | 'nested' = 'top-level') {
  const dshHome = await temporaryDshHome()
  const fakeBin = join(dshHome, 'fake-bin')
  const profileBin = join(dshHome, 'profiles', 'web', 'node_modules', '.bin')
  await mkdir(fakeBin, { recursive: true })
  await mkdir(profileBin, { recursive: true })
  const profileModules = join(dshHome, 'profiles', 'web', 'node_modules')
  await writeFile(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', type: 'module',
    dependencies: { [policyLayout === 'nested' ? '@dsh-enhanced/personal-assistant' : '@dsh-enhanced/assistant-policy']: '0.1.48' },
    dsh: { profile: { bundles: policyLayout === 'nested' ? ['@dsh-enhanced/personal-assistant'] : [] } },
  }))
  await mkdir(join(profileModules, '@dsh-enhanced'), { recursive: true })
  await symlink(join(repoRoot, 'plugins', 'traex-acp-provider'),
    join(profileModules, '@dsh-enhanced', 'traex-acp-provider'), 'dir')
  if (policyLayout === 'nested') {
    const personalDir = join(profileModules, '@dsh-enhanced', 'personal-assistant')
    await mkdir(join(personalDir, 'node_modules', '@dsh-enhanced'), { recursive: true })
    await writeFile(join(personalDir, 'package.json'), JSON.stringify({
      name: '@dsh-enhanced/personal-assistant', version: '0.1.48', type: 'module',
      dependencies: { '@dsh-enhanced/assistant-policy': '0.1.48' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(personalDir, 'cordis.patch.yml'), '[]\n')
    await symlink(join(repoRoot, 'plugins', 'assistant-policy'),
      join(personalDir, 'node_modules', '@dsh-enhanced', 'assistant-policy'), 'dir')
  } else {
    await symlink(join(repoRoot, 'plugins', 'assistant-policy'),
      join(profileModules, '@dsh-enhanced', 'assistant-policy'), 'dir')
  }
  await writeExecutable(join(fakeBin, commandName), `#!/bin/bash
if [[ "$*" == 'login status' ]]; then
  printf '%s\\n' '${loggedIn ? 'Logged in using Trae' : 'Not logged in'}'
  exit 0
fi
exit 7
`)
  await nativeModelSetupHost(dshHome, fakeBin)
  await writeExecutable(join(profileBin, 'dsh-model-setup'), `#!/bin/bash
exec "$NODE_BIN" --experimental-strip-types --input-type=module -e 'import(process.env.MODEL_SETUP_SOURCE).then(m => m.runModelSetup(process.argv.slice(1))).catch(error => { process.stderr.write(String(error) + "\\n"); process.exitCode = 1 })' -- "$@"
`)
  const environment = {
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    DSH_HOME: dshHome,
    NODE_BIN: process.execPath,
    MODEL_SETUP_SOURCE: join(repoRoot, 'plugins', 'assistant-policy', 'src', 'model-setup.ts'),
  }
  return { dshHome, fakeBin, commandPath: join(fakeBin, commandName), environment }
}

function runRestart(args: readonly string[], dshHome: string, platform?: string) {
  return spawnSync('/bin/bash', [restartScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      DSH_HOME: dshHome,
      DSH_ENHANCED_DRY_RUN: '1',
      ...(platform === undefined ? {} : { DSH_ENHANCED_PLATFORM_OVERRIDE: platform }),
    },
  })
}

async function configureExistingLark(dshHome: string, profile = 'web'): Promise<void> {
  const profileDirectory = join(dshHome, 'profiles', profile)
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({ dependencies: {} }))
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')
}

const zeroSha256 = '0'.repeat(64)

function withPinnedLifecycleHashes(source: string, configHash: string, profileHash: string): string {
  return source
    .replace(
      /^DSH_ENHANCED_PINNED_LIFECYCLE_CONFIG_SHA256='[0-9a-f]{64}'$/mu,
      `DSH_ENHANCED_PINNED_LIFECYCLE_CONFIG_SHA256='${configHash}'`,
    )
    .replace(
      /^DSH_ENHANCED_PINNED_LIFECYCLE_PROFILE_SHA256='[0-9a-f]{64}'$/mu,
      `DSH_ENHANCED_PINNED_LIFECYCLE_PROFILE_SHA256='${profileHash}'`,
    )
}

interface RemoteBootstrapFixture {
  assets: Record<'common.sh' | 'lifecycle-config.mjs' | 'lifecycle-profile.mjs' | 'host-lifecycle.mjs' | 'host-profile-update.mjs' | 'host-rsi-update.mjs', string>
  assetDirectory: string
  dshHome: string
  fakeBin: string
  hashes: Record<keyof RemoteBootstrapFixture['assets'], string>
  logPath: string
  temporaryDirectory: string
}

async function remoteBootstrapFixture(
  replacements: Partial<RemoteBootstrapFixture['assets']> = {},
): Promise<RemoteBootstrapFixture> {
  // Bootstrap intentionally validates every real TMPDIR ancestor. Keep this
  // small trust fixture under Linux's root-owned system tmp, independently
  // of a capacity-oriented TMPDIR whose ancestors may belong to another UID.
  const root = await realpath(await temporaryDshHome(process.platform === 'linux' ? '/tmp' : tmpdir()))
  const assetDirectory = join(root, 'release-assets')
  const fakeBin = join(root, 'bin')
  const temporaryDirectory = join(root, 'tmp')
  const dshHome = join(root, 'dsh-home')
  const logPath = join(root, 'bootstrap.log')
  await Promise.all([
    mkdir(assetDirectory),
    mkdir(fakeBin),
    mkdir(temporaryDirectory, { mode: 0o700 }),
  ])
  const assets = {
    'common.sh': [
      '#!/usr/bin/env bash',
      'printf \'source:common\\n\' >> "$REMOTE_BOOTSTRAP_LOG"',
      'dsh_enhanced_install() {',
      '  { printf \'run\'; printf \'\\t%s\' "$@"; printf \'\\n\'; } >> "$REMOTE_BOOTSTRAP_LOG"',
      '  mkdir -p "$DSH_HOME"',
      '  printf \'mutated\\n\' > "$DSH_HOME/bootstrap-ran"',
      '}',
      '',
    ].join('\n'),
    'lifecycle-config.mjs': '// lifecycle config fixture\n',
    'lifecycle-profile.mjs': '// lifecycle profile fixture\n',
    'host-lifecycle.mjs': '// host lifecycle fixture\n',
    'host-profile-update.mjs': '// host profile fixture\n',
    'host-rsi-update.mjs': '// host rsi fixture\n',
    ...replacements,
  }
  await Promise.all(Object.entries(assets).map(([name, source]) => (
    writeFile(join(assetDirectory, name), source, 'utf8')
  )))
  await writeExecutable(join(fakeBin, 'curl'), [
    '#!/bin/bash',
    'set -euo pipefail',
    "url=''",
    "destination=''",
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    -o) destination="$2"; shift 2 ;;',
    '    -*) shift ;;',
    '    *) url="$1"; shift ;;',
    '  esac',
    'done',
    'asset="$(basename "$url")"',
    'printf \'download\\t%s\\n\' "$url" >> "$REMOTE_BOOTSTRAP_LOG"',
    'cp "$REMOTE_BOOTSTRAP_ASSETS/$asset" "$destination"',
    'if [[ "$REMOTE_BOOTSTRAP_TAMPER" == "$asset" ]]; then',
    '  printf \'tampered\\n\' >> "$destination"',
    'fi',
    '',
  ].join('\n'))
  await writeExecutable(join(fakeBin, 'sha256sum'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'asset="$(basename "$1" .download)"',
    'printf \'verify\\t%s\\n\' "$asset" >> "$REMOTE_BOOTSTRAP_LOG"',
    `"$REMOTE_BOOTSTRAP_NODE" -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); for (const path of process.argv.slice(1)) console.log(createHash("sha256").update(readFileSync(path)).digest("hex") + "  " + path)' "$@"`,
    '',
  ].join('\n'))
  await writeExecutable(join(fakeBin, 'stat'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'target="${@: -1}"',
    'if [[ -n "${REMOTE_BOOTSTRAP_ROOT_STAT_PATHS:-}" ]]; then',
    '  IFS=":" read -r -a __root_paths <<< "$REMOTE_BOOTSTRAP_ROOT_STAT_PATHS"',
    '  for __p in "${__root_paths[@]}"; do',
    '    if [[ "$target" == "$__p" && ( "${1:-}" == -c || "${1:-}" == -f ) ]]; then',
    '      raw="$(/usr/bin/stat "$@")"',
    '      IFS=":" read -r device inode _ mode links type <<< "$raw"',
    "      printf '%s:%s:0:%s:%s:%s\\n' \"$device\" \"$inode\" \"$mode\" \"$links\" \"$type\"",
    '      exit 0',
    '    fi',
    '  done',
    'fi',
    'if [[ -n "${REMOTE_BOOTSTRAP_FOREIGN_STAT_PATH:-}" && "$target" == "$REMOTE_BOOTSTRAP_FOREIGN_STAT_PATH" && ( "${1:-}" == -c || "${1:-}" == -f ) ]]; then',
    '  raw="$(/usr/bin/stat "$@")"',
    '  IFS=: read -r device inode _ mode links type <<< "$raw"',
    "  printf '%s:%s:%s:%s:%s:%s\\n' \"$device\" \"$inode\" \"$REMOTE_BOOTSTRAP_FOREIGN_UID\" \"$mode\" \"$links\" \"$type\"",
    '  exit 0',
    'fi',
    'exec /usr/bin/stat "$@"',
    '',
  ].join('\n'))
  const hashes = Object.fromEntries(Object.entries(assets).map(([name, source]) => [
    name, createHash('sha256').update(source).digest('hex'),
  ])) as RemoteBootstrapFixture['hashes']
  return { assets, assetDirectory, dshHome, fakeBin, hashes, logPath, temporaryDirectory }
}

function runRemoteNpmBootstrap(
  installer: string,
  fixture: RemoteBootstrapFixture,
  args: readonly string[],
  options: {
    lifecycleDigests?: boolean
    hostDigests?: boolean
    foreignStatPath?: string
    rootStatPaths?: readonly string[]
    tamper?: keyof RemoteBootstrapFixture['assets']
    temporaryDirectory?: string
  } = {},
) {
  return spawnSync('/bin/bash', ['-s', '--', ...args], {
    cwd: dirname(fixture.dshHome),
    encoding: 'utf8',
    input: installer,
    env: {
      PATH: fixture.fakeBin + ':/usr/bin:/bin',
      HOME: fixture.dshHome,
      REMOTE_BOOTSTRAP_NODE: process.execPath,
      TMPDIR: options.temporaryDirectory ?? fixture.temporaryDirectory,
      DSH_HOME: fixture.dshHome,
      DSH_ENHANCED_INSTALL_REF: 'v9.8.7',
      DSH_ENHANCED_INSTALL_BASE_URL: 'https://assets.invalid/v9.8.7',
      DSH_ENHANCED_INSTALL_COMMON_SHA256: fixture.hashes['common.sh'],
      ...(options.lifecycleDigests ? {
        DSH_ENHANCED_INSTALL_LIFECYCLE_CONFIG_SHA256: fixture.hashes['lifecycle-config.mjs'],
        DSH_ENHANCED_INSTALL_LIFECYCLE_PROFILE_SHA256: fixture.hashes['lifecycle-profile.mjs'],
      } : {}),
      ...(options.hostDigests ? {
        DSH_ENHANCED_INSTALL_HOST_LIFECYCLE_SHA256: fixture.hashes['host-lifecycle.mjs'],
        DSH_ENHANCED_INSTALL_HOST_PROFILE_UPDATE_SHA256: fixture.hashes['host-profile-update.mjs'],
        DSH_ENHANCED_INSTALL_HOST_RSI_UPDATE_SHA256: fixture.hashes['host-rsi-update.mjs'],
        DSH_ENHANCED_HOST_UPDATE_PLAN: '/private/plan.json',
      } : {}),
      REMOTE_BOOTSTRAP_ASSETS: fixture.assetDirectory,
      REMOTE_BOOTSTRAP_FOREIGN_STAT_PATH: options.foreignStatPath ?? '',
      REMOTE_BOOTSTRAP_ROOT_STAT_PATHS: options.rootStatPaths?.join(':') ?? '',
      REMOTE_BOOTSTRAP_FOREIGN_UID: String((process.getuid?.() ?? 0) + 1),
      REMOTE_BOOTSTRAP_LOG: fixture.logPath,
      REMOTE_BOOTSTRAP_TAMPER: options.tamper ?? '',
    },
  })
}

test('reads a systemd log entry only after its second append commits the newline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-systemd-json-lines-'))
  const path = join(root, 'systemd.log')
  try {
    await writeFile(path, '["first"]\n["second"')
    const observedIncomplete = Promise.withResolvers<void>()
    const reading = readJsonLines(path, observedIncomplete.resolve)
    await observedIncomplete.promise
    await appendFile(path, ']\n')
    expect(await reading).toEqual([['first'], ['second']])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects a malformed newline-committed systemd log entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-systemd-json-lines-'))
  const path = join(root, 'systemd.log')
  try {
    await writeFile(path, '["first"]\n["bad"\n["pending"')
    await expect(readJsonLines(path)).rejects.toThrow(SyntaxError)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects a permanently unterminated systemd log entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-systemd-json-lines-'))
  const path = join(root, 'systemd.log')
  try {
    await writeFile(path, '["first"]\n["pending"')
    await expect(readJsonLines(path)).rejects.toThrow(`Incomplete JSON line in ${path}`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

const yamlOptions = {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
} as const

async function composeSelectedBundleRows(installerOutput: string): Promise<any[]> {
  const paths = [...new Set([...installerOutput.matchAll(new RegExp(`${repoRoot}/plugins/[a-z0-9-]+`, 'gu'))]
    .map(match => match[0]))]
  const rows: any[] = []
  for (const path of paths) {
    const patch = parse(await readFile(join(path, 'cordis.patch.yml'), 'utf8'), yamlOptions) as any[]
    for (const operation of patch) {
      if (Array.isArray(operation.insert)) rows.push(...operation.insert)
      else if (typeof operation.id === 'string') rows.push(operation)
    }
  }
  return rows
}

describe('one-click installers', () => {

  test('a copied lifecycle helper resolves YAML only through a pnpm-style canonical DSH package closure', async () => {
    const root = await temporaryDshHome()
    const home = join(root, 'home')
    const hostRoot = join(root, 'cli', 'node_modules')
    const dshPackage = join(hostRoot, '@deepseek-ai', 'dsh')
    const shim = join(hostRoot, '.bin', 'dsh')
    const copiedHelper = join(root, 'copied', 'lifecycle-config.mjs')
    const yamlManifest = createRequire(import.meta.url).resolve('yaml/package.json')
    await Promise.all([
      mkdir(join(home, 'inside'), { recursive: true }),
      mkdir(join(dshPackage, 'lib'), { recursive: true }),
      mkdir(join(dshPackage, 'node_modules'), { recursive: true }),
      mkdir(dirname(shim), { recursive: true }),
      mkdir(dirname(copiedHelper), { recursive: true }),
    ])
    await writeFile(join(dshPackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '0.1.5-rc.1', type: 'module', exports: './lib/bin.js', bin: { dsh: 'lib/bin.js' }, dependencies: { yaml: '^2.9.0' },
    }))
    await writeFile(join(dshPackage, 'lib', 'bin.js'), '')
    await cp(dirname(yamlManifest), join(dshPackage, 'node_modules', 'yaml'), { recursive: true })
    await writeExecutable(shim, '#!/bin/sh\nbasedir=$(dirname "$0")\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node" "$basedir/../@deepseek-ai/dsh/lib/bin.js" "$@"\nelse\n  exec node "$basedir/../@deepseek-ai/dsh/lib/bin.js" "$@"\nfi\n')
    const resolution = spawnSync(process.execPath, ['--input-type=module', '--eval', [
      "import { createRequire } from 'node:module'",
      'const [shim, manifest] = process.argv.slice(1)',
      'try { createRequire(shim).resolve("yaml"); process.exitCode = 1 } catch (error) { if (error?.code !== "MODULE_NOT_FOUND") throw error }',
      'process.stdout.write(createRequire(manifest).resolve("yaml"))',
    ].join(';'), shim, join(dshPackage, 'package.json')], { cwd: root, encoding: 'utf8', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } })
    expect(resolution.status, resolution.stderr).toBe(0)
    expect(resolution.stdout).toContain('/yaml/')
    await cp(join(installDirectory, 'lifecycle-config.mjs'), copiedHelper)
    const source = join(root, 'config.yml')
    const malformed = join(root, 'malformed.yml')
    const escaping = join(root, 'escaping.yml')
    const dynamicMarker = join(root, 'dynamic-marker.yml')
    const missingId = join(root, 'missing-id.yml')
    const nonStringId = join(root, 'non-string-id.yml')
    await writeFile(source, `- id: first-party\n  name: '@dsh-enhanced/assistant-web-owner'\n  config:\n    databasePath: ${join(home, 'inside', 'state.sqlite')}\n`)
    await writeFile(malformed, '- id: [broken\n')
    await writeFile(escaping, `- id: first-party\n  name: '@dsh-enhanced/assistant-web-owner'\n  config:\n    databasePath: ${join(root, 'outside.sqlite')}\n`)
    await writeFile(dynamicMarker, "- id: dsh-enhanced-assistant-web-owner\n  name: '@dsh-enhanced/assistant-web-owner'\n  disabled: !!js process.platform === 'win32'\n")
    await writeFile(missingId, `- name: '@untrusted/example'\n  config:\n    statePath: ${join(root, 'outside-missing-id.sqlite')}\n`)
    await writeFile(nonStringId, `- id: 3\n  name: '@untrusted/example'\n  config:\n    statePath: ${join(root, 'outside-non-string-id.sqlite')}\n`)
    const program = [
      "import { readFile } from 'node:fs/promises'",
      "import { pathToFileURL } from 'node:url'",
      'const [helper, source, home, executable] = process.argv.slice(1)',
      'const { classifyLifecycleScenario, validateLifecycleConfig } = await import(pathToFileURL(helper).href)',
      'await validateLifecycleConfig(await readFile(source, "utf8"), { dshHome: home, dshExecutable: executable })',
      'process.stdout.write(`${await classifyLifecycleScenario(await readFile(source, "utf8"), { dshExecutable: executable })}\\n`)',
    ].join(';')
    const run = (file: string, executable = shim) => spawnSync(process.execPath, ['--input-type=module', '--eval', program, copiedHelper, file, home, executable], {
      cwd: root, encoding: 'utf8', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    })

    const npmPackage = join(root, 'npm-host', 'node_modules', '@deepseek-ai', 'dsh')
    const npmBin = join(npmPackage, 'lib', 'bin.js')
    await mkdir(join(npmPackage, 'node_modules'), { recursive: true })
    await mkdir(dirname(npmBin), { recursive: true })
    await writeFile(join(npmPackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '0.1.2-rc.1', type: 'module', exports: './lib/bin.js', bin: { dsh: 'lib/bin.js' }, dependencies: { yaml: '^2.9.0' },
    }))
    await writeFile(npmBin, '')
    await cp(dirname(yamlManifest), join(npmPackage, 'node_modules', 'yaml'), { recursive: true })
    const npmCanonical = run(source, npmBin)
    expect(npmCanonical.status, npmCanonical.stderr).toBe(0)
    expect(npmCanonical.stdout).toBe('web\n')
    const accepted = run(source)
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(accepted.stdout).toBe('web\n')
    const escapedEntry = join(root, 'outside-entry.js')
    await writeFile(escapedEntry, '')
    await rm(join(dshPackage, 'lib', 'bin.js'))
    await symlink(escapedEntry, join(dshPackage, 'lib', 'bin.js'))
    const symlinkEscape = run(source)
    expect(symlinkEscape.status).not.toBe(0)
    expect(symlinkEscape.stderr).toContain('canonical DSH executable')
    await rm(join(dshPackage, 'lib', 'bin.js'))
    await writeFile(join(dshPackage, 'lib', 'bin.js'), '')
    const malformedResult = run(malformed)
    expect(malformedResult.status).not.toBe(0)
    expect(malformedResult.stderr).toContain('structurally valid YAML')
    const escapingResult = run(escaping)
    expect(escapingResult.status).not.toBe(0)
    expect(escapingResult.stderr).toContain('resolves outside canonical DSH_HOME')
    const dynamicMarkerResult = run(dynamicMarker)
    expect(dynamicMarkerResult.status).not.toBe(0)
    expect(dynamicMarkerResult.stderr).toContain('disabled field must be boolean')
    for (const file of [missingId, nonStringId]) {
      const result = run(file)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('must have string id fields')
    }
    const exactManifest = await readFile(join(dshPackage, 'package.json'), 'utf8')
    const withHostVersion = (version: string) => JSON.stringify({ ...JSON.parse(exactManifest), version })
    for (const version of ['0.1.5-rc.2', '0.1.2-rc.1', '0.1.2-rc.0a', '0.1.2-zeta.1']) {
      await writeFile(join(dshPackage, 'package.json'), withHostVersion(version))
      const acceptedVersion = run(source)
      expect(acceptedVersion.status, `${version}: ${acceptedVersion.stderr}`).toBe(0)
    }
    for (const version of ['0.1.2-rc', '0.1.2-rc.0', '0.1.2-rc.01', '0.2.0-rc.1', 'malformed']) {
      await writeFile(join(dshPackage, 'package.json'), withHostVersion(version))
      const rejectedVersion = run(source)
      expect(rejectedVersion.status, version).not.toBe(0)
      expect(rejectedVersion.stderr).toContain('canonical DSH executable')
    }
    await writeFile(join(dshPackage, 'package.json'), exactManifest)
    const forgedRoot = join(root, 'forged-host')
    const forgedShim = join(forgedRoot, 'cli', 'node_modules', '.bin', 'dsh')
    await mkdir(dirname(forgedShim), { recursive: true })
    await mkdir(join(forgedRoot, 'node_modules'), { recursive: true })
    await writeFile(join(forgedRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-rc.1', bin: { dsh: 'lib/bin.js' } }))
    await mkdir(join(forgedRoot, 'lib'), { recursive: true })
    await writeFile(join(forgedRoot, 'lib', 'bin.js'), '')
    await symlink(dirname(yamlManifest), join(forgedRoot, 'node_modules', 'yaml'))
    await writeExecutable(forgedShim, '#!/bin/sh\nexec node "$0" "$@"\n')
    const forgedAncestor = run(source, forgedShim)
    expect(forgedAncestor.status).not.toBe(0)
    expect(forgedAncestor.stderr).toContain('canonical DSH executable')
  })

  test('lifecycle transactions reject state paths outside the snapshotted DSH_HOME', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const fakeBin = join(root, 'bin')
    await mkdir(dshHome)
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
printf '%s\n' '- id: custom-state' "  name: '@dsh-enhanced/personal-assistant'" '  config:' '    databasePath: /srv/shared/state.sqlite'
`)

    const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_validate_lifecycle_state_paths web "$2"',
      'state-path-test', installerLibrary, dshHome], {
      cwd: repoRoot, encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects custom-state.databasePath: resolves outside canonical DSH_HOME')
  })

  test('lifecycle state-path validation fails closed for escaping dshHomePath expressions', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const fakeBin = join(root, 'bin')
    await mkdir(dshHome)
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
printf '%s\n' '- id: custom-state' "  name: '@dsh-enhanced/personal-assistant'" '  config:' "    databasePath: !!js dshHomePath('../shared/state.sqlite')"
`)

    const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_validate_lifecycle_state_paths web "$2"',
      'state-path-test', installerLibrary, dshHome], {
      cwd: repoRoot, encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects custom-state.databasePath: only a non-empty relative dshHomePath expression is allowed')
  })

  test('lifecycle state-path validation fails closed for default dshHomePath expressions', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const fakeBin = join(root, 'bin')
    await mkdir(dshHome)
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
printf '%s\n' '- id: custom-state' "  name: '@dsh-enhanced/personal-assistant'" '  config:' '    databasePath: !!js dshHomePath()'
`)

    const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_validate_lifecycle_state_paths web "$2"',
      'state-path-test', installerLibrary, dshHome], {
      cwd: repoRoot, encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects custom-state.databasePath: only a non-empty relative dshHomePath expression is allowed')
  })

  test('keeps the shared installer compatible with macOS Bash 3.2 empty-array semantics', async () => {
    const source = await readFile(installerLibrary, 'utf8')

    expect(source).not.toMatch(/\b(?:mapfile|readarray)\b/u)
    expect(source).not.toMatch(/\|\s+(?:LC_ALL=C\s+)?sort -V/u)
    expect(source).toContain('if [[ -n "${selected_slugs[0]+set}" ]]')
    expect(source).toContain('if [[ -n "${add_ons[0]+set}" ]]')
    expect(source).toContain('${overlay_args[@]+"${overlay_args[@]}"}')
  })

  test.skipIf(pinnedRemoteCommon === undefined || pinnedRemoteCommon.status !== 0)('remote bootstrap hash matches its pinned release asset when that tag is available locally', async () => {
    // A shallow checkout may not contain release tags.  The test deliberately
    // skips there instead of using the network; release-version fixture tests
    // separately cover future pin rewriting.
    const pinnedHash = pinnedInstallerSource.match(/^DSH_ENHANCED_PINNED_COMMON_SHA256='([0-9a-f]{64})'$/mu)?.[1]

    expect(pinnedHash).toBe(createHash('sha256').update(pinnedRemoteCommon!.stdout).digest('hex'))
  })

  test('remote lifecycle helper pins are both zero sentinels or both release hashes', () => {
    expect(pinnedLifecycleConfigHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(pinnedLifecycleProfileHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(pinnedLifecycleConfigHash === zeroSha256).toBe(pinnedLifecycleProfileHash === zeroSha256)
  })

  test.skipIf(
    pinnedLifecycleConfigHash === undefined
      || pinnedLifecycleProfileHash === undefined
      || pinnedLifecycleConfigHash === zeroSha256
      || pinnedLifecycleProfileHash === zeroSha256
      || pinnedRemoteLifecycleConfig === undefined
      || pinnedRemoteLifecycleConfig.status !== 0
      || pinnedRemoteLifecycleProfile === undefined
      || pinnedRemoteLifecycleProfile.status !== 0,
  )('remote lifecycle helper hashes match their pinned release assets when that tag is available locally', () => {
    expect(pinnedLifecycleConfigHash).toBe(
      createHash('sha256').update(pinnedRemoteLifecycleConfig!.stdout).digest('hex'),
    )
    expect(pinnedLifecycleProfileHash).toBe(
      createHash('sha256').update(pinnedRemoteLifecycleProfile!.stdout).digest('hex'),
    )
  })

  test('remote npm install with lifecycle zero sentinels downloads, verifies, and sources only common.sh', async () => {
    const fixture = await remoteBootstrapFixture()
    const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)

    const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'])

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(fixture.logPath, 'utf8')).toBe([
      'download\thttps://assets.invalid/v9.8.7/common.sh',
      'verify\tcommon.sh',
      'source:common',
      'run\tnpm\t\t--dry-run',
      '',
    ].join('\n'))
    expect(await readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8')).toBe('mutated\n')
    expect(await readdir(fixture.temporaryDirectory)).toEqual([])
  })

  test('remote npm bootstrap rejects an unsafe custom TMPDIR before download or source', async () => {
    const fixture = await remoteBootstrapFixture()
    await chmod(fixture.temporaryDirectory, 0o777)
    const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)

    const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/TMPDIR|temporary|临时/iu)
    await expect(stat(fixture.logPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(fixture.dshHome, 'bootstrap-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(fixture.temporaryDirectory)).toEqual([])
  })

  test('remote npm bootstrap rejects a private TMPDIR beneath a foreign-owned ancestor before download or source',
    async () => {
      const fixture = await remoteBootstrapFixture()
      const foreignAncestor = join(fixture.temporaryDirectory, 'foreign-ancestor')
      const privateTmp = join(foreignAncestor, 'private-tmp')
      await mkdir(foreignAncestor, { mode: 0o755 })
      await mkdir(privateTmp, { mode: 0o700 })
      const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)

      const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'], {
        foreignStatPath: foreignAncestor,
        temporaryDirectory: privateTmp,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/TMPDIR|临时目录祖先所有者不受信任/iu)
      await expect(stat(fixture.logPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(fixture.dshHome, 'bootstrap-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(privateTmp)).toEqual([])
    },
  )

  test.each([
    { label: 'a private custom TMPDIR', build: async () => ({}), cleanup: (fixture: Awaited<ReturnType<typeof remoteBootstrapFixture>>) => fixture.temporaryDirectory },
    { label: 'the macOS default TMPDIR beneath a root-owned /var alias',
      build: async (fixture: Awaited<ReturnType<typeof remoteBootstrapFixture>>) => {
        const root = dirname(fixture.dshHome)
        const privateVar = join(root, 'private', 'var')
        const macTmp = join(privateVar, 'folders', 'd5', 'T')
        await mkdir(macTmp, { mode: 0o700, recursive: true })
        await symlink('private/var', join(root, 'var'))
        return { rootStatPaths: [join(root, 'var')], temporaryDirectory: join(root, 'var', 'folders', 'd5', 'T') }
      },
      cleanup: async (fixture: Awaited<ReturnType<typeof remoteBootstrapFixture>>) => {
        const root = dirname(fixture.dshHome)
        return join(root, 'private', 'var', 'folders', 'd5', 'T')
      } },
    { label: 'a TMPDIR containing spaces and glob metacharacters',
      build: async (fixture: Awaited<ReturnType<typeof remoteBootstrapFixture>>) => {
        const root = dirname(fixture.dshHome)
        const specialTmp = join(root, 'tmp two', 'star*dir', 'T')
        await mkdir(specialTmp, { mode: 0o700, recursive: true })
        return { temporaryDirectory: specialTmp }
      },
      cleanup: async (fixture: Awaited<ReturnType<typeof remoteBootstrapFixture>>) =>
        join(dirname(fixture.dshHome), 'tmp two', 'star*dir', 'T') },
  ] as const)('remote npm bootstrap accepts $label', async ({ build, cleanup }) => {
    const fixture = await remoteBootstrapFixture()
    const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)

    const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'], await build(fixture))

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(fixture.logPath, 'utf8')).toContain('source:common\n')
    expect(await readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8')).toBe('mutated\n')
    expect(await readdir(await cleanup(fixture))).toEqual([])
  })

  test('remote npm bootstrap rejects TMPDIR through a non-root-owned directory symlink', async () => {
    const fixture = await remoteBootstrapFixture()
    const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)
    const root = dirname(fixture.dshHome)
    const privateVar = join(root, 'private', 'var')
    const userTmp = join(privateVar, 'folders', 'd5', 'T')
    await mkdir(userTmp, { mode: 0o700, recursive: true })
    await symlink('private/var', join(root, 'var'))

    const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'], {
      foreignStatPath: join(root, 'var'),
      temporaryDirectory: join(root, 'var', 'folders', 'd5', 'T'),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('非 root 拥有的符号链接')
    await expect(stat(fixture.logPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(fixture.dshHome, 'bootstrap-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(userTmp)).toEqual([])
  })

  test('remote npm bootstrap rejects a non-root symlink nested inside a root-owned alias target', async () => {
    const fixture = await remoteBootstrapFixture()
    const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)
    const root = dirname(fixture.dshHome)
    const realTmp = join(root, 'real', 'T')
    const innerLink = join(root, 'layer', 'inner')
    await mkdir(realTmp, { mode: 0o700, recursive: true })
    await mkdir(dirname(innerLink), { mode: 0o755, recursive: true })
    await symlink(realTmp, innerLink)
    await symlink(join(root, 'layer'), join(root, 'alias'))

    const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'], {
      rootStatPaths: [join(root, 'alias')],
      foreignStatPath: innerLink,
      temporaryDirectory: join(root, 'alias', 'inner'),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('非 root 拥有的符号链接')
    expect(result.stderr).toContain(innerLink)
    await expect(stat(fixture.logPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(fixture.dshHome, 'bootstrap-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('remote npm bootstrap rejects a non-root symlink reached via a root link target containing ".."', async () => {
    // Root-owned link target `zz/evil/../real` still traverses the non-root
    // `evil` component when re-resolved; the lexical ".." must not erase it.
    const fixture = await remoteBootstrapFixture()
    const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)
    const root = dirname(fixture.dshHome)
    const evilLink = join(root, 'zz', 'evil')
    await mkdir(join(root, 'zz', 'real'), { mode: 0o700, recursive: true })
    await symlink('real', evilLink)
    await symlink('zz/evil/../real', join(root, 'passthrough'))

    const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'], {
      rootStatPaths: [join(root, 'passthrough')],
      foreignStatPath: evilLink,
      temporaryDirectory: join(root, 'passthrough'),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('非 root 拥有的符号链接')
    expect(result.stderr).toContain(evilLink)
    await expect(stat(fixture.logPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(fixture.dshHome, 'bootstrap-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('remote npm bootstrap rejects a non-root symlink after descending through a root link to the root directory',
    async () => {
      const fixture = await remoteBootstrapFixture()
      const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)
      const root = dirname(fixture.dshHome)
      const evilLink = join(root, 'under', 'evil')
      await mkdir(join(root, 'under', 'realdir'), { mode: 0o700, recursive: true })
      await symlink('realdir', evilLink)
      // Absolute target restarts resolution at the filesystem root.
      await symlink(root, join(root, 'slash'))

      const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'], {
        rootStatPaths: [join(root, 'slash')],
        foreignStatPath: evilLink,
        temporaryDirectory: join(root, 'slash', 'under', 'evil'),
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('非 root 拥有的符号链接')
      expect(result.stderr).toContain(evilLink)
      await expect(stat(fixture.logPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(fixture.dshHome, 'bootstrap-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  test.each([
    ['self-referencing', (root: string) => {
      const link = join(root, 'loopA')
      return { links: [link], make: async () => symlink('loopA', link), tmpdir: link }
    }],
    ['mutually-referencing', (root: string) => {
      const linkA = join(root, 'loopA')
      const linkB = join(root, 'loopB')
      return {
        links: [linkA, linkB],
        make: async () => { await symlink('loopB', linkA); await symlink('loopA', linkB) },
        tmpdir: linkA,
      }
    }],
  ] as const)(
    'remote npm bootstrap rejects a root-owned %s symlink cycle without looping',
    async (_label, build) => {
      const fixture = await remoteBootstrapFixture()
      const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)
      const root = dirname(fixture.dshHome)
      const spec = build(root)
      await spec.make()

      const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'], {
        rootStatPaths: spec.links,
        temporaryDirectory: spec.tmpdir,
      })

      expect(result.status).not.toBe(0)
      // A cycle is fail-closed either at the upfront canonical `cd -P`
      // ("不存在或不可访问") or, for a chain that resolves far enough, at the
      // hop-count / readlink guard inside the alias validator. Either way it
      // must return promptly without downloading or sourcing anything.
      expect(result.stderr).toMatch(/TMPDIR (不存在或不可访问|符号链接)/)
      await expect(stat(fixture.logPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(fixture.dshHome, 'bootstrap-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  test.each(['upgrade', 'uninstall'] as const)(
    'remote npm %s with lifecycle zero sentinels fails before downloads or source',
    async operation => {
      const fixture = await remoteBootstrapFixture()
      const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)

      const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, [
        '--operation', operation, '--confirm-dsh-home-stopped', '--scenario', 'web', '--dry-run',
      ])

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('固定发布未包含已校验的 lifecycle helper')
      await expect(readFile(fixture.logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(fixture.temporaryDirectory)).toEqual([])
    },
  )

  test.each(['upgrade', 'uninstall'] as const)(
    'remote npm %s lifecycle bootstrap downloads one release cohort and verifies every asset before source',
    async operation => {
      const fixture = await remoteBootstrapFixture()

      const result = runRemoteNpmBootstrap(pinnedInstallerSource, fixture, [
        '--operation', operation, '--confirm-dsh-home-stopped', '--scenario', 'web', '--dry-run',
      ], { lifecycleDigests: true })

      expect(result.status, result.stderr).toBe(0)
      expect(await readFile(fixture.logPath, 'utf8')).toBe([
        'download\thttps://assets.invalid/v9.8.7/common.sh',
        'verify\tcommon.sh',
        'download\thttps://assets.invalid/v9.8.7/lifecycle-config.mjs',
        'download\thttps://assets.invalid/v9.8.7/lifecycle-profile.mjs',
        'verify\tlifecycle-config.mjs',
        'verify\tlifecycle-profile.mjs',
        'source:common',
        `run\tnpm\t\t--operation\t${operation}\t--confirm-dsh-home-stopped\t--scenario\tweb\t--dry-run`,
        '',
      ].join('\n'))
      expect(await readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8')).toBe('mutated\n')
      expect(await readdir(fixture.temporaryDirectory)).toEqual([])
    },
  )

  test.each(['common.sh', 'lifecycle-config.mjs', 'lifecycle-profile.mjs'] as const)(
    'remote npm lifecycle bootstrap rejects tampered %s before source or home mutation',
    async tamperedAsset => {
      const fixture = await remoteBootstrapFixture()

      const result = runRemoteNpmBootstrap(pinnedInstallerSource, fixture, [
        '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--scenario', 'web', '--dry-run',
      ], { lifecycleDigests: true, tamper: tamperedAsset })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('远程 ' + tamperedAsset + ' 完整性校验失败')
      const log = await readFile(fixture.logPath, 'utf8')
      expect(log).not.toContain('source:common')
      expect(log).not.toContain('\nrun\t')
      await expect(readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(fixture.temporaryDirectory)).toEqual([])
    },
  )

  test('remote Host update bootstrap verifies all helper assets before sourcing common', async () => {
    const fixture = await remoteBootstrapFixture()
    const result = runRemoteNpmBootstrap(pinnedInstallerSource, fixture, [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--scenario', 'web',
    ], { lifecycleDigests: true, hostDigests: true })
    expect(result.status, result.stderr).toBe(0)
    const log = await readFile(fixture.logPath, 'utf8')
    for (const asset of ['host-lifecycle.mjs', 'host-profile-update.mjs', 'host-rsi-update.mjs']) {
      expect(log).toContain(`download\thttps://assets.invalid/v9.8.7/${asset}\n`)
      expect(log).toContain(`verify\t${asset}\n`)
    }
    expect(log.indexOf('verify\thost-rsi-update.mjs')).toBeLessThan(log.indexOf('source:common'))
  })

  test.each(['host-lifecycle.mjs', 'host-profile-update.mjs', 'host-rsi-update.mjs'] as const)(
    'remote Host update bootstrap rejects tampered %s before source', async tamperedAsset => {
      const fixture = await remoteBootstrapFixture()
      const result = runRemoteNpmBootstrap(pinnedInstallerSource, fixture, [
        '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--scenario', 'web',
      ], { lifecycleDigests: true, hostDigests: true, tamper: tamperedAsset })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`远程 ${tamperedAsset} 完整性校验失败`)
      expect(await readFile(fixture.logPath, 'utf8')).not.toContain('source:common')
      await expect(readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  test('collects an interactive model route before its npm cohort is preflighted', async () => {
    const source = await readFile(installerLibrary, 'utf8')
    const routeSelection = source.indexOf('dsh_enhanced_prompt_model_route model_provider model_name model_base_url model_api model_display_name')
    const cohortPreflight = source.indexOf('dsh_enhanced_resolve_npm_cohort "$plugin_version" "$dry_run"')

    expect(routeSelection).toBeGreaterThan(-1)
    expect(cohortPreflight).toBeGreaterThan(routeSelection)
  })

  test('explicit core installs capability discovery without optional bundles', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, ['--dry-run', '--scenario', 'core', '--lark', 'skip'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('目标 profile：web')
    expect(result.stdout).toContain('部署场景：core')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'personal-assistant'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'plugin-control-plane'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'lark-channel'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-policy'))
    expect(result.stdout).not.toContain('部署模式：')
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'acp'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'hello'))
    expect(result.stdout).toContain('Agent 工具授权：preserve')
    expect(result.stdout).toContain('权限默认值：保留现有 Settings')
    expect(result.stdout).toContain('立即使用：dsh --profile web')
    expect(result.stdout).not.toContain('dsh-lark-setup')
  })

  test.skipIf(process.platform !== 'linux').each([localInstaller, npmInstaller])('Linux auto selects bounded ordinary-use learning for %s', async installer => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(installer, ['--dry-run', '--yes'], dshHome, 'Linux')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：supervised')
    expect(result.stdout).toContain('部署模式：supervised-growth')
    expect(result.stdout).toContain('安装成功后，后续任务会产生有限额外模型消耗')
    expect(result.stdout).toContain('dsh-lark-setup --profile web')
    expect(result.stdout).toContain('dsh-rsi-setup --install-owner --profile web')
    expect(result.stdout).not.toContain('--ack-existing-automations')
  })

  test.each([
    { args: ['--lark', 'skip'], scenario: 'core' },
    { args: ['--no-service'], scenario: 'core' },
    { args: ['--mode', 'standard'], scenario: 'core' },
    { args: ['--scenario', 'lark'], scenario: 'lark' },
    { args: ['--scenario', 'full'], scenario: 'full' },
  ])('Linux auto retains explicit limited choice $args', async ({ args, scenario }) => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, ['--dry-run', '--yes', ...args], dshHome, 'Linux')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`部署场景：${scenario}`)
    expect(result.stdout).toContain('普通使用自迭代：本次不启用完整 RSI')
    expect(result.stdout).not.toContain('dsh-rsi-setup --install-owner')
  })

  test.each([['--lark', 'skip'], ['--no-service']])('Linux existing Lark respects limited opt-out %s', async (...args) => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)
    const result = runInstaller(localInstaller, ['--dry-run', '--yes', ...args], dshHome, 'Linux')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：lark')
    expect(result.stdout).toContain('普通使用自迭代：本次不启用完整 RSI')
    expect(result.stdout).not.toContain('dsh-rsi-setup --install-owner')
  })

  test.skipIf(process.platform !== 'linux')('Linux fresh noninteractive install fails before mutation when owner pairing is unavailable', async () => {
    const dshHome = await temporaryDshHome()
    const fakeBin = join(dshHome, 'bin')
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), '#!/bin/bash\nprintf "0.2.1-rc.2\\n"\n')
    const result = runInstaller(localInstaller, ['--yes'], dshHome, 'Linux', {
      PATH: `${fakeBin}:${pathWithoutTraex}`,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('需要交互式飞书 onboarding')
    expect(result.stdout).not.toContain('准备并构建当前仓库')
    expect(result.stdout).not.toContain('安装流程完成')
  })

  async function macUpgradeProcessView(fixtureHome: string, fixtureRoot: string, visiblePid?: number) {
    const canonicalHome = await realpath(fixtureHome)
    const preload = join(fixtureRoot, 'mac-upgrade-process-view.cjs')
    const marker = join(fixtureRoot, 'mac-upgrade-ps-observed')
    await writeFile(preload, String.raw`const child = require('node:child_process')
const fs = require('node:fs')
const original = child.spawnSync
child.spawnSync = (command, args, options) => {
  const result = original(command, args, options)
  if (process.argv[1] !== '-' || process.argv[2] !== ${JSON.stringify(canonicalHome)}
    || command !== '/bin/ps' || args?.length !== 2 || args[0] !== '-axo'
    || args[1] !== 'pid=,command=') return result
  fs.appendFileSync(${JSON.stringify(marker)}, 'ps\n')
  if (result.status !== 0 || result.error || result.signal || typeof result.stdout !== 'string') return result
  const visiblePid = ${JSON.stringify(visiblePid ?? null)}
  const lines = result.stdout.match(/[^\n]*\n|[^\n]+$/gu) ?? []
  let parsed = 0
  let removed = 0
  const stdout = lines.filter(line => {
    if (line.trim() === '') return true
    const match = /^\s*(\d+)\s+.+$/u.exec(line.endsWith('\n') ? line.slice(0, -1) : line)
    if (!match) return true
    parsed += 1
    if (visiblePid !== null && Number(match[1]) === visiblePid) return true
    removed += 1
    return false
  }).join('')
  fs.appendFileSync(${JSON.stringify(marker)}, 'parsed=' + parsed + ' removed=' + removed + '\n')
  return { ...result, stdout }
}
require('node:module').syncBuiltinESMExports()
`)
    return { environment: { NODE_OPTIONS: `--require=${preload}` }, marker }
  }

  test.each(['local', 'npm'] as const)(
    'macOS %s supervised upgrade auto-detects the scenario and repairs a legacy Recovery closure',
    async source => {
      const f = await lifecycleFixture({
        effectiveScenario: 'supervised',
        managedDependencies: ['personal-assistant', 'assistant-recovery'],
        systemd: {},
      })
      const script = source === 'local'
        ? join(f.fixtureInstallDirectory, 'install-local.sh')
        : join(f.fixtureInstallDirectory, 'install-npm.sh')
      const args = ['--operation', 'upgrade', '--confirm-dsh-home-stopped', '--dry-run']
      if (source === 'npm') args.push('--plugin-version', '1.4.0')
      const processView = await macUpgradeProcessView(f.dshHome, f.root)
      const result = runInstaller(
        script, args, f.dshHome, 'Darwin', {
          ...lifecycleEnvironment(f.dshHome, f.fakeBin), ...processView.environment,
        },
      )

      expect(await readFile(processView.marker, 'utf8')).toMatch(/parsed=[1-9]\d* removed=[1-9]\d*/u)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('自动识别为 supervised')
      expect(result.stdout).toContain('assistant-recovery 但缺少 assistant-goals')
      expect(result.stdout).toContain(source === 'npm'
        ? '@dsh-enhanced/assistant-goals@1.4.0'
        : join(repoRoot, 'plugins', 'assistant-goals'))
      expect(result.stdout).toContain('macOS 已停止 Home 升级')
      if (source === 'npm') {
        expect(result.stdout).toContain('profile 依赖构建策略')
      } else {
        expect(result.stdout).not.toContain('profile 依赖构建策略')
      }
      expect(result.stdout).not.toMatch(/systemctl|journalctl/iu)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
    },
  )


  test.each(['local', 'npm'] as const)('macOS %s rejects a Host update plan before changing the profile', async source => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised',
      managedDependencies: ['personal-assistant', 'assistant-recovery'],
      systemd: {},
    })
    const before = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const processView = await macUpgradeProcessView(f.dshHome, f.root)
    const result = runInstaller(join(f.fixtureInstallDirectory, `install-${source}.sh`), [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--yes',
    ], f.dshHome, 'Darwin', {
      ...lifecycleEnvironment(f.dshHome, f.fakeBin),
      ...processView.environment,
      DSH_ENHANCED_HOST_UPDATE_PLAN: join(f.dshHome, 'host-plan.json'),
    })
    expect(await readFile(processView.marker, 'utf8')).toMatch(/parsed=[1-9]\d* removed=[1-9]\d*/u)
    expect(result.status, result.stderr).toBe(2)
    expect(result.stderr).toContain('macOS 尚不支持受管 Host 跨版本更新')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(before)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    expect(await readFile(f.systemdLog, 'utf8')).toBe('')
    expect((await readdir(join(f.dshHome, 'profiles'))).some(name => name.includes('upgrade-backup'))).toBe(false)
  })

  test.each(['local', 'npm'] as const)(
    'macOS %s refuses a frozen native Home before workspace or package work', async source => {
      const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: {} })
      const before = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
      await mkdir(join(f.dshHome, 'rsi-local-cohorts', 'web'), { recursive: true })
      const result = runInstaller(join(f.fixtureInstallDirectory, `install-${source}.sh`), [
        '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--yes',
      ], f.dshHome, 'Darwin', lifecycleEnvironment(f.dshHome, f.fakeBin))
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/rsi-local-cohorts|冻结的 owner\/source/iu)
      expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(before)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
      await expect(stat(join(f.dshHome, 'assistant-workspace'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(join(f.dshHome, 'profiles'))).some(name => name.includes('upgrade-backup'))).toBe(false)
    },
  )

  test('macOS refuses a native owner authority even without a cohort receipt', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: {} })
    await mkdir(join(f.dshHome, 'rsi-authorities', 'web'), { recursive: true })
    const result = runInstaller(join(f.fixtureInstallDirectory, 'install-local.sh'), [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--yes',
    ], f.dshHome, 'Darwin', lifecycleEnvironment(f.dshHome, f.fakeBin))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('rsi-authorities')
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
  })

  test('macOS refuses a partial native runtime marker and a symlink profile', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: {} })
    const argv = ['--operation', 'upgrade', '--confirm-dsh-home-stopped', '--yes']
    await mkdir(join(f.dshHome, 'rsi-native-runtimes'), { recursive: true })
    const marker = runInstaller(join(f.fixtureInstallDirectory, 'install-local.sh'), argv,
      f.dshHome, 'Darwin', lifecycleEnvironment(f.dshHome, f.fakeBin))
    expect(marker.status).not.toBe(0)
    expect(marker.stderr).toContain('rsi-native-runtimes')
    await rm(join(f.dshHome, 'rsi-native-runtimes'), { recursive: true })
    await symlink(f.profileDirectory, join(f.dshHome, 'profiles', 'other'))
    const alias = runInstaller(join(f.fixtureInstallDirectory, 'install-local.sh'), argv,
      f.dshHome, 'Darwin', lifecycleEnvironment(f.dshHome, f.fakeBin))
    expect(alias.status).not.toBe(0)
    expect(alias.stderr).toContain('profile entry other has unknown identity')
    await rm(join(f.dshHome, 'profiles', 'other'))
    await rm(join(f.dshHome, 'profiles', 'node_modules'), { recursive: true, force: true })
    await symlink(f.profileDirectory, join(f.dshHome, 'profiles', 'node_modules'))
    const fallbackAlias = runInstaller(join(f.fixtureInstallDirectory, 'install-local.sh'), argv,
      f.dshHome, 'Darwin', lifecycleEnvironment(f.dshHome, f.fakeBin))
    expect(fallbackAlias.status).not.toBe(0)
    expect(fallbackAlias.stderr).toContain('profiles/node_modules identity is unknown')
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
  })

  test.skipIf(process.platform !== 'darwin')('macOS launchd Home alias resolves to the same running Home', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: {} })
    const alias = join(f.root, 'home-alias')
    await symlink(f.dshHome, alias)
    const preload = join(f.root, 'launchctl-alias-fixture.cjs')
    await writeFile(preload, `const child = require('node:child_process')
const original = child.spawnSync
child.spawnSync = (command, args, options) => command === '/bin/launchctl'
  ? args[1].endsWith('.web')
    ? { status: 0, signal: null, error: undefined, stdout: 'gui/501/ai.deepseek.dsh.profile.web = {\\nDSH_HOME => ${alias}\\nstate = running\\npid = 4321\\n}', stderr: '' }
    : { status: 113, signal: null, error: undefined, stdout: '', stderr: 'Could not find service' }
  : original(command, args, options)
require('node:module').syncBuiltinESMExports()
`)
    const result = runInstaller(join(f.fixtureInstallDirectory, 'install-local.sh'), [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--yes',
    ], f.dshHome, 'Darwin', {
      ...lifecycleEnvironment(f.dshHome, f.fakeBin), NODE_OPTIONS: `--require=${preload}`,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('launchd web is still running')
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
  })

  test.each(['web', 'orphan'])('macOS refuses a running Host for %s even when stopped-Home confirmation is supplied', async profile => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: {} })
    const hostScript = join(f.root, 'other-home', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await mkdir(dirname(hostScript), { recursive: true })
    await writeFile(hostScript, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)\n")
    const host = spawn(process.execPath, [hostScript, `--profile=${profile}`, '--no-open'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('host readiness timeout')), 3000)
        host.stdout.once('data', () => { clearTimeout(timer); resolveReady() })
        host.once('error', error => { clearTimeout(timer); rejectReady(error) })
        host.once('close', () => { clearTimeout(timer); rejectReady(new Error('host exited before ready')) })
      })
      const hostPid = host.pid
      expect(hostPid).toBeDefined()
      const running = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      expect(running.status, running.stderr).toBe(0)
      const hostLine = running.stdout.split('\n').find(line => new RegExp(`^\\s*${hostPid}\\s+`, 'u').test(line))
      expect(hostLine).toContain(hostScript)
      expect(hostLine).toContain(`--profile=${profile}`)
      const processView = await macUpgradeProcessView(f.dshHome, f.root, hostPid)
      const result = runInstaller(join(f.fixtureInstallDirectory, 'install-local.sh'), [
        '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--yes',
      ], f.dshHome, 'Darwin', {
        ...lifecycleEnvironment(f.dshHome, f.fakeBin), ...processView.environment,
      })
      expect(await readFile(processView.marker, 'utf8')).toMatch(/parsed=[1-9]\d* removed=[1-9]\d*/u)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`Host PID ${hostPid} for profile ${profile} is still running`)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
      await expect(stat(join(f.dshHome, 'assistant-workspace'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (host.exitCode === null && host.signalCode === null) {
        await new Promise<void>((resolveClose, rejectClose) => {
          const force = setTimeout(() => host.kill('SIGKILL'), 1000)
          const timeout = setTimeout(() => rejectClose(new Error('host did not close after SIGKILL')), 3000)
          host.once('close', () => { clearTimeout(force); clearTimeout(timeout); resolveClose() })
          host.kill('SIGTERM')
        })
      }
    }
  })

  test('macOS local supervised upgrade activates successfully and removes its temporary backup', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised',
      managedDependencies: ['personal-assistant', 'assistant-recovery'],
      systemd: {},
    })
    const processView = await macUpgradeProcessView(f.dshHome, f.root)
    const result = runInstaller(join(f.fixtureInstallDirectory, 'install-local.sh'), [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--yes',
    ], f.dshHome, 'Darwin', {
      ...lifecycleEnvironment(f.dshHome, f.fakeBin), ...processView.environment,
    })

    expect(await readFile(processView.marker, 'utf8')).toMatch(/parsed=[1-9]\d* removed=[1-9]\d*/u)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('macOS profile 原地升级通过')
    expect(result.stdout).toContain('assistant-recovery 但缺少 assistant-goals')
    expect(await readFile(f.dshLog, 'utf8')).toContain(join(repoRoot, 'plugins', 'assistant-goals'))
    expect((await readdir(join(f.dshHome, 'profiles'))).some(name => name.includes('upgrade-backup'))).toBe(false)
  })

  test('macOS local supervised upgrade restores the original profile after activation failure', async () => {
    const f = await lifecycleFixture({
      activationFails: true,
      effectiveScenario: 'supervised',
      managedDependencies: ['personal-assistant', 'assistant-recovery'],
      systemd: {},
    })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const processView = await macUpgradeProcessView(f.dshHome, f.root)
    const result = runInstaller(join(f.fixtureInstallDirectory, 'install-local.sh'), [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--yes',
    ], f.dshHome, 'Darwin', {
      ...lifecycleEnvironment(f.dshHome, f.fakeBin), ...processView.environment,
    })

    expect(await readFile(processView.marker, 'utf8')).toMatch(/parsed=[1-9]\d* removed=[1-9]\d*/u)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('原 profile 已恢复')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    const profileEntries = await readdir(join(f.dshHome, 'profiles'))
    expect(profileEntries.some(name => name.startsWith('web.failed-upgrade.'))).toBe(true)
    expect(profileEntries.some(name => name.includes('upgrade-backup'))).toBe(false)
  })

  test('macOS npm supervised upgrade converges the build policy before the bare add', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised',
      managedDependencies: ['personal-assistant', 'assistant-recovery'],
      systemd: {},
    })
    // The default fixture workspace is the pnpm 10 era shape (no allowBuilds);
    // pnpm 11 exits nonzero on the undecided koffi script during this bare add.
    const workspaceBefore = await readFile(join(f.profileDirectory, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspaceBefore).not.toContain('allowBuilds')
    const processView = await macUpgradeProcessView(f.dshHome, f.root)
    const result = runInstaller(join(f.fixtureInstallDirectory, 'install-npm.sh'), [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--yes',
    ], f.dshHome, 'Darwin', {
      ...lifecycleEnvironment(f.dshHome, f.fakeBin), ...processView.environment,
    })

    expect(await readFile(processView.marker, 'utf8')).toMatch(/parsed=[1-9]\d* removed=[1-9]\d*/u)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('macOS profile 原地升级通过')
    const converged = parse(await readFile(join(f.profileDirectory, 'pnpm-workspace.yaml'), 'utf8'))
    expect(converged).toMatchObject({ allowBuilds: { koffi: true, protobufjs: false } })
    expect(await readFile(f.dshLog, 'utf8')).toContain('plugin\t--profile\tweb\tadd')
    expect((await readdir(join(f.dshHome, 'profiles'))).some(name => name.includes('upgrade-backup'))).toBe(false)
  })

  test('macOS npm supervised upgrade restores the profile when build policy preparation fails', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised',
      managedDependencies: ['personal-assistant', 'assistant-recovery'],
      systemd: {},
    })
    await writeFile(join(f.profileDirectory, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nallowBuilds:\n  koffi: true\n  protobufjs: false\n  some-native: set this to true or false\n')
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const processView = await macUpgradeProcessView(f.dshHome, f.root)
    const result = runInstaller(join(f.fixtureInstallDirectory, 'install-npm.sh'), [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--yes',
    ], f.dshHome, 'Darwin', {
      ...lifecycleEnvironment(f.dshHome, f.fakeBin), ...processView.environment,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('原 profile 已恢复')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    // The unreviewed placeholder is restored byte-for-byte and the add never ran.
    expect(await readFile(join(f.profileDirectory, 'pnpm-workspace.yaml'), 'utf8')).toContain('some-native: set this to true or false')
    expect(await readFile(f.dshLog, 'utf8')).not.toContain('plugin\t--profile\tweb\tadd')
  })

  test('macOS auto selects native ordinary-use learning', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, ['--dry-run', '--yes'], dshHome, 'Darwin')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：supervised')
    expect(result.stdout).toContain('部署模式：supervised-growth')
    expect(result.stdout).toContain('dsh-rsi-setup --install-owner')
  })

  test.each(['Linux', 'Darwin'])('%s interactive scenario menu defaults to supervised and offers limited opt-outs', platform => {
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_scenario 0 "$2"', 'installer-test', installerLibrary, platform,
    ], { encoding: 'utf8', input: '\n' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('supervised')
    expect(result.stderr).toContain('额外消耗有限模型额度')
    expect(result.stderr).toContain('3) 仅本机核心')
  })

  test('standard Lark installs automatic preference learning without the supervised operations stack', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--scenario', 'lark', '--lark', 'skip', '--agent-tools', 'disable',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：lark')
    expect(result.stdout).toContain('Agent 工具授权：disable')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'preference-learning'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')} `
      + '--profile web --refresh-agent-policy --disable-agent-tools',
    )
    expect(result.stdout).not.toContain('--install-service')
  })

  test('repairs the legacy Evolution-to-Evaluation bundle closure without expanding Lark into supervised', async () => {
    const dshHome = await temporaryDshHome()
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      dependencies: { '@dsh-enhanced/assistant-evolution': '0.1.7' },
      dsh: { profile: { bundles: ['@dsh-enhanced/assistant-evolution'] } },
    }, null, 2), 'utf8')

    const result = runInstaller(localInstaller, [
      '--dry-run', '--scenario', 'lark', '--lark', 'skip',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('旧 profile 含 assistant-evolution 但缺少 assistant-evaluation')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
  })

  test('explicit standard is byte-for-byte the default dry-run and does not mount Evolution', async () => {
    const implicitHome = await temporaryDshHome()
    const explicitHome = await temporaryDshHome()

    const implicit = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], implicitHome)
    const explicit = runInstaller(localInstaller, ['--dry-run', '--mode', 'standard', '--lark', 'skip'], explicitHome)

    expect(implicit.status, implicit.stderr).toBe(0)
    expect(explicit.status, explicit.stderr).toBe(0)
    expect(explicit.stdout.replaceAll(explicitHome, '<DSH_HOME>')).toBe(
      implicit.stdout.replaceAll(implicitHome, '<DSH_HOME>'),
    )
    expect(explicit.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(explicit.stdout).not.toContain('dsh-supervised-growth-setup')
  })

  test('npm installer defers Host latest resolution and applies one release selector to every published bundle', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--lark', 'skip', '--profile', 'personal-web', '--plugin-version', '0.2.0',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('目标 profile：personal-web')
    expect(result.stdout).toContain('DSH 目标：npm latest（dry-run 未联网解析')
    expect(result.stdout).toContain('@dsh-enhanced/personal-assistant@0.2.0')
    expect(result.stdout).toContain('@dsh-enhanced/plugin-control-plane@0.2.0')
    expect(result.stdout).not.toContain('@dsh-enhanced/lark-channel@0.2.0')
    expect(result.stdout).not.toContain('@dsh-enhanced/acp@')
    expect(result.stdout).not.toContain('@dsh-enhanced/hello@')
  })

  test('npm cohort preflight resolves latest once from the personal-assistant anchor and verifies every bundle', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$1" in
  view)
    case "$2" in
      @dsh-enhanced/personal-assistant@latest|@dsh-enhanced/personal-assistant@1.4.0|@dsh-enhanced/plugin-control-plane@1.4.0|@dsh-enhanced/traex-acp-provider@1.4.0)
        printf '%s\\n' '"1.4.0"'
        ;;
      *) exit 9 ;;
    esac
    ;;
  *) exit 9 ;;
esac
`)

    const result = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort "$2" "$3" personal-assistant plugin-control-plane traex-acp-provider; printf "resolved=%s\\n" "$DSH_ENHANCED_RESOLVED_PLUGIN_VERSION"',
      'installer-test', installerLibrary, 'latest', '0',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('resolved=1.4.0')
    expect(await readFile(logPath, 'utf8')).toBe([
      'view @dsh-enhanced/personal-assistant@latest version --json --location=global',
      'view @dsh-enhanced/personal-assistant@1.4.0 version --json --location=global',
      'view @dsh-enhanced/plugin-control-plane@1.4.0 version --json --location=global',
      'view @dsh-enhanced/traex-acp-provider@1.4.0 version --json --location=global',
      '',
    ].join('\n'))
  })

  test('npm cohort preflight rejects a partial publication before any profile command can run', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    const profileLogPath = join(root, 'profile.log')
    await mkdir(fakeBin, { recursive: true })
    await symlink(process.execPath, join(fakeBin, 'node'))
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$2" in
  @dsh-enhanced/personal-assistant@latest|@dsh-enhanced/personal-assistant@1.4.0|@dsh-enhanced/plugin-control-plane@1.4.0)
    printf '%s\\n' '"1.4.0"'
    ;;
  @dsh-enhanced/assistant-delivery@1.4.0)
    printf '%s\\n' '"1.3.9"'
    ;;
  *) exit 9 ;;
esac
`)

    const result = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant plugin-control-plane assistant-delivery || exit $?; printf profile-mutated >> "$PROFILE_LOG"',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, HOME: root, NPM_LOG: logPath, PROFILE_LOG: profileLogPath },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@dsh-enhanced/assistant-delivery@1.4.0')
    await expect(readFile(profileLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('npm cohort preflight resolves the same anchor again on a repeated install', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
printf '%s\\n' '"1.4.0"'
`)

    const result = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant plugin-control-plane && dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant plugin-control-plane',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })

    expect(result.status, result.stderr).toBe(0)
    expect((await readFile(logPath, 'utf8')).match(/@latest version --json/g)?.length).toBe(2)
    expect((await readFile(logPath, 'utf8')).match(/@1\.4\.0 version --json/g)?.length).toBe(4)
  })

  test('npm cohort preflight keeps an explicit exact version and makes dry-run registry-free', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$2" in
  @dsh-enhanced/personal-assistant@1.4.0|@dsh-enhanced/plugin-control-plane@1.4.0) printf '%s\\n' '"1.4.0"' ;;
  *) exit 9 ;;
esac
`)

    const explicit = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort 1.4.0 0 personal-assistant plugin-control-plane; printf "resolved=%s\\n" "$DSH_ENHANCED_RESOLVED_PLUGIN_VERSION"',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })
    const dryRun = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 1 personal-assistant plugin-control-plane; printf "resolved=%s\\n" "$DSH_ENHANCED_RESOLVED_PLUGIN_VERSION"',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })
    const environmentDefault = spawnSync('/bin/bash', [
      npmInstaller, '--dry-run', '--lark', 'skip',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        DSH_HOME: join(root, 'dsh-home'),
        DSH_ENHANCED_VERSION: '1.4.0',
        NPM_LOG: logPath,
      },
    })

    expect(explicit.status, explicit.stderr).toBe(0)
    expect(explicit.stdout).toContain('resolved=1.4.0')
    expect(await readFile(logPath, 'utf8')).toContain('view @dsh-enhanced/personal-assistant@1.4.0 version --json --location=global')
    expect(dryRun.status, dryRun.stderr).toBe(0)
    expect(dryRun.stdout).toContain('resolved=<npm-anchor:latest>')
    expect(dryRun.stdout).toContain('不会访问 npm registry')
    expect(environmentDefault.status, environmentDefault.stderr).toBe(0)
    expect(environmentDefault.stdout).toContain('@dsh-enhanced/personal-assistant@1.4.0')
    expect((await readFile(logPath, 'utf8')).match(/\n/g)?.length).toBe(3)
  })

  test('npm cohort preflight rejects malformed registry data and unsafe selectors without running a command', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    const markerPath = join(root, 'selector-ran')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
printf '%s\\n' '{not-json'
`)

    const malformed = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })
    const unsafe = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort "latest; touch $2" 0 personal-assistant',
      'installer-test', installerLibrary, markerPath,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })

    expect(malformed.status).toBe(1)
    expect(malformed.stderr).toContain('无效的版本数据')
    expect(unsafe.status).toBe(2)
    expect(unsafe.stderr).toContain('不支持 range')
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(logPath, 'utf8')).toBe('view @dsh-enhanced/personal-assistant@latest version --json --location=global\n')
  })

  test('npm supervised dry-run describes one unresolved anchor cohort for every required bundle', async () => {
    const dshHome = await temporaryDshHome()
    const installer = await readFile(npmInstaller, 'utf8')
    const release = installer.match(/^DSH_ENHANCED_PINNED_RELEASE_REF='v([^']+)'$/mu)?.[1]
    expect(release).toMatch(/^\d+\.\d+\.\d+$/u)

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--scenario', 'supervised', '--lark', 'configure',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    const selected = [...result.stdout.matchAll(/@dsh-enhanced\/([a-z0-9-]+)@([^\s]+)/gu)]
    expect(selected.length).toBeGreaterThan(0)
    expect(result.stdout).toContain('npm cohort（dry-run）：将先解析 @dsh-enhanced/personal-assistant@latest 的精确版本')
    expect(result.stdout).toContain('<npm-anchor:latest>')
    const slugs = new Set(selected.map(match => match[1]))
    for (const required of [
      'personal-assistant', 'assistant-delivery', 'assistant-evaluation',
      'assistant-evolution', 'assistant-growth-experiments', 'preference-learning', 'assistant-heartbeat',
      'assistant-health', 'assistant-goals', 'assistant-recovery', 'lark-channel', 'event-triggers', 'assistant-proactive',
      // The observe-only work-item ledger is part of the supervised cohort so a
      // fresh managed install records ordinary authenticated intake.
      'assistant-work-items',
    ]) expect(slugs.has(required), `missing ${required}`).toBe(true)
    expect(result.stdout).toContain('env npm_config_loglevel=error dsh plugin --profile web add')
    expect(result.stdout).toContain('dsh-rsi-setup --install-owner --profile web')
    expect(result.stdout).not.toContain('dsh-supervised-growth-setup')
  })

  test.each([
    { name: 'fresh Host profile', workspace: undefined, expectedStatus: 71 },
    { name: 'existing profile and pnpm placeholders', workspace: 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nsharedWorkspaceLockfile: false\nallowBuilds:\n  protobufjs: set this to true or false\n  koffi: set this to true or false\n', expectedStatus: 71 },
    { name: 'existing explicit false', workspace: 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  protobufjs: false\n  other-native: true\n', expectedStatus: 71 },
    { name: 'existing explicit koffi true', workspace: 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: true\n', expectedStatus: 71 },
    { name: 'existing explicit koffi false is honored with a warning', workspace: 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: false\n', expectedStatus: 71, warning: '保留 owner 显式决策 koffi=false' },
    { name: 'existing explicit true conflict', workspace: 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  protobufjs: true\n', expectedStatus: 1, expectedError: 'protobufjs build decision conflicts with false' },
    { name: 'existing unknown protobufjs decision conflict', workspace: 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  protobufjs: ask-owner\n', expectedStatus: 1, expectedError: 'protobufjs build decision must be true or false' },
    { name: 'existing unknown koffi decision conflict', workspace: 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: ask-owner\n', expectedStatus: 1, expectedError: 'koffi build decision must be true or false' },
    { name: 'unreviewed placeholder outside the decision table', workspace: 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: true\n  protobufjs: false\n  some-native: set this to true or false\n', expectedStatus: 1, expectedError: 'unreviewed pending build decisions require an explicit boolean' },
  ])('npm install applies exact profile build policy before package add: $name', async ({ workspace, expectedStatus, expectedError, warning }) => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const profileDirectory = join(dshHome, 'profiles', 'probe')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'operations.log')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(logPath, '')
    if (workspace !== undefined) {
      await mkdir(profileDirectory, { recursive: true })
      await writeFile(join(profileDirectory, 'package.json'), '{"name":"dsh-profile-probe","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
      await writeFile(join(profileDirectory, 'pnpm-workspace.yaml'), workspace)
    }
    const hostExecutable = await nativeInstallerHost(root, `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
if [[ "$*" == *'plugin --profile probe version-exemptions'* ]]; then
  printf 'init\\n' >> "$INSTALL_LOG"
  mkdir -p "$DSH_HOME/profiles/probe"
  printf '%s\\n' '{"name":"dsh-profile-probe","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}' > "$DSH_HOME/profiles/probe/package.json"
  printf 'packages:\\n  - .\\n\\nnodeLinker: hoisted\\nautoInstallPeers: false\\n' > "$DSH_HOME/profiles/probe/pnpm-workspace.yaml"
  exit 0
fi
if [[ "$*" == *'plugin --profile probe add '* ]]; then
  printf 'add\\n' >> "$INSTALL_LOG"
  exit 71
fi
exit 0
`)
    await symlink(hostExecutable, join(fakeBin, 'dsh'))
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "\${1:-}" == 'view' ]]; then printf '"0.1.55"\\n'; exit 0; fi
exit 0
`)
    const result = runInstaller(npmInstaller, [
      '--profile', 'probe', '--scenario', 'core', '--lark', 'skip', '--model', 'skip', '--model-route', 'skip',
      '--no-service', '--yes', '--plugin-version', '0.1.55',
    ], dshHome, undefined, { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, INSTALL_LOG: logPath })
    expect(result.status, result.stderr).toBe(expectedStatus)
    const operations = await readFile(logPath, 'utf8')
    const finalWorkspace = await readFile(join(profileDirectory, 'pnpm-workspace.yaml'), 'utf8')
    if (expectedStatus === 71) {
      expect(operations).toContain('add\n')
      const expectedKoffi = workspace?.includes('koffi: false') ? false : true
      expect(parse(finalWorkspace)).toMatchObject({
        packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false,
        allowBuilds: { protobufjs: false, koffi: expectedKoffi },
      })
      if (workspace?.includes('sharedWorkspaceLockfile')) {
        expect(parse(finalWorkspace)).toMatchObject({ sharedWorkspaceLockfile: false })
      }
      if (workspace?.includes('other-native')) expect(parse(finalWorkspace)).toMatchObject({ allowBuilds: { 'other-native': true } })
      if (warning !== undefined) expect(result.stderr).toContain(warning)
      else expect(result.stderr).not.toContain('profile 依赖构建策略')
    } else {
      expect(operations).not.toContain('add\n')
      expect(finalWorkspace).toBe(workspace)
      expect(result.stderr).toContain(expectedError)
    }
  })

  test('npm install build-policy preparation is idempotent across reruns', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const profileDirectory = join(dshHome, 'profiles', 'probe')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'operations.log')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(logPath, '')
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'package.json'), '{"name":"dsh-profile-probe","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n')
    const workspaceWithPlaceholders = 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  protobufjs: set this to true or false\n  koffi: set this to true or false\n'
    await writeFile(join(profileDirectory, 'pnpm-workspace.yaml'), workspaceWithPlaceholders)
    const hostExecutable = await nativeInstallerHost(root, `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
if [[ "$*" == *'plugin --profile probe add '* ]]; then
  printf 'add\\n' >> "$INSTALL_LOG"
  exit 71
fi
exit 0
`)
    await symlink(hostExecutable, join(fakeBin, 'dsh'))
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "\${1:-}" == 'view' ]]; then printf '"0.1.55"\\n'; exit 0; fi
exit 0
`)
    const args = [
      '--profile', 'probe', '--scenario', 'core', '--lark', 'skip', '--model', 'skip', '--model-route', 'skip',
      '--no-service', '--yes', '--plugin-version', '0.1.55',
    ] as const
    const env = { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, INSTALL_LOG: logPath }
    const first = runInstaller(npmInstaller, args, dshHome, undefined, env)
    expect(first.status, first.stderr).toBe(71)
    const converged = await readFile(join(profileDirectory, 'pnpm-workspace.yaml'), 'utf8')
    expect(parse(converged)).toMatchObject({ allowBuilds: { protobufjs: false, koffi: true } })
    const second = runInstaller(npmInstaller, args, dshHome, undefined, env)
    expect(second.status, second.stderr).toBe(71)
    expect(await readFile(join(profileDirectory, 'pnpm-workspace.yaml'), 'utf8')).toBe(converged)
  })

  const writeInstalledBundleMetadata = async (profileDirectory: string, name: string, isBundle: boolean) => {
    const packageDirectory = join(profileDirectory, 'node_modules', name)
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(join(packageDirectory, 'package.json'), isBundle
      ? '{"name":"placeholder","dsh":{"bundle":"./cordis.patch.yml"}}\n'
      : '{"name":"placeholder"}\n')
  }

  test('npm install drops half-installed bundle dependencies before retry', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const profileDirectory = join(dshHome, 'profiles', 'probe')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'operations.log')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(logPath, '')
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: true\n  protobufjs: false\n')
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      name: 'dsh-profile-probe',
      private: true,
      dependencies: {
        '@dsh-enhanced/personal-assistant': '0.1.55',
        '@dsh-enhanced/plugin-control-plane': '0.1.55',
        '@dsh-enhanced/owner-plain': '1.2.3',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2) + '\n')
    await writeInstalledBundleMetadata(profileDirectory, '@dsh-enhanced/personal-assistant', true)
    await writeInstalledBundleMetadata(profileDirectory, '@dsh-enhanced/plugin-control-plane', true)
    await writeInstalledBundleMetadata(profileDirectory, '@dsh-enhanced/owner-plain', false)
    const hostExecutable = await nativeInstallerHost(root, `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
if [[ "$*" == *'plugin --profile probe add '* ]]; then
  printf 'add\\n' >> "$INSTALL_LOG"
  exit 71
fi
exit 0
`)
    await symlink(hostExecutable, join(fakeBin, 'dsh'))
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "\${1:-}" == 'view' ]]; then printf '"0.1.55"\\n'; exit 0; fi
exit 0
`)
    const result = runInstaller(npmInstaller, [
      '--profile', 'probe', '--scenario', 'core', '--lark', 'skip', '--model', 'skip', '--model-route', 'skip',
      '--no-service', '--yes', '--plugin-version', '0.1.55',
    ], dshHome, undefined, { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, INSTALL_LOG: logPath })
    expect(result.status, result.stderr).toBe(71)
    expect(await readFile(logPath, 'utf8')).toContain('add\n')
    const manifest = parse(await readFile(join(profileDirectory, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ '@dsh-enhanced/owner-plain': '1.2.3' })
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(result.stdout).toContain('半装 bundle')
  })

  test('npm install keeps registered bundles and plain dependencies untouched on rerun', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const profileDirectory = join(dshHome, 'profiles', 'probe')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'operations.log')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(logPath, '')
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: true\n  protobufjs: false\n')
    const originalManifest = JSON.stringify({
      name: 'dsh-profile-probe',
      private: true,
      dependencies: {
        '@dsh-enhanced/personal-assistant': '0.1.55',
        '@dsh-enhanced/owner-tool': '1.2.3',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-enhanced/personal-assistant'] } },
    }, null, 2) + '\n'
    await writeFile(join(profileDirectory, 'package.json'), originalManifest)
    await writeInstalledBundleMetadata(profileDirectory, '@dsh-enhanced/personal-assistant', true)
    await writeInstalledBundleMetadata(profileDirectory, '@dsh-enhanced/owner-tool', false)
    const hostExecutable = await nativeInstallerHost(root, `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
if [[ "$*" == *'plugin --profile probe add '* ]]; then
  printf 'add\\n' >> "$INSTALL_LOG"
  exit 71
fi
exit 0
`)
    await symlink(hostExecutable, join(fakeBin, 'dsh'))
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "\${1:-}" == 'view' ]]; then printf '"0.1.55"\\n'; exit 0; fi
exit 0
`)
    const result = runInstaller(npmInstaller, [
      '--profile', 'probe', '--scenario', 'core', '--lark', 'skip', '--model', 'skip', '--model-route', 'skip',
      '--no-service', '--yes', '--plugin-version', '0.1.55',
    ], dshHome, undefined, { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, INSTALL_LOG: logPath })
    expect(result.status, result.stderr).toBe(71)
    expect(await readFile(join(profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
    expect(result.stdout).not.toContain('半装 bundle')
  })

  test('npm install keeps an unregistered dependency without dsh.bundle metadata', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const profileDirectory = join(dshHome, 'profiles', 'probe')
    const fakeBin = join(root, 'bin')
    await mkdir(fakeBin, { recursive: true })
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: true\n  protobufjs: false\n')
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      name: 'dsh-profile-probe',
      private: true,
      dependencies: { '@dsh-enhanced/plugin-control-plane': '0.1.55' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2) + '\n')
    // Installed tree does not declare dsh.bundle (or is unreadable): never prune.
    await writeInstalledBundleMetadata(profileDirectory, '@dsh-enhanced/plugin-control-plane', false)
    const hostExecutable = await nativeInstallerHost(root, `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
if [[ "$*" == *'plugin --profile probe add '* ]]; then exit 71; fi
exit 0
`)
    await symlink(hostExecutable, join(fakeBin, 'dsh'))
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "\${1:-}" == 'view' ]]; then printf '"0.1.55"\\n'; exit 0; fi
exit 0
`)
    const result = runInstaller(npmInstaller, [
      '--profile', 'probe', '--scenario', 'core', '--lark', 'skip', '--model', 'skip', '--model-route', 'skip',
      '--no-service', '--yes', '--plugin-version', '0.1.55',
    ], dshHome, undefined, { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin` })
    expect(result.status, result.stderr).toBe(71)
    const manifest = parse(await readFile(join(profileDirectory, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ '@dsh-enhanced/plugin-control-plane': '0.1.55' })
  })

  test('npm install dry-run reports half-installed cleanup without writing', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const profileDirectory = join(dshHome, 'profiles', 'probe')
    const fakeBin = join(root, 'bin')
    await mkdir(fakeBin, { recursive: true })
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: true\n  protobufjs: false\n')
    const originalManifest = JSON.stringify({
      name: 'dsh-profile-probe',
      private: true,
      dependencies: { '@dsh-enhanced/personal-assistant': '0.1.55' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2) + '\n'
    await writeFile(join(profileDirectory, 'package.json'), originalManifest)
    await writeInstalledBundleMetadata(profileDirectory, '@dsh-enhanced/personal-assistant', true)
    const hostExecutable = await nativeInstallerHost(root, `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
exit 0
`)
    await symlink(hostExecutable, join(fakeBin, 'dsh'))
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "\${1:-}" == 'view' ]]; then printf '"0.1.55"\\n'; exit 0; fi
exit 0
`)
    const result = runInstaller(npmInstaller, [
      '--profile', 'probe', '--dry-run', '--scenario', 'core', '--lark', 'skip',
      '--yes', '--plugin-version', '0.1.55',
    ], dshHome, undefined, { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin` })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('半装修复')
    expect(await readFile(join(profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
  })

  test('agent provider add retries a half-installed bundle left by a failed add', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const profileDirectory = join(dshHome, 'profiles', 'probe')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'dsh.log')
    await mkdir(fakeBin, { recursive: true })
    await symlink(process.execPath, join(fakeBin, 'node'))
    await writeFile(logPath, '')
    // A failed pnpm add links node_modules and writes the dependency, but the
    // Host never registers the bundle: the old directory-exists early return
    // treated this as installed and skipped the retrying add entirely.
    await mkdir(join(profileDirectory, 'node_modules/@dsh-enhanced/traex-acp-provider'), { recursive: true })
    await writeFile(join(profileDirectory, 'node_modules/@dsh-enhanced/traex-acp-provider/package.json'),
      '{"name":"@dsh-enhanced/traex-acp-provider","dsh":{"bundle":"./cordis.patch.yml"}}\n')
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      name: 'dsh-profile-probe',
      private: true,
      dependencies: { '@dsh-enhanced/traex-acp-provider': '0.1.55' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2) + '\n')
    await writeFile(join(profileDirectory, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: true\n  protobufjs: false\n')
    const hostExecutable = await nativeInstallerHost(root, `#!/bin/bash
printf '%s\\n' "$*" >> "$DSH_LOG"
exit 0
`)
    await symlink(hostExecutable, join(fakeBin, 'dsh'))
    const runEnsure = () => spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_ensure_agent_bundle traex-agent probe "$2" npm "$3" 0.1.55 0',
      'installer-test', installerLibrary, dshHome, repoRoot,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, DSH_LOG: logPath },
    })
    const result = runEnsure()
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(logPath, 'utf8')).toContain('plugin --profile probe add @dsh-enhanced/traex-acp-provider@0.1.55')
    // The stale dependency entry is pruned before the add so the Host
    // reconciler registers the bundle instead of skipping it as pre-existing.
    const manifest = parse(await readFile(join(profileDirectory, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({})
    // Once registered, the function is a pure no-op: no second add.
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      name: 'dsh-profile-probe',
      private: true,
      dependencies: { '@dsh-enhanced/traex-acp-provider': '0.1.55' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-enhanced/traex-acp-provider'] } },
    }, null, 2) + '\n')
    await writeFile(logPath, '')
    const rerun = runEnsure()
    expect(rerun.status, rerun.stderr).toBe(0)
    expect(await readFile(logPath, 'utf8')).toBe('')
  })

  test('half-installed cleanup refuses a profile manifest with a malformed bundles list', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const profileDirectory = join(dshHome, 'profiles', 'probe')
    const fakeBin = join(root, 'bin')
    await mkdir(fakeBin, { recursive: true })
    await symlink(process.execPath, join(fakeBin, 'node'))
    await mkdir(profileDirectory, { recursive: true })
    const originalManifest = JSON.stringify({
      name: 'dsh-profile-probe',
      private: true,
      dependencies: { '@dsh-enhanced/personal-assistant': '0.1.55' },
      dsh: { profile: { bundles: '@dsh-enhanced/personal-assistant' } },
    }, null, 2) + '\n'
    await writeFile(join(profileDirectory, 'package.json'), originalManifest)
    const result = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_prune_half_installed_bundles probe "$2" 0 @dsh-enhanced/personal-assistant@0.1.55',
      'installer-test', installerLibrary, dshHome,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('profile bundles is not a string array')
    expect(await readFile(join(profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
  })

  test('npm installer with its sibling common rejects an unsupported exact host version', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--lark', 'skip', '--dsh-version', '0.1.0-rc.8',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('支持 DSH >=0.2.1-rc.2 <0.3.0')
  })

  test('fresh checkout defers latest resolution in dry-run while the released bootstrap retains its exact pin', async () => {
    const dshHome = await temporaryDshHome()
    const local = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)
    const npm = runInstaller(npmInstaller, ['--dry-run', '--lark', 'skip'], dshHome)
    const manifest = JSON.parse(await readFile(join(repoRoot, 'release-manifest.json'), 'utf8'))
    const released = readFileSync(npmInstaller, 'utf8')
    const pinnedRelease = manifest.pending ?? manifest.current

    expect(local.status, local.stderr).toBe(0)
    expect(npm.status, npm.stderr).toBe(0)
    expect(local.stdout).toContain('DSH 目标：npm latest（dry-run 未联网解析')
    expect(npm.stdout).toContain('DSH 目标：npm latest（dry-run 未联网解析')
    expect(local.stdout).not.toContain('npm install --global @deepseek-ai/dsh@latest')
    expect(npm.stdout).not.toContain('npm install --global @deepseek-ai/dsh@latest')
    expect(manifest.nextPinnedHostVersion).toBe('0.2.2-rc.1')
    expect(manifest.nextVerifiedHostRange).toBe('>=0.2.1-rc.2 <0.3.0')
    expect(released).toContain(`DSH_ENHANCED_PINNED_HOST_VERSION='${pinnedRelease.pinnedHostVersion}'`)
    expect(released).toContain(`DSH_ENHANCED_PINNED_VERIFIED_HOST_RANGE='${pinnedRelease.verifiedHostRange}'`)
  })

  test('remote npm installer exports the verified range paired with its pinned common', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const remoteCommon = join(root, 'common.sh')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(remoteCommon, [
      '#!/usr/bin/env bash',
      'dsh_enhanced_install() {',
      "  printf 'remote-range=%s remote-host=%s\\n' \"$DSH_ENHANCED_VERIFIED_HOST_RANGE\" \"$DSH_ENHANCED_PINNED_HOST_VERSION\"",
      '}',
      '',
    ].join('\n'), 'utf8')
    await writeExecutable(join(fakeBin, 'curl'), `#!/bin/bash
cp "$REMOTE_COMMON" "$4"
`)
    const commonHash = createHash('sha256').update(await readFile(remoteCommon)).digest('hex')
    const installer = await readFile(npmInstaller, 'utf8')
    const releaseManifest = JSON.parse(await readFile(join(repoRoot, 'release-manifest.json'), 'utf8'))
    const pinnedRelease = releaseManifest.pending ?? releaseManifest.current
    expect(pinnedRelease).toBeDefined()
    const pinnedRange = installer.match(
      /^DSH_ENHANCED_PINNED_VERIFIED_HOST_RANGE='([^']+)'$/mu,
    )?.[1]
    const pinnedHostVersion = installer.match(
      /^DSH_ENHANCED_PINNED_HOST_VERSION='([^']+)'$/mu,
    )?.[1]
    const pinnedReleaseRef = installer.match(
      /^DSH_ENHANCED_PINNED_RELEASE_REF='([^']+)'$/mu,
    )?.[1]
    expect(pinnedReleaseRef).toBe(`v${pinnedRelease.version}`)
    expect(pinnedRange).toBe(pinnedRelease.verifiedHostRange)
    expect(pinnedHostVersion).toBe(pinnedRelease.pinnedHostVersion)

    const result = spawnSync('/bin/bash', ['-s', '--', '--dry-run'], {
      cwd: root,
      encoding: 'utf8',
      input: installer,
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: join(root, 'dsh-home'),
        DSH_ENHANCED_INSTALL_BASE_URL: `https://installer.invalid/v${pinnedRelease.version}`,
        DSH_ENHANCED_INSTALL_COMMON_SHA256: commonHash,
        REMOTE_COMMON: remoteCommon,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`remote-range=${pinnedRange} remote-host=${pinnedHostVersion}`)
  })

  test('refuses incompatible stored permission defaults before changing the installation', async () => {
    for (const preset of ['read-only', 'unrecognized-local-preset', 'auto']) {
      const dshHome = await temporaryDshHome()
      const settingsPath = join(dshHome, 'settings.yaml')
      await writeFile(settingsPath, `permission:\n  defaultPreset: ${preset}\n`, 'utf8')
      const before = await readFile(settingsPath, 'utf8')

      const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

      expect(result.status).toBe(2)
      expect(result.stderr).toContain(`permission.defaultPreset=${preset}`)
      expect(result.stderr).toContain('不会覆盖用户设置')
      expect(result.stdout).not.toContain('dsh plugin')
      expect(await readFile(settingsPath, 'utf8')).toBe(before)
    }
  })

  test('preserves every supported stored permission default', async () => {
    for (const preset of ['workspace-write', 'danger-full-access']) {
      const dshHome = await temporaryDshHome()
      const settingsPath = join(dshHome, 'settings.yaml')
      await writeFile(settingsPath, `permission:\n  defaultPreset: ${preset}\n`, 'utf8')
      const before = await readFile(settingsPath, 'utf8')

      const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

      expect(result.status, result.stderr).toBe(0)
      expect(await readFile(settingsPath, 'utf8')).toBe(before)
    }
  })

  test('rejects explicit native Auto before changing the installation', async () => {
    const dshHome = await temporaryDshHome()
    const settingsPath = join(dshHome, 'settings.yaml')
    const before = Buffer.from('permission:\n  defaultPreset: workspace-write\n')
    await writeFile(settingsPath, before)

    const result = runInstaller(localInstaller, ['--permission', 'auto', '--lark', 'skip'], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--permission auto 只适用于当前会话')
    expect(result.stderr).toContain('/permission auto')
    expect(await readdir(dshHome)).toEqual(['settings.yaml'])
    expect(await readFile(settingsPath)).toEqual(before)
  })

  test('Recovery README primary command installs every activator dependency then invokes it after Lark onboarding', async () => {
    const dshHome = await temporaryDshHome()
    const readme = await readFile(join(repoRoot, 'plugins', 'assistant-recovery', 'README.md'), 'utf8')
    const documentedCommand = readme.match(/^\.\/scripts\/install\/install-local\.sh --scenario supervised --lark configure$/mu)?.[0]
    expect(documentedCommand).toBeDefined()
    const [, ...documentedArgs] = documentedCommand!.split(/\s+/u)

    const result = runInstaller(localInstaller, [
      '--dry-run', ...documentedArgs,
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署模式：supervised-growth')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'personal-assistant'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-delivery'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'lark-channel'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-growth-experiments'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'preference-learning'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
    expect(result.stdout).toContain('dsh-lark-setup --profile web')
    expect(result.stdout).toContain('dsh-rsi-setup --install-owner --profile web')
    expect(result.stdout).not.toContain('dsh-supervised-growth-setup')
    expect(result.stdout).not.toContain('overlay：未应用')
  })

  test('supervised-growth can install TraeX when explicitly requested without a local executable', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure', '--with', 'traex',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
  })

  test('selected supervised bundles compose into a real effective tree accepted by the activator', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure',
    ], dshHome)
    expect(result.status, result.stderr).toBe(0)

    const installedRows = await composeSelectedBundleRows(result.stdout)
    const lark = installedRows.find(row => row.id === 'dsh-enhanced-lark-channel')
    expect(lark).toBeDefined()
    lark.config = { ...lark.config, enabled: true, account: 'primary', tenant: 'personal' }
    const effectiveBefore = stringify(installedRows)
    const binding = {
      id: 'binding-owner-dm',
      conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' },
      workspace: join(dshHome, 'assistant-workspace'),
      agentPreset: 'standard',
      sessionId: 'session-owner', generation: 1, policyRef: 'owner-dm', status: 'active',
      createdAt: 1, updatedAt: 1, version: 1,
    } as const
    const overlay = parse(configureSupervisedGrowthProfilePatch({
      profilePatch: '[]\n', effectiveConfig: effectiveBefore, dshHome, binding,
      activationState: 'preview',
      activationNonce: 'installer-compose-preview',
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    }), yamlOptions) as any[]
    const composed = new Map(installedRows.map(row => [row.id, row]))
    for (const row of overlay) composed.set(row.id, row)

    expect(assertEffectiveSupervisedGrowthConfig({
      effectiveConfig: stringify([...composed.values()]), dshHome, binding,
      activationState: 'preview',
      activationNonce: 'installer-compose-preview',
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    })).toMatchObject({
      workspace: join(dshHome, 'assistant-workspace'),
      agentPreset: 'standard',
      activationState: 'preview',
      automationId: 'recovery:supervised-growth',
    })
  })

  test('supervised-growth passes an explicit acknowledgement only to owner RSI setup', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure', '--ack-existing-automations',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('dsh-rsi-setup --install-owner --profile web')
    expect(result.stdout).toContain('--ack-existing-automations')
    expect(result.stdout).not.toContain('dsh-supervised-growth-setup')
  })

  test('supervised-growth refuses to run without an owner onboarding path', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'skip',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('supervised-growth 需要飞书 onboarding')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('rejects an unknown deployment mode before planning installation', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'unbounded', '--lark', 'skip',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--mode 只能是 standard 或 supervised-growth')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('matches npm SemVer precedence and excludes prereleases without a same-core comparator', () => {
    const result = spawnSync('/bin/bash', [
      '-c', [
        'source "$1"',
        'dsh_enhanced_version_ge 0.1.0-rc.8 0.1.0-rc.7',
        '! dsh_enhanced_version_ge 0.1.0-rc.7 0.1.0-rc.8',
        'dsh_enhanced_version_ge 0.1.0 0.1.0-rc.8',
        '! dsh_enhanced_version_ge 0.1.0-rc.8 0.1.0',
        'dsh_enhanced_version_ge 0.1.2-rc.1 0.1.0-rc.8',
        'dsh_enhanced_version_ge 0.1.2-rc.10 0.1.2-rc.2',
        '! dsh_enhanced_version_ge 0.1.2-rc.2 0.1.2-rc.10',
        'dsh_enhanced_version_ge 0.1.2-rc.beta 0.1.2-rc.1',
        '! dsh_enhanced_version_ge 0.1.2-rc.1 0.1.2-rc.beta',
        'dsh_enhanced_version_ge 0.1.2-rc.1.0 0.1.2-rc.1',
        '! dsh_enhanced_version_ge 0.1.2-rc.1 0.1.2-rc.1.0',
        'dsh_enhanced_version_ge 0.1.2+build.2 0.1.2+build.1',
        'dsh_enhanced_version_ge 0.1.2+build.1 0.1.2+build.2',
        "dsh_enhanced_version_in_range 0.1.2-rc.1 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2-rc.2 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2-rc.1.0 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2+build.1 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.3 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.3-rc.1 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.5-rc.1 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.9-rc.10 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.2-alpha.9 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.2-rc.0 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.3-alpha.1 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.5-alpha.1 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.5-beta.2 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.2.0-rc.1 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.2.0-alpha.1 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.2.0 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.4-rc.1 '>=0.1.2 <0.1.5'",
        "! dsh_enhanced_version_in_range 0.1.5-rc.1 '>=0.1.2 <0.1.5'",
      ].join('\n'),
      'installer-test', installerLibrary,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
  })

  test('keeps an installed DSH when it is within the supported range', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(logPath, '', 'utf8')
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\n'; fi
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\n' "$*" >> "$INSTALL_LOG"
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_ensure_dsh 0.2.1-rc.2 0 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, INSTALL_LOG: logPath },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('DSH 已安装且版本兼容：0.2.1-rc.2')
    expect(await readFile(logPath, 'utf8')).toBe('')
  })

  test('prepares setup Host peers from the exact canonical dsh package without mounting a profile', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const hostRoot = join(root, 'host', 'node_modules')
    const dshPackage = join(hostRoot, '@deepseek-ai', 'dsh')
    const appBootPackage = join(hostRoot, '@deepseek-ai', 'dsh-app-boot')
    const canonicalDsh = join(dshPackage, 'bin', 'dsh.js')
    await mkdir(dirname(canonicalDsh), { recursive: true })
    await mkdir(appBootPackage, { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    // Exports deliberately hides package.json so this covers an npm bin
    // symlink whose canonical executable must be anchored by its package.
    await writeFile(join(dshPackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '0.1.5-rc.3', type: 'module', exports: './bin/dsh.js',
    }))
    await writeFile(canonicalDsh, '#!/usr/bin/env node\nthrow new Error("dsh must not be mounted for setup peers")\n')
    await chmod(canonicalDsh, 0o755)
    await writeFile(join(appBootPackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-app-boot', type: 'module', exports: './index.js',
    }))
    await writeFile(join(appBootPackage, 'index.js'), [
      "import { mkdir, writeFile } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      'export async function healProfilesModuleFallback({ installAnchor, home }) {',
      "  if (!installAnchor.endsWith('/@deepseek-ai/dsh/package.json')) throw new Error('wrong Host anchor')",
      "  await mkdir(join(home, 'profiles', 'node_modules'), { recursive: true })",
      "  await writeFile(join(home, 'profiles', 'node_modules', '.host-fallback-healed'), 'exact-host')",
      '}',
      '',
    ].join('\n'))
    await symlink(canonicalDsh, join(fakeBin, 'dsh'))

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_heal_host_module_fallback "$2" 0.1.5-rc.3',
      'installer-test', installerLibrary, dshHome,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { DSH_ENHANCED_VERIFIED_HOST_RANGE: '>=0.1.5-rc.3 <0.1.6', PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('已验证 DSH 的 setup peer 解析；未挂载或启动 profile')
    expect(await readFile(join(dshHome, 'profiles', 'node_modules', '.host-fallback-healed'), 'utf8')).toBe('exact-host')
    await expect(stat(join(dshHome, '.activation-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('installs the Host peer closure after bundle add and before the web setup CLI', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const workspace = join(root, 'workspace')
    const logPath = join(root, 'commands.log')
    const hostRoot = join(root, 'host', 'node_modules')
    const dshPackage = join(hostRoot, '@deepseek-ai', 'dsh')
    const appBootPackage = join(hostRoot, '@deepseek-ai', 'dsh-app-boot')
    const canonicalDsh = join(dshPackage, 'bin', 'dsh.js')
    await Promise.all([mkdir(dirname(canonicalDsh), { recursive: true }), mkdir(appBootPackage, { recursive: true }),
      mkdir(fakeBin, { recursive: true }), mkdir(workspace), writeFile(logPath, '')])
    await writeFile(join(dshPackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '0.1.5-rc.3', type: 'module', exports: './bin/dsh.js',
    }))
    await writeFile(canonicalDsh, [
      '#!/usr/bin/env node',
      "import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      'const args = process.argv.slice(2)',
      "await appendFile(process.env.INSTALL_LOG, `dsh ${args.join(' ')}\\n`)",
      "if (args[0] === '--version') { process.stdout.write('0.1.5-rc.3\\n'); process.exit(0) }",
      "if (args.includes('plugin') && args.includes('add')) {",
      "  const bin = join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', '.bin')",
      '  await mkdir(bin, { recursive: true })',
      "  const setup = join(bin, 'dsh-web-owner-setup')",
      `  await writeFile(setup, ${JSON.stringify('#!/bin/bash\nset -euo pipefail\ntest -f "$DSH_HOME/profiles/node_modules/.host-fallback-healed"\nprintf "web-setup %s\\n" "$*" >> "$INSTALL_LOG"\n')})`,
      '  await chmod(setup, 0o755)',
      '  process.exit(0)',
      '}',
      "if (args.includes('--dump-config')) { process.stdout.write('[]\\n'); process.exit(0) }",
      "if (args.includes('--host')) { process.stdout.write('dsh web: http://127.0.0.1:43210\\n'); process.exit(0) }",
      'process.exit(0)',
      '',
    ].join('\n'))
    await chmod(canonicalDsh, 0o755)
    await writeFile(join(appBootPackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-app-boot', type: 'module', exports: './index.js',
    }))
    await writeFile(join(appBootPackage, 'index.js'), [
      "import { mkdir, writeFile } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      'export async function healProfilesModuleFallback({ installAnchor, home }) {',
      "  if (!installAnchor.endsWith('/@deepseek-ai/dsh/package.json')) throw new Error('wrong Host anchor')",
      "  await mkdir(join(home, 'profiles', 'node_modules'), { recursive: true })",
      "  await writeFile(join(home, 'profiles', 'node_modules', '.host-fallback-healed'), 'exact-host')",
      "  await writeFile(process.env.INSTALL_LOG, 'host-fallback\\n', { flag: 'a' })",
      '}',
      '',
    ].join('\n'))
    await symlink(canonicalDsh, join(fakeBin, 'dsh'))
    const webPort = await new Promise<number>((resolvePort, rejectPort) => {
      const server = createServer()
      server.once('error', rejectPort)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') return rejectPort(new Error('missing test port'))
        server.close(error => error === undefined ? resolvePort(address.port) : rejectPort(error))
      })
    })
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "${'$'}{1:-}" == '--version' ]]; then printf '11.7.0\\n'; else printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"; fi
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "${'$'}{1:-}" == 'prefix' ]]; then printf '%s\\n' "$FAKE_PREFIX"; exit 0; fi
printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'dsh-rsi'), `#!/bin/bash
if [[ "${'$'}{1:-}" == 'version' ]]; then printf '0.1.48\\n'; fi
`)

    const result = spawnSync('/bin/bash', [
      localInstaller, '--scenario', 'web', '--workspace', workspace, '--yes', '--no-service', '--model', 'skip',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { DSH_ENHANCED_VERIFIED_HOST_RANGE: '>=0.1.5-rc.3 <0.1.6', PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, DSH_HOME: dshHome, INSTALL_LOG: logPath, FAKE_PREFIX: root, DSH_ENHANCED_WEB_PORT: String(webPort) },
    })

    expect(result.status, result.stderr).toBe(0)
    const log = await readFile(logPath, 'utf8')
    expect(log).toMatch(/dsh plugin --profile web add[\s\S]*host-fallback[\s\S]*web-setup/)
    expect(await readFile(join(dshHome, 'profiles', 'node_modules', '.host-fallback-healed'), 'utf8')).toBe('exact-host')
  })

  test('keeps the verified installed DSH without invoking npm', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(logPath, '', 'utf8')
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_ensure_dsh latest 0 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, INSTALL_LOG: logPath },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('DSH 已安装且版本兼容：0.2.1-rc.2')
    expect(await readFile(logPath, 'utf8')).toBe('')
  })

  test('resolves latest to an exact supported Host before a fresh global install', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(logPath, '', 'utf8')
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
if [[ "$*" == 'install --global @deepseek-ai/dsh@0.2.1-rc.2' ]]; then
  printf '#!/bin/bash\\nif [[ "\${1:-}" == "--version" ]]; then printf "0.2.1-rc.2\\\\n"; fi\\n' > "$FAKE_BIN/dsh"
  chmod +x "$FAKE_BIN/dsh"
  exit 0
fi
exit 8
`)
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_ensure_dsh latest 0 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, INSTALL_LOG: logPath, FAKE_BIN: fakeBin },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('DSH 目标：@deepseek-ai/dsh@0.2.1-rc.2')
    expect(await readFile(logPath, 'utf8')).toBe('npm view @deepseek-ai/dsh dist-tags.latest\nnpm install --global @deepseek-ai/dsh@0.2.1-rc.2\nnpm prefix --global\n')
  })

  test('explicit exact Host selector bypasses latest lookup', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(logPath, '', 'utf8')
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == 'install --global @deepseek-ai/dsh@0.2.1-rc.2' ]]; then
  printf '#!/bin/bash\\nif [[ "\${1:-}" == "--version" ]]; then printf "0.2.1-rc.2\\\\n"; fi\\n' > "$FAKE_BIN/dsh"
  chmod +x "$FAKE_BIN/dsh"
  exit 0
fi
exit 8
`)
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_ensure_dsh 0.2.1-rc.2 0 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, INSTALL_LOG: logPath, FAKE_BIN: fakeBin },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(logPath, 'utf8')).toBe('npm install --global @deepseek-ai/dsh@0.2.1-rc.2\nnpm prefix --global\n')
  })

  test.each(['', 'garbage', '0.1.5-beta.9', '0.1.6-rc.1', '0.2.1-rc.2\n0.2.1-rc.2'])('rejects unsafe latest registry response %j before install', async latest => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(logPath, '', 'utf8')
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '%s\\n' "$LATEST_RESPONSE"; exit 0; fi
exit 8
`)
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_ensure_dsh latest 0 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, INSTALL_LOG: logPath, LATEST_RESPONSE: latest },
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('不是此安装器支持的精确版本')
    expect(await readFile(logPath, 'utf8')).toBe('npm view @deepseek-ai/dsh dist-tags.latest\n')
  })

  test('stops without an install when latest lookup fails', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(logPath, '', 'utf8')
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"
exit 8
`)
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_ensure_dsh latest 0 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, INSTALL_LOG: logPath },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('无法从 npm registry 解析 DSH latest')
    expect(await readFile(logPath, 'utf8')).toBe('npm view @deepseek-ai/dsh dist-tags.latest\n')
  })

  // The transaction uses the same Linux-only flock/proc contracts as the
  // lifecycle integration suite; the version-only checks above are portable.
  test.skipIf(process.platform !== 'linux')('upgrade executes with an installed verified Host without changing the global npm toolchain', async () => {
    const f = await lifecycleFixture()
    const dsh = join(f.fakeBin, 'dsh')
    await writeFile(dsh, (await readFile(dsh, 'utf8')).replace("printf '0.2.1-rc.2\\n'", "printf '0.2.1-rc.2\\n'"))
    const result = runInstaller(localInstaller, [
      '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--scenario', 'web',
    ], f.dshHome, undefined, { ...lifecycleEnvironment(f.dshHome, f.fakeBin), PATH: `${f.fakeBin}:${process.env.PATH ?? ''}` })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('生命周期事务使用现有 DSH：0.2.1-rc.2')
    expect(await readFile(f.operationLog, 'utf8')).not.toContain('npm ')
  })

  test('rejects a requested unsupported DSH version even when acknowledgement is supplied', async () => {
    const dshHome = await temporaryDshHome()
    const blocked = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--dsh-version', '0.1.0-rc.8',
    ], dshHome)
    expect(blocked.status).toBe(2)
    expect(blocked.stderr).toContain('支持 DSH >=0.2.1-rc.2 <0.3.0')
    expect(blocked.stdout).not.toContain('dsh plugin')

    const acknowledged = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--dsh-version', '0.1.0-rc.8', '--ack-unverified-host',
    ], dshHome)
    expect(acknowledged.status).toBe(2)
    expect(acknowledged.stderr).toContain('支持 DSH >=0.2.1-rc.2 <0.3.0')
    expect(acknowledged.stdout).not.toContain('@deepseek-ai/dsh@0.1.0-rc.8')

    const sourcePin = readFileSync(installerLibrary, 'utf8').match(/^DSH_ENHANCED_SOURCE_PINNED_HOST_VERSION='([^']+)'$/mu)?.[1]
    expect(sourcePin).toBeDefined()
    const override = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome, undefined, {
      // The equality guard must reject any explicit pin different from the
      // source pin, independent of future default version updates.
      DSH_ENHANCED_PINNED_HOST_VERSION: `${sourcePin!}-tampered`,
    })
    expect(override.status).toBe(2)
    expect(override.stderr).toContain('Host pin 与安装逻辑不一致')
    expect(override.stdout).not.toContain('dsh plugin')
  })

  test('accepts the verified 0.2 release candidates and rejects next-line or malformed Host versions', () => {
    const result = spawnSync('/bin/bash', ['-c', [
      'source "$1"',
      'dsh_enhanced_require_pinned_host_version 0.2.1-rc.2',
      'dsh_enhanced_require_pinned_host_version 0.2.2-rc.1',
      '! dsh_enhanced_require_pinned_host_version 0.2.0-rc.1',
      '! dsh_enhanced_require_pinned_host_version 0.2.1-rc.2-invalid!',
    ].join('; '), 'installer-test', installerLibrary], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('支持 DSH >=0.2.1-rc.2 <0.3.0')
  })

  test('next release Host baseline admits 0.2.1-rc.2 and 0.2.2-rc.1 and rejects old or beta builds', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'release-manifest.json'), 'utf8'))
    const result = spawnSync('/bin/bash', ['-c', [
      'set -e',
      'source "$1"',
      'dsh_enhanced_require_pinned_host_version 0.2.1-rc.2',
      'dsh_enhanced_require_pinned_host_version 0.2.2-rc.1',
      '! dsh_enhanced_require_pinned_host_version 0.2.0-rc.2',
      '! dsh_enhanced_require_pinned_host_version 0.1.5-rc.2',
      '! dsh_enhanced_require_pinned_host_version 0.1.6-beta.1',
      '! dsh_enhanced_require_pinned_host_version 0.1.7-rc.2',
    ].join('; '), 'installer-test', installerLibrary], {
      encoding: 'utf8',
      env: { ...process.env, DSH_ENHANCED_VERIFIED_HOST_RANGE: manifest.nextVerifiedHostRange },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('支持 DSH >=0.2.1-rc.2 <0.3.0')
  })

  test('local installer installs the exact supported DSH on a fresh machine and executes build, install, and validation', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    const setupDirectory = join(dshHome, 'profiles', 'web', 'node_modules', '.bin')
    await mkdir(setupDirectory, { recursive: true })
    await writeExecutable(join(setupDirectory, 'dsh-lark-setup'), `#!/bin/bash
printf 'lark-setup %s\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'dsh-new'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == *'--no-open --port 0'* ]]; then
  printf 'dsh web: http://127.0.0.1:43210\\n'
  exit 0
fi
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
if [[ "\${1:-}" == 'prefix' ]]; then printf '%s\\n' "$FAKE_PREFIX"; exit 0; fi
if [[ "$*" == 'install --global @deepseek-ai/dsh@0.2.1-rc.2' ]]; then
  cp "$FAKE_BIN/dsh-new" "$FAKE_BIN/dsh"
  chmod 755 "$FAKE_BIN/dsh"
fi
if [[ "\${1:-}" == 'install' && "$*" == *rsi-cli* ]]; then
  printf '#!/bin/bash\nif [[ "\${1:-}" == version ]]; then printf "0.1.35\\n"; fi\nexit 0\n' > "$FAKE_BIN/dsh-rsi"
  chmod 755 "$FAKE_BIN/dsh-rsi"
fi
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)

    const result = spawnSync('/bin/bash', [localInstaller, '--lark', 'skip'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
        FAKE_BIN: fakeBin,
        FAKE_PREFIX: root,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('npm install --global @deepseek-ai/dsh@0.2.1-rc.2')
    expect(log).toContain('pnpm install')
    expect(log).toContain('pnpm build')
    expect(log).toContain('dsh plugin --profile web add')
    expect(log).toContain('dsh --profile web --dump-config')
    expect(log).toContain('dsh --profile web --host 127.0.0.1 --no-open --port 0')
    expect(log).not.toContain('lark-setup')
  })

  test('fails before Feishu onboarding when a real activation probe reports a pending service', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: {
        '@dsh-enhanced/assistant-evolution': '0.1.7',
        '@dsh-enhanced/assistant-evaluation': '0.1.7',
      },
    }, null, 2), 'utf8')
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.2.1-rc.2\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == *'--no-open --port 0'* ]]; then
  printf '%s\\n' 'Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate' >&2
  printf '%s\\n' '@dsh-enhanced/assistant-evolution: pending (waiting for service: assistantEvaluation)' >&2
  exit 1
fi
if [[ "\${1:-}" == 'plugin' ]]; then
  bin="$DSH_HOME/profiles/web/node_modules/.bin"
  mkdir -p "$bin"
  cat > "$bin/dsh-lark-setup" <<'EOF'
#!/bin/bash
printf 'lark-setup %s\\n' "$*" >> "$INSTALL_LOG"
EOF
  chmod 755 "$bin/dsh-lark-setup"
fi
`)

    const result = spawnSync('/bin/bash', [
      localInstaller, '--scenario', 'lark', '--lark', 'skip', '--no-service', '--yes',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('waiting for service: assistantEvaluation')
    expect(result.stderr).toContain('尚未继续飞书授权、凭据写入或常驻服务启动')
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('--no-open --port 0')
    expect(log).not.toContain('lark-setup')
    expect(log).not.toContain('systemctl --user show-environment')
  })

  test('supervised-growth prepares source before Lark setup and installs owner RSI after doctor without fixed Recovery', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await configureExistingLark(dshHome)
    const profile = join(dshHome, 'profiles', 'web')
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', type: 'module',
      dependencies: { '@dsh-enhanced/lark-channel': '0.0.0' }, dsh: { profile: { bundles: [] } },
    }))
    const larkExecutable = await nativeInstallerSetupPackage(profile, 'lark-channel', 'dsh-lark-setup', 'setup',
      `import { appendFile } from 'node:fs/promises'
export async function runLarkSetup(args) { await appendFile(process.env.INSTALL_LOG, 'lark-setup ' + args.join(' ') + '\\n') }
`)
    const rsiExecutable = await nativeInstallerSetupPackage(profile, 'lark-channel', 'dsh-rsi-setup', 'rsi-setup',
      `import { appendFile } from 'node:fs/promises'
export async function runRsiSetup(args) { await appendFile(process.env.INSTALL_LOG, 'rsi-source-setup ' + args.join(' ') + '\\n') }
`)
    const setupBin = join(profile, 'node_modules', '.bin')
    await mkdir(setupBin, { recursive: true })
    await symlink(larkExecutable, join(setupBin, 'dsh-lark-setup'))
    await symlink(rsiExecutable, join(setupBin, 'dsh-rsi-setup'))
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; exit 0; fi
if [[ "\${6:-}" == 'source-rsi' && "$*" == *'--install-local-cohort'* ]]; then
  printf 'local-cohort %s\\n' "\${*:9}" >> "$INSTALL_LOG"
  dsh plugin --profile web add fixture-local-cohort
  exit 0
fi
exec "$FIXTURE_REAL_NODE" "$@"
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
if [[ "\${1:-}" == 'prefix' ]]; then printf '%s\\n' "$FAKE_PREFIX"; fi
if [[ "\${1:-}" == 'install' && "$*" == *rsi-cli* ]]; then
  printf '#!/bin/bash\nif [[ "\${1:-}" == version ]]; then printf "0.1.35\\n"; fi\nexit 0\n' > "$FAKE_BIN/dsh-rsi"
  chmod 755 "$FAKE_BIN/dsh-rsi"
fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then printf 'yes\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "\${1:-}" == '--user' && "\${2:-}" == 'show' ]]; then
  printf '%s\\n' 'ActiveState=active' 'SubState=running' 'NRestarts=0' 'ExecMainStatus=0'
fi
exit 0
`)
    const hostExecutable = await nativeInstallerHost(root, `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == *'--no-open --port 0'* ]]; then
  printf 'dsh web: http://127.0.0.1:43210\\n'
  exit 0
fi
`)
    await symlink(hostExecutable, join(fakeBin, 'dsh'))

    const result = spawnSync('/bin/bash', [localInstaller, '--mode', 'supervised-growth', '--lark', 'keep', '--yes'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
        FAKE_BIN: fakeBin,
        FIXTURE_REAL_NODE: process.execPath,
        FAKE_PREFIX: root,
        DSH_ENHANCED_SERVICE_STABILITY_SECONDS: '0',
        // The fake bin stubs systemd tooling, so pin the detected platform
        // instead of inheriting the host's own `uname -s`.
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'Linux',
      },
    })

    expect(result.status, `${result.stderr}\n${await readFile(logPath, 'utf8')}`).toBe(0)
    expect(result.stdout).not.toContain('supervised growth activated')
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('systemctl --user show-environment')
    expect(log).toContain('systemctl --user is-active --quiet dsh-profile-web.service')
    expect(log).toContain('systemctl --user show dsh-profile-web.service')
    expect(log).toContain('loginctl show-user')
    expect(log).not.toContain('--no-open --port 0')
    const larkSetup = log.indexOf('lark-setup --profile web --install-service')
    const localCohort = log.indexOf('local-cohort ')
    const sourceSetup = log.indexOf(`rsi-source-setup --prepare-build --optional-build --profile web --dsh-home ${dshHome} --source-repository ${repoRoot}`)
    const ownerInstall = log.indexOf('rsi-source-setup --install-owner --profile web')
    expect(log).not.toContain('supervised-setup')
    const serviceDoctor = log.indexOf('systemctl --user is-active --quiet dsh-profile-web.service')
    expect(larkSetup).toBeGreaterThanOrEqual(0)
    expect(sourceSetup).toBeGreaterThanOrEqual(0)
    expect(localCohort).toBeGreaterThanOrEqual(0)
    expect(sourceSetup).toBeGreaterThan(localCohort)
    expect(larkSetup).toBeGreaterThan(sourceSetup)
    expect(serviceDoctor).toBeGreaterThan(larkSetup)
    expect(ownerInstall).toBeGreaterThan(serviceDoctor)
  })

  test('Linux service stability verification stops a restart loop and reports its journal', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const showCount = join(root, 'show-count')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == '--user' && "\${2:-}" == 'show' ]]; then
  count=0
  if [[ -f "$SHOW_COUNT" ]]; then count="$(cat "$SHOW_COUNT")"; fi
  count=$((count + 1))
  printf '%s' "$count" > "$SHOW_COUNT"
  if [[ "$count" == '1' ]]; then restarts=0; else restarts=1; fi
  printf 'ActiveState=active\\nSubState=running\\nNRestarts=%s\\nExecMainStatus=0\\n' "$restarts"
fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'journalctl'), `#!/bin/bash
printf 'journalctl %s\\n' "$*" >> "$COMMAND_LOG"
printf '%s\\n' 'simulated DSH activation failure'
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_verify_linux_service_stability web',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        SHOW_COUNT: showCount,
        DSH_ENHANCED_SERVICE_STABILITY_SECONDS: '0',
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('restarts=0->1')
    expect(result.stderr).toContain('simulated DSH activation failure')
    expect(result.stderr).toContain('已停止该服务以避免无限重启')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain('systemctl --user show dsh-profile-web.service')
    expect(log).toContain('journalctl --user -u dsh-profile-web.service -n 80 --no-pager')
    expect(log).toContain('systemctl --user stop dsh-profile-web.service')
  })

  test('checks TraeX login before changing its global default or restarting the managed Lark service', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await configureExistingLark(dshHome)
    const originalSettings = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    await writeFile(join(dshHome, 'settings.yaml'), originalSettings, 'utf8')
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; exit 0; fi
exec "$NODE_BIN" "$@"
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.2.1-rc.2\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
if [[ "\${1:-}" == 'show-user' ]]; then printf 'yes\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$COMMAND_LOG"
exit 0
`)
    await writeExecutable(join(fakeBin, 'traex'), `#!/bin/bash
if [[ "\${1:-}" == 'login' && "\${2:-}" == 'status' ]]; then
  printf '%s\\n' 'not logged in'
  exit 1
fi
exit 1
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == *'--dump-config'* ]]; then
  printf '%s\\n' "name: '@dsh-enhanced/traex-acp-provider'"
fi
if [[ "\${1:-}" == 'plugin' ]]; then
  bin="$DSH_HOME/profiles/web/node_modules/.bin"
  mkdir -p "$bin"
  cat > "$bin/dsh-lark-setup" <<'EOF'
#!/bin/bash
printf 'lark-setup %s\\n' "$*" >> "$COMMAND_LOG"
EOF
  cat > "$bin/dsh-model-setup" <<'EOF'
#!/bin/bash
printf 'model-setup %s\\n' "$*" >> "$COMMAND_LOG"
EOF
  chmod 755 "$bin/dsh-lark-setup" "$bin/dsh-model-setup"
fi
`)

    const result = spawnSync('/bin/bash', [
      localInstaller, '--scenario', 'lark', '--lark', 'keep', '--model-provider', 'traex-agent', '--yes',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        COMMAND_LOG: commandLog,
        NODE_BIN: process.execPath,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('traex 未确认登录')
    const log = await readFile(commandLog, 'utf8')
    expect(log).not.toContain('model-setup --dsh-home')
    expect(log).not.toContain('systemctl --user restart dsh-profile-web.service')
    expect(await readFile(join(dshHome, 'settings.yaml'), 'utf8')).toBe(originalSettings)
  })

  test('agent-route rollback restores the exact pre-write settings and profile patch', async () => {
    const dshHome = await temporaryDshHome()
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const settingsPath = join(dshHome, 'settings.yaml')
    const profilePatch = join(profileDirectory, 'cordis.patch.yml')
    const originalSettings = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    const originalPatch = '# owner overlay\n[]\n'
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(settingsPath, originalSettings, 'utf8')
    await writeFile(profilePatch, originalPatch, 'utf8')

    const result = spawnSync('/bin/bash', [
      '-c', [
        'source "$1"',
        'snapshot="$(dsh_enhanced_snapshot_agent_route_configuration "$2" "$3")" || exit $?',
        "printf 'agent-default-model:\\n  provider: traex-agent\\n' > \"$3/settings.yaml\"",
        "printf '%s\\n' '- id: dsh-enhanced-traex-acp-provider' '  config: { enabled: true }' > \"$3/profiles/$2/cordis.patch.yml\"",
        'dsh_enhanced_restore_agent_route_configuration "$snapshot" "$2" "$3"',
      ].join('\n'),
      'installer-test', installerLibrary, 'web', dshHome,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(settingsPath, 'utf8')).toBe(originalSettings)
    expect(await readFile(profilePatch, 'utf8')).toBe(originalPatch)
  })

  test('agent-route transaction restores files when SIGTERM lands after the model write', async () => {
    const dshHome = await temporaryDshHome()
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const settingsPath = join(dshHome, 'settings.yaml')
    const profilePatch = join(profileDirectory, 'cordis.patch.yml')
    const originalSettings = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    const originalPatch = '# owner overlay\n[]\n'
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(settingsPath, originalSettings, 'utf8')
    await writeFile(profilePatch, originalPatch, 'utf8')

    // `$$` is the pid of the subshell that installed the EXIT/TERM traps: inside
    // a `name() ( ... )` subshell function bash keeps `$$` pointing at that
    // shell, so the signal reaches the rollback owner. `$BASHPID` is unset on
    // macOS bash 3.2, and deriving a pid via `exec sh -c 'echo $PPID'` returns
    // the command substitution's own child instead, which exits 143 without ever
    // running the restore.
    //
    // Signalling `$$` is fatal to the shell that runs it, so the transaction runs
    // in a nested shell; the outer shell survives to observe its 143 and to keep
    // the rollback assertions below reachable.
    const result = spawnSync('/bin/bash', [
      '-c', [
        'inner=$(cat <<\'SCRIPT\'',
        'source "$1"',
        'dsh_enhanced_apply_model() {',
        `  printf 'agent-default-model:\\n  provider: traex-agent\\n' > "$2/settings.yaml"`,
        `  printf '%s\\n' '- id: dsh-enhanced-traex-acp-provider' > "$2/profiles/$1/cordis.patch.yml"`,
        '  kill -TERM "$$"',
        '}',
        'dsh_enhanced_verify_model_route() { return 1; }',
        'dsh_enhanced_apply_verified_agent_model "$2" "$3" traex-agent "" "" "" "" 0 1',
        'SCRIPT',
        ')',
        '/bin/bash -c "$inner" installer-test "$1" "$2" "$3"',
        'status=$?',
        '[[ "$status" == 143 ]]',
      ].join('\n'),
      'installer-test', installerLibrary, 'web', dshHome,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('已恢复原有 settings/profile patch')
    expect(await readFile(settingsPath, 'utf8')).toBe(originalSettings)
    expect(await readFile(profilePatch, 'utf8')).toBe(originalPatch)
  })

  test('Linux auto supervision preserves the existing Feishu binding and Agent policy', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    const result = runInstaller(localInstaller, ['--dry-run', '--yes'], dshHome, 'Linux')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：supervised')
    expect(result.stdout).toContain('飞书处理：保留当前应用配置')
    expect(result.stdout).toContain('检测到已有启用的 Lark channel；跳过临时 Host')
    const larkSetup = join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')
    const installService = `${larkSetup} --profile web --install-service`
    expect(result.stdout).toContain(installService)
    expect(result.stdout).not.toContain('--refresh-agent-policy')
  })

  test('Lark auto passes no Agent tools override, while explicit preserve never refreshes policy', async () => {
    const dshHome = await temporaryDshHome()
    const automatic = runInstaller(localInstaller, [
      '--dry-run', '--scenario', 'lark', '--lark', 'configure', '--no-service',
    ], dshHome)
    expect(automatic.status, automatic.stderr).toBe(0)
    expect(automatic.stdout).toContain('Agent 工具授权：auto')
    expect(automatic.stdout).toContain('dsh-lark-setup --profile web --no-service')
    expect(automatic.stdout).not.toContain('--preserve-agent-tools')
    await configureExistingLark(dshHome)
    const preserved = runInstaller(localInstaller, [
      '--dry-run', '--scenario', 'lark', '--lark', 'keep', '--agent-tools', 'preserve',
    ], dshHome)
    expect(preserved.status, preserved.stderr).toBe(0)
    expect(preserved.stdout).not.toContain('--refresh-agent-policy')
  })

  test.each([localInstaller, npmInstaller].flatMap(installer => [
    { installer, profile: 'web', mode: 'missing', extra: [] },
    { installer, profile: 'personal-web', mode: 'missing', extra: [] },
    { installer, profile: 'web', mode: 'registered', extra: [] },
    { installer, profile: 'web', mode: 'failed', extra: [] },
    { installer, profile: 'web', mode: 'invisible', extra: [] },
    { installer, profile: 'web', mode: 'foreign', extra: [] },
    { installer, profile: 'web', mode: 'inactive', extra: [] },
    { installer, profile: 'web', mode: 'missing', extra: ['--no-service'] },
    { installer, profile: 'web', mode: 'missing', extra: ['--lark', 'skip'] },
  ]))('reconciles launchd registration in $installer ($profile, $mode, $extra)', async ({ installer, profile, mode, extra }) => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const fakeBin = join(root, 'bin')
    const setupDirectory = join(dshHome, 'profiles', profile, 'node_modules', '.bin')
    const logPath = join(root, 'commands.log')
    const registered = join(root, 'registered')
    await mkdir(fakeBin)
    await mkdir(setupDirectory, { recursive: true })
    await configureExistingLark(dshHome, profile)
    const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
    const originalPatch = await readFile(patchPath, 'utf8')
    await writeFile(logPath, '')
    if (mode === 'registered' || mode === 'inactive') await writeFile(registered, '')
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; exit 0; fi
exec "$FIXTURE_REAL_NODE" "$@"
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "\${1:-}" == 'view' ]]; then printf '"0.1.33"\\n'; fi
if [[ "\${1:-}" == 'install' && "$*" == *rsi-cli* ]]; then
  printf '#!/bin/bash\nif [[ "\${1:-}" == version ]]; then printf "0.1.35\\n"; fi\nexit 0\n' > "$FAKE_BIN/dsh-rsi"
  chmod 755 "$FAKE_BIN/dsh-rsi"
fi
exit 0
`)
    const hostExecutable = await nativeInstallerHost(root, `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.2.1-rc.2\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
exit 0
`)
    await symlink(hostExecutable, join(fakeBin, 'dsh'))
    await writeExecutable(join(fakeBin, 'launchctl'), `#!/bin/bash
printf 'launchctl %s\\n' "$*" >> "$INSTALL_LOG"
[[ "$1" == 'print' && "$2" == "gui/$(id -u)/ai.deepseek.dsh.profile.$FIXTURE_PROFILE" && -f "$REGISTERED" ]]
`)
    const packageExecutable = await nativeInstallerSetupPackage(join(dshHome, 'profiles', profile),
      'lark-channel', 'dsh-lark-setup', 'setup', `import { appendFile, access, writeFile } from 'node:fs/promises'
export async function runLarkSetup(args) {
  await appendFile(process.env.INSTALL_LOG, 'lark-setup ' + args.join(' ') + '\\n')
  if (args.join(' ') !== '--profile ' + process.env.FIXTURE_PROFILE + ' --install-service') throw new Error('wrong setup args')
  try { await access(process.env.SETUP_ONCE) } catch { await writeFile(process.env.SETUP_ONCE, ''); return }
  if (process.env.REGISTER_MODE === 'failed') throw new Error('bootstrap denied')
  if (process.env.REGISTER_MODE !== 'invisible') await writeFile(process.env.REGISTERED, '')
}
`)
    await writeFile(join(dirname(dirname(packageExecutable)), 'lib', 'launchd-control.js'), `import { appendFile, access } from 'node:fs/promises'
export async function runLaunchdControl(args) {
  const profile = args[args.indexOf('--profile') + 1]
  const home = args[args.indexOf('--dsh-home') + 1]
  const action = args[args.indexOf('--action') + 1]
  if (profile !== process.env.FIXTURE_PROFILE || home !== process.env.DSH_HOME) throw new Error('wrong service identity')
  await appendFile(process.env.INSTALL_LOG, 'lark-service ' + action + ' ' + profile + '\\n')
  if (process.env.REGISTER_MODE === 'foreign') throw new Error('loaded service belongs to another installation')
  if (process.env.REGISTER_MODE === 'inactive' && action === 'running') { process.exitCode = 3; return }
  try { await access(process.env.REGISTERED) } catch { process.exitCode = 3 }
}
`)
    await symlink(packageExecutable, join(setupDirectory, 'dsh-lark-setup'))
    await writeFile(join(dshHome, 'profiles', profile, 'package.json'), JSON.stringify({
      name: `dsh-profile-${profile}`, type: 'module',
      // A healthy prior add leaves the bundle both in dependencies and in the
      // Host's registered bundle list; this rerun only reconciles service state.
      dependencies: { '@dsh-enhanced/lark-channel': '0.0.0' },
      dsh: { profile: { bundles: ['@dsh-enhanced/lark-channel'] } },
    }))
    if (installer === npmInstaller) {
      await writeFile(join(dshHome, 'profiles', profile, 'pnpm-workspace.yaml'),
        'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    }
    const result = runInstaller(installer, [
      '--scenario', 'lark', '--profile', profile, '--yes', '--model', 'skip', '--model-route', 'skip', ...extra,
    ], dshHome, 'Darwin', {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      FAKE_BIN: fakeBin,
      FIXTURE_REAL_NODE: process.execPath,
      FIXTURE_PROFILE: profile,
      INSTALL_LOG: logPath,
      REGISTERED: registered,
      SETUP_ONCE: join(root, 'setup-once'),
      REGISTER_MODE: mode,
    })
    const log = await readFile(logPath, 'utf8')
    const optedOut = extra.length > 0
    const failed = ['failed', 'invisible', 'foreign', 'inactive'].includes(mode)
    expect(result.status, result.stderr).toBe(failed ? 1 : 0)
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    const calls = log.split('\n').filter(line => line.startsWith('lark-setup '))
    expect(calls).toHaveLength(optedOut ? 0 : ['registered', 'foreign', 'inactive'].includes(mode) ? 1 : 2)
    expect(calls.every(line => line === `lark-setup --profile ${profile} --install-service`)).toBe(true)
    if (optedOut) {
      expect(log).not.toContain('launchctl')
      expect(log).not.toContain('lark-service')
    } else if (failed) {
      expect(result.stdout).not.toContain('安装流程完成')
      expect(result.stderr).toContain(mode === 'failed' ? 'bootstrap denied' : mode === 'foreign'
        ? 'another installation' : mode === 'inactive' ? '未运行或归属无法确认' : '仍不可见')
    } else {
      expect(result.stdout).toContain('doctor：profile、channel 与常驻服务均已通过检查')
      expect(log.trim().split('\n').at(-1)).toBe(`lark-service running ${profile}`)
      if (mode === 'missing') expect(result.stdout).toContain('launchd 注册已完成')
      else expect(result.stdout).not.toContain('正在自动注册')
    }
  })

  test.each([
    ['Linux', 'supervised'],
    ['Darwin', 'supervised'],
  ])('recognizes a home-layer Lark binding as the effective profile binding on %s', async (platform, scenario) => {
    const dshHome = await temporaryDshHome()
    await writeFile(join(dshHome, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')

    const result = runInstaller(localInstaller, ['--dry-run', '--yes'], dshHome, platform)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`部署场景：${scenario}`)
    expect(result.stdout).toContain('飞书处理：保留当前应用配置')
    expect(result.stdout).toContain('检测到已有启用的 Lark channel；跳过临时 Host')
  })

  test('a profile-layer Lark disable overrides a configured home layer', async () => {
    const dshHome = await temporaryDshHome()
    const profilePatch = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await mkdir(dirname(profilePatch), { recursive: true })
    await writeFile(join(dshHome, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')
    await writeFile(profilePatch, `- id: dsh-enhanced-lark-channel
  disabled: true
`, 'utf8')

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_effective_lark_is_configured "$2" "$3"',
      'installer-test', installerLibrary, profilePatch, join(dshHome, 'cordis.patch.yml'),
    ], { encoding: 'utf8' })

    expect(result.status).toBe(1)
  })

  test('fresh configure mode preserves Agent tool reachability unless it is explicitly authorized', async () => {
    const dshHome = await temporaryDshHome()

    // The trailing assertions describe the Linux systemd preflight, so pin the
    // platform rather than depending on the host running this suite.
    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'configure'], dshHome, 'Linux')

    expect(result.status, result.stderr).toBe(0)
    const larkSetup = join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')
    const setupCommands = result.stdout
      .split('\n')
      .filter(line => line.includes('dsh-lark-setup'))
    expect(setupCommands).toEqual([
      `  $ ${larkSetup} --profile web`,
    ])
    expect(result.stdout).toContain('将在飞书授权前验证 user manager')
    expect(result.stdout).toContain('常驻服务与 Linux logout persistence')
  })

  test('Linux service preflight enables lingering without sudo before checking the user manager', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const lingerState = join(root, 'linger-enabled')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'id'), `#!/bin/bash
printf 'id %s\n' "$*" >> "$COMMAND_LOG"
printf '424242\n'
`)
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then
  if [[ -f "$LINGER_STATE" ]]; then printf 'yes\n'; else printf 'no\n'; fi
  exit 0
fi
if [[ "\${1:-}" == '--no-ask-password' && "\${2:-}" == 'enable-linger' ]]; then
  touch "$LINGER_STATE"
  exit 0
fi
exit 2
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_prepare_linux_resident_service 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        LINGER_STATE: lingerState,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('已为当前用户启用 logout persistence')
    expect(result.stdout).toContain('user manager 与 logout persistence 已就绪')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain(`loginctl show-user ${process.geteuid?.() ?? process.getuid?.()}`)
    expect(log).toContain('loginctl --no-ask-password enable-linger')
    expect(log).toContain('systemctl --user show-environment')
    expect(log).not.toContain('sudo')
    expect(log).not.toContain('id -u')
  })

  test('Linux service preflight stops before OAuth when lingering needs explicit administrator approval', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then printf 'no\n'; exit 0; fi
exit 1
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_prepare_linux_resident_service 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sudo loginctl enable-linger "$(id -u)"')
    expect(result.stderr).toContain('尚未开始飞书授权')
    const log = await readFile(commandLog, 'utf8')
    expect(log).not.toContain('systemctl')
  })

  test('interactive Linux preflight explains and runs exactly one fixed sudo action after confirmation', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const lingerState = join(root, 'linger-enabled')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then
  if [[ -f "$LINGER_STATE" ]]; then printf 'yes\n'; else printf 'no\n'; fi
  exit 0
fi
if [[ "\${1:-}" == '--no-ask-password' ]]; then exit 1; fi
if [[ "\${1:-}" == 'enable-linger' ]]; then touch "$LINGER_STATE"; exit 0; fi
exit 2
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)
    await writeExecutable(join(fakeBin, 'sudo'), `#!/bin/bash
printf 'sudo %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == '--' ]]; then shift; fi
"$@"
`)

    const result = spawnSync('/bin/bash', [
      '-c', `source "$1"
dsh_enhanced_trusted_system_command() { printf '%s/%s\\n' "$FAKE_BIN" "$1"; }
dsh_enhanced_prepare_linux_resident_service 0 force`,
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      input: '\n',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        LINGER_STATE: lingerState,
        FAKE_BIN: fakeBin,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('唯一的提权动作')
    expect(result.stderr).toContain('现在通过 sudo 启用？[Y/n]')
    expect(result.stdout).toContain('密码由 sudo 直接读取，不会进入安装器')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain(`sudo -- ${join(fakeBin, 'loginctl')} enable-linger`)
    expect(log.match(/^sudo /gmu)).toHaveLength(1)
    expect(log).toContain('systemctl --user show-environment')
  })

  test('requires explicit confirmation before planning a danger-full-access default', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--permission', 'danger-full-access',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--confirm-dangerous-full-access')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('prints the bounded headless model route check only when requested', async () => {
    const dshHome = await temporaryDshHome()
    // Pin a non-agent default for this dry-run; the builder image has no global dsh.
    await writeFile(join(dshHome, 'settings.yaml'),
      'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-chat\n', 'utf8')

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-route', 'verify',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("dsh --profile headless Reply\\ with\\ exactly\\ DSH_ROUTE_READY")
  })

  test('an agent-route default verifies structurally instead of a headless model call', async () => {
    const dshHome = await temporaryDshHome()
    const fakeBin = join(dshHome, 'fake-bin')
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), '#!/bin/bash\nexit 1\n')
    // The runtime resolves the settings.yaml user-layer selection, which is what
    // the verifier reads; a real run would have just written it.
    await writeFile(join(dshHome, 'settings.yaml'),
      'agent-default-model:\n  provider: traex-agent\n  model: default\n', 'utf8')

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-route', 'verify',
    ], dshHome, undefined, { PATH: `${fakeBin}:${pathWithoutTraex}` })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('agent route traex-agent 不发送模型请求')
    expect(result.stdout).toContain('校验 profile web 已注册适配器并检查本机登录')
    // No headless model call is planned for an agent route.
    expect(result.stdout).not.toContain('DSH_ROUTE_READY')
  })

  test('the effective-default reader returns the settings.yaml user-layer provider', async () => {
    const dshHome = await temporaryDshHome()
    await writeFile(join(dshHome, 'settings.yaml'),
      'ui-theme:\n  preference: dark\nagent-default-model:\n  provider: traex-agent\n  model: default\nllm-pi-ai:\n  providers: {}\n', 'utf8')

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_effective_default_provider "$2"', 'installer-test', installerLibrary, dshHome,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('traex-agent')
  })

  test('the effective-default reader also parses a flow-style settings document', async () => {
    // dsh-model-setup writes block style, but a hand-edited or legacy file may be
    // flow style; the reader must still resolve the provider so agent-route
    // verification does not fall back to a headless model call.
    const dshHome = await temporaryDshHome()
    const read = async (document: string): Promise<string> => {
      await writeFile(join(dshHome, 'settings.yaml'), document, 'utf8')
      const result = spawnSync('/bin/bash', [
        '-c', 'source "$1"; dsh_enhanced_effective_default_provider "$2"', 'installer-test', installerLibrary, dshHome,
      ], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      return result.stdout.trim()
    }

    expect(await read('{ agent-default-model: { provider: traex-agent, model: default } }\n')).toBe('traex-agent')
    expect(await read('{ ui-theme: { preference: dark }, agent-default-model: { provider: custom-gateway, model: glm5.2 } }\n')).toBe('custom-gateway')
    expect(await read('ui-theme:\n  preference: dark\n')).toBe('')
  })

  test('a fresh install then read resolves the agent-route provider end to end', async () => {
    // A fresh profile writes its own default and route without creating a
    // legacy settings.yaml layer that could override other profiles.
    const dshHome = await temporaryDshHome()
    const fakeBin = join(dshHome, 'fake-bin')
    await mkdir(fakeBin, { recursive: true })
    await nativeModelSetupHost(dshHome, fakeBin)
    const setupBin = join(repoRoot, 'plugins', 'personal-assistant', 'bin', 'dsh-model-setup.js')
    const write = spawnSync(process.execPath, [
      setupBin, '--dsh-home', dshHome, '--profile', 'web', '--provider', 'traex-agent', '--enable-in-profile', 'web',
    ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NODE_BIN: process.execPath,
      MODEL_SETUP_SOURCE: join(repoRoot, 'plugins', 'assistant-policy', 'src', 'model-setup.ts') } })
    expect(write.status, write.stderr).toBe(0)
    const profilePatch = await readFile(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(profilePatch).toContain('id: agent-default-model')
    expect(profilePatch).toContain('provider: traex-agent')
    expect(profilePatch).toContain('id: dsh-enhanced-traex-acp-provider')
    expect(profilePatch).toContain('enabled: true')
    expect(existsSync(join(dshHome, 'settings.yaml'))).toBe(false)

    const read = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_effective_default_provider "$2" web', 'installer-test', installerLibrary, dshHome,
    ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NODE_BIN: process.execPath,
      MODEL_SETUP_SOURCE: join(repoRoot, 'plugins', 'assistant-policy', 'src', 'model-setup.ts') } })
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout.trim()).toBe('traex-agent')
  })

  test('non-interactive default keeps the composed model without configuring a route', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('模型配置：本次跳过；使用 profile 已组合的默认模型。')
    expect(result.stdout).not.toContain('dsh-model-setup')
  })

  test('resolves dsh-model-setup from the pnpm shim, then falls back to a node-run package bin', async () => {
    const dshHome = await temporaryDshHome()
    const base = join(dshHome, 'profiles', 'web', 'node_modules')
    const binDir = join(base, '.bin')
    const paScript = join(base, '@dsh-enhanced', 'personal-assistant', 'bin', 'dsh-model-setup.js')
    const apScript = join(base, '@dsh-enhanced', 'assistant-policy', 'bin', 'dsh-model-setup.js')

    const resolve = (): { status: number | null; stdout: string } => spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_resolve_model_setup web "$2"', 'installer-test', installerLibrary, dshHome,
    ], { encoding: 'utf8' })

    // No launcher anywhere -> non-zero, no output.
    const none = resolve()
    expect(none.status).not.toBe(0)
    expect(none.stdout).toBe('')

    // Package bin present but no shim -> node fallback (prefers personal-assistant).
    await mkdir(join(base, '@dsh-enhanced', 'assistant-policy', 'bin'), { recursive: true })
    await writeFile(apScript, '// stub\n', 'utf8')
    const apOnly = resolve()
    expect(apOnly.status, apOnly.stdout).toBe(0)
    expect(apOnly.stdout).toBe(`node\n${apScript}\n`)

    await mkdir(join(base, '@dsh-enhanced', 'personal-assistant', 'bin'), { recursive: true })
    await writeFile(paScript, '// stub\n', 'utf8')
    const preferPa = resolve()
    expect(preferPa.stdout).toBe(`node\n${paScript}\n`)

    // An executable shim wins over the package bins.
    await mkdir(binDir, { recursive: true })
    await writeExecutable(join(binDir, 'dsh-model-setup'), '#!/bin/bash\nexit 0\n')
    const withShim = resolve()
    expect(withShim.stdout).toBe(`${join(binDir, 'dsh-model-setup')}\n`)
  })

  test('configuring deepseek-official plans an env-only key store into settings and credentials', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official', '--model-name', 'deepseek-v4-flash',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('模型配置：provider=deepseek-official model=deepseek-v4-flash')
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-model-setup')} `
      + `--dsh-home ${dshHome} --profile web --provider deepseek-official --model deepseek-v4-flash`,
    )
    // The key is never an argument; without one in the environment the plan
    // still writes the route and names the credential reference to set later.
    expect(result.stdout).toContain('未检测到 API Key，稍后请设置 DEEPSEEK_API_KEY')
    expect(result.stdout).not.toContain('--store-key')
  })

  test('an available key env var upgrades the deepseek plan to store the credential', async () => {
    const dshHome = await temporaryDshHome()

    const result = spawnSync('/bin/bash', [localInstaller,
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DSH_HOME: dshHome, DSH_ENHANCED_MODEL_API_KEY: 'plat-secret' },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('把环境中的 API Key 存入 .credentials.yaml')
    expect(result.stdout).toContain('--provider deepseek-official --store-key')
  })

  test('a custom gateway route plans llm-pi-ai transport fields', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'custom-gateway', '--model-name', 'glm5.2',
      '--model-base-url', 'https://custom-gateway.example/v1', '--model-api', 'openai-completions',
      '--model-display-name', 'Custom Gateway',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      '--provider custom-gateway --model glm5.2 --base-url https://custom-gateway.example/v1'
      + ' --api openai-completions --display-name Custom\\ Gateway',
    )
  })

  test('rejects a custom gateway route without a base URL and deepseek with transport fields', async () => {
    const dshHome = await temporaryDshHome()

    const missingBaseUrl = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'custom-gateway', '--model-name', 'glm5.2',
    ], dshHome)
    expect(missingBaseUrl.status).toBe(2)
    expect(missingBaseUrl.stderr).toContain('自定义模型 provider 需要 --model-base-url')
    expect(missingBaseUrl.stdout).not.toContain('dsh plugin')

    const misplacedFields = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official', '--model-base-url', 'https://x/v1',
    ], dshHome)
    expect(misplacedFields.status).toBe(2)
    expect(misplacedFields.stderr).toContain('仅适用于自定义 provider')
    expect(misplacedFields.stdout).not.toContain('dsh plugin')
  })

  test('non-interactive configure without a provider guides the owner to the model flags', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model', 'configure',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('非交互配置模型需要 --model-provider')
  })

  test('restarts the resident service after (re)configuring the model on a managed profile', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    // Keeping the existing Feishu bot leaves a managed resident service, so a
    // model (re)configuration must restart it to load the new default/route.
    // The restart is delegated to the platform's own supervisor, so pin the
    // detected platform and assert both real branches.
    const linux = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'keep', '--model-provider', 'deepseek-official', '--model-name', 'deepseek-v4-flash',
    ], dshHome, 'Linux')

    expect(linux.status, linux.stderr).toBe(0)
    expect(linux.stdout).toContain('常驻服务：将重启以加载新模型配置。')
    expect(linux.stdout).toContain('systemctl --user restart dsh-profile-web.service')

    const darwin = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'keep', '--model-provider', 'deepseek-official', '--model-name', 'deepseek-v4-flash',
    ], dshHome, 'Darwin')

    expect(darwin.status, darwin.stderr).toBe(0)
    expect(darwin.stdout).toContain('常驻服务：将重启以加载新模型配置。')
    expect(darwin.stdout).toContain('launchctl kickstart -k')
  })

  test('does not restart a service when the model step is skipped or no service is managed', async () => {
    const skipHome = await temporaryDshHome()
    const skipModel = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model', 'skip',
    ], skipHome)
    expect(skipModel.status, skipModel.stderr).toBe(0)
    expect(skipModel.stdout).not.toContain('常驻服务：将重启以加载新模型配置。')

    // core scenario configures a model but manages no channel/service.
    const coreHome = await temporaryDshHome()
    const core = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official',
    ], coreHome)
    expect(core.status, core.stderr).toBe(0)
    expect(core.stdout).not.toContain('常驻服务：将重启以加载新模型配置。')
  })

  test('model menu writes UI separately from its machine-readable selection', () => {
    const configured = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_model_mode 1', 'installer-test', installerLibrary,
    ], { encoding: 'utf8', input: '2\n' })
    expect(configured.status, configured.stderr).toBe(0)
    expect(configured.stdout).toBe('configure')
    expect(configured.stderr).toContain('检测到当前 profile 已能解析默认模型')

    const unconfigured = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_model_mode 0', 'installer-test', installerLibrary,
    ], { encoding: 'utf8', input: '\n' })
    expect(unconfigured.status, unconfigured.stderr).toBe(0)
    expect(unconfigured.stdout).toBe('configure')
    expect(unconfigured.stderr).toContain('尚未配置可用的默认模型')
  })

  test('selecting the local TraeX route plans bundle install, default selection, and profile enable', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'traex-agent',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    // The provider bundle is pulled into the top-level install set...
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
    // ...and the default-model write enables the route in this profile's patch.
    expect(result.stdout).toContain('模型配置：provider=traex-agent')
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-model-setup')} `
      + `--dsh-home ${dshHome} --profile web --provider traex-agent --enable-in-profile web`,
    )
    // Agent routes never touch an API key.
    expect(result.stdout).not.toContain('--store-key')
    expect(result.stdout).not.toContain('存入 .credentials.yaml')
    expect(result.stdout).toContain('无需 API Key')
    expect(result.stdout).toContain('本轮已配置 TraeX，正在执行免额度的适配器与登录校验')
    expect(result.stdout).toContain('agent route traex-agent 不发送模型请求')
    expect(result.stdout).not.toContain('DSH_ROUTE_READY')
  })

  test('rejects gateway transport fields on the TraeX agent route', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'traex-agent', '--model-base-url', 'https://x/v1',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('不适用于本机 agent route traex-agent')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('the model prompt offers TraeX only when a local traex command is present', () => {
    const scriptWithTraex = 'export PATH="$2:$PATH"; source "$1"; '
      + 'dsh_enhanced_prompt_model_route p m b a d >/dev/null; printf "provider=%s" "$p"'
    const fakeBin = join(tmpdir(), `dsh-fake-traex-${Date.now()}`)

    return (async () => {
      await mkdir(fakeBin, { recursive: true })
      await writeExecutable(join(fakeBin, 'traex'), '#!/bin/bash\nexit 0\n')

      const withTraex = spawnSync('/bin/bash', ['-c', scriptWithTraex, 'installer-test', installerLibrary, fakeBin], {
        encoding: 'utf8', input: '3\n',
      })
      expect(withTraex.status, withTraex.stderr).toBe(0)
      expect(withTraex.stderr).toContain('本机 TraeX')
      expect(withTraex.stdout).toBe('provider=traex-agent')

      // Without a traex command on PATH, option 3 is not offered and is invalid.
      const withoutTraex = spawnSync('/bin/bash', [
        '-c', 'export PATH="/nonexistent-only"; source "$1"; dsh_enhanced_prompt_model_route p m b a d; printf "rc=%s" "$?"',
        'installer-test', installerLibrary,
      ], { encoding: 'utf8', input: '3\n' })
      expect(withoutTraex.stderr).not.toContain('本机 TraeX')

      await rm(fakeBin, { recursive: true, force: true })
    })()
  })

  test('auto-discovers trae-cli as an executable path and enables its profile route and default', async () => {
    const f = await autoTraexSetupFixture('trae-cli', true)
    const detected = spawnSync('/bin/bash', ['-c', 'PATH="$2"; export PATH; source "$1"; dsh_enhanced_detect_traex_command',
      'installer-test', installerLibrary, f.environment.PATH], { encoding: 'utf8', env: f.environment })
    expect(detected.status, detected.stderr).toBe(0)
    expect(detected.stdout).toBe(f.commandPath)
    const result = spawnSync('/bin/bash', [
      '-c', 'PATH="$3"; export PATH; source "$1"; detected="$(dsh_enhanced_detect_traex_command)"; dsh_enhanced_apply_auto_traex web "$2" "$detected" 1 0',
      'installer-test', installerLibrary, f.dshHome, f.environment.PATH,
    ], { encoding: 'utf8', env: f.environment })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`TraeX 自动接入：${f.commandPath}`)
    const patch = await readFile(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: dsh-enhanced-traex-acp-provider')
    expect(patch).toContain('enabled: true')
    expect(patch).toContain(`command: ${f.commandPath}`)
    expect(patch).toContain('id: agent-default-model')
    expect(patch).toContain('provider: traex-agent')
    expect(existsSync(join(f.dshHome, 'settings.yaml'))).toBe(false)
  })

  test('auto TraeX postflight resolves Policy YAML through isolated personal-assistant dependencies', async () => {
    const f = await autoTraexSetupFixture('trae-cli', true, 'nested')
    const profileModules = join(f.dshHome, 'profiles', 'web', 'node_modules')
    expect(existsSync(join(profileModules, '@dsh-enhanced', 'assistant-policy'))).toBe(false)
    expect(existsSync(join(profileModules, 'yaml'))).toBe(false)
    const positive = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_apply_auto_traex web "$2" "$3" 1 0',
      'installer-test', installerLibrary, f.dshHome, f.commandPath,
    ], { encoding: 'utf8', env: f.environment })
    expect(positive.status, positive.stderr).toBe(0)
    const patch = await readFile(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('enabled: true')
    expect(patch).toContain(`command: ${f.commandPath}`)

    const composedPath = join(f.dshHome, 'disabled-composed.yml')
    await writeFile(composedPath, `- id: dsh-enhanced-traex-acp-provider
  name: '@dsh-enhanced/traex-acp-provider'
  disabled: true
  config:
    enabled: true
    command: ${f.commandPath}
`)
    const negative = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_probe_auto_traex_route web "$2" "$3"',
      'installer-test', installerLibrary, f.dshHome, composedPath,
    ], { encoding: 'utf8', env: f.environment })
    expect(negative.status).not.toBe(0)
    expect(negative.stderr).toContain('composed TraeX route is not active')
  })

  test('TraeX postflight resolves only an omitted command from the installed provider schema', async () => {
    const f = await autoTraexSetupFixture('traex', true)
    const patchPath = join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml')
    const composedPath = join(f.dshHome, 'composed-traex.yml')
    const row = (command: string, options: { name?: string; disabled?: boolean } = {}) =>
      `- id: dsh-enhanced-traex-acp-provider\n`
      + (options.name === undefined ? '' : `  name: '${options.name}'\n`)
      + (options.disabled ? '  disabled: true\n' : '')
      + `  config:\n    enabled: true\n${command}`
    const probe = (withComposed: boolean) => spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_probe_auto_traex_route web "$2" "$3"',
      'installer-test', installerLibrary, f.dshHome, withComposed ? composedPath : '',
    ], { encoding: 'utf8', env: f.environment })

    await writeFile(patchPath, row(''))
    await writeFile(composedPath, row('', { name: '@dsh-enhanced/traex-acp-provider' }))
    const defaulted = probe(true)
    expect(defaulted.status, defaulted.stderr).toBe(0)
    expect(defaulted.stdout).toBe('traex')
    const profileOnly = probe(false)
    expect(profileOnly.status, profileOnly.stderr).toBe(0)
    expect(profileOnly.stdout).toBe('traex')

    await writeFile(patchPath, row('    command: /custom/traex\n'))
    await writeFile(composedPath, row('    command: /custom/traex\n', { name: '@dsh-enhanced/traex-acp-provider' }))
    const custom = probe(true)
    expect(custom.status, custom.stderr).toBe(0)
    expect(custom.stdout).toBe('/custom/traex')

    for (const invalid of ["    command: ''\n", '    command: 42\n', '    command: null\n']) {
      await writeFile(patchPath, row(invalid))
      const rejected = probe(false)
      expect(rejected.status, invalid).not.toBe(0)
      expect(rejected.stderr).toContain('TraeX route is not enabled with a nonempty command')
      expect(rejected.stdout).toBe('')
    }
    await writeFile(patchPath, row('', { disabled: true }))
    expect(probe(false).status).not.toBe(0)
    await writeFile(patchPath, row('', { name: '@example/not-traex' }))
    expect(probe(false).status).not.toBe(0)

    await writeFile(patchPath, row(''))
    for (const overridden of [
      row('', { name: '@example/not-traex' }),
      row('', { name: '@dsh-enhanced/traex-acp-provider', disabled: true }),
      row('    command: /other/traex\n', { name: '@dsh-enhanced/traex-acp-provider' }),
    ]) {
      await writeFile(composedPath, overridden)
      const rejected = probe(true)
      expect(rejected.status, rejected.stderr).not.toBe(0)
      expect(rejected.stdout).toBe('')
    }
  })

  test('TraeX postflight reads the installed schema when the plugin entrypoint fails', async () => {
    const f = await autoTraexSetupFixture('traex', true)
    const providerDir = join(f.dshHome, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'traex-acp-provider')
    await rm(providerDir)
    await mkdir(join(providerDir, 'lib'), { recursive: true })
    await writeFile(join(providerDir, 'package.json'), JSON.stringify({
      name: '@dsh-enhanced/traex-acp-provider', type: 'module',
      exports: { '.': './lib/index.js', './package.json': './package.json' },
    }))
    await writeFile(join(providerDir, 'lib', 'index.js'), "throw new Error('fixture plugin entrypoint must not load')\n")
    await symlink(join(repoRoot, 'plugins', 'traex-acp-provider', 'lib', 'config.js'),
      join(providerDir, 'lib', 'config.js'), 'file')
    const brokenEntry = spawnSync(process.execPath, [join(providerDir, 'lib', 'index.js')], { encoding: 'utf8' })
    expect(brokenEntry.status).not.toBe(0)
    expect(brokenEntry.stderr).toContain('fixture plugin entrypoint must not load')

    await writeFile(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'),
      '- id: dsh-enhanced-traex-acp-provider\n  config:\n    enabled: true\n')
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_probe_auto_traex_route web "$2"',
      'installer-test', installerLibrary, f.dshHome,
    ], { encoding: 'utf8', env: f.environment })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('traex')
    expect(result.stderr).not.toContain('fixture plugin entrypoint must not load')
  })

  test('auto-enabling TraeX preserves an explicit default and operator command/cwd across repeat installs', async () => {
    const f = await autoTraexSetupFixture('traex', true)
    const patchPath = join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml')
    const settingsPath = join(f.dshHome, 'settings.yaml')
    const originalSettings = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    await writeFile(settingsPath, originalSettings)
    await writeFile(patchPath, "- id: dsh-enhanced-traex-acp-provider\n  config:\n    enabled: false\n    command: /custom/traex\n    cwd: !!js dshHomePath('custom-workspace')\n")
    const invoke = () => spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_apply_auto_traex web "$2" "$3" 1 0',
      'installer-test', installerLibrary, f.dshHome, f.commandPath,
    ], { encoding: 'utf8', env: f.environment })
    const first = invoke()
    expect(first.status, first.stderr).toBe(0)
    const afterFirst = await readFile(patchPath, 'utf8')
    const second = invoke()
    expect(second.status, second.stderr).toBe(0)
    expect(await readFile(patchPath, 'utf8')).toBe(afterFirst)
    expect(afterFirst).toContain('enabled: true')
    expect(afterFirst).toContain('command: /custom/traex')
    expect(afterFirst).toContain("cwd: !!js dshHomePath('custom-workspace')")
    expect(afterFirst).not.toContain('id: agent-default-model')
    expect(await readFile(settingsPath, 'utf8')).toBe(originalSettings)
  })

  test('auto-enabling TraeX preserves an explicit profile-local default without creating settings.yaml', async () => {
    const fixture = await autoTraexSetupFixture('traex', true)
    const patchPath = join(fixture.dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await writeFile(patchPath, '- id: agent-default-model\n  config:\n    provider: custom-gateway\n    model: glm5.2\n')

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_apply_auto_traex web "$2" "$3" 1 0',
      'installer-test', installerLibrary, fixture.dshHome, fixture.commandPath,
    ], { encoding: 'utf8', env: fixture.environment })

    expect(result.status, result.stderr).toBe(0)
    const patch = await readFile(patchPath, 'utf8')
    expect(patch.match(/id: agent-default-model/gu)).toHaveLength(1)
    expect(patch).toContain('provider: custom-gateway')
    expect(patch).toContain('model: glm5.2')
    expect(patch).toContain('id: dsh-enhanced-traex-acp-provider')
    expect(patch).toContain('enabled: true')
    expect(existsSync(join(fixture.dshHome, 'settings.yaml'))).toBe(false)
  })

  test('auto-enabling TraeX does not use a discovered login for an existing custom command', async () => {
    const f = await autoTraexSetupFixture('traex', true)
    const patchPath = join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await writeFile(patchPath, '- id: dsh-enhanced-traex-acp-provider\n  config:\n    command: /custom/traex\n')
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_apply_auto_traex web "$2" "$3" 1 0',
      'installer-test', installerLibrary, f.dshHome, f.commandPath,
    ], { encoding: 'utf8', env: f.environment })
    expect(result.status, result.stderr).toBe(0)
    const patch = await readFile(patchPath, 'utf8')
    expect(patch).toContain('enabled: true')
    expect(patch).toContain('command: /custom/traex')
    expect(patch).not.toContain('id: agent-default-model')
    expect(result.stdout).toContain('请运行：/custom/traex login')
    expect(result.stdout).not.toContain('本机已登录')
  })

  test('auto TraeX postflight rejects a disabled row and leaves concurrent settings changes intact', async () => {
    const f = await autoTraexSetupFixture('traex', true)
    const patchPath = join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml')
    const settingsPath = join(f.dshHome, 'settings.yaml')
    const originalPatch = '- id: existing-owner-row\n  config: { enabled: true }\n'
    await writeFile(patchPath, originalPatch)
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_apply_auto_traex web "$2" "$3" 1 0',
      'installer-test', installerLibrary, f.dshHome, f.commandPath,
    ], { encoding: 'utf8', env: { ...f.environment, DSH_FAKE_CONCURRENT_STATE: '1' } })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('profile/composed route 未确认启用')
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    expect(await readFile(settingsPath, 'utf8')).toBe('agent-default-model:\n  provider: concurrent-owner\n')
  })

  test('auto TraeX rejects a disabled effective composed row even when profile config is enabled', async () => {
    const f = await autoTraexSetupFixture('traex', true)
    const patchPath = join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml')
    const originalPatch = '- id: existing-owner-row\n  config: { enabled: true }\n'
    await writeFile(patchPath, originalPatch)
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_apply_auto_traex web "$2" "$3" 1 0',
      'installer-test', installerLibrary, f.dshHome, f.commandPath,
    ], { encoding: 'utf8', env: { ...f.environment, DSH_FAKE_COMPOSED_DISABLED: '1' } })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('composed TraeX route is not active')
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
  })

  test.each([
    { label: 'misleading substring', response: "printf '%s\\n' 'Not Logged in using Trae'", ready: false },
    { label: 'stdout prefix noise', response: "printf '%s\\n' 'notice' 'Logged in using Trae'", ready: false },
    { label: 'stderr noise', response: "printf '%s\\n' 'Logged in using Trae'; printf '%s\\n' 'notice' >&2", ready: false },
    { label: 'exact stderr', response: "printf '%s\\n' 'Logged in using Trae' >&2", ready: true },
  ])('auto TraeX accepts only runtime-exact login status: $label', async ({ response, ready }) => {
    const f = await autoTraexSetupFixture('traex', false)
    await writeExecutable(f.commandPath, `#!/bin/bash
if [[ "$*" == 'login status' ]]; then
  ${response}
  exit 0
fi
exit 7
`)
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_apply_auto_traex web "$2" "$3" 1 0',
      'installer-test', installerLibrary, f.dshHome, f.commandPath,
    ], { encoding: 'utf8', env: f.environment })
    expect(result.status, result.stderr).toBe(0)
    const patch = await readFile(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(patch.includes('id: agent-default-model')).toBe(ready)
    expect(result.stdout.includes('本机已登录')).toBe(ready)
  }, 60_000)

  test.each([{ loggedIn: false, defaultCandidate: '1' }, { loggedIn: true, defaultCandidate: '0' }])(
    'auto-enables TraeX without changing defaults when loggedIn=$loggedIn candidate=$defaultCandidate',
    async ({ loggedIn, defaultCandidate }) => {
      const f = await autoTraexSetupFixture('traex', loggedIn)
      const result = spawnSync('/bin/bash', [
        '-c', 'source "$1"; dsh_enhanced_apply_auto_traex web "$2" "$3" "$4" 0',
        'installer-test', installerLibrary, f.dshHome, f.commandPath, defaultCandidate,
      ], { encoding: 'utf8', env: f.environment })
      expect(result.status, result.stderr).toBe(0)
      const patch = await readFile(join(f.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain('enabled: true')
      expect(patch).not.toContain('id: agent-default-model')
      expect(existsSync(join(f.dshHome, 'settings.yaml'))).toBe(false)
      if (!loggedIn) {
        expect(result.stdout).toContain(`请运行：${f.commandPath} login`)
        expect(result.stdout).not.toContain('本机已登录')
      }
    },
  )

  test('auto-discovered TraeX joins the dry-run cohort before profile writes; explicit model skip only skips default', async () => {
    const f = await autoTraexSetupFixture('trae-cli', true)
    const result = runInstaller(npmInstaller, [
      '--dry-run', '--scenario', 'core', '--model', 'skip', '--plugin-version', '0.1.48',
    ], f.dshHome, undefined, { PATH: f.environment.PATH })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('@dsh-enhanced/traex-acp-provider@0.1.48')
    expect(result.stdout.indexOf('npm cohort（dry-run）')).toBeLessThan(result.stdout.indexOf('dsh plugin --profile'))
    expect(result.stdout).toContain(`--agent-command ${f.commandPath} --enable-only`)
    expect(result.stdout).not.toContain('--default-if-absent')
    expect(result.stdout).not.toContain('请选择')
  })

  test('explicit configure mode reruns onboarding and can avoid installing a service', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'configure', '--no-service',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('飞书处理：选择已有应用或创建新应用，并覆盖当前 channel 配置')
    expect(result.stdout).toContain('dsh-lark-setup --profile web --no-service')
  })

  test('Feishu menu writes UI separately from its machine-readable selection', () => {
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_lark_mode 1', 'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      input: '2\n',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('configure')
    expect(result.stderr).toContain('检测到当前 profile 已启用飞书 Bot')
  })

  test('rejects unsafe profile names before planning any installation', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--profile', '../web',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('profile 名称不合法')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('restart command rebuilds and kickstarts web without installation or onboarding', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart([], dshHome, 'darwin')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm build')
    expect(result.stdout).toContain('launchctl kickstart -k gui/')
    expect(result.stdout).toContain('/ai.deepseek.dsh.profile.web')
    expect(result.stdout).not.toContain('dsh plugin')
    expect(result.stdout).not.toContain('dsh-lark-setup')
  })

  test('restart command accepts the profile as its only optional argument', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart(['personal-web'], dshHome, 'darwin')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm build')
    expect(result.stdout).toContain('/ai.deepseek.dsh.profile.personal-web')
  })

  test('restart command rejects more than one argument', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart(['web', 'extra'], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('只接受一个可选的 profile 参数')
  })

  test('restart command uses systemd on Linux and Task Scheduler on Windows', async () => {
    const dshHome = await temporaryDshHome()

    const linux = runRestart(['web'], dshHome, 'linux')
    expect(linux.status, linux.stderr).toBe(0)
    expect(linux.stdout).toContain('systemctl --user restart dsh-profile-web.service')

    const windows = runRestart(['web'], dshHome, 'windows')
    expect(windows.status, windows.stderr).toBe(0)
    expect(windows.stdout).toContain('schtasks.exe /End /TN DSH\\ profile\\ web')
    expect(windows.stdout).toContain('schtasks.exe /Run /TN DSH\\ profile\\ web')
  })
})


describe.skipIf(process.platform !== 'linux')('pre-owner native base entry', () => {
  test.each([false, true])('upgrades originalNative=%s with real base identities and a distinct formal resource proof', async originalNative => {
    const f = await nativePreOwnerLifecycleFixture({ originalNative })
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade')
    expect(result.status, result.stderr).toBe(0)
    const family = await f.primitive.inspectLinuxRsiNativeBaseAt({ logicalHome: f.dshHome, physicalHome: f.dshHome, profile: 'web' })
    expect(family.runtime.sourceCommit).toBe('2'.repeat(40))
    expect(existsSync(join(f.dshHome, 'rsi-builds/web'))).toBe(false)
    const stages = (await f.nativeEvents()).filter(event => event.action === 'staged') as Array<{
      action: string; transactionPresent: boolean; proof: { physicalHome: string; originalBackend: string;
        relocation: { sourceHome: string; elements: Array<{ name: string; ino: number; dev: number }> } }
    }>
    const formal = stages.find(event => event.proof.physicalHome === f.dshHome + '.dsh-enhanced-transaction/staged-home')!
    const preview = stages.find(event => event.proof.physicalHome.includes('.dsh-local-candidate-'))!
    expect(formal).toBeDefined(); expect(preview).toBeDefined()
    expect(preview.transactionPresent).toBe(false); expect(formal.transactionPresent).toBe(true)
    expect(formal.proof.originalBackend).toBe(originalNative ? 'linux-native' : 'docker')
    expect(formal.proof.relocation.sourceHome).toBe(join(f.preparationRoot, 'home'))
    const actual = await lstat(join(f.dshHome, 'rsi-linux-runtimes/web/runtime'))
    expect(formal.proof.relocation.elements.find(item => item.name === 'runtime')).toMatchObject({ ino: actual.ino, dev: actual.dev })
    expect(preview.proof.relocation.elements.find(item => item.name === 'runtime')!.ino).not.toBe(actual.ino)
    expect((await f.nativeEvents()).filter(event => event.action === 'inspect')
      .some(event => String(event.physicalHome).includes('.dsh-local-source-preview-'))).toBe(false)
    const calls = await readLifecycleSystemdLog(f.systemdLog)
    expect(calls.some(call => call.includes('stop'))).toBe(true)
    expect(calls.some(call => call.includes('start'))).toBe(true)
    expect(await readFile(join(f.dshHome, 'sessions/owner-session.jsonl'), 'utf8')).toBe('durable-session')
  }, 60000)

  test.each(['mixed', 'original-inode', 'stage'] as const)('rejects native %s before service mutation', async fault => {
    const f = await nativePreOwnerLifecycleFixture({ originalNative: true })
    if (fault === 'mixed') await mkdir(join(f.dshHome, 'rsi-builds/web'), { recursive: true })
    if (fault === 'original-inode') {
      const path = join(f.dshHome, 'rsi-linux-runtimes/web/bootstrap.json')
      const receipt = JSON.parse(await readFile(path, 'utf8'))
      receipt.runtime.root.ino++
      delete receipt.receiptDigest
      receipt.receiptDigest = createHash('sha256').update(JSON.stringify(receipt)).digest('hex')
      await writeFile(path, JSON.stringify(receipt))
    }
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade', fault === 'stage' ? { nativeResourceFailure: 'stage' } : {})
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.stderr).toMatch(fault === 'mixed' ? /exactly one build backend/u
      : fault === 'original-inode' ? /identity differs/u : /candidate native staging failed/u)
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(call => call.some(arg => ['stop', 'start', 'mask', 'unmask'].includes(arg)))).toBe(false)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']?.activeState).toBe('active')
    expect(existsSync(f.dshHome + '.dsh-enhanced-transaction')).toBe(false)
    expect(await readFile(join(f.dshHome, 'sessions/owner-session.jsonl'), 'utf8')).toBe('durable-session')
  }, 60000)

  test.each(['after-stage', 'after-packages'] as const)('refuses %s resource drift and restores the same original runtime inode', async nativeResourceFailure => {
    const f = await nativePreOwnerLifecycleFixture({ originalNative: true })
    const before = await lstat(join(f.dshHome, 'rsi-linux-runtimes/web/runtime'))
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade', { nativeResourceFailure })
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.stderr).toMatch(/native|runtime|identity|digest/u)
    expect((await f.nativeEvents()).some(event => event.action === 'drift' && event.phase === nativeResourceFailure)).toBe(true)
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(call => call.includes('stop'))).toBe(true)
    const after = await lstat(join(f.dshHome, 'rsi-linux-runtimes/web/runtime'))
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
    expect((await f.primitive.inspectLinuxRsiNativeBaseAt({ logicalHome: f.dshHome, physicalHome: f.dshHome, profile: 'web' })).runtime.sourceCommit).toBe('1'.repeat(40))
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']?.activeState).toBe('active')
  }, 60000)

  test.each([false, true])('recovery authenticates the original inode rather than a copied backup (copy=%s)', async copy => {
    const f = await nativePreOwnerLifecycleFixture({ originalNative: true })
    const before = await lstat(join(f.dshHome, 'rsi-linux-runtimes/web/runtime'))
    const first = runPreOwnerLifecycle(f, 'local-service-upgrade', { killLifecycleAfterOriginalRename: true })
    expect(first.status).not.toBe(0); expect(existsSync(f.dshHome)).toBe(false)
    const backup = f.dshHome + '.dsh-enhanced-transaction/original-home'
    if (copy) {
      const runtime = join(backup, 'rsi-linux-runtimes/web/runtime'), detached = join(f.root, 'detached-runtime')
      await cp(runtime, detached, { recursive: true, verbatimSymlinks: true })
      await rm(runtime, { recursive: true }); await rename(detached, runtime)
      expect((await lstat(runtime)).ino).not.toBe(before.ino)
    }
    const previous = (await readLifecycleSystemdLog(f.systemdLog)).length
    const result = runPreOwnerLifecycle(f, 'local-service-recover')
    const snapshots = (await f.nativeEvents()).filter(event => event.action === 'source-snapshot')
    expect(snapshots.length).toBeGreaterThan(0)
    for (const snapshot of snapshots) {
      expect(snapshot.physicalHome).toBe(backup)
      expect(snapshot.sourceDigest).toBe(snapshot.expectedStateDigest)
    }
    if (copy) {
      expect(result.status, result.stderr).not.toBe(0)
      expect(result.stderr).toMatch(/identity differs/u)
      expect((await readLifecycleSystemdLog(f.systemdLog)).slice(previous).some(call => call.includes('start'))).toBe(false)
      expect(existsSync(f.dshHome)).toBe(false)
    } else {
      expect(result.status, result.stderr).toBe(0)
      const after = await lstat(join(f.dshHome, 'rsi-linux-runtimes/web/runtime'))
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
      await f.primitive.inspectLinuxRsiNativeBaseAt({ logicalHome: f.dshHome, physicalHome: f.dshHome, profile: 'web' })
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']?.activeState).toBe('active')
    }
  }, 90000)

  test('native memory extension preserves existing finite configuration and business counter values', async () => {
    const f = await nativePreOwnerLifecycleFixture({ originalNative: true, memoryExtension: true })
    const configPath = join(f.dshHome, '.lifecycle-dump-config')
    const rows = parse(await readFile(configPath, 'utf8')) as Array<{ id: string; config?: Record<string, unknown> }>
    const assistant = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
    assistant.config = { assistantAutomations: { schedulerEnabled: false, maxModelCalls: 7, maxToolCalls: 3 } }
    await writeFile(configPath, stringify(rows))
    const counter = new DatabaseSync(f.databasePath)
    try { counter.exec('CREATE TABLE finite_counter(maximum INTEGER,spent INTEGER); INSERT INTO finite_counter VALUES (2,1)') } finally { counter.close() }
    const result = runPreOwnerLifecycle(f, 'local-service-upgrade')
    expect(result.status, result.stderr).toBe(0)
    const after = parse(await readFile(configPath, 'utf8')) as Array<{ id: string; config?: Record<string, unknown> }>
    expect(after.find(row => row.id === assistant.id)).toEqual(assistant)
    expect(after.at(-1)).toEqual(rsiMemoryLearningInitialRow)
    const db = new DatabaseSync(f.databasePath, { readOnly: true })
    try { expect(db.prepare('SELECT maximum,spent FROM finite_counter').all()).toEqual([{ maximum: 2, spent: 1 }]) } finally { db.close() }
    // This is a fixture counter, not acceptance of a real Policy owner ledger.
    expect((await f.primitive.inspectLinuxRsiNativeBaseAt({ logicalHome: f.dshHome, physicalHome: f.dshHome, profile: 'web' })).runtime.sourceCommit).toBe('2'.repeat(40))
  }, 60000)
})
