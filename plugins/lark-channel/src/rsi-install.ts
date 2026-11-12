import { createHash } from 'node:crypto'
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { listActiveAutomationsForReadiness } from '@dsh-enhanced/assistant-automations'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import { isDeepStrictEqual } from 'node:util'
import { controlPlaneDigest, queryRuntimeObserver, runtimeConfigDigest, type RuntimeObserverConfig } from '@dsh-enhanced/plugin-control-plane'
import { withDshHomeLifecycleLock } from './setup.js'
import { prepareRsiSourceWorkspace } from './rsi-source.js'
import { rsiBuildResources as io } from './rsi-build.js'
import { prepareRsiReleaseBuildEnvironment, readRsiReleaseBuildEnvironment,
  RsiReleaseBuildUnavailableError, type PreparedReleaseBuildEnvironment } from './rsi-release-build.js'
import { prepareRsiAuthorityRuntime } from './rsi-authority-runtime.js'
import { prepareRsiAuthorityResources } from './rsi-authority-resources.js'
import { createRsiBootstrapManifest, type RsiBootstrapSourceBuild } from './rsi-bootstrap-manifest.js'
import { validateRsiPluginCreationSetup } from './rsi-plugin-creation.js'
import { validateRsiPluginRevisionSetup } from './rsi-plugin-revision.js'
import { prepareLinuxRsiRuntime, readLinuxRsiRuntime, LinuxRsiRuntimeUnavailableError } from './rsi-linux-runtime-bootstrap.js'
import { prepareLinuxRsiRepositoryRuntime, readLinuxRsiRepositoryRuntime } from './rsi-linux-repository-bootstrap.js'
import { prepareLinuxRsiCreationBuildEnvironment, readLinuxRsiCreationBuildEnvironment,
  RsiLinuxCreationBuildUnavailableError, type LinuxRsiCreationBuildEnvironment } from './rsi-linux-creation-build.js'
import { discoverLinuxCgroupRoots, RsiLinuxCgroupUnavailableError } from './rsi-linux-cgroup-roots.js'
import { prepareRsiLinuxRunnerStates, type RsiLinuxRunnerStates } from './rsi-linux-runner-states.js'
import { inspectRsiOwnerConfiguration, prepareRsiOwnerConfiguration, type RsiOwnerConfigurationContext } from './rsi-bootstrap.js'
import { collectRsiInstalledInputs, RsiInstalledInputsUnavailableError } from './rsi-install-inputs.js'
import { captureRsiSystemdUnitProperties, readRsiSystemdUnitProperties } from './rsi-systemd-bootstrap.js'
import { configureRsiSetupLocked, rsiSetupPorts, type RsiSetupPorts } from './rsi-setup.js'
import { systemdServicePaths } from './systemd.js'
import type { RsiSetupManifest } from './rsi-profile.js'
import type { RsiAuthorityConfigInput } from './rsi-authority-config.js'
import { readRsiServiceEnvironment } from './rsi-service-environment.js'
import { version } from './version.js'
import { readRsiLocalCohort, verifyRsiLocalInstalledPackages } from './rsi-local-cohort.js'
import { installRsiLocalProfile, isRsiLocalPackageRepairable } from './rsi-local-install.js'
import { assertRsiSchedulerActivation, captureRsiAutomationInventories, rsiDatabasePaths } from './rsi-owner-profile.js'

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const coordinatorBundles = ['assistant-policy', 'assistant-automations', 'plugin-control-plane'] as const
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function fail(message: string): never { throw new Error(`rsi install: ${message}`) }
export interface RsiInstallInput { dshHome: string; profile: string; sourceRepository?: string | undefined; signal?: AbortSignal; ackExistingAutomations?: boolean | undefined
  /** Fresh-install-only ordinary-use learning; a retry preserves the stored opt-in and never expands it. */
  enableOrdinaryUseLearning?: boolean | undefined
  /** Fresh-install-only skip decision; a retry preserves the stored (missing) memory-learning chain. */
  skipMemoryLearning?: boolean | undefined
  /** Explicit evaluator route when the composition has no Delivery agentProvider/agentModel. */
  intakeProvider?: string | undefined
  intakeModel?: string | undefined }
