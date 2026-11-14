import { chmod, cp, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { expect } from 'vitest'
import { parse, stringify } from 'yaml'
import { createSystemdUserUnit, systemdServicePaths } from '../../plugins/lark-channel/src/systemd.ts'
import { nativeInstallerHost } from '../native-installer-host-fixture.ts'
import { rsiMemoryLearningInitialRow } from '../../plugins/lark-channel/src/rsi-local-roots-extension.ts'

interface LifecycleFixtureOptions {
  /** Opt in only when the test requires /tmp namespace store remounts. */
  temporaryParent?: string
  readiness?: 'web' | 'host' | 'invalid-host'
  activationFails?: boolean
  effectiveScenario?: 'autonomy' | 'lark' | 'supervised' | 'web'
  managedDependencies?: readonly string[]
  requirePnpmFrozenStore?: boolean
  requirePnpmStore?: boolean
  requirePnpmStoreFd?: boolean
  requirePnpmProfileCwd?: boolean
  systemd?: LifecycleSystemdFixtureOptions
  thirdParty?: boolean
  thirdPartyDependency?: boolean
}

interface LifecycleSystemdUnitOptions {
  active: boolean
  serviceEnvironment?: Record<string, string>
  enabled?: boolean
  dshHome?: string
  dropIn?: 'keyring' | 'unknown' | 'unsafe-keyring'
  fragment?: 'managed' | 'foreign'
  profile: string
  reportedDshHome?: string
  runtimeMasked?: boolean
  workingDirectory?: string
}

interface LifecycleSystemdFixtureOptions {
  units?: readonly LifecycleSystemdUnitOptions[]
}

interface LifecycleRunOptions {
  nativeResourceFailure?: 'stage' | 'after-stage' | 'after-packages'
  candidateFailure?: 'add' | 'fetch' | 'verify' | 'offline' | 'missing-started' | 'missing-done' | 'policy' | 'optional-resolution' | 'offline-optional-resolution' | 'offline-graph-drift' | 'final-graph-drift' | 'external-preparation'
  activationMarker?: string
  canonicalCleanupFails?: boolean
  crashDuringCleanup?: boolean
  crashAfterCleanupMetadata?: boolean
  crashAfterCleanupPrepared?: boolean
  crashAfterCleanupReacceptGuardian?: boolean
  crashAfterCleanupReacceptPending?: boolean
  configAfterActivation?: string
  configAfterUpgrade?: string
  expectedScenario?: 'autonomy' | 'lark' | 'supervised' | 'unsupported' | 'web'
  guardianDisconnectAfterStart?: boolean
  killLifecycleAfterOriginalRename?: boolean
  killLifecycleAfterStopped?: boolean
  npmBlock?: boolean
  npmPeerExternalBin?: string
  npmPrepareFails?: boolean
  metadataWarmupFails?: boolean
  metadataWarmupSkipReason?: 'resolution_failure' | 'unsupported_platform' | 'missing'
  metadataWarmupMissingMirror?: boolean
  metadataMirrorMutationPath?: string
  metadataGraphShrink?: 'replay' | 'both'
  metadataWarmupStderrSkip?: boolean
  metadataWarmupLargeStderr?: boolean
  npmReceiptMissingPolicy?: 'dependencyAliasCheck' | 'resolutionShapeCheck' | 'tarballUrlBinding'
  npmSandboxRegistryDrift?: boolean
  npmSourceMetadataMutation?: boolean
  npmVersion?: string
  npmVerifyFails?: boolean
  localBuildFails?: boolean
  localInstallFails?: boolean
  pnpmStoreMarker?: string
  pnpmfileMustNotRun?: boolean
  requirePnpmProfileCwd?: boolean
  requirePnpmStoreFd?: boolean
  packageBlock?: boolean
  packageExternalStartProfile?: string
  packageFails?: boolean
  packageSymlinkRelative?: string
  packageSymlinkTarget?: string
  packageWriteRelative?: string
  processAncestorReference?: 'cwd' | 'fd'
  serviceStabilityMs?: string
  serviceStabilitySamples?: number
  storeFails?: boolean
  systemdDropInMutation?: 'hash' | 'identity'
  systemdCrashBeforeStartProfile?: string
  systemdCachedLoadStateProfile?: string
  systemdCachedLoadState?: 'loaded' | 'masked'
  systemdDynamicProfile?: string
  systemdDynamicReportedDshHome?: '__other__'
  systemdGuardianListUnitFilesFailureBudget?: number
  systemdGuardianListUnitsFailureBudget?: number
  systemdGuardianOwnershipShowFailureBudget?: number
  systemdGuardianOwnershipShowFailsProfile?: string
  systemdJournal?: 'fail' | 'missing' | 'ready' | 'stale'
  systemdLarkDisconnectAfterConnect?: boolean
  systemdLarkFlapAfterAccept?: boolean
  systemdLarkFlapAtReadinessBaseline?: boolean
  systemdMaskedMetadataEmpty?: boolean
  systemdMaskedStaticMetadataOmitted?: boolean
  systemdKillLifecycleDuringStartProfile?: string
  systemdLarkProfiles?: readonly string[]
  systemdOwnershipChangesProfile?: string
  systemdOwnershipChangesAfterStartProfile?: string
  systemdPidStuckProfile?: string
  systemdProcPids?: readonly number[]
  sshdProofPids?: readonly number[]
  sdPamProofPids?: readonly number[]
  systemdQuiescenceDriftProfile?: string
  systemdReadinessFailsProfile?: string
  systemdRawBlankNumericProfile?: string
  systemdRawIdMismatchProfile?: string
  systemdReplaceControlMaskOnUnmaskProfile?: string
  systemdRestartLoopProfile?: string
  systemdStartFailsProfile?: string
  systemdStopFailsProfile?: string
  systemdStopLeavesFailedProfile?: string
  systemdSupervisedProfile?: string
  systemdUnsupportedProfile?: string
  supervisedMockFailure?: 'active' | 'host-exit' | 'post-swap' | 'preview'
  supervisedProofDrift?: boolean
  supervisedUnmanagedAutomationDrift?: boolean
  deliverySnapshotSchema?: 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30
}

interface LifecycleSystemdState {
  controls: {
    crashBeforeStartProfile?: string
    crashTriggered?: boolean
    controlMaskReplaced?: boolean
    cachedLoadState?: 'loaded' | 'masked'
    cachedLoadStateProfile?: string
    dynamicAdded?: boolean
    dynamicProfile?: string
    dropInMutation?: 'hash' | 'identity'
    guardianListUnitFilesFailuresRemaining?: number
    guardianListUnitsFailuresRemaining?: number
    guardianOwnershipShowFailuresRemaining?: number
    guardianOwnershipShowFailsProfile?: string
    journal?: 'fail' | 'missing' | 'ready' | 'stale'
    ownershipChangesProfile?: string
    pidStuckProfile?: string
    quiescenceDriftProfile?: string
    readinessFailsProfile?: string
    rawBlankNumericProfile?: string
    rawIdMismatchProfile?: string
    replaceControlMaskOnUnmaskProfile?: string
    restartLoopProfile?: string
    startFailsProfile?: string
    stopFailsProfile?: string
    stopLeavesFailedProfile?: string
  }
  firstCommandBackupExists?: boolean
  firstCommandHomeExists?: boolean
  firstCommandTransactionExists?: boolean
  stopLegacyMarkerExists?: boolean
  nextPid: number
  stopObservations?: Array<{ maskPresent: boolean; unit: string; unitFileState: string }>
  units: Record<string, {
    activeState: string
    boundMaskPersistedWhenRuntimeUnmasked?: boolean
    boundMaskPresentWhenRuntimeUnmasked?: boolean
    controlPid: number
    dropIns: string[]
    fragmentPath: string
    invocationId: string
    mainPid: number
    maskPresentWhenStopped?: boolean
    nRestarts: number
    pathEnvironment: string
    serviceEnvironment: Record<string, string>
    profile: string
    reportedDshHome: string
    serviceHome: string
    starts: number
    subState: string
    unitFileState: string
    unitFileStateBeforeMask?: string
    workingDirectory: string
    replacementMaskIdentity?: LifecycleIdentity
  }>
}

type RecoveryState = 'preparing' | 'prepared' | 'validated' | 'original-renamed' | 'swapped' | 'committed' | 'cleanup-started' | 'failed'

interface LifecycleIdentity {
  dev: string
  ino: string
  mode?: number
  uid?: number
}

interface BoundLifecycleManifest {
  version: 1
  id: string
  homePath: string
  canonicalHome: string
  transactionPath: string
  transactionIdentity?: LifecycleIdentity
  profile: string
  operation: 'upgrade' | 'uninstall'
  originalIdentity: LifecycleIdentity
  originalProfileDigest: string
  originalProfileTreeDigest?: string
  stagedIdentity?: LifecycleIdentity
  stagedProfileDigest?: string
  expectedScenario?: 'autonomy' | 'lark' | 'web'
  stagedScenario?: 'autonomy' | 'lark' | 'unsupported' | 'web'
  createdAt: string
  state: RecoveryState
  updatedAt: string
  bindingDigest: string
}

// Each spec owns its fixtures and cleanup registry. Importing this module does not register tests.
export function createInstallerFixtures() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

  const installDirectory = join(repoRoot, 'scripts', 'install')

  const localInstaller = join(installDirectory, 'install-local.sh')

  const npmInstaller = join(installDirectory, 'install-npm.sh')

  const installerLibrary = join(installDirectory, 'common.sh')

  // Installer fixtures should not inherit a developer machine's optional TraeX.
  // Tests for auto-discovery place their own executable ahead of this PATH.
  const pathWithoutTraex = (process.env.PATH ?? '').split(':').filter(directory => directory !== ''
    && !existsSync(join(directory, 'traex')) && !existsSync(join(directory, 'trae-cli'))).join(':')

  const temporaryRoots: string[] = []

  const realBwrapProbe = spawnSync('/usr/bin/bwrap', [
    '--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true',
  ], { encoding: 'utf8', timeout: 5_000 })

  const realBwrapUsable = realBwrapProbe.status === 0

  const digest64 = 'a'.repeat(64)

  const supervisedManagedDependencies = [
    'personal-assistant',
    'plugin-control-plane',
    'assistant-delivery',
    'credentials-keychain',
    'lark-channel',
    'preference-learning',
    'assistant-evaluation',
    'assistant-evolution',
    'assistant-growth-experiments',
    'assistant-heartbeat',
    'assistant-health',
    'assistant-skills',
    'assistant-verifier',
    'assistant-growth-driver',
    'assistant-recovery',
  ] as const

  /**
   * Run an installer entry point.
   *
   * `platform` pins `uname -s` detection the same way {@link runRestart} does, so
   * assertions about a platform-specific resident service (systemd units on
   * Linux, launchd on macOS) stay deterministic on any development host instead
   * of only passing on the CI runner's operating system.
   */
  function runInstaller(
    script: string,
    args: readonly string[],
    dshHome: string,
    platform?: string,
    extraEnvironment: Record<string, string | undefined> = {},
  ) {
    // The installer bootstraps pnpm for every install source. A fixture that owns a
    // fake PATH gets the pinned shim automatically, so an install no longer depends
    // on whichever pnpm the host happens to expose. Fixtures that provide their own
    // pnpm keep it.
    const firstPathEntry = (extraEnvironment.PATH ?? pathWithoutTraex).split(':')[0]
    if (firstPathEntry !== '' && existsSync(firstPathEntry)) {
      const pnpmShim = join(firstPathEntry, 'pnpm')
      if (!existsSync(pnpmShim)) {
        writeFileSync(pnpmShim, "#!/bin/bash\nprintf '11.7.0\\n'\n", { mode: 0o755 })
      }
    }
    const fixtureScript = join(dirname(dshHome), 'install', basename(script))
    return spawnSync('/bin/bash', [existsSync(fixtureScript) ? fixtureScript : script, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: pathWithoutTraex,
        DSH_HOME: dshHome,
        ...(platform === undefined ? {} : { DSH_ENHANCED_PLATFORM_OVERRIDE: platform }),
        ...extraEnvironment,
      },
    })
  }

  async function temporaryDshHome(parent = tmpdir()): Promise<string> {
    const root = await realpath(await mkdtemp(join(parent, 'dsh-enhanced-installer-')))
    temporaryRoots.push(root)
    return root
  }

  async function writeExecutable(path: string, content: string): Promise<void> {
    await writeFile(path, content, 'utf8')
    await chmod(path, 0o755)
  }

  async function lifecycleFixture(options: LifecycleFixtureOptions = {}) {
    const root = await temporaryDshHome(options.temporaryParent)
    const dshHome = join(root, 'home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const fakeBin = join(root, 'bin')
    const fixtureInstallDirectory = join(root, 'install')
    const fixtureInstallerLibrary = join(fixtureInstallDirectory, 'common.sh')
    await mkdir(profileDirectory, { recursive: true })
    await mkdir(fakeBin)
    await mkdir(fixtureInstallDirectory)
    await writeFile(fixtureInstallerLibrary, await readFile(installerLibrary))
    await writeFile(join(fixtureInstallDirectory, 'lifecycle-config.mjs'),
      await readFile(join(installDirectory, 'lifecycle-config.mjs')))
    for (const helper of ['host-lifecycle.mjs', 'host-profile-update.mjs', 'host-rsi-update.mjs', 'local-source-maintenance.mjs', 'local-source-preview.mjs', 'local-source-candidate-policy.mjs', 'local-source-cache-copy.mjs']) {
      await writeFile(join(fixtureInstallDirectory, helper), await readFile(join(installDirectory, helper)))
    }
    const lifecycleSource = await readFile(join(installDirectory, 'lifecycle-profile.mjs'), 'utf8')
    const trustCheck = "  const entry = await lstat(canonical)\n"
    const systemTrustFunction = "async function trustedSystemExecutable(path, name) {\n"
    const procLoop = "  const proc = await opendir('/proc')\n  for await (const entry of proc) {"
    const sshdProofAnchor = "async function isStrictlyRootSshdAuthSession(pid, childStatus) {\n"
    const sdPamProofAnchor = "async function isStrictlySystemdUserPamHelper(pid, childStatus) {\n"
    const guardianReady = "  try {\n    const result = await operation()"
    const guardianCompletion = '  const completion = new Promise((resolveCompletion, rejectCompletion) => {\n'
    const originalRenamed = "    manifest = await writeManifest(physicalTransactionRoot, manifest, 'original-renamed')\n"
    const serviceStopped = "      manifest = await writeManifest(physicalTransactionRoot, { ...manifest, servicePhase: 'stopped' }, 'preparing')\n"
    const canonicalCleanup = 'async function removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome }) {\n'
    const cleanupDeleting = "        cleanup: { ...manifest.cleanup, phase: 'deleting' },\n      })\n"
    const cleanupMetadata = "      manifest = await writeManifest(cleanupFdPath, manifest, 'cleanup-started', {\n        cleanup: { ...manifest.cleanup, phase: 'metadata-only' },\n      })\n"
    const cleanupPrepared = "          cleanup: { protocol: SERVICE_CLEANUP_PROTOCOL, phase: 'prepared', tombstoneName, identity: boundBackupIdentity },\n        })\n"
    const cleanupReacceptPending = "    }, resumeCleanup ? 'cleanup-started' : 'swapped')\n    let accepted\n"
    const cleanupReacceptGuardian = "      })\n    } catch (error) {\n      if (supervisedContext !== undefined && manifest.supervisedLifecycle.source === undefined) {\n"
    const supervisedOperator = 'async function runSupervisedOperator(context, action, nonce, extraEnvironment) {\n'
    const supervisedDirectOperator = 'async function runSupervisedOperatorDirect(context, action, nonce) {\n'
    const supervisedHost = 'async function startSandboxHost(context) {\n'
    const supervisedCapability = 'async function assertSupervisedLifecycleCapability(homePath, profile) {\n'
    expect(lifecycleSource).toContain(trustCheck)
    expect(lifecycleSource).toContain(systemTrustFunction)
    expect(lifecycleSource).toContain(procLoop)
    expect(lifecycleSource).toContain(sshdProofAnchor)
    expect(lifecycleSource).toContain(sdPamProofAnchor)
    expect(lifecycleSource).toContain(guardianReady)
    expect(lifecycleSource).toContain(guardianCompletion)
    expect(lifecycleSource).toContain(originalRenamed)
    expect(lifecycleSource).toContain(serviceStopped)
    expect(lifecycleSource).toContain(canonicalCleanup)
    expect(lifecycleSource).toContain(cleanupDeleting)
    expect(lifecycleSource).toContain(cleanupMetadata)
    expect(lifecycleSource).toContain(cleanupPrepared)
    expect(lifecycleSource).toContain(cleanupReacceptPending)
    expect(lifecycleSource).toContain(cleanupReacceptGuardian)
    expect(lifecycleSource).toContain(supervisedOperator)
    expect(lifecycleSource).toContain(supervisedDirectOperator)
    expect(lifecycleSource).toContain(supervisedHost)
    expect(lifecycleSource).toContain(supervisedCapability)
    const supervisedMock = `
async function testSupervisedHost(context) {
  const home = context.stageHome ?? context.homePath
  let fixtureInventory
  try { fixtureInventory = JSON.parse(await readFile(join(home, '.scanner-retirement-fixture.json'), 'utf8')) } catch {}
  if (fixtureInventory && fixtureInventory.mode !== 'no-op') {
    const retired = await lstat(join(home, '.scanner-retired')).then(() => true, () => false)
    const manifest = JSON.parse(await readFile(join(process.env.LIFECYCLE_ORIGINAL_HOME + '.dsh-enhanced-transaction', 'manifest.json'), 'utf8'))
    const phase = manifest.supervisedLifecycle.scannerRetirement.phase
    await writeFile(process.env.LIFECYCLE_OPERATION_LOG, 'scanner-host retirement=' + phase + ' retired=' + retired + '\\n', { flag: 'a' })
    if (!retired || phase !== 'completed') throw new Error('fixture Host entered before retirement completion')
  }
  return { closed: () => process.env.LIFECYCLE_SUPERVISED_MOCK_FAILURE === 'host-exit', close: async () => {} }
}
async function testSupervisedOperator(action, nonce, direct, context) {
  let archivePresent = false
  for (const candidate of [context?.stageHome, context?.homePath]) {
    if (candidate !== undefined
      && await lstat(join(candidate, 'uninstalled-profiles')).then(() => true, () => false)) archivePresent = true
  }
  if (process.env.DSH_ENHANCED_TEST_SUPERVISED_OPERATOR_LOG) {
    await writeFile(process.env.DSH_ENHANCED_TEST_SUPERVISED_OPERATOR_LOG,
      'supervised-operator\\t' + action + '\\t' + (direct ? 'direct' : 'sandbox')
        + '\\tarchive=' + String(archivePresent) + '\\n', { flag: 'a' })
  }
  const digest = '${digest64}'
  const mockHome = direct ? context.homePath : context.stageHome ?? context.homePath
  const effectiveConfig = await readFile(join(mockHome, 'profiles', context.profile, '.lifecycle-dump-config'), 'utf8')
    .catch(() => readFile(join(mockHome, '.lifecycle-dump-config'), 'utf8'))
  const configDigest = sha256(effectiveConfig)
  let fixtureInventory
  try { fixtureInventory = JSON.parse(await readFile(join(mockHome, '.scanner-retirement-fixture.json'), 'utf8')) } catch {}
  const fixtureRetired = await lstat(join(mockHome, '.scanner-retired')).then(() => true, () => false)
  const database = { device: '1', inode: '2', size: '3', digest }
  const generationFile = process.env.LIFECYCLE_SUPERVISED_GENERATION_FILE
  let persistedGeneration = 0
  try { persistedGeneration = Number(await readFile(generationFile, 'utf8')) } catch {}
  const source = action === 'attest-active' && direct && nonce === undefined && persistedGeneration === 0
  const postSwap = action === 'attest-active' && direct && nonce !== undefined
  const raw = action === 'snapshot'
  const stage = action.endsWith('preview') ? 'preview' : 'active'
  const effectiveNonce = source ? 'source-nonce' : nonce || '12345678-1234-4123-8123-123456789abc'
  let generation = source ? 1
    : raw ? Math.max(2, persistedGeneration)
      : stage === 'preview' ? 2
        : postSwap ? Math.max(3, persistedGeneration + 1) : Math.max(3, persistedGeneration)
  const cleanupRead = action === 'attest-active' && direct && !source && persistedGeneration >= 3
  const ownerDigest = cleanupRead && process.env.LIFECYCLE_SUPERVISED_PROOF_DRIFT === '1' ? 'b'.repeat(64) : digest
  const unmanagedDefinition = action === 'attest-preview'
    && process.env.LIFECYCLE_SUPERVISED_UNMANAGED_DRIFT === '1' ? 'b'.repeat(64) : digest
  if (action.startsWith('attest-') && generationFile) await writeFile(generationFile, String(generation))
  if (process.env.LIFECYCLE_SUPERVISED_MOCK_FAILURE === 'post-swap' && postSwap) throw new Error('injected supervised post-swap failure')
  if (action.startsWith('attest-') && process.env.LIFECYCLE_SUPERVISED_MOCK_FAILURE === stage
    && !(stage === 'active' && source)) throw new Error('injected supervised ' + stage + ' failure')
  if (action.startsWith('prepare-')) {
    const plan = {
      patchDigest: digest, effectiveConfigDigest: configDigest, attestationSetDigest: digest,
      managedInventoryDigest: digest, ownerBindingDigest: digest,
      externalProviderExemptions: stage === 'preview' ? ['larkChannel'] : [],
    }
    // prepare-preview derives and stages the isolation overlay inside the
    // sandbox; the orchestrator re-reads the dotfile and binds its digest.
    if (action === 'prepare-preview' && context && !direct) {
      const overlay = supervisedPreviewOverlayPaths(context)
      const overlayBody = 'mock-derived-preview-overlay-' + digest
      await writeFile(overlay.stagePath, overlayBody, { mode: 0o600 })
      plan.runtimeOverlayDigest = sha256(overlayBody)
    }
    return { catalogDigest: digest, plan }
  }
  const recovery = { protocol: 'assistant-recovery/operator-snapshot/v1', schemaVersion: 5, database, snapshotDigest: digest,
    bootstrap: { status: raw ? 'running' : 'succeeded', generation, attestationValid: !raw,
      attestationSetDigest: raw ? '' : digest, attestations: raw ? [] : [{ automationId: 'recovery:supervised-growth',
        activationState: stage, activationNonce: effectiveNonce, activationPlanDigest: digest }] } }
  return { effectiveConfigDigest: configDigest, semanticDigest: digest,
    databasePaths: { delivery: 'delivery.sqlite', automations: 'automations.sqlite', recovery: 'recovery.sqlite' },
    ownerBindingDigest: ownerDigest,
    delivery: { protocol: 'assistant-delivery/active-lark-owner-bindings-snapshot/v1', schemaVersion: ${options.deliverySnapshotSchema ?? 24}, database,
      snapshotDigest: digest, storageDigest: digest, bindings: [{ id: 'binding-1' }] },
    recovery, automations: { protocol: 'assistant-automations-operator-snapshot/v1', schemaVersion: 16, database,
      snapshotDigest: digest, inventoryDigest: digest, storageDigest: digest, inFlightCount: raw ? 1 : 0,
      records: fixtureInventory ? (fixtureRetired ? fixtureInventory.after : fixtureInventory.before) : [{ id: 'owner:user-job', owner: 'owner', definitionHash: unmanagedDefinition, status: 'paused',
        createdAt: 1, updatedAt: 1, version: 1, runningTaskCount: 0 }], sidecars: { wal: null, shm: null } },
    managedProjection: { protocol: 'dsh-enhanced/supervised-growth-managed-automations/v1', records: [], digest },
    ...(raw ? {} : { attestation: { protocol: 'dsh-enhanced/supervised-growth-lifecycle-attestation/v1',
      stage, externalProviderExemptions: stage === 'preview' ? ['larkChannel'] : [], effectiveConfigDigest: configDigest,
      attestationDigest: digest, recovery: { activationNonceDigest: sha256(effectiveNonce), catalogDigest: digest,
        bootstrapAttestationSetDigest: digest } } }),
  }
}
`
    await writeFile(join(fixtureInstallDirectory, 'lifecycle-profile.mjs'), lifecycleSource.replace(
      trustCheck,
      trustCheck + `  if (process.env.DSH_ENHANCED_TEST_SERVICE_TOOLS === '1'\n`
        + `    && dirname(canonical) === ${JSON.stringify(fakeBin)}) return canonical\n`,
    ).replace(
      systemTrustFunction,
      systemTrustFunction + `  if (process.env.DSH_ENHANCED_TEST_SERVICE_TOOLS === '1') return await realpath(path)\n`,
    ).replace(
      procLoop,
      "  const procNames = (process.env.DSH_ENHANCED_TEST_PROC_PIDS ?? '').split(',').filter(Boolean)\n"
        + "  if (process.env.DSH_ENHANCED_TEST_INCLUDE_ANCESTORS === '1') procNames.push(...await processAncestorIds())\n"
        + "  const proc = [...new Set(procNames.map(String))].map(name => ({ name }))\n  for (const entry of proc) {",
    ).replace(
      sshdProofAnchor,
      sshdProofAnchor
        + "  if ((process.env.DSH_ENHANCED_TEST_SSHD_PROOF_PIDS ?? '').split(',').filter(Boolean).map(Number).includes(pid)) return true\n",
    ).replace(
      sdPamProofAnchor,
      sdPamProofAnchor
        + "  if ((process.env.DSH_ENHANCED_TEST_SDPAM_PROOF_PIDS ?? '').split(',').filter(Boolean).map(Number).includes(pid)) return true\n",
    ).replace(
      guardianCompletion,
      "  if (process.env.DSH_ENHANCED_TEST_GUARDIAN_PID_FILE) await writeFile(process.env.DSH_ENHANCED_TEST_GUARDIAN_PID_FILE, String(guardian.pid))\n"
        + guardianCompletion,
    ).replace(
      guardianReady,
      "  if (process.env.DSH_ENHANCED_TEST_KILL_PARENT_AFTER_GUARDIAN_START === '1') process.kill(process.pid, 'SIGKILL')\n"
        + "  if (process.env.DSH_ENHANCED_TEST_DISCONNECT_GUARDIAN_AFTER_START === '1') { guardian.stdin.end(); await completion }\n"
        + guardianReady,
    ).replace(
      originalRenamed,
      originalRenamed
        + "    if (process.env.DSH_ENHANCED_TEST_KILL_AFTER_ORIGINAL_RENAME === '1') process.kill(process.pid, 'SIGKILL')\n",
    ).replace(
      serviceStopped,
      serviceStopped
        + "      if (process.env.DSH_ENHANCED_TEST_KILL_AFTER_STOPPED === '1') process.kill(process.pid, 'SIGKILL')\n",
    ).replace(
      canonicalCleanup,
      canonicalCleanup
        + "  if (process.env.DSH_ENHANCED_TEST_FAIL_CANONICAL_CLEANUP === '1') fail('injected canonical cleanup failure')\n",
    ).replace(
      cleanupPrepared,
      cleanupPrepared
        + "        if (process.env.DSH_ENHANCED_TEST_CRASH_AFTER_CLEANUP_PREPARED === '1') process.kill(process.pid, 'SIGKILL')\n",
    ).replace(
      cleanupDeleting,
      cleanupDeleting
        + "      if (process.env.DSH_ENHANCED_TEST_CRASH_DURING_CLEANUP === '1') {\n"
        + "        await rm(join(anchoredTombstone, 'profiles'), { recursive: true, force: true })\n"
        + "        process.kill(process.pid, 'SIGKILL')\n"
        + "      }\n",
    ).replace(
      cleanupMetadata,
      cleanupMetadata
        + "      if (process.env.DSH_ENHANCED_TEST_CRASH_AFTER_CLEANUP_METADATA === '1') process.kill(process.pid, 'SIGKILL')\n",
    ).replace(
      cleanupReacceptPending,
      cleanupReacceptPending.replace('    let accepted\n',
        "    if (process.env.DSH_ENHANCED_TEST_CRASH_AFTER_CLEANUP_REACCEPT_PENDING === '1') process.kill(process.pid, 'SIGKILL')\n"
          + '    let accepted\n'),
    ).replace(
      cleanupReacceptGuardian,
      cleanupReacceptGuardian.replace('    } catch (error) {\n',
        "      if (process.env.DSH_ENHANCED_TEST_CRASH_AFTER_CLEANUP_REACCEPT_GUARDIAN === '1') process.kill(process.pid, 'SIGKILL')\n"
          + '    } catch (error) {\n'),
    ).replace(
      supervisedOperator,
      supervisedMock + supervisedOperator
        + "  if (process.env.LIFECYCLE_SUPERVISED_MOCK === '1') return testSupervisedOperator(action, nonce ?? context.supervisedNonce, false, context)\n",
    ).replace(
      supervisedDirectOperator,
      supervisedDirectOperator
        + "  if (process.env.LIFECYCLE_SUPERVISED_MOCK === '1') return testSupervisedOperator(action, nonce ?? context.supervisedNonce, true, context)\n",
    ).replace(
      supervisedHost,
      supervisedHost + "  if (process.env.LIFECYCLE_SUPERVISED_MOCK === '1') return testSupervisedHost(context)\n",
    ).replace(
      supervisedCapability,
      supervisedCapability + "  if (process.env.LIFECYCLE_SUPERVISED_MOCK === '1') return\n",
    ))
    await writeFile(join(fixtureInstallDirectory, 'install-local.sh'),
      `#!/bin/bash\nset -euo pipefail\nsource ${JSON.stringify(fixtureInstallerLibrary)}\ndsh_enhanced_install local ${JSON.stringify(repoRoot)} "$@"\n`)
    await writeFile(join(fixtureInstallDirectory, 'install-npm.sh'),
      `#!/bin/bash\nset -euo pipefail\nsource ${JSON.stringify(fixtureInstallerLibrary)}\ndsh_enhanced_install npm '' "$@"\n`)
    await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
    const thirdParty = options.thirdParty ?? false
    const managedDependencies = options.managedDependencies ?? ['personal-assistant']
    const dependencies = Object.fromEntries(managedDependencies.map(name => [`@dsh-enhanced/${name}`, '0.1.0']))
    const managedBundles = managedDependencies.map(name => `@dsh-enhanced/${name}`)
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true,
      dependencies: {
        ...dependencies,
        ...(options.thirdPartyDependency ? { 'owner-library': '1.0.0' } : {}),
        ...(thirdParty ? { 'owner-plugin': '1.0.0' } : {}),
      },
      dsh: { profile: { bundles: [
        '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...managedBundles,
        ...(thirdParty ? ['owner-plugin'] : []),
      ] } },
    }, null, 2))
    await writeFile(join(profileDirectory, 'cordis.yml'), '[]\n')
    await writeFile(join(profileDirectory, 'cordis.patch.yml'), '- id: owner-custom\n  config: { value: keep }\n')
    await writeFile(join(profileDirectory, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    await writeFile(join(profileDirectory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const effectiveScenario = options.effectiveScenario ?? (options.systemd === undefined ? 'web' : 'lark')
    const effectiveRows = effectiveScenario === 'lark'
      ? [{
          id: 'dsh-enhanced-lark-channel',
          name: '@dsh-enhanced/lark-channel',
          config: { enabled: true },
        }]
      : effectiveScenario === 'supervised'
        ? [
            {
              id: 'dsh-enhanced-lark-channel',
              name: '@dsh-enhanced/lark-channel',
              config: { enabled: true },
            },
            { id: 'dsh-enhanced-assistant-recovery', name: '@dsh-enhanced/assistant-recovery' },
          ]
        : [
            { id: 'dsh-enhanced-assistant-web-owner', name: '@dsh-enhanced/assistant-web-owner' },
            ...(effectiveScenario === 'autonomy'
              ? [{ id: 'dsh-enhanced-assistant-isolation', name: '@dsh-enhanced/assistant-isolation' }]
              : []),
          ]
    await writeFile(join(dshHome, '.lifecycle-dump-config'), stringify(effectiveRows))
    await mkdir(join(dshHome, 'assistant-goals'), { recursive: true })
    const databasePath = join(dshHome, 'assistant-goals', 'web.sqlite')
    const database = new DatabaseSync(databasePath)
    database.exec("PRAGMA user_version = 1; CREATE TABLE goals (value TEXT NOT NULL); INSERT INTO goals VALUES ('durable-goal-state');")
    database.close()
    await mkdir(join(dshHome, 'sessions'), { recursive: true })
    await writeFile(join(dshHome, 'sessions', 'owner-session.jsonl'), 'durable-session')
    const dshLog = join(root, 'dsh.log')
    const bwrapLog = join(root, 'bwrap.log')
    const operationLog = join(root, 'lifecycle-operations.log')
    const pnpmStorePath = join(root, 'pnpm-store')
    await Promise.all([writeFile(operationLog, ''), mkdir(pnpmStorePath)])
    const supervisedOperatorLog = join(root, 'supervised-operator.log')
    await writeFile(supervisedOperatorLog, '')
    const lifecycleTarget = join(root, 'managed-target')
    await mkdir(lifecycleTarget)
    await writeFile(join(lifecycleTarget, 'package.json'), JSON.stringify({
      name: `@dsh-enhanced/${managedDependencies[0] ?? 'personal-assistant'}`,
      version: '0.1.0',
    }))
    const readinessLine = options.readiness === 'host' ? 'dsh-enhanced host ready: v1'
      : options.readiness === 'invalid-host' ? 'dsh-enhanced host ready: v10'
        : 'dsh web: http://127.0.0.1:43210'
    const activation = `"${process.execPath}" --input-type=module - "$DSH_HOME/assistant-goals/web.sqlite" <<'NODE'
import { DatabaseSync } from 'node:sqlite'
const database = new DatabaseSync(process.argv[2])
database.exec("PRAGMA user_version = 2; INSERT INTO goals VALUES ('migrated-during-activation');")
database.close()
NODE
if [[ -n "$LIFECYCLE_CONFIG_AFTER_ACTIVATION" ]]; then
  printf '%s\n' "$LIFECYCLE_CONFIG_AFTER_ACTIVATION" > "$DSH_HOME/.lifecycle-dump-config"
fi
${options.activationFails ? "printf 'activation failed\\n' >&2; exit 23" : `printf '${readinessLine}\\n'${options.readiness && options.readiness !== 'web' ? ' >&2' : ''}; exit 0`}`
    const lifecycleDshExecutable = await nativeInstallerHost(root, String.raw`#!/bin/bash
set -euo pipefail
{ printf 'CALL'; printf '\t%s' "$@"; printf '\n'; } >> "$LIFECYCLE_DSH_LOG"
if [[ " ${'$'}{1:-} " == ' --version ' ]]; then printf '0.2.1-rc.2\n'; exit 0; fi
if [[ " $* " == *' plugin '* && " $* " == *' add '* ]]; then
  transaction_state='absent'
  [[ -e "$LIFECYCLE_ORIGINAL_HOME.dsh-enhanced-transaction" ]] && transaction_state='present'
  printf 'dsh-add\t%s\toffline=%s\timport=%s\t%s\n' "$transaction_state" "${'$'}{pnpm_config_offline:-}" "${'$'}{pnpm_config_package_import_method:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  ${options.requirePnpmStore ? `if [[ "${'$'}{pnpm_config_store_dir:-}" != "${pnpmStorePath}" ]]; then printf 'sandbox store mismatch\n' >&2; exit 96; fi` : ''}
  ${options.requirePnpmFrozenStore ? `if [[ "${'$'}{pnpm_config_frozen_store:-}" != 'true' || "${'$'}{pnpm_config_ignore_scripts:-}" != 'true' ]]; then printf 'sandbox store must be frozen with scripts disabled\n' >&2; exit 95; fi` : ''}
  if [[ "$LIFECYCLE_PACKAGE_FAILS" == '1' ]]; then printf 'package update failed\n' >&2; exit 42; fi
  if [[ "$LIFECYCLE_PACKAGE_BLOCK" == '1' ]]; then
    : > "$DSH_HOME/.package-preparation-started"
    while [[ ! -f "$DSH_HOME/.package-preparation-release" ]]; do sleep 0.05; done
  fi
  if [[ -n "$LIFECYCLE_PACKAGE_EXTERNAL_START_PROFILE" ]]; then
    systemctl --user start "dsh-profile-$LIFECYCLE_PACKAGE_EXTERNAL_START_PROFILE.service" || true
  fi
  if [[ -n "$LIFECYCLE_SYSTEMD_QUIESCENCE_DRIFT_PROFILE" ]]; then
    "${process.execPath}" --input-type=module - "$LIFECYCLE_SYSTEMD_STATE" "$LIFECYCLE_SYSTEMD_QUIESCENCE_DRIFT_PROFILE" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const state = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const unit = Object.values(state.units).find(value => value.profile === process.argv[3])
if (unit) { unit.activeState = 'active'; unit.subState = 'running'; unit.mainPid = 49999 }
writeFileSync(process.argv[2], JSON.stringify(state) + '\n')
NODE
  fi
  if [[ -n "$LIFECYCLE_CONFIG_AFTER_UPGRADE" ]]; then
    printf '%s\n' "$LIFECYCLE_CONFIG_AFTER_UPGRADE" > "$DSH_HOME/.lifecycle-dump-config"
  fi
  if [[ -n "$LIFECYCLE_PACKAGE_WRITE_RELATIVE" ]]; then
    printf 'outside-write\n' > "$DSH_HOME/$LIFECYCLE_PACKAGE_WRITE_RELATIVE"
  fi
  if [[ -n "$LIFECYCLE_PACKAGE_SYMLINK_RELATIVE" ]]; then
    mkdir -p "$(dirname "$DSH_HOME/$LIFECYCLE_PACKAGE_SYMLINK_RELATIVE")"
    rm -f -- "$DSH_HOME/$LIFECYCLE_PACKAGE_SYMLINK_RELATIVE"
    ln -s -- "$LIFECYCLE_PACKAGE_SYMLINK_TARGET" "$DSH_HOME/$LIFECYCLE_PACKAGE_SYMLINK_RELATIVE"
  fi
  printf 'upgraded\n' > "$DSH_HOME/profiles/web/upgraded"
  exit 0
fi
if [[ " $* " == *' plugin '* && " $* " == *' list '* ]]; then
  mkdir -p "$DSH_HOME/profiles/web"
  printf '%s\n' '{"name":"dsh-profile-web","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}' > "$DSH_HOME/profiles/web/package.json"
  printf '%s\n' '[]' > "$DSH_HOME/profiles/web/cordis.yml"
  printf '%s\n' '[]' > "$DSH_HOME/profiles/web/cordis.patch.yml"
  printf '%s\n' '[]' > "$DSH_HOME/.lifecycle-dump-config"
  exit 0
fi
if [[ " $* " == *' --dump-config '* ]]; then
  requested_profile=''
  for ((index = 1; index <= $#; index += 1)); do
    if [[ "${'$'}{!index}" == '--profile' ]]; then next=$((index + 1)); requested_profile="${'$'}{!next}"; break; fi
  done
  if [[ -n "$LIFECYCLE_SYSTEMD_SUPERVISED_PROFILE" && "$requested_profile" == "$LIFECYCLE_SYSTEMD_SUPERVISED_PROFILE" ]]; then
    printf '%s\n' "- id: dsh-enhanced-assistant-recovery" "  name: '@dsh-enhanced/assistant-recovery'"
  elif [[ ",$LIFECYCLE_SYSTEMD_LARK_PROFILES," == *",$requested_profile,"* ]]; then
    printf '%s\n' "- id: dsh-enhanced-lark-channel" "  name: '@dsh-enhanced/lark-channel'" "  config:" "    enabled: true"
  elif [[ -n "$LIFECYCLE_SYSTEMD_UNSUPPORTED_PROFILE" && "$requested_profile" == "$LIFECYCLE_SYSTEMD_UNSUPPORTED_PROFILE" ]]; then
    printf '[]\n'
  elif [[ -d "$DSH_HOME/uninstalled-profiles" ]] \
    && [[ -f "$DSH_HOME/profiles/$requested_profile/package.json" ]] \
    && ! grep -q '"@dsh-enhanced/' "$DSH_HOME/profiles/$requested_profile/package.json"; then
    printf '[]\n'
  elif [[ -f "$DSH_HOME/.lifecycle-dump-config" ]]; then cat "$DSH_HOME/.lifecycle-dump-config"; else printf '[]\n'; fi
  exit 0
fi
if [[ " $* " == *' --host 127.0.0.1 --no-open --port 0 '* ]]; then
  : > "$LIFECYCLE_ACTIVATION_MARKER"
  __ACTIVATION__
fi
exit 2
`.replace('__ACTIVATION__', activation))
    await symlink(lifecycleDshExecutable, join(fakeBin, 'dsh'))
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
set -euo pipefail
if [[ " \${1:-} " == ' view ' && " \${3:-} " == ' version ' && " \${4:-} " == ' --json ' ]]; then
  transaction_state='absent'
  [[ -e "$LIFECYCLE_ORIGINAL_HOME.dsh-enhanced-transaction" ]] && transaction_state='present'
  printf 'npm-view\t%s\t%s\n' "$transaction_state" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  if [[ "$LIFECYCLE_NPM_BLOCK" == '1' ]]; then
    : > "$LIFECYCLE_NPM_BLOCK_STARTED"
    while [[ ! -f "$LIFECYCLE_NPM_BLOCK_RELEASE" ]]; do sleep 0.05; done
  fi
  printf '"%s"\n' "$LIFECYCLE_NPM_VERSION"
  exit 0
fi
printf 'unexpected fake npm invocation: %s\n' "$*" >&2
exit 91
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
set -euo pipefail
if [[ " \${1:-} " == ' --version ' ]]; then printf '10.0.0\n'; exit 0; fi
if [[ " \${1:-} \${2:-} " == ' store path ' ]]; then
  if [[ "\${HOME:-}" == *'/verified-cache/home' && -n "\${pnpm_config_store_dir:-}" ]]; then
    mkdir -p "\${pnpm_config_store_dir}/v11"
    printf '%s\\n' "\${pnpm_config_store_dir}/v11"; exit 0
  fi
  if [[ "${'$'}{LIFECYCLE_REQUIRE_PNPM_PROFILE_CWD:-0}" == '1' && "$PWD" != "${'$'}{LIFECYCLE_PROFILE_DIRECTORY:-}" ]]; then printf 'pnpm profile cwd mismatch\n' >&2; exit 97; fi
  if [[ "${'$'}{LIFECYCLE_PNPMFILE_MUST_NOT_RUN:-0}" == '1' && "${'$'}{pnpm_config_ignore_pnpmfile:-}" != 'true' ]]; then printf 'pnpmfile execution was not disabled\n' >&2; exit 98; fi
  if [[ -n "\${LIFECYCLE_PNPM_STORE_MARKER:-}" ]]; then : > "$LIFECYCLE_PNPM_STORE_MARKER"; fi
  printf '%s\n' "${pnpmStorePath}"; exit 0
fi
if [[ " \${1:-} \${2:-} \${3:-} " == ' config list --json ' ]]; then
  if [[ ! -f "$PWD/pnpm-workspace.yaml" ]]; then printf 'pnpm config workspace missing\n' >&2; exit 96; fi
  if [[ -n "\${LIFECYCLE_METADATA_MIRROR_MUTATION_PATH:-}" ]]; then printf 'changed metadata\n' > "$LIFECYCLE_METADATA_MIRROR_MUTATION_PATH"; fi
  registry='https://registry.npmjs.org/'
  if [[ "\${LIFECYCLE_NPM_SANDBOX_REGISTRY_DRIFT:-0}" == '1' && "\${pnpm_config_offline:-}" == 'true' ]]; then registry='https://registry.invalid/'; fi
  printf '{"registry":"%s","@jsr:registry":"https://npm.jsr.io/"}\n' "$registry"
  exit 0
fi
if [[ "\${1:-}" == '--store-dir' && "\${2:-}" == '${pnpmStorePath}' && "\${3:-}" == 'store' && "\${4:-}" == 'add' ]]; then
  if [[ "${'$'}{LIFECYCLE_REQUIRE_PNPM_PROFILE_CWD:-0}" == '1' && "$PWD" != "${'$'}{LIFECYCLE_PROFILE_DIRECTORY:-}" ]]; then printf 'pnpm profile cwd mismatch\n' >&2; exit 97; fi
  if [[ "${'$'}{LIFECYCLE_PNPMFILE_MUST_NOT_RUN:-0}" == '1' && "${'$'}{pnpm_config_ignore_pnpmfile:-}" != 'true' ]]; then printf 'pnpmfile execution was not disabled\n' >&2; exit 98; fi
  transaction_state='absent'
  [[ -e "$LIFECYCLE_ORIGINAL_HOME.dsh-enhanced-transaction" ]] && transaction_state='present'
  printf 'pnpm-store-add\t%s\tignore=%s\t%s\n' "$transaction_state" "${'$'}{pnpm_config_ignore_scripts:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  if [[ "$LIFECYCLE_STORE_FAILS" == '1' ]]; then printf 'store prefetch failed\n' >&2; exit 93; fi
  exit 0
fi
directory="$PWD"
used_directory='0'
arguments=("$@")
if [[ "\${1:-}" == '--dir' ]]; then directory="$2"; used_directory='1'; arguments=("\${@:3}"); fi
transaction_state='absent'
[[ -e "$LIFECYCLE_ORIGINAL_HOME.dsh-enhanced-transaction" ]] && transaction_state='present'
if [[ " \${arguments[0]:-} \${arguments[1]:-} \${arguments[2]:-} " == ' config list --json ' ]]; then
  if [[ ! -f "$directory/pnpm-workspace.yaml" ]]; then printf 'pnpm config workspace missing\n' >&2; exit 96; fi
  registry='https://registry.npmjs.org/'
  if [[ "\${LIFECYCLE_NPM_SANDBOX_REGISTRY_DRIFT:-0}" == '1' && "\${pnpm_config_offline:-}" == 'true' ]]; then registry='https://registry.invalid/'; fi
  printf '{"registry":"%s","@jsr:registry":"https://npm.jsr.io/"}\n' "$registry"
  exit 0
fi
if [[ "\${arguments[0]:-}" == 'add' && " \${arguments[*]} " == *' --force --ignore-scripts --reporter=ndjson '* && " \${arguments[*]} " != *' --lockfile-only '* && ( "$directory" == *'-metadata' || "$directory" == *'-replay' ) ]]; then
  if [[ " \${arguments[*]} " == *' --no-frozen-lockfile '* ]]; then printf 'Unknown option frozen-lockfile\n' >&2; exit 93; fi
  if [[ "$directory" == *'-replay' && -e "$directory/node_modules" ]]; then printf 'metadata replay reused warm node_modules\n' >&2; exit 91; fi
  printf 'pnpm-metadata-warmup\t%s\tcwd=%s\toffline=%s\t%s\n' "$transaction_state" "$directory" "\${pnpm_config_offline:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  if [[ "$directory" == *'-metadata' ]]; then
    mkdir -p "$directory/node_modules"
    if [[ "\${LIFECYCLE_METADATA_WARMUP_FAIL:-0}" == '1' ]]; then printf 'metadata warmup failed\n' >&2; exit 93; fi
    if [[ "\${LIFECYCLE_METADATA_WARMUP_MISSING_MIRROR:-0}" != '1' ]]; then
      mkdir -p "\${pnpm_config_cache_dir:?}/v11/metadata-full/registry.npmjs.org/@koromix"
      printf 'full metadata\n' > "\${pnpm_config_cache_dir}/v11/metadata-full/registry.npmjs.org/@koromix/koffi-linux-x64.jsonl"
      mkdir -p "\${pnpm_config_cache_dir}/v12/metadata-full" "\${pnpm_config_cache_dir}/v9/metadata"
      printf 'new version\n' > "\${pnpm_config_cache_dir}/v12/metadata-full/entry.jsonl"
      printf 'old version\n' > "\${pnpm_config_cache_dir}/v9/metadata/entry.jsonl"
    fi
  elif [[ ! -f "\${pnpm_config_cache_dir:?}/v11/metadata-full/registry.npmjs.org/@koromix/koffi-linux-x64.jsonl" ]]; then
    printf '{"name":"pnpm:skipped-optional-dependency","reason":"resolution_failure"}\n'
  fi
  if [[ -n "\${LIFECYCLE_METADATA_WARMUP_SKIP_REASON:-}" ]]; then
    if [[ "$LIFECYCLE_METADATA_WARMUP_SKIP_REASON" == 'missing' ]]; then
      printf '{"name":"pnpm:skipped-optional-dependency"}\n'
    else
      printf '{"name":"pnpm:skipped-optional-dependency","reason":"%s"}\n' "$LIFECYCLE_METADATA_WARMUP_SKIP_REASON"
    fi
  fi
  if [[ "\${LIFECYCLE_METADATA_WARMUP_STDERR_SKIP:-0}" == '1' ]]; then
    printf '{"name":"pnpm:skipped-optional-dependency","reason":"resolution_failure"}\n' >&2
  fi
  if [[ "\${LIFECYCLE_METADATA_WARMUP_LARGE_STDERR:-0}" == '1' ]]; then
    node -e "process.stderr.write('x'.repeat(4 * 1024 * 1024 + 1024))"
    printf '{"name":"pnpm:skipped-optional-dependency","reason":"resolution_failure"}\n' >&2
  fi
  if [[ "\${LIFECYCLE_METADATA_GRAPH_SHRINK:-}" == 'both' || "\${LIFECYCLE_METADATA_GRAPH_SHRINK:-}" == 'replay' && "$directory" == *'-replay' ]]; then
    node - "$directory/pnpm-lock.yaml" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const path = process.argv[2]
const source = readFileSync(path, 'utf8')
const shortened = source.replace("      '@koromix/koffi-linux-x64': 3.3.2\\n", '')
if (source === shortened) process.exit(92)
writeFileSync(path, shortened)
NODE
  fi
  exit 0
fi
if [[ "\${arguments[0]:-}" == 'add' && " \${arguments[*]} " == *' --lockfile-only '* && " \${arguments[*]} " == *' --save-exact '* ]]; then
  printf 'pnpm-prepare\t%s\tcwd=%s\tignore=%s\tstore=%s\tcache=%s\t%s\n' "$transaction_state" "$directory" "\${pnpm_config_ignore_scripts:-}" "\${pnpm_config_store_dir:-}" "\${pnpm_config_cache_dir:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  if [[ "\${LIFECYCLE_NPM_PREPARE_FAIL:-0}" == '1' ]]; then printf 'metadata preparation failed\n' >&2; exit 93; fi
  node - "$directory" "\${arguments[@]}" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const directory = process.argv[2]
const targets = process.argv.slice(3).filter(value => value.startsWith('@dsh-enhanced/'))
const manifestPath = join(directory, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies ??= {}
for (const target of targets) {
  const index = target.lastIndexOf('@')
  manifest.dependencies[target.slice(0, index)] = target.slice(index + 1)
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n')
const dependencyLines = Object.entries(manifest.dependencies).map(([name, version]) => '      ' + JSON.stringify(name) + ':\\n        specifier: ' + JSON.stringify(version) + '\\n        version: ' + JSON.stringify(version)).join('\\n')
const packageLines = targets.map(target => '  ' + JSON.stringify(target) + ':\\n    resolution: {integrity: sha512-fixture}').join('\\n')
const snapshotLines = targets.map(target => '  ' + JSON.stringify(target) + ': {}').join('\\n')
writeFileSync(join(directory, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\\n\\nimporters:\\n  .:\\n    dependencies:\\n" + dependencyLines + "\\n\\npackages:\\n" + packageLines + "\\n\\nsnapshots:\\n" + snapshotLines + "\\n")
if (process.env.LIFECYCLE_NPM_SOURCE_METADATA_MUTATION === '1') {
  const sourcePath = process.env.LIFECYCLE_ORIGINAL_METADATA_PATH
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
  source.externalMutation = 'preserve'
  writeFileSync(sourcePath, JSON.stringify(source, null, 2) + '\\n')
}
NODE
  exit 0
fi
if [[ "\${arguments[0]:-}" == 'install' && " \${arguments[*]} " == *' --lockfile-only '* && " \${arguments[*]} " == *' --frozen-lockfile '* ]]; then
  printf 'pnpm-verify\t%s\tcwd=%s\tignore=%s\tstore=%s\tcache=%s\t%s\n' "$transaction_state" "$directory" "\${pnpm_config_ignore_scripts:-}" "\${pnpm_config_store_dir:-}" "\${pnpm_config_cache_dir:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  if [[ "\${LIFECYCLE_NPM_VERIFY_FAIL:-0}" == '1' ]]; then printf 'metadata verification failed\n' >&2; exit 94; fi
  node - "$directory/pnpm-lock.yaml" <<'NODE' > "\${pnpm_config_cache_dir:?}/lockfile-verified.jsonl"
const { createHash } = require('node:crypto')
const { readFileSync, statSync } = require('node:fs')
const { resolve } = require('node:path')
const path = resolve(process.argv[2])
const lockStat = statSync(path, { bigint: true })
const policy = { tarballUrlBinding: true, resolutionShapeCheck: true, dependencyAliasCheck: true }
if (process.env.LIFECYCLE_NPM_RECEIPT_MISSING_POLICY) delete policy[process.env.LIFECYCLE_NPM_RECEIPT_MISSING_POLICY]
process.stdout.write(JSON.stringify({ lockfile: { path, size: Number(lockStat.size), inode: String(lockStat.ino), mtimeNs: String(lockStat.mtimeNs), hash: createHash('sha256').update(readFileSync(path)).digest('base64') }, policy }) + '\\n')
NODE
  exit 0
fi
if [[ "\${arguments[0]:-}" == 'fetch' && " \${arguments[*]} " == *' --frozen-lockfile '* ]]; then
  printf 'pnpm-fetch\t%s\tcwd=%s\tignore=%s\tstore=%s\tcache=%s\t%s\n' "$transaction_state" "$directory" "\${pnpm_config_ignore_scripts:-}" "\${pnpm_config_store_dir:-}" "\${pnpm_config_cache_dir:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  if [[ "\${LIFECYCLE_NPM_PREFETCH_FAIL:-0}" == '1' || "$LIFECYCLE_STORE_FAILS" == '1' ]]; then printf 'metadata prefetch failed\n' >&2; exit 95; fi
  exit 0
fi
if [[ "\${arguments[0]:-}" == 'build' ]]; then
  if [[ ! -f "$directory/package.json" ]]; then printf 'pnpm build package manifest missing\n' >&2; exit 96; fi
  if [[ "\${LIFECYCLE_LOCAL_BUILD_FAIL:-0}" == '1' && "$used_directory" == '1' && "$directory" == "$LIFECYCLE_REPO_ROOT" ]]; then printf 'local fixture pnpm build failed\n' >&2; exit 72; fi
  exit 0
fi
if [[ "\${arguments[0]:-}" == 'install' && " \${arguments[*]} " == *' --offline '* && " \${arguments[*]} " == *' --frozen-lockfile '* ]]; then
  if [[ "\${LIFECYCLE_LOCAL_INSTALL_FAIL:-0}" == '1' && "$used_directory" == '1' && "$directory" == "$LIFECYCLE_REPO_ROOT" ]]; then printf 'local fixture pnpm install failed\n' >&2; exit 71; fi
  printf 'pnpm-offline-install\t%s\tcwd=%s\tignore=%s\tstore=%s\tcache=%s\t%s\n' "$transaction_state" "$directory" "\${pnpm_config_ignore_scripts:-}" "\${pnpm_config_store_dir:-}" "\${pnpm_config_cache_dir:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  if [[ -n "\${LIFECYCLE_NPM_PEER_EXTERNAL_BIN:-}" && -e "$directory/node_modules/@dsh-enhanced/lark-channel/package.json" ]]; then
    mkdir -p "$(dirname "$LIFECYCLE_NPM_PEER_EXTERNAL_BIN")"
    printf 'unexpected external bin\n' > "$LIFECYCLE_NPM_PEER_EXTERNAL_BIN"
  fi
  if [[ "$used_directory" == '1' && "$transaction_state" == 'present' && "$directory" == */profiles/web ]]; then
    printf 'upgraded\n' > "$directory/upgraded"
  fi
  exit 0
fi
printf 'unexpected fake pnpm invocation: %s\n' "$*" >&2
exit 92
`)
    const systemdHome = join(root, 'systemd-home')
    const systemdState = join(root, 'systemd-state.json')
    const systemdLog = join(root, 'systemd.log')
    const journalLog = join(root, 'journal.log')
    if (options.systemd !== undefined) {
      const unitDirectory = join(systemdHome, '.config', 'systemd', 'user')
      await mkdir(unitDirectory, { recursive: true, mode: 0o700 })
      const wantsDirectory = join(unitDirectory, 'default.target.wants')
      await mkdir(wantsDirectory, { mode: 0o700 })
      const configuredUnits = options.systemd.units ?? [
        { profile: 'web', active: true },
        { profile: 'worker', active: true },
        { profile: 'dormant', active: false },
      ]
      const units: Record<string, {
        activeState: string
        controlPid: number
        dropIns: string[]
        fragmentPath: string
        invocationId: string
        mainPid: number
        nRestarts: number
        pathEnvironment: string
        serviceEnvironment: Record<string, string>
        profile: string
        reportedDshHome: string
        serviceHome: string
        starts: number
        subState: string
        unitFileState: string
        unitFileStateBeforeMask?: string
        workingDirectory: string
      }> = {}
      for (const configured of configuredUnits) {
        const serviceHome = configured.dshHome === '__other__'
          ? join(root, 'other-home')
          : configured.dshHome === '__nested__'
            ? join(dshHome, 'nested-home')
            : configured.dshHome ?? dshHome
        const serviceProfileDirectory = join(serviceHome, 'profiles', configured.profile)
        const reportedDshHome = configured.reportedDshHome ?? serviceHome
        const workingDirectory = configured.workingDirectory === '__other__'
          ? join(root, 'foreign-working-directory')
          : configured.workingDirectory ?? serviceProfileDirectory
        await mkdir(serviceProfileDirectory, { recursive: true, mode: 0o700 })
        const paths = systemdServicePaths({ home: systemdHome, dshHome: serviceHome, profile: configured.profile })
        const serviceEnvironment = configured.serviceEnvironment ?? {}
        const source = configured.fragment === 'foreign'
          ? `[Service]\nEnvironment=DSH_HOME=${serviceHome}\nExecStart=/usr/bin/false\n`
          : createSystemdUserUnit({
            ...paths,
            dshHome: serviceHome,
            profile: configured.profile,
            profileDirectory: serviceProfileDirectory,
            nodePath: process.execPath,
            dshPath: join(fakeBin, 'dsh'),
            path: `${dirname(process.execPath)}:${fakeBin}:/usr/bin:/bin`,
            environment: serviceEnvironment,
          })
        if (Object.keys(serviceEnvironment).length > 0) {
          const bindingDirectory = join(serviceHome, 'rsi-service-environments')
          await mkdir(bindingDirectory, { recursive: true, mode: 0o700 })
          await writeFile(join(bindingDirectory, `${configured.profile}.json`), `${JSON.stringify({
          schemaVersion: 1, dshHome: serviceHome, profile: configured.profile, environment: serviceEnvironment,
        })}\n`, { mode: 0o600 })
        }
        await writeFile(paths.unitPath, source, { mode: 0o600 })
        if (!configured.runtimeMasked && configured.enabled !== false) {
          await symlink(paths.unitPath, join(wantsDirectory, paths.unitName))
        }
        const dropIns: string[] = []
        if (configured.dropIn !== undefined) {
          const dropInDirectory = `${paths.unitPath}.d`
          await mkdir(dropInDirectory, { mode: 0o700 })
          const knownKeyring = configured.dropIn === 'keyring' || configured.dropIn === 'unsafe-keyring'
          const dropIn = join(dropInDirectory, knownKeyring ? 'keyring.conf' : 'owner.conf')
          await writeFile(dropIn, knownKeyring
            ? '[Unit]\nRequires=gnome-keyring-daemon.service\nAfter=gnome-keyring-daemon.service\n'
            : '[Service]\nEnvironment=OWNER_OVERRIDE=1\n', { mode: configured.dropIn === 'unsafe-keyring' ? 0o666 : 0o600 })
          if (configured.dropIn === 'unsafe-keyring') await chmod(dropIn, 0o666)
          dropIns.push(dropIn)
        }
        const unit = paths.unitName
        units[unit] = {
          activeState: configured.active ? 'active' : 'inactive',
          controlPid: 0,
          dropIns,
          fragmentPath: paths.unitPath,
          invocationId: configured.active ? `original-${configured.profile}` : '',
          mainPid: configured.active ? 20_000 + Object.keys(units).length : 0,
          nRestarts: 0,
          pathEnvironment: `${dirname(process.execPath)}:${fakeBin}:/usr/bin:/bin`,
          serviceEnvironment,
          profile: configured.profile,
          reportedDshHome,
          serviceHome,
          starts: 0,
          subState: configured.active ? 'running' : 'dead',
          unitFileState: configured.runtimeMasked ? 'masked-runtime' : configured.enabled === false ? 'disabled' : 'enabled',
          unitFileStateBeforeMask: 'enabled',
          workingDirectory,
        }
      }
      await writeFile(systemdState, `${JSON.stringify({ controls: {}, nextPid: 30_000, units }, null, 2)}\n`, { mode: 0o600 })
      await writeFile(systemdLog, '')
      await writeFile(journalLog, '')
    }
    await writeExecutable(join(fakeBin, 'systemctl'), `#!${process.execPath}
const { appendFileSync, existsSync, lstatSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const logPath = ${JSON.stringify(systemdLog)}
const statePath = ${JSON.stringify(systemdState)}
const controlRoot = ${JSON.stringify(join(systemdHome, '.config', 'systemd', 'user.control'))}
const journalExecutable = ${JSON.stringify(join(fakeBin, 'journalctl'))}
const dshExecutable = ${JSON.stringify(join(fakeBin, 'dsh'))}
const originalHome = ${JSON.stringify(dshHome)}
appendFileSync(logPath, JSON.stringify(args) + '\\n')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const persist = () => {
  const temporary = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(state) + '\\n', { mode: 0o600 })
  renameSync(temporary, statePath)
}
if (state.firstCommandHomeExists === undefined) {
  state.firstCommandHomeExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME)
  state.firstCommandBackupExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME + '.dsh-enhanced-transaction/original-home')
  state.firstCommandTransactionExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME + '.dsh-enhanced-transaction')
  persist()
}
if (state.firstCommandHomeExists === undefined) {
  state.firstCommandHomeExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME)
  state.firstCommandBackupExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME + '.dsh-enhanced-transaction/original-home')
  persist()
}
if (args[0] !== '--user') process.exit(90)
if (args[1] === 'list-unit-files') {
  if (state.controls.guardianListUnitFilesFailuresRemaining > 0
    && Object.values(state.units).some(unit => unit.starts > 0)) {
    state.controls.guardianListUnitFilesFailuresRemaining -= 1
    persist()
    process.exit(7)
  }
  for (const [name, unit] of Object.entries(state.units)) process.stdout.write(name + ' ' + unit.unitFileState + ' enabled\\n')
  process.exit(0)
}
if (args[1] === 'list-units') {
  if (state.controls.guardianListUnitsFailuresRemaining > 0
    && Object.values(state.units).some(unit => unit.starts > 0)) {
    state.controls.guardianListUnitsFailuresRemaining -= 1
    persist()
    process.exit(7)
  }
  for (const [name, unit] of Object.entries(state.units)) {
    process.stdout.write(name + ' loaded ' + unit.activeState + ' ' + unit.subState + ' DSH profile ' + unit.profile + '\\n')
  }
  process.exit(0)
}
if (args[1] === 'daemon-reload') {
  for (const [name, unit] of Object.entries(state.units)) {
    if (unit.unitFileState === 'masked-runtime') continue
    const wants = process.env.HOME + '/.config/systemd/user/default.target.wants/' + name
    unit.unitFileState = existsSync(wants) ? 'enabled' : 'disabled'
  }
  persist()
  state.controls.cachedLoadState = undefined
  state.controls.cachedLoadStateProfile = undefined
  persist()
  const profile = state.controls.replaceControlMaskOnUnmaskProfile
  const started = Object.values(state.units).some(unit => unit.starts > 0)
  if (profile && started && !state.controls.controlMaskReplaced) {
    const name = 'dsh-profile-' + profile + '.service'
    const maskPath = controlRoot + '/' + name
    try { renameSync(maskPath, maskPath + '.superseded') } catch {}
    symlinkSync('/dev/null', maskPath)
    const replacement = lstatSync(maskPath)
    state.units[name].replacementMaskIdentity = { dev: String(replacement.dev), ino: String(replacement.ino) }
    state.controls.controlMaskReplaced = true
    persist()
  }
  process.exit(0)
}
if (args[1] === 'show') {
  const unit = state.units[args[2]]
  if (!unit) process.exit(4)
  if ((state.controls.ownershipChangesProfile === unit.profile
    && (state.stopObservations?.length ?? 0) > 0
    || state.controls.ownershipChangesAfterStartProfile === unit.profile
      && Object.values(state.units).some(candidate => candidate.starts > 0))
    && unit.reportedDshHome !== originalHome) {
    unit.reportedDshHome = originalHome
    persist()
  }
  if (state.controls.guardianOwnershipShowFailsProfile === unit.profile && unit.starts > 0
    && args.includes('--property=Environment') && args.includes('--property=WorkingDirectory')
    && state.controls.guardianOwnershipShowFailuresRemaining > 0) {
    state.controls.guardianOwnershipShowFailuresRemaining -= 1
    persist()
    process.exit(7)
  }
  const controlMaskPath = controlRoot + '/' + args[2]
  const lifecycleGuardPath = controlRoot + '/' + args[2] + '.d/dsh-enhanced-lifecycle.conf'
  let controlMasked = false
  try { controlMasked = lstatSync(controlMaskPath).isSymbolicLink() } catch {}
  const dropIns = [...unit.dropIns]
  try { if (lstatSync(lifecycleGuardPath).isFile()) dropIns.unshift(lifecycleGuardPath) } catch {}
  if (state.controls.restartLoopProfile === unit.profile && unit.starts > 0 && unit.activeState === 'active') {
    unit.nRestarts += 1
    unit.invocationId = 'loop-' + unit.profile + '-' + unit.nRestarts
    unit.mainPid += 1
    persist()
  }
  const properties = [
    ['Id', state.controls.rawIdMismatchProfile === unit.profile ? 'dsh-profile-wrong.service' : args[2]],
    ['LoadState', state.controls.cachedLoadStateProfile === unit.profile ? state.controls.cachedLoadState
      : controlMasked || unit.unitFileState === 'masked-runtime' ? 'masked' : 'loaded'],
    ['FragmentPath', unit.fragmentPath],
    ['DropInPaths', dropIns.join(' ')],
    ['ActiveState', unit.activeState],
    ['SubState', unit.subState],
    ['MainPID', state.controls.rawBlankNumericProfile === unit.profile ? '' : unit.mainPid],
    ['ControlPID', unit.controlPid],
    ['InvocationID', unit.invocationId],
    ['NRestarts', unit.nRestarts],
    ['UnitFileState', controlMasked ? 'masked' : unit.unitFileState],
    ['WorkingDirectory', controlMasked && state.controls.maskedMetadataEmpty ? '' : unit.workingDirectory],
    ['Environment', controlMasked && state.controls.maskedMetadataEmpty ? '' : [
      'DSH_HOME=' + unit.reportedDshHome, 'PATH=' + unit.pathEnvironment,
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/' + process.getuid() + '/bus',
      'XDG_RUNTIME_DIR=/run/user/' + process.getuid(),
      ...Object.entries(unit.serviceEnvironment ?? {}).sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => name + '=' + value),
    ].map((value, index) => index < 4 ? value : JSON.stringify(value)).join(' ')],
    ['ExecStart', '{ path=' + process.execPath + ' ; argv[]=' + process.execPath + ' '
      + '--disable-warning=ExperimentalWarning ' + dshExecutable + ' --profile ' + unit.profile + ' --no-open ; ignore_errors=no ; }'],
  ]
  const requested = new Set(args.filter(value => value.startsWith('--property='))
    .map(value => value.slice('--property='.length)))
  process.stdout.write(properties
    .filter(([name]) => requested.size === 0 || requested.has(name))
    .filter(([name]) => !(controlMasked && state.controls.maskedStaticMetadataOmitted
      && ['FragmentPath', 'DropInPaths', 'ExecStart'].includes(name)))
    .map(([name, value]) => name + '=' + value).join('\\n') + '\\n')
  process.exit(0)
}
if (args[1] === 'mask' && args[2] === '--runtime') {
  for (const name of args.slice(3)) {
    const unit = state.units[name]
    if (!unit) continue
    if (unit.unitFileState !== 'masked-runtime') unit.unitFileStateBeforeMask = unit.unitFileState
    unit.unitFileState = 'masked-runtime'
  }
  persist()
  process.exit(0)
}
if (args[1] === 'unmask' && args[2] === '--runtime') {
  for (const name of args.slice(3)) {
    const unit = state.units[name]
    if (!unit) continue
    const maskPath = controlRoot + '/' + name
    try {
      unit.boundMaskPresentWhenRuntimeUnmasked = lstatSync(maskPath).isSymbolicLink()
        && readlinkSync(maskPath) === '/dev/null'
    } catch { unit.boundMaskPresentWhenRuntimeUnmasked = false }
    try {
      const manifest = JSON.parse(readFileSync(originalHome + '.dsh-enhanced-transaction/manifest.json', 'utf8'))
      unit.boundMaskPersistedWhenRuntimeUnmasked = manifest.containmentMasks.some(mask => (
        mask.unit === name && mask.guardianRuntimeMask === true
      ))
    } catch { unit.boundMaskPersistedWhenRuntimeUnmasked = false }
    unit.unitFileState = unit.unitFileStateBeforeMask ?? 'enabled'
    if (state.controls.replaceControlMaskOnUnmaskProfile === unit.profile) {
      const maskPath = controlRoot + '/' + name
      renameSync(maskPath, maskPath + '.superseded')
      symlinkSync('/dev/null', maskPath)
      const replacement = lstatSync(maskPath)
      unit.replacementMaskIdentity = { dev: String(replacement.dev), ino: String(replacement.ino) }
    }
  }
  persist()
  process.exit(0)
}
if (args[1] === 'disable' || args[1] === 'enable') {
  for (const name of args.slice(2)) {
    const unit = state.units[name]
    if (unit) unit.unitFileState = args[1] === 'disable' ? 'disabled' : 'enabled'
  }
  persist()
  process.exit(0)
}
if (args[1] === 'stop') {
  if (state.stopLegacyMarkerExists === undefined) {
    state.stopLegacyMarkerExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME
      + '.dsh-enhanced-transaction/legacy-v1-marker')
  }
  for (const name of args.slice(2)) {
    const unit = state.units[name]
    if (!unit) continue
    const maskPath = process.env.HOME + '/.config/systemd/user.control/' + name
    try { unit.maskPresentWhenStopped = lstatSync(maskPath).isSymbolicLink() } catch { unit.maskPresentWhenStopped = false }
    state.stopObservations = [...(state.stopObservations ?? []), {
      unit: name, maskPresent: unit.maskPresentWhenStopped, unitFileState: unit.unitFileState,
    }]
    if (state.controls.stopFailsProfile === unit.profile) { persist(); process.exit(5) }
    const leavesFailed = state.controls.stopLeavesFailedProfile === unit.profile
    unit.activeState = leavesFailed ? 'failed' : 'inactive'
    unit.subState = leavesFailed ? 'failed' : 'dead'
    if (state.controls.pidStuckProfile !== unit.profile) unit.mainPid = 0
  }
  persist()
  const mutation = state.controls.dropInMutation
  if (mutation) {
    const dropIn = Object.values(state.units).flatMap(unit => unit.dropIns)[0]
    if (dropIn) {
      if (mutation === 'identity') { writeFileSync(dropIn + '.replacement', '[Unit]\\nAfter=changed.service\\n'); renameSync(dropIn + '.replacement', dropIn) }
      else appendFileSync(dropIn, '# changed\\n')
    }
  }
  if (state.controls.journal === 'missing') unlinkSync(journalExecutable)
  process.exit(0)
}
if (args[1] === 'reset-failed') {
  for (const name of args.slice(2)) {
    const unit = state.units[name]
    if (!unit) continue
    if (unit.activeState === 'failed' && unit.mainPid === 0 && unit.controlPid === 0) {
      unit.activeState = 'inactive'
      unit.subState = 'dead'
    }
  }
  persist()
  process.exit(0)
}
if (args[1] === 'start' || args[1] === 'restart') {
  const starting = args.slice(2).map(name => state.units[name]).filter(Boolean)
  if (!state.controls.crashTriggered
    && starting.some(unit => state.controls.crashBeforeStartProfile === unit.profile)) {
    state.controls.crashTriggered = true
    persist()
    process.kill(process.ppid, 'SIGKILL')
    process.exit(99)
  }
  for (const name of args.slice(2)) {
    const unit = state.units[name]
    if (!unit) continue
    try { if (lstatSync(controlRoot + '/' + name).isSymbolicLink()) process.exit(8) } catch {}
    if (unit.unitFileState === 'masked-runtime') process.exit(8)
    if (state.controls.startFailsProfile === unit.profile) { persist(); process.exit(6) }
    unit.starts += 1
    if (state.controls.readinessFailsProfile === unit.profile) {
      unit.activeState = 'failed'; unit.subState = 'failed'; unit.mainPid = 0
    } else {
      state.nextPid += 1
      unit.activeState = 'active'; unit.subState = 'running'; unit.mainPid = state.nextPid
      unit.invocationId = 'fresh-' + unit.profile + '-' + state.nextPid
    }
    if (!state.controls.lifecycleParentKilled
      && state.controls.killLifecycleDuringStartProfile === unit.profile) {
      let lifecyclePid = process.ppid
      for (let depth = 0; depth < 8 && lifecyclePid > 1; depth += 1) {
        const command = readFileSync('/proc/' + lifecyclePid + '/cmdline', 'utf8')
        if (command.includes('lifecycle-profile.mjs')) break
        const parentLine = readFileSync('/proc/' + lifecyclePid + '/status', 'utf8')
          .split(String.fromCharCode(10)).find(line => line.startsWith('PPid:'))
        lifecyclePid = Number(parentLine?.trim().split(' ').filter(Boolean)[1])
      }
      state.controls.lifecycleParentKilled = true
      state.controls.killedLifecyclePid = lifecyclePid
      persist()
      if (Number.isSafeInteger(lifecyclePid) && lifecyclePid > 1) process.kill(lifecyclePid, 'SIGKILL')
    }
  }
  if (state.controls.dynamicProfile && !state.controls.dynamicAdded) {
    const source = starting[0]
    const profile = state.controls.dynamicProfile
    const name = 'dsh-profile-' + profile + '.service'
    const fragmentPath = source.fragmentPath.replace(source.unit ?? args[2], name)
    writeFileSync(fragmentPath, readFileSync(source.fragmentPath, 'utf8').replaceAll(source.profile, profile))
    state.units[name] = {
      ...source, profile, activeState: 'active', subState: 'running', mainPid: ++state.nextPid,
      invocationId: 'dynamic-' + profile + '-' + state.nextPid, starts: 1,
      fragmentPath, unitFileState: 'enabled', unitFileStateBeforeMask: 'enabled', dropIns: [],
      ...(state.controls.dynamicReportedDshHome ? { reportedDshHome: state.controls.dynamicReportedDshHome } : {}),
    }
    state.controls.dynamicAdded = true
  }
  persist()
  process.exit(0)
}
process.exit(91)
`)
    await writeExecutable(join(fakeBin, 'journalctl'), `#!${process.execPath}
const { appendFileSync, existsSync, renameSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const statePath = ${JSON.stringify(systemdState)}
const state = require(statePath)
const persist = () => {
  const temporary = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(state) + '\\n', { mode: 0o600 })
  renameSync(temporary, statePath)
}
appendFileSync(${JSON.stringify(journalLog)}, JSON.stringify(args) + '\\n')
if (state.controls.journal === 'fail') process.exit(7)
const invocation = args.find(value => value.startsWith('_SYSTEMD_INVOCATION_ID='))?.slice('_SYSTEMD_INVOCATION_ID='.length)
const lines = []
if (state.controls.journal !== 'stale' && invocation?.startsWith('fresh-')) {
  lines.push(${JSON.stringify(readinessLine)}, 'lark-channel: connected')
  if (state.controls.larkDisconnectAfterConnect) lines.push('lark-channel: disconnected')
  // F5：swap 完成（原 home 出现 upgraded 标记）之后，在稳定性窗口的第 2 个
  // 样本上制造 connected→disconnected→connected。末点状态复原，两点采样
  // 抓不住；只有逐行审查窗口内新增状态行才能拒绝。
  if (state.controls.larkFlapAfterAccept) {
    const profile = invocation.split('-')[1]
    const swapped = existsSync(join(${JSON.stringify(join(dshHome, 'profiles'))}, profile, 'upgraded'))
    if (swapped) {
      state.controls.larkFlapQuery = (state.controls.larkFlapQuery ?? 0) + 1
      persist()
      if (state.controls.larkFlapQuery === 4) lines.push('lark-channel: disconnected', 'lark-channel: connected')
    }
  }
  if (state.controls.larkFlapAtReadinessBaseline) {
    state.controls.larkReadinessQuery = (state.controls.larkReadinessQuery ?? 0) + 1
    persist()
    if (state.controls.larkReadinessQuery === 3) lines.push('lark-channel: disconnected', 'lark-channel: connected')
  }
} else {
  lines.push('old invocation did not become ready')
}
process.stdout.write(lines.join('\\n') + '\\n')
`)
    await writeExecutable(join(fakeBin, 'bwrap'), `#!${process.execPath}
const { appendFileSync, realpathSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const separator = args.indexOf('--')
const environment = {}
const controls = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('LIFECYCLE_')))
let stageHome
let logicalHome
let validatorFd
let validatorPath
let validatorMode
const readonlyBindings = {}
for (let index = 0; index < separator; index += 1) {
  if (args[index] === '--setenv') { environment[args[index + 1]] = args[index + 2]; index += 2; continue }
  if (args[index] === '--bind') { stageHome = args[index + 1]; logicalHome = args[index + 2]; index += 2; continue }
  if (args[index] === '--bind-fd') { stageHome = realpathSync('/proc/self/fd/' + args[index + 1]); logicalHome = args[index + 2]; index += 2; continue }
  if (args[index] === '--perms') { validatorMode = args[index + 1]; index += 1; continue }
  if (args[index] === '--ro-bind-data') { validatorFd = args[index + 1]; validatorPath = args[index + 2]; index += 2; continue }
  if (args[index] === '--ro-bind-fd') { readonlyBindings[args[index + 2]] = args[index + 1]; index += 2; continue }
  if (args[index] === '--ro-bind') { index += 2; continue }
  if (args[index] === '--tmpfs' || args[index] === '--proc' || args[index] === '--dev') { index += 1 }
}
if (controls.LIFECYCLE_BWRAP_LOG) appendFileSync(controls.LIFECYCLE_BWRAP_LOG, JSON.stringify(args) + '\\n')
if (separator < 0 || !args.includes('--unshare-all') || args.includes('--share-net') || !stageHome || !logicalHome
  || validatorMode !== '0400' || validatorFd !== '4' || validatorPath !== '/run/dsh-enhanced-lifecycle-config.mjs') {
  process.stderr.write('fake bwrap rejected unsafe or incomplete sandbox arguments: ' + JSON.stringify({ separator, stageHome, logicalHome, validatorMode, validatorFd, validatorPath }) + '\\n')
  process.exit(97)
}
if (controls.LIFECYCLE_REQUIRE_PNPM_STORE_FD === '1' && (args.slice(separator + 1).includes('install') || args.slice(separator + 1).includes('config'))
  && (readonlyBindings[${JSON.stringify(pnpmStorePath)}] !== '5'
    || realpathSync('/proc/self/fd/' + readonlyBindings[${JSON.stringify(pnpmStorePath)}]) !== ${JSON.stringify(pnpmStorePath)}
    || readonlyBindings['/run/dsh-enhanced-pnpm-cache'] !== '6')) {
  process.stderr.write('fake bwrap missing exact read-only pnpm store/cache fds ' + JSON.stringify(readonlyBindings) + '\\n')
  process.exit(96)
}
for (const [key, value] of Object.entries(environment)) {
  if (value === logicalHome || value.startsWith(logicalHome + '/')) environment[key] = stageHome + value.slice(logicalHome.length)
}
Object.assign(environment, controls)
for (const key of ['LIFECYCLE_ACTIVATION_MARKER']) {
  const value = environment[key]
  if (value === logicalHome || value.startsWith(logicalHome + '/')) environment[key] = stageHome + value.slice(logicalHome.length)
}
const command = args.slice(separator + 1)
let validatorCommand = false
for (let index = 0; index < command.length; index += 1) {
  const value = command[index]
  if (value === logicalHome || value.startsWith(logicalHome + '/')) command[index] = stageHome + value.slice(logicalHome.length)
  else if (value === validatorPath) { command[index] = '/proc/self/fd/' + validatorFd; validatorCommand = true }
}
if (validatorCommand) command.splice(1, 0, '--preserve-symlinks-main')
const result = spawnSync(command[0], command.slice(1), {
  env: environment, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe', 3, 4],
})
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) { process.stderr.write(String(result.error) + '\\n'); process.exit(98) }
process.exit(result.status ?? 99)
`)
    return {
      root, dshHome, profileDirectory, fakeBin, databasePath, dshLog, bwrapLog, operationLog, supervisedOperatorLog, lifecycleTarget,
      activationMarker: join(dshHome, '.activation-ran'),
      fixtureInstallDirectory, fixtureInstallerLibrary, journalLog, systemdHome, systemdLog, systemdState,
    }
  }

  // The outer transaction is real; only trusted installer capability APIs and
  // systemd/bwrap are deterministic fixtures. Real signed-source/package contracts
  // are covered by lark-channel's source-maintenance and local-package suites.
  async function preOwnerLifecycleFixture({ baseServices = false, memoryExtension = false, temporaryParent }: { baseServices?: boolean; memoryExtension?: boolean; temporaryParent?: string } = {}) {
    const f = await lifecycleFixture({ ...(temporaryParent === undefined ? {} : { temporaryParent }), systemd: { units: [{ profile: 'web', active: true }] }, ...(baseServices ? { readiness: 'host' as const } : {}) })
    const candidateLock = "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  fixture-native@1.0.0:\n    resolution: {integrity: sha512-fixture}\nsnapshots:\n  fixture-native@1.0.0: {}\n"
    const bootRoot = join(f.root, 'fake-host', 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    await rm(bootRoot)
    await mkdir(join(bootRoot, 'lib'), { recursive: true })
    await writeFile(join(bootRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: '0.2.1-rc.2',
      type: 'module', exports: { '.': './lib/index.js', './package.json': './package.json' } }))
    await writeFile(join(bootRoot, 'lib/index.js'), `export function loadProfileDirectory(name, dir, installAnchor) {
  if (name !== 'dsh' || !dir.endsWith('/profiles/web') || !installAnchor.endsWith('/@deepseek-ai/dsh/package.json')) throw new Error('wrong Host profile')
  return { dir }
}
export async function healProfilesModuleFallback({ installAnchor, profile, home }) {
  if (!installAnchor.endsWith('/@deepseek-ai/dsh/package.json') || profile.dir !== home + '/profiles/web') throw new Error('wrong Host fallback')
}
export async function createRuntimeResolution({ installAnchor, profile, home }) {
  if (!installAnchor.endsWith('/@deepseek-ai/dsh/package.json') || profile.dir !== home + '/profiles/web') throw new Error('wrong Host resolution')
  return { entries: [{ name: '@deepseek-ai/cordis', scope: 'installation' }] }
}
`)
    if (baseServices || memoryExtension) await writeFile(join(f.dshHome, '.lifecycle-dump-config'), stringify([
      { id: 'dsh-enhanced-lark-channel', name: '@dsh-enhanced/lark-channel', config: { enabled: true } },
      { id: 'dsh-enhanced-assistant-recovery', name: '@dsh-enhanced/assistant-recovery', config: { jobs: [] } },
      { id: 'dsh-enhanced-plugin-control-plane', name: '@dsh-enhanced/plugin-control-plane', config: {} },
      ...(memoryExtension ? [{ id: 'dsh-enhanced-personal-assistant', name: '@dsh-enhanced/personal-assistant',
        config: { assistantAutomations: { schedulerEnabled: false } } }] : []),
    ]))
    const cachePath = join(f.root, 'pnpm-cache'), storeAlias = join(f.root, 'pnpm-store-alias')
    await mkdir(cachePath, { mode: 0o700 })
    await writeFile(join(cachePath, 'original-cache'), 'original cache', { mode: 0o600 })
    await writeFile(join(f.root, 'pnpm-store', 'original-store'), 'original store', { mode: 0o600 })
    await symlink(join(f.root, 'pnpm-store'), storeAlias)
    await mkdir(join(f.profileDirectory, 'node_modules'), { recursive: true })
    await writeFile(join(f.profileDirectory, 'node_modules', '.modules.yaml'), stringify({ storeDir: storeAlias }), { mode: 0o600 })
    const pnpmPath = join(f.fakeBin, 'pnpm')
    await writeFile(pnpmPath, (await readFile(pnpmPath, 'utf8'))
      .replaceAll('"@jsr:registry":"https://npm.jsr.io/"',
        `"@jsr:registry":"https://npm.jsr.io/","cacheDir":${JSON.stringify(cachePath)},"ignoreScripts":true,"ignorePnpmfile":true,"trustLockfile":false,"pmOnFail":"error","managePackageManagerVersions":false,"packageManagerStrict":true,"packageManagerStrictVersion":true`))
    // Candidate-only command support; the shared legacy pnpm fixture stays intact.
    const candidatePnpm = `
