import type { LinuxRuntime, LinuxCgroupRoots } from '@dsh-enhanced/assistant-isolation'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml'

export interface FiniteAutonomyTerms { maxRuns: number; leaseMs: number; maxTotalDurationMs: number }
export type AutonomyLinuxSource = { kind: 'official-tag' } | { kind: 'local-head'; repository: string }
/** Only the linux-native backend remains; Docker-era options are rejected explicitly. */
export type AutonomySetupOptions = FiniteAutonomyTerms & {
  backend?: 'linux-native'
  source?: AutonomyLinuxSource
}
export type AutonomyLinuxConfig = { runtime: LinuxRuntime; cgroupRoots: LinuxCgroupRoots }
export type AutonomyResolvedOptions = FiniteAutonomyTerms & {
  backend?: 'linux-native'
  linux: AutonomyLinuxConfig
}
export interface AutonomyProfileInput { dshHome: string; profile: string; workspace: string; preset: string; isolation: AutonomyResolvedOptions }
export type AutonomyPreflightInput = Omit<AutonomyProfileInput, 'isolation'> & { isolation: AutonomySetupOptions }


const requiredBundles = ['assistant-isolation', 'assistant-actions', 'credentials-keychain'] as const
const stateBundles = ['assistant-skills', 'assistant-proactive'] as const
const bundles = [...requiredBundles, ...stateBundles] as const
type Bundle = typeof bundles[number]
const profileKey = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const presetKey = /^[a-z0-9][a-z0-9-]*$/u
const dockerRemoved = 'Docker isolation was removed; use the linux-native backend'
function fail(message: string): never { throw new Error(`assistant-web-owner autonomy: ${message}`) }
function map(value: unknown, label: string): YAMLMap { if (!isMap(value)) fail(`${label} must be a mapping`); return value }
function parse(source: string, label: string): { document: Document; rows: YAMLSeq } {
  const document = parseDocument(source.trim() === '' ? '[]' : source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length !== 0 || !isSeq(document.contents)) fail(`${label} must be a YAML sequence`)
  return { document, rows: document.contents }
}
function row(rows: YAMLSeq, bundle: Bundle, required: boolean): YAMLMap | undefined {
  const id = `dsh-enhanced-${bundle}`; const name = `@dsh-enhanced/${bundle}`
  const matches = rows.items.filter(item => isMap(item) && (item.get('id') === id || item.get('name') === name)) as YAMLMap[]
  if (matches.length > 1) fail(`duplicate or shadowed ${id}`)
  const found = matches[0]
  if (!found) { if (required) fail(`install ${name} before autonomy setup`); return undefined }
  if (found.get('id') !== id || (found.has('name') && found.get('name') !== name) || (found.has('disabled') && found.get('disabled') !== false)) fail(`invalid or disabled ${id}`)
  return found
}
function merge(base: YAMLMap, overlay: YAMLMap): YAMLMap {
  const result = map(base.clone(), 'config')
  for (const pair of overlay.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') fail('config keys must be strings')
    const inherited = result.get(pair.key.value, true); const value = pair.value as Node | null
    result.set(pair.key.value, isMap(inherited) && isMap(value) ? merge(inherited, value) : value?.clone() ?? null)
  }
  return result
}
function path(value: unknown, label: string): string {
  if (!isScalar(value) || typeof value.value !== 'string' || value.tag !== undefined && value.tag !== 'tag:yaml.org,2002:str') fail(`${label} must be a literal absolute path`)
  if (!isAbsolute(value.value) || value.value.includes('\0') || normalize(value.value) !== value.value) fail(`${label} must be a canonical absolute path`)
  return value.value
}
function canonicalPath(value: string, label: string, rejectLeafSymlink = false): string {
  let cursor = value; const suffix: string[] = []
  for (;;) {
    let stat
    try { stat = lstatSync(cursor) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(`${label} has an inaccessible filesystem ancestor`)
      const parent = dirname(cursor)
      if (parent === cursor) fail(`${label} has no existing filesystem ancestor`)
      suffix.unshift(basename(cursor)); cursor = parent
      continue
    }
    if (rejectLeafSymlink && suffix.length === 0 && stat.isSymbolicLink()) fail(`${label} must not be a symbolic link`)
    try { return resolve(realpathSync(cursor), ...suffix) } catch { fail(`${label} has an unresolved filesystem ancestor`) }
  }
}
function dshStatePath(value: unknown, label: string, dshHome: string): string {
  const resolved = path(value, label)
  const canonical = canonicalPath(resolved, label, true)
  const within = relative(canonicalPath(dshHome, 'DSH_HOME'), canonical)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) fail(`${label} must be within DSH_HOME`)
  // Setup cannot hold filesystem descriptors until every runtime opens its state.
  // Each state-owning runtime must retain its private/no-follow checks for TOCTOU defense.
  return canonical
}
function sequence(value: unknown, label: string): YAMLSeq { if (!isSeq(value)) fail(`${label} must be a sequence`); return value }
function scalar(value: unknown, label: string): string { if (!isScalar(value) || typeof value.value !== 'string') fail(`${label} must be a string`); return value.value }
function publishedCredentialDefault(value: unknown): boolean {
  return isScalar(value) && value.tag === 'tag:yaml.org,2002:js' && value.value === "dshHomePath('credentials-keychain/ledger.sqlite')"
}
function publishedDatabaseDefault(value: unknown, expected: string): boolean {
  return isScalar(value) && (value.tag === undefined || value.tag === 'tag:yaml.org,2002:str') && value.value === expected
}
function exists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    fail(`cannot inspect inherited database state at ${path}`)
  }
}
function sqliteStateExists(databasePath: string, companion = false): boolean {
  const databases = companion ? [databasePath, `${databasePath}.preparations`] : [databasePath]
  return databases.some(value => [value, `${value}-journal`, `${value}-wal`, `${value}-shm`].some(exists))
}
function canonicalizeNestedStateRoots(document: Document, node: Node | null, dshHome: string, label: string): void {
  if (isAlias(node)) fail(`${label} config must not use YAML aliases`)
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : undefined
      if (key === 'stateRoot') pair.value = document.createNode(dshStatePath(pair.value, `${label} stateRoot`, dshHome))
      else canonicalizeNestedStateRoots(document, pair.value as Node | null, dshHome, label)
    }
  } else if (isSeq(node)) for (const item of node.items) canonicalizeNestedStateRoots(document, item as Node | null, dshHome, label)
}
function options(input: AutonomyProfileInput): void {
  if (!profileKey.test(input.profile) || !presetKey.test(input.preset)) fail('invalid profile or preset')
  for (const value of [input.dshHome, input.workspace]) if (!isAbsolute(value) || value.includes('\0') || normalize(value) !== value) fail('home and workspace must be canonical absolute paths')
  validateFiniteTerms(input.isolation)
}