export type RsiInstallResult = { mode: 'not-ready'; reason: string } | { mode: 'ready'; profiles: readonly string[]; manifestPath: string }
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false }
}
/** Stable per-target name, including for a maximum-length target profile. */
export function rsiCoordinatorProfile(profile: string): string {
  if (!profilePattern.test(profile)) fail('invalid target profile')
  return `rsi-${profile.slice(0,43)}-${hash(profile).slice(0,12)}`
}
async function prepareResources(input: RsiInstallInput, signal: AbortSignal) {
  const source = await prepareRsiSourceWorkspace({ ...input, version, signal })
  const runtime = await prepareRsiAuthorityRuntime({ ...input, signal })
  const resources = await prepareRsiAuthorityResources({ ...input, signal })
  const storedManifest = join(resources.configRoot, 'manifest.json')
  const previous = await exists(storedManifest)
    ? JSON.parse((await io.readStable(storedManifest, 2_097_152, true)).toString('utf8')) as RsiSetupManifest
    : undefined
  if (previous?.pluginCreation !== undefined) validateRsiPluginCreationSetup(previous.pluginCreation, previous.sourceReviews.owner)
  if (previous?.pluginRevision !== undefined) validateRsiPluginRevisionSetup(previous.pluginRevision, previous.sourceReviews.owner)
  const priorBuild = previous?.controlPlane.sourceBuild
  // Historical Docker-era manifests are readable but can never be continued by
  // the linux-native installer. Migration requires its own signed handoff.
  if (previous && (!priorBuild || 'backend' in priorBuild && priorBuild.backend !== 'linux-native')) {
    fail('existing Linux installation has an unsupported build backend')
  }
  const enableCreation = !previous || previous.pluginCreation !== undefined
  let build: { sourceBuild: RsiBootstrapSourceBuild }
  let release: PreparedReleaseBuildEnvironment
  let creationBuild: LinuxRsiCreationBuildEnvironment | undefined
  let runnerStates: RsiLinuxRunnerStates | undefined
  const directories: string[] = []
  const resourceInput = { ...input, source, signal }
  const base = await (previous ? readLinuxRsiRuntime : prepareLinuxRsiRuntime)(resourceInput)
  release = await (previous ? readRsiReleaseBuildEnvironment : prepareRsiReleaseBuildEnvironment)({ ...resourceInput, build: base })
  const repository = await (previous ? readLinuxRsiRepositoryRuntime : prepareLinuxRsiRepositoryRuntime)(resourceInput)
  const cgroupRoots = await discoverLinuxCgroupRoots({ signal })
  build = { sourceBuild: { backend: 'linux-native', repository, cgroupRoots } }
  directories.push('linux-source-build-runner')
  if (enableCreation) {
    creationBuild = await (previous ? readLinuxRsiCreationBuildEnvironment : prepareLinuxRsiCreationBuildEnvironment)({
      ...resourceInput, stateRoot: resources.stateRoot,
    })
    if (!isDeepStrictEqual(creationBuild.cgroupRoots, cgroupRoots)) fail('creation cgroup roots changed during preparation')
    if (!previous || previous.pluginRevision) directories.push('revision-review-runner', 'revision-regression-runner')
  }
  runnerStates = await prepareRsiLinuxRunnerStates(resources, {
    creation: enableCreation, revision: enableCreation && (!previous || previous.pluginRevision !== undefined),
  }, previous)
  if (creationBuild) directories.push('creation-review-runner', 'creation-adoption-runner')
  for (const name of directories) {
    const path = join(resources.stateRoot, name)
    if (!previous && !await exists(path)) await mkdir(path, { mode: 0o700 })
    await io.directory(path)
  }
  return { source, runtime, resources, build, release, ...(creationBuild ? { creationBuild } : {}),
    ...(runnerStates ? { runnerStates } : {}) }
}
async function ensureCoordinator(input: RsiInstallInput, coordinator: string,
  executor: RsiAuthorityConfigInput['executor'], signal: AbortSignal, systemctlPin: RsiAuthorityConfigInput['systemctl']): Promise<void> {
  const root = join(input.dshHome, 'profiles', coordinator)
  const receiptPath = join(input.dshHome, `.rsi-coordinator-${hash(input.profile).slice(0,16)}.json`)
  const receipt = JSON.stringify({schemaVersion:1,targetProfile:input.profile,coordinatorProfile:coordinator,
    version,sourceRepository:input.sourceRepository ?? null})
  let owned = await exists(receiptPath)
  if (owned && (await io.readStable(receiptPath,65_536,true)).toString('utf8') !== receipt) fail('coordinator preparation belongs to another installation')
  if (await exists(root) && !owned) fail('unregistered coordinator profile cannot be overwritten')
  if (!await exists(root) && !owned) {
    await io.writeExclusive(receiptPath,receipt); await io.syncDirectory(input.dshHome); owned = true
  }
  const matches = async (name: string): Promise<boolean> => {
    const path = join(root,'node_modules','@dsh-enhanced',name,'package.json')
    if (!await exists(path)) return false
    const manifest = JSON.parse((await io.readStable(await realpath(path),65_536)).toString('utf8')) as {name:string;version:string}
    if (manifest.name !== `@dsh-enhanced/${name}` || manifest.version !== version) fail('coordinator must use the same installed plugin release')
    return true
  }
  let complete = (await Promise.all(coordinatorBundles.map(matches))).every(Boolean)
  const local = input.sourceRepository ? await readRsiLocalCohort({dshHome:input.dshHome,profile:input.profile}) : undefined
  if (local && (local.sourceRepository !== input.sourceRepository || local.version !== version)) fail('local coordinator cohort differs from the source installation')
  if (local && complete) {
    try { await verifyRsiLocalInstalledPackages({cohort:local,profilePath:root,bundles:[...coordinatorBundles]}) }
    catch (error) { if (!isRsiLocalPackageRepairable(error)) throw error; complete = false }
  }
  if (!complete) {
    if (!owned) fail('unregistered coordinator profile cannot be overwritten')
    const state = await status(systemctlPin,coordinator,signal)
    if (!['inactive','failed'].includes(state.ActiveState!) || state.MainPID !== '0') fail('partial coordinator must be stopped before package repair')
    if (local) await installRsiLocalProfile({dshHome:input.dshHome,profile:coordinator,cohort:local,
      bundles:coordinatorBundles,dsh:{path:executor.path,pin:{path:executor.path,sha256:executor.sha256}},signal})
    else await io.command(executor.path, ['plugin', '--profile', coordinator, 'add', ...coordinatorBundles.map(name => `@dsh-enhanced/${name}@${version}`)],
      { ...process.env, DSH_HOME: input.dshHome, npm_config_loglevel: 'error' }, signal, 300_000, 2_097_152)
    if (!(await Promise.all(coordinatorBundles.map(matches))).every(Boolean)) fail('coordinator package installation is incomplete')
  }
  if (local) await verifyRsiLocalInstalledPackages({cohort:local,profilePath:root,bundles:[...coordinatorBundles]})
  await io.directory(root, false)
}
async function systemctl(pin: RsiAuthorityConfigInput['systemctl'], args: string[], signal: AbortSignal): Promise<string> {
  if (pin.interpreter !== null) fail('automatic installation requires native systemctl')
  if (createHash('sha256').update(await io.readStable(pin.path, 268_435_456, false, true)).digest('hex') !== pin.sha256) fail('systemctl changed')
  return io.command(pin.path, ['--user', ...args], process.env, signal, 40_000, 262_144)
}
async function status(pin: RsiAuthorityConfigInput['systemctl'], profile: string, signal: AbortSignal): Promise<Record<string, string>> {
  const text = await systemctl(pin, ['show', `dsh-profile-${profile}.service`,
    '--property=LoadState,ActiveState,MainPID,InvocationID,NRestarts,FragmentPath,DropInPaths,WorkingDirectory'], signal)
  return Object.fromEntries(text.split('\n').filter(Boolean).map(line => {
    const index = line.indexOf('='); if (index < 1) fail('invalid systemctl status'); return [line.slice(0,index),line.slice(index+1)]
  }))
}
async function stopManaged(input: RsiInstallInput, profile: string, pin: RsiAuthorityConfigInput['systemctl'], signal: AbortSignal): Promise<boolean> {
  const state = await status(pin, profile, signal)
  if (state.LoadState === 'not-found' && state.MainPID === '0' && state.ActiveState === 'inactive') return false
  const paths = systemdServicePaths({ dshHome: input.dshHome, profile })
  if (state.LoadState !== 'loaded' || state.FragmentPath !== paths.unitPath || state.DropInPaths !== ''
    || state.WorkingDirectory !== join(input.dshHome, 'profiles', profile)) fail(`service ${profile} is not the target installation's managed unit`)
  const active = state.ActiveState === 'active'
  await systemctl(pin, ['stop', paths.unitName], signal)
  const stopped = await status(pin, profile, signal)
  if (!['inactive','failed'].includes(stopped.ActiveState!) || stopped.MainPID !== '0') fail(`service ${profile} did not stop`)
  if (stopped.ActiveState === 'failed') await systemctl(pin, ['reset-failed', paths.unitName], signal)
  return active
}
async function observerReady(observer: RuntimeObserverConfig, state: Record<string,string>, signal: AbortSignal): Promise<void> {
  const value = await queryRuntimeObserver({ ...observer, signal })
  if (value.processId !== Number(state.MainPID) || value.invocationId !== state.InvocationID
    || value.profilePath !== observer.profilePath || value.observerConfigDigest !== runtimeConfigDigest(observer)
    || Math.abs(Date.now() - value.observedAt) > 5_000 || value.entries.length !== observer.targets.length) fail('runtime observation differs from installed Host')
  for (const target of observer.targets) {
    const entry = value.entries.find(item => item.entryId === target.entryId)
    if (!entry?.active || entry.module !== target.module || entry.configDigest !== target.configDigest
      || target.services.some(name => !entry.services.some(service => service.name === name && service.instance !== null))) fail('installed Loader entries are not ready')
  }
}
export function assertRsiMemoryScanActivation(manifest: Pick<RsiSetupManifest, 'memoryLearning'>,
  records: ReturnType<typeof listActiveAutomationsForReadiness>): void {
  const learning = manifest.memoryLearning?.learning
  if (!learning) return
  const owner = learning.owner, digest = growthObjectDigest(learning)
  const id = `memory-scan-${growthObjectDigest([learning.authorityId, owner])}`
  const registration = records.find(item => item.id === id)
  const definition = registration?.definition, execution = definition?.execution
  if (!registration || registration.owner !== 'assistant-memory-learning'
    || definition?.principal !== owner.principalId || definition.workspace !== owner.workspace
    || definition.agentPreset !== owner.agentPreset || definition.budgetId !== learning.scanBudgetId
    || definition.budgetAmount !== learning.scanBudgetAmount || definition.retrySafety !== 'never'
    || definition.maxRetries !== 0 || execution?.kind !== 'host'
    || execution.executorId !== 'assistant-memory-learning-v1' || execution.executorContractVersion !== 1
    || execution.runbookId !== 'scan' || execution.runbookVersion !== 1
    || execution.catalogDigest !== growthObjectDigest({ executor: 'assistant-memory-learning-v1', contract: 1 })
    || execution.ownerRouteId !== owner.authorityId || execution.activationNonce !== digest
    || !isDeepStrictEqual(execution.targetScope, { workspace: owner.workspace, preset: owner.agentPreset })
    || execution.scopeDigest !== growthObjectDigest([owner.workspace, owner.agentPreset])) {
    fail('target has no matching owner-bound native memory scan activation')
  }
}
async function ready(manifest: RsiSetupManifest, pin: RsiAuthorityConfigInput['systemctl'], signal: AbortSignal, startedAt: number): Promise<void> {
  const home = manifest.controlPlane.runtimeObserver!.profilePath.split('/profiles/').slice(0,-1).join('/profiles/')
  const memoryDatabasePath = manifest.memoryLearning === undefined ? undefined
    : rsiDatabasePaths(rsiSetupPorts.dump(manifest.targetProfile, home), home).automationsDatabasePath
  if (manifest.memoryLearning) {
    for (const [id, service] of [['dsh-enhanced-personal-assistant', 'personalMemory'],
      ['dsh-enhanced-assistant-verifier', 'assistantVerifier'],
      ['dsh-enhanced-assistant-memory-learning', 'assistantMemoryLearning']] as const) {
      if (!manifest.controlPlane.runtimeObserver?.targets.some(target => target.entryId === id
        && target.services.includes(service))) fail(`target memory observer is missing ${id}`)
    }
  }
  const deadline = Date.now() + 60_000
  let stableSince = 0, last = '', failure: unknown
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    try {
      const states = await Promise.all([manifest.targetProfile, manifest.coordinatorProfile].map(profile => status(pin, profile, signal)))
      if (states.some(state => state.ActiveState !== 'active' || !/^\d+$/u.test(state.MainPID ?? '') || Number(state.MainPID) < 1
        || !/^[a-f0-9]{32}$/u.test(state.InvocationID ?? ''))) fail('Host services are not running')
      await observerReady(manifest.controlPlane.runtimeObserver!, states[0]!, signal)
      if (memoryDatabasePath) assertRsiMemoryScanActivation(manifest, listActiveAutomationsForReadiness(memoryDatabasePath))
      const scope = manifest.controlPlane.taskObservations!.scope
      const coordinatorId = manifest.controlPlane.sourceAdoptions!.handoff!.coordinatorId
      const id = `adoption-coordinator-${controlPlaneDigest({coordinatorId,scope}).slice(0,40)}`
      const registration = listActiveAutomationsForReadiness(join(home,'rsi-coordinators',manifest.coordinatorProfile,'automations.sqlite')).find(item => item.id === id)
      if (!registration || registration.owner !== 'plugin-control-plane-adoption-coordinator'
        || registration.updatedAt < startedAt || registration.definition.execution?.kind !== 'host'
        || registration.definition.execution.executorId !== 'plugin-control-plane-adoption-coordinator-v1'
        || registration.definition.execution.ownerRouteId !== scope.ownerRouteId
        || registration.definition.principal !== scope.principalId || registration.definition.workspace !== scope.workspace
        || registration.definition.agentPreset !== scope.preset) fail('coordinator has no fresh owner-bound native activation')
      const current = JSON.stringify(states.map(state => [state.MainPID,state.InvocationID,state.NRestarts]))
      if (last !== current) { stableSince = Date.now(); last = current }
      if (Date.now() - stableSince >= 12_000) return
    } catch (error) { failure = error; stableSince = 0; last = '' }
    await delay(250, undefined, { signal })
  }
  throw new Error('rsi install: dual Host readiness failed; applied configuration retained for retry', { cause: failure })
}
export class RsiOwnerPreflightUnavailableError extends Error {
  readonly stage: string
  constructor(stage: string, message: string) {
    super(`rsi owner preflight unavailable (${stage}): ${message}`)
    this.name = 'RsiOwnerPreflightUnavailableError'
    this.stage = stage
  }
}

