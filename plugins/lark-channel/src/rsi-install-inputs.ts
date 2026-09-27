import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PROTECTED_PLUGIN_DENYLIST, resolveLocalExecutable, runtimeConfigDigest,
  validateHostDeploymentInputs, type PluginControlTrustConfig, type RuntimeObserverTarget,
  type SourceReleaseAuthorityConfig } from '@dsh-enhanced/plugin-control-plane'
import { isMap, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml'

import { rawLoaderConfig } from './rsi-bootstrap-manifest.js'
import type { RsiAuthorityResources } from './rsi-authority-resources.js'
import type { Pin } from './rsi-authority-runtime.js'
import type { RsiSourceWorkspace } from './rsi-source.js'

const pluginPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
const stableObserverRows = [
  { entryId: 'dsh-enhanced-assistant-delivery', module: '@dsh-enhanced/assistant-delivery', services: ['assistantDelivery'] },
  { entryId: 'dsh-enhanced-lark-channel', module: '@dsh-enhanced/lark-channel', services: ['larkChannel'] },
] as const

function fail(message: string): never { throw new Error(`rsi installed inputs: ${message}`) }
export class RsiInstalledInputsUnavailableError extends Error {
  constructor(message: string) { super(`rsi installed inputs unavailable: ${message}`) }
}
function canonical(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value
    || value.includes('\0') || /[\r\n]/u.test(value)) fail(`${label} must be canonical absolute`)
  return value
}
function within(root: string, path: string, label: string): void {
  const child = relative(root, path)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail(`${label} escapes installed root`)
}
function relativeJs(value: unknown, label: string, requireLib: boolean): string {
  if (typeof value !== 'string' || !/^\.\/[A-Za-z0-9._/-]+\.js$/u.test(value)
    || requireLib && !value.startsWith('./lib/')
    || value.slice(2).split('/').some(part => !part || part === '.' || part === '..')) {
    fail(`${label} must be a package-local ${requireLib ? 'lib ' : ''}JS entry`)
  }
  return value.slice(2)
}
async function bytes(path: string, limit: number, label: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true })
    if (!before.isFile() || before.size > BigInt(limit) || before.size < 1n
      || before.dev !== named.dev || before.ino !== named.ino || (before.mode & 0o022n) !== 0n
      || (before.mode & 0o7000n) !== 0n
      || process.getuid && before.uid !== 0n && before.uid !== BigInt(process.getuid())) fail(`${label} is not a trusted regular file`)
    const value = await file.readFile(), after = await file.stat({ bigint: true })
    if (BigInt(value.length) !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail(`${label} changed during read`)
    return value
  } finally { await file.close() }
}
async function json(path: string, label: string): Promise<Record<string, unknown>> {
  let value: unknown
  try { value = JSON.parse((await bytes(path, 1_048_576, label)).toString('utf8')) }
  catch (error) { fail(`${label} is invalid: ${String(error)}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}
async function pin(path: string, label: string): Promise<Pin> {
  canonical(path, label)
  if (await realpath(path) !== path) fail(`${label} path changed`)
  const data = await bytes(path, 64 * 1024 * 1024, label)
  const metadata = await lstat(path)
  if ((metadata.mode & 0o111) === 0) fail(`${label} is not executable`)
  return { path, sha256: createHash('sha256').update(data).digest('hex') }
}
function executableCandidates(command: string, environment: NodeJS.ProcessEnv): string[] {
  return (environment.PATH ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, command))
}
function assertPackagePatch(bytes: Buffer, plugin: string): void {
  const document = parseDocument(bytes.toString('utf8'), { uniqueKeys: true })
  if (document.errors.length || !isSeq(document.contents)) fail(`${plugin} package patch is invalid`)
  let matches = 0
  for (const operation of document.contents.items) {
    if (!isMap(operation)) fail(`${plugin} package patch operation is invalid`)
    const insert = operation.get('insert', true)
    const entries = isSeq(insert) ? insert.items : [operation]
    for (const value of entries) {
      if (!isMap(value)) continue
      if (value.get('id') === `dsh-enhanced-${plugin}`) {
        if (value.get('name') !== `@dsh-enhanced/${plugin}`) fail(`${plugin} package patch mounts the wrong package`)
        matches++
      }
    }
  }
  if (matches !== 1) fail(`${plugin} package patch has no unique mounted entry`)
}
async function locateDsh(environment: NodeJS.ProcessEnv): Promise<string> {
  for (const candidate of executableCandidates('dsh', environment)) {
    try { return await realpath(candidate) } catch { /* try next PATH entry */ }
  }
  fail('dsh executable is absent from PATH')
}

export interface InstalledRsiDsh { root: string; path: string; version: string; pin: Pin }

/** Inspect only the installed CLI package and its exact bin target. */
export async function resolveInstalledRsiDsh(environment: NodeJS.ProcessEnv = process.env,
  installedDshRoot?: string): Promise<InstalledRsiDsh> {
  const executable = installedDshRoot === undefined ? await locateDsh(environment) : undefined
  let root: string | undefined
  if (installedDshRoot !== undefined) {
    root = canonical(installedDshRoot, 'DSH package root')
    if (await realpath(root) !== root) fail('DSH package root is not physical')
  } else {
    let directory = dirname(executable!)
    for (let depth = 0; depth < 5; depth++, directory = dirname(directory)) {
      try {
        const manifest = await json(join(directory, 'package.json'), 'DSH manifest')
        if (manifest.name === '@deepseek-ai/dsh') { root = directory; break }
      } catch { /* bounded ancestor search */ }
      if (dirname(directory) === directory) break
    }
  }
  if (!root) fail('dsh executable has no installed @deepseek-ai/dsh package')
  const manifest = await json(join(root, 'package.json'), 'DSH manifest')
  const bin = manifest.bin
  if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string'
    || !versionPattern.test(manifest.version) || !bin || typeof bin !== 'object' || Array.isArray(bin)
    || Object.keys(bin).length !== 1 || typeof (bin as Record<string, unknown>).dsh !== 'string') fail('DSH package identity is invalid')
  const main = relativeJs(`./${(bin as Record<string, string>).dsh!.replace(/^\.\//u, '')}`, 'DSH bin', false)
  const path = join(root, main)
  if (await realpath(path) !== path || executable !== undefined && executable !== path) fail('dsh PATH entry differs from installed package bin')
  return { root, path, version: manifest.version, pin: await pin(path, 'DSH executable') }
}

export interface RsiInstalledInputsRequest {
  dshHome: string
  targetProfile: string
  /** Exact bytes returned by the installed DSH --dump-config command. */
  targetEffective: string
  /** Optional when the PATH dsh points into the same installed package. */
  installedDshRoot?: string
  resources: RsiAuthorityResources
  source: RsiSourceWorkspace
  environment?: NodeJS.ProcessEnv
}
export interface RsiInstalledInputs {
  dsh: InstalledRsiDsh
  plugins: string[]
  hostDeploymentInputs: string[]
  observerTargets: RuntimeObserverTarget[]
  executor: PluginControlTrustConfig['executor']
  git: Pin
  systemctl: Pin & { interpreter: Pin | null }
  policies: SourceReleaseAuthorityConfig['grant']['policies']
}

/** Caller holds the installation lifecycle lock and supplies one pre-mutation
 * dump. These are declared Host disk inputs, not a claim of complete transitive
 * JavaScript module coverage. */
export async function collectRsiInstalledInputs(input: RsiInstalledInputsRequest): Promise<RsiInstalledInputs> {
  canonical(input.dshHome, 'DSH_HOME')
  if (!profilePattern.test(input.targetProfile) || typeof input.targetEffective !== 'string'
    || Buffer.byteLength(input.targetEffective) > 2_097_152) fail('invalid target profile or effective dump')
  const profile = join(input.dshHome, 'profiles', input.targetProfile)
  if (await realpath(profile) !== profile) fail('installed profile is not physical')
  const dsh = await resolveInstalledRsiDsh(input.environment, input.installedDshRoot)
  const document = parseDocument(input.targetEffective, { uniqueKeys: true })
  if (document.errors.length || !isSeq(document.contents)) fail('effective dump is not an entry list')
  const rows = new Map<string, YAMLMap>()
  const plugins: string[] = []
  for (const value of document.contents.items) {
    if (!isMap(value)) fail('effective entry is not a mapping')
    const row = value as YAMLMap
    const id = row.get('id'), name = row.get('name')
    if (typeof id !== 'string' || !id || rows.has(id)) fail('effective entry identity is duplicate or invalid')
    rows.set(id, row)
    if (row.get('disabled') === true) continue
    if (typeof name !== 'string' || !name.startsWith('@dsh-enhanced/')) {
      if (id.startsWith('dsh-enhanced-')) fail(`installed ${id} has no package name`)
      continue
    }
    const plugin = name.slice('@dsh-enhanced/'.length)
    if (!pluginPattern.test(plugin) || id !== `dsh-enhanced-${plugin}`) fail(`installed ${id} has inconsistent package identity`)
    if (!PROTECTED_PLUGIN_DENYLIST.has(plugin)) plugins.push(plugin)
  }
  if (!plugins.length || plugins.length > 32) fail('repairable installed plugin scope is empty or too large')
  const observerTargets: RuntimeObserverTarget[] = stableObserverRows.map(expected => {
    const row = rows.get(expected.entryId)
    if (!row || row.get('disabled') === true || row.get('name') !== expected.module) fail(`required ${expected.entryId} is unavailable`)
    const raw = rawLoaderConfig(row.get('config', true) as Node | undefined, expected.entryId)
    if (expected.entryId === 'dsh-enhanced-lark-channel'
      && (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as Record<string, unknown>).enabled !== true)) {
      fail('installed Lark channel is not enabled')
    }
    return { entryId: expected.entryId, module: expected.module,
      configDigest: runtimeConfigDigest(raw),
      services: [...expected.services] }
  })
  const hostDeploymentInputs = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']
  for (const entry of hostDeploymentInputs) {
    const path = await realpath(join(profile, entry)); within(profile, path, entry)
    await bytes(path, 64 * 1024 * 1024, entry)
  }
  for (const plugin of plugins) {
    const prefix = `node_modules/@dsh-enhanced/${plugin}/`, packageRoot = join(profile, 'node_modules', '@dsh-enhanced', plugin)
    const physical = await realpath(packageRoot)
    const child = relative(profile, physical)
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new RsiInstalledInputsUnavailableError(`${plugin} is linked outside the profile; automatic RSI requires profile-local installed packages`)
    }
    const manifestFile = await realpath(join(packageRoot, 'package.json'))
    within(profile, manifestFile, `${plugin} manifest`)
    const manifest = await json(manifestFile, `${plugin} manifest`)
    const exported = manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)
      ? (manifest.exports as Record<string, unknown>)['.'] : undefined
    const exportMain = exported && typeof exported === 'object' && !Array.isArray(exported)
      ? (exported as Record<string, unknown>).default : undefined
    const main = relativeJs(manifest.main, `${plugin} main`, true)
    if (manifest.name !== `@dsh-enhanced/${plugin}` || manifest.version !== input.source.version
      || exportMain !== manifest.main || (manifest.dsh as { bundle?: { patch?: string } } | undefined)?.bundle?.patch !== './cordis.patch.yml') {
      fail(`${plugin} installed package identity or entry differs from source cohort`)
    }
    const declared = [`${prefix}package.json`, `${prefix}cordis.patch.yml`, `${prefix}${main}`]
    for (const entry of declared.slice(1)) {
      const path = await realpath(join(profile, entry)); within(profile, path, entry)
      const content = await bytes(path, 64 * 1024 * 1024, entry)
      if (entry.endsWith('/cordis.patch.yml')) assertPackagePatch(content, plugin)
    }
    hostDeploymentInputs.push(...declared)
  }
  validateHostDeploymentInputs(hostDeploymentInputs)
  if (input.resources.schemaVersion !== 1 || input.resources.root !== join(input.dshHome, 'rsi-authorities', input.targetProfile)
    || input.source.schemaVersion !== 1) fail('authority resources or source cohort differs from installation')
  const environment = input.environment ?? process.env
  const git = await pin(await resolveLocalExecutable('git', environment), 'Git')
  let systemctlPath: string | undefined
  for (const candidate of executableCandidates('systemctl', environment)) {
    try { systemctlPath = await realpath(candidate); break } catch { /* next candidate */ }
  }
  if (!systemctlPath) fail('systemctl executable is absent from PATH')
  if (!(await bytes(systemctlPath, 64 * 1024 * 1024, 'systemctl')).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    fail('systemctl is not a native executable')
  }
  const systemctl = { ...await pin(systemctlPath, 'systemctl'), interpreter: null }
  const policies: SourceReleaseAuthorityConfig['grant']['policies'] = plugins.map(plugin => ({
    targetBranch: input.source.baseline.targetBranch, candidateId: plugin,
    packageName: `@dsh-enhanced/${plugin}`, packagePath: `plugins/${plugin}`,
    dshBaseline: dsh.version, capabilities: ['owner-installed'], authorities: ['owner-installed'], requires: [],
    registryId: input.resources.registry.id, registryLocator: input.resources.registry.locator,
    catalogId: input.resources.catalog.id, catalogPath: input.resources.catalog.path,
    minimumReproducibleBuilds: 2,
  }))
  return { dsh, plugins, hostDeploymentInputs, observerTargets,
    executor: { id: '@deepseek-ai/dsh', version: dsh.version, path: dsh.path,
      sha256: dsh.pin.sha256, environmentAllowlist: [] }, git, systemctl, policies }
}