function validateFiniteTerms(value: FiniteAutonomyTerms): void {
  const positive = (number: number, maximum: number, label: string, minimum = 1) => { if (!Number.isSafeInteger(number) || number < minimum || number > maximum) fail(`invalid ${label}`) }
  positive(value.maxRuns, 10_000, 'maxRuns'); positive(value.leaseMs, 7 * 24 * 60 * 60 * 1000, 'leaseMs'); positive(value.maxTotalDurationMs, 24 * 60 * 60 * 1000, 'maxTotalDurationMs', 60_000)
}
export function validateAutonomyOptions(value: AutonomySetupOptions): void {
  if (value === null || typeof value !== 'object') fail('invalid autonomy options')
  // Only linux-native keys are accepted. Docker-era options (`image`, `backend:
  // 'docker'`, or any other unknown key) fail explicitly instead of being ignored.
  if (Object.keys(value).some(key => !['backend', 'source', 'maxRuns', 'leaseMs', 'maxTotalDurationMs'].includes(key))) fail(dockerRemoved)
  validateFiniteTerms(value)
  if (value.backend !== undefined && value.backend !== 'linux-native') fail(dockerRemoved)
  if (value.source !== undefined) {
    const source = value.source
    if (!source || typeof source !== 'object' || (source.kind !== 'official-tag' && source.kind !== 'local-head')
      || Object.keys(source).sort().join(',') !== (source.kind === 'local-head' ? 'kind,repository' : 'kind')) fail('invalid Linux source')
    if (source.kind === 'local-head' && (typeof source.repository !== 'string' || !isAbsolute(source.repository)
      || normalize(source.repository) !== source.repository || /[\p{Cc}*]/u.test(source.repository))) fail('Linux source repository must be a canonical absolute path')
  }
}
/** Reject tagged/aliased native descriptors rather than evaluating arbitrary YAML. */
export function literalAutonomyLinux(value: unknown): AutonomyLinuxConfig {
  const decode = (node: unknown): unknown => {
    if (isAlias(node)) fail('Linux descriptor must not use aliases')
    if (isScalar(node) && (node.tag === undefined || node.tag === 'tag:yaml.org,2002:str')) return node.value
    if (isMap(node)) return Object.fromEntries(node.items.map(pair => [scalar(pair.key, 'Linux descriptor key'), decode(pair.value)]))
    fail('Linux descriptor must contain only literal mappings and scalars')
  }
  const result = decode(value) as AutonomyLinuxConfig
  if (!result || typeof result !== 'object' || Object.keys(result).sort().join() !== 'cgroupRoots,runtime'
    || !result.runtime || !result.cgroupRoots || typeof result.runtime.root?.path !== 'string') fail('invalid Linux descriptor')
  return result
}
export function validateAutonomyLinuxPaths(linux: AutonomyLinuxConfig, stateRoot: string, home: string): void {
  const root = linux.runtime.root.path
  if (!isAbsolute(root) || normalize(root) !== root || /[\p{Cc}*]/u.test(root) || root === '/') fail('invalid Linux runtime root')
  const canonical = canonicalPath(root, 'Linux runtime root', true)
  if (canonical !== root) fail('Linux runtime root must be realpath canonical')
  const within = relative(canonicalPath(home, 'DSH_HOME'), canonical)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) fail('Linux runtime must be within DSH_HOME')
  if (root === stateRoot || root.startsWith(stateRoot + sep) || stateRoot.startsWith(root + sep)) fail('Isolation state overlaps Linux runtime')
}