export interface RsiOwnerPreflightInput {
  input: RsiInstallInput
  prepared: Awaited<ReturnType<typeof prepareResources>>
  installed: Awaited<ReturnType<typeof collectRsiInstalledInputs>>
  manifest: RsiSetupManifest
  binding: RsiOwnerConfigurationContext['binding']
  profiles: RsiOwnerConfigurationContext['profiles']
  /** Present when this call replays an existing installation; fresh installs
   * have no installed owner policies or prior profile objects to re-read. */
  previousManifest?: RsiSetupManifest
  signal: AbortSignal
  /** Test seam: production reads the delegated cgroup roots from the host file
   * system; shape-only fixtures inject a probe because those descriptors never
   * touch the host. */
  cgroupRootsProbe?: (path: string, signal: AbortSignal) => Promise<void>
}

async function preflightStage<T>(stage: string, action: () => Promise<T> | T): Promise<T> {
  try { return await action() }
  catch (error) {
    if (error instanceof RsiOwnerPreflightUnavailableError) throw error
    throw new RsiOwnerPreflightUnavailableError(stage, error instanceof Error ? error.message : String(error))
  }
}

export interface RsiOwnerPreflightShapeInput {
  home: string
  manifest: RsiSetupManifest
  profiles: RsiOwnerConfigurationContext['profiles']
  installedPolicies?: readonly unknown[]
  previousManifest?: RsiSetupManifest
}

