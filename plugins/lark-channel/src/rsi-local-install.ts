import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'
import { rsiBuildResources as io } from './rsi-build.js'
import { resolveInstalledRsiDsh, type InstalledRsiDsh } from './rsi-install-inputs.js'
import { prepareRsiSourceWorkspace } from './rsi-source.js'
import { prepareRsiLocalCohort, readRsiLocalCohort, verifyRsiLocalInstalledPackages, rsiLocalPeerOverrides, rsiLocalRuntimeClosure, type RsiLocalCohort } from './rsi-local-cohort.js'
import { withDshHomeLifecycleLock } from './setup.js'
import { version } from './version.js'

function fail(message: string): never { throw new Error(`rsi local install: ${message}`) }
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
async function systemctlPin() {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    let path: string
    try { path = await realpath(join(directory,'systemctl')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const bytes = await io.readStable(path,67_108_864,false,true)
    if (!bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))) fail('systemctl must be native')
    return {path,sha256:hash(bytes),interpreter:null}
  }
  fail('systemctl is unavailable')
}

/** Scope each override to an actual runtime edge. A global override would also
 * turn matching optional peers into dependencies in pnpm 11. */
export function rsiLocalDependencyOverrides(cohort: RsiLocalCohort, bundles?: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const parent of bundles ? rsiLocalRuntimeClosure(cohort, bundles) : cohort.packages) for (const name of parent.runtimeDependencies) {
    const child = cohort.packages.find(item => item.name === name)
    if (!child) fail('local runtime dependency is absent from the frozen cohort')
    result[`${parent.name}@${cohort.version}>${name}`] = `file:${child.tarball}`
  }
  return result
}

function assertLocalOverrideIdentity(source: string, cohort: RsiLocalCohort, peers: Record<string, string>): void {
  const document = parseDocument(source, { uniqueKeys: true })
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) fail('profile workspace configuration is invalid')
  const mapping = document.get('overrides', true)
  if (mapping === undefined) return
  if (!isMap(mapping)) fail('profile overrides must be a mapping')
  const known = { ...rsiLocalDependencyOverrides(cohort), ...peers }
  for (const item of mapping.items) {
    if (!isScalar(item.key) || typeof item.key.value !== 'string') fail('profile override selector is invalid')
    const selector = item.key.value
    if (selector.includes('@dsh-enhanced/') && (!Object.hasOwn(known, selector)
      || !isScalar(item.value) || item.value.value !== known[selector])) fail(`unknown or changed frozen internal override: ${selector}`)
  }
}

export function mergeRsiLocalOverrides(source: string, overrides: Record<string,string>, allowBuilds: Record<string,boolean> = {}): string {
  const document = parseDocument(source, { uniqueKeys: true })
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) fail('profile workspace configuration is invalid')
  const linker = document.get('nodeLinker')
  if (linker !== undefined && linker !== 'hoisted' && linker !== 'isolated') fail('unsupported profile nodeLinker')
  // Hoisting can resolve a registry peer of the same version instead of the
  // frozen tarball selected by a runtime edge. Keep each edge's own resolution.
  document.set('nodeLinker','isolated')
  const current = document.get('overrides', true)
  if (current !== undefined && !isMap(current)) fail('profile overrides must be a mapping')
  if (current === undefined) document.set('overrides', document.createNode({}))
  for (const [selector, path] of Object.entries(overrides)) {
    const value = document.getIn(['overrides',selector])
    if (value !== undefined && value !== path) fail(`existing override conflicts with ${selector}`)
    document.setIn(['overrides',selector],path)
  }
  const builds = document.get('allowBuilds', true)
  if (builds !== undefined && !isMap(builds)) fail('profile allowBuilds must be a mapping')
  if (Object.keys(allowBuilds).length && builds === undefined) document.set('allowBuilds', document.createNode({}))
  for (const [name, allowed] of Object.entries(allowBuilds)) {
    const value = document.getIn(['allowBuilds',name])
    if (value !== undefined && value !== allowed) fail(`existing build policy conflicts with ${name}`)
    document.setIn(['allowBuilds',name],allowed)
  }
  return document.toString()
}

export interface RsiLocalProfileInput {
  dshHome: string
  profile: string
  cohort: RsiLocalCohort
  bundles: readonly string[]
  dsh: Pick<InstalledRsiDsh, 'path' | 'pin'>
  signal: AbortSignal
}
export interface RsiLocalProfilePorts {
  command: typeof io.command
  verify: typeof verifyRsiLocalInstalledPackages
}
const localProfilePorts: RsiLocalProfilePorts = { command: io.command, verify: verifyRsiLocalInstalledPackages }

/** Reject an existing owner's configuration conflict before stopping its Host.
 * Installation re-reads these bytes after stopping, before any package mutation. */
