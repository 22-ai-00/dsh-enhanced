import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { listActiveAutomationsLocally } from '@dsh-enhanced/assistant-automations'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import { isDeepStrictEqual } from 'node:util'
import { controlPlaneDigest, queryRuntimeObserver, runtimeConfigDigest, type RuntimeObserverConfig } from '@dsh-enhanced/plugin-control-plane'
import { withDshHomeLifecycleLock } from './setup.js'
import { prepareRsiSourceWorkspace } from './rsi-source.js'
import { prepareRsiBuildEnvironment, RsiBuildUnavailableError, rsiBuildResources as io } from './rsi-build.js'
import { prepareRsiReleaseBuildEnvironment, RsiReleaseBuildUnavailableError } from './rsi-release-build.js'
import { prepareRsiAuthorityRuntime } from './rsi-authority-runtime.js'
import { prepareRsiAuthorityResources } from './rsi-authority-resources.js'
import { createRsiBootstrapManifest } from './rsi-bootstrap-manifest.js'
import { prepareRsiCreationBuildEnvironment, type RsiCreationBuildEnvironment } from './rsi-creation-build.js'
import { validateRsiPluginCreationSetup } from './rsi-plugin-creation.js'
import { inspectRsiOwnerConfiguration, prepareRsiOwnerConfiguration } from './rsi-bootstrap.js'
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
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function fail(message: string): never { throw new Error(`rsi install: ${message}`) }
export interface RsiInstallInput { dshHome: string; profile: string; sourceRepository?: string | undefined; signal?: AbortSignal; ackExistingAutomations?: boolean | undefined }
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
  const build = await prepareRsiBuildEnvironment({ ...input, source, signal })
  const release = await prepareRsiReleaseBuildEnvironment({ ...input, build, signal })
  const storedManifest = join(resources.configRoot, 'manifest.json')
  const previous = await exists(storedManifest)
    ? JSON.parse((await io.readStable(storedManifest, 2_097_152, true)).toString('utf8')) as RsiSetupManifest
    : undefined
  if (previous?.pluginCreation !== undefined) validateRsiPluginCreationSetup(previous.pluginCreation, previous.sourceReviews.owner)
  const creationBuild: RsiCreationBuildEnvironment | undefined = previous && previous.pluginCreation === undefined
    ? undefined : await prepareRsiCreationBuildEnvironment({ ...input, source, build, signal })
  if (creationBuild) {
    for (const name of ['creation-review-runner', 'creation-adoption-runner']) {
      const path = join(resources.stateRoot, name)
      if (!await exists(path)) await mkdir(path, { mode: 0o700 })
      await io.directory(path)
    }
  }
  return { source, runtime, resources, build, release, ...(creationBuild ? { creationBuild } : {}) }
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
export function assertRsiMemoryScanActivation(manifest: RsiSetupManifest,
  records: ReturnType<typeof listActiveAutomationsLocally>): void {
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
      if (memoryDatabasePath) assertRsiMemoryScanActivation(manifest, listActiveAutomationsLocally(memoryDatabasePath))
      const scope = manifest.controlPlane.taskObservations!.scope
      const coordinatorId = manifest.controlPlane.sourceAdoptions!.handoff!.coordinatorId
      const id = `adoption-coordinator-${controlPlaneDigest({coordinatorId,scope}).slice(0,40)}`
      const registration = listActiveAutomationsLocally(join(home,'rsi-coordinators',manifest.coordinatorProfile,'automations.sqlite')).find(item => item.id === id)
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
}
export const rsiInstallPorts: RsiInstallPorts = {
  prepare: prepareResources, collect: collectRsiInstalledInputs, coordinator: ensureCoordinator, setup: rsiSetupPorts,
  capture: captureRsiSystemdUnitProperties, readUnit: readRsiSystemdUnitProperties, stop: stopManaged, ready, configure: configureRsiSetupLocked, prepareOwner: prepareRsiOwnerConfiguration,
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
      if (error instanceof RsiBuildUnavailableError || error instanceof RsiReleaseBuildUnavailableError) return { mode: 'not-ready', reason: error.message }
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
    let previousManifest: RsiSetupManifest | undefined
    if (await exists(storedManifest)) {
      // A retry reuses the original installation's finite terms, never renews them.
      const previous = JSON.parse((await io.readStable(storedManifest, 2_097_152, true)).toString('utf8')) as RsiSetupManifest
      previousManifest = previous
      const host = JSON.parse((await io.readStable(join(resources.configRoot,'host-authority.json'), 2_097_152, true)).toString('utf8')) as { grant: { notBefore: number } }
      now = host.grant.notBefore; expiresAt = previous.sourceReviews.expiresAt
      // Replaying a legacy installation must not silently add a new authority.
      enableCreation = previous.pluginCreation !== undefined
    }
    const manifest = createRsiBootstrapManifest({ dshHome: input.dshHome, targetProfile: pair[0], coordinatorProfile: pair[1],
      targetEffective, owner: binding, resources, runtime, source, sourceBuild: build.sourceBuild,
      ...(enableCreation && prepared.creationBuild ? { creationBuild: prepared.creationBuild } : {}),
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