/**
 * Pure shape/consistency check for the owner manifest that is about to be
 * written. It never reads the file system: the full compile still runs at the
 * configure step after the profile directory and authority state exist. A fresh
 * install therefore passes without any installed policies or lstat of paths it
 * is about to create; a retry additionally proves the installed release policy
 * set is still readable.
 */
export function validateRsiOwnerPreflightShape(value: RsiOwnerPreflightShapeInput): void {
  const object = (value: unknown, label: string): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' is missing')
    return value as Record<string, unknown>
  }
  const text = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error(label + ' is invalid')
    return value
  }
  const manifest = object(value.manifest, 'manifest')
  if (manifest.schemaVersion !== 1) throw new Error('manifest schema is unsupported')
  const target = text(manifest.targetProfile, 'targetProfile')
  const coordinator = text(manifest.coordinatorProfile, 'coordinatorProfile')
  if (target === coordinator) throw new Error('target and coordinator profiles must differ')
  const reviews = object(manifest.sourceReviews, 'sourceReviews')
  const decisionRoot = text(reviews.decisionRoot, 'sourceReviews decisionRoot')
  const controlPlane = object(manifest.controlPlane, 'controlPlane')
  const releaseExecution = object(controlPlane.sourceReleaseExecution, 'sourceReleaseExecution')
  const reviewDecisionRoot = text(releaseExecution.reviewDecisionRoot, 'sourceReleaseExecution reviewDecisionRoot')
  if (decisionRoot !== reviewDecisionRoot) throw new Error('source review decision roots differ')
  const stateRoot = join(value.home, 'rsi-authorities', target, 'state')
  for (const [label, path] of [['sourceReviews decisionRoot', decisionRoot],
    ['sourceReleaseExecution reviewDecisionRoot', reviewDecisionRoot]] as const) {
    if (!isAbsolute(path) || resolve(path) !== path || !path.startsWith(stateRoot + '/')) {
      throw new Error(label + ' is outside the installation state root')
    }
  }
  for (const [label, group] of [['sourceJobs', controlPlane.sourceJobs], ['sourceBuild', controlPlane.sourceBuild],
    ['sourceAdoptions', controlPlane.sourceAdoptions], ['taskObservations', controlPlane.taskObservations]] as const) {
    object(group, label)
  }
  const jobs = object(controlPlane.sourceJobs, 'sourceJobs')
  if (typeof jobs.budgetId !== 'string' || typeof jobs.ownerRouteId !== 'string') throw new Error('sourceJobs is incomplete')
  const growth = object(manifest.growthDriver, 'growthDriver')
  if (growth.enabled !== true || typeof growth.budgetId !== 'string' || typeof growth.usageLearning !== 'object') {
    throw new Error('growthDriver is incomplete')
  }
  object(manifest.limits, 'limits')
  const memory = manifest.memoryLearning
  if (memory !== undefined) {
    const group = object(memory, 'memoryLearning')
    for (const key of ['learning', 'reviews', 'adoption'] as const) object(group[key], 'memoryLearning ' + key)
  }
  const ordinary = manifest.ordinaryUseLearning
  if (ordinary !== undefined) object(object(ordinary, 'ordinaryUseLearning').intakeEvaluation, 'ordinaryUseLearning intakeEvaluation')
  const creation = manifest.pluginCreation
  if (creation !== undefined) {
    const group = object(creation, 'pluginCreation')
    for (const key of ['creation', 'reviews'] as const) object(group[key], 'pluginCreation ' + key)
  }
  const revision = manifest.pluginRevision
  if (revision !== undefined) {
    const group = object(revision, 'pluginRevision')
    for (const key of ['revision', 'reviews'] as const) object(group[key], 'pluginRevision ' + key)
  }
  for (const [label, profile] of [['targetPatch', value.profiles.targetPatch],
    ['targetEffective', value.profiles.targetEffective], ['coordinatorPatch', value.profiles.coordinatorPatch],
    ['coordinatorEffective', value.profiles.coordinatorEffective], ['coordinatorBase', value.profiles.coordinatorBase]] as const) {
    // Compiled profile patches are full YAML documents; only the raw manifest
    // fields above are small bounded strings.
    if (typeof profile !== 'string' || profile.length === 0 || profile.length > 2_097_152) {
      throw new Error(label + ' is invalid')
    }
  }
  if (value.previousManifest !== undefined && (!value.installedPolicies || value.installedPolicies.length < 1)) {
    throw new Error('installed release policies are unavailable')
  }
}

