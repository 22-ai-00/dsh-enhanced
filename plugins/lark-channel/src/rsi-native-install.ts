import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { listActiveAutomationsLocally } from '@dsh-enhanced/assistant-automations'
import { withDshHomeLifecycleLock } from './setup.js'
import { withLaunchAgentTargetLock } from './launchd-target-lock.js'
import { createLaunchAgent, launchAgentPaths } from './launchd.js'
import { prepareRsiSourceWorkspace } from './rsi-source.js'
import { prepareRsiBuildEnvironment, RsiBuildUnavailableError, rsiBuildResources as io } from './rsi-build.js'
import { prepareRsiCreationBuildEnvironment } from './rsi-creation-build.js'
import { prepareRsiAuthorityResources } from './rsi-authority-resources.js'
import { compileNativeRsiProfile, type NativeRsiCompiledProfile, type NativeRsiSetupManifest } from './rsi-native-profile.js'
import { assertRsiEffectivePatch, rsiSetupPorts } from './rsi-setup.js'
import { resolveInstalledRsiDsh } from './rsi-install-inputs.js'
import { assertRsiMemoryScanActivation, type RsiInstallInput, type RsiInstallResult } from './rsi-install.js'
import { rsiDatabasePaths } from './rsi-owner-profile.js'
import { assertNativeLaunchdPlist, inspectNativeLaunchd, startNativeLaunchd, stopNativeLaunchd, waitNativeRuntimeReady, type NativeLaunchdIdentity } from './rsi-native-launchd.js'
import { version } from './version.js'

const MAX_BYTES = 4_194_304
function fail(message: string): never { throw new Error(`rsi native install: ${message}`) }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function optional(path: string, privateFile = true): Promise<string | null> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.nlink !== 1 || entry.mode & 0o022 || await realpath(path) !== path) fail(`unsafe file: ${path}`)
    return (await io.readStable(path, MAX_BYTES, privateFile)).toString('utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
async function atomic(path: string, value: string | null): Promise<void> {
  if (value === null) { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error }); await io.syncDirectory(dirname(path)); return }
  const temporary = `${path}.${randomUUID()}.tmp`
  await io.writeExclusive(temporary, value)
  try { await rename(temporary, path); await io.syncDirectory(dirname(path)) }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
async function immutable(path: string, value: string): Promise<void> {
  const existing = await optional(path)
  if (existing !== null) { if (existing !== value) fail(`frozen authority changed: ${path}`); return }
  await io.writeExclusive(path, value); await io.syncDirectory(dirname(path))
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  await io.directory(path)
}

async function prepare(input: RsiInstallInput, signal: AbortSignal) {
  const source = await prepareRsiSourceWorkspace({ ...input, version, signal })
  const resources = await prepareRsiAuthorityResources({ ...input, signal })
  const build = await prepareRsiBuildEnvironment({ ...input, source, signal })
  const creationBuild = await prepareRsiCreationBuildEnvironment({ ...input, source, build, signal })
  for (const name of ['creation-review-runner', 'creation-adoption-runner']) await privateDirectory(join(resources.stateRoot, name))
  const dsh = await resolveInstalledRsiDsh()
  return { source, resources, build, creationBuild,
    executor: { id: 'dsh', version: dsh.version, path: dsh.path, sha256: dsh.pin.sha256, environmentAllowlist: [] } }
}
async function ready(input: RsiInstallInput & NativeLaunchdIdentity, manifest: NativeRsiSetupManifest, signal: AbortSignal) {
  await waitNativeRuntimeReady(input, manifest.controlPlane.runtimeObserver!, signal)
  const effective = rsiSetupPorts.dump(input.profile, input.dshHome)
  const database = rsiDatabasePaths(effective, input.dshHome).automationsDatabasePath
  assertRsiMemoryScanActivation(manifest, listActiveAutomationsLocally(database))
}
export interface NativeRsiInstallPorts {
  prepare: typeof prepare
  compile: typeof compileNativeRsiProfile
  dump: typeof rsiSetupPorts.dump
  snapshot: typeof rsiSetupPorts.snapshot
  inventory: typeof rsiSetupPorts.automationInventory
  inspect: typeof inspectNativeLaunchd
  validatePlist: typeof assertNativeLaunchdPlist
  stop: typeof stopNativeLaunchd
  start: typeof startNativeLaunchd
  ready: typeof ready
  home?: string
  now: () => number
}
export const nativeRsiInstallPorts: NativeRsiInstallPorts = { prepare, compile: compileNativeRsiProfile,
  dump: rsiSetupPorts.dump, snapshot: rsiSetupPorts.snapshot, inventory: rsiSetupPorts.automationInventory,
  inspect: inspectNativeLaunchd, validatePlist: assertNativeLaunchdPlist, stop: stopNativeLaunchd,
  start: startNativeLaunchd, ready, now: Date.now }