if [[ "$directory" == *'/.dsh-local-candidate-'* ]]; then
  if [[ "\${arguments[0]:-}" == 'add' ]]; then
    [[ " \${arguments[*]} " == *' --lockfile-only --force --ignore-scripts --reporter=ndjson '* ]] || exit 87
    printf 'candidate-add\\t%s\\toffline=%s\\t%s\\n' "$transaction_state" "\${pnpm_config_offline:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
    [[ "\${LIFECYCLE_CANDIDATE_FAILURE:-}" != 'add' ]] || { echo 'candidate add failed' >&2; exit 88; }
    node - "$directory" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(process.argv[2],'pnpm-lock.yaml'),${JSON.stringify(candidateLock)});
if(process.env.LIFECYCLE_CANDIDATE_FAILURE==='external-preparation')fs.appendFileSync(process.env.LIFECYCLE_PREPARED_RECEIPT_PATH,'external mutation');
NODE
    if [[ "\${LIFECYCLE_CANDIDATE_FAILURE:-}" == 'optional-resolution' ]]; then printf '{"name":"pnpm:skipped-optional-dependency","reason":"resolution_failure"}\\n'; fi
    exit 0
  fi
  if [[ "\${arguments[0]:-}" == 'fetch' ]]; then
    printf 'candidate-fetch\\t%s\\toffline=%s\\t%s\\n' "$transaction_state" "\${pnpm_config_offline:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
    [[ "\${LIFECYCLE_CANDIDATE_FAILURE:-}" != 'fetch' ]] || { echo 'candidate fetch failed' >&2; exit 89; }
    exit 0
  fi
  if [[ "\${arguments[0]:-}" == 'install' ]]; then
    if [[ " \${arguments[*]} " == *' --offline '* ]]; then
      printf 'candidate-offline-verify\\t%s\\toffline=%s\\t%s\\n' "$transaction_state" "\${pnpm_config_offline:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
      if [[ "\${LIFECYCLE_CANDIDATE_FAILURE:-}" == 'offline-optional-resolution' ]]; then printf '{"name":"pnpm:skipped-optional-dependency","reason":"resolution_failure"}\\n'; fi
      if [[ "\${LIFECYCLE_CANDIDATE_FAILURE:-}" == 'offline-graph-drift' ]]; then printf 'drifted: true\\n' >> "$directory/pnpm-lock.yaml"; fi
      exit 0
    fi
    printf 'candidate-verify\\t%s\\toffline=%s\\t%s\\n' "$transaction_state" "\${pnpm_config_offline:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
    [[ ! -e "\${pnpm_config_cache_dir:?}/lockfile-verified.jsonl" ]] || { echo 'candidate verification reused a warm receipt' >&2; exit 86; }
    [[ "\${LIFECYCLE_CANDIDATE_FAILURE:-}" != 'verify' ]] || { echo 'candidate verify failed' >&2; exit 90; }
    node - "$directory/pnpm-lock.yaml" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const p=process.argv[2],s=fs.statSync(p,{bigint:true}),logical=path.join(process.env.LIFECYCLE_ORIGINAL_HOME,'profiles','web','pnpm-lock.yaml');