/**
 * Read-only readiness gate. It runs before any Host is stopped and before any
 * owner grant, authority configuration or manifest is written; failures map to a
 * not-ready result so a retry can run after fixing the Host without reconciling
 * a partially issued authorization. Environment checks are limited to state the
 * installer itself prepared (pinned user manager, delegated cgroup descriptor,
 * private profiles/observer paths) plus the sandbox tool the runner needs.
 */
export async function preflightRsiOwnerReadiness(value: RsiOwnerPreflightInput): Promise<void> {
  const { input, prepared, manifest, profiles, signal } = value
  const home = input.dshHome, pair = [manifest.targetProfile, manifest.coordinatorProfile] as const
  signal.throwIfAborted()
  // Service manager: the pinned user manager must answer a read-only query.
  await preflightStage('service-manager', () => systemctl(value.installed.systemctl, ['show-environment'], signal))
  // release-pinned tools: re-read the exact bwrap and tar pins recorded by the
  // release build environment. Existence, executable mode and content digest
  // must still match; a PATH lookup or a foreign binary is not accepted.
  await preflightStage('tool-pin', async () => {
    const pins = prepared.release.releaseBuild
    for (const [label, pin] of [['bwrap', pins.sandboxExecutable], ['tar', pins.tarExecutable]] as const) {
      if (!isAbsolute(pin.path) || resolve(pin.path) !== pin.path || !/^[a-f0-9]{64}$/u.test(pin.sha256)) {
        throw new Error(label + ' release pin is invalid')
      }
      const entry = await lstat(pin.path)
      if (!entry.isFile() || (entry.mode & 0o111) === 0) throw new Error(label + ' release pin is not an executable file: ' + pin.path)
      if (hash(await readFile(pin.path)) !== pin.sha256) throw new Error(label + ' release pin content changed: ' + pin.path)
    }
  })
  // cgroup: the delegated v1 descriptor frozen during preparation must still be
  // complete, and each root must be a readable/searchable directory on the host.
  await preflightStage('cgroup', async () => {
    const roots = prepared.build.sourceBuild.cgroupRoots
    const control = roots.mode === 'v1' ? [roots.cpu, roots.memory, roots.pids, roots.freezer] : []
    if (roots.mode !== 'v1' || control.length !== 4 || new Set(control).size !== 4
      || control.some(path => !isAbsolute(path) || resolve(path) !== path)) {
      throw new Error('delegated cgroup v1 roots are incomplete')
    }
    const probe = value.cgroupRootsProbe ?? (async (path: string, probeSignal: AbortSignal) => {
      probeSignal.throwIfAborted()
      const entry = await lstat(path)
      if (!entry.isDirectory()) throw new Error('delegated cgroup root is not a directory: ' + path)
      await access(path, constants.R_OK | constants.X_OK)
    })
    for (const path of control) await probe(path, signal)
  })
  // observer: the native socket path must fit sun_path, stay inside the private
  // installation roots and name both profiles. A fresh install validates the
  // shape of paths it is about to create; a retry also re-reads the existing
  // private profile directories and observer socket parent.
  await preflightStage('observer', async () => {
    const observer = manifest.controlPlane.runtimeObserver
    if (!observer) throw new Error('runtime observer is missing')
    if (!isAbsolute(observer.socketPath) || resolve(observer.socketPath) !== observer.socketPath
      || Buffer.byteLength(observer.socketPath) > 100) throw new Error('runtime observer socket path is invalid')
    const authorityRoot = join(home, 'rsi-authorities', pair[0])
    if (!isAbsolute(observer.keyPath) || resolve(observer.keyPath) !== observer.keyPath
      || observer.keyPath !== join(authorityRoot, 'config', 'observer.key')) throw new Error('runtime observer key path is invalid')
    if (observer.profilePath !== join(home, 'profiles', pair[0])) throw new Error('runtime observer profile differs from the target installation')
    const socketParent = dirname(observer.socketPath)
    if (socketParent !== join(authorityRoot, 'state')) throw new Error('runtime observer socket is outside the installation state root')
    const profilesRoot = join(home, 'profiles')
    for (const profile of pair) {
      const path = join(profilesRoot, profile)
      if (!isAbsolute(path) || resolve(path) !== path || !path.startsWith(profilesRoot + '/')) throw new Error('owner profile path is invalid')
    }
    if (value.previousManifest !== undefined) {
      for (const profile of pair) await io.directory(join(profilesRoot, profile), false)
      await io.directory(socketParent)
    }
  })
  // authority: shape and consistency only. The full compile remains at the
  // configure step, where the profile directory and authority state exist; a
  // fresh install must not require installed policies or lstat paths that are
  // about to be created, while a retry still proves those policies are readable.
  await preflightStage('authority', async () => {
    validateRsiOwnerPreflightShape({ home, manifest, profiles,
      ...(value.previousManifest === undefined ? {} : { previousManifest: value.previousManifest,
        installedPolicies: value.installed.policies }) })
  })
}