/** Pure YAML materialization; it neither creates credentials nor grants external repository authority. */
export function preflightAutonomyProfile(input: AutonomyPreflightInput, source: string, effectiveSource: string): string {
  validateAutonomyOptions(input.isolation)
  return materializeAutonomyProfile(input as AutonomyProfileInput, source, effectiveSource, undefined, Date.now(), true)
}
export function prepareAutonomyProfile(input: AutonomyProfileInput, source: string, effectiveSource: string, owner?: { id: string; version: number }, now = Date.now()): string {
  return materializeAutonomyProfile(input, source, effectiveSource, owner, now, false)
}
function materializeAutonomyProfile(input: AutonomyProfileInput, source: string, effectiveSource: string, owner: { id: string; version: number } | undefined, now: number, preflight: boolean): string {
  options(input)
  if (!preflight) {
    if (Object.keys(input.isolation).some(key => !['backend','linux','maxRuns','leaseMs','maxTotalDurationMs'].includes(key))
      || input.isolation.backend !== undefined && input.isolation.backend !== 'linux-native') fail(dockerRemoved)
    if (!input.isolation.linux || Object.keys(input.isolation.linux).sort().join() !== 'cgroupRoots,runtime') fail('invalid resolved Linux descriptor')
  }
  if (owner !== undefined && (typeof owner.id !== 'string' || owner.id.length === 0 || !Number.isSafeInteger(owner.version) || owner.version < 1)) fail('invalid owner')
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - input.isolation.leaseMs) fail('invalid clock')
  const target = parse(source, 'profile patch'); const effective = parse(effectiveSource, 'effective profile')
  const configs = new Map<Bundle, YAMLMap>()
  const explicit = new Map<Bundle, ReadonlySet<string>>()
  for (const bundle of bundles) {
    const required = (requiredBundles as readonly Bundle[]).includes(bundle)
    const inherited = row(effective.rows, bundle, required); const existing = row(target.rows, bundle, false)
    if (!inherited) {
      if (existing) fail(`effective profile is missing @dsh-enhanced/${bundle}`)
      continue
    }
    const base = inherited.has('config') ? map(inherited.get('config', true), bundle) : target.document.createNode({}) as YAMLMap
    const config = existing?.has('config') ? merge(base, map(existing.get('config', true), bundle)) : map(base.clone(), bundle)
    explicit.set(bundle, existing?.has('config') ? new Set(map(existing.get('config', true), bundle).items.map(pair => scalar(pair.key, 'config key'))) : new Set())
    const destination = existing ?? target.document.createNode({ id: `dsh-enhanced-${bundle}`, name: `@dsh-enhanced/${bundle}` }) as YAMLMap
    destination.set('config', config); if (!existing) target.rows.add(destination); configs.set(bundle, config)
  }
  const isolation = configs.get('assistant-isolation')!; const actions = configs.get('assistant-actions')!; const credentials = configs.get('credentials-keychain')!
  const canonicalHome = canonicalPath(input.dshHome, 'DSH_HOME')
  const roots = {
    isolation: join(canonicalHome, 'assistant-isolation', input.profile),
    actions: join(canonicalHome, 'assistant-actions', input.profile),
    credentials: join(canonicalHome, 'credentials-keychain', `${input.profile}.sqlite`),
    skills: join(canonicalHome, 'assistant-skills', 'skills.sqlite'),
    proactive: join(canonicalHome, 'assistant-proactive', 'proactive.sqlite'),
  }
  for (const [config, field, fallback, label] of [[isolation, 'stateRoot', roots.isolation, 'Isolation stateRoot'], [actions, 'stateRoot', roots.actions, 'Actions stateRoot']] as const) {
    if (!config.has(field)) config.set(field, target.document.createNode(fallback))
    config.set(field, target.document.createNode(dshStatePath(config.get(field, true), label, canonicalHome)))
  }
  const credentialPath = credentials.get('databasePath', true)
  if (credentialPath === undefined || (!explicit.get('credentials-keychain')!.has('databasePath') && publishedCredentialDefault(credentialPath))) credentials.set('databasePath', target.document.createNode(roots.credentials))
  credentials.set('databasePath', target.document.createNode(dshStatePath(credentials.get('databasePath', true), 'Credential databasePath', canonicalHome)))
  for (const [bundle, fallback, published, label] of [
    ['assistant-skills', roots.skills, join(homedir(), '.dsh', 'assistant-skills.sqlite'), 'Skills databasePath'],
    ['assistant-proactive', roots.proactive, join(homedir(), '.dsh', 'assistant-proactive.sqlite'), 'Proactive databasePath'],
  ] as const) {
    const config = configs.get(bundle)
    if (!config) continue
    const current = config.get('databasePath', true)
    const inheritedDefault = !explicit.get(bundle)!.has('databasePath') && (current === undefined || publishedDatabaseDefault(current, published))
    if (inheritedDefault && sqliteStateExists(published, bundle === 'assistant-proactive')) fail(`${label} published default contains existing state; perform an offline migration to ${fallback} before setup`)
    if (inheritedDefault) config.set('databasePath', target.document.createNode(fallback))
    config.set('databasePath', target.document.createNode(dshStatePath(config.get('databasePath', true), label, canonicalHome)))
  }
  const skills = configs.get('assistant-skills')
  if (skills) canonicalizeNestedStateRoots(target.document, skills, canonicalHome, 'Skills')
  const configuredBackend = isolation.has('backend') ? scalar(isolation.get('backend', true), 'Isolation backend') : isolation.has('linux') ? 'linux-native' : undefined
  const oldImage = isolation.has('image') ? scalar(isolation.get('image', true), 'Isolation image') : undefined
  // Existing Docker profiles are never rewritten in place: the owner must run an
  // explicit migration so the backend and authority change stays auditable.
  if (configuredBackend === 'docker' || oldImage !== undefined || isolation.has('dockerPath') || isolation.has('socketPath')) fail('existing Docker isolation requires explicit migration')
  if (configuredBackend !== undefined && configuredBackend !== 'linux-native') fail('existing isolation backend differs; explicit migration is required')
  const existing = isolation.has('linux') ? literalAutonomyLinux(isolation.get('linux', true)) : undefined
  if (preflight) {
    const plannedRoot = join(canonicalHome, 'rsi-linux-runtimes', input.profile, 'runtime')
    const state = scalar(isolation.get('stateRoot', true), 'Isolation stateRoot')
    if (plannedRoot === state || plannedRoot.startsWith(state + sep) || state.startsWith(plannedRoot + sep)) fail('Isolation state overlaps Linux runtime')
  }
  if (existing) validateAutonomyLinuxPaths(existing, scalar(isolation.get('stateRoot', true), 'Isolation stateRoot'), canonicalHome)
  const resolved = 'linux' in input.isolation ? input.isolation.linux : undefined
  if (!preflight && !resolved) fail('resolved Linux runtime and cgroup roots are required')
  if (resolved) {
    validateAutonomyLinuxPaths(resolved, scalar(isolation.get('stateRoot', true), 'Isolation stateRoot'), canonicalHome)
    if (existing && !isDeepStrictEqual(existing, resolved)) fail('existing Linux descriptor differs; explicit migration is required')
    isolation.set('linux', target.document.createNode(resolved))
  }
  isolation.set('backend', target.document.createNode('linux-native'))
  isolation.delete('image'); isolation.delete('dockerPath'); isolation.delete('socketPath')
  if (!actions.has('grants')) actions.set('grants', target.document.createNode([]))
  else sequence(actions.get('grants', true), 'Actions grants')
  let grants: YAMLSeq
  if (!isolation.has('grants')) { grants = target.document.createNode([]) as YAMLSeq; isolation.set('grants', grants) } else grants = sequence(isolation.get('grants', true), 'Isolation grants')
  if (!isolation.has('linux') && grants.items.length > 0) fail('existing isolation grants without a native descriptor require explicit migration')
  const id = `autonomy-${input.profile}`; const principalDigest = createHash('sha256').update(`web/${input.profile}/local/operator`).digest('hex')
  const baseGrant = { id, revision: 1, principalDigest, workspace: input.workspace, agentPreset: input.preset, maxRuns: input.isolation.maxRuns, maxTotalDurationMs: input.isolation.maxTotalDurationMs }
  const validateManaged = (current: YAMLMap, checkOwner: boolean): void => {
    for (const [field, value] of Object.entries(baseGrant)) if (current.get(field) !== value) fail('managed isolation grant differs; explicit migration is required')
    if (typeof current.get('principalRecordId') !== 'string' || !Number.isSafeInteger(current.get('principalVersion')) || (current.get('principalVersion') as number) < 1) fail('managed isolation grant has invalid owner lineage')
    if (checkOwner && (current.get('principalRecordId') !== owner!.id || current.get('principalVersion') !== owner!.version)) fail('managed isolation grant differs; explicit migration is required')
    const expiresAt = current.get('expiresAt'); if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 0) fail('managed isolation grant has invalid expiry')
  }
  if (grants.items.length !== 0) {
    if (grants.items.length !== 1 || !isMap(grants.items[0])) fail('existing isolation grants require explicit migration')
    validateManaged(grants.items[0] as YAMLMap, owner !== undefined)
  } else if (owner !== undefined) grants.add(target.document.createNode({ ...baseGrant, principalRecordId: owner.id, principalVersion: owner.version, expiresAt: now + input.isolation.leaseMs }))
  return target.document.toString({ lineWidth: 0 })
}