const policy={tarballUrlBinding:true,minimumReleaseAge:0,minimumReleaseAgeExclude:[],trustPolicy:null,trustPolicyExclude:[],trustPolicyIgnoreAfter:null,resolutionShapeCheck:true,dependencyAliasCheck:true};
if(process.env.LIFECYCLE_CANDIDATE_FAILURE==='policy')delete policy.dependencyAliasCheck;
fs.writeFileSync(path.join(process.env.pnpm_config_cache_dir,'lockfile-verified.jsonl'),JSON.stringify({lockfile:{path:logical,size:Number(s.size),inode:String(s.ino),mtimeNs:String(s.mtimeNs),hash:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('base64')},policy})+'\\n');
for(const status of ['started','done'])if(process.env.LIFECYCLE_CANDIDATE_FAILURE!=='missing-'+status)console.log(JSON.stringify({name:'pnpm:lockfile-verification',level:'debug',status,entries:1,lockfilePath:logical,...(status==='done'?{elapsedMs:1}:{})}));
NODE
    exit 0
  fi
fi
`
    const candidateAddHead = 'if [[ "${arguments[0]:-}" == \'add\''
    await writeFile(pnpmPath, (await readFile(pnpmPath, 'utf8')).replace(candidateAddHead, candidatePnpm + '\n' + candidateAddHead))
    writePreOwnerPnpmFixtureEnvironment(f)
    await chmod(f.dshHome, 0o755)
    await mkdir(join(f.dshHome, 'profiles', 'node_modules'))
    const moduleRoot = join(f.root, 'reviewed-installer')
    for (const directory of ['plugins/lark-channel/lib', 'packages', 'scripts/install', 'node_modules']) await mkdir(join(moduleRoot, directory), { recursive: true })
    const require = createRequire(import.meta.url)
    await cp(dirname(require.resolve('yaml/package.json')), join(moduleRoot, 'node_modules/yaml'), { recursive: true })
    await cp(f.fixtureInstallDirectory, join(moduleRoot, 'scripts/install'), { recursive: true })
    await writeFile(join(moduleRoot, 'package.json'), '{"type":"module"}', { mode: 0o600 })
    await writeFile(join(moduleRoot, 'plugins/lark-channel/package.json'), '{"type":"module"}', { mode: 0o600 })
    await writeFile(join(moduleRoot, 'pnpm-lock.yaml'), 'fixture-lock', { mode: 0o600 })
    const preparationRoot = join(f.root, 'prepared-update')
    await mkdir(preparationRoot)
    await writeFile(join(preparationRoot, 'receipt.json'), '{"revision":"prepared"}\n', { mode: 0o600 })
    for (const kind of ['rsi-sources', 'rsi-local-cohorts', 'rsi-builds', 'rsi-release-builds', 'rsi-authority-runtimes']) {
      await mkdir(join(f.dshHome, kind, 'web'), { recursive: true, mode: 0o700 })
      await writeFile(join(f.dshHome, kind, 'web', 'receipt.json'), '{"revision":"old"}', { mode: 0o600 })
    }
    const preOwnerAuthority = join(f.dshHome, 'rsi-authorities', 'web')
    for (const name of ['config', 'identities', 'registry', 'state']) {
      await mkdir(join(preOwnerAuthority, name), { recursive: true, mode: 0o700 })
    }
    await writeFile(join(preOwnerAuthority, 'bootstrap.json'), '{"revision":"old"}', { mode: 0o600 })
    await writeFile(join(preOwnerAuthority, 'catalog.json'), '{"schemaVersion":1,"entries":[]}', { mode: 0o600 })
    const source = `
