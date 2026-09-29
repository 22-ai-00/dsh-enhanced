import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, parseDocument } from 'yaml'
import type { RsiLocalCohort } from './rsi-local-cohort.js'
import { mergeRsiLocalOverrides, rsiLocalDependencyOverrides } from './rsi-local-install.js'

const INTERNAL = '@dsh-enhanced/'
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/u
function fail(message: string): never { throw new Error(`rsi local profile update: ${message}`) }
function canonical(path: string): boolean { return typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !path.includes('\0') }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Only configuration identities are checked here. The caller independently
 * reads/verifies both frozen receipts and their tarball inventories. */
function assertCohort(cohort: RsiLocalCohort): void {
  if (!canonical(cohort.root) || !PROFILE.test(cohort.root.split('/').at(-1)!)
    || dirname(cohort.root).split('/').at(-1) !== 'rsi-local-cohorts'
    || !VERSION.test(cohort.version) || !object(cohort.allowBuilds)
    || !Array.isArray(cohort.bundles) || !cohort.bundles.length || new Set(cohort.bundles).size !== cohort.bundles.length
    || cohort.bundles.some(slug => !SLUG.test(slug))
    || !Array.isArray(cohort.packages) || !cohort.packages.length || cohort.packages.length > 128
    || new Set(cohort.packages.map(item => item.name)).size !== cohort.packages.length
    || Object.entries(cohort.allowBuilds).some(([name, allowed]) => !name || typeof allowed !== 'boolean')) fail('invalid frozen cohort configuration')
  for (const item of cohort.packages) {
    const slug = item.name.slice(INTERNAL.length)
    if (!item.name.startsWith(INTERNAL) || !SLUG.test(slug)
      || item.path !== `${item.bundle ? 'plugins' : 'packages'}/${slug}`
      || item.tarball !== join(cohort.root, 'artifacts', `${slug}.tgz`)
      || !Array.isArray(item.runtimeDependencies) || new Set(item.runtimeDependencies).size !== item.runtimeDependencies.length
      || item.runtimeDependencies.some(name => !cohort.packages.some(child => child.name === name))) fail(`invalid frozen package configuration: ${item.name}`)
  }
  if (cohort.bundles.some(slug => !cohort.packages.some(item => item.name === `${INTERNAL}${slug}` && item.bundle))) fail('selected bundle is absent from cohort')
}

function compareVersions(left: string, right: string): number {
  const a = VERSION.exec(left)!, b = VERSION.exec(right)!
  for (let index = 1; index <= 3; index++) {
    const first = BigInt(a[index]!), second = BigInt(b[index]!)
    if (first !== second) return first < second ? -1 : 1
  }
  if (a[4] === b[4]) return 0
  if (a[4] === undefined || b[4] === undefined) return a[4] === undefined ? 1 : -1
  const first = a[4].split('.'), second = b[4].split('.')
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    const x = first[index], y = second[index]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const nx = /^\d+$/u.test(x), ny = /^\d+$/u.test(y)
    if (nx && ny) { if (BigInt(x) !== BigInt(y)) return BigInt(x) < BigInt(y) ? -1 : 1 }
    else if (nx !== ny) return nx ? -1 : 1
    else return x < y ? -1 : 1
  }
  return 0
}

/** Replace only the old cohort's exact runtime edges in a stopped profile's
 * workspace. Extra owner settings and YAML comments remain in the document;
 * the candidate cannot grant new build-script authority. No files are read or
 * written and no installation/Host action is performed. */