export async function preflightRsiLocalProfile(input: Pick<RsiLocalProfileInput,'dshHome'|'profile'|'cohort'> & { bundles?: readonly string[] }): Promise<void> {
  if (!profilePattern.test(input.profile)) fail('invalid target profile')
  const workspace = join(input.dshHome,'profiles',input.profile,'pnpm-workspace.yaml')
  try { await lstat(workspace) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (await realpath(workspace) !== workspace) fail('profile workspace file is not physical')
  const bundles = input.bundles ?? input.cohort.bundles
  const source = (await io.readStable(workspace,1_048_576)).toString('utf8')
  const peers = await rsiLocalPeerOverrides({ cohort: input.cohort, bundles })
  assertLocalOverrideIdentity(source, input.cohort, peers)
  mergeRsiLocalOverrides(source, { ...rsiLocalDependencyOverrides(input.cohort, bundles), ...peers }, input.cohort.allowBuilds)
}

export function isRsiLocalPackageRepairable(error: unknown): boolean {
  return error instanceof Error && ((error as NodeJS.ErrnoException).code === 'ENOENT'
    || error.message.startsWith('rsi local cohort: installed package file differs:')
    || error.message.startsWith('rsi local cohort: installed package identity split:'))
}

/** Caller owns the home lifecycle lock and has stopped any existing Host. */
export async function installRsiLocalProfile(input: RsiLocalProfileInput, ports = localProfilePorts): Promise<void> {
  if (!profilePattern.test(input.profile) || await realpath(input.dshHome) !== input.dshHome
    || !input.bundles.length || new Set(input.bundles).size !== input.bundles.length) fail('invalid local profile identity')
  // Re-read all immutable files immediately before installation, including on
  // coordinator retries. The caller cannot substitute a different receipt.
  const cohort = await readRsiLocalCohort({dshHome:input.dshHome,profile:input.cohort.root.split('/').at(-1)!})
  if (JSON.stringify(cohort) !== JSON.stringify(input.cohort)) fail('local cohort changed before installation')
  const tarballs = input.bundles.map(slug => {
    const item = cohort.packages.find(value => value.name === `@dsh-enhanced/${slug}` && value.bundle)
    if (!item) fail(`bundle ${slug} is absent from the frozen cohort`)
    return item.tarball
  })
  const run = async (args: string[], force = false) => {
    if (input.dsh.path !== input.dsh.pin.path || hash(await io.readStable(input.dsh.path,67_108_864,false,true)) !== input.dsh.pin.sha256) fail('DSH executable changed')
    return ports.command(input.dsh.path,['plugin','--profile',input.profile,...args],
      {...process.env,DSH_HOME:input.dshHome,CI:'true',pnpm_config_force:String(force),
        pnpm_config_loglevel:'error',pnpm_config_package_import_method:'copy'},input.signal,300_000,2_097_152)
  }
  await run(['list']) // Native profile initialization; never starts a Host.
  const profilePath = join(input.dshHome,'profiles',input.profile)
  await io.directory(profilePath,false)
  const workspace = join(profilePath,'pnpm-workspace.yaml')
  if (await realpath(workspace) !== workspace) fail('profile workspace file is not physical')
  const before = await io.readStable(workspace,1_048_576)
  const peers = await rsiLocalPeerOverrides({ cohort, bundles: input.bundles })
  assertLocalOverrideIdentity(before.toString('utf8'), cohort, peers)
  const overrides = { ...rsiLocalDependencyOverrides(cohort, input.bundles), ...peers }
  const after = mergeRsiLocalOverrides(before.toString('utf8'),overrides,cohort.allowBuilds)
  if (after !== before.toString('utf8')) {
    const temporary = join(profilePath,`.rsi-local-workspace-${randomUUID()}`)
    try {
      await io.writeExclusive(temporary,after)
      if (!(await io.readStable(workspace,1_048_576)).equals(before)) fail('profile workspace changed before installation')
      await rename(temporary,workspace); await io.syncDirectory(profilePath)
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
  }
  // Keep the frozen overrides on failure: pnpm may have changed its lock or
  // package tree. A retry reconciles that same cohort rather than guessing rollback.
  await run(['add',...tarballs])
  if ((await io.readStable(workspace,1_048_576)).toString('utf8') !== after) fail('package installation changed the frozen overrides')
  const verify = () => ports.verify({cohort,profilePath,bundles:[...input.bundles]})
  try { await verify() }
  catch (error) {
    if (!isRsiLocalPackageRepairable(error)) throw error
    // pnpm add can preserve an interrupted package directory. Only retry once,
    // after revalidating the immutable artifacts and configuration; never delete
    // arbitrary profile files to make an inventory mismatch disappear.
    const frozen = await readRsiLocalCohort({dshHome:input.dshHome,profile:cohort.root.split('/').at(-1)!})
    if (JSON.stringify(frozen) !== JSON.stringify(cohort)
      || (await io.readStable(workspace,1_048_576)).toString('utf8') !== after) throw error
    await run(['add',...tarballs],true)
    if ((await io.readStable(workspace,1_048_576)).toString('utf8') !== after) fail('package repair changed the frozen overrides')
    await verify()
  }
}

export async function installRsiLocalTarget(input: {dshHome:string;profile:string;sourceRepository:string;bundles:string[];signal?:AbortSignal}) {
  if (process.platform !== 'linux') fail('automatic local RSI installation currently requires Linux')
  if (!profilePattern.test(input.profile)) fail('invalid target profile')
  await mkdir(input.dshHome,{recursive:true,mode:0o700})
  if (await realpath(input.dshHome) !== input.dshHome) fail('DSH_HOME must be canonical')
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal,AbortSignal.timeout(2_400_000)])
  return withDshHomeLifecycleLock(input.dshHome,async () => {
    const source = await prepareRsiSourceWorkspace({...input,version,signal})
    const cohort = await prepareRsiLocalCohort({...input,source,signal})
    await preflightRsiLocalProfile({...input,cohort})
    const dsh = await resolveInstalledRsiDsh()
    const systemctl = await systemctlPin()
    const {rsiInstallPorts} = await import('./rsi-install.js')
    const running = await rsiInstallPorts.stop(input,input.profile,systemctl,signal)
    await installRsiLocalProfile({...input,cohort,dsh,signal})
    if (running) await rsiInstallPorts.setup.start(input.profile,input.dshHome)
    return {mode:'local-cohort-installed',profile:input.profile,sourceCommit:cohort.sourceCommit,packages:cohort.packages.length}
  })
}