import { readFile, writeFile, lstat, realpath, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const kinds = ['rsi-sources','rsi-local-cohorts','rsi-builds','rsi-release-builds','rsi-authorities','rsi-authority-runtimes']
async function canonicalStage(path) {
 if(await realpath(path) !== path) throw new Error('stage must be a distinct canonical stopped Home')
 if((await lstat(path)).mode & 0o077) throw new Error('stage Home must be private')
}
export async function readRsiSourceMaintenance(input) {
 await realpath(input.logicalHome)
 const revision = JSON.parse(await readFile(join(input.physicalHome,'rsi-sources',input.profile,'receipt.json'),'utf8')).revision
 return { anchor: { installationId:'fixture-installation' }, records: [], workspace: { revision }, originalBootstrapDigest:'a'.repeat(64) }
}
export async function assertRsiPreOwnerInstallation(input) {
 try { await lstat(join(input.physicalHome,'owner-residue')); throw new Error('owner/coordinator rejected') }
 catch(error) { if(error.code !== 'ENOENT') throw error }
}
export async function readRsiLocalCohort(input) { return { sourceRepository:${JSON.stringify(join(f.root, 'upstream'))}, bundles:['personal-assistant'], receiptDigest:'c'.repeat(64),allowBuilds:{}, packages:[{name:'@dsh-enhanced/personal-assistant',bundle:true,tarball:join(input.dshHome,'rsi-local-cohorts',input.profile,'personal-assistant.tgz')}] } }
export function rsiLocalDependencyOverrides() { return {} }
export async function rsiLocalPeerOverrides() { return {} }
export function mergeRsiLocalOverrides(source) { return source }
export async function planRsiLocalProfilePackages(input) { return {workspace:'nodeLinker: isolated\\noverrides: {}\\n',bundles:input.bundles,tarballs:input.candidate.packages.map(p=>p.tarball)} }
export async function installRsiLocalProfile(input) {
 const profile=join(input.dshHome,'profiles',input.profile);
 try { await lstat(join(profile,'node_modules'));throw new Error('candidate native install reused node_modules') }catch(e){if(e.code!=='ENOENT')throw e}
 const r=spawnSync(input.dsh.path,['plugin','--profile',input.profile,'add',...input.cohort.packages.map(p=>p.tarball)],{env:{...process.env,DSH_HOME:input.dshHome},encoding:'utf8'});
 if(r.status!==0)throw new Error('candidate offline native failed: '+r.stderr);
 await mkdir(join(profile,'node_modules'));
}
export async function verifyRsiLocalInstalledPackages(input) {
 const value = await readFile(join(input.profilePath,'node_modules/@dsh-enhanced/plugin-control-plane/lib/entry.js'),'utf8')
 if(value !== 'approved-package-bytes') throw new Error('installed package file differs')
}
export async function readRsiLocalUpdateLocked(input) { return {receiptDigest:createHash('sha256').update(await readFile(join(input.root,'receipt.json'))).digest('hex'),source:{root:${JSON.stringify(join(preparationRoot, 'source'))}},build:{sourceBuild:{schemaVersion:1}},
 ...(${JSON.stringify(memoryExtension)} ? {schemaVersion:2,extension:'memory-learning'} : {})} }
export async function stageRsiLocalUpdateResources(input) {
 await canonicalStage(input.stagePhysicalHome)
 for(const kind of kinds.slice(1,4)) await writeFile(join(input.stagePhysicalHome,kind,input.profile,'receipt.json'),'{"revision":"new"}')
 return {cohort:{},proof:{}}
}
export async function produceRsiLocalSourceMaintenance(input) { await canonicalStage(input.stagePhysicalHome); if(input.maintenanceMode !== 'pre-owner') throw new Error('wrong mode');return {host:null} }
export async function applyRsiSourceMaintenanceInStage(input) { await canonicalStage(input.physicalHome); await writeFile(join(input.physicalHome,'rsi-sources',input.profile,'receipt.json'),'{"revision":"new"}') }
export async function stageRsiLocalSinglePackages(input) {
 if(input.rootExtension !== ${JSON.stringify(memoryExtension ? 'memory-learning' : null)}${memoryExtension ? '' : ' && input.rootExtension !== undefined'}) throw new Error('frozen memory extension was not passed to package staging')
 if(process.env.pnpm_config_frozen_store !== 'false' || process.env.pnpm_config_offline !== 'true'
  || process.env.pnpm_config_ignore_scripts !== 'true' || process.env.pnpm_config_ignore_pnpmfile !== 'true') throw new Error('unsafe private package cache configuration')
 await writeFile(join(process.env.pnpm_config_store_dir,'package-install-marker'),'private store mutation')
 await writeFile(join(process.env.pnpm_config_cache_dir,'package-install-marker'),'private cache mutation')
 if(process.env.LIFECYCLE_PACKAGE_FAILS === '1') throw new Error('fixture package failure')
 ${memoryExtension ? `await writeFile(join(input.dshHome,'.lifecycle-dump-config'),
   (await readFile(join(input.dshHome,'.lifecycle-dump-config'),'utf8')) + ${JSON.stringify(stringify([rsiMemoryLearningInitialRow]))})` : ''}
 await writeFile(join(input.dshHome,'profiles',input.profile,'pnpm-lock.yaml'),${JSON.stringify(candidateLock)})
 await writeFile(join(input.dshHome,'profiles',input.profile,'pnpm-workspace.yaml'),'nodeLinker: isolated\\noverrides: {}\\n')
 if(process.env.LIFECYCLE_CANDIDATE_FAILURE==='final-graph-drift')await writeFile(join(input.dshHome,'profiles',input.profile,'pnpm-lock.yaml'),'drifted: true\\n')
 await writeFile(join(input.dshHome,'profiles',input.profile,'upgraded'),'upgraded\\n')
 return {schemaVersion:1,profile:input.profile,cohortDigest:'c'.repeat(64),files:{}}
}
export async function replaceRsiAuthorityRuntimeInStage(input, source) {
 await canonicalStage(input.physicalHome)
 if(!source.packageRoot.startsWith(input.physicalHome + '/')) throw new Error('authority source remap is outside canonical stage')
 const logicalSource = input.logicalHome + source.packageRoot.slice(input.physicalHome.length)
 await writeFile(join(input.physicalHome,'rsi-authority-runtimes',input.profile,'receipt.json'),JSON.stringify({revision:'new',logicalSource}))
}
export function buildSupervisedGrowthPreviewOverlay() { return '[]\\n' }
export function assertSupervisedGrowthPreviewDerivation() { return {externalProviderExemptions:['larkChannel']} }
`
    await writeFile(join(f.dshHome,'rsi-local-cohorts/web/personal-assistant.tgz'),'fixture candidate tarball',{mode:0o600})
    for (const name of ['rsi-local-update','rsi-source-maintenance','rsi-local-activation','rsi-local-pair-install','rsi-local-install','rsi-local-roots-extension','rsi-local-cohort','rsi-local-profile-update','rsi-authority-runtime','supervised-growth-profile']) {
      await writeFile(join(moduleRoot, 'plugins/lark-channel/lib', `${name}.js`), name === 'rsi-local-activation' ? source
        : name === 'rsi-local-profile-update' ? 'export function assertRsiLocalProfileRoots({source}) { if(!JSON.parse(source).dsh)throw new Error("fixture profile roots missing") }\n'
        : name === 'rsi-local-roots-extension' ? `export const rsiMemoryLearningInitialRow = ${JSON.stringify(rsiMemoryLearningInitialRow)}\n`
          : 'export {}\n', { mode: 0o600 })
    }
    // This fake namespace remaps JSON locators just as a real bwrap Home mount
    // does. The production helper has no environment-controlled test seam.
    const bwrapPath = join(f.fakeBin, 'bwrap')
    const bwrapSource = await readFile(bwrapPath, 'utf8')
    const candidateNamespace = `
if (!validatorFd && args.includes('--clearenv')) {
 const fs=require('node:fs'),path=require('node:path');
 if(controls.LIFECYCLE_BWRAP_LOG)fs.appendFileSync(controls.LIFECYCLE_BWRAP_LOG,JSON.stringify(args)+'\\n');
 if(separator<0||!args.includes('--unshare-all')||!stageHome||Object.keys(writableBindings).length!==2)throw new Error('candidate namespace mounts missing');
 const cache=writableBindings['/run/dsh-enhanced-local-pnpm-cache'],storeEntry=Object.entries(writableBindings).find(([target])=>target==='/run/dsh-enhanced-local-pnpm-store'||target.startsWith('/run/dsh-enhanced-local-pnpm-store/'));
 const store=storeEntry?.[1],storeTarget=storeEntry?.[0];
 if(!cache||!store)throw new Error('candidate private package caches missing');
 const remapString=v=>{for(const [from,to]of [[logicalHome,stageHome],['/run/dsh-enhanced-local-pnpm-cache',cache],[storeTarget,store]])if(v===from||v.startsWith(from+'/'))return to+v.slice(from.length);return v};
 for(const [k,v]of Object.entries(environment))environment[k]=remapString(v);
 if(storeTarget!=='/run/dsh-enhanced-local-pnpm-store'&&environment.pnpm_config_store_dir==='/run/dsh-enhanced-local-pnpm-store')environment.pnpm_config_store_dir=path.resolve(store,...path.relative('/run/dsh-enhanced-local-pnpm-store',storeTarget).split('/').map(()=>'..'));
 Object.assign(environment,controls);
 const command=args.slice(separator+1).map(remapString);
 const homeNames=fs.readdirSync(stageHome).sort();
 if(homeNames.some(n=>!['profiles','rsi-local-cohorts','.candidate-install.json'].includes(n)))throw new Error('candidate anonymous Home leaked runtime state');
 const profile=path.join(stageHome,'profiles','web');
 if(fs.readFileSync(path.join(profile,'cordis.patch.yml'),'utf8')!=='[]\\n')throw new Error('candidate copied live patch');
 if(command.includes('candidate-install')){
   if(args.includes('--share-net'))throw new Error('candidate native install retained network');
   const input=command.at(-1),remap=v=>typeof v==='string'?remapString(v):Array.isArray(v)?v.map(remap):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,remap(x)])):v;
   fs.writeFileSync(input,JSON.stringify(remap(JSON.parse(fs.readFileSync(input,'utf8')))));
 } else if(!command.includes('config')&&!command.includes('--offline')&&!args.includes('--share-net'))throw new Error('candidate online phase has no network flag');
 const transactionState=fs.existsSync(controls.LIFECYCLE_ORIGINAL_HOME+'.dsh-enhanced-transaction')?'present':'absent';
 fs.appendFileSync(controls.LIFECYCLE_OPERATION_LOG,'candidate-sandbox\\t'+transactionState+'\\toffline='+environment.pnpm_config_offline+'\\t'+command.join(' ')+'\\n');
 const result=spawnSync(command[0],command.slice(1),{cwd:profile,env:environment,encoding:'buffer',stdio:['ignore','pipe','pipe',3,4,5,6,7]});
 if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);if(result.error)throw result.error;process.exit(result.status??99);
}
`
    await writeFile(bwrapPath, bwrapSource.replace('const readonlyBindings = {}', 'const readonlyBindings = {}\nconst writableBindings = {}')
      .replace("if (args[index] === '--bind-fd') { stageHome", "if (args[index] === '--bind-fd' && args[index + 1] !== '3') { writableBindings[args[index + 2]] = realpathSync('/proc/self/fd/' + args[index + 1]); index += 2; continue }\n  if (args[index] === '--bind-fd') { stageHome")
      .replace("if (controls.LIFECYCLE_BWRAP_LOG)", candidateNamespace + "\nif (controls.LIFECYCLE_BWRAP_LOG)")
      .replace('Object.assign(environment, controls)', `for(const [key,value] of Object.entries(environment)) {
 const destination = Object.keys(writableBindings).find(path => value === path || (() => { try { return realpathSync(value) === path } catch { return false } })())
 if(destination) environment[key] = writableBindings[destination]
}
Object.assign(environment, controls)`)
      .replace('const result = spawnSync(command[0], command.slice(1), {', `