export function rebaseRsiLocalProfileWorkspace(input: { source: string; original: RsiLocalCohort; candidate: RsiLocalCohort; bundles?: readonly string[];
  originalPeers?: Record<string, string>; candidatePeers?: Record<string, string> }): string {
  const { source, original, candidate } = input
  assertCohort(original); assertCohort(candidate)
  if (original.root !== candidate.root || original.sourceRepository !== candidate.sourceRepository
    || !isDeepStrictEqual(original.bundles, candidate.bundles)) fail('candidate cohort installation identity changed')
  if (compareVersions(candidate.version, original.version) < 0) fail('candidate cohort version moved backwards')
  for (const item of original.packages) {
    const next = candidate.packages.find(value => value.name === item.name)
    if (next && (next.path !== item.path || next.bundle !== item.bundle || next.tarball !== item.tarball)) fail(`candidate package path changed: ${item.name}`)
  }
  for (const [name, allowed] of Object.entries(original.allowBuilds)) {
    if (candidate.allowBuilds[name] !== allowed) fail(`candidate changed existing build authorization: ${name}`)
  }
  for (const [name, allowed] of Object.entries(candidate.allowBuilds)) {
    if (!Object.hasOwn(original.allowBuilds, name) && allowed) fail(`candidate added build authorization: ${name}`)
  }
  const document = parseDocument(source, { uniqueKeys: true })
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) fail('profile workspace configuration is invalid')
  if (document.get('nodeLinker') !== 'isolated') fail('profile nodeLinker drifted from frozen local installation')
  const oldRuntime = rsiLocalDependencyOverrides(original)
  const oldRequired = rsiLocalDependencyOverrides(original, input.bundles)
  const oldOverrides = { ...oldRuntime, ...input.originalPeers }
  const nextOverrides = { ...rsiLocalDependencyOverrides(candidate, input.bundles), ...input.candidatePeers }
  const overrides = document.get('overrides', true)
  if (overrides !== undefined && !isMap(overrides)) fail('profile overrides must be a mapping')
  if (isMap(overrides)) for (const item of overrides.items) {
    if (!isScalar(item.key) || typeof item.key.value !== 'string') fail('profile override selector is invalid')
    const selector = item.key.value
    if (selector.includes(INTERNAL) && !Object.hasOwn(oldOverrides, selector)) fail(`unknown or stale internal override: ${selector}`)
  }
  for (const [selector, value] of Object.entries(oldRequired)) {
    if (document.getIn(['overrides', selector]) !== value) fail(`old runtime override is missing or changed: ${selector}`)
  }
  for (const [selector, value] of Object.entries(oldOverrides)) {
    const present = document.getIn(['overrides', selector])
    if (present !== undefined && present !== value) fail(`old peer or runtime override changed: ${selector}`)
  }
  const builds = document.get('allowBuilds', true)
  if (builds !== undefined && !isMap(builds)) fail('profile allowBuilds must be a mapping')
  if (isMap(builds)) for (const item of builds.items) {
    if (!isScalar(item.key) || typeof item.key.value !== 'string'
      || !isScalar(item.value) || typeof item.value.value !== 'boolean') fail('profile build policy must contain booleans')
  }
  for (const [name, allowed] of Object.entries(original.allowBuilds)) {
    if (document.getIn(['allowBuilds', name]) !== allowed) fail(`old build authorization is missing or changed: ${name}`)
  }
  // Rename retained edges in place, including version advances, so owner
  // comments survive. Comments on removed edges remain on the overrides map.
  for (const selector of Object.keys(oldOverrides)) {
    if (document.getIn(['overrides', selector]) === undefined) continue
    const nextSelector = selector.replace(`@${original.version}>`, `@${candidate.version}>`)
    if (Object.hasOwn(nextOverrides, nextSelector) && isMap(overrides)) {
      const pair = overrides.items.find(item => isScalar(item.key) && item.key.value === selector)!
      if (isScalar(pair.key)) pair.key.value = nextSelector
    } else {
      if (isMap(overrides)) {
        const pair = overrides.items.find(item => isScalar(item.key) && item.key.value === selector)!
        const comments = [overrides.comment, isScalar(pair.key) && pair.key.commentBefore,
          isScalar(pair.key) && pair.key.comment, isScalar(pair.value) && pair.value.commentBefore,
          isScalar(pair.value) && pair.value.comment].filter(value => typeof value === 'string')
        overrides.comment = comments.join('\n') || null
      }
      document.deleteIn(['overrides', selector])
    }
  }
  return mergeRsiLocalOverrides(document.toString(), nextOverrides, candidate.allowBuilds)
}

/** Assert the manifest's internal root dependencies are exactly this profile's
 * selected frozen bundles. pnpm may save a tarball as an absolute file: path or
 * relative to Home/profiles/<name>; every profile has that same directory depth.
 * Other dependency/configuration fields are inspected without rewriting bytes. */
export function assertRsiLocalProfileRoots(input: { source: string; cohort: RsiLocalCohort; bundles: readonly string[] }): void {
  assertCohort(input.cohort)
  let manifest: unknown
  try { manifest = JSON.parse(input.source) } catch { fail('profile manifest is invalid JSON') }
  if (!object(manifest) || !input.bundles.length || new Set(input.bundles).size !== input.bundles.length) fail('profile manifest or bundle roots are invalid')
  const roots = new Map(input.bundles.map(slug => {
    const item = input.cohort.packages.find(value => value.name === `${INTERNAL}${slug}` && value.bundle)
    if (!item) fail(`profile bundle is absent from cohort: ${slug}`)
    return [item!.name, item!.tarball] as const
  }))
  const dsh = manifest.dsh, profile = object(dsh) ? dsh.profile : undefined
  const mounted = object(profile) ? profile.bundles : undefined
  if (!Array.isArray(mounted) || mounted.some(name => typeof name !== 'string' || !name || name.includes('\0'))
    || new Set(mounted).size !== mounted.length) fail('profile mounted bundles are invalid')
  const internalMounted = mounted.filter((name: string) => name.includes(INTERNAL))
  if (internalMounted.length !== roots.size || internalMounted.some((name: string) => !roots.has(name))) fail('profile mounted internal bundle roots changed')
  const profileDirectory = join(dirname(dirname(input.cohort.root)), 'profiles', '_profile_')
  const seen = new Set<string>()
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const mapping = manifest[field]
    if (mapping === undefined) continue
    if (!object(mapping)) fail(`profile ${field} must be a mapping`)
    for (const [name, value] of Object.entries(mapping)) {
      if (!name.startsWith(INTERNAL)) continue
      if (field !== 'dependencies' || !roots.has(name) || typeof value !== 'string' || !value.startsWith('file:')
        || value.includes('\0') || resolve(profileDirectory, value.slice(5)) !== roots.get(name)) fail(`profile internal bundle root is missing or changed: ${name}`)
      seen.add(name)
    }
  }
  if (seen.size !== roots.size) fail('profile selected bundle root is missing')
}