export interface RsiInstallPorts {
  prepare: typeof prepareResources
  collect: typeof collectRsiInstalledInputs
  coordinator: typeof ensureCoordinator
  setup: RsiSetupPorts
  capture: typeof captureRsiSystemdUnitProperties
  stop: typeof stopManaged
  readUnit: typeof readRsiSystemdUnitProperties
  ready: typeof ready
  configure: typeof configureRsiSetupLocked
  prepareOwner: typeof prepareRsiOwnerConfiguration
  preflight: typeof preflightRsiOwnerReadiness
}
export const rsiInstallPorts: RsiInstallPorts = {
  prepare: prepareResources, collect: collectRsiInstalledInputs, coordinator: ensureCoordinator, setup: rsiSetupPorts,
  capture: captureRsiSystemdUnitProperties, readUnit: readRsiSystemdUnitProperties, stop: stopManaged, ready, configure: configureRsiSetupLocked, prepareOwner: prepareRsiOwnerConfiguration, preflight: preflightRsiOwnerReadiness,
}

/** Installer-owned process, never invoked from the Host being restarted. */
export async function installRsiOwnerDeployment(input: RsiInstallInput, ports: RsiInstallPorts = rsiInstallPorts): Promise<RsiInstallResult> {
  if (!profilePattern.test(input.profile) || await realpath(input.dshHome) !== input.dshHome) fail('invalid installation identity')
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(2_400_000)])
  signal.throwIfAborted()
  return withDshHomeLifecycleLock(input.dshHome, async () => {
    let prepared: Awaited<ReturnType<typeof prepareResources>>
    try { prepared = await ports.prepare(input, signal) }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof RsiReleaseBuildUnavailableError
        || error instanceof LinuxRsiRuntimeUnavailableError || error instanceof RsiLinuxCgroupUnavailableError
        || error instanceof RsiLinuxCreationBuildUnavailableError) return { mode: 'not-ready', reason: error.message }
      throw error
    }
    const { resources, runtime, source, build, release } = prepared
    let targetEffective = ports.setup.dump(input.profile, input.dshHome)
    let installed: Awaited<ReturnType<typeof collectRsiInstalledInputs>>
    try { installed = await ports.collect({ dshHome: input.dshHome, targetProfile: input.profile, targetEffective, resources, source }) }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof RsiInstalledInputsUnavailableError) return { mode: 'not-ready', reason: error.message }
      throw error
    }
    const coordinatorProfile = rsiCoordinatorProfile(input.profile)
    await ports.coordinator(input, coordinatorProfile, installed.executor, signal, installed.systemctl)
    const pair = [input.profile, coordinatorProfile] as const
    const setupJournal = join(input.dshHome,'.rsi-setup-journal.json')
    if (await exists(setupJournal)) {
      const interrupted = JSON.parse((await io.readStable(setupJournal,2_097_152,true)).toString('utf8')) as {stage?:string;entries?:Array<{profile?:string}>}
      if (interrupted.stage === 'prepared') {
        if (!Array.isArray(interrupted.entries) || interrupted.entries.length !== 2
          || interrupted.entries.some((entry,index) => entry.profile !== pair[index])) fail('interrupted setup belongs to another profile pair')
        const recoveryRunning: string[] = []
        for (const profile of [...pair].reverse()) if (await ports.stop(input,profile,installed.systemctl,signal)) recoveryRunning.push(profile)
        await ports.configure({dshHome:input.dshHome,manifestPath:join(resources.configRoot,'manifest.json'),
          apply:false,rollback:true,start:false,confirmStopped:true,help:false},ports.setup)
        // A successful rollback restores a known deployment. Restore prior
        // availability before any new owner or source preflight can fail.
        for (const profile of recoveryRunning) await ports.setup.start(profile,input.dshHome)
        targetEffective = ports.setup.dump(input.profile,input.dshHome)
        installed = await ports.collect({dshHome:input.dshHome,targetProfile:input.profile,targetEffective,resources,source})
      }
    }
    const profiles = { targetPatch: (await io.readStable(join(input.dshHome, 'profiles', pair[0], 'cordis.patch.yml'), 2_097_152)).toString('utf8'),
      targetEffective, coordinatorPatch: (await io.readStable(join(input.dshHome, 'profiles', pair[1], 'cordis.patch.yml'), 2_097_152)).toString('utf8'),
      coordinatorEffective: ports.setup.dump(pair[1], input.dshHome), coordinatorBase: await ports.setup.base(pair[1], input.dshHome) }
    const snapshot = await ports.setup.snapshot(targetEffective, input.dshHome)
    if (snapshot.bindings.length !== 1) fail('exactly one active owner DM is required')
    const binding = snapshot.bindings[0]!
    const storedManifest = join(resources.configRoot, 'manifest.json')
    let now = Date.now(), expiresAt = now + 365 * 86_400_000
    let enableCreation = true
    let enableOrdinaryUseLearning = input.enableOrdinaryUseLearning === true
    let skipMemoryLearning = input.skipMemoryLearning === true
    let intakeProvider = input.intakeProvider, intakeModel = input.intakeModel
    let previousManifest: RsiSetupManifest | undefined
    if (await exists(storedManifest)) {
      // A retry reuses the original installation's finite terms, never renews them.
      const previous = JSON.parse((await io.readStable(storedManifest, 2_097_152, true)).toString('utf8')) as RsiSetupManifest
      previousManifest = previous
      const host = JSON.parse((await io.readStable(join(resources.configRoot,'host-authority.json'), 2_097_152, true)).toString('utf8')) as { grant: { notBefore: number } }
      now = host.grant.notBefore; expiresAt = previous.sourceReviews.expiresAt
      // Replaying a legacy installation must not silently add a new authority.
      enableCreation = previous.pluginCreation !== undefined
      const storedOrdinary = previous.ordinaryUseLearning?.intakeEvaluation
      if (input.enableOrdinaryUseLearning === true && storedOrdinary === undefined) {
        fail('existing installation cannot be expanded with ordinary-use learning; install a fresh profile instead')
      }
      // A retry preserves exactly the stored opt-in and route, like enableRevision.
      enableOrdinaryUseLearning = storedOrdinary !== undefined
      if (storedOrdinary !== undefined) { intakeProvider = storedOrdinary.provider; intakeModel = storedOrdinary.model }
      // A skip decision is likewise frozen: an existing installation that already
      // issued memory-learning grants must not drop or renew them, while an
      // interrupted skip retry keeps the memory-learning chain absent.
      if (input.skipMemoryLearning === true && previous.memoryLearning !== undefined) {
        fail('existing installation cannot drop memory learning; reinstall a fresh profile to change the decision')
      }
      skipMemoryLearning = previous.memoryLearning === undefined
    }
    const manifest = createRsiBootstrapManifest({ dshHome: input.dshHome, targetProfile: pair[0], coordinatorProfile: pair[1],
      targetEffective, owner: binding, resources, runtime, source, sourceBuild: build.sourceBuild,
      ...(enableCreation && prepared.creationBuild ? { creationBuild: prepared.creationBuild } : {}),
      ...(prepared.runnerStates ? { runnerStates: prepared.runnerStates } : {}),
      ...(previousManifest ? { enableRevision: previousManifest.pluginRevision !== undefined } : {}),
      enableOrdinaryUseLearning,
      skipMemoryLearning,
      ...(intakeProvider !== undefined ? { intakeProvider } : {}),
      ...(intakeModel !== undefined ? { intakeModel } : {}),
      git: installed.git, now, expiresAt, plugins: installed.plugins,
      observerTargets: installed.observerTargets, hostDeploymentInputs: installed.hostDeploymentInputs })
    if (previousManifest && !isDeepStrictEqual(previousManifest, manifest)) fail('existing manifest differs before stopping Hosts')
    if (previousManifest) {
      const compiledPatches = await ports.setup.compile({ manifest, dshHome: input.dshHome,
        ...profiles, owner: binding })
      await inspectRsiOwnerConfiguration({ manifest, resources, patches: compiledPatches, signal })
    }
    const inventories = await captureRsiAutomationInventories(ports.setup.automationInventory,
      targetEffective, profiles.coordinatorEffective, input.dshHome, coordinatorProfile)
    assertRsiSchedulerActivation(inventories, input.ackExistingAutomations === true)
    const previousJournal = await exists(setupJournal) ? (await io.readStable(setupJournal,2_097_152,true)).toString('utf8') : null
    // Readiness preflight before stopping Hosts or issuing grants: the owner
    // configuration (authorities, manifest and memory-learning grants) is only
    // written after the pinned user manager, sandbox, delegated cgroup roots,
    // observer placement and compiled owner profile are all readable.
    try {
      await ports.preflight({ input, prepared, installed, manifest, binding, profiles, signal,
        ...(previousManifest === undefined ? {} : { previousManifest }) })
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof RsiOwnerPreflightUnavailableError) return { mode: 'not-ready', reason: error.message }
      throw error
    }
    const running = new Set<string>()
    let applied = false
    try {
      for (const profile of [...pair].reverse()) if (await ports.stop(input, profile, installed.systemctl, signal)) running.add(profile)
      signal.throwIfAborted()
      if (!isDeepStrictEqual(snapshot.bindings, (await ports.setup.snapshot(targetEffective,input.dshHome)).bindings)
        || ports.setup.dump(pair[0],input.dshHome) !== targetEffective
        || ports.setup.dump(pair[1],input.dshHome) !== profiles.coordinatorEffective) fail('owner or profile changed while stopping Hosts')
      if (!isDeepStrictEqual(inventories, await captureRsiAutomationInventories(ports.setup.automationInventory,
        targetEffective, profiles.coordinatorEffective, input.dshHome, coordinatorProfile))) fail('Automation inventory changed while stopping Hosts')
      const unitProperties = await ports.capture({ dshHome: input.dshHome, profile: pair[0] },
        { systemctl: { ...installed.systemctl, interpreter: null }, environment: manifest.serviceEnvironment!.target, signal })
      const configuration = await ports.prepareOwner({ manifest, resources, runtime, source, releaseBuild: release.releaseBuild,
        executor: installed.executor, systemctl: installed.systemctl, unitProperties, policies: installed.policies, now }, { binding, profiles, signal })
      const args = { dshHome: input.dshHome, manifestPath: configuration.manifestPath, apply: true, rollback: false,
        start: false, confirmStopped: true, help: false, ackExistingAutomations: input.ackExistingAutomations === true,
        expectedAutomationInventories: inventories }
      const deploymentPorts: RsiSetupPorts = { ...ports.setup, async validateServiceUnits(value, environment) {
        await ports.setup.validateServiceUnits(value, environment)
        const current = await ports.readUnit({ dshHome: input.dshHome, profile: pair[0] },
          { systemctl: { ...installed.systemctl, interpreter: null }, signal })
        if (!isDeepStrictEqual(current, unitProperties)) fail('final loaded systemd unit differs from the installation grant')
      } }
      await ports.configure(args, deploymentPorts)
      applied = true
      signal.throwIfAborted()
      // The setup journal remains the source of recovery truth after application.
      const startedAt = Date.now()
      await ports.setup.start(pair[1],input.dshHome)
      await ports.setup.start(pair[0],input.dshHome)
      await ports.ready(manifest,installed.systemctl,signal,startedAt)
      await deploymentPorts.validateServiceUnits(manifest,manifest.serviceEnvironment!.target)
      return { mode: 'ready', profiles: pair, manifestPath: configuration.manifestPath }
    } catch (error) {
      if (!applied) {
        // Restore availability only when all profile bytes and the unit are still
        // the original deployment. Unknown outcomes retain stopped services.
        const unchanged = await Promise.all(pair.map(async (profile,index) => {
          const bytes = (await io.readStable(join(input.dshHome,'profiles',profile,'cordis.patch.yml'),2_097_152)).toString('utf8')
          return bytes === (index === 0 ? profiles.targetPatch : profiles.coordinatorPatch)
        })).catch(() => [false])
        const recoveredJournal = await exists(setupJournal) ? (await io.readStable(setupJournal,2_097_152,true)).toString('utf8') : null
        if (unchanged.every(Boolean) && recoveredJournal === previousJournal) {
          for (const profile of [...pair].reverse()) if (running.has(profile)) {
            const environment = await readRsiServiceEnvironment(input.dshHome,profile)
            const rendered = await ports.setup.renderServiceUnit(profile,input.dshHome,environment ?? {})
            const actual = await readFile(ports.setup.serviceUnitPath(profile,input.dshHome),'utf8').catch(() => '')
            if (actual === rendered) await ports.setup.start(profile,input.dshHome)
          }
        }
      }
      throw error
    }
  })
}