interface Plan {
  schemaVersion: 1; dshHome: string; profile: string; now: number; expiresAt: number
  beforePatch: string; beforeEffective: string; beforePlist: string | null; registered: boolean
  afterPlist: string; compiled: NativeRsiCompiledProfile; owner: unknown; observerKeyDigest: string
  sourceCommit: string; executor: Awaited<ReturnType<typeof prepare>>['executor']
}
interface Journal {
  schemaVersion: 1; planDigest: string; stage: 'prepared' | 'applied' | 'ready' | 'rolled-back'
  beforePatch: string; beforePlist: string | null; registered: boolean
}

/** A single native Host owns the existing task loop. Grants are immutable and
 * finite; retries resume the same grant, and never mint replacement budgets. */
export async function installNativeRsiOwnerDeployment(input: RsiInstallInput,
  ports: NativeRsiInstallPorts = nativeRsiInstallPorts): Promise<RsiInstallResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profile) || input.profile === 'desktop'
    || await realpath(input.dshHome) !== input.dshHome) fail('invalid native installation identity')
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(2_400_000)])
  return withDshHomeLifecycleLock(input.dshHome, () => withLaunchAgentTargetLock(input, async () => {
    let prepared: Awaited<ReturnType<typeof prepare>>
    try { prepared = await ports.prepare(input, signal) }
    catch (error) { signal.throwIfAborted(); if (error instanceof RsiBuildUnavailableError) return { mode: 'not-ready', reason: error.message }; throw error }
    const { resources, source, build, creationBuild, executor } = prepared
    const serviceInput = { ...input, ...(ports.home ? { home: ports.home } : {}), nodePath: await realpath(process.execPath),
      dshPath: executor.path, dshSha256: executor.sha256 }, paths = launchAgentPaths(serviceInput)
    const profileRoot = join(input.dshHome, 'profiles', input.profile), patchPath = join(profileRoot, 'cordis.patch.yml')
    await io.directory(profileRoot, false)
    await mkdir(dirname(paths.plistPath), { recursive: true, mode: 0o700 }); await io.directory(dirname(paths.plistPath), false)
    await privateDirectory(join(input.dshHome, 'logs'))
    const observerRoot = join(input.dshHome, `.rsi-${digest(input.profile).slice(0, 12)}`)
    await privateDirectory(observerRoot)
    const observer = { socketPath: join(observerRoot, 'observe.sock'), keyPath: join(observerRoot, 'key') }
    if (Buffer.byteLength(observer.socketPath) > 100) fail('DSH_HOME is too long for a native Unix socket')
    if (await optional(observer.keyPath) === null) await io.writeExclusive(observer.keyPath, randomBytes(32))
    const key = await io.readStable(observer.keyPath, 32, true)
    if (key.length !== 32) fail('invalid observer key')
    const observerKeyDigest = createHash('sha256').update(key).digest('hex'); key.fill(0)
    const planPath = join(resources.configRoot, 'native-plan.json'), journalPath = join(resources.configRoot, 'native-journal.json')
    const manifestPath = join(resources.configRoot, 'native-manifest.json')
    const saved = await optional(planPath)
    const old = saved === null ? undefined : JSON.parse(saved) as Plan
    if (old && (old.schemaVersion !== 1 || old.dshHome !== input.dshHome || old.profile !== input.profile
      || typeof old.beforePatch !== 'string' || typeof old.beforeEffective !== 'string' || typeof old.afterPlist !== 'string'
      || old.sourceCommit !== source.sourceCommit || !isDeepStrictEqual(old.executor, executor)
      || old.observerKeyDigest !== observerKeyDigest)) fail('frozen native installation inputs changed')
    const targetPatch = await optional(patchPath, false)
    if (targetPatch === null) fail('target profile patch is missing')
    const effective = ports.dump(input.profile, input.dshHome), snapshot = await ports.snapshot(effective, input.dshHome)
    if (snapshot.bindings.length !== 1) fail('exactly one current owner DM is required')
    const owner = snapshot.bindings[0]!
    if (old && !isDeepStrictEqual(old.owner, owner)) fail('owner changed; frozen grants cannot be reused')
    const now = old?.now ?? ports.now(), expiresAt = old?.expiresAt ?? now + 365 * 86_400_000
    if (expiresAt <= ports.now()) fail('native grant expired; reinstall does not renew it')
    const compiled = ports.compile({ dshHome: input.dshHome, targetProfile: input.profile,
      targetPatch: old?.beforePatch ?? targetPatch, targetEffective: old?.beforeEffective ?? effective,
      owner, resources, source, sourceBuild: build.sourceBuild, creationBuild, executor, now, expiresAt, observer })
    if (old && !isDeepStrictEqual(old.compiled, compiled)) fail('native compiled grant differs from the frozen plan')
    const currentPlist = await optional(paths.plistPath, false)
    if (currentPlist !== null) ports.validatePlist(currentPlist, serviceInput)
    const state = ports.inspect(serviceInput)
    if (state.registered && currentPlist === null) fail('loaded service has no restorable plist')
    const afterPlist = old?.afterPlist ?? createLaunchAgent({ ...paths, dshHome: input.dshHome, profile: input.profile,
      profileDirectory: profileRoot, nodePath: await realpath(process.execPath), dshPath: executor.path,
      path: [...new Set([dirname(await realpath(process.execPath)), dirname(executor.path),
        ...(process.env.PATH ?? '').split(':').filter(value => value.startsWith('/')), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':') })
    ports.validatePlist(afterPlist, serviceInput)
    const plan: Plan = old ?? { schemaVersion: 1, dshHome: input.dshHome, profile: input.profile, now, expiresAt,
      beforePatch: targetPatch, beforeEffective: effective, beforePlist: currentPlist, registered: state.registered,
      afterPlist, compiled, owner, observerKeyDigest, sourceCommit: source.sourceCommit, executor }
    if (![plan.beforePatch, compiled.targetPatch].includes(targetPatch)
      || currentPlist !== plan.beforePlist && currentPlist !== plan.afterPlist) fail('profile or service changed outside the installation transaction')
    const inventory = await ports.inventory(effective, input.dshHome)
    if (!inventory.schedulerEnabled && inventory.records.length && !input.ackExistingAutomations) fail('existing active or paused Automations require --ack-existing-automations')
    const planBytes = JSON.stringify(plan), planDigest = digest(planBytes), journalBytes = await optional(journalPath)
    let attempt = { beforePatch: targetPatch, beforePlist: currentPlist, registered: state.registered }
    if (journalBytes !== null) {
      const previous = JSON.parse(journalBytes) as Journal
      if (previous.schemaVersion !== 1 || previous.planDigest !== planDigest
        || !['prepared', 'applied', 'ready', 'rolled-back'].includes(previous.stage)
        || ![plan.beforePatch, compiled.targetPatch].includes(previous.beforePatch)
        || previous.beforePlist !== plan.beforePlist && previous.beforePlist !== plan.afterPlist
        || typeof previous.registered !== 'boolean') fail('native journal does not match the frozen plan')
      // Resume an interrupted attempt with its original rollback boundary. A
      // new retry after success preserves the already-installed deployment.
      if (previous.stage === 'prepared' || previous.stage === 'applied') {
        attempt = { beforePatch: previous.beforePatch, beforePlist: previous.beforePlist, registered: previous.registered }
      }
    }
    await immutable(planPath, planBytes)
    await immutable(manifestPath, JSON.stringify(compiled.manifest))
    await immutable(compiled.manifest.controlPlane.trustPath, JSON.stringify(compiled.trust))
    const journal = (stage: Journal['stage']) => atomic(journalPath, JSON.stringify({ schemaVersion: 1, planDigest, stage, ...attempt }))
    await journal('prepared')
    // A failed or interrupted attempt restores exact original bytes. No grant,
    // runtime ledger, candidate history or resource directory is deleted.
    const restore = async () => {
      const recovery = AbortSignal.timeout(60_000)
      await ports.stop(serviceInput, recovery)
      const patch = await optional(patchPath, false), plist = await optional(paths.plistPath, false)
      if (patch !== plan.beforePatch && patch !== compiled.targetPatch
        || plist !== plan.beforePlist && plist !== plan.afterPlist) fail('rollback conflicts with external changes; retain journal')
      await atomic(patchPath, attempt.beforePatch); await atomic(paths.plistPath, attempt.beforePlist)
      if (attempt.registered) await ports.start(serviceInput, recovery)
      await journal('rolled-back')
    }
    try {
      await ports.stop(serviceInput, signal)
      if (await optional(patchPath, false) !== targetPatch || await optional(paths.plistPath, false) !== currentPlist) fail('profile or service drifted while stopping')
      const stoppedEffective = ports.dump(input.profile, input.dshHome)
      const stoppedOwner = await ports.snapshot(stoppedEffective, input.dshHome)
      const stoppedInventory = await ports.inventory(stoppedEffective, input.dshHome)
      if (stoppedEffective !== effective || !isDeepStrictEqual(stoppedOwner.bindings, snapshot.bindings)
        || !isDeepStrictEqual(stoppedInventory, inventory)) fail('owner, profile or Automation inventory changed while stopping')
      await atomic(patchPath, compiled.targetPatch)
      assertRsiEffectivePatch(compiled.targetPatch, ports.dump(input.profile, input.dshHome))
      await atomic(paths.plistPath, plan.afterPlist); await journal('applied')
      await ports.start(serviceInput, signal)
      await ports.ready(serviceInput, compiled.manifest, signal)
      const readyEffective = ports.dump(input.profile, input.dshHome)
      assertRsiEffectivePatch(compiled.targetPatch, readyEffective)
      if (!isDeepStrictEqual((await ports.snapshot(readyEffective, input.dshHome)).bindings, snapshot.bindings)) {
        fail('owner changed during startup readiness')
      }
      await journal('ready')
      return { mode: 'ready', profiles: [input.profile], manifestPath }
    } catch (error) {
      try { await restore() }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'rsi native install failed and rollback requires reconciliation') }
      throw error
    }
  }))
}