if (command.includes(${JSON.stringify(join(f.fixtureInstallDirectory, 'local-source-maintenance.mjs'))})) {
 const fs = require('node:fs')
 const inputPath = command.at(-1)
 const remap = value => typeof value === 'string' && (value === logicalHome || value.startsWith(logicalHome + '/'))
   ? stageHome + value.slice(logicalHome.length) : Array.isArray(value) ? value.map(remap)
   : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key,remap(item)])) : value
 fs.writeFileSync(inputPath, JSON.stringify(remap(JSON.parse(fs.readFileSync(inputPath,'utf8')))))
}
const result = spawnSync(command[0], command.slice(1), {`))
    await writeFile(bwrapPath, (await readFile(bwrapPath, 'utf8')).replace('if (result.stdout) process.stdout.write(result.stdout)', `if (result.stdout && command.includes('candidate-plan')) {
 const restore=value=>typeof value==='string'&&(value===stageHome||value.startsWith(stageHome+'/'))?logicalHome+value.slice(stageHome.length):Array.isArray(value)?value.map(restore):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,restore(v)])):value;
 process.stdout.write(JSON.stringify(restore(JSON.parse(result.stdout.toString('utf8'))))+'\\n');
} else if (result.stdout) process.stdout.write(result.stdout)`))
    await mkdir(join(f.dshHome, 'assistant-delivery'), { recursive: true })
    await writeFile(join(f.dshHome, 'assistant-delivery', 'preview-queue.json'), '{"attempts":0,"pending":["owner-job"]}', { mode: 0o600 })
    // Model the pinned native prepareProfile write even for --dump-config.
    const nativePath = join(f.fakeBin, 'dsh')
    const activationHead = `if [[ " $* " == *' --host 127.0.0.1 --no-open --port 0 '* ]]; then`
    const nativeSource = (await readFile(nativePath, 'utf8')).replace(activationHead, activationHead + `\n  printf 'preview-claimed-job' > "$DSH_HOME/assistant-delivery/preview-queue.json"\n  printf 'preview-session-write' > "$DSH_HOME/sessions/owner-session.jsonl"`)
    const candidateNative = `
  if [[ "$DSH_HOME" == *'/.dsh-local-candidate-'* ]]; then
    printf 'candidate-native\\t%s\\toffline=%s\\t%s\\n' "$transaction_state" "\${pnpm_config_offline:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
    [[ "\${pnpm_config_offline:-}" == 'true' ]] || exit 84
    [[ ! -e "$DSH_HOME/profiles/web/node_modules" ]] || exit 85
    [[ "\${LIFECYCLE_CANDIDATE_FAILURE:-}" != 'offline' ]] || { echo 'candidate native install failed' >&2; exit 83; }
    exit 0
  fi
`
    const dumpSource = nativeSource.replace("  if [[ \"$LIFECYCLE_PACKAGE_FAILS\" == '1' ]]", candidateNative + "\n  if [[ \"$LIFECYCLE_PACKAGE_FAILS\" == '1' ]]").replace('  if [[ -n "$LIFECYCLE_SYSTEMD_SUPERVISED_PROFILE"',
      `  printf '[]\\n' > "$DSH_HOME/profiles/$requested_profile/cordis.yml"\n${baseServices || memoryExtension ? '  if [[ "$requested_profile" == \'web\' ]]; then cat "$DSH_HOME/.lifecycle-dump-config"; exit 0; fi\n' : ''}  if [[ -n "$LIFECYCLE_SYSTEMD_SUPERVISED_PROFILE"`)
    // Keep the shared v3 fake unchanged. This pre-owner fake composes CLI patches
    // by row id and replaces each supplied config as a whole native patch value.
    const composer = join(f.fakeBin, 'pre-owner-config-overlay.cjs')
    await writeFile(composer, `
const { readFileSync } = require('node:fs')
const yaml = require(${JSON.stringify(require.resolve('yaml'))})
const source = readFileSync(0, 'utf8')
const args = process.argv.slice(2), patches = []
for(let index = 0; index < args.length; index++) if(args[index] === '--patch') patches.push(args[++index])
if(!patches.length) { process.stdout.write(source); process.exit(0) }
const rows = yaml.parse(source)
for(const path of patches) for(const patch of yaml.parse(readFileSync(path, 'utf8'))) {
 const index = rows.findIndex(row => row.id === patch.id)
 if(index < 0) rows.push(patch)
 else rows[index] = { ...rows[index], ...patch }
}
process.stdout.write(yaml.stringify(rows))
`)
    const dumpHead = `if [[ " $* " == *' --dump-config '* ]]; then`
    const dumpStart = dumpSource.indexOf(dumpHead), dumpEnd = dumpSource.indexOf(activationHead, dumpStart)
    const dumpBody = dumpSource.slice(dumpStart + dumpHead.length, dumpEnd).replace(/\nfi\n$/u, '\n')
    await writeFile(nativePath, dumpSource.slice(0, dumpStart) + `${dumpHead}
  pre_owner_dump() {${dumpBody}  }
  pre_owner_dump "$@" | "${process.execPath}" "${composer}" "$@"
  exit 0
fi
` + dumpSource.slice(dumpEnd))
    // Runtime replacement uses a package locator but no fixture Control Plane code.
    const controlPackage = join(f.profileDirectory, 'node_modules/@dsh-enhanced/plugin-control-plane')
    await mkdir(controlPackage, { recursive: true })
    await writeFile(join(controlPackage, 'package.json'), '{"name":"@dsh-enhanced/plugin-control-plane","version":"0.1.0"}')
    await mkdir(join(controlPackage, 'lib'))
    await writeFile(join(controlPackage, 'lib/entry.js'), 'approved-package-bytes')
    const pnpmPackageRoot = join(f.fakeBin, 'node_modules', 'pnpm')
    await mkdir(join(pnpmPackageRoot, 'bin'), { recursive: true })
    await mkdir(join(pnpmPackageRoot, 'dist'))
    await writeFile(join(pnpmPackageRoot, 'package.json'), JSON.stringify({ name: 'pnpm', version: '11.7.0',
      bin: { pnpm: 'bin/pnpm.cjs' } }), { mode: 0o600 })
    await writeFile(join(pnpmPackageRoot, 'dist', 'fixture.sh'), await readFile(pnpmPath), { mode: 0o700 })
    await writeFile(join(pnpmPackageRoot, 'dist', 'pnpm.cjs'), `const {readFileSync}=require('node:fs');
const {spawnSync}=require('node:child_process');const {join}=require('node:path');
const input=JSON.parse(readFileSync(${JSON.stringify(join(f.root, 'pnpm-fixture-env.json'))},'utf8'));
if(process.argv.includes('config')&&(process.env.pnpm_config_pm_on_fail!=='error'||process.env.pnpm_config_manage_package_manager_versions!=='false'||process.env.pnpm_config_package_manager_strict!=='true'||process.env.pnpm_config_package_manager_strict_version!=='true'))throw new Error('fixture pnpm manager selection was not frozen');
const controls=Object.fromEntries(Object.entries(input).filter(([key,value])=>/^LIFECYCLE_[A-Z0-9_]+$/.test(key)&&typeof value==='string'));
const result=spawnSync('/bin/bash',[join(__dirname,'fixture.sh'),...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,...controls}});
if(result.error)throw result.error;process.exitCode=result.status??1;
`, { mode: 0o600 })
    await writeExecutable(join(pnpmPackageRoot, 'bin', 'pnpm.cjs'), '#!/usr/bin/env node\nrequire("../dist/pnpm.cjs")\n')
    await rm(pnpmPath)
    await symlink(join(pnpmPackageRoot, 'bin', 'pnpm.cjs'), pnpmPath)
    return { ...f, moduleRoot, preparationRoot, cachePath, storeAlias, pnpmPackageRoot, candidateLock }
  }

  /** Real tiny runtime files and genuine base readers; no native kernel/workload
   * acceptance is implied. Preparation, source and CLI remain explicit ports. */
  async function nativeEntryBaseSource(commit: string) {
    const { fixture } = await import('../../plugins/lark-channel/tests/fixtures/linux-native-home-fixture.js')
    const { linuxRuntimeDigest } = await import('../../plugins/assistant-isolation/lib/linux-runtime.js')
    const f = await fixture()
    temporaryRoots.push(dirname(f.sourceHome))
    for (const name of ['rsi-authorities', 'rsi-linux-repository-runtimes', 'rsi-linux-creation-builds']) {
      await rm(join(f.sourceHome, name), { recursive: true })
    }
    const rewrite = (value: unknown): unknown => typeof value === 'string'
      ? value === 'unit' ? 'web' : value.replaceAll('/unit/', '/web/').replace(/\/unit$/u, '/web')
      : Array.isArray(value) ? value.map(rewrite) : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)])) : value
    const seal = (value: Record<string, unknown>) => {
      const content = { ...value }; delete content.receiptDigest
      return { ...content, receiptDigest: createHash('sha256').update(JSON.stringify(content)).digest('hex') }
    }
    for (const name of ['rsi-linux-runtimes', 'rsi-release-builds']) await rename(join(f.sourceHome, name, 'unit'), join(f.sourceHome, name, 'web'))
    const runtimePath = join(f.sourceHome, 'rsi-linux-runtimes/web/bootstrap.json')
    const runtimeReceipt = rewrite(JSON.parse(await readFile(runtimePath, 'utf8'))) as Record<string, unknown>
    const runtime = runtimeReceipt.runtime as Parameters<typeof linuxRuntimeDigest>[0]
    runtime.sourceCommit = commit
    runtimeReceipt.sourceCommit = commit
    runtimeReceipt.manifestHashes = { 'pnpm-lock.yaml': createHash('sha256').update('lock').digest('hex') }
    await writeFile(runtimePath, JSON.stringify(seal(runtimeReceipt)), { mode: 0o600 })
    const releasePath = join(f.sourceHome, 'rsi-release-builds/web/bootstrap.json')
    const release = rewrite(JSON.parse(await readFile(releasePath, 'utf8'))) as Record<string, unknown>
    release.sourceCommit = commit; release.runtimeDigest = linuxRuntimeDigest(runtime)
    await writeFile(releasePath, JSON.stringify(seal(release)), { mode: 0o600 })
    return f.sourceHome
  }

  async function nativePreOwnerLifecycleFixture({ originalNative = false, memoryExtension = false,
    baseServices = memoryExtension, temporaryParent }: { originalNative?: boolean; memoryExtension?: boolean;
      baseServices?: boolean; temporaryParent?: string } = {}) {
    const f = await preOwnerLifecycleFixture({ baseServices, memoryExtension,
      ...(temporaryParent === undefined ? {} : { temporaryParent }) })
    const primitive = await import('../../plugins/lark-channel/src/rsi-linux-native-relocation.js')
    const seed = async (logicalHome: string, commit: string, existing: boolean) => {
      const sourceHome = await nativeEntryBaseSource(commit)
      const physicalHome = await mkdtemp(join(f.root, '.native-base-seed-'))
      const proof = await primitive.relocateLinuxRsiNativeBase({ sourceHome, physicalHome, logicalHome, profile: 'web',
        ...(existing ? { existingLogicalHome: logicalHome } : {}) })
      if (!existing) await rename(physicalHome, logicalHome)
      else {
        await rm(join(logicalHome, 'rsi-builds/web'), { recursive: true })
        await rm(join(logicalHome, 'rsi-release-builds/web'), { recursive: true })
        for (const kind of ['rsi-linux-runtimes', 'rsi-release-builds']) {
          await mkdir(join(logicalHome, kind), { recursive: true, mode: 0o700 })
          await rename(join(physicalHome, kind, 'web'), join(logicalHome, kind, 'web'))
        }
      }
      if (existing) await primitive.inspectLinuxRsiNativeBaseAt({ logicalHome, physicalHome: logicalHome, profile: 'web' })
      else await primitive.openLinuxRsiNativeRelocatedBaseAt(proof, logicalHome)
    }
    await seed(join(f.preparationRoot, 'home'), '2'.repeat(40), false)
    if (originalNative) await seed(f.dshHome, '1'.repeat(40), true)
    const lib = join(f.moduleRoot, 'plugins/lark-channel/lib')
    await cp(join(repoRoot, 'plugins/lark-channel/lib/rsi-linux-native-relocation.js'), join(lib, 'rsi-linux-native-relocation.js'))
    // Closed, narrow facade over unchanged published primitive implementations.
    const isolation = join(f.moduleRoot, 'node_modules/@dsh-enhanced/assistant-isolation')
    await mkdir(join(isolation, 'lib'), { recursive: true })
    for (const name of ['linux-runtime.js', 'linux-user-namespace.js']) await cp(join(repoRoot, 'plugins/assistant-isolation/lib', name), join(isolation, 'lib', name))
    await writeFile(join(isolation, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/assistant-isolation', type: 'module', exports: './lib/index.js' }))
    await writeFile(join(isolation, 'lib/index.js'), "export * from './linux-runtime.js'; export { validateLinuxUserNamespaceMapping } from './linux-user-namespace.js'\n")
    const nativeLog = join(f.root, 'native-entry-resources.jsonl')
    await writeFile(nativeLog, '')
    const activationPath = join(lib, 'rsi-local-activation.js')
    let activation = await readFile(activationPath, 'utf8')
    activation = activation.replace('build:{sourceBuild:{schemaVersion:1}}', "build:{sourceBuild:{schemaVersion:3,backend:'linux-native'}}")
      .replace('workspace: { revision }', "workspace: { revision, sourceCommit: await sourceCommit(input.physicalHome,input.profile), version:'0.1.0' }")
      .replace('export async function produceRsiLocalSourceMaintenance(', 'async function originalProduceRsiLocalSourceMaintenance(')
      .replace('export async function stageRsiLocalSinglePackages(', 'async function originalStageRsiLocalSinglePackages(')
    activation += `
async function sourceCommit(home,profile){try{return JSON.parse(await readFile(join(home,'rsi-linux-runtimes',profile,'bootstrap.json'),'utf8')).sourceCommit}catch(e){if(e.code!=='ENOENT')throw e;return '1'.repeat(40)}}
// Source/Host signatures remain the declared tiny seam. Snapshot recovery
// reads the physical backup and must still match the previously frozen state.
const snapshotCanonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(snapshotCanonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+snapshotCanonical(value[key])).join(',')+'}';
export async function readRsiSourceMaintenanceSnapshot(input){
 const state=await readRsiSourceMaintenance({...input,logicalHome:input.physicalHome});
 const digest=createHash('sha256').update(snapshotCanonical(state)).digest('hex');
 if(digest!==input.expectedStateDigest)throw new Error('fixture source snapshot differs from frozen state');
 await appendFile(${JSON.stringify(nativeLog)},JSON.stringify({action:'source-snapshot',physicalHome:input.physicalHome,expectedStateDigest:input.expectedStateDigest,sourceDigest:digest})+'\\n');
 return state;
}
async function drift(home,phase){if(process.env.LIFECYCLE_NATIVE_RESOURCE_FAILURE!==phase||!home.includes('.dsh-enhanced-transaction/staged-home'))return;
 const path=join(home,'rsi-linux-runtimes/web/runtime/node_modules/index.js');await chmod(path,0o644);await writeFile(path,'tampered runtime bytes');await chmod(path,0o444);
 await appendFile(${JSON.stringify(nativeLog)},JSON.stringify({action:'drift',phase,home})+'\\n')}
export async function produceRsiLocalSourceMaintenance(input){const result=await originalProduceRsiLocalSourceMaintenance(input);await drift(input.stagePhysicalHome,'after-stage');return result}
export async function stageRsiLocalSinglePackages(input){const result=await originalStageRsiLocalSinglePackages(input);await drift(input.dshHome,'after-packages');return result}
`
    activation = activation.replace("readFile, writeFile, lstat, realpath, mkdir }", "readFile, writeFile, lstat, realpath, mkdir, chmod, appendFile }")
    await writeFile(activationPath, activation)
    await writeFile(join(lib, 'rsi-linux-native-resources.js'), `
import { appendFile, readFile, rm } from 'node:fs/promises';import { existsSync } from 'node:fs';import { join } from 'node:path';import { createHash } from 'node:crypto';
import { relocateLinuxRsiNativeBase, openLinuxRsiNativeRelocatedBaseAt, inspectLinuxRsiNativeBaseAt as inspect } from './rsi-linux-native-relocation.js';
const home=${JSON.stringify(f.dshHome)},log=${JSON.stringify(nativeLog)};
const record=async value=>appendFile(log,JSON.stringify(value)+'\\n');
export async function freezeLinuxRuntimeSource(){return {manifests:[{path:'pnpm-lock.yaml',bytes:Buffer.from('lock')}]}}
export async function inspectLinuxRsiNativeBaseAt(input){await record({action:'inspect',...input});return inspect({...input,logicalHome:home})}
export async function stageLinuxRsiPreOwnerNativeResources(input){
 const originalBackend=existsSync(join(home,'rsi-linux-runtimes',input.profile))?'linux-native':'docker';
 await record({action:'stage-request',physicalHome:input.stagePhysicalHome,transactionPresent:existsSync(home+'.dsh-enhanced-transaction')});
 if(process.env.LIFECYCLE_NATIVE_RESOURCE_FAILURE==='stage')throw new Error('fixture candidate native staging failed');
 for(const kind of ['rsi-builds','rsi-linux-runtimes','rsi-release-builds'])await rm(join(input.stagePhysicalHome,kind,input.profile),{recursive:true,force:true});
 const relocation=await relocateLinuxRsiNativeBase({sourceHome:join(input.preparationRoot,'home'),physicalHome:input.stagePhysicalHome,logicalHome:home,profile:input.profile,existingLogicalHome:home});
 const proof={schemaVersion:1,backend:'linux-native',purpose:'pre-owner-base',logicalHome:home,physicalHome:input.stagePhysicalHome,profile:input.profile,
  preparationDigest:createHash('sha256').update(await readFile(join(input.preparationRoot,'receipt.json'))).digest('hex'),cohortDigest:'c'.repeat(64),originalBackend,relocation};
 await record({action:'staged',proof,transactionPresent:existsSync(home+'.dsh-enhanced-transaction')});return {cohort:{},proof};
}
export async function verifyLinuxRsiPreOwnerNativeResources({proof,physicalHome}){
 // The fake namespace changes logical path spellings in its JSON transport.
 // Undo those aliases only; dev/ino, physical paths and the genuine seal are never rewritten.
 const relocation=structuredClone(proof.relocation),alias=relocation.logicalHome;
 relocation.logicalHome=home;for(const e of relocation.elements)if(e.logicalPath===alias||e.logicalPath.startsWith(alias+'/'))e.logicalPath=home+e.logicalPath.slice(alias.length);
 await record({action:'verify',physicalHome,proofPhysicalHome:proof.physicalHome});await openLinuxRsiNativeRelocatedBaseAt(relocation,physicalHome);
}
`)
    return { ...f, nativeLog, originalNative, primitive,
      nativeEvents: async () => (await readFile(nativeLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>),
    }
  }

  // Production preparation deliberately excludes arbitrary inherited variables.
  // The deterministic pnpm fixture reads its synthetic controls from its own
  // fixture file, independently of that restricted production environment.
  function writePreOwnerPnpmFixtureEnvironment(f: { root: string; dshHome: string; fakeBin: string }, options: LifecycleRunOptions = {}) {
    const environment = lifecycleEnvironment(f.dshHome, f.fakeBin, options)
    const controls = Object.entries(environment).filter(([key]) => /^LIFECYCLE_[A-Z0-9_]+$/u.test(key))
    writeFileSync(join(f.root, 'pnpm-fixture-env.json'), JSON.stringify(Object.fromEntries(
      controls.map(([key, value]) => [key, String(value)]))), { mode: 0o600 })
  }

  function runPreOwnerLifecycle(f: Awaited<ReturnType<typeof preOwnerLifecycleFixture>>, operation: 'local-service-upgrade' | 'local-service-recover', options: LifecycleRunOptions = {}) {
    setLifecycleSystemdControls(join(f.root, 'systemd-state.json'), options)
    writePreOwnerPnpmFixtureEnvironment(f, options)
    return spawnSync(process.execPath, [join(f.fixtureInstallDirectory,'lifecycle-profile.mjs'), operation, 'web', f.dshHome,
      join(f.fakeBin,'dsh'), join(f.fakeBin,'bwrap'), join(f.fakeBin,'systemctl'), join(f.fakeBin,'journalctl'),
      ...(operation === 'local-service-upgrade' ? [join(f.fakeBin,'pnpm'),f.preparationRoot] : []), f.moduleRoot], {
      cwd: repoRoot, encoding:'utf8', env:lifecycleEnvironment(f.dshHome,f.fakeBin, { ...options, systemdLarkProfiles:['web'] }),
    })
  }

  async function rsiPairLifecycleFixture(scannerMode: 'no-op' | 'complete' | 'partial-fail' = 'no-op') {
    const coordinator = 'rsi-web-test'
    const f = await lifecycleFixture({ readiness: 'host', effectiveScenario: 'supervised',
      managedDependencies: ['personal-assistant', 'plugin-control-plane'],
      systemd: { units: [{ profile: 'web', active: true }, { profile: coordinator, active: true }] } })
    const coordinatorPath = join(f.dshHome, 'profiles', coordinator)
    const slugs = ['assistant-automations', 'assistant-policy', 'plugin-control-plane']
    const scope = { ownerRouteId: 'owner-route', principalId: 'owner', workspace: 'workspace', preset: 'default' }
    const storage = join(f.dshHome, 'rsi-coordinators', coordinator)
    const shared = { catalogPath: join(f.dshHome, 'catalog.json'), trustPath: join(f.dshHome, 'trust.json') }
    const targetRows = parse(await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')) as object[]
    targetRows.push({ id: 'dsh-enhanced-plugin-control-plane', name: '@dsh-enhanced/plugin-control-plane', config: {
      ...shared, sourceJobs: { ...scope, budgetAmount: 1 }, sourceAdoptions: { profile: 'web', handoff: { coordinatorId: 'pair-coordinator' } },
    } })
    await writeFile(join(f.dshHome, '.lifecycle-dump-config'), stringify(targetRows))
    const base = [{ id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } }]
    const rows = [...base,
      { id: 'dsh-enhanced-assistant-policy', name: '@dsh-enhanced/assistant-policy', config: {
        databasePath: join(storage, 'policy.sqlite'), budgets: [{ id: 'coord', metric: 'automation-runs', scope: 'subject', limit: 3, periodMs: 60_000 }],
      } },
      { id: 'dsh-enhanced-assistant-automations', name: '@dsh-enhanced/assistant-automations', config: {
        databasePath: join(storage, 'automations.sqlite'), runsPath: join(storage, 'runs'), schedulerEnabled: true,
      } },
      { id: 'dsh-enhanced-plugin-control-plane', name: '@dsh-enhanced/plugin-control-plane', config: {
        ...shared, statePath: storage, adoptionCoordinator: { coordinatorId: 'pair-coordinator', scope, timeoutMs: 10_000, budgetId: 'coord', budgetAmount: 1 },
      } },
    ]
    await writeFile(join(coordinatorPath, '.lifecycle-dump-config'), stringify(rows))
    await writeFile(join(coordinatorPath, 'cordis.patch.yml'), stringify(rows))
    await writeFile(join(coordinatorPath, 'package.json'), JSON.stringify({ name: 'coordinator', private: true,
      dependencies: Object.fromEntries(slugs.map(slug => [`@dsh-enhanced/${slug}`, '0.1.0'])),
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...slugs.map(slug => `@dsh-enhanced/${slug}`)] } },
    }))
    await writeFile(join(coordinatorPath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    await writeFile(join(coordinatorPath, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const basePath = join(coordinatorPath, 'node_modules', '@deepseek-ai', 'dsh-base')
    await mkdir(basePath, { recursive: true })
    await writeFile(join(basePath, 'cordis.patch.yml'), stringify([{ insert: base }]))
    for (const [profile, slug] of [['web', 'personal-assistant'], ['web', 'plugin-control-plane'], ...slugs.map(slug => [coordinator, slug])]) {
      const root = join(f.dshHome, 'profiles', profile!, 'node_modules', '@dsh-enhanced', slug!)
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: `@dsh-enhanced/${slug}`, version: '0.1.0', type: 'module', exports: './index.js' }))
      const source = slug === 'plugin-control-plane'
        ? "export const controlPlaneDigest = () => 'a'.repeat(64)\n"
        : `export const listActiveAutomationsLocally = () => [{ id: 'adoption-coordinator-' + 'a'.repeat(40), owner: 'plugin-control-plane-adoption-coordinator', updatedAt: Date.now(), definition: { execution: { kind: 'host', executorId: 'plugin-control-plane-adoption-coordinator-v1', ownerRouteId: 'owner-route' }, principal: 'owner', workspace: 'workspace', agentPreset: 'default' } }]\n`
      await writeFile(join(root, 'index.js'), source)
    }
    const receiptPath = join(f.dshHome, `.rsi-coordinator-${createHash('sha256').update('web').digest('hex').slice(0, 16)}.json`)
    await writeFile(receiptPath, JSON.stringify({ schemaVersion: 1, targetProfile: 'web', coordinatorProfile: coordinator, version: '0.1.0', sourceRepository: null }), { mode: 0o600 })
    const cohortPath = join(f.root, 'cohort')
    for (const slug of ['personal-assistant', ...slugs]) {
      await mkdir(join(cohortPath, slug), { recursive: true })
      await writeFile(join(cohortPath, slug, 'package.json'), JSON.stringify({ name: `@dsh-enhanced/${slug}`, version: '0.1.1' }))
    }
    const updater = join(f.fakeBin, 'pair-update.mjs')
    await writeFile(updater, `import { readFileSync,writeFileSync,existsSync,mkdirSync,appendFileSync } from 'node:fs';
import { join } from 'node:path';
const args=process.argv.slice(2), profile=args[args.indexOf('--profile')+1], root=join(process.env.DSH_HOME,'profiles',profile);
if(profile === ${JSON.stringify(coordinator)} && existsSync(join(process.env.DSH_HOME,'.fail-coordinator-install'))) process.exit(42);
const manifest=JSON.parse(readFileSync(join(root,'package.json')));
for(const path of args.slice(args.indexOf('add')+1)) {
 const value=JSON.parse(readFileSync(join(path,'package.json'))); manifest.dependencies[value.name]=value.version;
 const dest=join(root,'node_modules',value.name); mkdirSync(dest,{recursive:true});
 let previous={};try{previous=JSON.parse(readFileSync(join(dest,'package.json')))}catch{}
 writeFileSync(join(dest,'package.json'),JSON.stringify({...previous,...value}));
}
writeFileSync(join(root,'package.json'),JSON.stringify(manifest));
appendFileSync(process.env.LIFECYCLE_OPERATION_LOG,'pair-add '+profile+'\\n');
`)
    const dshPath = join(f.fakeBin, 'dsh')
    let dsh = await readFile(dshPath, 'utf8')
    const add = 'if [[ " $* " == *\' plugin \'* && " $* " == *\' add \'* ]]; then\n'
    expect(dsh).toContain(add)
    dsh = dsh.replace(add, add + `${JSON.stringify(process.execPath)} ${JSON.stringify(updater)} "$@"\n`)
    const dump = '  if [[ -n "$LIFECYCLE_SYSTEMD_SUPERVISED_PROFILE"'
    expect(dsh).toContain(dump)
    dsh = dsh.replace(dump, '  if [[ -f "$DSH_HOME/profiles/$requested_profile/.lifecycle-dump-config" ]]; then cat "$DSH_HOME/profiles/$requested_profile/.lifecycle-dump-config"; exit 0; fi\n' + dump)
    await writeFile(dshPath, dsh)
    const pnpmPath = join(f.fakeBin, 'pnpm')
    const pnpm = await readFile(pnpmPath, 'utf8')
    const installEntry = '  printf \'pnpm-offline-install'
    expect(pnpm).toContain(installEntry)
    const materializer = join(f.fakeBin, 'pair-materialize.mjs')
    await writeFile(materializer, `import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root=process.argv[2], manifest=JSON.parse(readFileSync(join(root,'package.json')));
for(const [name,version] of Object.entries(manifest.dependencies)) {
 if(!name.startsWith('@dsh-enhanced/')) continue;
 const dest=join(root,'node_modules',name); mkdirSync(dest,{recursive:true});
 let previous={};try{previous=JSON.parse(readFileSync(join(dest,'package.json')))}catch{}
 writeFileSync(join(dest,'package.json'),JSON.stringify({...previous,name,version}));
}
`)
    await writeFile(pnpmPath, pnpm.replace(installEntry,
      `  ${JSON.stringify(process.execPath)} ${JSON.stringify(materializer)} "$directory"\n` + installEntry))
    const journalPath = join(f.fakeBin, 'journalctl')
    const journal = await readFile(journalPath, 'utf8')
    await writeFile(journalPath, journal.replace("invocation?.startsWith('fresh-')",
      `(invocation?.startsWith('fresh-') || invocation === 'original-${coordinator}')`))
    // These paired-flow fixtures mock systemd/DSH and the installed source reader
    // and migration APIs, while the parent journal/artifact/phase/cleanup code is real.
    const fixtureOwner = { authorityId: 'owner-route', authorityHash: digest64, principalId: 'owner',
      principalRecordId: 'principal_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', principalVersion: 1,
      workspace: join(f.dshHome, 'workspace'), agentPreset: 'default' }
    const ordinary = { id: 'owner:user-job', owner: 'owner', definitionHash: digest64, status: 'paused',
      createdAt: 1, updatedAt: 1, version: 1, runningTaskCount: 0 }
    const scanner = { ...ordinary, id: `usage-scan-${digest64}`, owner: 'assistant-growth-usage', status: 'active', nextRunAt: 2 }
    const inventory = { mode: scannerMode, before: scannerMode === 'no-op' ? [ordinary] : [ordinary, scanner],
      after: scannerMode === 'no-op' ? [ordinary] : [ordinary, { ...scanner, status: 'paused', nextRunAt: undefined, updatedAt: 2, version: 2 }] }
    await writeFile(join(f.dshHome, '.scanner-retirement-fixture.json'), JSON.stringify(inventory), { mode: 0o600 })
    const diagnosticsPath = join(f.fixtureInstallDirectory, 'lifecycle-profile.mjs')
    await writeFile(diagnosticsPath, (await readFile(diagnosticsPath, 'utf8')).replace(
      '  main().catch(error => {\n', '  main().catch(error => {\n    process.stderr.write(String(error?.stack ?? error) + "\\n")\n').replace(
      '    const persisted = await loadManifest(physicalTransactionRoot, { homePath, profile, transactionPath: transactionRoot }).catch(() => undefined)',
      '    process.stderr.write("fixture primary lifecycle failure: " + String(error?.stack ?? error) + "\\n")\n    const persisted = await loadManifest(physicalTransactionRoot, { homePath, profile, transactionPath: transactionRoot }).catch(() => undefined)'))
    const sourceHelperPath = join(f.fixtureInstallDirectory, 'host-rsi-update.mjs')
    const sourceHelper = await readFile(sourceHelperPath, 'utf8')
    const sourceEntry = 'export async function inspectRsiScannerOwnerSource({ homePath, physicalHome = homePath, profile }) {\n'
    expect(sourceHelper).toContain(sourceEntry)
    await writeFile(sourceHelperPath, sourceHelper.replace(sourceEntry, sourceEntry
      + `  return ${JSON.stringify({ protocol: 'host-rsi/scanner-owner-source/v1', homePath: f.dshHome, profile: 'web', sourceDigest: digest64, owner: fixtureOwner })}\n`))
    const larkModule = join(f.profileDirectory, 'node_modules', '@dsh-enhanced', 'lark-channel')
    await mkdir(larkModule, { recursive: true })
    await writeFile(join(larkModule, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/lark-channel', version: '0.1.0', type: 'module', exports: './index.js' }))
    await writeFile(join(larkModule, 'index.js'), `import {createHash} from 'node:crypto';import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
const hash=x=>createHash('sha256').update(x).digest('hex'),home=process.env.DSH_HOME;
const inventory=JSON.parse(await readFile(join(home,'.scanner-retirement-fixture.json'),'utf8'));
const log=action=>writeFile(process.env.LIFECYCLE_OPERATION_LOG,'scanner-api '+action+'\\n',{flag:'a'});
export async function deriveScannerRetirementConfiguration(input){return {effectiveConfigDigest:hash(input.effectiveConfig),owner:input.owner,dshHome:input.dshHome,profile:input.profile};}
export async function captureScannerRetirementPlan(input){await log('capture');if(inventory.mode==='no-op')return {status:'no-op',reason:'owner-active',effectiveConfigDigest:hash(input.effectiveConfig),beforeSnapshotDigest:'${digest64}',storageDigest:input.expectedStorageDigest};
return {status:'prepared',plan:{protocol:'lark-channel/scanner-retirement-plan/v1',planDigest:'${digest64}',dshHome:input.dshHome,profile:input.profile,owner:input.owner,effectiveConfigDigest:hash(input.effectiveConfig),automationsDatabasePath:join(input.dshHome,'automations.sqlite'),before:{storageDigest:input.expectedStorageDigest,records:inventory.before},ownerProof:{storageDigest:'${digest64}'},operations:[{owner:'assistant-growth-usage',automationId:'usage-scan-${digest64}',operationId:'owner-revoked:${digest64}',expectedVersion:1}]}};}
export async function applyScannerRetirementPlan({plan,signal}){signal.throwIfAborted();await log('apply');await writeFile(join(home,'.scanner-retired'),'fixture permanent marker');if(inventory.mode==='partial-fail')throw new Error('injected partial scanner maintenance failure');return {protocol:'lark-channel/scanner-retirement-completion/v1',planDigest:plan.planDigest,after:{records:inventory.after}};}
export async function verifyScannerRetirementPersistence({plan,completion}){await log('verify');await readFile(join(home,'.scanner-retired'));if(completion.planDigest!==plan.planDigest)throw new Error('fixture completion differs');return {records:inventory.after};}
`)
    const namespacePath = join(f.fakeBin, 'bwrap'), namespaceSource = await readFile(namespacePath, 'utf8')
    // A real mount namespace keeps logical Home argv unchanged. Preserve that one
    // argument in the fixture operator; its mock API writes only mapped DSH_HOME.
    const remap = "  if (value === logicalHome || value.startsWith(logicalHome + '/')) command[index] = stageHome + value.slice(logicalHome.length)"
    expect(namespaceSource).toContain(remap)
    await writeFile(namespacePath, namespaceSource.replace(remap,
      `  if (index === 5 && command[3]?.includes('const [action, home, profile, dsh, sourcePath')) continue\n` + remap))
    // This fixture's bwrap substitute maps argv paths to the staged directory.
    // Map literals during path validation too, matching the real mount namespace.
    const validatorPath = join(f.fixtureInstallDirectory, 'lifecycle-config.mjs')
    const validationEntry = 'export async function validateLifecycleConfig(source, { dshHome, dshExecutable } = {}) {\n'
    const validator = await readFile(validatorPath, 'utf8')
    expect(validator).toContain(validationEntry)
    await writeFile(validatorPath, validator.replace(validationEntry,
      validationEntry + `  source = source.replaceAll(${JSON.stringify(f.dshHome)}, dshHome)\n`))
    return { ...f, coordinator, coordinatorPath, receiptPath, targets: ['personal-assistant', 'plugin-control-plane'].map(slug => join(cohortPath, slug)) }
  }

  function lifecycleEnvironment(dshHome: string, fakeBin: string, options: LifecycleRunOptions = {}) {
    return {
      LIFECYCLE_NATIVE_RESOURCE_FAILURE: options.nativeResourceFailure ?? '',
      LIFECYCLE_CANDIDATE_FAILURE: options.candidateFailure ?? '',
      LIFECYCLE_PREPARED_RECEIPT_PATH: join(dirname(dshHome), 'prepared-update', 'receipt.json'),
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`, DSH_HOME: dshHome, NODE_ENV: 'test',
      DSH_ENHANCED_TEST_SERVICE_TOOLS: '1',
      DSH_ENHANCED_TEST_SUPERVISED_OPERATOR_LOG: join(dirname(dshHome), 'supervised-operator.log'),
      LIFECYCLE_ACTIVATION_MARKER: options.activationMarker ?? join(dshHome, '.activation-ran'),
      LIFECYCLE_BWRAP_LOG: join(dirname(dshHome), 'bwrap.log'),
      LIFECYCLE_CONFIG_AFTER_ACTIVATION: options.configAfterActivation ?? '',
      LIFECYCLE_CONFIG_AFTER_UPGRADE: options.configAfterUpgrade ?? '',
      LIFECYCLE_DSH_LOG: join(dirname(dshHome), 'dsh.log'),
      LIFECYCLE_DSH_EXECUTABLE: join(fakeBin, 'dsh'),
      LIFECYCLE_NPM_BLOCK: options.npmBlock ? '1' : '0',
      LIFECYCLE_NPM_BLOCK_RELEASE: join(dirname(dshHome), 'npm-block-release'),
      LIFECYCLE_NPM_BLOCK_STARTED: join(dirname(dshHome), 'npm-block-started'),
      LIFECYCLE_NPM_PEER_EXTERNAL_BIN: options.npmPeerExternalBin ?? '',
      LIFECYCLE_NPM_PREPARE_FAIL: options.npmPrepareFails ? '1' : '0',
      LIFECYCLE_METADATA_WARMUP_FAIL: options.metadataWarmupFails ? '1' : '0',
      LIFECYCLE_METADATA_WARMUP_SKIP_REASON: options.metadataWarmupSkipReason ?? '',
      LIFECYCLE_METADATA_WARMUP_MISSING_MIRROR: options.metadataWarmupMissingMirror ? '1' : '0',
      LIFECYCLE_METADATA_MIRROR_MUTATION_PATH: options.metadataMirrorMutationPath ?? '',
      LIFECYCLE_METADATA_GRAPH_SHRINK: options.metadataGraphShrink ?? '',
      LIFECYCLE_METADATA_WARMUP_STDERR_SKIP: options.metadataWarmupStderrSkip ? '1' : '0',
      LIFECYCLE_METADATA_WARMUP_LARGE_STDERR: options.metadataWarmupLargeStderr ? '1' : '0',
      LIFECYCLE_NPM_RECEIPT_MISSING_POLICY: options.npmReceiptMissingPolicy ?? '',
      LIFECYCLE_NPM_SANDBOX_REGISTRY_DRIFT: options.npmSandboxRegistryDrift ? '1' : '0',
      LIFECYCLE_NPM_SOURCE_METADATA_MUTATION: options.npmSourceMetadataMutation ? '1' : '0',
      LIFECYCLE_NPM_VERSION: options.npmVersion ?? '1.4.0',
      LIFECYCLE_NPM_VERIFY_FAIL: options.npmVerifyFails ? '1' : '0',
      LIFECYCLE_LOCAL_BUILD_FAIL: options.localBuildFails ? '1' : '0',
      LIFECYCLE_LOCAL_INSTALL_FAIL: options.localInstallFails ? '1' : '0',
      LIFECYCLE_PNPM_STORE_MARKER: options.pnpmStoreMarker ?? '',
      LIFECYCLE_OPERATION_LOG: join(dirname(dshHome), 'lifecycle-operations.log'),
      LIFECYCLE_ORIGINAL_HOME: dshHome,
      LIFECYCLE_ORIGINAL_METADATA_PATH: join(dshHome, 'profiles', 'web', 'package.json'),
      LIFECYCLE_PNPMFILE_MUST_NOT_RUN: options.pnpmfileMustNotRun ? '1' : '0',
      LIFECYCLE_PROFILE_DIRECTORY: join(dshHome, 'profiles', 'web'),
      LIFECYCLE_REPO_ROOT: repoRoot,
      LIFECYCLE_REQUIRE_PNPM_PROFILE_CWD: options.requirePnpmProfileCwd ? '1' : '0',
      LIFECYCLE_REQUIRE_PNPM_STORE_FD: options.requirePnpmStoreFd ? '1' : '0',
      LIFECYCLE_PACKAGE_FAILS: options.packageFails ? '1' : '0',
      LIFECYCLE_PACKAGE_EXTERNAL_START_PROFILE: options.packageExternalStartProfile ?? '',
      LIFECYCLE_PACKAGE_BLOCK: options.packageBlock ? '1' : '0',
      LIFECYCLE_PACKAGE_SYMLINK_RELATIVE: options.packageSymlinkRelative ?? '',
      LIFECYCLE_PACKAGE_SYMLINK_TARGET: options.packageSymlinkTarget ?? '',
      LIFECYCLE_PACKAGE_WRITE_RELATIVE: options.packageWriteRelative ?? '',
      LIFECYCLE_STORE_FAILS: options.storeFails ? '1' : '0',
      LIFECYCLE_SUPERVISED_MOCK: options.expectedScenario === 'supervised' ? '1' : '0',
      LIFECYCLE_SUPERVISED_MOCK_FAILURE: options.supervisedMockFailure ?? '',
      LIFECYCLE_SUPERVISED_PROOF_DRIFT: options.supervisedProofDrift ? '1' : '0',
      LIFECYCLE_SUPERVISED_UNMANAGED_DRIFT: options.supervisedUnmanagedAutomationDrift ? '1' : '0',
      LIFECYCLE_SUPERVISED_GENERATION_FILE: join(dirname(dshHome), 'supervised-generation'),
      LIFECYCLE_SYSTEMD_CRASH_BEFORE_START_PROFILE: options.systemdCrashBeforeStartProfile ?? '',
      LIFECYCLE_SYSTEMD_DROPIN_MUTATION: options.systemdDropInMutation ?? '',
      LIFECYCLE_SYSTEMD_DYNAMIC_PROFILE: options.systemdDynamicProfile ?? '',
      LIFECYCLE_JOURNAL_LOG: join(dirname(dshHome), 'journal.log'),
      LIFECYCLE_JOURNAL_EXECUTABLE: join(fakeBin, 'journalctl'),
      LIFECYCLE_SYSTEMD_JOURNAL: options.systemdJournal ?? 'ready',
      LIFECYCLE_SYSTEMD_KILL_LIFECYCLE_DURING_START_PROFILE: options.systemdKillLifecycleDuringStartProfile ?? '',
      LIFECYCLE_SYSTEMD_OWNERSHIP_CHANGES_PROFILE: options.systemdOwnershipChangesProfile ?? '',
      DSH_ENHANCED_TEST_DISCONNECT_GUARDIAN_AFTER_START: options.guardianDisconnectAfterStart ? '1' : '',
      DSH_ENHANCED_TEST_GUARDIAN_PID_FILE: join(dirname(dshHome), 'guardian.pid'),
      DSH_ENHANCED_TEST_FAIL_CANONICAL_CLEANUP: options.canonicalCleanupFails ? '1' : '',
      DSH_ENHANCED_TEST_CRASH_DURING_CLEANUP: options.crashDuringCleanup ? '1' : '',
      DSH_ENHANCED_TEST_CRASH_AFTER_CLEANUP_METADATA: options.crashAfterCleanupMetadata ? '1' : '',
      DSH_ENHANCED_TEST_CRASH_AFTER_CLEANUP_PREPARED: options.crashAfterCleanupPrepared ? '1' : '',
      DSH_ENHANCED_TEST_CRASH_AFTER_CLEANUP_REACCEPT_GUARDIAN: options.crashAfterCleanupReacceptGuardian ? '1' : '',
      DSH_ENHANCED_TEST_CRASH_AFTER_CLEANUP_REACCEPT_PENDING: options.crashAfterCleanupReacceptPending ? '1' : '',
      DSH_ENHANCED_TEST_KILL_PARENT_AFTER_GUARDIAN_START: options.systemdKillLifecycleDuringStartProfile === undefined ? '' : '1',
      DSH_ENHANCED_TEST_KILL_AFTER_ORIGINAL_RENAME: options.killLifecycleAfterOriginalRename ? '1' : '',
      DSH_ENHANCED_TEST_KILL_AFTER_STOPPED: options.killLifecycleAfterStopped ? '1' : '',
      LIFECYCLE_SYSTEMD_LOG: join(dirname(dshHome), 'systemd.log'),
      LIFECYCLE_SYSTEMD_LARK_PROFILES: options.systemdLarkProfiles?.join(',') ?? '',
      LIFECYCLE_SYSTEMD_PID_STUCK_PROFILE: options.systemdPidStuckProfile ?? '',
      DSH_ENHANCED_TEST_PROC_PIDS: options.systemdProcPids?.join(',') ?? '',
      DSH_ENHANCED_TEST_SSHD_PROOF_PIDS: options.sshdProofPids?.join(',') ?? '',
      DSH_ENHANCED_TEST_SDPAM_PROOF_PIDS: options.sdPamProofPids?.join(',') ?? '',
      DSH_ENHANCED_TEST_INCLUDE_ANCESTORS: options.processAncestorReference === undefined ? '' : '1',
      LIFECYCLE_SYSTEMD_QUIESCENCE_DRIFT_PROFILE: options.systemdQuiescenceDriftProfile ?? '',
      LIFECYCLE_SYSTEMD_READINESS_FAILS_PROFILE: options.systemdReadinessFailsProfile ?? '',
      LIFECYCLE_SYSTEMD_REPLACE_CONTROL_MASK_ON_UNMASK_PROFILE: options.systemdReplaceControlMaskOnUnmaskProfile ?? '',
      LIFECYCLE_SYSTEMD_RESTART_LOOP_PROFILE: options.systemdRestartLoopProfile ?? '',
      LIFECYCLE_SYSTEMD_START_FAILS_PROFILE: options.systemdStartFailsProfile ?? '',
      LIFECYCLE_SYSTEMD_STATE: join(dirname(dshHome), 'systemd-state.json'),
      LIFECYCLE_SYSTEMD_STOP_FAILS_PROFILE: options.systemdStopFailsProfile ?? '',
      LIFECYCLE_SYSTEMD_SUPERVISED_PROFILE: options.systemdSupervisedProfile ?? '',
      LIFECYCLE_SYSTEMD_UNSUPPORTED_PROFILE: options.systemdUnsupportedProfile ?? '',
      DSH_ENHANCED_SERVICE_READY_TIMEOUT_MS: '1000',
      DSH_ENHANCED_SERVICE_STABILITY_MS: options.serviceStabilityMs ?? '0',
      ...(options.serviceStabilitySamples === undefined ? {} : {
        DSH_ENHANCED_SERVICE_STABILITY_SAMPLES: String(options.serviceStabilitySamples),
      }),
      DSH_ENHANCED_SERVICE_STOP_TIMEOUT_MS: '1000',
      HOME: join(dirname(dshHome), 'systemd-home'),
    }
  }

  function runLifecycle(args: readonly string[], dshHome: string, fakeBin: string, options: LifecycleRunOptions = {}) {
    const lifecycleInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
    const [operation, profile, homePath, dryRun, ...targets] = args
    return spawnSync('/bin/bash', ['-c', 'source "$1"; shift; dsh_enhanced_profile_lifecycle "$@"',
      'lifecycle-test', lifecycleInstallerLibrary, operation!, profile!, homePath!, dryRun!,
      options.expectedScenario ?? 'web', ...targets], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: lifecycleEnvironment(dshHome, fakeBin, options),
    })
  }

  function runServiceLifecycle(
    args: readonly string[],
    dshHome: string,
    fakeBin: string,
    options: LifecycleRunOptions = {},
    operation: 'service-upgrade' | 'service-uninstall' = 'service-upgrade',
  ) {
    const [profile, homePath, _dryRun, ...targets] = args
    const statePath = join(dirname(dshHome), 'systemd-state.json')
    const serviceInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
    setLifecycleSystemdControls(statePath, options)
    return spawnSync('/bin/bash', [
      '-c', `${options.processAncestorReference === 'fd' ? 'exec 9<"$DSH_HOME"; ' : ''}source "$1"; shift; dsh_enhanced_run_lifecycle_executor ${operation} "$@"`,
      'service-lifecycle-test', serviceInstallerLibrary, profile!, homePath!, options.expectedScenario ?? 'lark', ...targets,
    ], {
      cwd: options.processAncestorReference === 'cwd' ? dshHome : repoRoot,
      encoding: 'utf8',
      env: lifecycleEnvironment(dshHome, fakeBin, options),
    })
  }

  function startServiceLifecycle(
    args: readonly string[],
    dshHome: string,
    fakeBin: string,
    options: LifecycleRunOptions = {},
    operation: 'service-upgrade' | 'service-uninstall' = 'service-upgrade',
  ) {
    const [profile, homePath, _dryRun, ...targets] = args
    const statePath = join(dirname(dshHome), 'systemd-state.json')
    const serviceInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
    setLifecycleSystemdControls(statePath, options)
    const child = spawn('/bin/bash', [
      '-c', `source "$1"; shift; dsh_enhanced_run_lifecycle_executor ${operation} "$@"`,
      'service-lifecycle-test', serviceInstallerLibrary, profile!, homePath!, options.expectedScenario ?? 'lark', ...targets,
    ], {
      cwd: repoRoot, detached: true, env: lifecycleEnvironment(dshHome, fakeBin, options),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    return {
      child,
      output: () => ({ stdout, stderr, pid: child.pid, status: child.exitCode, signal: child.signalCode }),
      exited: new Promise<void>(resolveExit => { child.once('exit', () => resolveExit()); child.once('error', () => resolveExit()) }),
      done: new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveDone => {
        child.once('close', status => resolveDone({ status, stdout, stderr }))
      }),
    }
  }

  // Only the two long-lived guardian cases below need observation before exit.
  async function lifecycleResult(lifecycle: Pick<ReturnType<typeof startServiceLifecycle>, 'done' | 'output'>, phase: string, timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([lifecycle.done, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${phase} exceeded its remaining budget: ${JSON.stringify(lifecycle.output())}`)), Math.max(1, timeoutMs))
      })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }

  async function withGuardianFixtureCleanup(
    f: Awaited<ReturnType<typeof lifecycleFixture>>,
    lifecycles: ReturnType<typeof startServiceLifecycle>[], check: () => Promise<void>,
  ) {
    let failure: unknown
    try { await check() } catch (error) { failure = error }
    try {
      // Stop the parent first: it must not create another detached guardian while
      // cleanup reads registration metadata. Its exit is distinct from pipe close.
      for (const { child } of lifecycles) if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error: any) { if (error.code !== 'ESRCH') throw error }
      }
      await lifecycleResult({ done: Promise.all(lifecycles.map(item => item.exited)).then(() => ({ status: 0, stdout: '', stderr: '' })),
        output: () => ({ stdout: '', stderr: '', pid: undefined, status: null, signal: null }) }, 'parent cleanup', 1000)
      const source = await readFile(join(f.fixtureInstallDirectory, 'lifecycle-profile.mjs'), 'utf8')
      const begin = source.indexOf('const source = String.raw`', source.indexOf('async function withCrashStopGuardian('))
      const end = source.indexOf('`\n  const guardian = spawn(', begin)
      if (begin < 0 || end < 0) throw new Error('fixture guardian source is unavailable')
      const guardianSource = source.slice(begin + 'const source = String.raw`'.length, end)
      const identity = async (pid: string) => {
        try {
          if ((await stat(`/proc/${pid}`)).uid !== process.getuid?.()) return undefined
          const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')
          if (args[0] !== process.execPath || args[1] !== '-e' || args[2] !== guardianSource
            || args[3] !== join(f.fakeBin, 'systemctl') || args[6] !== f.dshHome) return undefined
          const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(') ') + 2).split(' ')
          return Number(fields[2]) === Number(pid) ? fields[19] : undefined
        } catch (error: any) { if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return undefined; throw error }
      }
      let closed = false
      void Promise.all(lifecycles.map(item => item.done)).then(() => { closed = true })
      const deadline = Date.now() + 2000
      while (!closed && Date.now() < deadline) {
        for (const pid of (await readdir('/proc')).filter(name => /^\d+$/u.test(name))) {
          const ticks = await identity(pid)
          if (ticks !== undefined && await identity(pid) === ticks) {
            try { process.kill(-Number(pid), 'SIGKILL') } catch (error: any) { if (error.code !== 'ESRCH') throw error }
          }
        }
        // A pre-registration child still holds stderr. Re-scan until it has exec'd
        // and is identifiable, and require pipe close before removing this fixture.
        if (!closed) await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      }
      if (!closed) throw new Error(`fixture guardian pipes remain open: ${f.root}`)
    } catch (error) {
      const index = temporaryRoots.indexOf(f.root)
      if (index >= 0) temporaryRoots.splice(index, 1) // Preserve unproven cleanup for diagnosis.
      failure = new AggregateError(failure === undefined ? [error] : [failure, error], 'fixture cleanup failed')
    }
    if (failure !== undefined) {
      const state = await readFile(f.systemdState, 'utf8').catch(error => String(error))
      const log = await readFile(f.systemdLog, 'utf8').catch(error => String(error))
      throw new Error(`${String(failure)}\n${JSON.stringify({ root: f.root, output: lifecycles.map(item => item.output()),
      state, systemdLogTail: log.slice(-8192) })}`, { cause: failure })
    }
  }

  function startInstaller(
    script: string,
    args: readonly string[],
    dshHome: string,
    fakeBin: string,
    options: LifecycleRunOptions = {},
  ) {
    const fixtureScript = join(dirname(dshHome), 'install', basename(script))
    const child = spawn('/bin/bash', [existsSync(fixtureScript) ? fixtureScript : script, ...args], {
      cwd: repoRoot, env: lifecycleEnvironment(dshHome, fakeBin, options),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    return {
      child,
      done: new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveDone => {
        child.once('close', status => resolveDone({ status, stdout, stderr }))
      }),
    }
  }

  function startLifecycle(args: readonly string[], dshHome: string, fakeBin: string, options: LifecycleRunOptions = {}) {
    const lifecycleInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
    const [operation, profile, homePath, dryRun, ...targets] = args
    const child = spawn('/bin/bash', ['-c', 'source "$1"; shift; dsh_enhanced_profile_lifecycle "$@"',
      'lifecycle-test', lifecycleInstallerLibrary, operation!, profile!, homePath!, dryRun!,
      options.expectedScenario ?? 'web', ...targets], {
      cwd: repoRoot, env: lifecycleEnvironment(dshHome, fakeBin, options),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    return { child,
      done: new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveDone => {
        child.once('close', status => resolveDone({ status, stdout, stderr }))
      }),
    }
  }

  function runRecovery(profile: string, dshHome: string, fakeBin: string, options: LifecycleRunOptions = {}) {
    const lifecycleInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
    return spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_recover_profile_lifecycle "$2" "$3" 0',
      'recovery-test', lifecycleInstallerLibrary, profile, dshHome], {
      cwd: repoRoot, encoding: 'utf8', env: lifecycleEnvironment(dshHome, fakeBin, options),
    })
  }

  function startRecovery(profile: string, dshHome: string, fakeBin: string) {
    const lifecycleInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
    const child = spawn('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_recover_profile_lifecycle "$2" "$3" 0',
      'recovery-test', lifecycleInstallerLibrary, profile, dshHome], {
      cwd: repoRoot, env: lifecycleEnvironment(dshHome, fakeBin),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    return {
      child,
      done: new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveDone => {
        child.once('close', status => resolveDone({ status, stdout, stderr }))
      }),
    }
  }

  async function holdExternalLifecycleLock(path: string) {
    const child = spawn('/usr/bin/python3', ['-c', [
      'import fcntl, os, sys',
      'handle = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)',
      'fcntl.flock(handle, fcntl.LOCK_EX)',
      'sys.stdout.write("LOCKED\\n")',
      'sys.stdout.flush()',
      'sys.stdin.buffer.read()',
    ].join('\n'), path], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`external lock did not become ready: ${stderr}`)), 5_000)
      const inspect = () => {
        if (!stdout.includes('LOCKED\n')) return
        clearTimeout(timeout)
        child.stdout.off('data', inspect)
        resolveReady()
      }
      child.stdout.on('data', inspect)
      child.once('exit', status => {
        if (!stdout.includes('LOCKED\n')) {
          clearTimeout(timeout)
          rejectReady(new Error(`external lock exited with ${status}: ${stderr}`))
        }
      })
    })
    return {
      async release() {
        child.stdin.end()
        await new Promise<void>(resolveClose => child.once('close', () => resolveClose()))
      },
    }
  }

  async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await readFile(path)
        return
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
    }
    throw new Error(`Timed out waiting for ${path}`)
  }

  function readLifecycleDatabase(path: string) {
    const database = new DatabaseSync(path, { readOnly: true })
    const userVersion = database.prepare('PRAGMA user_version').get() as { user_version: number }
    const values = database.prepare('SELECT value FROM goals ORDER BY rowid').all() as Array<{ value: string }>
    database.close()
    return { userVersion: userVersion.user_version, values: values.map(({ value }) => value) }
  }

  async function preservedLifecycleTransactions(dshHome: string): Promise<string[]> {
    const parent = dirname(dshHome)
    const prefix = `${basename(dshHome)}.dsh-enhanced-transaction`
    return (await readdir(parent))
      .filter(name => name === prefix || name.startsWith(`${prefix}.`))
      .map(name => join(parent, name))
      .sort()
  }

  async function readJsonLines(path: string, onIncomplete?: () => void): Promise<unknown[][]> {
    const deadline = Date.now() + 2_000
    let observedIncomplete = false
    for (;;) {
      const source = await readFile(path, 'utf8')
      const lines = source.split('\n')
      const tail = lines.pop()
      const complete = lines.filter(Boolean).map(line => JSON.parse(line) as unknown[])
      if (tail === '') return complete
      if (!observedIncomplete) {
        observedIncomplete = true
        onIncomplete?.()
      }
      if (Date.now() >= deadline) throw new Error(`Incomplete JSON line in ${path}`)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
    }
  }

  async function readLifecycleSystemdState(path: string): Promise<LifecycleSystemdState> {
    return JSON.parse(await readFile(path, 'utf8')) as LifecycleSystemdState
  }

  function setLifecycleSystemdControls(path: string, options: LifecycleRunOptions): void {
    const state = JSON.parse(readFileSync(path, 'utf8')) as LifecycleSystemdState
    state.controls = {
      dropInMutation: options.systemdDropInMutation,
      crashBeforeStartProfile: options.systemdCrashBeforeStartProfile,
      cachedLoadState: options.systemdCachedLoadState,
      cachedLoadStateProfile: options.systemdCachedLoadStateProfile,
      dynamicProfile: options.systemdDynamicProfile,
      dynamicReportedDshHome: options.systemdDynamicReportedDshHome === '__other__'
        ? join(dirname(path), 'other-home') : undefined,
      guardianListUnitFilesFailuresRemaining: options.systemdGuardianListUnitFilesFailureBudget ?? 0,
      guardianListUnitsFailuresRemaining: options.systemdGuardianListUnitsFailureBudget ?? 0,
      guardianOwnershipShowFailuresRemaining: options.systemdGuardianOwnershipShowFailureBudget ?? 0,
      guardianOwnershipShowFailsProfile: options.systemdGuardianOwnershipShowFailsProfile,
      journal: options.systemdJournal ?? 'ready',
      larkDisconnectAfterConnect: options.systemdLarkDisconnectAfterConnect ?? false,
      larkFlapAfterAccept: options.systemdLarkFlapAfterAccept ?? false,
      larkFlapAtReadinessBaseline: options.systemdLarkFlapAtReadinessBaseline ?? false,
      maskedMetadataEmpty: options.systemdMaskedMetadataEmpty ?? false,
      maskedStaticMetadataOmitted: options.systemdMaskedStaticMetadataOmitted ?? false,
      killLifecycleDuringStartProfile: options.systemdKillLifecycleDuringStartProfile,
      ownershipChangesProfile: options.systemdOwnershipChangesProfile,
      ownershipChangesAfterStartProfile: options.systemdOwnershipChangesAfterStartProfile,
      pidStuckProfile: options.systemdPidStuckProfile,
      quiescenceDriftProfile: options.systemdQuiescenceDriftProfile,
      readinessFailsProfile: options.systemdReadinessFailsProfile,
      rawBlankNumericProfile: options.systemdRawBlankNumericProfile,
      rawIdMismatchProfile: options.systemdRawIdMismatchProfile,
      replaceControlMaskOnUnmaskProfile: options.systemdReplaceControlMaskOnUnmaskProfile,
      restartLoopProfile: options.systemdRestartLoopProfile,
      startFailsProfile: options.systemdStartFailsProfile,
      stopFailsProfile: options.systemdStopFailsProfile,
      stopLeavesFailedProfile: options.systemdStopLeavesFailedProfile,
    }
    writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  }

  async function readLifecycleSystemdLog(path: string): Promise<string[][]> {
    return (await readJsonLines(path)) as string[][]
  }

  async function lifecycleIdentity(path: string): Promise<LifecycleIdentity> {
    const entry = await stat(path)
    return { dev: String(entry.dev), ino: String(entry.ino) }
  }

  function lifecycleBinding(manifest: Omit<BoundLifecycleManifest, 'bindingDigest' | 'updatedAt'>) {
    return {
      version: manifest.version,
      id: manifest.id,
      homePath: manifest.homePath,
      canonicalHome: manifest.canonicalHome,
      transactionPath: manifest.transactionPath,
      transactionIdentity: manifest.transactionIdentity,
      profile: manifest.profile,
      operation: manifest.operation,
      originalIdentity: manifest.originalIdentity,
      originalProfileDigest: manifest.originalProfileDigest,
      originalProfileTreeDigest: manifest.originalProfileTreeDigest,
      stagedIdentity: manifest.stagedIdentity,
      stagedProfileDigest: manifest.stagedProfileDigest,
      expectedScenario: manifest.expectedScenario,
      stagedScenario: manifest.stagedScenario,
      createdAt: manifest.createdAt,
      state: manifest.state,
    }
  }

  function serviceLifecycleBinding(manifest: Record<string, unknown>) {
    return {
      version: manifest.version,
      id: manifest.id,
      homePath: manifest.homePath,
      canonicalHome: manifest.canonicalHome,
      transactionPath: manifest.transactionPath,
      transactionIdentity: manifest.transactionIdentity,
      profile: manifest.profile,
      operation: manifest.operation,
      originalIdentity: manifest.originalIdentity,
      originalProfileDigest: manifest.originalProfileDigest,
      originalProfileTreeDigest: manifest.originalProfileTreeDigest,
      stagedIdentity: manifest.stagedIdentity,
      stagedProfileDigest: manifest.stagedProfileDigest,
      expectedScenario: manifest.expectedScenario,
      stagedScenario: manifest.stagedScenario,
      createdAt: manifest.createdAt,
      state: manifest.state,
      services: manifest.services,
      servicePhase: manifest.servicePhase,
      serviceFailure: manifest.serviceFailure,
      serviceAcceptance: manifest.serviceAcceptance,
      unitUniverse: manifest.unitUniverse,
      foreignOwnership: manifest.foreignOwnership,
      cleanProfileDigest: manifest.cleanProfileDigest,
      cleanProfiles: manifest.cleanProfiles,
      serviceMasks: manifest.serviceMasks,
      containmentMasks: manifest.containmentMasks,
      containmentMaskIntents: manifest.containmentMaskIntents,
      serviceStartBarriers: manifest.serviceStartBarriers,
      containmentStartBarriers: manifest.containmentStartBarriers,
      archivedProfile: manifest.archivedProfile,
      cleanup: manifest.cleanup,
      supervisedLifecycle: manifest.supervisedLifecycle,
    }
  }

  async function writeBoundLifecycleManifest(options: {
    dshHome: string
    includeTransactionIdentity?: boolean
    originalHome: string
    stagedHome?: string
    state: RecoveryState
    originalProfileDigest?: string
    originalIdentity?: LifecycleIdentity
    stagedIdentity?: LifecycleIdentity
    stagedProfileDigest?: string
  }): Promise<BoundLifecycleManifest> {
    const transactionPath = `${options.dshHome}.dsh-enhanced-transaction`
    await mkdir(transactionPath, { recursive: true, mode: 0o700 })
    await chmod(transactionPath, 0o700)
    const createdAt = '2026-09-09T00:00:00.000Z'
    const base = {
      version: 1 as const,
      id: `recovery-${options.state}`,
      homePath: options.dshHome,
      canonicalHome: await realpath(options.dshHome).catch(() => options.dshHome),
      transactionPath,
      ...(options.includeTransactionIdentity === false ? {} : { transactionIdentity: await lifecycleIdentity(transactionPath) }),
      profile: 'web',
      operation: 'upgrade' as const,
      originalIdentity: options.originalIdentity ?? await lifecycleIdentity(options.originalHome),
      originalProfileDigest: options.originalProfileDigest ?? createHash('sha256')
        .update(await readFile(join(options.originalHome, 'profiles', 'web', 'package.json')))
        .digest('hex'),
      stagedIdentity: options.stagedIdentity ?? (options.stagedHome === undefined ? undefined : await lifecycleIdentity(options.stagedHome)),
      stagedProfileDigest: options.stagedProfileDigest,
      createdAt,
      state: options.state,
    }
    const manifest: BoundLifecycleManifest = {
      ...base,
      updatedAt: createdAt,
      bindingDigest: createHash('sha256').update(JSON.stringify(lifecycleBinding(base))).digest('hex'),
    }
    await writeFile(join(transactionPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    return manifest
  }

  async function cleanupInstallerFixtures() {
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }

  return {
    cleanupInstallerFixtures,
    repoRoot,
    installDirectory,
    localInstaller,
    npmInstaller,
    installerLibrary,
    pathWithoutTraex,
    temporaryRoots,
    realBwrapUsable,
    digest64,
    supervisedManagedDependencies,
    runInstaller,
    temporaryDshHome,
    writeExecutable,
    lifecycleFixture,
    nativePreOwnerLifecycleFixture,
    writePreOwnerPnpmFixtureEnvironment,
    runPreOwnerLifecycle,
    rsiPairLifecycleFixture,
    lifecycleEnvironment,
    runLifecycle,
    runServiceLifecycle,
    startServiceLifecycle,
    lifecycleResult,
    withGuardianFixtureCleanup,
    startInstaller,
    startLifecycle,
    runRecovery,
    startRecovery,
    holdExternalLifecycleLock,
    waitForFile,
    readLifecycleDatabase,
    preservedLifecycleTransactions,
    readJsonLines,
    readLifecycleSystemdState,
    setLifecycleSystemdControls,
    readLifecycleSystemdLog,
    lifecycleIdentity,
    serviceLifecycleBinding,
    writeBoundLifecycleManifest,
  }
}
